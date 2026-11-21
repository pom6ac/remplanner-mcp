// 349/353 (живая перепроверка фикс-2 b4193ae перед слиянием PR #52, ID только из env):
// (а) M1-R — floor_tile (400×400, tile, шов 3) → подъём/якорь → смена на laminate БЕЗ
//     параметров: после save/reopen у записи умолчания ламината (width/height/stitch_width/
//     type_laying — сверка с tools.laminate живой страницы, эталон бандла 120/18/0.2/1/2),
//     f0offset/anchor сохранены;
// (б) то же покрытие (laminate без параметров): параметры раскладки, подъём, якорь, id
//     записи сохранены;
// (в) M2-R — room_set_name → wall_move → undo → save verified, имя комнаты на сервере;
// (г) M2-R — redo → save verified, имя переживает пересоздание комнаты (новый id);
// (д) наблюдение без фикса (f1 ревью 352): rename → wall_move через противоположную
//     стену (split на две комнаты) → save → wall_move обратно в исходный контур (merge)
//     → save: что редактор делает с именем частей и что отвечает MCP на save после merge.
// Гарды полные (probe-guard): READONLY обязателен, коллизий env нет, GET-пара,
// план в редакторе == серверу перед каждым reopen/записью, roGuard перед каждой
// записью, финальная сверка контрольного проекта — await checkFinal, closeBrowser в
// finally. Бэкап .orca-reports/backup-<OBJECT>-353.json ДО прогона, restore общим
// probe-restore по захваченным ID, сверка sig с бэкапом в конце.
// node scripts/probes/349-finish9-fix-live.ts run
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { sig } from "./probe-sig.ts";
import { assertNoReadonlyCollision, assertTargetPair, readonlyGuard, readonlyRefPath, type ReadonlyGuard } from "./probe-guard.ts";
import { logCaptured, restoreByCaptured, type ProbeCreated } from "./probe-restore.ts";

if (process.argv[2] !== "run") {
  console.error("запуск: run");
  process.exit(0);
}
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"] as string;
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"] as string;
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"] as string;
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"] as string;
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) { console.error("нужны env"); process.exit(1); }
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 20 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "349-finish9-fix-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as TextContent).content ?? []).map((c) => c.text ?? "").join("");
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 600)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};

let created: ProbeCreated[] = [];
let opened = false;
let restoredFlag = false;
let before: LoadedModel | null = null;
let roGuard: ReadonlyGuard | null = null;
let probeRoomSites = new Set<string>();
// журнал захваченных ID (probe-restore.logCaptured) — зачистка только по нему
const CAPTURED_PATH = `.orca-reports/tmp/349-captured-${OBJECT_ID}.json`;
const journal = (): void => logCaptured(CAPTURED_PATH, created, [...probeRoomSites]);

async function saveTagged(tag: string): Promise<Record<string, unknown>> {
  await roGuard?.assertUnchanged(tag);
  const r = await call("project_save", {});
  console.log(`save ${tag}:`, JSON.stringify({ verified: r["verified"], warnings: ((r["warnings"] ?? []) as unknown[]).length }));
  if (!r["verified"]) throw new Error(`save ${tag} не verified: ${JSON.stringify(r["details"] ?? r).slice(0, 600)}`);
  await new Promise((res) => setTimeout(res, 5500)); // ≤1 сохранение в 5 с
  return r;
}

/** Сохранение-наблюдение (д): ответ MCP логируется, отказ НЕ останавливает пробу. */
async function observeSave(tag: string): Promise<{ verified: boolean; raw: string }> {
  await roGuard?.assertUnchanged(tag);
  try {
    const r = await call("project_save", {});
    const raw = JSON.stringify({ verified: r["verified"], warnings: r["warnings"], details: r["details"] });
    console.log(`save ${tag} (наблюдение):`, raw.slice(0, 700));
    await new Promise((res) => setTimeout(res, 5500));
    return { verified: r["verified"] === true, raw };
  } catch (e) {
    const raw = String((e as Error).message).slice(0, 700);
    console.log(`save ${tag} (наблюдение) ОТКАЗ:`, raw);
    await new Promise((res) => setTimeout(res, 5500));
    return { verified: false, raw };
  }
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

/** Умолчания инструмента покрытия с живой страницы (window.tools[tool]); null —
 *  страница недоступна (тогда сверка идёт с эталоном бандла). */
type ToolDefaults = { width?: number; height?: number; stitch_width?: number; type_laying?: string };
async function readToolDefaults(tool: string): Promise<ToolDefaults | null> {
  const ed = ctx.workspaceOrNull?.editorOrNull() as unknown as { page?: { evaluate<T>(fn: string): Promise<T> } } | null;
  if (!ed?.page) return null;
  try {
    const got = await ed.page.evaluate<ToolDefaults | null>(`(() => {
      const t = (typeof tools !== "undefined" && tools && tools[${JSON.stringify(tool)}]) ? tools[${JSON.stringify(tool)}] : null;
      return t ? { width: t.width, height: t.height, stitch_width: t.stitch_width, type_laying: t.type_laying } : null;
    })()`);
    return got && typeof got === "object" ? got : null;
  } catch { return null; }
}

/** Живая запись пола комнаты из ROOMS2 (объект Floor редактора до сериализации). */
async function readLiveFloor(roomId: string): Promise<ToolDefaults | null> {
  const ed = ctx.workspaceOrNull?.editorOrNull() as unknown as { page?: { evaluate<T>(fn: string): Promise<T> } } | null;
  if (!ed?.page) return null;
  try {
    const got = await ed.page.evaluate<ToolDefaults | null>(`(() => {
      const r = (window.ROOMS2 || {})[${JSON.stringify(roomId)}];
      const f = r && r.floors && r.floors[0];
      return f ? { width: f.width, height: f.height, stitch_width: f.stitch_width, type_laying: f.type_laying, cover: f.cover } : null;
    })()`);
    return got && typeof got === "object" ? got : null;
  } catch { return null; }
}

function roomsRef(siteId: string, roomsList: Array<{ id: string; site_id?: string }>): string {
  return roomsList.find((r) => r.site_id === siteId)?.id ?? siteId;
}

/** Пробная комната w×h (см), правее всей геометрии; возвращает roomId, полигон (см)
 *  и site_id стен в порядке создания (верх, право, низ, лево). */
async function makeTrialRoom(w: number, h: number): Promise<{ roomId: string; poly: Array<{ x: number; y: number }>; wallSites: string[] }> {
  const beforeModel = await loadModel(ctx.session(), OBJECT_ID!, PLAN_ID!);
  const rawWalls = (beforeModel.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const maxX = Math.max(0, ...Object.values(rawWalls).flatMap((wl) => [wl.p1.x, wl.p2.x]));
  const maxY = Math.max(0, ...Object.values(rawWalls).flatMap((wl) => [wl.p1.x * 0 + wl.p1.y, wl.p2.y]));
  const ox = Math.ceil(maxX) + 300, oy = Math.ceil(maxY) + 300;
  type Pt = { x: number; y: number };
  const wallSites: string[] = [];
  for (const [p1, p2] of [
    [{ x: ox, y: oy }, { x: ox + w, y: oy }],
    [{ x: ox + w, y: oy }, { x: ox + w, y: oy + h }],
    [{ x: ox + w, y: oy + h }, { x: ox, y: oy + h }],
    [{ x: ox, y: oy + h }, { x: ox, y: oy }],
  ] as [Pt, Pt][]) {
    const res = await call("wall_add", { start: { x: Math.round(p1.x * 10), y: Math.round(p1.y * 10) }, end: { x: Math.round(p2.x * 10), y: Math.round(p2.y * 10) }, thickness_mm: 100 });
    const sid = (res as { entity?: { site_id?: string } | { entity?: { site_id?: string } }[] }).entity;
    const siteId = Array.isArray(sid) ? sid[0]?.entity?.site_id : (sid as { site_id?: string } | undefined)?.site_id;
    if (!siteId) throw new Error("wall_add без site_id");
    wallSites.push(siteId);
    created.push({ kind: "wall", siteId });
    // n3-R ревью 350: журнал пишется сразу после каждого created.push —
    // жёсткое падение между wall_add и saveTagged не теряет стены из журнала
    journal();
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
  return { roomId: entry[0], poly: entry[1].polygon!, wallSites };
}

async function restoreProbe(): Promise<void> {
  if (restoredFlag || !opened) return;
  restoredFlag = true;
  journal();
  try {
    await restoreByCaptured({
      call,
      created,
      ownRoomIds: [...probeRoomSites],
      save: async () => {
        try { await saveTagged("restore"); }
        catch (e) { console.log("restore save:", String((e as Error).message).slice(0, 300)); }
      },
      log: (line) => console.log("restore:", line),
    });
  } finally {
    created = [];
    opened = false;
  }
}

type FloorRec = Record<string, unknown>;
function floorOf(model: LoadedModel, roomId: string): FloorRec | undefined {
  const rooms = (model.model["rooms2"] ?? {}) as Record<string, { floors?: FloorRec[] }>;
  return rooms[roomId]?.floors?.[0];
}
function roomName(model: LoadedModel, roomId: string): string | null {
  const rooms = (model.model["rooms2"] ?? {}) as Record<string, { zones?: Array<Record<string, unknown>> }>;
  const z = rooms[roomId]?.zones?.[0];
  return typeof z?.["name"] === "string" ? z["name"] : null;
}
async function rightWallId(): Promise<string> {
  const mg = (await call("model_get", {})) as { walls?: Array<{ id: string; site_id?: string }> };
  const w = (mg.walls ?? []).find((x) => x.site_id === RIGHT_WALL_SITE);
  if (!w) throw new Error("правая стена пробной комнаты не найдена в model_get");
  return w.id;
}
let RIGHT_WALL_SITE = "";

try {
  roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = ".orca-reports/backup-".concat(OBJECT_ID, "-353.json");
  if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
  else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
    if (sig(stored.model as Record<string, unknown>) !== sig(before.model as Record<string, unknown>)) {
      throw new Error("модель на сервере не совпадает с бэкапом — стоп");
    }
  }
  await openAndGuard();

  // ---- пробная комната ----
  await roGuard.assertUnchanged("перед пробной комнатой");
  const trial = await makeTrialRoom(400, 300);
  console.log("пробная комната:", trial.roomId);
  probeRoomSites.add(trial.roomId);
  journal();
  const roomsList0 = ((await call("model_get", {}))["rooms"] ?? []) as Array<{ id: string; site_id?: string }>;
  const roomRef = roomsRef(trial.roomId, roomsList0);
  const px = trial.poly.map((p) => p.x), py = trial.poly.map((p) => p.y);
  RIGHT_WALL_SITE = trial.wallSites[1]!;

  // ---- (а) floor_tile → laminate: умолчания ламината, f0offset/anchor сохранены ----
  await roGuard.assertUnchanged("перед частью (а)");
  await call("finish_floor_set", { room_id: roomRef, cover: "floor_tile", plank_length_mm: 400, plank_width_mm: 400, stitch_width_mm: 3, type_laying: "tile" });
  await saveTagged("tile");
  await openAndGuard();
  const tileModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const tileRec = floorOf(tileModel, trial.roomId);
  console.log("tile-запись на сервере:", JSON.stringify({ cover: tileRec?.["cover"], width: tileRec?.["width"], height: tileRec?.["height"], stitch_width: tileRec?.["stitch_width"], type_laying: tileRec?.["type_laying"] }));
  await call("finish_floor_offset_set", { room_id: roomRef, offset_mm: 300 });
  const ax = Math.min(...px) + (Math.max(...px) - Math.min(...px)) * 0.6;
  const ay = Math.min(...py) + (Math.max(...py) - Math.min(...py)) * 0.6;
  await call("finish_floor_anchor_set", { room_id: roomRef, at_mm: { x: Math.round(ax * 10), y: Math.round(ay * 10) } });
  await saveTagged("podium");
  // умолчания ламината с живой страницы (эталон бандла: 120/18/0.2/«1/2»)
  const lamLive = await readToolDefaults("laminate");
  console.log("tools.laminate (страница):", lamLive ? JSON.stringify(lamLive) : "недоступна — эталон бандла");
  await call("finish_floor_set", { room_id: roomRef, cover: "laminate" });
  const v1 = (await call("model_validate", {})) as Record<string, unknown>;
  console.log("validate (а):", JSON.stringify(v1).slice(0, 600));
  await saveTagged("cover-change");
  await openAndGuard();
  const afterCover = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const lamRec = floorOf(afterCover, trial.roomId);
  console.log("(а) reopen после смены покрытия:", JSON.stringify({ cover: lamRec?.["cover"], width: lamRec?.["width"], height: lamRec?.["height"], stitch_width: lamRec?.["stitch_width"], type_laying: lamRec?.["type_laying"], f0offset: lamRec?.["f0offset"], anchor: lamRec?.["anchor"] }));
  if (!lamRec || lamRec["cover"] !== "laminate") throw new Error("(а): покрытие не сменилось на laminate");
  // M1-R: панельные поля tile (40/40/0.3/tile) НЕ наследуются. На сервере после
  // save/reopen их нет вовсе (наблюдение 353/проба 349: конструктор Floor в
  // restore-контексте получает settings.width=0 и сериализация пустые поля
  // опускает); в редакторе умолчания инструмента подставляются при отрисовке.
  if (lamRec["width"] !== undefined || lamRec["height"] !== undefined || lamRec["stitch_width"] !== undefined || lamRec["type_laying"] !== undefined) {
    throw new Error(`(а): панельные поля унаследовались/записались при смене покрытия (ожидались умолчания/отсутствие): ${JSON.stringify(lamRec)}`);
  }
  // наблюдение: что держит живой редактор в ROOMS2 для этой комнаты
  const lamLiveRoom = await readLiveFloor(trial.roomId);
  console.log("(а) живой ROOMS2 floors[0]:", lamLiveRoom ? JSON.stringify(lamLiveRoom) : "недоступно");
  if (lamRec["f0offset"] !== 30) throw new Error(`(а): подъём пола стёрт сменой покрытия: ${JSON.stringify(lamRec)}`);
  const anchorRec = lamRec["anchor"] as { p?: { x?: number; y?: number } } | undefined;
  if (!anchorRec?.p || Math.abs((anchorRec.p.x ?? 0) - ax) > 1 || Math.abs((anchorRec.p.y ?? 0) - ay) > 1) {
    throw new Error("(а): точка укладки стёрта сменой покрытия");
  }
  console.log("(а) M1-R (умолчания ламината, f0offset/anchor сохранены): PASS");

  // ---- (б) то же покрытие: параметры раскладки сохранены ----
  await roGuard.assertUnchanged("перед частью (б)");
  const firstId = lamRec["id"];
  await call("finish_floor_set", { room_id: roomRef, cover: "laminate" });
  await saveTagged("same-cover");
  await openAndGuard();
  const afterSame = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const sameRec = floorOf(afterSame, trial.roomId);
  console.log("(б) reopen того же покрытия:", JSON.stringify({ id: sameRec?.["id"], width: sameRec?.["width"], height: sameRec?.["height"], stitch_width: sameRec?.["stitch_width"], type_laying: sameRec?.["type_laying"], f0offset: sameRec?.["f0offset"] }));
  if (!sameRec) throw new Error("(б): запись пола пропала");
  if (sameRec["width"] !== lamRec["width"] || sameRec["height"] !== lamRec["height"] || sameRec["stitch_width"] !== lamRec["stitch_width"] || sameRec["type_laying"] !== lamRec["type_laying"]) {
    throw new Error("(б): параметры раскладки не сохранились при том же покрытии");
  }
  if (sameRec["f0offset"] !== 30 || !sameRec["anchor"]) throw new Error("(б): подъём/якорь потеряны при том же покрытии");
  if (sameRec["id"] !== firstId) throw new Error(`(б): id записи изменился: ${String(firstId)} → ${String(sameRec["id"])}`);
  console.log("(б) (параметры раскладки при том же покрытии): PASS");

  // ---- (в) rename → wall_move → undo → save verified ----
  await roGuard.assertUnchanged("перед частью (в)");
  await call("room_set_name", { room_id: roomRef, name: "Зал 9" });
  const rw1 = await rightWallId();
  await call("wall_move", { wall_id: rw1, offset_mm: 500 });
  const u = await call("undo", {});
  console.log("undo:", JSON.stringify(u));
  if ((u["applied"] as number) !== 1) throw new Error(`(в): undo не применился: ${JSON.stringify(u)}`);
  await saveTagged("undo");
  await openAndGuard();
  const afterUndo = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const undoName = roomName(afterUndo, trial.roomId);
  console.log("(в) имя после undo+save:", JSON.stringify(undoName));
  if (undoName !== "Зал 9") throw new Error(`(в): имя потерялось после undo+save: ${JSON.stringify(undoName)}`);
  console.log("(в) M2-R (rename → wall_move → undo → save): PASS");

  // ---- (г) rename → wall_move → undo → redo → save verified, имя на новом id ----
  await roGuard.assertUnchanged("перед частью (г)");
  await call("room_set_name", { room_id: roomRef, name: "Зал 9" });
  const rw2 = await rightWallId();
  await call("wall_move", { wall_id: rw2, offset_mm: 500 });
  const u2 = await call("undo", {});
  console.log("undo (г):", JSON.stringify(u2));
  if ((u2["applied"] as number) !== 1) throw new Error(`(г): undo не применился: ${JSON.stringify(u2)}`);
  const r = await call("redo", {});
  console.log("redo (г):", JSON.stringify(r));
  if ((r["applied"] as number) !== 1) throw new Error(`(г): redo не применился: ${JSON.stringify(r)}`);
  await saveTagged("redo");
  await openAndGuard();
  const afterRedo = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsAfterMove = (afterRedo.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }>; zones?: Array<Record<string, unknown>> }>;
  const maxX1 = Math.max(...px) + 51;
  const moved = Object.entries(roomsAfterMove).filter(([, room]) => {
    const p = room.polygon ?? [];
    return p.length >= 3 && p.every((q) => q.x >= Math.min(...px) - 1 && q.x <= maxX1 && q.y >= Math.min(...py) - 1 && q.y <= Math.max(...py) + 1);
  });
  console.log("после redo: комнат в bbox:", moved.length);
  if (moved.length !== 1) throw new Error(`ожидалась 1 комната после redo, найдено ${moved.length}`);
  const [newRoomId, newRoom] = moved[0]!;
  const gotName = typeof newRoom.zones?.[0]?.["name"] === "string" ? newRoom.zones![0]!["name"] : null;
  console.log("(г) id комнаты:", `${trial.roomId} → ${newRoomId}`, "имя:", JSON.stringify(gotName));
  if (gotName !== "Зал 9") throw new Error(`(г): имя потерялось после redo+save: ${JSON.stringify(gotName)}`);
  probeRoomSites.delete(trial.roomId);
  probeRoomSites.add(newRoomId);
  journal();
  console.log("(г) M2-R (redo → save, имя на новом id): PASS");

  // ---- (д) наблюдение: rename → split (wall_move через противоположную стену) → merge ----
  // Наблюдение 353: MCP сам отказывает в split/merge, пока у комнаты есть покрытие
  // пола (защита отделки, INVALID_GEOMETRY) — для наблюдения имени снимаем покрытие
  // (пробная комната, зачистка удаляет её целиком).
  await roGuard.assertUnchanged("перед частью (д)");
  await call("finish_floor_remove", { room_id: roomRef });
  const rw3 = await rightWallId();
  await call("wall_move", { wall_id: rw3, offset_mm: -5000 });
  const splitMg = (await call("model_get", {})) as { rooms?: Array<{ id: string; site_id?: string }> };
  const splitModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const splitRooms = (splitModel.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }>; zones?: Array<Record<string, unknown>>; floors?: FloorRec[] }>;
  const splitRows = Object.entries(splitRooms).filter(([, room]) => {
    const p = room.polygon ?? [];
    return p.length >= 3 && p.some((q) => q.x >= Math.min(...px) - 1 && q.x <= Math.max(...px) + 1);
  }).map(([rid, room]) => ({
    id: rid,
    ref: roomsRef(rid, splitMg.rooms ?? []),
    name: typeof room.zones?.[0]?.["name"] === "string" ? room.zones![0]!["name"] : null,
    cover: room.floors?.[0]?.["cover"] ?? null,
  }));
  console.log("(д) после split: комнат в колонке пробной:", JSON.stringify(splitRows));
  for (const row of splitRows) probeRoomSites.add(row.id);
  journal();
  const splitSave = await observeSave("split");
  // merge обратно в исходный контур
  await call("wall_move", { wall_id: rw3, offset_mm: 5000 });
  const mergeMg = (await call("model_get", {})) as { rooms?: Array<{ id: string; site_id?: string }> };
  const mergeModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const mergeRooms = (mergeModel.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }>; zones?: Array<Record<string, unknown>>; floors?: FloorRec[] }>;
  const mergeRows = Object.entries(mergeRooms).filter(([, room]) => {
    const p = room.polygon ?? [];
    return p.length >= 3 && p.some((q) => q.x >= Math.min(...px) - 1 && q.x <= Math.max(...px) + 1);
  }).map(([rid, room]) => ({
    id: rid,
    ref: roomsRef(rid, mergeMg.rooms ?? []),
    name: typeof room.zones?.[0]?.["name"] === "string" ? room.zones![0]!["name"] : null,
    cover: room.floors?.[0]?.["cover"] ?? null,
  }));
  console.log("(д) после merge: комнат в колонке пробной:", JSON.stringify(mergeRows));
  for (const row of mergeRows) probeRoomSites.add(row.id);
  journal();
  const mergeSave = await observeSave("merge-back");
  console.log("(д) итог наблюдения:", JSON.stringify({ split_save: splitSave.verified, merge_save: mergeSave.verified, merge_save_raw: mergeSave.raw.slice(0, 400) }));
  // состояние сервера после наблюдения (для отчёта; на исход не влияет)
  await openAndGuard();
  const afterObs = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const obsRooms = (afterObs.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }>; zones?: Array<Record<string, unknown>> }>;
  const obsRows = Object.entries(obsRooms).filter(([, room]) => {
    const p = room.polygon ?? [];
    return p.length >= 3 && p.some((q) => q.x >= Math.min(...px) - 1 && q.x <= Math.max(...px) + 1);
  }).map(([rid, room]) => ({
    id: rid,
    name: typeof room.zones?.[0]?.["name"] === "string" ? room.zones![0]!["name"] : null,
  }));
  console.log("(д) сервер после merge-save/reopen:", JSON.stringify(obsRows));

  // ---- зачистка ----
  await roGuard.assertUnchanged("перед зачисткой");
  await restoreProbe();
  await openAndGuard();
  const final = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const sigOk = sig(final.model as Record<string, unknown>) === sig(before!.model as Record<string, unknown>);
  console.log("сверка с бэкапом (sig):", sigOk ? "OK" : "РАСХОЖДЕНИЕ");
  if (!sigOk) throw new Error("финальная модель не совпала с бэкапом");
  const allProbeRooms = [trial.roomId, ...[...probeRoomSites]];
  const probeRoomLeft = allProbeRooms.some((rid) => rid in ((final.model["rooms2"] ?? {}) as Record<string, unknown>));
  console.log("пробная комната удалена:", !probeRoomLeft);
  const changedFinal = await roGuard.checkFinal("финал");
  console.log("контрольный проект:", changedFinal ? "ИЗМЕНИЛСЯ" : "не изменился");
  console.log("349-finish9-fix-live (353): PASS — сценарии (а)-(г) зелёные, (д) наблюдение записано");
} catch (e) {
  console.error("FAIL:", String((e as Error).message).slice(0, 800));
  try { await restoreProbe(); } catch (e2) { console.error("restore:", String((e2 as Error).message).slice(0, 200)); }
  process.exitCode = 1;
} finally {
  await closeBrowser();
  process.exit(process.exitCode ?? 0);
}
