// 349 (фикс ревью 348, живая перепроверка M1/M2 в dev-объекте, ID только из env):
// 1) M1 — подъём пола + точка укладки переживают смену покрытия (finish_floor_set
//    другим материалом без параметров): save verified, reopen — f0offset/anchor/cover;
// 2) M2 — имя зоны переживает wall_move (редактор пересоздаёт комнату с новым id):
//    room_set_name → wall_move → save verified без ложной блокировки; reopen — имя;
//    room_set_color на новом id → save verified;
// 3) зачистка: журнал захваченных ID (probe-restore.logCaptured), восстановление
//    общим probe-restore (restoreByCaptured), save restore, сверка sig с бэкапом
//    .orca-reports/backup-<OBJECT>-349.json (снимается ДО прогона).
// Гарды полные (probe-guard): READONLY обязателен, коллизий env нет, GET-пара,
// план в редакторе == серверу перед каждым reopen/записью, roGuard перед каждой
// записью, финальная сверка контрольного проекта — await checkFinal (m6 ревью 348),
// closeBrowser в finally. node scripts/probes/349-finish9-fix-live.ts run
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
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

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

try {
  roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = ".orca-reports/backup-".concat(OBJECT_ID, "-349.json");
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

  // ---- часть 1 (M1): подъём + якорь переживают смену покрытия ----
  await roGuard.assertUnchanged("перед частью 1");
  await call("finish_floor_set", { room_id: roomRef, cover: "laminate", plank_length_mm: 1200, plank_width_mm: 180, stitch_width_mm: 2 });
  await saveTagged("floor");
  await call("finish_floor_offset_set", { room_id: roomRef, offset_mm: 300 });
  const ax = Math.min(...px) + (Math.max(...px) - Math.min(...px)) * 0.6;
  const ay = Math.min(...py) + (Math.max(...py) - Math.min(...py)) * 0.6;
  await call("finish_floor_anchor_set", { room_id: roomRef, at_mm: { x: Math.round(ax * 10), y: Math.round(ay * 10) } });
  // M1: смена покрытия БЕЗ параметров — подъём/якорь переживают; панельные
  // параметры НЕ наследуются (M1-R ревью 350): width/height после смены —
  // умолчания нового покрытия (конструктор Floor), поэтому сверяем только
  // f0offset/anchor/cover
  await call("finish_floor_set", { room_id: roomRef, cover: "parquet" });
  const v1 = await call("model_validate", {});
  console.log("validate 1:", JSON.stringify({ ok: v1["ok"] }));
  await saveTagged("cover-change");
  await openAndGuard();
  const afterCover = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const floorRec = ((afterCover.model["rooms2"] ?? {}) as Record<string, { floors?: Array<Record<string, unknown>> }>)[trial.roomId]?.floors?.[0];
  console.log("reopen после смены покрытия:", JSON.stringify({ cover: floorRec?.["cover"], f0offset: floorRec?.["f0offset"], anchor: floorRec?.["anchor"], width: floorRec?.["width"] }));
  if (!floorRec || floorRec["cover"] !== "parquet") throw new Error("покрытие не сменилось");
  if (floorRec["f0offset"] !== 30) throw new Error(`M1: подъём пола стёрт сменой покрытия: ${JSON.stringify(floorRec)}`);
  const anchorRec = floorRec["anchor"] as { p?: { x?: number; y?: number } } | undefined;
  if (!anchorRec?.p || Math.abs((anchorRec.p.x ?? 0) - ax) > 1 || Math.abs((anchorRec.p.y ?? 0) - ay) > 1) {
    throw new Error("M1: точка укладки стёрта сменой покрытия");
  }
  // M1-R ревью 350: панельные параметры при смене покрытия — умолчания нового
  // покрытия, прежние (120/18) переживать не обязаны; конкретное значение
  // умолчаний паркета офлайн не сверялось — не проверяем
  console.log("M1 (сменa покрытия не стирает поля): PASS");

  // ---- часть 2 (M2): имя зоны переживает wall_move (новый id комнаты) ----
  await roGuard.assertUnchanged("перед частью 2");
  const nameRes = await call("room_set_name", { room_id: roomRef, name: "Зал 9" });
  console.log("room_set_name:", JSON.stringify(nameRes).slice(0, 120));
  await saveTagged("name");
  // перенос правой стены наружу на 50 см — контур меняется, редактор пересоздаёт комнату
  const mg1 = (await call("model_get", {})) as { walls?: Array<{ id: string; site_id?: string }> };
  const rightWall = (mg1.walls ?? []).find((w) => w.site_id === trial.wallSites[1]);
  if (!rightWall) throw new Error("правая стена пробной комнаты не найдена в model_get");
  await call("wall_move", { wall_id: rightWall.id, offset_mm: 500 });
  await saveTagged("wall-move");
  await openAndGuard();
  const afterMove = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsAfterMove = (afterMove.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }>; zones?: Array<Record<string, unknown>> }>;
  const maxX1 = Math.max(...px) + 51;
  const moved = Object.entries(roomsAfterMove).filter(([, r]) => {
    const p = r.polygon ?? [];
    return p.length >= 3 && p.every((q) => q.x >= Math.min(...px) - 1 && q.x <= maxX1 && q.y >= Math.min(...py) - 1 && q.y <= Math.max(...py) + 1);
  });
  console.log("после wall_move: комнат в bbox:", moved.length);
  if (moved.length !== 1) throw new Error(`ожидалась 1 комната после wall_move, найдено ${moved.length}`);
  const [newRoomId, newRoom] = moved[0]!;
  const gotName = typeof newRoom.zones?.[0]?.["name"] === "string" ? newRoom.zones![0]!["name"] : null;
  console.log("id комнаты:", `${trial.roomId} → ${newRoomId}`, "имя:", JSON.stringify(gotName));
  if (gotName !== "Зал 9") throw new Error(`M2: имя комнаты потерялось после wall_move: ${JSON.stringify(gotName)}`);
  probeRoomSites.delete(trial.roomId);
  probeRoomSites.add(newRoomId);
  journal();
  // цвет на новом id — правка после смены id тоже сохраняется
  await call("room_set_color", { room_id: newRoomId, color: "#f5e9d0" });
  await saveTagged("color");
  await openAndGuard();
  const afterColor = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const colorRoom = ((afterColor.model["rooms2"] ?? {}) as Record<string, { zones?: Array<Record<string, unknown>> }>)[newRoomId];
  const gotColor = typeof colorRoom?.zones?.[0]?.["color"] === "string" ? colorRoom.zones![0]!["color"] : null;
  console.log("цвет на новом id:", gotColor);
  if (gotColor !== "#f5e9d0") throw new Error(`M2: цвет зоны не дошёл до сервера: ${JSON.stringify(gotColor)}`);
  console.log("M2 (правки полей переживают wall_move/смену id): PASS");

  // ---- зачистка ----
  await roGuard.assertUnchanged("перед зачисткой");
  await restoreProbe();
  await openAndGuard();
  const final = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const sigOk = sig(final.model as Record<string, unknown>) === sig(before!.model as Record<string, unknown>);
  console.log("сверка с бэкапом (sig):", sigOk ? "OK" : "РАСХОЖДЕНИЕ");
  if (!sigOk) throw new Error("финальная модель не совпала с бэкапом");
  const probeRoomLeft = trial.roomId in ((final.model["rooms2"] ?? {}) as Record<string, unknown>) || newRoomId in ((final.model["rooms2"] ?? {}) as Record<string, unknown>);
  console.log("пробная комната удалена:", !probeRoomLeft);
  const changedFinal = await roGuard.checkFinal("финал");
  console.log("контрольный проект:", changedFinal ? "ИЗМЕНИЛСЯ" : "не изменился");
  console.log("349-finish9-fix-live: PASS");
} catch (e) {
  console.error("FAIL:", String((e as Error).message).slice(0, 800));
  try { await restoreProbe(); } catch (e2) { console.error("restore:", String((e2 as Error).message).slice(0, 200)); }
  process.exitCode = 1;
} finally {
  await closeBrowser();
  process.exit(process.exitCode ?? 0);
}
