import type { Point } from "./types.ts";

export type Segment = { p1: Point; p2: Point };

export const EPS = 1e-9;

export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Point, k: number): Point {
  return { x: a.x * k, y: a.y * k };
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Угол по часовой стрелке от оси X при Y вниз, градусы (−180…180). */
export function angleDeg(a: Point, b: Point): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** Нормаль влево по ходу (dx,dy) при Y вниз: (dy,−dx). */
export function leftNormal(dx: number, dy: number): Point {
  const len = Math.hypot(dx, dy);
  if (len < EPS) return { x: 0, y: 0 };
  const nx = dy / len;
  const ny = -dx / len;
  return { x: nx === 0 ? 0 : nx, y: ny === 0 ? 0 : ny };
}

/** Пересечение отрезков; null, если параллельны или не пересекаются. */
export function segmentIntersection(s1: Segment, s2: Segment): Point | null {
  const d1 = sub(s1.p2, s1.p1);
  const d2 = sub(s2.p2, s2.p1);
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < EPS) return null;
  const t = ((s2.p1.x - s1.p1.x) * d2.y - (s2.p1.y - s1.p1.y) * d2.x) / denom;
  const u = ((s2.p1.x - s1.p1.x) * d1.y - (s2.p1.y - s1.p1.y) * d1.x) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return add(s1.p1, scale(d1, t));
}

/** Пересечение бесконечных прямых (для удлинения соседних стен). */
export function lineIntersection(s1: Segment, s2: Segment): Point | null {
  const d1 = sub(s1.p2, s1.p1);
  const d2 = sub(s2.p2, s2.p1);
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < EPS) return null;
  const t = ((s2.p1.x - s1.p1.x) * d2.y - (s2.p1.y - s1.p1.y) * d2.x) / denom;
  return add(s1.p1, scale(d1, t));
}

/** Ближайшая точка на отрезке и параметр t (0..1). */
export function closestPoint(seg: Segment, p: Point): { point: Point; t: number } {
  const d = sub(seg.p2, seg.p1);
  const len2 = d.x * d.x + d.y * d.y;
  if (len2 < EPS) return { point: { ...seg.p1 }, t: 0 };
  const t = Math.max(0, Math.min(1, ((p.x - seg.p1.x) * d.x + (p.y - seg.p1.y) * d.y) / len2));
  return { point: add(seg.p1, scale(d, t)), t };
}

/** Лежит ли точка на отрезке с допуском. */
export function pointOnSegment(seg: Segment, p: Point, tolerance = 1e-6): boolean {
  const { point, t } = closestPoint(seg, p);
  return t >= -EPS && t <= 1 + EPS && dist(point, p) <= tolerance;
}

/** Проекция точки на ось отрезка: длина от p1 до проекции. */
export function projectionLength(seg: Segment, p: Point): number {
  const { t } = closestPoint(seg, p);
  return t * dist(seg.p1, seg.p2);
}

// ---------- Полигон ----------

export type Polygon = Point[];

/** Площадь полигона (модуль), по формуле шнурования. */
export function polygonArea(poly: Polygon): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Знаковая площадь: > 0 — обход по часовой стрелке при Y вниз. */
export function polygonSignedArea(poly: Polygon): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function polygonPerimeter(poly: Polygon): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    sum += dist(poly[i]!, poly[(i + 1) % poly.length]!);
  }
  return sum;
}

/** Принадлежность точки полигону (ray casting, с допуском на границе). */
export function pointInPolygon(poly: Polygon, p: Point, tolerance = 1e-9): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    if (pointOnSegment({ p1: poly[i]!, p2: poly[(i + 1) % n]! }, p, tolerance)) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i]!.x;
    const yi = poly[i]!.y;
    const xj = poly[j]!.x;
    const yj = poly[j]!.y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Смещение линии (отрезка) на величину offset перпендикулярно, влево по ходу p1→p2
 * при положительном offset (Y вниз).
 */
export function offsetSegment(seg: Segment, offset: number): Segment {
  const d = sub(seg.p2, seg.p1);
  const n = leftNormal(d.x, d.y);
  return {
    p1: add(seg.p1, scale(n, offset)),
    p2: add(seg.p2, scale(n, offset)),
  };
}

/** Точка на отрезке на заданном расстоянии от p1. */
export function pointAtLength(seg: Segment, at: number): Point {
  const len = dist(seg.p1, seg.p2);
  if (len < EPS) return { ...seg.p1 };
  const t = Math.max(0, Math.min(1, at / len));
  return add(seg.p1, scale(sub(seg.p2, seg.p1), t));
}

/** Точка по центру и половине ширины вдоль оси отрезка. */
export function pointsAroundCenter(seg: Segment, center: Point, halfWidth: number): { p1: Point; p2: Point } {
  const dir = sub(seg.p2, seg.p1);
  const len = Math.hypot(dir.x, dir.y);
  if (len < EPS) return { p1: { ...center }, p2: { ...center } };
  const ux = dir.x / len;
  const uy = dir.y / len;
  return {
    p1: { x: center.x - ux * halfWidth, y: center.y - uy * halfWidth },
    p2: { x: center.x + ux * halfWidth, y: center.y + uy * halfWidth },
  };
}

/** Пересекаются ли отрезки (включая касание). */
export function segmentsCross(s1: Segment, s2: Segment): boolean {
  return segmentIntersection(s1, s2) !== null;
}

/** Обход полигона по часовой стрелке (Y вниз)? */
export function isClockwise(poly: Polygon): boolean {
  return polygonSignedArea(poly) > 0;
}

/**
 * Полигон целиком внутри полигона (ревью 68 №2): все вершины внутри/на границе,
 * плюс каждое ребро внутреннего полигона разбивается точками пересечения с рёбрами
 * внешнего (включая касания в вершинах и коллинеарные наложения) — середина каждого
 * интервала должна быть внутри/на границе. Проверка середин ловит проход ребра через
 * вершину вогнутой комнаты наружу: пересечение в вершине само по себе не исключается
 * (касание изнутри законно), но за вершиной интервалы вне комнаты дают отказ.
 * Общий предикат контуров: проёмы в полу (floorhole), тёплый пол (climate).
 */
export function polygonInsidePolygon(inner: Polygon, outer: Polygon): boolean {
  for (const v of inner) {
    if (!pointInPolygon(outer, v)) return false;
  }
  const T_EPS = 1e-9;
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i]!;
    const b = inner[(i + 1) % inner.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const edge: Segment = { p1: a, p2: b };
    // параметр точки p на ребре (ребро невырожденное — размеры проверены)
    const tOf = (p: Point): number => (Math.abs(dx) >= Math.abs(dy) ? (p.x - a.x) / dx : (p.y - a.y) / dy);
    const ts: number[] = [0, 1];
    for (let j = 0; j < outer.length; j++) {
      const roomEdge: Segment = { p1: outer[j]!, p2: outer[(j + 1) % outer.length]! };
      const p = lineIntersection(edge, roomEdge);
      if (p) {
        const t = tOf(p);
        if (t > T_EPS && t < 1 - T_EPS && pointOnSegment(roomEdge, p, 1e-6)) ts.push(t);
      } else {
        // параллельны: коллинеарная накладка — концы ребра комнаты на ребре проёма
        for (const q of [roomEdge.p1, roomEdge.p2]) {
          if (!pointOnSegment(edge, q, 1e-6)) continue;
          const t = tOf(q);
          if (t > T_EPS && t < 1 - T_EPS) ts.push(t);
        }
      }
    }
    ts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1]! - ts[k]! < T_EPS) continue;
      const mid = { x: a.x + (dx * (ts[k]! + ts[k + 1]!)) / 2, y: a.y + (dy * (ts[k]! + ts[k + 1]!)) / 2 };
      if (!pointInPolygon(outer, mid)) return false;
    }
  }
  return true;
}

/**
 * Площадь пересечения двух полигонов, см² (Sutherland–Hodgman: subject режется
 * внутренностью clip; clip ожидается выпуклым — тело стены, прямоугольник колонны).
 * Касание даёт ~0.
 */
export function overlapArea(subject: Polygon, clip: Polygon): number {
  let out = subject;
  const sign = polygonSignedArea(clip) >= 0 ? 1 : -1;
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const side = (p: Point): number => sign * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j]!;
      const prev = input[(j + input.length - 1) % input.length]!;
      const curIn = side(cur) >= -1e-9;
      const prevIn = side(prev) >= -1e-9;
      if (curIn !== prevIn) {
        const isect = lineIntersection({ p1: prev, p2: cur }, { p1: a, p2: b });
        if (isect) out.push(isect);
      }
      if (curIn) out.push(cur);
    }
  }
  return polygonArea(out);
}
