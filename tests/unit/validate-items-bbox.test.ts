// Дефект 2 (отчёт 11-user-trial-1): model_validate проверяет прямоугольник предмета
// с учётом поворота (bbox), а не только центр: выход за внутренние грани комнаты
// (ITEM_OUTSIDE_ROOM) и пересечение со стеной (ITEM_INTERSECTS_WALL) — с вылетом в мм.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateModel } from "../../src/model/validate.ts";
import { addItem } from "../../src/model/items.ts";
import { prepareForRestore } from "../../src/model/walls.ts";
import type { Model, FixtureEnvelope } from "../../src/model/types.ts";
import type { RoomPolygon } from "../../src/model/items.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function loadModel(name: string): Model {
  const env = JSON.parse(readFileSync(join(ROOT, "tests/fixtures", name), "utf8")) as FixtureEnvelope;
  return env.model;
}

/** Комната по внутренним граням фикстуры 4000×3000 (см). */
const ROOM: RoomPolygon[] = [{
  roomId: "r1",
  polygon: [{ x: 10, y: 10 }, { x: 390, y: 10 }, { x: 390, y: 290 }, { x: 10, y: 290 }],
  areaCm2: 380 * 280,
  axisAreaCm2: null,
}];

/** Сценарий из отчёта 11: диван 2000×800 с центром в 500 мм за верхней внутренней гранью. */
function incidentModel(): Model {
  const model = loadModel("anon-rect-4000x3000.json");
  prepareForRestore(model);
  addItem(model, {
    name: "sofa_triple",
    position: { center: { x: 1400, y: 600 } }, // мм: центр y=600, диван с angle 90 → y 500..2500 мм
    angleDeg: 90,
    widthMm: 2000,
    depthMm: 800,
    heightMm: 850,
  }, ROOM);
  return model;
}

test("validate-bbox: диван, вылезший за внутреннюю грань на 500 мм, ловится (центр внутри — старый код молчал)", () => {
  const problems = validateModel(incidentModel(), ROOM);
  const hit = problems.find((p) => p.code === "ITEM_OUTSIDE_ROOM");
  assert.ok(hit, `ожидался ITEM_OUTSIDE_ROOM: ${JSON.stringify(problems)}`);
  assert.equal(hit!.details?.protrusion_mm, 500, `вылет 500 мм, получено ${JSON.stringify(hit!.details)}`);
});

test("validate-bbox: тот же диван пересекает тело стены → ITEM_INTERSECTS_WALL с вылетом", () => {
  const problems = validateModel(incidentModel(), ROOM);
  const hit = problems.find((p) => p.code === "ITEM_INTERSECTS_WALL");
  assert.ok(hit, `ожидался ITEM_INTERSECTS_WALL: ${JSON.stringify(problems)}`);
  assert.equal(hit!.details?.protrusion_mm, 500, `вылет 500 мм, получено ${JSON.stringify(hit!.details)}`);
  assert.ok(hit!.details?.wall_id, "указана стена");
});

test("validate-bbox: предмет вплотную к внутренней грани (касание) — не проблема", () => {
  const model = loadModel("anon-rect-4000x3000.json");
  prepareForRestore(model);
  // диван 2000×800 без поворота, центр y = 10 см (внутренняя грань) + 40 см (полглубины)
  addItem(model, { name: "sofa_triple", position: { center: { x: 2000, y: 500 } }, widthMm: 2000, depthMm: 800, heightMm: 850 }, ROOM);
  const problems = validateModel(model, ROOM);
  assert.equal(problems.length, 0, JSON.stringify(problems));
});

test("validate-bbox: предмет в проёме двери не считается пересекающим стену", () => {
  const model = loadModel("anon-rect-4000x3000.json");
  prepareForRestore(model);
  // дверь на верхней стене (ось y=0, тело −10..10 см) с проёмом 120 см; item 80×80 в проёме.
  // addItem сам отвергает центр вне комнат, поэтому вставляем props напрямую
  model.items["idw"] = {
    id: "idw", name: "wardrobe",
    pc: { x: 200, y: 0 }, angle: 0, width: 80, height: 80, self_height: 200,
    plan: { furniture: 1 }, id_room: null, id_wall: null, layer: null, comment: null,
  };
  const problems = validateModel(model, ROOM);
  assert.ok(problems.some((p) => p.code === "ITEM_OUTSIDE_ROOM"), "центр вне комнаты — отмечается");
  assert.ok(!problems.some((p) => p.code === "ITEM_INTERSECTS_WALL"), `в проёме стены нет: ${JSON.stringify(problems)}`);
});

// Ревью v0.1.1 №1: отрицательный tolerance исключал проверку угла на границе —
// предмет, касающийся стены вплотную, получал ITEM_OUTSIDE_ROOM с вылетом 0 мм.
// Касание (зазор 0, включая погрешность sin/cos) не ошибка; допуск 1 мм в пользу «внутри».
test("validate-bbox: касание нижней и правой грани при 0° — не проблема", () => {
  const model = loadModel("anon-rect-4000x3000.json");
  prepareForRestore(model);
  // низ: углы bbox ровно на y=290 (внутренняя грань), центр y = 290 − 40
  addItem(model, { name: "sofa_triple", position: { center: { x: 2000, y: 2500 } }, widthMm: 2000, depthMm: 800, heightMm: 850 }, ROOM);
  const problemsBottom = validateModel(model, ROOM);
  assert.equal(problemsBottom.length, 0, JSON.stringify(problemsBottom));
  // правая грань: углы ровно на x=390 (центр 390 − полширины 100 см)
  const model2 = loadModel("anon-rect-4000x3000.json");
  prepareForRestore(model2);
  addItem(model2, { name: "sofa_triple", position: { center: { x: 2900, y: 1500 } }, widthMm: 2000, depthMm: 800, heightMm: 850 }, ROOM);
  const problemsRight = validateModel(model2, ROOM);
  assert.equal(problemsRight.length, 0, JSON.stringify(problemsRight));
});

test("validate-bbox: касание граней при 90° и 45° (включая погрешность sin/cos) — не проблема", () => {
  // 90°: диван 2000×800 повёрнут, нижние углы на y=290
  const m90 = loadModel("anon-rect-4000x3000.json");
  prepareForRestore(m90);
  addItem(m90, { name: "sofa_triple", position: { center: { x: 2000, y: 1900 } }, angleDeg: 90, widthMm: 2000, depthMm: 800, heightMm: 850 }, ROOM);
  assert.equal(validateModel(m90, ROOM).length, 0, JSON.stringify(validateModel(m90, ROOM)));
  // 45°: нижний угол ровно на y=290 с поправкой на поворот
  const m45 = loadModel("anon-rect-4000x3000.json");
  prepareForRestore(m45);
  const drop45 = (100 + 80) * Math.SQRT1_2; // вылет повёрнутого угла по y, см
  addItem(m45, { name: "sofa_triple", position: { center: { x: 2000, y: 2900 - Math.round(drop45 * 10) } }, angleDeg: 45, widthMm: 2000, depthMm: 800, heightMm: 850 }, ROOM);
  assert.equal(validateModel(m45, ROOM).length, 0, JSON.stringify(validateModel(m45, ROOM)));
  // верхняя грань при 90°: верхние углы ровно на y=10
  const m90top = loadModel("anon-rect-4000x3000.json");
  prepareForRestore(m90top);
  addItem(m90top, { name: "sofa_triple", position: { center: { x: 2000, y: 1100 } }, angleDeg: 90, widthMm: 2000, depthMm: 800, heightMm: 850 }, ROOM);
  assert.equal(validateModel(m90top, ROOM).length, 0, JSON.stringify(validateModel(m90top, ROOM)));
});

test("validate-bbox: реальное проникновение за грань (5 мм за пределы допуска) остаётся ошибкой", () => {
  const model = loadModel("anon-rect-4000x3000.json");
  prepareForRestore(model);
  // центр на 5 мм глубже касания: углы на y=290.5 — за внутренней гранью
  addItem(model, { name: "sofa_triple", position: { center: { x: 2000, y: 2505 } }, widthMm: 2000, depthMm: 800, heightMm: 850 }, ROOM);
  const problems = validateModel(model, ROOM);
  const hit = problems.find((p) => p.code === "ITEM_OUTSIDE_ROOM");
  assert.ok(hit, `ожидался ITEM_OUTSIDE_ROOM: ${JSON.stringify(problems)}`);
  assert.equal(hit!.details?.protrusion_mm, 5);
});

test("validate-bbox: предмет поперёк перегородки между комнатами → ITEM_INTERSECTS_WALL без OUTSIDE_ROOM", () => {
  const model = loadModel("anon-rect-4000x3000.json");
  prepareForRestore(model);
  // перегородка по x=200 см (ось), толщина 10 см; комнаты слева и справа от неё
  model.walls["part"] = {
    id: "part", plan: "c", role: "wall", child: 0, archive: 0, demount: 0,
    depth: 10, height: 270,
    p1: { x: 200, y: 10 }, p2: { x: 200, y: 290 },
    holes: {}, material: "a_block",
  } as Model["walls"][string];
  prepareForRestore(model);
  const rooms: RoomPolygon[] = [
    { roomId: "r1", polygon: [{ x: 10, y: 10 }, { x: 195, y: 10 }, { x: 195, y: 290 }, { x: 10, y: 290 }], areaCm2: 1, axisAreaCm2: null },
    { roomId: "r2", polygon: [{ x: 205, y: 10 }, { x: 390, y: 10 }, { x: 390, y: 290 }, { x: 205, y: 290 }], areaCm2: 1, axisAreaCm2: null },
  ];
  // центр в правой комнате, но bbox 200 см шириной заходит за перегородку
  model.items["icross"] = {
    id: "icross", name: "sofa_triple",
    pc: { x: 240, y: 150 }, angle: 0, width: 200, height: 80, self_height: 85,
    plan: { furniture: 1 }, id_room: null, id_wall: null, layer: null, comment: null,
  };
  const problems = validateModel(model, rooms);
  assert.ok(problems.some((p) => p.code === "ITEM_INTERSECTS_WALL"), JSON.stringify(problems));
  assert.ok(!problems.some((p) => p.code === "ITEM_OUTSIDE_ROOM"), `углы в одной из комнат: ${JSON.stringify(problems)}`);
});
