// 112: юнит-тесты чистых функций guard'а несоединённых концов (ревью 111 R10).
// expectedDanglingEndPoints — не переносить наследование на внутренний узел
// разреза; unmatchedDanglingEnds — сопоставление унаследованных концов
// один-к-одному (одна ожидаемая точка оправдывает не более одного конца).
import test from "node:test";
import assert from "node:assert/strict";
import { expectedDanglingEndPoints, unmatchedDanglingEnds, type DanglingEnd } from "../../src/model/walls.ts";

// ---------- чистые функции guard'а: топология разреза и один-к-одному ----------

test("112 R10: ожидаемые точки не включают внутренний узел разреза (wallId.node соединён после split)", () => {
  const before: Array<{ wallId: string; node: "p1" | "p2"; point: { x: number; y: number } }> = [
    { wallId: "w", node: "p2", point: { x: 600, y: -600 } },
  ];
  const afterWalls = [
    { id: "w", p1: { x: 0, y: -600 }, p2: { x: 300, y: -600 }, depth: 10 },
    { id: "w2", p1: { x: 300, y: -600 }, p2: { x: 600, y: -600 }, depth: 10 },
  ];
  const pts = expectedDanglingEndPoints(before, afterWalls);
  assert.deepEqual(pts, [{ x: 600, y: -600 }], "только исходная точка свободного конца");
});

test("112 R10: перенос конца вместе со стеной остаётся в ожидаемых точках", () => {
  const before: Array<{ wallId: string; node: "p1" | "p2"; point: { x: number; y: number } }> = [
    { wallId: "w", node: "p1", point: { x: 0, y: -600 } },
  ];
  const afterWalls = [{ id: "w", p1: { x: 20, y: -620 }, p2: { x: 620, y: -620 }, depth: 10 }];
  const pts = expectedDanglingEndPoints(before, afterWalls);
  assert.equal(pts.length, 2);
  assert.ok(pts.some((p) => p.x === 20 && p.y === -620), "новое положение конца добавлено");
});

test("112 R10: одна ожидаемая точка оправдывает не более одного конца (сопоставление один-к-одному)", () => {
  const expected = [{ x: 300, y: -600 }];
  const dangling: DanglingEnd[] = [
    { wallId: "a", node: "p2", point: { x: 300, y: -600 } },
    { wallId: "b", node: "p1", point: { x: 300.2, y: -600 } },
  ];
  const unmatched = unmatchedDanglingEnds(dangling, expected);
  assert.equal(unmatched.length, 1, "второй конец остался неоправданным");
});

test("112 R10: два конца — две ожидаемые точки, оба оправданы", () => {
  const expected = [{ x: 300, y: -600 }, { x: 300.2, y: -600 }];
  const dangling: DanglingEnd[] = [
    { wallId: "a", node: "p2", point: { x: 300, y: -600 } },
    { wallId: "b", node: "p1", point: { x: 300.2, y: -600 } },
  ];
  assert.equal(unmatchedDanglingEnds(dangling, expected).length, 0);
});

test("112 R10: конец дальше допуска не оправдан", () => {
  const expected = [{ x: 0, y: -600 }];
  const dangling: DanglingEnd[] = [{ wallId: "a", node: "p1", point: { x: 0.6, y: -600 } }];
  assert.equal(unmatchedDanglingEnds(dangling, expected).length, 1);
});
