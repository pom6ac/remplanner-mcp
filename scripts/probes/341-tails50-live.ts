// 341 (живая перепроверка правок 336/338, dev-объект, ID только из env):
// 1) комната с двухуровневым потолком + плинтус пола + потолочный плинтус + ниша →
//    wall_delete → отказ INVALID_GEOMETRY с подсказкой (реестр видов, порядок) →
//    выполнение подсказки по шагам → wall_delete проходит → save verified;
// 2) зонированный потолок (zone_ceiling-делитель) с непокрытой зоной →
//    finish_ceiling_set тем же материалом → зона покрыта, level/profile
//    унаследованы (337 n3) → save verified.
// Гарды полные (probe-guard): ID из env, READONLY обязателен, GET-пара, план в
// редакторе == серверу, бэкап + сверка sig(), контрольный проект — фиксированный
// корневой эталон (без REF_INIT; расхождение — немедленный стоп), restore по
// захваченным ID в finally (отделка своих комнат снимается по реестру, журнал ID —
// .orca-reports/tmp/343-captured.json), closeBrowser.
// node scripts/probes/341-tails50-live.ts run
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { sig } from "./probe-sig.ts";
import { assertNoReadonlyCollision, assertTargetPair, gitRepoRoot, readonlyGuard, readonlyRefPath, type ReadonlyGuard } from "./probe-guard.ts";
import { logCaptured, restoreByCaptured as restoreByCapturedCore, type ProbeCreated } from "./probe-restore.ts";

if (process.argv[2] !== "run") { console.error("запуск: run"); process.exit(0); }
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"] as string;
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"] as string;
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"] as string;
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"] as string;
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) { console.error("нужны env"); process.exit(1); }
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
const ROOT_DIR = gitRepoRoot() ?? process.cwd();
mkdirSync(join(ROOT_DIR, ".orca-reports", "tmp"), { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "341-tails50-live", version: "0.0.0" });
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
/** Ожидаемый отказ: возвращает {message} вместо броска. */
const callErr = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if (!(res as { isError?: boolean }).isError) throw new Error(`${name}: ожидался отказ, а прошёл: ${text(res).slice(0, 300)}`);
  return text(res).slice(0, 2000);
};

type Created = ProbeCreated;
let created: Created[] = [];
let ownRoomIds: string[] = [];
let opened = false;
let restoredFlag = false;
// журнал захваченных ID (m1 ревью 342): доочистка — только по ним, не по геометрии
const CAPTURED_PATH = join(ROOT_DIR, ".orca-reports", "tmp", "343-captured.json");

async function saveTagged(tag: string): Promise<Record<string, unknown>> {
  await roGuard?.assertUnchanged(tag);
  const r = await call("project_save", {});
  console.log(`save ${tag}:`, JSON.stringify({ verified: r["verified"], warnings: r["warnings"] }));
  if (!r["verified"]) throw new Error(`save ${tag} не verified`);
  await new Promise((res) => setTimeout(res, 5500)); // ≤1 сохранение в 5 с
  return r;
}

async function restoreByCaptured(): Promise<void> {
  if (restoredFlag || !opened) return;
  restoredFlag = true;
  logCaptured(CAPTURED_PATH, created, ownRoomIds);
  // m1 ревью 342: restore — только по захваченным ID; отделка СВОИХ комнат
  // снимается по подсказке реестра ДО удаления стен (иначе wall_delete отказывает)
  try { await restoreByCapturedCore({ call, created, ownRoomIds, save: () => saveTagged("restore"), log: console.log }); }
  catch (e) { console.log("restore:", String((e as Error).message).slice(0, 250)); }
  created = [];
  ownRoomIds = [];
  opened = false;
}

/** Пробная комната w×h (см), правее всей геометрии; возвращает roomId и полигон (см). */
async function makeTrialRoom(w: number, h: number): Promise<{ roomId: string; poly: Array<{ x: number; y: number }> }> {
  const beforeModel = await loadModel(ctx.session(), OBJECT_ID!, PLAN_ID!);
  const rawWalls = (beforeModel.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const maxX = Math.max(0, ...Object.values(rawWalls).flatMap((wl) => [wl.p1.x, wl.p2.x]));
  const maxY = Math.max(0, ...Object.values(rawWalls).flatMap((wl) => [wl.p1.y, wl.p2.y]));
  const ox = Math.ceil(maxX) + 300, oy = Math.ceil(maxY) + 300;
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
  await saveTagged("trial-room");
  await openAndGuard();
  const after = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const rooms = (after.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const entry = Object.entries(rooms).find(([, r]) => {
    const p = r.polygon ?? [];
    return p.length >= 3 && p.every((q) => q.x >= ox - 1 && q.x <= ox + w + 1 && q.y >= oy - 1 && q.y <= oy + h + 1);
  });
  if (!entry) throw new Error("пробная комната не появилась");
  ownRoomIds.push(entry[0]);
  logCaptured(CAPTURED_PATH, created, ownRoomIds);
  return { roomId: entry[0], poly: entry[1].polygon! };
}

async function openAndGuard(): Promise<void> {
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  opened = true;
  await call("render_plan", {});
  const ed = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { compatInfo(): Promise<{ plan_id?: unknown }> } | null;
  const compat = ed ? await ed.compatInfo() : null;
  const planInEditor = compat?.plan_id == null ? "" : String(compat.plan_id);
  if (!planInEditor) throw new Error("compat.plan_id пуст — стоп");
  if (planInEditor !== String(PLAN_ID)) throw new Error(`план в редакторе ${planInEditor} != серверу ${PLAN_ID}`);
  console.log("гард «план в редакторе == серверу»: OK");
}

/** Комната по site_id: compact model_get не несёт site_id комнат — метка R<n>
 *  без привязки; rooms2-ключ пробной комнаты сам годится для room_id (resolveRoom). */
function roomRefOf(roomId: string): string {
  return roomId;
}

let before: LoadedModel | null = null;
let roGuard: ReadonlyGuard | null = null;

try {
  roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const root = gitRepoRoot() ?? process.cwd();
  const backupPath = join(root, ".orca-reports", `backup-${OBJECT_ID}-341.json`);
  if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
  else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
    if (sig(stored.model as Record<string, unknown>) !== sig(before.model as Record<string, unknown>)) {
      throw new Error("модель на сервере не совпадает с бэкапом — стоп");
    }
  }
  console.log("бэкап:", backupPath);

  // ================= Сценарий A: wall_delete против отделки =================
  await roGuard.assertUnchanged("перед сценарием A");
  await openAndGuard();
  const roomA = await makeTrialRoom(340, 280);
  console.log("пробная комната A:", roomA.roomId);
  const refA = roomRefOf(roomA.roomId);
  // стены комнаты A — 4 захваченных site_id; координаты осей — в model_get (from/to, мм).
  // Нижняя (max средний Y) — под плинтусы/нишу, верхняя (min средний Y) — под wall_delete.
  const wallsA = ((await call("model_get", {}))["walls"] ?? []) as Array<{ id: string; site_id: string; from: [number, number]; to: [number, number] }>;
  const roomAWalls = wallsA.filter((w) => created.some((c) => c.kind === "wall" && c.siteId === w.site_id));
  if (roomAWalls.length !== 4) throw new Error(`у комнаты A ${roomAWalls.length} своих стен, ожидалось 4`);
  const midY = (w: { from: [number, number]; to: [number, number] }): number => (w.from[1] + w.to[1]) / 2;
  const sorted = [...roomAWalls].sort((u, v) => midY(v) - midY(u));
  const bottomId = sorted[0]!.id, topId = sorted[sorted.length - 1]!.id;
  console.log("стены A: bottom", bottomId, "top", topId);
  await call("finish_ceiling_set", { room_id: refA, material: "gypsum_ceiling", level: 0 });
  await call("finish_ceiling_complex_set", { room_id: refA, at_mm: { x: Math.round(((Math.min(...roomA.poly.map((p) => p.x)) + Math.max(...roomA.poly.map((p) => p.x))) / 2) * 10), y: Math.round(((Math.min(...roomA.poly.map((p) => p.y)) + Math.max(...roomA.poly.map((p) => p.y))) / 2) * 10) } });
  await call("finish_floor_molding_set", { room_id: refA, wall_id: bottomId, type: "floor_molding_mdf" });
  await call("finish_ceiling_molding_set", { room_id: refA, wall_id: bottomId });
  await call("finish_ceiling_niche_add", { room_id: refA, wall_id: bottomId });
  const vA = await call("model_validate", {});
  console.log("validate A:", JSON.stringify({ ok: vA["ok"] }));
  await saveTagged("A-finishes");
  await openAndGuard();
  const finA = await call("finish_get", { room_id: refA });
  console.log("finish_get A:", JSON.stringify(finA).slice(0, 500));

  // wall_delete → отказ с подсказкой
  let refused = "";
  try {
    refused = await callErr("wall_delete", { wall_id: topId });
  } catch (e) {
    throw new Error(`${String((e as Error).message)} — ожидался отказ INVALID_GEOMETRY с подсказкой`);
  }
  console.log("wall_delete отказ:", refused.slice(0, 700));
  if (!refused.includes("finish_ceiling_niche_remove")) throw new Error("в отказе нет finish_ceiling_niche_remove");
  if (!refused.includes("finish_ceiling_molding_remove")) throw new Error("в отказе нет finish_ceiling_molding_remove");
  if (!refused.includes("finish_floor_molding_remove")) throw new Error("в отказе нет finish_floor_molding_remove");
  if (!refused.includes("finish_ceiling_set")) throw new Error("в отказе нет finish_ceiling_set");
  const iNiche = refused.indexOf("finish_ceiling_niche_remove");
  const iCmold = refused.indexOf("finish_ceiling_molding_remove");
  const iFmold = refused.indexOf("finish_floor_molding_remove");
  const iSet = refused.indexOf("finish_ceiling_set");
  if (!(iNiche < iCmold && iCmold < iFmold && iFmold < iSet)) throw new Error("порядок инструментов в подсказке не по реестру");
  console.log("A-REFUSAL: PASS");

  // выполнение подсказки по шагам
  await call("finish_ceiling_niche_remove", { room_id: refA });
  await call("finish_ceiling_molding_remove", { room_id: refA });
  await call("finish_floor_molding_remove", { room_id: refA });
  const setOther = await call("finish_ceiling_set", { room_id: refA, material: "stretch_ceiling" });
  console.log("finish_ceiling_set (другое покрытие):", JSON.stringify((setOther as { warnings?: string[] }).warnings ?? []));
  if (!JSON.stringify((setOther as { warnings?: unknown[] }).warnings ?? []).includes("complex_removed")) throw new Error("смена материала не сняла двухуровневый потолок (нет complex_removed)");
  await call("finish_ceiling_remove", { room_id: refA });
  await call("wall_delete", { wall_id: topId });
  console.log("A-DELETE: PASS (wall_delete прошёл после снятия отделки)");
  await saveTagged("A-delete");
  await openAndGuard();
  const afterA = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsAfterA = (afterA.model["rooms2"] ?? {}) as Record<string, unknown>;
  if (roomsAfterA[roomA.roomId] !== undefined) throw new Error("комната A не исчезла после wall_delete");
  console.log("A-SAVE: PASS (save verified, комната исчезла)");

  // ================= Сценарий B: зонированный потолок, непокрытая зона =================
  await roGuard.assertUnchanged("перед сценарием B");
  await openAndGuard();
  const roomB = await makeTrialRoom(340, 280);
  console.log("пробная комната B:", roomB.roomId);
  const refB = roomRefOf(roomB.roomId);
  await call("finish_ceiling_set", { room_id: refB, material: "gypsum_ceiling", level: 15 });
  await saveTagged("B-finish");
  await openAndGuard();
  // вертикальный делитель зон потолка от стены до стены
  const xs = roomB.poly.map((p) => p.x), ys = roomB.poly.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const zs = await call("zone_ceiling_add", {
    room_id: refB,
    from_mm: { x: Math.round(cx * 10), y: Math.round(Math.min(...ys) * 10) },
    to_mm: { x: Math.round(cx * 10), y: Math.round(Math.max(...ys) * 10) },
  });
  const zSite = (zs as { site_id?: string }).site_id ?? (zs as { entity?: { site_id?: string } }).entity?.site_id;
  if (!zSite) throw new Error("zone_ceiling_add без site_id");
  created.push({ kind: "delimiter", siteId: zSite });
  logCaptured(CAPTURED_PATH, created, ownRoomIds);
  await saveTagged("B-delimiter");
  await openAndGuard();
  const afterDelim = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsDelim = (afterDelim.model["rooms2"] ?? {}) as Record<string, { ceilings?: Array<Record<string, unknown>> }>;
  const cB = roomsDelim[roomB.roomId]?.ceilings ?? [];
  console.log("B зоны после делителя:", JSON.stringify(cB.map((c) => ({ exist: c["exist"], material: c["material"], level: c["level"], profile: c["profile"], poly: Array.isArray(c["polygon"]) ? (c["polygon"] as unknown[]).length : 0 }))));
  if (cB.length < 2) throw new Error("делитель зон потолка не создал зоны");
  const uncovered = cB.filter((c) => c["exist"] !== true);
  if (uncovered.length === 0) throw new Error("нет непокрытой зоны — сценарий 337 n3 невоспроизводим");
  // finish_ceiling_set тем же материалом — непокрытая зона покрывается с наследованием
  await call("finish_ceiling_set", { room_id: refB, material: "gypsum_ceiling" });
  const finB = await call("finish_get", { room_id: refB });
  console.log("finish_get B:", JSON.stringify(finB).slice(0, 600));
  await saveTagged("B-same-material");
  await openAndGuard();
  const afterB = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsAfterB = (afterB.model["rooms2"] ?? {}) as Record<string, { ceilings?: Array<Record<string, unknown>> }>;
  const cB2 = roomsAfterB[roomB.roomId]?.ceilings ?? [];
  console.log("B зоны после finish_ceiling_set (сервер):", JSON.stringify(cB2.map((c) => ({ exist: c["exist"], material: c["material"], level: c["level"], profile: c["profile"] }))));
  if (cB2.length < 2 || cB2.some((c) => c["exist"] !== true)) throw new Error("не все зоны покрыты после finish_ceiling_set тем же материалом");
  for (const c of cB2) {
    if (c["material"] !== "gypsum_ceiling") throw new Error("материал зоны не совпал");
    if (Number(c["level"] ?? 0) !== 15) throw new Error(`зона не унаследовала level 15 (n3): ${String(c["level"])}`);
    if (String(c["profile"] ?? "standard") !== "standard") throw new Error(`зона не унаследовала profile: ${String(c["profile"])}`);
  }
  console.log("B-INHERIT: PASS (зона покрыта, level/profile унаследованы, save verified)");

  console.log("DONE");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 1500));
  process.exitCode = 1;
} finally {
  try { await restoreByCaptured(); } catch (ce) { console.error("RESTORE FAIL:", String((ce as Error).message ?? ce).slice(0, 400)); process.exitCode = 1; }
  try {
    if (before) {
      const final = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
      const same = sig(final.model) === sig(before.model);
      console.log("сверка с бэкапом (sig модели):", same ? "OK" : "РАСХОЖДЕНИЕ");
      if (!same) process.exitCode = 1;
    }
  } catch (ce) { console.error("final check:", String((ce as Error).message ?? ce).slice(0, 300)); }
  try { await roGuard?.checkFinal("finally"); } catch (ce) { console.error("ro:", String((ce as Error).message ?? ce).slice(0, 200)); }
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
