import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "../../src/model/types.ts";
import { compactModel, compactModelJson } from "../../src/model/compact.ts";
import { validateModel } from "../../src/model/validate.ts";
import { prepareForRestore, addWall, addRoomRect } from "../../src/model/walls.ts";
import { addItem } from "../../src/model/items.ts";

void addWall;

const here = dirname(fileURLToPath(import.meta.url));

function loadModel(name: string): Model {
  return JSON.parse(readFileSync(join(here, "../fixtures", name), "utf8")).model as Model;
}

function preparedRect(): Model {
  const model = loadModel("anon-rect-4000x3000.json");
  prepareForRestore(model);
  return model;
}

// ---------- compact ----------

test("compact: фикстура 4000×3000 меньше 2 КБ и содержит площадь 12,00 м²", () => {
  const model = preparedRect();
  const json = compactModelJson(model);
  assert.ok(json.length < 2048, `компактная модель ${json.length} байт, ожидалось < 2048`);
  const compact = compactModel(model);
  assert.equal(compact.rooms.length, 1);
  // площадь редактора по внутренним граням (rooms2) — 10,64 м²; осевой площади нет (T27)
  assert.equal(compact.rooms[0]!.area_m2, 10.64);
  assert.equal(compact.rooms[0]!.area_axis_m2, null);
  assert.equal(compact.walls.length, 4);
  assert.ok(compact.walls.every((w) => /^W\d+$/.test(w.id)));
  // длины по внутренним граням: у фикстуры ось 4000×3000 → грани 3800×2800
  const inners = compact.walls.map((w) => w.len_inner_mm).sort((a, b) => b - a);
  assert.deepEqual(inners, [3800, 3800, 2800, 2800]);
  // проёмы с отступами
  const withHoles = compact.walls.filter((w) => w.openings.length > 0);
  assert.equal(withHoles.length, 2);
  for (const o of withHoles.flatMap((w) => w.openings)) {
    assert.ok(o.width_mm > 0);
    assert.ok(o.offset_mm >= 0);
  }
});

test("compact: имя помещения из rooms2.zones[0].name", () => {
  const model = preparedRect();
  model.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12, zones: [{ name: "Гостиная" }] } };
  const compact = compactModel(model);
  assert.equal(compact.rooms[0]!.name, "Гостиная");
});

test("compact: предметы с метками I и размерами в мм", () => {
  const model = preparedRect();
  addItem(model, { name: "sofa_double", position: { center: { x: 2000, y: 1500 } }, widthMm: 1400, depthMm: 800, heightMm: 850 });
  const compact = compactModel(model);
  assert.equal(compact.items.length, 1);
  assert.equal(compact.items[0]!.id, "I1");
  assert.equal(compact.items[0]!.width_mm, 1400);
  assert.equal(compact.items[0]!.height_mm, 850);
});

// ---------- validate ----------

test("validate: подготовленная модель 4000×3000 без проблем (кроме висячих узлов нет)", () => {
  const problems = validateModel(preparedRect());
  assert.deepEqual(problems, []);
});

test("validate: рабочая копия без граней и p1/p2 чиста — prepare вычисляет их на клоне", () => {
  const model = loadModel("anon-rect-4000x3000.json");
  const problems = validateModel(model);
  assert.equal(problems.filter((p) => p.code === "MISSING_WALL_FACES" || p.code === "MISSING_HOLE_POINTS").length, 0,
    JSON.stringify(problems));
  assert.ok(!model.walls || Object.values(model.walls).every((w) => !("l1" in w) || (w as { l1?: unknown }).l1 === undefined),
    "исходная модель не мутируется валидатором");
});

test("validate: вырожденная стена (нулевой длины) → MISSING_WALL_FACES", () => {
  const model = loadModel("anon-rect-4000x3000.json") as Model;
  const first = Object.values(model.walls)[0]!;
  model.walls["degenerate"] = {
    ...structuredClone(first),
    id: "degenerate",
    p1: { x: 0, y: 0 },
    p2: { x: 0, y: 0 },
    holes: {},
  };
  const problems = validateModel(model);
  assert.ok(problems.some((p) => p.code === "MISSING_WALL_FACES" && p.details?.wall_id === "degenerate"));
});

test("validate: стена короче 3 см → WALL_TOO_SHORT", () => {
  const problems = validateModel(loadModel("broken-wall-too-short.json"));
  assert.ok(problems.some((p) => p.code === "WALL_TOO_SHORT" && p.details?.wall_id === "b1"));
});

test("validate: стена поверх другой → WALL_OVER_WALL", () => {
  const problems = validateModel(loadModel("broken-wall-over-wall.json"));
  assert.ok(problems.some((p) => p.code === "WALL_OVER_WALL"));
});

test("validate: проём вне стены → OPENING_OUTSIDE_WALL", () => {
  const problems = validateModel(loadModel("broken-opening-outside.json"));
  assert.ok(problems.some((p) => p.code === "OPENING_OUTSIDE_WALL" && p.details?.hole_id === "bad1"));
});

test("validate: пересекающиеся проёмы → OPENINGS_OVERLAP", () => {
  const problems = validateModel(loadModel("broken-openings-overlap.json"));
  assert.ok(problems.some((p) => p.code === "OPENINGS_OVERLAP"));
});

test("validate: предмет вне помещений → ITEM_OUTSIDE_ROOM", () => {
  const problems = validateModel(loadModel("broken-item-outside.json"));
  assert.ok(problems.some((p) => p.code === "ITEM_OUTSIDE_ROOM" && p.details?.item_id === "iout1"));
});

test("validate: проём без p1/p2 восстанавливается из pc (prepare на клоне), сорванный pc ловится", () => {
  const model = preparedRect();
  const wall = Object.values(model.walls)[0]!;
  wall.holes["nopts"] = { id: "nopts", plan: "a", type: "window", group: "windows", pc: { x: 200, y: 0 }, width: 120, height: 150, depth: 10 };
  delete wall.holes["nopts"].p1;
  delete wall.holes["nopts"].p2;
  const problems = validateModel(model);
  assert.ok(!problems.some((p) => p.details?.hole_id === "nopts"), JSON.stringify(problems));
  // сорванный pc (вне оси) — ловится
  wall.holes["offaxis"] = { id: "offaxis", plan: "a", type: "window", group: "windows", pc: { x: 200, y: 10 }, width: 120, height: 150, depth: 10 };
  const problems2 = validateModel(model);
  assert.ok(problems2.some((p) => p.code === "OPENING_OFF_AXIS" && p.details?.hole_id === "offaxis"),
    JSON.stringify(problems2));
});

test("validate: общая стена двух комнат не считается пересечением", () => {
  const model = preparedRect();
  model.walls = {};
  addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 3000, depthMm: 4000, thicknessMm: 200 });
  addRoomRect(model, { origin: { x: 3200, y: 0 }, widthMm: 2000, depthMm: 4000, thicknessMm: 200 });
  prepareForRestore(model);
  const problems = validateModel(model).filter((p) => p.code !== "WALL_DANGLING");
  assert.ok(!problems.some((p) => p.code === "WALL_OVER_WALL"), JSON.stringify(problems));
});
