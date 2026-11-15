import test from "node:test";
import assert from "node:assert/strict";
import {
  dist, add, sub, scale, midpoint, angleDeg, leftNormal,
  segmentIntersection, lineIntersection, closestPoint, pointOnSegment, projectionLength,
  polygonArea, polygonSignedArea, polygonPerimeter, pointInPolygon, offsetSegment,
  pointAtLength, pointsAroundCenter, segmentsCross, isClockwise,
} from "../../src/model/geometry.ts";
import { mmToCm, cmToMm, round1, round0, cm2ToM2 } from "../../src/model/units.ts";
import type { Point } from "../../src/model/types.ts";
import type { Segment } from "../../src/model/geometry.ts";

const p = (x: number, y: number): Point => ({ x, y });
const seg = (x1: number, y1: number, x2: number, y2: number): Segment => ({ p1: p(x1, y1), p2: p(x2, y2) });

// ---------- units ----------

test("units: мм ⇄ см", () => {
  assert.equal(mmToCm(4000), 400);
  assert.equal(mmToCm(200), 20);
  assert.equal(cmToMm(400), 4000);
  assert.equal(cmToMm(0.1), 1);
});

test("units: округления", () => {
  assert.equal(round1(1.23456), 1.23); // до 0,01 см = 0,1 мм
  assert.equal(round1(-1.266), -1.27); // Math.round тянет половину к +∞
  assert.equal(round0(1.6), 2);
  assert.equal(round0(-1.4), -1);
  assert.equal(cm2ToM2(106400), 10.64);
  assert.equal(cm2ToM2(120000), 12);
});

test("units: точность 0,1 мм сохраняется", () => {
  assert.equal(mmToCm(1234), 123.4);
  assert.equal(cmToMm(mmToCm(1234.6)), 1234.6);
});

// ---------- векторы ----------

test("dist/add/sub/scale/midpoint", () => {
  assert.equal(dist(p(0, 0), p(3, 4)), 5);
  assert.deepEqual(add(p(1, 2), p(3, 4)), p(4, 6));
  assert.deepEqual(sub(p(4, 6), p(1, 2)), p(3, 4));
  assert.deepEqual(scale(p(2, -3), 2), p(4, -6));
  assert.deepEqual(midpoint(p(0, 0), p(10, 20)), p(5, 10));
});

test("angleDeg: по часовой стрелке при Y вниз", () => {
  assert.equal(angleDeg(p(0, 0), p(10, 0)), 0);        // +X → 0
  assert.equal(angleDeg(p(0, 0), p(0, 10)), 90);       // +Y вниз → +90
  assert.equal(angleDeg(p(0, 0), p(-10, 0)), 180);     // −X → 180
  assert.equal(angleDeg(p(0, 0), p(0, -10)), -90);     // −Y вверх → −90
});

test("leftNormal: влево по ходу при Y вниз", () => {
  assert.deepEqual(leftNormal(10, 0), p(0, -1));  // +X → нормаль вверх (−Y)
  assert.deepEqual(leftNormal(0, 10), p(1, 0));   // +Y вниз → нормаль вправо (+X)
  assert.deepEqual(leftNormal(0, 0), p(0, 0));    // вырожденный
});

// ---------- пересечения ----------

test("segmentIntersection: прямое пересечение", () => {
  const i = segmentIntersection(seg(0, 0, 10, 10), seg(0, 10, 10, 0));
  assert.ok(i);
  assert.ok(Math.abs(i.x - 5) < 1e-9 && Math.abs(i.y - 5) < 1e-9);
});

test("segmentIntersection: параллельные → null", () => {
  assert.equal(segmentIntersection(seg(0, 0, 10, 0), seg(0, 5, 10, 5)), null);
});

test("segmentIntersection: за пределами отрезков → null", () => {
  assert.equal(segmentIntersection(seg(0, 0, 1, 1), seg(5, 5, 6, 0)), null);
});

test("segmentIntersection: Т-примыкание на конце", () => {
  const i = segmentIntersection(seg(0, 0, 10, 0), seg(5, 5, 5, 0));
  assert.ok(i);
  assert.ok(Math.abs(i.x - 5) < 1e-9);
});

test("lineIntersection: продолжение за концы", () => {
  const i = lineIntersection(seg(0, 0, 1, 0), seg(5, 1, 5, 2));
  assert.ok(i);
  assert.ok(Math.abs(i.x - 5) < 1e-9 && Math.abs(i.y) < 1e-9);
});

test("lineIntersection: параллельные → null", () => {
  assert.equal(lineIntersection(seg(0, 0, 1, 0), seg(0, 1, 1, 1)), null);
});

// ---------- точка на отрезке ----------

test("closestPoint: проекция и clamping", () => {
  assert.deepEqual(closestPoint(seg(0, 0, 10, 0), p(4, 3)), { point: p(4, 0), t: 0.4 });
  assert.deepEqual(closestPoint(seg(0, 0, 10, 0), p(-5, 3)), { point: p(0, 0), t: 0 });
  assert.deepEqual(closestPoint(seg(0, 0, 10, 0), p(15, 3)), { point: p(10, 0), t: 1 });
});

test("pointOnSegment: внутри, на краю, вне", () => {
  assert.equal(pointOnSegment(seg(0, 0, 10, 0), p(5, 0)), true);
  assert.equal(pointOnSegment(seg(0, 0, 10, 0), p(10, 0)), true);
  assert.equal(pointOnSegment(seg(0, 0, 10, 0), p(5, 0.5), 0.1), false);
  assert.equal(pointOnSegment(seg(0, 0, 10, 0), p(5, 0.05), 0.1), true);
  assert.equal(pointOnSegment(seg(0, 0, 10, 0), p(12, 0)), false);
});

test("projectionLength: длина вдоль оси", () => {
  assert.equal(projectionLength(seg(0, 0, 40, 0), p(14, 7)), 14);
  assert.equal(projectionLength(seg(0, 0, 40, 0), p(-5, 0)), 0);
  assert.equal(projectionLength(seg(0, 0, 40, 0), p(50, 0)), 40);
});

// ---------- полигон ----------

const RECT_CW = [p(0, 0), p(40, 0), p(40, 30), p(0, 30)]; // по часовой при Y вниз
const RECT_CCW = [...RECT_CW].reverse();

test("polygonArea: прямоугольник и треугольник", () => {
  assert.equal(polygonArea(RECT_CW), 1200);
  assert.equal(polygonArea([p(0, 0), p(10, 0), p(0, 10)]), 50);
  assert.equal(polygonArea([p(0, 0)]), 0);
});

test("polygonSignedArea/isClockwise: Y вниз", () => {
  assert.ok(polygonSignedArea(RECT_CW) > 0);
  assert.equal(isClockwise(RECT_CW), true);
  assert.equal(isClockwise(RECT_CCW), false);
  assert.equal(polygonSignedArea(RECT_CCW), -polygonSignedArea(RECT_CW));
});

test("polygonPerimeter", () => {
  assert.equal(polygonPerimeter(RECT_CW), 140);
});

test("pointInPolygon: внутри, вне, на границе", () => {
  assert.equal(pointInPolygon(RECT_CW, p(20, 15)), true);
  assert.equal(pointInPolygon(RECT_CW, p(50, 15)), false);
  assert.equal(pointInPolygon(RECT_CW, p(0, 0)), true);   // вершина
  assert.equal(pointInPolygon(RECT_CW, p(20, 0)), true);  // ребро
  assert.equal(pointInPolygon(RECT_CW, p(20, -0.001), 1e-9), false);
});

test("pointInPolygon: невыпуклый полигон", () => {
  const L = [p(0, 0), p(30, 0), p(30, 30), p(20, 30), p(20, 10), p(0, 10)];
  assert.equal(pointInPolygon(L, p(10, 5)), true);   // нижняя полка
  assert.equal(pointInPolygon(L, p(25, 20)), true);  // правый столб
  assert.equal(pointInPolygon(L, p(10, 20)), false); // вырез
  assert.equal(pointInPolygon(L, p(25, 35)), false);
});

// ---------- смещения ----------

test("offsetSegment: влево по ходу при Y вниз", () => {
  const o = offsetSegment(seg(0, 0, 40, 0), 10);
  assert.deepEqual(o.p1, p(0, -10));
  assert.deepEqual(o.p2, p(40, -10));
  const o2 = offsetSegment(seg(0, 0, 0, 30), 10);
  assert.deepEqual(o2.p1, p(10, 0));
  assert.deepEqual(o2.p2, p(10, 30));
});

test("pointAtLength: точка на расстоянии от p1", () => {
  assert.deepEqual(pointAtLength(seg(0, 0, 40, 0), 14), p(14, 0));
  assert.deepEqual(pointAtLength(seg(0, 0, 40, 0), 100), p(40, 0));
  assert.deepEqual(pointAtLength(seg(0, 0, 40, 0), -5), p(0, 0));
});

test("pointsAroundCenter: края проёма на оси", () => {
  const { p1, p2 } = pointsAroundCenter(seg(0, 0, 40, 0), p(20, 0), 6);
  assert.deepEqual(p1, p(14, 0));
  assert.deepEqual(p2, p(26, 0));
});

test("segmentsCross: пересечение и касание", () => {
  assert.equal(segmentsCross(seg(0, 0, 10, 10), seg(0, 10, 10, 0)), true);
  assert.equal(segmentsCross(seg(0, 0, 10, 0), seg(5, 5, 5, 0)), true);
  assert.equal(segmentsCross(seg(0, 0, 10, 0), seg(0, 5, 10, 5)), false);
});
