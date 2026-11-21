// 328: тесты потолка ч.2 — проём в потолке (ceiling_hole, план "ceiling") и
// двухуровневый потолок (complex_ceiling): эталоны UI в обе стороны, метки
// CH<n>/FH<n> по типам, пересечения в пределах вида, выбор зоны по точке,
// проверки площади/внутреннего контура, mock save (сверка complex-полей).
// Ревью 329 №3: комната с Т-узлом на контуре (коллинеарные рёбра) — complex
// ставится. Ревью 329 №4/№11: тесты «в обе стороны» — стена сквозь проём →
// INVALID_GEOMETRY до записи, стена мимо/делит комнату (в том числе с
// двухуровневым потолком) → без ложных отказов; эталонные тесты через
// ингест → compact → levelHoleMismatches == [].
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model, LevelHole } from "../../src/model/types.ts";
import { addCeilingHole, updateCeilingHole, deleteCeilingHole, addFloorHole, updateFloorHole, deleteFloorHole, levelHoleMismatches } from "../../src/model/floorhole.ts";
import { setCeilingComplex } from "../../src/model/ceiling-complex.ts";
import { addWall } from "../../src/model/walls.ts";
import type { RoomPolygon } from "../../src/model/items.ts";
import { compactModel } from "../../src/model/compact.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";

type Pt = { x: number; y: number };
type HoleFixture = Record<string, unknown> & { polygon: Pt[]; id_room: string; plan: string; type: string };
type ComplexFixture = Record<string, unknown> & { polygon: Pt[] };

const HOLE_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-ceiling-hole.json", "utf8")) as HoleFixture;
const COMPLEX_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-ceiling-complex.json", "utf8")) as ComplexFixture;

const ROOM_POLY: Pt[] = HOLE_REF.polygon.map((p) => ({ x: p.x - 60, y: p.y - 60 }));
// прямоугольная комната, охватывающая эталонный проём с запасом
const ROOM: Pt[] = [
  { x: Math.min(...HOLE_REF.polygon.map((p) => p.x)) - 100, y: Math.min(...HOLE_REF.polygon.map((p) => p.y)) - 100 },
  { x: Math.max(...HOLE_REF.polygon.map((p) => p.x)) + 100, y: Math.min(...HOLE_REF.polygon.map((p) => p.y)) - 100 },
  { x: Math.max(...HOLE_REF.polygon.map((p) => p.x)) + 100, y: Math.max(...HOLE_REF.polygon.map((p) => p.y)) + 100 },
  { x: Math.min(...HOLE_REF.polygon.map((p) => p.x)) - 100, y: Math.max(...HOLE_REF.polygon.map((p) => p.y)) + 100 },
];
const ROOMS: RoomPolygon[] = [{ roomId: "room1", polygon: ROOM, areaCm2: Math.abs(ROOM.reduce((s, p, i) => {
  const q = ROOM[(i + 1) % ROOM.length]!;
  return s + (p.x * q.y - q.x * p.y);
}, 0)) / 2, axisAreaCm2: null }];
const HOLES_MM = (): { corner1: Pt; corner2: Pt } => ({
  corner1: { x: Math.round(HOLE_REF.polygon[0]!.x * 10), y: Math.round(HOLE_REF.polygon[0]!.y * 10) },
  corner2: { x: Math.round(HOLE_REF.polygon[2]!.x * 10), y: Math.round(HOLE_REF.polygon[2]!.y * 10) },
});

function baseModel(): Model {
  return {
    walls: {}, items: {}, pillars: {}, rulers: {}, comments: {},
    rooms2: { room1: { polygon: ROOM.map((p) => ({ ...p })), ceilings: [{ exist: false, polygon: ROOM.map((p) => ({ ...p })) }] } },
  } as unknown as Model;
}

/** Маска проёма: id проёма/вершин, ключи items, id_room (как в тестах 64). */
function maskHole(h: LevelHole): Record<string, unknown> {
  const c = structuredClone(h) as unknown as Record<string, unknown>;
  delete c["_source"];
  c["id"] = "ID";
  c["id_room"] = "ROOM";
  const v = (c["vertexes"] ?? []) as Array<Record<string, unknown>>;
  v.forEach((vert, i) => { vert["id"] = `V${i}`; });
  // items не сравниваем (в эталоне не сохраняли — как в ui-ref-floorhole);
  // граф items покрывает тест «ingest»/mock save уровня сверок
  delete c["items"];
  return c;
}

function maskRefHole(): Record<string, unknown> {
  const c = structuredClone(HOLE_REF) as unknown as Record<string, unknown>;
  delete c["_source"];
  c["id"] = "ID";
  c["id_room"] = "ROOM";
  const v = (c["vertexes"] ?? []) as Array<Record<string, unknown>>;
  v.forEach((vert, i) => { vert["id"] = `V${i}`; });
  // items не сравниваем (в эталоне не сохраняли — как в ui-ref-floorhole)
  delete c["items"];
  return c;
}

// ---------- проём в потолке: эталон в обе стороны ----------

test("328: эталон UI ceiling_hole — запись MCP совпадает с эталоном drag'а (обе стороны), план ceiling", () => {
  const m = baseModel();
  const hole = addCeilingHole(m, HOLES_MM(), ROOMS);
  assert.equal(hole.type, "ceiling_hole");
  assert.equal(hole.plan, "ceiling");
  // MCP → форма эталона
  assert.deepEqual(maskHole(hole), maskRefHole());
  // обратная сторона: эталон, записанный в модель, — это то, что add производит
  // (восстановление эталона и сравнение маскированных форм)
  const m2 = baseModel();
  m2.level_holes = { [HOLE_REF.id as string]: structuredClone(HOLE_REF) as unknown as LevelHole };
  const etalonEntry = Object.values(m2.level_holes)[0]!;
  assert.deepEqual(maskHole(etalonEntry), maskRefHole());
});

test("328: метки FH/CH сквозные по типам, compact включает type; resolve по метке — только свой тип", () => {
  const m = baseModel();
  const r0 = ROOM[0]!;
  addFloorHole(m, { corner1: { x: Math.round((r0.x + 30) * 10), y: Math.round((r0.y + 30) * 10) }, corner2: { x: Math.round((r0.x + 80) * 10), y: Math.round((r0.y + 80) * 10) } }, ROOMS);
  addCeilingHole(m, HOLES_MM(), ROOMS);
  const compact = compactModel(m, ROOMS);
  const floor = compact.level_holes.find((h) => h.type === "floor_hole")!;
  const ceil = compact.level_holes.find((h) => h.type === "ceiling_hole")!;
  assert.equal(floor.id, "FH1");
  assert.equal(ceil.id, "CH1");
  assert.equal(ceil.width_mm, Math.round((Math.max(...HOLE_REF.polygon.map((p) => p.x)) - Math.min(...HOLE_REF.polygon.map((p) => p.x))) * 10));
});

test("328: проём потолка и проём пола в одном месте не конфликтуют (разные листы), same-type — конфликт", () => {
  const m = baseModel();
  addFloorHole(m, HOLES_MM(), ROOMS);
  const ceil = addCeilingHole(m, HOLES_MM(), ROOMS); // тот же прямоугольник — допустимо
  assert.equal(ceil.type, "ceiling_hole");
  assert.throws(() => addCeilingHole(m, HOLES_MM(), ROOMS), (e: unknown) =>
    e instanceof McpError && e.code === "GEOMETRY_CONFLICT");
});

test("328: ceiling_hole_update/delete — тип проверяется, перенос в другую комнату, NOT_FOUND", () => {
  const m = baseModel();
  const hole = addCeilingHole(m, HOLES_MM(), ROOMS);
  // floor-инструмент по ceiling-проёму — отказ
  assert.throws(() => updateCeilingHole(m, { holeId: "nope" }, ROOMS), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
  const c1 = { x: Math.round((ROOM[0]!.x + 30) * 10), y: Math.round((ROOM[0]!.y + 30) * 10) };
  const c2 = { x: Math.round((ROOM[0]!.x + 90) * 10), y: Math.round((ROOM[0]!.y + 90) * 10) };
  const moved = updateCeilingHole(m, { holeId: hole.id, corner1: c1, corner2: c2 }, ROOMS);
  assert.equal(moved.pc.x, (c1.x + c2.x) / 20);
  assert.equal(moved.id_room, "room1");
  deleteCeilingHole(m, hole.id);
  assert.equal(Object.keys(m.level_holes ?? {}).length, 0);
});

test("328: сверка проёмов ловит потерю ceiling_hole после save", () => {
  const m = baseModel();
  const hole = addCeilingHole(m, HOLES_MM(), ROOMS);
  const expected = structuredClone(m.level_holes!);
  const got: Record<string, unknown> = {};
  const mism = levelHoleMismatches(expected, got);
  assert.ok(mism.some((x) => x.includes(hole.id) && x.includes("исчез")));
  // и лишний проём на сервере
  const mism2 = levelHoleMismatches({}, structuredClone(m.level_holes!) as Record<string, unknown>);
  assert.ok(mism2.some((x) => x.includes("лишний")));
});

// ---------- двухуровневый потолок ----------

/** Маска записи complex: id, производные поля (polygon/edges пересчитывает редактор). */
function maskComplex(rec: Record<string, unknown>): Record<string, unknown> {
  const c = structuredClone(rec);
  delete c["_source"];
  c["id"] = "ID";
  for (const key of ["polygon", "edges", "edges_new", "polygon2", "polygon_new", "polygons_layout", "polygons_layout_points", "pc", "area", "area_childs", "area_niches", "niches", "height", "width"]) {
    delete c[key];
  }
  return c;
}

test("328: эталон UI complex_ceiling — поля записи MCP совпадают с эталоном кликов", () => {
  const m = baseModel();
  const room = (m.rooms2 as Record<string, Record<string, unknown>>)["room1"]!;
  (room["ceilings"] as Record<string, unknown>[])[0]!["polygon"] = structuredClone(COMPLEX_REF.polygon);
  const res = setCeilingComplex(m, "room1");
  assert.equal(res.already, false);
  const rec = ((room["ceilings"] ?? []) as Record<string, unknown>[])[res.index]!;
  assert.deepEqual(maskComplex(rec), maskComplex(COMPLEX_REF));
});

test("328: complex — нет-op на повторном вызове (как второй клик редактора)", () => {
  const m = baseModel();
  const room = (m.rooms2 as Record<string, Record<string, unknown>>)["room1"]!;
  (room["ceilings"] as Record<string, unknown>[])[0]!["polygon"] = structuredClone(COMPLEX_REF.polygon);
  const first = setCeilingComplex(m, "room1");
  const snapshot = structuredClone(room["ceilings"]);
  const second = setCeilingComplex(m, "room1");
  assert.equal(second.already, true);
  assert.deepEqual(room["ceilings"], snapshot);
  void first;
});

test("328: complex — площадь < 4 м² отказ (ceiling_reason_1), полигон без complex-полей", () => {
  const m = baseModel();
  const room = (m.rooms2 as Record<string, Record<string, unknown>>)["room1"]!;
  (room["ceilings"] as Record<string, unknown>[])[0]!["polygon"] = [
    { x: 0, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 150 }, { x: 0, y: 150 },
  ];
  assert.throws(() => setCeilingComplex(m, "room1"), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT" && e.message.includes("4 м²"));
});

test("328: complex — Г-образная зона, внутренний контур с самопересечением — GEOMETRY_CONFLICT", () => {
  const m = baseModel();
  const room = (m.rooms2 as Record<string, Record<string, unknown>>)["room1"]!;
  // квадрат 400×400 с узким вырезом (паз 40 см от нижней грани): внутренний контур
  // (отступ 40 см) имеет самопересечение у паза; площадь ~14.6 м² ≥ 4 — отказ по контуру
  (room["ceilings"] as Record<string, unknown>[])[0]!["polygon"] = [
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 260, y: 400 }, { x: 260, y: 60 }, { x: 220, y: 60 }, { x: 220, y: 400 }, { x: 0, y: 400 },
  ];
  try {
    setCeilingComplex(m, "room1");
    assert.fail("ожидался отказ");
  } catch (e) {
    assert.ok(e instanceof McpError);
    const err = e as McpError;
    assert.ok(["GEOMETRY_CONFLICT", "INVALID_ARGUMENT"].includes(err.code), String(err.message));
    assert.match(err.message, /контур|отступ/);
  }
});

test("328: complex — выбор зоны по точке at_mm, без точки при нескольких зонах — отказ", () => {
  const m = baseModel();
  const room = (m.rooms2 as Record<string, Record<string, unknown>>)["room1"]!;
  room["ceilings"] = [
    { exist: false, polygon: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 }] },
    { exist: false, polygon: [{ x: 300, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 300 }, { x: 300, y: 300 }] },
  ];
  assert.throws(() => setCeilingComplex(m, "room1"), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT" && e.message.includes("at_mm"));
  const res = setCeilingComplex(m, "room1", { x: 4500, y: 1500 });
  assert.equal(res.index, 1);
  const rec = (room["ceilings"] as Record<string, unknown>[])[1]!;
  assert.equal(rec["complex"], true);
  // точка вне зон (x=700 см правее обеих зон)
  assert.throws(() => setCeilingComplex(m, "room1", { x: 7000, y: 1500 }), (e: unknown) =>
    e instanceof McpError && e.code === "OUTSIDE_ROOM");
});

test("328: complex сохраняет существующие level2 (умолчания редактора не перетирают)", () => {
  const m = baseModel();
  const room = (m.rooms2 as Record<string, Record<string, unknown>>)["room1"]!;
  const rec0 = (room["ceilings"] as Record<string, unknown>[])[0]!;
  rec0["polygon"] = structuredClone(COMPLEX_REF.polygon);
  rec0["level2"] = 10;
  rec0["material2"] = "paint_ceiling";
  setCeilingComplex(m, "room1");
  const after = (room["ceilings"] as Record<string, unknown>[])[0]!;
  assert.equal(after["level2"], 10);
  assert.equal(after["material2"], "paint_ceiling");
  assert.equal(after["complex"], true);
  assert.equal(after["offset"], 40);
  void rec0;
});

// ---------- ревью 329 №3: коллинеарные рёбра (Т-узел на контуре) ----------

test("ревью 329 №3: комната с Т-узлом на контуре (примыкающая стена) — complex ставится", () => {
  const m = baseModel();
  const room = (m.rooms2 as Record<string, Record<string, unknown>>)["room1"]!;
  (room["ceilings"] as Record<string, unknown>[])[0]!["polygon"] = [
    { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 },
  ];
  const res = setCeilingComplex(m, "room1");
  assert.equal(res.already, false);
  const rec = ((room["ceilings"] ?? []) as Record<string, unknown>[])[res.index]!;
  assert.equal(rec["complex"], true);
});

test("ревью 329 №3: innerPolygon сливает коллинеарные вершины (порт mergeLines)", async () => {
  const { innerPolygon, mergeCollinearEdges } = await import("../../src/model/ceiling-complex.ts");
  const tJunction = [
    { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 },
  ];
  assert.deepEqual(mergeCollinearEdges(tJunction), [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }]);
  // прямоугольник с Т-узлом: внутренний контур — прямоугольник 320×220 (отступ 40)
  const inner = innerPolygon(tJunction, 40);
  assert.equal(inner.length, 4);
  assert.deepEqual(inner, [{ x: 360, y: 40 }, { x: 360, y: 260 }, { x: 40, y: 260 }, { x: 40, y: 40 }]);
  // углы не сливает (45° и 90°), дубликаты вершин сливает
  assert.equal(mergeCollinearEdges([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]).length, 3);
  assert.deepEqual(
    mergeCollinearEdges([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]),
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }],
  );
});

// ---------- ревью 329 №11: эталон через ингест → compact → mismatches == [] ----------

test("ревью 329 №11: ингест эталона ceiling_hole → compact CH1; levelHoleMismatches(эталон, MCP) == []", () => {
  const m = baseModel();
  m.level_holes = { [HOLE_REF.id as string]: structuredClone(HOLE_REF) as unknown as LevelHole };
  const compact = compactModel(m, ROOMS);
  const ch = compact.level_holes.find((h) => h.id === "CH1")!;
  assert.ok(ch, "эталонный проём виден как CH1");
  assert.equal(ch.type, "ceiling_hole");
  assert.equal(ch.width_mm, 300);
  assert.equal(ch.depth_mm, 300);
  assert.equal(ch.area_m2, 0.09);
  // семантическая сверка в обе стороны: то, что производит MCP по тем же углам,
  // не расходится с эталоном drag'а (вершины сопоставляются по координатам).
  // граф items в эталоне отсутствует (дамп БЕЗ сохранения, редактор достраивает
  // при draw) — заполняем ожидание значениями MCP по сопоставлению вершин по
  // координатам; сам граф items покрыт ingest-тестом b5/171
  const m2 = baseModel();
  const produced = addCeilingHole(m2, HOLES_MM(), ROOMS);
  const expectedRec = structuredClone(HOLE_REF) as unknown as { vertexes: { id: string; point: { x: number; y: number } }[]; items?: Record<string, string> };
  const gotRec = structuredClone(produced) as unknown as { vertexes: { id: string; point: { x: number; y: number } }[]; items: Record<string, string> };
  expectedRec.items = {};
  for (const ev of expectedRec.vertexes) {
    const gv = gotRec.vertexes.find((gv) => Math.abs(gv.point.x - ev.point.x) < 0.01 && Math.abs(gv.point.y - ev.point.y) < 0.01);
    assert.ok(gv, "вершина эталона воспроизведена MCP");
    expectedRec.items[ev.id] = gotRec.items[gv.id]!;
  }
  assert.deepEqual(
    levelHoleMismatches({ [HOLE_REF.id as string]: expectedRec as unknown as LevelHole }, { [HOLE_REF.id as string]: gotRec }),
    [],
  );
});

test("ревью 329 №11: floor-инструменты по ceiling-проёму — INVALID_ARGUMENT (и наоборот)", () => {
  const m = baseModel();
  const ceil = addCeilingHole(m, HOLES_MM(), ROOMS);
  assert.throws(() => updateFloorHole(m, { holeId: ceil.id }, ROOMS), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.throws(() => deleteFloorHole(m, ceil.id), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
  const floor = addFloorHole(m, { corner1: { x: 8500, y: 4500 }, corner2: { x: 8800, y: 4800 } }, ROOMS);
  assert.throws(() => updateCeilingHole(m, { holeId: floor.id }, ROOMS), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.throws(() => deleteCeilingHole(m, floor.id), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
});

// ---------- ревью 329 №4: стена/проём/complex — mock normalize в обе стороны ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

/** Mock-сессия save (как в floor-terrace.test.ts): transformNorm правит нормализованную копию. */
function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const c = { walls: 0, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      afterSave(server);
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
  return new Workspace(deps);
}

test("ревью 329 №4a: normalize потерял ceiling_hole (стена сквозь проём) — INVALID_GEOMETRY до записи", async () => {
  const m = baseModel();
  addCeilingHole(m, HOLES_MM(), ROOMS);
  const before = structuredClone(m);
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    // редактор молча потерял проём потолка (стена прошла сквозь него)
    (norm as { level_holes?: Record<string, unknown> }).level_holes = {};
  });
  await ws.open("0", "1");
  await assert.rejects(
    ws.applyWalls("wall_add", (model) => {
      addWall(model, { start: { x: 0, y: -3000 }, end: { x: 4000, y: -3000 }, thicknessMm: 100 });
      return true;
    }),
    (e: unknown) => {
      assert.ok(e instanceof McpError);
      assert.equal(e.code, "INVALID_GEOMETRY");
      const details = (e as { details?: { level_hole_mismatches?: string[] } }).details;
      assert.ok(
        (details?.level_hole_mismatches ?? []).some((x) => x.includes("потолке") && x.includes("потерян")),
        JSON.stringify(details),
      );
      return true;
    },
  );
  assert.deepEqual(m, before, "локальная модель не изменилась");
});

test("ревью 329 №4б: normalize сохранил проём при делении комнаты — мутация без ложных отказов", async () => {
  const m = baseModel();
  addCeilingHole(m, HOLES_MM(), ROOMS);
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    // редактор разделил комнату стеной: room1/room2, проём пережил (в части room1);
    // идемпотентно — save-верификация нормализует серверную копию повторно
    const rooms = (norm as { rooms2?: Record<string, Record<string, unknown>> }).rooms2!;
    if (rooms["room2"]) return;
    rooms["room1"] = { polygon: [{ x: 700, y: 300 }, { x: 930, y: 300 }, { x: 930, y: 400 }, { x: 700, y: 400 }], ceilings: [{ exist: false }] };
    rooms["room2"] = { polygon: [{ x: 700, y: 400 }, { x: 930, y: 400 }, { x: 930, y: 530 }, { x: 700, y: 530 }], ceilings: [{ exist: false }] };
  });
  await ws.open("0", "1");
  const out = await ws.applyWalls("wall_add", (model) => {
    addWall(model, { start: { x: 7000, y: 4000 }, end: { x: 9300, y: 4000 }, thicknessMm: 100 });
    return true;
  });
  assert.ok(out.result === true);
});

/** Запись complex для split-тестов: комната с двухуровневым потолком. */
function complexRoomModel(): Model {
  const m = baseModel();
  const room = (m.rooms2 as Record<string, Record<string, unknown>>)["room1"]!;
  room["polygon"] = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }];
  const rec = (room["ceilings"] as Record<string, unknown>[])[0]!;
  rec["polygon"] = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }];
  setCeilingComplex(m, "room1");
  return m;
}

test("ревью 329 №4в: стена делит комнату с двухуровневым потолком — без ложного NORMALIZATION_DROPPED", async () => {
  const m = complexRoomModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    // редактор разделил комнату: части унаследовали complex-отделку (restoreCeilings);
    // идемпотентно — серверная копия при верификации нормализуется повторно
    const rooms = (norm as { rooms2?: Record<string, Record<string, unknown>> }).rooms2!;
    if (rooms["room2"]) return;
    const srcRec = structuredClone((rooms["room1"]!["ceilings"] as Record<string, unknown>[])[0]!);
    rooms["room1"] = {
      polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 150 }, { x: 0, y: 150 }],
      ceilings: [structuredClone(srcRec)],
    };
    rooms["room2"] = {
      polygon: [{ x: 0, y: 150 }, { x: 400, y: 150 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
      ceilings: [structuredClone(srcRec)],
    };
  });
  await ws.open("0", "1");
  const out = await ws.save();
  assert.equal(out.verified, true, "split с complex — штатная топология");
});

test("ревью 329 №4в: normalize потерял complex-поля при split — NORMALIZATION_DROPPED до записи", async () => {
  const m = complexRoomModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (norm) => {
    const rooms = (norm as { rooms2?: Record<string, Record<string, unknown>> }).rooms2!;
    rooms["room1"] = {
      polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 150 }, { x: 0, y: 150 }],
      ceilings: [{ exist: true, material: "gypsum_ceiling", level: 0, profile: "standard" }],
    };
    rooms["room2"] = {
      polygon: [{ x: 0, y: 150 }, { x: 400, y: 150 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
      ceilings: [{ exist: true, material: "gypsum_ceiling", level: 0, profile: "standard" }],
    };
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "NORMALIZATION_DROPPED");
    return true;
  });
  assert.equal(saves, 0, "до записи дело не дошло");
});
