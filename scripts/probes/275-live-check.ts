// 275: живая проверка ревью 274 — №4 (тёплая стена и проёмы: как редактор
// поступает с частью на ребре с дверью — подрезка или запрет) и №8 (разрез
// стены ЧЕРЕЗ участок — миграция id_old, переписывание вершин кабеля).
// Схема «бэкап → запись → проверка → восстановление» (268-climate3-spec):
// пробные объекты правее существующих, сохранения ≥ 5 с, ≤ 30 запросов/мин,
// удаление только по захваченным site_id, восстановление в finally, GET
// контрольного проекта до/после — не изменился. Запуск:
// node scripts/probes/275-live-check.ts run
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { assertNoReadonlyCollision, assertTargetPair, readonlyGuard, readonlyRefPath } from "./probe-guard.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу run (ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID, REMPLANNER_PROBE_READONLY_PLAN_ID");
  process.exit(1);
}
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 25 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "275-live-check", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = (await client.callTool({ name, arguments: args })) as ToolCallResult;
  if (res.isError) throw new Error(`${name}: ${(res.content ?? []).map((c) => c.text ?? "").join("").slice(0, 400)}`);
  return JSON.parse((res.content ?? []).find((c) => typeof c.text === "string")?.text ?? "{}") as Record<string, unknown>;
};
const entitySiteId = (res: Record<string, unknown>, what: string): string => {
  const e = res["entity"] as { site_id?: string } | undefined;
  if (!e?.site_id) throw new Error(`в ответе нет entity.site_id (${what}): ${JSON.stringify(res).slice(0, 200)}`);
  return e.site_id;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(6000);

const backupPath = process.env["REMPLANNER_PROBE_BACKUP"];
if (!backupPath) { console.error("нужен REMPLANNER_PROBE_BACKUP"); process.exit(1); }
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
const strip = (m: unknown) => {
  const c = structuredClone(m as Record<string, unknown>);
  delete c.save_id; delete c.log_plan; delete c.session; delete c.version;
  return JSON.stringify(c);
};
type Raw = { model: Record<string, Record<string, Record<string, unknown>>> };
const rawGet = async (tag: string): Promise<Raw> => {
  const m = (await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)) as unknown as Raw;
  writeFileSync(`${OUT}/275-get-own-${tag}.json`, JSON.stringify(m, null, 1) + "\n");
  return m;
};

const created = {
  items: [] as string[],
  walls: [] as string[],
  warm_walls: [] as string[],
  wiring: [] as { coll: string; site_id: string }[],
};
const writeCreated = (): void => {
  writeFileSync(`${OUT}/275-created.json`, JSON.stringify(created, null, 1) + "\n");
};

// ревью 319 №3/№4: пара объект/план из env; эталон контрольного проекта фиксированный
await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
const roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(OBJECT_ID, READONLY_ID, READONLY_PLAN_ID));
await roGuard.assertUnchanged("перед записями");

const captureNewWalls = async (known: Set<string>): Promise<void> => {
  const mgNow = (await call("model_get", {})) as unknown as { walls: { site_id?: string }[] };
  for (const w of mgNow.walls) {
    if (w.site_id && !known.has(w.site_id) && !created.walls.includes(w.site_id)) created.walls.push(w.site_id);
  }
  writeCreated();
};

/** Миграция id части (id_old): обновить захваченный site_id, иначе зачистка и
 *  контроль остатков пропустят часть с новым id (ревью 276 N5 — аналог 273). */
const refreshCapturedPart = (oldId: string, part: { id: string }): void => {
  if (part.id === oldId) return;
  const hit = created.warm_walls.indexOf(oldId);
  if (hit >= 0) { console.log(`миграция id части: ${oldId} → ${part.id}`); created.warm_walls[hit] = part.id; writeCreated(); }
};

const deleteBySite = async (entries: (string | { coll: string; site_id: string })[], tool: string, arg: string): Promise<void> => {
  for (const entry of [...entries].reverse()) {
    const coll = typeof entry === "string" ? guessColl(tool) : entry.coll;
    const siteId = typeof entry === "string" ? entry : entry.site_id;
    const mgNow = (await call("model_get", {})) as unknown as Record<string, Array<{ id?: string; site_id?: string }>>;
    const found = (mgNow[coll] ?? []).find((o) => o.site_id === siteId);
    if (!found?.id) { console.log(`пропуск: ${coll} ${siteId} не найден в рабочей модели — ничего не удалено`); continue; }
    await call(tool, { [arg]: found.id });
  }
};
const guessColl = (tool: string): string =>
  tool === "wiring_delete" ? "cables_warm_floor" : tool === "item_delete" ? "items" : "walls";

const saveLog = async (tag: string): Promise<Record<string, unknown>> => {
  await roGuard.assertUnchanged("{tag}");
  const s = await call("project_save", {});
  console.log(`${tag}: verified =`, s["verified"], "; will_delete =", JSON.stringify(s["will_delete"] ?? null), "; warnings =", JSON.stringify(s["warnings"] ?? null));
  if (s["verified"] !== true) throw new Error(`${tag} не verified`);
  return s;
};

let failed: Error | null = null;
let readonlyUnchanged = false;

try {
  const ownNow = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  if (strip(ownNow.model) !== strip(backup.model)) throw new Error("dev-проект изменился с момента бэкапа — стоп");
  console.log("бэкап актуален, контрольный GET OK");

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const wallsFull0 = (await call("model_get", {})) as unknown as { walls: { site_id: string; from: [number, number]; to: [number, number] }[] };
  const wallsBefore = new Set(wallsFull0.walls.map((w) => w.site_id));
  const maxX = Math.max(...wallsFull0.walls.flatMap((w) => [w.from[0], w.to[0]]));
  const ox = maxX + 1500;
  const oy = 0;

  // ---------- №4: тёплая стена на ребре с дверью ----------
  console.log("=== №4: ребро с дверью ===");
  await call("room_add_rect", { origin: { x: ox, y: oy }, width: 4000, depth: 3000, wall_thickness: 200 });
  await captureNewWalls(wallsBefore);
  await pause();
  await saveLog("save#1 (пробная комната)");

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const base1 = (await rawGet("room")).model;
  const inZone = (rid: string): boolean => {
    const poly = ((base1.rooms2 ?? base1.rooms1 ?? {})[rid] as { polygon?: { x: number; y: number }[] } | undefined)?.polygon;
    if (!poly || poly.length === 0) return false;
    return Math.min(...poly.map((p) => p.x)) > ox / 10 - 60;
  };
  const rid1 = Object.keys(base1.rooms2 ?? base1.rooms1 ?? {}).find(inZone);
  if (!rid1) throw new Error("пробная комната не найдена в rooms2");
  const room1 = (base1.rooms2 ?? base1.rooms1 ?? {})[rid1] as { edges: { p1: { x: number; y: number }; p2: { x: number; y: number } }[] };
  const edgeCountBefore = room1.edges.length;
  const topEdgeIdx = room1.edges.findIndex((e) => e.p1.y === e.p2.y && e.p1.y === Math.min(...room1.edges.map((q) => q.p1.y)));
  if (topEdgeIdx < 0) throw new Error("верхнее ребро не найдено");
  console.log(`комната ${rid1}: edges=${edgeCountBefore}, верхнее ребро #${topEdgeIdx}`);

  // верхняя стена пробной комнаты: созданная, горизонтальная, с минимальным y
  const mgWalls = (await call("model_get", {})) as unknown as { walls: { id: string; site_id: string; from: [number, number]; to: [number, number] }[] };
  const createdWallsRecs = mgWalls.walls.filter((w) => created.walls.includes(w.site_id));
  const topWallRec = createdWallsRecs
    .filter((w) => w.from[1] === w.to[1])
    .sort((x, y) => Math.min(x.from[1], x.to[1]) - Math.min(y.from[1], y.to[1]))[0];
  if (!topWallRec) throw new Error("верхняя стена пробной комнаты не найдена");
  console.log("верхняя стена:", topWallRec.site_id, JSON.stringify([topWallRec.from, topWallRec.to]));

  // дверь в середине ребра: центр 2000 мм от начала оси стены
  const doorCenterMm = 2000;
  await call("opening_add", { wall_id: topWallRec.id, type: "door", center_mm: doorCenterMm, width_mm: 800, height_mm: 2100 });
  await pause();
  await saveLog("save#2 (дверь на верхнем ребре)");

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const base2 = (await rawGet("door")).model;
  const room2b = ((base2.rooms2 ?? base2.rooms1 ?? {})[rid1] ?? {}) as { edges: { p1: { x: number; y: number }; p2: { x: number; y: number } }[] };
  console.log(`после двери: edges=${room2b.edges.length} (было ${edgeCountBefore})`);
  const topEdgeIdx2 = room2b.edges.findIndex((e) => e.p1.y === e.p2.y && e.p1.y === Math.min(...room2b.edges.map((q) => q.p1.y)));
  if (topEdgeIdx2 < 0) throw new Error("верхнее ребро после двери не найдено");
  const e2 = room2b.edges[topEdgeIdx2]!;
  const lenE = Math.hypot(e2.p2.x - e2.p1.x, e2.p2.y - e2.p1.y);
  const u = { x: (e2.p2.x - e2.p1.x) / lenE, y: (e2.p2.y - e2.p1.y) / lenE };
  const edgeLenMm2 = Math.round(lenE * 10);
  // дверь в координатах ребра: проекция начала оси стены + center ± 400
  const projMm = Math.round((topWallRec.from[0] - e2.p1.x * 10) * u.x + (topWallRec.from[1] - e2.p1.y * 10) * u.y);
  const doorStart = projMm + doorCenterMm - 400;
  const doorEnd = projMm + doorCenterMm + 400;
  console.log(`верхнее ребро #${topEdgeIdx2}: len=${edgeLenMm2} мм, дверь ${doorStart}..${doorEnd} мм`);

  // участок ЧЕРЕЗ дверь и участок рядом (вне проёма)
  const across = await call("warm_wall_add", { room_id: rid1, edge: topEdgeIdx2, start_mm: doorStart - 600, end_mm: doorEnd + 600 });
  const wwAcross = String(across["id"] ?? "");
  created.warm_walls.push(wwAcross);
  const besideStart = doorEnd + 800;
  const beside = await call("warm_wall_add", { room_id: rid1, edge: topEdgeIdx2, start_mm: besideStart, end_mm: Math.min(besideStart + 1000, edgeLenMm2) });
  const wwBeside = String(beside["id"] ?? "");
  created.warm_walls.push(wwBeside);
  writeCreated();
  console.log("warm_wall_add: через дверь", JSON.stringify(across).slice(0, 160), "; рядом", JSON.stringify(beside).slice(0, 160));
  await pause();
  const s3 = await saveLog("save#3 (участки через дверь и рядом)");
  console.log("  warmwall_mismatches =", JSON.stringify(s3["warmwall_mismatches"] ?? null));

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after3 = (await rawGet("after-door-part")).model;
  const parts3 = allParts(after3).filter((p) => p.id === wwAcross || p.id === wwBeside || String((p.props as { id?: string })?.id ?? "") === wwAcross || String((p.props as { id?: string })?.id ?? "") === wwBeside);
  console.log("частей после save+reopen:", parts3.length, "(создано 2)");
  for (const p of parts3) { refreshCapturedPart(wwAcross, p); refreshCapturedPart(wwBeside, p); console.log("  ", JSON.stringify({ id: p.id, id_old: p["id_old"] ?? null, line: p.line })); }

  // ---------- №8: разрез стены ЧЕРЕЗ участок «рядом» ----------
  console.log("=== №8: разрез через участок ===");
  // терморегулятор + кабель к участку «рядом», чтобы видеть переписывание вершин
  await call("item_add", { name: "socket_thermo", position: { against_wall: { wall_id: topWallRec.site_id, offset_mm: 3600 } } });
  await captureNewWalls(wallsBefore);
  await pause();
  const sThermo = await saveLog("save#4a (терморегулятор)");
  console.log("  will_delete после терморегулятора =", JSON.stringify(sThermo["will_delete"] ?? null));
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const rawThermo = (await rawGet("thermo")).model;
  const thermoKey = Object.entries(rawThermo.items ?? {}).find(([, v]) => {
    const it = v as { name?: string; pc?: { x: number }; socket_group?: Array<{ name?: string }> };
    return it.pc !== undefined && it.pc.x > ox / 10 - 60 && it.name === "socket_group" && Array.isArray(it.socket_group) && it.socket_group.some((sg) => sg.name === "socket_thermo");
  })?.[0];
  if (!thermoKey) throw new Error("терморегулятор не найден в зоне пробы");
  created.items = [thermoKey];
  writeCreated();
  const mgItems = (await call("model_get", {})) as unknown as { items: { id: string; site_id: string }[] };
  const thermoLabel = mgItems.items.find((o) => o.site_id === thermoKey)?.id;
  if (!thermoLabel) throw new Error("метка терморегулятора не найдена");
  const wireRes = await call("wiring_add", { kind: "warm_floor_wire", path: [{ item_id: thermoLabel }, { item_id: wwBeside }] });
  const wireSite = entitySiteId(wireRes, "wiring_add");
  created.wiring.push({ coll: "cables_warm_floor", site_id: wireSite });
  writeCreated();
  await pause();
  await saveLog("save#4 (кабель к участку)");

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const before8 = (await rawGet("before-cut")).model;
  const partBefore = findPart(before8, wwBeside);
  if (!partBefore) throw new Error("участок не найден перед разрезом");
  console.log("участок до разреза:", JSON.stringify({ id: partBefore.id, line: partBefore.line }));
  const mgWalls3 = (await call("model_get", {})) as unknown as { walls: { id: string; site_id: string; from: [number, number]; to: [number, number] }[] };
  const topWallRec3 = mgWalls3.walls.find((w) => w.site_id === topWallRec.site_id);
  if (!topWallRec3) throw new Error("верхняя стена не найдена перед разрезом");
  // разрез в середине участка: середина линии (см) → мм вдоль оси стены
  const partMidCm = (partBefore.line.p1.x + partBefore.line.p2.x) / 2;
  const wallFromX = Math.min(topWallRec3.from[0], topWallRec3.to[0]);
  const cutAtMm = Math.round(partMidCm * 10) - wallFromX;
  console.log(`wall_split верхней стены at_mm=${cutAtMm} (середина участка)`);
  await call("wall_split", { wall_id: topWallRec3.site_id, at_mm: cutAtMm });
  await captureNewWalls(wallsBefore);
  await pause();
  const s5 = await saveLog("save#5 (разрез через участок)");
  console.log("  warmwall_mismatches =", JSON.stringify(s5["warmwall_mismatches"] ?? null));

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after5 = (await rawGet("after-cut")).model;
  const partAfter = findPart(after5, wwBeside) ?? findPartByGeometry(after5, partBefore);
  if (!partAfter) throw new Error("участок ПОТЕРЯН после разреза через него (ни по id, ни по геометрии)");
  refreshCapturedPart(wwBeside, partAfter);
  const wire5 = ((after5.cables_warm_floor ?? {})[wireSite] ?? {}) as { vertexes?: { id: string; type: string }[] };
  const wwv = wire5.vertexes?.find((v) => v.type === "warm_wall");
  const verdict8 = {
    idChanged: partAfter.id !== wwBeside,
    idOld: (partAfter as { id_old?: string }).id_old ?? null,
    lineChanged: JSON.stringify(partAfter.line) !== JSON.stringify(partBefore.line),
    cableVertexOk: Boolean(wwv) && wwv!.id === partAfter.id,
    propsLinkOk: (partAfter.props as { cables_warm_floor?: { cable_warm_floor_id?: string } })?.cables_warm_floor?.cable_warm_floor_id === wireSite,
  };
  console.log("№8 вывод:", JSON.stringify(verdict8));
  console.log("участок после разреза:", JSON.stringify({ id: partAfter.id, id_old: (partAfter as { id_old?: string }).id_old ?? null, line: partAfter.line }));

  const png = await call("render_plan", { sheet: "warm_floor" });
  console.log("render:", (png["path"] as string) ?? JSON.stringify(png).slice(0, 120));
} catch (e) {
  failed = e as Error;
  console.error("FAIL:", failed.message);
} finally {
  try {
    if (failed) {
      await roGuard.assertUnchanged("{tag}");
      try { await call("project_save", {}); } catch { /* проект мог не открыться */ }
    }
    await pause();
    // свежая рабочая копия с сервера: локальная нормализация (wall_split и др.)
    // может переименовать id стен в рабочей модели, а зачистка идёт по
    // захваченным site_id — резолв по свежему model_get (rev 274 №7)
    await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const mgPre = (await call("model_get", {})) as unknown as { walls: { site_id?: string }[] };
    console.log(`cleanup: стен в рабочей модели ${mgPre.walls.length}, захвачено ${new Set(created.walls).size}`);
    await deleteBySite(created.wiring, "wiring_delete", "wiring_id");
    // тёплые стены: резолв метки строго по site_id из свежего warm_wall_list
    for (const siteId of [...created.warm_walls].reverse()) {
      const listRes = (await call("warm_wall_list", {})) as unknown as { warm_walls?: Array<{ id: string; label: string }> };
      const found = (listRes.warm_walls ?? []).find((x) => x.id === siteId);
      if (!found) { console.log(`пропуск: тёплая стена ${siteId} не найдена — ничего не удалено`); continue; }
      await call("warm_wall_delete", { warm_wall_id: found.label });
    }
    await deleteBySite(created.items, "item_delete", "item_id");
    await deleteBySite(created.walls, "wall_delete", "wall_id");
    writeCreated();
    await pause();
    await saveLog("save#6 (очистка)");
    if (!failed) {
      const rawLeft = ((await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)) as unknown as Raw).model;
      const leftoverPairs: [string, string][] = [
        ...created.wiring.map((w) => [w.coll, w.site_id] as [string, string]),
        ...created.items.map((s) => ["items", s] as [string, string]),
        ...created.walls.map((s) => ["walls", s] as [string, string]),
      ];
      const leftovers = leftoverPairs.filter(([coll, s]) => Object.keys(rawLeft[coll] ?? {}).includes(s));
      const wwLeft: string[] = [];
      for (const [, room] of Object.entries(rawLeft.rooms2 ?? {})) {
        for (const g of ((room as { warms_walls?: Array<{ parts?: Record<string, unknown> }> }).warms_walls ?? [])) {
          for (const pid of Object.keys(g.parts ?? {})) {
            if (created.warm_walls.includes(pid)) wwLeft.push(pid);
          }
        }
      }
      if (leftovers.length > 0 || wwLeft.length > 0) throw new Error(`очистка неполна: ${leftovers.map(([c, s]) => `${c}:${s}`).join(", ")}${wwLeft.length ? " + warms_walls " + wwLeft.join(",") : ""}`);
    } else {
      console.error("cleanup после сбоя выполнен");
    }
  } catch (ce) {
    console.error("cleanup не удался (объекты в 275-created.json):", (ce as Error).message);
    writeCreated();
  }
  try {
    // ревью 319 №4: сверка контрольного проекта с фиксированным эталоном — и при успехе, и в ветке ошибки
    const roChanged = await roGuard.checkFinal(failed ? "после сбоя" : "в конце");
    readonlyUnchanged = !roChanged;
  } catch (ce) {
    console.error("контрольная сверка после прогона не удалась:", (ce as Error).message);
    readonlyUnchanged = false;
  }
  await closeBrowser().catch(() => {});
}

const ownAfter = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
writeFileSync(`${OUT}/275-get-own-after.json`, JSON.stringify(ownAfter, null, 1) + "\n");
const same = strip(ownAfter.model) === strip(backup.model);
console.log("data dev == бэкап:", same ? "OK — восстановлен" : "РАСХОЖДЕНИЕ (сверить производные пути)");
process.exit(failed || !readonlyUnchanged || !same ? 1 : 0);

// ---------- helpers ----------

type PartRec = { id: string; type: string; line: { p1: { x: number; y: number }; p2: { x: number; y: number } }; props?: Record<string, unknown>; [k: string]: unknown };

function allParts(model: Raw["model"]): PartRec[] {
  const rooms2 = (model.rooms2 ?? model.rooms1 ?? {}) as Record<string, { warms_walls?: Array<{ parts?: Record<string, Record<string, unknown>> }> }>;
  const out: PartRec[] = [];
  for (const [, room] of Object.entries(rooms2)) {
    for (const g of room.warms_walls ?? []) {
      for (const [pid, raw] of Object.entries(g.parts ?? {})) out.push({ ...(raw as unknown as PartRec), id: pid });
    }
  }
  return out;
}

function findPart(model: Raw["model"], partId: string): PartRec | null {
  return allParts(model).find((p) => p.id === partId || String((p.props as { id?: string })?.id ?? "") === partId) ?? null;
}

function findPartByGeometry(model: Raw["model"], ref: PartRec): PartRec | null {
  const hit = allParts(model).find((p) =>
    p.type === ref.type
    && Math.abs(p.line.p1.x - ref.line.p1.x) <= 0.51 && Math.abs(p.line.p1.y - ref.line.p1.y) <= 0.51
    && Math.abs(p.line.p2.x - ref.line.p2.x) <= 0.51 && Math.abs(p.line.p2.y - ref.line.p2.y) <= 0.51);
  return hit ?? null;
}
