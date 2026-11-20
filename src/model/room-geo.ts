import type { Point } from "./types.ts";
import { roundTenthMm as r2 } from "./units.ts";

// Общая геометрия комнат для сверок по каноническому контуру (этап 260):
// вынесено из src/model/finish.ts, чтобы модули-сверки (finish, zone, rooms-save)
// не импортировали друг друга (сторож runtime-циклов, этап 181-c3b).

export const ROOM_COORD_TOL = 0.5; // см: допуск сравнения вершин/границ
export const ROOM_COLLINEAR_TOL = 0.5; // см: вершина на хорде ближе этого — коллинеарная

export function signedArea(poly: Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function distToChord(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len = Math.hypot(abx, aby);
  if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * aby - (p.y - a.y) * abx) / len;
}

export function removeCollinear(poly: Point[]): Point[] {
  let pts = [...poly];
  for (let pass = 0; pass < 2; pass++) {
    const kept: Point[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n]!, next = pts[(i + 1) % n]!;
      if (distToChord(pts[i]!, prev, next) > ROOM_COLLINEAR_TOL) kept.push(pts[i]!);
    }
    pts = kept;
  }
  return pts;
}

/**
 * Каноническая форма контура: без дубликатов и коллинеарных вершин, против часовой
 * стрелки, начиная с лексикографически минимальной вершины. Один и тот же контур
 * с любым стартовым ребром, направлением и лишними точками на прямых даёт одну форму.
 */
export function canonicalPolygon(poly: Point[] | undefined): Point[] | null {
  if (!poly || poly.length < 3) return null;
  let pts: Point[] = [];
  for (const p of poly) {
    const q = { x: r2(p.x), y: r2(p.y) };
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last.x - q.x) > 1e-9 || Math.abs(last.y - q.y) > 1e-9) pts.push(q);
  }
  if (pts.length > 1) {
    const first = pts[0]!, last = pts[pts.length - 1]!;
    if (Math.abs(first.x - last.x) <= 1e-9 && Math.abs(first.y - last.y) <= 1e-9) pts.pop();
  }
  pts = removeCollinear(pts);
  if (pts.length < 3) return null;
  if (signedArea(pts) < 0) pts = [...pts].reverse();
  let mi = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i]!, b = pts[mi]!;
    if (a.x < b.x - 1e-9 || (Math.abs(a.x - b.x) <= 1e-9 && a.y < b.y - 1e-9)) mi = i;
  }
  return [...pts.slice(mi), ...pts.slice(0, mi)];
}

export function polygonsEqual(a: Point[] | undefined, b: Point[] | undefined): boolean {
  const ca = canonicalPolygon(a), cb = canonicalPolygon(b);
  if (!ca || !cb || ca.length !== cb.length) return false;
  return ca.every((p, i) => Math.abs(p.x - cb[i]!.x) <= ROOM_COORD_TOL && Math.abs(p.y - cb[i]!.y) <= ROOM_COORD_TOL);
}

export function polygonArea(poly: Point[] | undefined): number {
  if (!poly || poly.length < 3) return 0;
  return Math.abs(signedArea(poly));
}

type GeoRoomRec = { polygon?: Point[]; points?: Point[]; [key: string]: unknown };

function roomPolygon(room: GeoRoomRec): Point[] | undefined {
  return (room.polygon ?? room.points) as Point[] | undefined;
}

/** Комнаты модели (rooms2 ?? rooms1) — общий слой сверов (упрощение ревью 263). */
export function roomsMapOf(
  model: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return ((model?.["rooms2"] ?? model?.["rooms1"]) ?? undefined) as Record<string, unknown> | undefined;
}

/** Полигон комнаты записи (polygon ?? points) — для сопоставления по каноническому контуру. */
export function roomPolygonOf(room: unknown): Point[] | undefined {
  return roomPolygon((room ?? {}) as GeoRoomRec);
}

/**
 * Сопоставление комнат по каноническому контуру (ревью 95 R1): ID — только подсказка,
 * проверенная геометрией. Общий слой для сверки отделки, зон потолка и сверки комнат
 * при save (этап 126) — не дублируется.
 */
export function matchRoomsByContour(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
): { pairs: Map<string, string>; matchedGot: Set<string> } {
  const exp = (expectedRooms ?? {}) as Record<string, GeoRoomRec>;
  const got = (gotRooms ?? {}) as Record<string, GeoRoomRec>;
  const pairs = new Map<string, string>();
  const matchedGot = new Set<string>();
  for (const [rid, room] of Object.entries(exp)) {
    const cand = got[rid];
    if (cand && polygonsEqual(roomPolygon(room), roomPolygon(cand))) {
      pairs.set(rid, rid);
      matchedGot.add(rid);
    }
  }
  for (const [rid, room] of Object.entries(exp)) {
    if (pairs.has(rid)) continue;
    const found = Object.keys(got).find((k) => !matchedGot.has(k) && polygonsEqual(roomPolygon(room), roomPolygon(got[k]!)));
    if (found) {
      pairs.set(rid, found);
      matchedGot.add(found);
    }
  }
  return { pairs, matchedGot };
}

const SPLIT_MIN = 0.3; // доля ожидаемой комнаты в комнате-кандидате при split/merge
export { SPLIT_MIN };
const PART_SHARE_MIN = 0.5; // доля части внутри ожидаемой комнаты: комната-«часть» split (эталон 98)

/**
 * Доля площади inner, покрытая outer (сетка ~32×32 по bbox inner): сопоставление
 * при split/merge, когда контуры не равны.
 */
export function overlapShare(inner: Point[], outer: Point[]): number {
  const area = polygonArea(inner);
  if (area <= 1e-9) return 0;
  const xs = inner.map((p) => p.x), ys = inner.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const step = Math.max(Math.sqrt(area / 900), 1e-6);
  let total = 0, hit = 0;
  for (let x = x0 + step / 2; x < x1; x += step) {
    for (let y = y0 + step / 2; y < y1; y += step) {
      const p = { x, y };
      if (!pointInside(p, inner)) continue;
      total++;
      if (pointInside(p, outer)) hit++;
    }
  }
  return total > 0 ? hit / total : 0;
}

/** Расстояние от точки до отрезка (перпендикуляр вне отрезка — до ближайшего конца), см. */
export function distToSeg(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x, vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  let q: Point;
  if (l2 < 1e-12) {
    q = a;
  } else {
    const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2;
    q = t <= 0 ? a : t >= 1 ? b : { x: a.x + t * vx, y: a.y + t * vy };
  }
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/**
 * Точка внутри полигона или на его границе в допуске tolCm см (общий помощник
 * сверов — отделка ч.2 rev 246 №5 nearRoom, зоны потолка 260, overlapShare):
 * ray-casting, промах проверяется расстоянием до рёбер.
 */
export function pointInPolygon(p: Point, poly: Point[], tolCm = 0): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  if (inside || tolCm <= 0) return inside;
  for (let i = 0; i < poly.length; i++) {
    if (distToSeg(p, poly[i]!, poly[(i + 1) % poly.length]!) <= tolCm) return true;
  }
  return false;
}

function pointInside(p: Point, poly: Point[]): boolean {
  return pointInPolygon(p, poly);
}

export type RoomHeir = { key: string; kind: "split" | "merge" | "same"; partKeys: string[] } | null;

/** Режим сверок по комнатам: «normalize» — до записи (штатная топология редактора),
 *  «save» — после записи по GET (строго). */
export type RoomCompareMode = "normalize" | "save";

/**
 * Классификация наследников при изменившейся топологии (только режим normalize).
 * Изменение контура — ещё не смена топологии (ревью 100 N4/N5): классификация по
 * площадям. split доказан несколькими комнатами результата, merge — несколькими
 * реальными источниками; иначе (перенос стены, деформация, расширение одной комнаты) —
 * та же комната с новой геометрией, строгая проверка без послаблений.
 */
export function roomHeirs(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
  exact: Map<string, string>,
  mode: RoomCompareMode = "normalize",
): Map<string, RoomHeir> {
  const exp = (expectedRooms ?? {}) as Record<string, GeoRoomRec>;
  const got = (gotRooms ?? {}) as Record<string, GeoRoomRec>;
  const gotKeys = Object.keys(got);
  const unmatchedExp = Object.keys(exp).filter((rid) => !exact.has(rid));
  const heirOf = new Map<string, RoomHeir>();
  if (mode !== "normalize") return heirOf;
  for (const rid of unmatchedExp) {
    const room = exp[rid]!;
    const poly = roomPolygon(room);
    let best: { key: string; shareExp: number } | null = null;
    for (const k of gotKeys) {
      const shareExp = overlapShare(poly ?? [], roomPolygon(got[k]!) ?? []);
      if (shareExp < SPLIT_MIN) continue;
      if (!best || shareExp > best.shareExp) best = { key: k, shareExp };
    }
    if (!best) { heirOf.set(rid, null); continue; }
    // комнаты результата, в основном лежащие внутри исходной (эталон 98: split)
    const partKeys = Object.keys(got).filter((k) => {
      const gp = roomPolygon(got[k]!) ?? [];
      return polygonArea(gp) > 1e-9 && overlapShare(gp, poly ?? []) >= PART_SHARE_MIN;
    });
    if (partKeys.length >= 2) {
      heirOf.set(rid, { key: best.key, kind: "split", partKeys });
      continue;
    }
    const sources = unmatchedExp.filter((s) =>
      overlapShare(roomPolygon(exp[s]!) ?? [], roomPolygon(got[best!.key]!) ?? []) >= SPLIT_MIN,
    );
    heirOf.set(rid, { key: best.key, kind: sources.length >= 2 ? "merge" : "same", partKeys: [] });
  }
  return heirOf;
}

/** Рёбра полигона в формате записей редактора (p1/p2/середина/длина, 0.01 см) —
 *  общий помощник зон потолка (ревью 313 C: используется и setCeilingFinish). */
export function polygonEdgesOf(poly: Point[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i]!, p2 = poly[(i + 1) % poly.length]!;
    out.push({
      p1: { x: Math.round(p1.x * 100) / 100, y: Math.round(p1.y * 100) / 100 },
      p2: { x: Math.round(p2.x * 100) / 100, y: Math.round(p2.y * 100) / 100 },
      c: { x: Math.round(((p1.x + p2.x) / 2) * 100) / 100, y: Math.round(((p1.y + p2.y) / 2) * 100) / 100 },
      length: Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y) * 100) / 100,
    });
  }
  return out;
}
