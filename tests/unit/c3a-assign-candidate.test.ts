// Аудит 65 C3 / план №7 (рефакторинг без изменения поведения): общий хелпер
// assignCandidate. Хелпер: identity объекта, удаление устаревших ключей,
// порядок ключей, поверхностное присваивание вложенных значений. Для каждой
// переведённой сущности (pillar, rigel, gas_line, warm_floor, световая линия,
// opening) — тест через публичную update-функцию: отказ валидации оставляет
// исходный объект неизменным (identity и содержимое).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, LedStrip } from "../../src/model/types.ts";
import { assignCandidate } from "../../src/model/assign.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addPillar, updatePillar } from "../../src/model/pillars.ts";
import { addRigel, updateRigel } from "../../src/model/rigels.ts";
import { addGasLine, updateGasLine } from "../../src/model/pipes.ts";
import { addWarmFloor, updateWarmFloor } from "../../src/model/climate.ts";
import { addLightLine, updateLightLine } from "../../src/model/lighting.ts";
import { addOpening, updateOpening } from "../../src/model/openings.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {} };
}

/** Прямоугольник 4000×3000, возвращает стены {top, right, bottom, left}. */
function rect(model: Model) {
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  return { top: walls[0]!, right: walls[1]!, bottom: walls[2]!, left: walls[3]! };
}

test("assignCandidate: identity — target остаётся тем же объектом, значения обновляются", () => {
  const target = { a: 1, b: 10 };
  const candidate = { a: 2, b: 20 };
  assignCandidate(target, candidate);
  assert.equal(target.a, 2);
  assert.equal(target.b, 20);
});

test("assignCandidate: ключи, которых нет у кандидата, удаляются", () => {
  const target: Record<string, unknown> = { a: 1, stale: "x" };
  const candidate: Record<string, unknown> = { a: 2 };
  assignCandidate(target, candidate);
  assert.deepEqual(Object.keys(target), ["a"]);
  assert.equal(target.a, 2);
  assert.equal("stale" in target, false);
});

test("assignCandidate: порядок ключей — ключи target, затем новые ключи кандидата", () => {
  const target: Record<string, unknown> = { b: 0, a: 1 };
  const candidate: Record<string, unknown> = { a: 2, c: 3 };
  assignCandidate(target, candidate);
  // b удалён (нет у кандидата), a остаётся на своей позиции, c дописан в конец
  assert.deepEqual(Object.keys(target), ["a", "c"]);
});

test("assignCandidate: вложенные объекты и массивы присваиваются поверхностно — по ссылке от кандидата", () => {
  const nested = { x: 1 };
  const arr = [1, 2, 3];
  const target = { nested: { x: 0 }, arr: [9] as number[] };
  const candidate = { nested, arr };
  assignCandidate(target, candidate);
  assert.equal(target.nested, nested);
  assert.equal(target.arr, arr);
  // сам target не заменяется новым объектом
  const candidate2 = { ...candidate };
  assignCandidate(target, candidate2);
  assert.equal(target.nested, nested);
});

test("updatePillar: отказ валидации — колонна не изменена (identity и содержимое)", () => {
  const model = emptyModel();
  rect(model);
  const pillar = addPillar(model, { center: { x: 1000, y: 1000 } });
  const snapshot = structuredClone(pillar);
  assert.throws(() => updatePillar(model, { pillarId: pillar.id, widthMm: 1 }), McpError);
  assert.equal(model.pillars[pillar.id], pillar);
  assert.deepEqual(pillar, snapshot);
});

test("updateRigel: отказ валидации (вырожденная ось) — ригель не изменён", () => {
  const model = emptyModel();
  rect(model);
  const rigel = addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 } });
  const snapshot = structuredClone(rigel);
  assert.throws(
    () => updateRigel(model, { rigelId: rigel.id, start: { x: 2000, y: 1000 }, end: { x: 2000, y: 1000 } }),
    McpError,
  );
  assert.equal(model.rigels![rigel.id], rigel);
  assert.deepEqual(rigel, snapshot);
});

test("updateGasLine: отказ валидации (совпадающие концы) — линия не изменена", () => {
  const model = emptyModel();
  const line = addGasLine(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 } });
  const snapshot = structuredClone(line);
  assert.throws(
    () => updateGasLine(model, { gasLineId: line.id, end: { x: 1000, y: 1000 } }),
    McpError,
  );
  assert.equal(model.pipes_gas![line.id], line);
  assert.deepEqual(line, snapshot);
});

test("updateWarmFloor: отказ валидации (нулевая площадь) — контур не изменён", () => {
  const model = emptyModel();
  rect(model);
  model.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  const wf = addWarmFloor(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 1000, y: 1000 } });
  const snapshot = structuredClone(wf);
  assert.throws(
    () => updateWarmFloor(model, { warmFloorId: wf.id, corner2: { x: 500, y: 500 } }),
    McpError,
  );
  assert.equal(model.warm_floors![wf.id], wf);
  assert.deepEqual(wf, snapshot);
});

test("updateLightLine: отказ валидации (vertex вне диапазона) — линия не изменена", () => {
  const model = emptyModel();
  const line = addLightLine(model, { kind: "led", path: [{ x: 1000, y: 1000 }, { x: 2500, y: 1000 }] }) as LedStrip;
  const snapshot = structuredClone(line);
  assert.throws(
    () => updateLightLine(model, { kind: "led", lineId: line.id, positions: [{ vertex: 9, x: 1500, y: 1500 }] }),
    McpError,
  );
  assert.equal(model.led_strips![line.id], line);
  assert.deepEqual(line, snapshot);
});

test("updateOpening: отказ валидации (смена типа) — проём не изменён", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const hole = addOpening(model, { wallId: top.id, type: "door", offsetMm: 300, widthMm: 800 });
  const snapshot = structuredClone(hole);
  assert.throws(
    () => updateOpening(model, { wallId: top.id, holeId: hole.id, type: "window" }),
    McpError,
  );
  assert.equal(top.holes[hole.id], hole);
  assert.deepEqual(hole, snapshot);
});
