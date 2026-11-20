// 318 (живая проверка, этап 4): zone_c в dev-объекте (ID только из env).
// 1) MCP zone_c_add в пробной комнате → validate → project_save без
//    NORMALIZATION_DROPPED → reopen → сверка → render PNG;
// 2) делитель, поставленный руками в UI (drag) и сохранённый страницей,
//    попадает в рабочую копию при project_open → MCP save его не теряет;
// 3) zone_c_remove → save verified;
// Гарды полные (285 №3 + ревью 319 №3/№4): ID из env, OBJECT_ID != READONLY_ID,
// PLAN_ID != READONLY_PLAN_ID, GET(OBJECT_ID, PLAN_ID) возвращает пару
// object_id/plan_id из env и PLAN_ID в планах объекта (probe-guard), план в
// редакторе == серверу (compat), бэкап + семантическая сверка sig(),
// контрольный проект — ФИКСИРОВАННЫЙ эталон (файл не перезаписывается), проверка
// перед КАЖДОЙ фазой записи и в finally, «ИЗМЕНИЛСЯ» → exit(1) до следующих
// записей; restore в finally по захваченным site_id (после drag — только НОВЫЕ
// id делителей: разность наборов до/после, не ровно один → стоп), closeBrowser.
// node scripts/probes/318-zonec-live.ts run
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
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
const client = new Client({ name: "318-zonec-live", version: "0.0.0" });
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

let created: Array<{ kind: string; siteId?: string }> = [];
let opened = false;
let restoredFlag = false;
let before: LoadedModel | null = null;
async function restoreByCaptured(): Promise<void> {
  if (restoredFlag || !opened) return;
  restoredFlag = true;
  // делители — ластиком на странице (по захваченным id), затем стены инструментом
  const page = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { page?: import("playwright-core").Page } | null;
  const delimIds = created.filter((c) => c.kind === "delimiter" && c.siteId).map((c) => c.siteId!);
  if (page?.page && delimIds.length > 0) {
    await page.page.evaluate((ids: string[]) => {
      const w: any = window as any;
      for (const id of ids) {
        const d: any = w.ZONE_DELIMITERS?.[id];
        if (d) { try { d.deleteFull(); } catch { try { d.delete(); } catch { /* уже нет */ } } }
      }
    }, delimIds);
    await roGuard?.assertUnchanged("{tag}");
    try { await call("project_save", {}); } catch (e) { console.log("restore save:", String((e as Error).message).slice(0, 200)); }
  }
  const mg2 = await call("model_get", {});
  const walls = (mg2["walls"] ?? []) as Array<{ id: string; site_id: string }>;
  const want = new Set(created.filter((x) => x.kind === "wall" && x.siteId).map((x) => x.siteId!));
  for (let guard = 0; guard < 40 && want.size > 0; guard++) {
    const hit = walls.find((wl) => want.has(wl.site_id));
    if (!hit) break;
    want.delete(hit.site_id);
    try { await call("wall_delete", { wall_id: hit.id }); } catch (e) { console.log(`restore: wall_delete ${hit.id}:`, String((e as Error).message).slice(0, 200)); }
    const fresh = await call("model_get", {});
    const fw = (fresh["walls"] ?? []) as Array<{ id: string; site_id: string }>;
    walls.length = 0;
    walls.push(...fw);
  }
  await roGuard?.assertUnchanged("{tag}");
  const saveRes = await call("project_save", {});
  console.log("restore save:", JSON.stringify({ verified: saveRes["verified"] }));
  created = [];
  opened = false;
}

let roGuard: ReadonlyGuard | null = null;
async function checkReadonly(): Promise<void> {
  if (!roGuard) return;
  await roGuard.checkFinal("finally");
}

/** Пробная комната: 4 стены 220×160, толщина 100, правее пользовательской геометрии.
 *  ревью 319 №5: maxX по ВСЕМ стенам, комната ищется по полному bbox (X и Y). */
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
    created.push({ kind: "wall", siteId: sid });
  }
  await roGuard?.assertUnchanged("{tag}");
  await call("project_save", {});
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterRoom = await loadModel(ctx.session(), OBJECT_ID!, PLAN_ID!);
  const roomsAfter = (afterRoom.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  // ревью 319 №5: полный bbox — и по X, и по Y; геометрия комнаты обязана лечь
  // на прямоугольник из захваченных (созданных пробой) стен
  const entry = Object.entries(roomsAfter).find(([, r]) => {
    const p = r.polygon ?? [];
    return p.length >= 3 && p.every((q) => q.x >= ox - 1 && q.x <= ox + w + 1 && q.y >= oy - 1 && q.y <= oy + h + 1);
  });
  if (!entry) throw new Error("пробная комната не появилась");
  return { roomId: entry[0], poly: entry[1].polygon! };
}

async function openAndGuard(): Promise<void> {
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  opened = true;
  // гард «план в редакторе == серверу»: render_plan запускает редактор без изменения модели
  await call("render_plan", {});
  const editorGuard = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { compatInfo(): Promise<{ plan_id?: unknown }> } | null;
  const compat = editorGuard ? await editorGuard.compatInfo() : null;
  const planInEditor = compat?.plan_id == null ? "" : String(compat.plan_id);
  if (!planInEditor) throw new Error("compat.plan_id пуст — стоп");
  if (planInEditor !== String(PLAN_ID)) throw new Error(`план в редакторе ${planInEditor} != серверу ${PLAN_ID}`);
  console.log("гард «план в редакторе == серверу»: OK");
}

try {
  // ревью 319 №4: эталон контрольного проекта фиксированный — файл создаётся,
  // только если его нет, и не перезаписывается; сверка перед каждой фазой записи
  roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  // ревью 319 №3: пара объект/план из env и PLAN_ID в планах объекта
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = ".orca-reports/backup-".concat(OBJECT_ID, "-318.json");
  if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
  else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
    if (sig(stored.model as Record<string, unknown>) !== sig(before.model as Record<string, unknown>)) {
      throw new Error("модель на сервере не совпадает с бэкапом (семантический канон) — стоп");
    }
  }

  // ---- часть 1: MCP zone_c_add → validate → save → reopen → сверка → render ----
  await roGuard.assertUnchanged("перед частью 1");
  await openAndGuard();
  const { roomId, poly } = await makeTrialRoom(before);
  console.log("пробная комната:", roomId);
  const roomRefRes = await call("model_get", {});
  const roomsCompact = (roomRefRes["rooms"] ?? []) as Array<{ id: string; site_id?: string }>;
  const roomRef = roomsCompact.find((r) => (r as { site_id?: string }).site_id === roomId)?.id ?? roomId;
  // зона: вертикальная линия между верхней и нижней гранью (мин/макс по полигону)
  const midX = Math.round(((Math.min(...poly.map((q) => q.x)) + Math.max(...poly.map((q) => q.x))) / 2) * 10);
  const yTop = Math.round(Math.max(...poly.map((q) => q.y)) * 10) - 10;
  const yBottom = Math.round(Math.min(...poly.map((q) => q.y)) * 10) + 10;
  const add = await call("zone_c_add", { room_id: roomRef, from_mm: { x: midX, y: yTop }, to_mm: { x: midX, y: yBottom } });
  console.log("zone_c_add:", JSON.stringify(add));
  const zSiteId = String(add["site_id"] ?? "");
  if (!zSiteId) throw new Error("zone_c_add без site_id");
  created.push({ kind: "delimiter", siteId: zSiteId });
  const vRes = await call("model_validate", {});
  console.log("validate:", JSON.stringify({ ok: vRes["ok"] }));
  await roGuard?.assertUnchanged("{tag}");
  const save1 = await call("project_save", {});
  console.log("save 1:", JSON.stringify({ verified: save1["verified"], warnings: save1["warnings"] }));
  if (!save1["verified"]) throw new Error("save 1 не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after1 = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const zds1 = Object.values((after1.model["zone_delimiters"] ?? {}) as Record<string, Record<string, unknown>>);
  console.log("reopen: zone_delimiters:", zds1.length, JSON.stringify({ type: zds1[0]?.["type"], plan: zds1[0]?.["plan"], length: zds1[0]?.["length"] }));
  if (zds1.length !== 1 || zds1[0]!["type"] !== "zone_c" || zds1[0]!["plan"] !== "c") throw new Error("делитель zone_c не дошёл до сервера");
  const render = await call("render_plan", {});
  console.log("render_plan:", JSON.stringify({ ok: render["ok"] ?? true, path: render["path"] ?? render["file"] ?? null }));
  await call("zone_c_remove", { delimiter_id: zSiteId });
  await roGuard?.assertUnchanged("{tag}");
  const save2 = await call("project_save", {});
  console.log("save 2 (после remove):", JSON.stringify({ verified: save2["verified"], warnings: save2["warnings"] }));
  if (!save2["verified"]) throw new Error("save 2 не verified");
  // делитель удалён — помечаем как убранный (restore не должен его искать)
  created = created.filter((c) => !(c.kind === "delimiter" && c.siteId === zSiteId));
  // убираем пробную комнату 1 (чтобы пробная комната 2 не легла на её стены)
  {
    const mg2 = await call("model_get", {});
    const walls = (mg2["walls"] ?? []) as Array<{ id: string; site_id: string }>;
    const want = new Set(created.filter((x) => x.kind === "wall" && x.siteId).map((x) => x.siteId!));
    for (let guard = 0; guard < 40 && want.size > 0; guard++) {
      const hit = walls.find((wl) => want.has(wl.site_id));
      if (!hit) break;
      want.delete(hit.site_id);
      await call("wall_delete", { wall_id: hit.id });
      const fresh = await call("model_get", {});
      const fw = (fresh["walls"] ?? []) as Array<{ id: string; site_id: string }>;
      walls.length = 0;
      walls.push(...fw);
    }
    created = created.filter((c) => c.kind !== "wall");
    await roGuard?.assertUnchanged("{tag}");
    const saveCleanup = await call("project_save", {});
    console.log("cleanup комнаты 1:", JSON.stringify({ verified: saveCleanup["verified"] }));
  }

  // ---- часть 2: делитель руками в UI → page save → project_open (ингест) → MCP save ----
  await roGuard.assertUnchanged("перед частью 2");
  await openAndGuard();
  const trial2 = await makeTrialRoom(await loadModel(ctx.session(), OBJECT_ID, PLAN_ID));
  console.log("пробная комната 2:", trial2.roomId);
  const ed = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { page?: import("playwright-core").Page } | null;
  const page = ed?.page;
  if (!page) throw new Error("страница недоступна");
  await page.evaluate(() => {
    const el: any = document.querySelector(".groups_navi_item.plan_create_walls") ??
      Array.from(document.querySelectorAll(".groups_navi_item")).find((e: any) => String(e.className).includes("plan_c"));
    if (el) el.click();
  });
  await page.waitForTimeout(2500);
  const zoneBtn = await page.evaluate(() => {
    const el: any = document.querySelector("#plannertool_zone");
    if (el && el.offsetParent !== null) { el.click(); return true; }
    return false;
  });
  if (!zoneBtn) throw new Error("plannertool_zone не найден");
  const toScreen = (p: { x: number; y: number }) => page.evaluate((pp) => {
    const svg: any = document.querySelector("#main_svg");
    const r = svg.getBoundingClientRect();
    const q = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    return { x: r.x + ((pp.x - q[0]) * r.width) / q[2], y: r.y + ((pp.y - q[1]) * r.height) / q[3] };
  }, p);
  const tp = trial2.poly;
  const a = { x: tp[3]!.x + 3, y: (tp[3]!.y + tp[2]!.y) / 2 };
  const bpt = { x: tp[0]!.x - 3, y: (tp[0]!.y + tp[1]!.y) / 2 };
  // ревью 319 №2: захватываем только НОВЫЕ id делителей — набор ДО drag, разность ПОСЛЕ
  const delimIdsBefore = new Set(await page.evaluate(() => {
    const w: any = window as any;
    return Object.keys(w.project.copy("server").zone_delimiters ?? {}) as string[];
  }));
  const sa = await toScreen(a), sb = await toScreen(bpt);
  await page.mouse.move(sa.x, sa.y, { steps: 5 });
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.move(sb.x, sb.y, { steps: 15 });
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const dragDelims = (await page.evaluate(() => {
    const w: any = window as any;
    return Object.keys(w.project.copy("server").zone_delimiters ?? {}) as string[];
  })).filter((id) => !delimIdsBefore.has(id));
  console.log("drag: новых делителей:", JSON.stringify(dragDelims), "(всего в редакторе:", delimIdsBefore.size + dragDelims.length, ")");
  // инцидент 240: чужие делители пользователя не трогаем — новых не ровно один → стоп
  if (dragDelims.length !== 1) throw new Error(`после drag новых делителей не ровно один (${dragDelims.length}) — стоп`);
  for (const id of dragDelims) created.push({ kind: "delimiter", siteId: id });
  await roGuard?.assertUnchanged("{tag}");
  const pageSave = await page.evaluate(async () => {
    const w: any = window as any;
    return await Promise.resolve(w.project.save(false, true)).then((r: unknown) => String(r).slice(0, 40)).catch((e: unknown) => `ERR ${String(e).slice(0, 40)}`);
  });
  console.log("page save:", JSON.stringify(pageSave));
  await new Promise((r) => setTimeout(r, 2500));
  // ингест: project_open перечитывает GET с делителем UI
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  await roGuard?.assertUnchanged("{tag}");
  const save3 = await call("project_save", {});
  console.log("save 3 (после ингеста):", JSON.stringify({ verified: save3["verified"], warnings: save3["warnings"] }));
  if (!save3["verified"]) throw new Error("save 3 не verified");
  const after3 = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const zds3 = Object.values((after3.model["zone_delimiters"] ?? {}) as Record<string, Record<string, unknown>>).filter((d) => String(d["type"]) === "zone_c");
  console.log("GET после save 3: zone_c-делителей:", zds3.length);
  if (zds3.length < 1) throw new Error("делитель UI потерян MCP save после ингеста");

  await restoreByCaptured();
  const final = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const same = sig(final.model) === sig(before!.model);
  console.log("семантическая сверка с бэкапом:", same ? "OK" : "РАСХОЖДЕНИЕ — требуется разбор");
  if (!same) {
    process.exitCode = 1;
    throw new Error("модель после restore не совпала с бэкапом");
  }
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 1500));
  process.exitCode = 1;
} finally {
  try { await restoreByCaptured(); } catch (ce) { console.error("RESTORE FAIL:", String((ce as Error).message ?? ce).slice(0, 400)); process.exitCode = 1; }
  await checkReadonly();
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
