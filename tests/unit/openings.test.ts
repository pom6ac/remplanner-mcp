import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import {
  addOpening, updateOpening, deleteOpening, OPENING_KINDS, openingFromSwing,
  holeCenterFromStart, holeOffsetFromStart,
} from "../../src/model/openings.ts";
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

test("OPENING_KINDS: door → single (проверено T1), window → window", () => {
  assert.equal(OPENING_KINDS["door"]!.type, "single");
  assert.equal(OPENING_KINDS["door"]!.group, "doors");
  assert.equal(OPENING_KINDS["window"]!.type, "window");
  assert.equal(OPENING_KINDS["window"]!.group, "windows");
  assert.equal(OPENING_KINDS["doorway"]!.group, "doors");
  assert.equal(OPENING_KINDS["windowway"]!.group, "windows");
});

test("addOpening: дверь 800 с отступом 300 от угла внутренней грани даёт pc на оси в нужной точке", () => {
  const model = emptyModel();
  const { top } = rect(model);
  // ось верхней стены: (-10,-10) → (410,-10), длина 420 см
  assert.deepEqual([top.p1.x, top.p1.y], [-10, -10]);
  const hole = addOpening(model, { wallId: top.id, type: "door", offsetMm: 300, widthMm: 800 });
  assert.equal(hole.type, "single");
  assert.equal(hole.group, "doors");
  // отступ от внутреннего угла (x=0): край на 300 мм, ширина 800 → центр на 700 мм = 70 см
  assert.deepEqual(hole.pc, { x: 70, y: -10 });
  assert.deepEqual(hole.p1, { x: 30, y: -10 });
  assert.deepEqual(hole.p2, { x: 110, y: -10 });
  assert.equal(hole.height, 210); // эталон UI (этап 37): высота двери 210, а не 200
  assert.equal(hole.depth, 4);
  assert.equal(hole.floor_height, undefined);
});

test("addOpening: окно с подоконником 800 мм", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const hole = addOpening(model, { wallId: top.id, type: "window", centerMm: 2000, sillHeightMm: 800 });
  assert.equal(hole.type, "window");
  assert.deepEqual(hole.pc, { x: 190, y: -10 });
  assert.deepEqual(hole.p1, { x: 130, y: -10 });
  assert.deepEqual(hole.p2, { x: 250, y: -10 });
  assert.equal(hole.floor_height, 80);
  assert.equal(hole.height, 150);
  // эталон UI (ui-ref-window-window.json): глубина окна 6 см, не толщина стены
  assert.equal(hole.depth, 6);
  assert.equal(hole.casements, 1);
  assert.equal(hole.slopes, 20);
  assert.equal(hole.slope_angle, 0);
  assert.equal(hole.casing, 1);
  assert.equal(hole.opening, "r-l");
  assert.deepEqual(hole.sill, { thinkness: 4, overhang: 0, overmeasure: 0, side: "l" });
});

test("addOpening: from end — отступ от внутреннего угла конца стены", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const hole = addOpening(model, { wallId: top.id, type: "door", offsetMm: 300, from: "end", widthMm: 800 });
  // внутренний угол конца стены x=400 (ось 410 см): край на 300 мм от угла → центр 3300 мм от p1
  assert.deepEqual(hole.pc, { x: 330, y: -10 });
  // axis-режим: от осевого конца (410 см)
  const model2 = emptyModel();
  const { top: top2 } = rect(model2);
  const hole2 = addOpening(model2, { wallId: top2.id, type: "door", offsetMm: 300, from: "end", widthMm: 800, offsetFrom: "axis" });
  assert.deepEqual(hole2.pc, { x: 340, y: -10 });
});

test("addOpening: swing → opening (проверенная комбинация r-l)", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const hole = addOpening(model, {
    wallId: top.id, type: "door", centerMm: 2000,
    swing: { hinge: "end", into: "left" },
  });
  assert.equal(hole.opening, "r-l");
  assert.equal(openingFromSwing({ hinge: "start", into: "left" }), "l-l");
  assert.equal(openingFromSwing({ hinge: "start", into: "right" }), "l-r");
  assert.equal(openingFromSwing({ hinge: "end", into: "right" }), "r-r");
});

test("addOpening: проём вне стены → GEOMETRY_CONFLICT", () => {
  const model = emptyModel();
  const { top } = rect(model);
  assert.throws(
    () => addOpening(model, { wallId: top.id, type: "door", centerMm: 100, widthMm: 800 }),
    (e: McpError) => e.code === "GEOMETRY_CONFLICT" && (e.toJSON().details as { kind: string }).kind === "opening_outside_wall",
  );
});

test("addOpening: пересечение проёмов → GEOMETRY_CONFLICT", () => {
  const model = emptyModel();
  const { top } = rect(model);
  addOpening(model, { wallId: top.id, type: "door", offsetMm: 300, widthMm: 800 });
  assert.throws(
    () => addOpening(model, { wallId: top.id, type: "window", offsetMm: 800, widthMm: 1200 }),
    (e: McpError) => e.code === "GEOMETRY_CONFLICT" && (e.toJSON().details as { kind: string }).kind === "openings_overlap",
  );
  // вплотную (не пересекаются) — можно
  const h2 = addOpening(model, { wallId: top.id, type: "window", offsetMm: 1100, widthMm: 1200 });
  assert.ok(h2);
});

test("addOpening: неизвестный тип → INVALID_ARGUMENT", () => {
  const model = emptyModel();
  const { top } = rect(model);
  assert.throws(
    () => addOpening(model, { wallId: top.id, type: "balcony123" }),
    (e: McpError) => e.code === "INVALID_ARGUMENT",
  );
});

test("addOpening: стена не найдена → NOT_FOUND", () => {
  const model = emptyModel();
  assert.throws(() => addOpening(model, { wallId: "nope", type: "door" }), (e: McpError) => e.code === "NOT_FOUND");
});

test("updateOpening: перенос и изменение ширины", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const hole = addOpening(model, { wallId: top.id, type: "door", offsetMm: 300, widthMm: 800 });
  updateOpening(model, { wallId: top.id, holeId: hole.id, centerMm: 3000, widthMm: 900 });
  assert.deepEqual(hole.pc, { x: 290, y: -10 });
  assert.deepEqual(hole.p1, { x: 245, y: -10 });
  assert.deepEqual(hole.p2, { x: 335, y: -10 });
});

test("updateOpening: коллизия при переносе → GEOMETRY_CONFLICT", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const d = addOpening(model, { wallId: top.id, type: "door", centerMm: 1000, widthMm: 800 });
  addOpening(model, { wallId: top.id, type: "window", centerMm: 3000, widthMm: 1200 });
  assert.throws(
    () => updateOpening(model, { wallId: top.id, holeId: d.id, centerMm: 2800 }),
    (e: McpError) => e.code === "GEOMETRY_CONFLICT",
  );
});

test("deleteOpening удаляет проём", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const hole = addOpening(model, { wallId: top.id, type: "door", centerMm: 2000 });
  deleteOpening(model, top.id, hole.id);
  assert.equal(Object.keys(top.holes).length, 0);
  assert.throws(() => deleteOpening(model, top.id, hole.id), (e: McpError) => e.code === "NOT_FOUND");
});

test("holeCenterFromStart/holeOffsetFromStart в мм (от начала оси)", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const hole = addOpening(model, { wallId: top.id, type: "door", offsetMm: 300, widthMm: 800 });
  // offset задавался от внутреннего угла (x=0); от начала оси (x=-10) край на 400 мм, центр 800 мм
  assert.equal(holeOffsetFromStart(top, hole), 400);
  assert.equal(holeCenterFromStart(top, hole), 800);
});
