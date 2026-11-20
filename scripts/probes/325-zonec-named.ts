// 325 (живая проверка главного сценария на КОМНАТЕ С ИМЕНЕМ, PR #49):
// (A) zone_c_add через MCP → save verified → reopen → делитель на месте,
//     room.name сохранён;
// (B) zone_c_remove → save verified → reopen → делителя нет, имя сохранено;
// (C) делитель, поставленный drag'ом в UI → page save → project_open MCP
//     (ингест) → правка не по зонам (wall_add/wall_delete вне пробной
//     комнаты) → save MCP → делитель НЕ удалён.
// Гарды полные (285 №3 + ревью 319 №3/№4 + 322 N3б/N4 + 323 N5/N6): ID из env,
// READONLY_ID/READONLY_PLAN_ID обязательны и не равны целевой паре,
// GET(OBJECT_ID, PLAN_ID) возвращает пару из env и PLAN_ID в планах объекта
// (probe-guard), модель несёт свои id (N5), план в редакторе == серверу (compat),
// бэкап + семантическая сверка sig(), контрольный проект — ФИКСИРОВАННЫЙ эталон
// на пару READONLY (файл .orca-reports/tmp/readonly-ref-<hash>.json не
// перезаписывается), assertUnchanged перед КАЖДОЙ записью, «ИЗМЕНИЛСЯ» →
// exit(1) до следующих записей; захват только своих id (drag — разность
// наборов до/после, не ровно один → стоп); restore в finally; closeBrowser.
// Правка 326 (разбор FAIL 325 по (C)): drag в 318 шёл после restore+draw в
// странице (normalize из wall_add/page save), в 325 — сразу после render_plan;
// в (C) добавлен editor.normalize (restore+draw) после openAndGuard, активация
// plannertool_zone проверяется по классу .active (до 3 попыток), добавлены
// диагностика viewBox/экранных координат/px-длины drag и скриншоты листа
// до/после drag (.orca-reports/tmp/326-drag-*.png); (A) validate печатает
// полный ответ (ok:false в дев-объекте — не по zone_c, см. отчёт 326).
// Правка 327 (разбор FAIL 326 по (C)): GET-формат zone_delimiters —
// Record<ключ, запись> с полем id записи; поля site_id в сыром GET НЕТ
// (site_id — имя поля компакта model_get, там site_id = rec.id ?? ключ,
// zoneDelimiterList) — сверка 325/326 по d["site_id"] не могла пройти ни при
// каком id, вывод 326 «регенерация id при save» кодом не подтверждён. Сверка
// (C) переделана: серверный id делителя = разность наборов GET до/после
// page save по полю id записей + геометрия (концы ±0,5 см, id_room, plan c),
// равенство локального id редактора не требуется; restore — zone_c_remove по
// захваченному серверному id.
// node scripts/probes/325-zonec-named.ts run
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { prepareForRestore } from "../../src/model/walls.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { sig } from "./probe-sig.ts";
import { assertNoReadonlyCollision, assertTargetPair, readonlyGuard, readonlyRefPath, type ReadonlyGuard } from "./probe-guard.ts";

if (process.argv[2] !== "run") { console.error("запуск: run"); process.exit(0); }
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) { console.error("нужны env"); process.exit(1); }
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "325-zonec-named", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
};
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 900)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};

let createdWalls: Array<{ siteId: string }> = [];
/** Серверный id drag-делителя (разность GET + геометрия) — для restore. */
let dragServerId: string | null = null;
let roGuard: ReadonlyGuard | null = null;
const page = (): import("playwright-core").Page => {
  const ed = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { page?: import("playwright-core").Page } | null;
  const p = ed?.page;
  if (!p) throw new Error("страница недоступна");
  return p;
};
const assertUnchanged = async (tag: string): Promise<void> => { await roGuard?.assertUnchanged(tag); };
const guardedSave = async (tag: string, label: string): Promise<void> => {
  await assertUnchanged(tag);
  const res = await call("project_save", {});
  console.log(`${label}:`, JSON.stringify({ verified: res["verified"], warnings: res["warnings"] }));
  if (!res["verified"]) throw new Error(`${label} не verified`);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Открыть проект + гард «план в редакторе == серверу» (compat). */
async function openAndGuard(): Promise<void> {
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  await call("render_plan", {});
  const editorGuard = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { compatInfo(): Promise<{ plan_id?: unknown }> } | null;
  const compat = editorGuard ? await editorGuard.compatInfo() : null;
  const planInEditor = compat?.plan_id == null ? "" : String(compat.plan_id);
  if (!planInEditor) throw new Error("compat.plan_id пуст — стоп");
  if (planInEditor !== String(PLAN_ID)) throw new Error(`план в редакторе ${planInEditor} != серверу ${PLAN_ID}`);
  console.log("гард «план в редакторе == серверу»: OK");
}

type RoomRec = { name?: unknown; polygon?: Array<{ x: number; y: number }>; zones?: Array<{ name?: unknown }> };

/** Пробная комната 220×160, толщина 100, правее пользовательской геометрии
 *  (ревью 319 №5: maxX/maxY по ВСЕМ стенам, поиск по полному bbox X и Y). */
async function makeTrialRoom(beforeModel: LoadedModel): Promise<{ roomId: string; poly: Array<{ x: number; y: number }> }> {
  const rawWalls = (beforeModel.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const maxX = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]));
  const maxY = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.y, w.p2.y]));
  const ox = Math.ceil(maxX) + 300, oy = Math.ceil(maxY) + 300, w = 220, h = 160;
  type Pt = { x: number; y: number };
  for (const [p1, p2] of [
    [{ x: ox, y: oy }, { x: ox + w, y: oy }],
    [{ x: ox + w, y: oy }, { x: ox + w, y: oy + h }],
    [{ x: ox + w, y: oy + h }, { x: ox, y: oy + h }],
    [{ x: ox, y: oy + h }, { x: ox, y: oy }],
  ] as [Pt, Pt][]) {
    const res = await call("wall_add", { start: { x: Math.round(p1.x * 10), y: Math.round(p1.y * 10) }, end: { x: Math.round(p2.x * 10), y: Math.round(p2.y * 10) }, thickness_mm: 100 });
    const sid = (res as { entity?: { site_id?: string } }).entity?.site_id;
    if (!sid) throw new Error("wall_add без site_id");
    createdWalls.push({ siteId: sid });
  }
  await assertUnchanged("перед save пробной комнаты");
  const saveRes = await call("project_save", {});
  console.log("save (пробная комната):", JSON.stringify({ verified: saveRes["verified"] }));
  if (!saveRes["verified"]) throw new Error("save пробной комнаты не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterRoom = await loadModel(ctx.session(), OBJECT_ID!, PLAN_ID!);
  const roomsAfter = (afterRoom.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const entry = Object.entries(roomsAfter).find(([, r]) => {
    const p = r.polygon ?? [];
    return p.length >= 3 && p.every((q) => q.x >= ox - 1 && q.x <= ox + w + 1 && q.y >= oy - 1 && q.y <= oy + h + 1);
  });
  if (!entry) throw new Error("пробная комната не появилась");
  return { roomId: entry[0], poly: entry[1].polygon ?? [] };
}

/** Дать комнате имя как руками (проба 43): ROOMS2[rid].name + zones[0], page save. */
async function nameRoomViaPage(roomId: string, name: string): Promise<void> {
  const p = page();
  await assertUnchanged("перед page save (имя комнаты)");
  const named = await p.evaluate(({ rid, nm }: { rid: string; nm: string }) => {
    const w: any = window as any;
    const r = w.ROOMS2?.[rid];
    if (!r) return { err: "нет ROOMS2[rid]" };
    const z = (r.zones ?? [])[0];
    if (!z) return { err: "нет зоны" };
    r.name = nm;
    z.name = nm;
    z.zone_name = nm;
    try { z.draw?.(); } catch { /* ignore */ }
    w.project.localSave();
    return { ok: true };
  }, { rid: roomId, nm: name });
  console.log("имя задано:", JSON.stringify(named));
  if (!(named as { ok?: boolean }).ok) throw new Error(`имя не задано: ${JSON.stringify(named)}`);
  await assertUnchanged("перед page save (имя)");
  const pageSave = await p.evaluate(async () => {
    const w: any = window as any;
    return await Promise.resolve(w.project.save(false, true)).then((r: unknown) => String(r).slice(0, 40)).catch((e: unknown) => `ERR ${String(e).slice(0, 40)}`);
  });
  console.log("page save (имя):", JSON.stringify(pageSave));
  await wait(2500);
  if (String(pageSave).startsWith("ERR")) throw new Error(`page save (имя) не прошёл: ${String(pageSave)}`);
}

/** Имя пробной комнаты на сервере (GET, rooms2). */
async function serverRoomName(roomId: string): Promise<unknown> {
  const m = await loadModel(ctx.session(), OBJECT_ID!, PLAN_ID!);
  const room = ((m.model["rooms2"] ?? {}) as Record<string, { name?: unknown }>)[roomId];
  return room?.name;
}

/** zone_c-делители на сервере (GET): id записей (поле id; ключ = id) + записи.
 *  Поле site_id в сыром GET отсутствует — это имя поля компакта model_get. */
async function serverZoneCEntries(): Promise<Array<{ id: string; rec: Record<string, unknown> }>> {
  const m = await loadModel(ctx.session(), OBJECT_ID!, PLAN_ID!);
  const zd = (m.model["zone_delimiters"] ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(zd)
    .filter(([, d]) => String(d["type"]) === "zone_c")
    .map(([key, d]) => ({ id: String(d["id"] ?? key), rec: d }));
}

/** Концы записи делителя (см, первая/последняя вершина). */
function endsOf(rec: Record<string, unknown>): Array<{ x: number; y: number }> {
  const v = (rec["vertexes"] ?? []) as Array<{ point?: { x: number; y: number } }>;
  const p1 = v[0]?.point, p2 = v[v.length - 1]?.point;
  if (!p1 || !p2) throw new Error("запись делителя без двух концов");
  return [p1, p2];
}

const distCm = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Та же геометрия: концы совпадают с точностью ±0,5 см (порядок концов не важен). */
function sameEnds(a: Array<{ x: number; y: number }>, b: Array<{ x: number; y: number }>): boolean {
  return (distCm(a[0]!, b[0]!) <= 0.5 && distCm(a[1]!, b[1]!) <= 0.5) ||
    (distCm(a[0]!, b[1]!) <= 0.5 && distCm(a[1]!, b[0]!) <= 0.5);
}

/** Правка не по зонам: wall_add + wall_delete далеко от пробной комнаты (net-zero). */
async function nonZoneEdit(): Promise<void> {
  const m = await loadModel(ctx.session(), OBJECT_ID!, PLAN_ID!);
  const rawWalls = (m.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const xs = Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]);
  const ys = Object.values(rawWalls).flatMap((w) => [w.p1.y, w.p2.y]);
  const fx = Math.ceil(Math.max(...xs)) + 2000, fy = Math.ceil(Math.max(...ys)) + 2000;
  const add = await call("wall_add", { start: { x: fx * 10, y: fy * 10 }, end: { x: (fx + 30) * 10, y: fy * 10 }, thickness_mm: 100 });
  const entity = add["entity"] as { id?: string; site_id?: string } | undefined;
  if (!entity?.site_id) throw new Error("wall_add (правка не по зонам) без site_id");
  const del = await call("wall_delete", { wall_id: entity.id ?? "" });
  console.log("правка не по зонам (wall_add+wall_delete):", JSON.stringify({ removed: del["removed"] ?? del["ok"] ?? true }));
}

/** Restore: убрать drag-делитель по захваченному серверному id, затем свои
 *  стены (комната с именем исчезает вместе со стенами). */
async function restoreWalls(): Promise<void> {
  if (dragServerId) {
    try { await call("zone_c_remove", { delimiter_id: dragServerId }); } catch (e) { console.log(`restore: zone_c_remove ${dragServerId}:`, String((e as Error).message).slice(0, 200)); }
    dragServerId = null;
  }
  const want = new Set(createdWalls.map((w) => w.siteId));
  for (let guard = 0; guard < 40 && want.size > 0; guard++) {
    const mg = await call("model_get", {});
    const walls = (mg["walls"] ?? []) as Array<{ id: string; site_id: string }>;
    const hit = walls.find((wl) => want.has(wl.site_id));
    if (!hit) break;
    want.delete(hit.site_id);
    try { await call("wall_delete", { wall_id: hit.id }); } catch (e) { console.log(`restore: wall_delete ${hit.id}:`, String((e as Error).message).slice(0, 200)); }
  }
  createdWalls = [];
  await assertUnchanged("restore: перед save");
  const saveRes = await call("project_save", {});
  console.log("restore save:", JSON.stringify({ verified: saveRes["verified"] }));
}

try {
  roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  const before = await loadModel(ctx.session(), OBJECT_ID!, PLAN_ID!);
  const backupPath = ".orca-reports/backup-".concat(OBJECT_ID, "-325.json");
  if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
  else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
    if (sig(stored.model as Record<string, unknown>) !== sig(before.model as Record<string, unknown>)) {
      throw new Error("модель на сервере не совпадает с бэкапом (семантический канон) — стоп");
    }
  }

  await assertUnchanged("перед подготовкой");
  await openAndGuard();
  const trial = await makeTrialRoom(before);
  console.log("пробная комната:", trial.roomId);
  const NAME = "Пробная";
  await nameRoomViaPage(trial.roomId, NAME);
  // ингест имени в рабочую копию + сверка имени на сервере
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const nameOnServer = await serverRoomName(trial.roomId);
  console.log("имя на сервере после page save:", JSON.stringify({ name: nameOnServer }));
  if (nameOnServer !== NAME) throw new Error(`имя комнаты не дошло до сервера: ${JSON.stringify(nameOnServer)}`);

  // ---- (A) zone_c_add через MCP → save verified → reopen → делитель + имя ----
  await assertUnchanged("перед (A) zone_c_add");
  const roomsRef = await call("model_get", {});
  const roomsCompact = (roomsRef["rooms"] ?? []) as Array<{ id: string; site_id?: string }>;
  const roomRef = roomsCompact.find((r) => r.site_id === trial.roomId)?.id ?? trial.roomId;
  const poly = trial.poly;
  const midX = Math.round(((Math.min(...poly.map((q) => q.x)) + Math.max(...poly.map((q) => q.x))) / 2) * 10);
  const yTop = Math.round(Math.max(...poly.map((q) => q.y)) * 10) - 10;
  const yBottom = Math.round(Math.min(...poly.map((q) => q.y)) * 10) + 10;
  const add = await call("zone_c_add", { room_id: roomRef, from_mm: { x: midX, y: yTop }, to_mm: { x: midX, y: yBottom } });
  console.log("(A) zone_c_add:", JSON.stringify({ id: add["id"], site_id: add["site_id"], length_mm: add["length_mm"] }));
  const zSiteId = String(add["site_id"] ?? "");
  if (!zSiteId) throw new Error("(A) zone_c_add без site_id");
  const vRes = await call("model_validate", {});
  // полный ответ: в 325 печатали только ok:false и не видели список проблем
  console.log("(A) validate:", JSON.stringify(vRes));
  await assertUnchanged("перед (A) save");
  const saveA = await call("project_save", {});
  console.log("(A) save:", JSON.stringify({ verified: saveA["verified"], warnings: saveA["warnings"] }));
  if (!saveA["verified"]) throw new Error("(A) save не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const zdsA = await serverZoneCEntries();
  const nameA = await serverRoomName(trial.roomId);
  console.log("(A) reopen:", JSON.stringify({ zoneC: zdsA.length, plan: zdsA[0]?.rec["plan"], id: zdsA[0]?.id, name: nameA }));
  if (zdsA.length !== 1 || zdsA[0]!.rec["plan"] !== "c") throw new Error("(A) делитель zone_c не дошёл до сервера");
  if (nameA !== NAME) throw new Error("(A) room.name потерян после save MCP");

  // ---- (B) zone_c_remove → save verified → reopen → делителя нет, имя цело ----
  await assertUnchanged("перед (B) zone_c_remove");
  const rem = await call("zone_c_remove", { delimiter_id: zSiteId });
  console.log("(B) zone_c_remove:", JSON.stringify({ removed: rem["removed"], room_id: rem["room_id"] }));
  await assertUnchanged("перед (B) save");
  const saveB = await call("project_save", {});
  console.log("(B) save:", JSON.stringify({ verified: saveB["verified"], warnings: saveB["warnings"] }));
  if (!saveB["verified"]) throw new Error("(B) save не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const zdsB = await serverZoneCEntries();
  const nameB = await serverRoomName(trial.roomId);
  console.log("(B) reopen:", JSON.stringify({ zoneC: zdsB.length, name: nameB }));
  if (zdsB.length !== 0) throw new Error("(B) делитель zone_c не удалён с сервера");
  if (nameB !== NAME) throw new Error("(B) room.name потерян после zone_c_remove+save");

  // ---- (C) делитель drag'ом в UI → page save → project_open (ингест) →
  //         правка не по зонам → save MCP → делитель НЕ удалён ----
  await assertUnchanged("перед (C) drag");
  await openAndGuard();
  // Причина FAIL 325: в 318 между render_plan (openAndGuard) и drag'ом были
  // wall_add×4 и page save — каждый делает editor.normalize ($Project.restore +
  // draw в странице), т.е. drag шёл по состоянию «после restore», а не «после
  // render_plan» (переключение листа init + $Project.focus). Воспроизводим то же
  // состояние: restore+draw текущей модели страницы, затем активация листа/инструмента.
  {
    const edN = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { normalize(m: unknown): Promise<unknown> } | null;
    const cur = await loadModel(ctx.session(), OBJECT_ID!, PLAN_ID!);
    const prepared = structuredClone(cur.model as import("../../src/model/types.ts").Model);
    prepareForRestore(prepared);
    if (!edN) throw new Error("(C) редактор недоступен для restore+draw");
    await edN.normalize(prepared);
  }
  const p = page();
  // серверный набор zone_c ДО drag (правка 327): серверный id делителя ищем
  // разностью наборов GET до/после page save, не равенством локального id
  const serverBeforeC = await serverZoneCEntries();
  // лист «Перегородки»: клик с проверкой активации (один повтор)
  const sheetClick = await p.evaluate(() => {
    const el: any = document.querySelector(".groups_navi_item.plan_create_walls") ??
      Array.from(document.querySelectorAll(".groups_navi_item")).find((e: any) => String(e.className).includes("plan_c"));
    if (el) { el.click(); return true; }
    return false;
  });
  if (!sheetClick) throw new Error("(C) nav «Перегородки» (plan_create_walls) не найден");
  await p.waitForTimeout(2500);
  // инструмент «Зонировать»: кликаем, пока кнопка не станет .active (до 3 попыток)
  let zoneActive = false;
  for (let i = 0; i < 3 && !zoneActive; i++) {
    await p.evaluate(() => {
      const el: any = document.querySelector("#plannertool_zone");
      if (el && el.offsetParent !== null && !el.classList.contains("active")) el.click();
    });
    await p.waitForTimeout(800);
    zoneActive = await p.evaluate(() => Boolean((document.querySelector("#plannertool_zone") as HTMLElement | null)?.classList.contains("active")));
  }
  console.log("(C) plannertool_zone active:", zoneActive);
  if (!zoneActive) throw new Error("(C) plannertool_zone не активировался (3 клика)");
  const toScreen = (pt: { x: number; y: number }) => p.evaluate((pp) => {
    const svg: any = document.querySelector("#main_svg");
    const r = svg.getBoundingClientRect();
    const q = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    return { x: r.x + ((pp.x - q[0]) * r.width) / q[2], y: r.y + ((pp.y - q[1]) * r.height) / q[3] };
  }, pt);
  const aPt = { x: poly[3]!.x + 3, y: (poly[3]!.y + poly[2]!.y) / 2 };
  const bPt = { x: poly[0]!.x - 3, y: (poly[0]!.y + poly[1]!.y) / 2 };
  const delimIdsBefore = new Set(await p.evaluate(() => {
    const w: any = window as any;
    return Object.keys(w.project.copy("server").zone_delimiters ?? {}) as string[];
  }));
  const sa = await toScreen(aPt), sb = await toScreen(bPt);
  // диагностика 326: масштаб/видимость — оба конца внутри вьюпорта, drag не короче 30 px
  const vp = p.viewportSize();
  const onScreen = [sa, sb].every((q) => q.x >= 0 && q.y >= 0 && (vp?.width ?? 0) >= q.x && (vp?.height ?? 0) >= q.y);
  const distPx = Math.hypot(sb.x - sa.x, sb.y - sa.y);
  const viewBox = await p.evaluate(() => (document.querySelector("#main_svg") as SVGElement | null)?.getAttribute("viewBox") ?? null);
  console.log("(C) drag-координаты:", JSON.stringify({ sa, sb, distPx: Math.round(distPx), viewBox, vp }));
  if (!onScreen) throw new Error("(C) концы drag вне вьюпорта — пробная комната не в видимой области");
  if (distPx < 30) throw new Error(`(C) drag на экране ${Math.round(distPx)} px (<30) — комната слишком мелкая/не видна`);
  await p.screenshot({ path: ".orca-reports/tmp/327-drag-before.png" });
  await p.mouse.move(sa.x, sa.y, { steps: 5 });
  await p.waitForTimeout(300);
  await p.mouse.down();
  await p.waitForTimeout(200);
  await p.mouse.move(sb.x, sb.y, { steps: 15 });
  await p.waitForTimeout(300);
  await p.mouse.up();
  await p.waitForTimeout(1200);
  await p.screenshot({ path: ".orca-reports/tmp/327-drag-after.png" });
  // новые записи делителей после drag (локальные id + запись для геометрии —
  // локальный id используется только для захвата своих, не для сверки с сервером)
  const localDelimsAfter = await p.evaluate(() => {
    const w: any = window as any;
    const zd = (w.project.copy("server").zone_delimiters ?? {}) as Record<string, Record<string, unknown>>;
    return Object.fromEntries(Object.entries(zd).map(([k, v]) => [k, {
      id: String(v["id"] ?? k),
      type: String(v["type"] ?? ""),
      plan: String(v["plan"] ?? ""),
      id_room: String(v["id_room"] ?? ""),
      vertexes: v["vertexes"],
    }]));
  }) as Record<string, { id: string; type: string; plan: string; id_room: string; vertexes: unknown }>;
  const dragDelims = Object.keys(localDelimsAfter).filter((id) => !delimIdsBefore.has(id));
  console.log("(C) drag: новых делителей:", JSON.stringify(dragDelims));
  if (dragDelims.length !== 1) throw new Error(`(C) после drag новых делителей не ровно один (${dragDelims.length}) — стоп`);
  const localRec = localDelimsAfter[dragDelims[0]!]!;
  if (localRec.type !== "zone_c" || localRec.plan !== "c") throw new Error(`(C) drag-делитель не zone_c/plan c: ${localRec.type}/${localRec.plan}`);
  if (localRec.id_room !== trial.roomId) throw new Error(`(C) drag-делитель в другой комнате: ${localRec.id_room}`);
  const localEnds = endsOf(localRec as unknown as Record<string, unknown>);
  await assertUnchanged("перед (C) page save");
  const pageSaveC = await p.evaluate(async () => {
    const w: any = window as any;
    return await Promise.resolve(w.project.save(false, true)).then((r: unknown) => String(r).slice(0, 40)).catch((e: unknown) => `ERR ${String(e).slice(0, 40)}`);
  });
  console.log("(C) page save:", JSON.stringify(pageSaveC));
  await wait(2500);
  if (String(pageSaveC).startsWith("ERR")) throw new Error(`(C) page save не прошёл: ${String(pageSaveC)}`);
  // серверный id drag-делителя (правка 327): разность наборов GET до/после
  // page save по полю id записей + геометрия (концы ±0,5 см, id_room, plan c)
  const serverAfterPageSave = await serverZoneCEntries();
  const newServer = serverAfterPageSave.filter((e) => !serverBeforeC.some((b) => b.id === e.id));
  console.log("(C) сервер после page save:", JSON.stringify({
    zoneC: serverAfterPageSave.length,
    новых: newServer.map((e) => e.id),
  }));
  if (newServer.length !== 1) throw new Error(`(C) на сервере новых zone_c-делителей не ровно один (${newServer.length}) — стоп`);
  const cand = newServer[0]!;
  const candEnds = endsOf(cand.rec);
  if (!sameEnds(localEnds, candEnds)) throw new Error(`(C) новый серверный делитель ${cand.id} не совпал по геометрии с drag-делителем`);
  if (String(cand.rec["id_room"] ?? "") !== localRec.id_room) throw new Error(`(C) id_room не совпал: ${cand.rec["id_room"]} != ${localRec.id_room}`);
  if (String(cand.rec["plan"] ?? "") !== "c") throw new Error(`(C) plan не c: ${cand.rec["plan"]}`);
  dragServerId = cand.id;
  console.log("(C) захвачен серверный id drag-делителя:", dragServerId);
  // ингест делителя UI
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const zdsC0 = await serverZoneCEntries();
  const afterIngest = zdsC0.find((e) => e.id === dragServerId);
  console.log("(C) после ингеста:", JSON.stringify({ zoneC: zdsC0.length, захваченный: Boolean(afterIngest), id: dragServerId }));
  if (!afterIngest) throw new Error("(C) делитель UI не подхвачен при project_open");
  if (!sameEnds(localEnds, endsOf(afterIngest.rec))) throw new Error("(C) после ингеста геометрия делителя изменилась");
  // правка не по зонам → save MCP → делитель НЕ удалён
  await assertUnchanged("перед (C) правка не по зонам");
  await nonZoneEdit();
  await assertUnchanged("перед (C) save MCP");
  const saveC = await call("project_save", {});
  console.log("(C) save:", JSON.stringify({ verified: saveC["verified"], warnings: saveC["warnings"] }));
  if (!saveC["verified"]) throw new Error("(C) save не verified");
  const zdsC = await serverZoneCEntries();
  const survived = zdsC.find((e) => e.id === dragServerId);
  const nameC = await serverRoomName(trial.roomId);
  console.log("(C) после save MCP:", JSON.stringify({ zoneC: zdsC.length, dragDelimSurvived: Boolean(survived), id: dragServerId, name: nameC }));
  if (!survived) throw new Error("(C) делитель UI УДАЛЁН save MCP");
  if (!sameEnds(localEnds, endsOf(survived.rec))) throw new Error("(C) после save MCP геометрия делителя изменилась");
  if (nameC !== NAME) throw new Error("(C) room.name потерян");

  await restoreWalls();
  const final = await loadModel(ctx.session(), OBJECT_ID!, PLAN_ID!);
  const same = sig(final.model) === sig(before.model);
  console.log("семантическая сверка с бэкапом:", same ? "OK" : "РАСХОЖДЕНИЕ — требуется разбор");
  if (!same) {
    process.exitCode = 1;
    throw new Error("модель после restore не совпала с бэкапом");
  }
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 1500));
  process.exitCode = 1;
} finally {
  try { await restoreWalls(); } catch (ce) { console.error("RESTORE FAIL:", String((ce as Error).message ?? ce).slice(0, 400)); process.exitCode = 1; }
  if (roGuard) await roGuard.checkFinal("finally");
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
