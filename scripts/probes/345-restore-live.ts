// 345 fix-2 (ревью 344 M1, живая проверка restore — главный риск этапа, dev-объект, ID только из env):
// пробная комната с отделкой (пол, стены, двухуровневый потолок, плинтусы, ниша) →
// restore из probe-restore.ts (снятие отделки по подсказке реестра, стены по захваченным
// site_id) → комната и стены удалены, save verified, сверка с бэкапом backup-<OBJECT>-345.json
// (снимается ДО прогона) по sig(). M1 ревью 344: finish_get отвечает МАССИВОМ — форма
// проверяется живым вызовом до restore. Гарды полные (probe-guard): ID из env, READONLY
// обязателен, GET-пара, план в редакторе == серверу, эталон контрольного проекта — корневой
// (без REF_INIT; расхождение — немедленный стоп), roGuard перед каждой записью, restore по
// захваченным ID в finally, журнал ID — .orca-reports/tmp/345-captured.json, closeBrowser.
// node scripts/probes/345-restore-live.ts run
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const client = new Client({ name: "345-restore-live", version: "0.0.0" });
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

type Created = ProbeCreated;
let created: Created[] = [];
let ownRoomIds: string[] = [];
let opened = false;
let restoredFlag = false;
// журнал захваченных ID: доочистка — только по ним, не по геометрии
const CAPTURED_PATH = join(ROOT_DIR, ".orca-reports", "tmp", "345-captured.json");

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
  // restore — только по захваченным ID; отделка СВОИХ комнат снимается по подсказке
  // реестра ДО удаления стен (иначе wall_delete отказывает, как в живом логе 341)
  try { await restoreByCapturedCore({ call, created, ownRoomIds, save: () => saveTagged("restore"), log: console.log }); }
  catch (e) { console.log("restore:", String((e as Error).message).slice(0, 250)); }
  created = [];
  ownRoomIds = [];
  opened = false;
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

/** Пробная комната w×h (см), правее всей геометрии; rooms2-ключ захватывается
 *  при создании (n2 ревью 344: запись идёт только в отделку своей комнаты). */
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

let before: LoadedModel | null = null;
let roGuard: ReadonlyGuard | null = null;

try {
  roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const root = gitRepoRoot() ?? process.cwd();
  // бэкап снимается ДО прогона (этап 345); существующий файл — сверка sig, расхождение — стоп
  const backupPath = join(root, ".orca-reports", `backup-${OBJECT_ID}-345.json`);
  if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
  else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
    if (sig(stored.model as Record<string, unknown>) !== sig(before.model as Record<string, unknown>)) {
      throw new Error("модель на сервере не совпадает с бэкапом — стоп");
    }
  }
  console.log("бэкап:", backupPath);

  // ================= Пробная комната с отделкой =================
  await roGuard.assertUnchanged("перед сценарием");
  await openAndGuard();
  const room = await makeTrialRoom(340, 280);
  console.log("пробная комната:", room.roomId);
  const wallsAll = ((await call("model_get", {}))["walls"] ?? []) as Array<{ id: string; site_id: string; from: [number, number]; to: [number, number] }>;
  const roomWalls = wallsAll.filter((w) => created.some((c) => c.kind === "wall" && c.siteId === w.site_id));
  if (roomWalls.length !== 4) throw new Error(`у пробной комнаты ${roomWalls.length} своих стен, ожидалось 4`);
  const midY = (w: { from: [number, number]; to: [number, number] }): number => (w.from[1] + w.to[1]) / 2;
  const bottomId = [...roomWalls].sort((u, v) => midY(v) - midY(u))[0]!.id;
  console.log("стены (4 своих):", JSON.stringify(roomWalls.map((w) => w.site_id)), "bottom", bottomId);
  // отделка: пол, стены, двухуровневый потолок, плинтусы (пол+потолок), ниша
  await call("finish_ceiling_set", { room_id: room.roomId, material: "gypsum_ceiling", level: 0 });
  await call("finish_ceiling_complex_set", { room_id: room.roomId, at_mm: { x: Math.round(((Math.min(...room.poly.map((p) => p.x)) + Math.max(...room.poly.map((p) => p.x))) / 2) * 10), y: Math.round(((Math.min(...room.poly.map((p) => p.y)) + Math.max(...room.poly.map((p) => p.y))) / 2) * 10) } });
  await call("finish_floor_set", { room_id: room.roomId, cover: "laminate" });
  await call("finish_wall_set", { room_id: room.roomId, wall_id: bottomId, type: "wallpaper" });
  await call("finish_floor_molding_set", { room_id: room.roomId, wall_id: bottomId, type: "floor_molding_mdf" });
  await call("finish_ceiling_molding_set", { room_id: room.roomId, wall_id: bottomId });
  await call("finish_ceiling_niche_add", { room_id: room.roomId, wall_id: bottomId });
  const v = await call("model_validate", {});
  console.log("validate:", JSON.stringify({ ok: v["ok"] }));
  await saveTagged("finishes");
  await openAndGuard();
  // M1 ревью 344: живой finish_get — МАССИВ, запись своей комнаты по site_id
  const fin = await call("finish_get", { room_id: room.roomId });
  const finList = (fin as unknown as { data?: unknown }).data ?? fin;
  const arr = Array.isArray(finList) ? finList as Array<Record<string, unknown>> : null;
  if (!arr) throw new Error(`finish_get вернул не массив: ${JSON.stringify(fin).slice(0, 200)}`);
  const rec = arr.find((r) => r["site_id"] === room.roomId) ?? arr[0];
  if (!rec) throw new Error("finish_get без записи пробной комнаты");
  console.log("finish_get (массив):", JSON.stringify(arr).slice(0, 600));
  for (const key of ["floor", "ceiling", "walls", "floor_moldings", "ceiling_moldings", "niches"] as const) {
    if (rec[key] === undefined || (Array.isArray(rec[key]) && (rec[key] as unknown[]).length === 0)) {
      throw new Error(`в finish_get нет ${key} — отделка не встала`);
    }
  }
  console.log("SETUP: PASS (отделка пола/стен/complex-потолка/плинтусов/ниши на сервере)");

  // ================= Restore по захваченным ID =================
  await restoreByCapturedCore({ call, created, ownRoomIds, save: () => saveTagged("restore"), log: console.log });
  if (created.length !== 0) throw new Error(`restore оставил свои стены: ${JSON.stringify(created)}`);
  await openAndGuard();
  const afterR = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsAfter = (afterR.model["rooms2"] ?? {}) as Record<string, unknown>;
  if (roomsAfter[room.roomId] !== undefined) throw new Error("пробная комната не исчезла после restore");
  console.log("RESTORE: PASS (комната и свои стены удалены, save verified)");
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
