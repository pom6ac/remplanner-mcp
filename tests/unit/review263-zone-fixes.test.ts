// 263: регрессионные тесты по находкам повторного ревью PR #40 (зонирование потолка).
// Каждая находка: тест красный на d492e13, зелёный после фикса (N6 — пин поведения,
// зелёный в обе стороны). Порядок проверен прогоном файла на d492e13.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model } from "../../src/model/types.ts";
import {
  addZoneCeiling,
  zoneDelimiterCompare,
  migrateLegacyDelimiter,
} from "../../src/model/zone.ts";
import { affectedRoomIds } from "../../src/model/rooms-save.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";

type Pt = { x: number; y: number };

function edgesOf(poly: Pt[]): Array<{ p1: Pt; p2: Pt }> {
  return poly.map((p, i) => ({ p1: p, p2: poly[(i + 1) % poly.length]! }));
}

/** Запись разделителя в канонической форме (как пишут addZoneCeiling и сервер). */
function delimRec(id: string, idRoom: string, p1: Pt, p2: Pt): Record<string, unknown> {
  return {
    id,
    type: "zone_ceiling",
    plan: "ceiling",
    id_room: idRoom,
    matrix: [[null, { length: 1 }], [{ length: 1 }, null]],
    vertexes: [
      { id: "v1", point: p1, type: "node" },
      { id: "v2", point: p2, type: "node" },
    ],
    items: { v1: "node", v2: "node" },
    length: Math.round((Math.hypot(p2.x - p1.x, p2.y - p1.y) / 100) * 100) / 100,
    on_size: 1,
  };
}

function modelLike(rooms: Record<string, unknown>, delims: Record<string, unknown>): Record<string, unknown> {
  return { rooms2: rooms, zone_delimiters: delims };
}

// ---------- N1: строгая затронутость для сверки разделителей ----------

const A_POLY: Pt[] = [{ x: 0, y: 0 }, { x: 195, y: 0 }, { x: 195, y: 300 }, { x: 0, y: 300 }];
const B_POLY: Pt[] = [{ x: 205, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 205, y: 300 }];
const SPLIT_WALL = { p1: { x: 0, y: 150 }, p2: { x: 200, y: 150 }, depthCm: 10 };

test("263 N1: zoneAffectedRoomIds строже affectedRoomIds — Т-примыкание к оси общей стены не затрагивает соседа", async () => {
  const rooms = { A: { polygon: A_POLY }, B: { polygon: B_POLY } };
  // старая классификация (для исчезновения комнат): сосед захватывается допуском
  const wide = affectedRoomIds(rooms, [SPLIT_WALL]);
  assert.ok(wide.has("B"), "affectedRoomIds захватывает соседа (поведение не менялось)");
  // строгая (для разделителей): сосед не затронут
  const { zoneAffectedRoomIds } = await import("../../src/model/rooms-save.ts");
  type ChangedWall = { p1: Pt; p2: Pt; depthCm: number };
  const strict = zoneAffectedRoomIds({ rooms2: rooms }, { changedWalls: [SPLIT_WALL] });
  assert.ok(strict!.has("A"), "комната разреза затронута (стена через внутренность)");
  assert.equal(strict!.has("B"), false, "сосед через общую стену не затронут");
  // стена, чья грань лежит на ребре комнаты (ось на depth/2 = 5 см снаружи
  // от ребра y=0 — геометрия редактора «ось ≠ грань», ревью 265 R4), затрагивает её
  const faceWall = { p1: { x: 0, y: -5 }, p2: { x: 195, y: -5 }, depthCm: 10 } as ChangedWall;
  const onFace = zoneAffectedRoomIds({ rooms2: rooms }, { changedWalls: [faceWall] });
  assert.ok(onFace!.has("A"), "грань стены на ребре комнаты — комната затронута");
  assert.equal(onFace!.has("B"), false, "ребро B не под стеной — не затронута");
  // стена через внутренность (y=10 при комнате 0..300) — тоже затрагивает
  const throughWall = { p1: { x: 10, y: 10 }, p2: { x: 390, y: 10 }, depthCm: 10 } as ChangedWall;
  const through = zoneAffectedRoomIds({ rooms2: rooms }, { changedWalls: [throughWall] });
  assert.ok(through!.has("A") && through!.has("B"), "стена через внутренность комнат — обе затронуты");
  // стены не менялись — undefined
  assert.equal(zoneAffectedRoomIds({ rooms2: rooms }, {}), undefined);
});

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

function wsMock(
  server: { saveId: string; model: Record<string, unknown> },
  transformNorm?: (m: Record<string, unknown>) => void,
  afterSave?: (s: { saveId: string; model: Record<string, unknown> }) => void,
): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      afterSave?.(server);
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return COMPAT; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: server.saveId, units: "cm", data_empty: false, model: structuredClone(server.model) };
    },
    async openEditor() { return editor; },
  };
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  return ws;
}

/** Комнаты A и B через ось x=200 (толщина 10) + их разделители. */
function twoRoomServer(): { server: { saveId: string; model: Record<string, unknown> } } {
  const model = {
    rooms2: {
      A: { polygon: A_POLY, edges: edgesOf(A_POLY) },
      B: { polygon: B_POLY, edges: edgesOf(B_POLY) },
    },
    walls: {
      w_top: { p1: { x: 0, y: 0 }, p2: { x: 400, y: 0 }, depth: 10, plan: "a" },
      w_bottom: { p1: { x: 0, y: 300 }, p2: { x: 400, y: 300 }, depth: 10, plan: "a" },
      w_left: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 300 }, depth: 10, plan: "a" },
      w_right: { p1: { x: 400, y: 0 }, p2: { x: 400, y: 300 }, depth: 10, plan: "a" },
      w_shared: { p1: { x: 200, y: 0 }, p2: { x: 200, y: 300 }, depth: 10, plan: "a" },
    },
    zone_delimiters: {
      za: delimRec("za", "A", { x: 30, y: 150 }, { x: 150, y: 150 }),
      zb: delimRec("zb", "B", { x: 250, y: 150 }, { x: 370, y: 150 }),
    },
  } as unknown as Record<string, unknown>;
  return { server: { saveId: "s1", model } };
}

test("263 N1: Т-разрез у общей стены, редактор потерял делитель соседа — problem (INVALID_GEOMETRY)", async () => {
  const { server } = twoRoomServer();
  const ws = wsMock(server, (norm) => {
    // split A стеной y=150 (ось от левого ребра до оси общей стены x=200)
    const rooms = norm["rooms2"] as Record<string, Record<string, unknown>>;
    delete rooms["A"];
    rooms["A1"] = { polygon: [{ x: 0, y: 0 }, { x: 195, y: 0 }, { x: 195, y: 150 }, { x: 0, y: 150 }] };
    rooms["A2"] = { polygon: [{ x: 0, y: 150 }, { x: 195, y: 150 }, { x: 195, y: 300 }, { x: 0, y: 300 }] };
    // делитель A пережил разрез, делитель соседа B редактор потерял
    const zd = norm["zone_delimiters"] as Record<string, Record<string, unknown>>;
    (zd["za"] as Record<string, unknown>)["id_room"] = "A1";
    delete zd["zb"];
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.applyWalls("wall_add", (mm) => {
    (mm.walls as unknown as Record<string, unknown>)["split"] = { p1: { x: 0, y: 150 }, p2: { x: 200, y: 150 }, depth: 10, plan: "a" };
    return "added";
  }), (e: unknown) => {
    const err = e as { code?: string; details?: Record<string, unknown> };
    assert.equal(err.code, "INVALID_GEOMETRY", `код: ${err.code}, детали: ${JSON.stringify(err.details).slice(0, 300)}`);
    const zm = (err.details ?? {})["zone_mismatches"] as string[] | undefined;
    assert.ok(Array.isArray(zm) && zm.some((p) => p.includes("zb")), JSON.stringify(err.details).slice(0, 400));
    return true;
  });
});

// ---------- N2: save-сверка затронутых комнат строга ----------

test("263 N2: save — потеря и смена типа делителя затронутой комнаты = problem, сдвиг до магнита = warning", () => {
  const room = { polygon: [{ x: 1863, y: 5 }, { x: 1863, y: 195 }, { x: 1773, y: 195 }, { x: 1773, y: 5 }] };
  const zd = delimRec("zd1", "left", { x: 1773, y: 100 }, { x: 1863, y: 60 });
  const exp = modelLike({ left: room }, { zd1: zd });
  const opts = { affectedRooms: new Set(["left"]) };
  // потеря — problem
  const lost = zoneDelimiterCompare(exp, modelLike({ left: room }, {}), "save", opts);
  assert.ok(lost.problems.some((p) => p.includes("потерян")), JSON.stringify(lost));
  // смена типа — problem, без «не сохранил»-warning
  const wrong = structuredClone(zd) as Record<string, unknown>;
  wrong["type"] = "zone_wall";
  const wrongRes = zoneDelimiterCompare(exp, modelLike({ left: room }, { zd1: wrong }), "save", opts);
  assert.ok(wrongRes.problems.length > 0, `смена типа — problem: ${JSON.stringify(wrongRes)}`);
  assert.equal(wrongRes.warnings.some((w) => w.includes("не сохранил")), false, JSON.stringify(wrongRes.warnings));
  // сдвиг конца до магнита (5 см) — предупреждение, не problem (живой эталон 262)
  const shifted = structuredClone(zd) as Record<string, unknown>;
  const vv = shifted["vertexes"] as Array<{ point: Pt }>;
  vv[1]!.point = { x: 1863, y: 65 };
  shifted["length"] = Math.round((Math.hypot(vv[1]!.point.x - vv[0]!.point.x, vv[1]!.point.y - vv[0]!.point.y) / 100) * 100) / 100;
  const shiftRes = zoneDelimiterCompare(exp, modelLike({ left: room }, { zd1: shifted }), "save", opts);
  assert.deepEqual(shiftRes.problems, [], `сдвиг до магнита не блок: ${JSON.stringify(shiftRes)}`);
  assert.ok(shiftRes.warnings.some((w) => w.includes("zone_topology_changed")), JSON.stringify(shiftRes.warnings));
});

test("263 N2: save — сервер потерял делитель затронутой комнаты → SITE_ERROR с zone_mismatches", async () => {
  const poly: Pt[] = [{ x: 10, y: 10 }, { x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }];
  const model = {
    rooms2: { A: { polygon: poly, edges: edgesOf(poly) } },
    walls: { w1: { p1: { x: 10, y: 10 }, p2: { x: 390, y: 10 }, depth: 10, plan: "a" } },
    zone_delimiters: { za: delimRec("za", "A", { x: 30, y: 150 }, { x: 150, y: 150 }) },
  } as unknown as Record<string, unknown>;
  const server = { saveId: "s1", model };
  const ws = wsMock(server, undefined, (s) => {
    delete s.model["zone_delimiters"]; // сервер потерял делитель при записи
  });
  await ws.open("0", "1");
  await ws.applyWalls("wall_delete", (mm) => {
    delete mm.walls["w1"]; // комната затронута изменённой стеной
    return "deleted";
  });
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as { code?: string; details?: Record<string, unknown> };
    assert.equal(err.code, "SITE_ERROR", `код: ${err.code}`);
    const zm = (err.details ?? {})["zone_mismatches"] as string[] | undefined;
    assert.ok(Array.isArray(zm) && zm.some((p) => p.includes("za")), JSON.stringify(err.details).slice(0, 400));
    return true;
  });
});

// ---------- N3: миграция не маскирует потерю on_size/length ----------

const REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-ceilzone-delimiter.json", "utf8")) as {
  room: { polygon: Pt[]; edges: unknown[] };
  zone_delimiters: Record<string, Record<string, unknown>>;
};
const REF_DELIM = Object.values(REF.zone_delimiters)[0]!;

function refModel(): Record<string, unknown> {
  return modelLike({ room1: structuredClone(REF.room) as unknown as Record<string, unknown> }, { zd1: structuredClone(REF_DELIM) });
}

test("263 N3: мутации delete on_size, length=0, delete length у top-level записи ловятся сверкой", () => {
  assert.ok("on_size" in REF_DELIM && "length" in REF_DELIM, "в эталоне есть on_size и length");
  const cases: Array<[string, (d: Record<string, unknown>) => Record<string, unknown>]> = [
    ["delete on_size", (d) => { const c = structuredClone(d); delete c["on_size"]; return c; }],
    ["on_size=0", (d) => { const c = structuredClone(d); c["on_size"] = 0; return c; }],
    ["length=0", (d) => { const c = structuredClone(d); c["length"] = 0; return c; }],
    ["delete length", (d) => { const c = structuredClone(d); delete c["length"]; return c; }],
  ];
  for (const [name, mutate] of cases) {
    const got = modelLike(
      { room1: structuredClone(REF.room) as unknown as Record<string, unknown> },
      { zd1: mutate(structuredClone(REF_DELIM)) },
    );
    for (const mode of ["normalize", "save"] as const) {
      const res = zoneDelimiterCompare(refModel(), got, mode);
      assert.ok(res.problems.length > 0, `${name} (${mode}): мутация поймана`);
    }
  }
});

test("263 N3: миграция дописывает on_size/length только legacy-записям", () => {
  // top-level запись без полей миграция не достраивает (иначе потеря маскируется)
  const top = structuredClone(REF_DELIM);
  delete top["on_size"];
  delete top["length"];
  const migTop = migrateLegacyDelimiter(top);
  assert.equal(migTop["on_size"], undefined);
  assert.equal(migTop["length"], undefined);
  // legacy-формы (points, per-room, d_*) по-прежнему достраиваются
  const points = { id: "l1", type: "zone_ceiling", plan: "ceiling", id_room: "r", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
  const migPoints = migrateLegacyDelimiter(structuredClone(points));
  assert.equal(migPoints["on_size"], 1);
  assert.equal(migPoints["length"], 1);
  const perRoom = structuredClone(REF_DELIM);
  delete perRoom["on_size"];
  delete perRoom["length"];
  const migLegacy = migrateLegacyDelimiter(perRoom, { legacy: true });
  assert.equal(migLegacy["on_size"], 1);
  assert.equal(migLegacy["length"], REF_DELIM["length"]);
  const dType = structuredClone(REF_DELIM);
  dType["type"] = "d_ceiling";
  const migD = migrateLegacyDelimiter(dType);
  assert.equal(migD["type"], "zone_ceiling");
});

// ---------- N4: пул нестрогого поиска без «кражи» у соседа ----------

test("263 N4: делитель соседней незатронутой комнаты не засчитывается затронутой", () => {
  const rooms = { a: { polygon: A_POLY }, c: { polygon: B_POLY } };
  const za = delimRec("za", "a", { x: 135, y: 150 }, { x: 195, y: 150 });
  const zc = delimRec("zc", "c", { x: 145, y: 150 }, { x: 205, y: 150 }); // концы в 10 см от концов za
  const exp = modelLike(rooms, { za, zc });
  const got = modelLike(structuredClone(rooms), { zc: structuredClone(zc) }); // za потерян редактором
  const res = zoneDelimiterCompare(exp, got, "normalize", { affectedRooms: new Set(["a"]) });
  assert.deepEqual(res.problems, [], `кражи нет: ${JSON.stringify(res)}`);
  assert.ok(res.warnings.some((w) => w.includes("za")), `предупреждение про za: ${JSON.stringify(res.warnings)}`);
  assert.equal(res.warnings.some((w) => w.includes("zc")), false, JSON.stringify(res.warnings));
});

// ---------- N5: делитель вдоль ребра комнаты ----------

function gRoomModel(): { m: Model; room: string } {
  const m = { rooms2: {}, walls: {}, items: {}, pillars: {}, rigels: {} } as unknown as Model;
  const poly: Pt[] = [
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 },
    { x: 200, y: 200 }, { x: 200, y: 400 }, { x: 0, y: 400 },
  ];
  (m.rooms2 as Record<string, Record<string, unknown>>)["r1"] = { polygon: poly, edges: edgesOf(poly) };
  return { m, room: "r1" };
}

test("263 N5: линия, на ненулевой длине идущая по ребру комнаты, — отказ", () => {
  const { m, room } = gRoomModel();
  // 2 м из 4 м идут по ребру выемки y=200 (ревью 263 N5: на d492e13 — OK)
  assert.throws(
    () => addZoneCeiling(m, room, { fromMm: { x: 4000, y: 2000 }, toMm: { x: 0, y: 2000 } }),
    (e: Error) => /вдоль ребра|вдоль стены/.test(e.message),
  );
});

test("263 N5: линия от ребра до ребра внутри комнаты по-прежнему проходит", () => {
  const { m, room } = gRoomModel();
  const res = addZoneCeiling(m, room, { fromMm: { x: 1500, y: 0 }, toMm: { x: 1500, y: 4000 } });
  assert.ok(res.length_mm > 0);
});

// ---------- N6: хорда через вогнутую вершину — поведение закреплено ----------

test("263 N6: хорда через вогнутую вершину (касание в точке) допустима — поведение закреплено тестом", () => {
  const { m, room } = gRoomModel();
  // (400,0)→(0,400) проходит через вогнутую вершину (200,200)
  const res = addZoneCeiling(m, room, { fromMm: { x: 4000, y: 0 }, toMm: { x: 0, y: 4000 } });
  assert.ok(res.length_mm > 0);
});
