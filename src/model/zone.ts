import type { Model, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, cmToMm } from "./units.ts";
import { McpError } from "../errors.ts";
import { roomPolygonOf, matchRoomsByContour, roomHeirs, pointInPolygon } from "./room-geo.ts";

// Зонирование потолка (лист «Потолки», инструмент «Зонировать потолок», zone_ceiling;
// PRO; этап 260, 2026-11-20). Разделители зон — линии-графы ZoneDelimiter extends
// GraphLines (бандл app.3.0, класс ZoneDelimitering), хранятся редактором ВЕРХНЕУРОВНЕВО
// в model.zone_delimiters (project.copy("server"): o.zone_delimiters=ZONE_DELIMITERS.copy();
// restore: ZONE_DELIMITERS.restore(e.zone_delimiters)). Per-room rooms2[rid].delimiters —
// legacy-хранилище: Rooms2.patch при restore мигрирует его в runtime (с миграцией типов
// d_*→zone_*), поэтому per-room используется только на чтение старых моделей.
// Формат записи — эталон scripts/probes/260-zone-serialize.ts +
// tests/fixtures/ui-ref-ceilzone-delimiter.json:
//   {id, matrix ([[null,{length:1}],[{length:1},null]]), vertexes [{id, point (см), type:"node"}],
//    items {vertexId:"node"}, type "zone_ceiling", length (м, 2 знака), id_room,
//    plan "ceiling", on_size 1}
// Привязка узлов (zone: ребро комнаты type "room" или ригель type "rigel") — производное
// редактора: calc() при restore пересчитывает её по геометрии (isPointOnLine), в MCP-запись
// не пишется. В API — мм; формат редактора в публичный слой не протекает.
//
// Стандарт редактора (пробы 260-zone-ui*): линия строится внутри одной комнаты
// от одной внешней стены до другой (обе точки — на рёбрах комнаты в 15 см магнитом
// или на гранях потолочных ригелей в 10 см); линия не пересекает стены, колонны,
// другие разделители комнаты и ригели/потолочные закладные; концы не внутри ригеля.

export type ZoneDelimiterRec = {
  id: string;
  matrix: ({ length: number } | null)[][];
  vertexes: Array<{ id: string; point: Point; type: string; zone?: Record<string, unknown> }>;
  items: Record<string, string>;
  type: string;
  /** Длина линии, м (сумма рёбер, округление редактора до 2 знаков). */
  length: number;
  id_room: string;
  plan: string;
  on_size?: number;
  [key: string]: unknown;
};

/**
 * Legacy-миграция (convertOld ZoneDelimiter, бандл): типы «d_zone»→«zone_c»,
 * «d_*»→«zone_*»; старая форма points:[p1,p2] без vertexes разворачивается в
 * граф из двух узлов (restore 260). Возвращает каноническую запись или исходную.
 */
export function migrateLegacyDelimiter(rec: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(rec);
  const t = String(out["type"] ?? "");
  if (t === "d_zone") out["type"] = "zone_c";
  else if (t.startsWith("d_")) out["type"] = `zone_${t.slice(2)}`;
  if (!Array.isArray(out["vertexes"]) || (out["vertexes"] as unknown[]).length === 0) {
    const points = out["points"] as Array<Point> | undefined;
    if (Array.isArray(points) && points.length >= 2) {
      out["vertexes"] = points.slice(0, 2).map((p, i) => ({ id: `p${i}`, point: p, type: "node" }));
      out["items"] = { ...((out["items"] ?? {}) as Record<string, string>), v0: "node", v1: "node" };
      out["matrix"] = [[null, { length: 1 }], [{ length: 1 }, null]];
    }
  }
  // ревью 261 №6: restore редактора дополняет записи полями on_size 1 и length
  // (м, по геометрии линии) — дописываем их миграции, чтобы старая модель (points-
  // форма, per-room без length/on_size) сверялась с нормализованной в обе стороны
  // и не блокировала save
  const v = (out["vertexes"] ?? []) as Array<{ point?: Point }>;
  if (v.length >= 2 && v[0]?.point && v[v.length - 1]?.point) {
    if (out["on_size"] === undefined) out["on_size"] = 1;
    const len = Number(out["length"] ?? 0);
    if (!(len > 0)) {
      const p1 = v[0]!.point!, p2 = v[v.length - 1]!.point!;
      out["length"] = Math.round((Math.hypot(p2.x - p1.x, p2.y - p1.y) / 100) * 100) / 100;
    }
  }
  return out;
}

type RoomRec = {
  polygon?: Point[];
  edges?: Array<{ p1?: Point; p2?: Point; length?: number; pid?: string; side?: string; room_side?: string }>;
  rigels?: Record<string, { polygon?: Point[]; edges?: Record<string, Array<{ p1?: Point; p2?: Point }>>; [k: string]: unknown }>;
  delimiters?: Record<string, Record<string, unknown>>;
  role?: string;
  [key: string]: unknown;
};

type RoomsMap = Record<string, RoomRec>;

function roomsOf(model: Model): RoomsMap {
  return (model.rooms2 ?? model.rooms1 ?? {}) as RoomsMap;
}

/** Все разделители модели: верхнеуровневое zone_delimiters (серверный формат) +
 *  legacy per-room delimiters (старые модели; редактор мигрирует их при restore).
 *  Ключ — id записи; при коллизии top-level приоритетен. */
function delimiterMapOf(model: Model): Record<string, { rec: Record<string, unknown>; roomKey: string | null }> {
  const out: Record<string, { rec: Record<string, unknown>; roomKey: string | null }> = {};
  const rooms = roomsOf(model);
  for (const [rid, room] of Object.entries(rooms)) {
    for (const [key, raw] of Object.entries((room.delimiters ?? {}) as Record<string, Record<string, unknown>>)) {
      out[key] = { rec: raw, roomKey: rid };
    }
  }
  for (const [key, raw] of Object.entries((model.zone_delimiters ?? {}) as Record<string, Record<string, unknown>>)) {
    out[key] = { rec: raw, roomKey: String(raw["id_room"] ?? "") || null };
  }
  return out;
}

function roomByRef(model: Model, ref: string): { id: string; room: RoomRec } {
  const rooms = roomsOf(model);
  if (rooms[ref]) return { id: ref, room: rooms[ref]! };
  const m = /^R(\d+)$/.exec(ref);
  if (m) {
    const found = Object.entries(rooms)[Number(m[1]) - 1];
    if (found) return { id: found[0], room: found[1] as RoomRec };
  }
  throw new McpError("NOT_FOUND", `комната ${ref} не найдена`);
}

// ---------- Геометрия (см) ----------

const EPS = 1e-9;

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function segLen(a: Point, b: Point): number {
  return dist(a, b);
}

/** Проекция точки на отрезок; null — перпендикуляр вне отрезка. */
function projOnSeg(p: Point, a: Point, b: Point): Point | null {
  const vx = b.x - a.x, vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  if (l2 < EPS) return null;
  const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2;
  if (t < -1e-6 || t > 1 + 1e-6) return null;
  return { x: a.x + t * vx, y: a.y + t * vy };
}

/** Расстояние от точки до отрезка (перпендикуляр вне отрезка — до ближайшего конца). */
function distToSeg(p: Point, a: Point, b: Point): number {
  const q = projOnSeg(p, a, b) ?? (dist(p, a) < dist(p, b) ? a : b);
  return dist(p, q);
}

/** Пересечение отрезков ненулевой длины (как LIB.crossLine: общая точка-касание не считается). */
function segsCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d = (o: Point, p: Point, q: Point) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = d(a1, a2, b1), d2 = d(a1, a2, b2), d3 = d(b1, b2, a1), d4 = d(b1, b2, a2);
  if (((d1 > EPS) !== (d2 > EPS)) && ((d3 > EPS) !== (d4 > EPS))) return true;
  return false;
}

// ---------- Лимиты (пробы 260: магниты UI) ----------

export const ZONE_LIMITS = {
  /** Магнит конца к ребру комнаты, см (mousedown: t=15). */
  edgeSnapCm: 15,
  /** Магнит конца к грани ригеля, см (mousedown: s=10). */
  rigelSnapCm: 10,
  /** Минимальная длина линии, мм (вырожденные линии редактор не создаёт). */
  minLineMm: 100,
} as const;

/** Потолочные ригели, чьи грани проходят внутри комнаты: глобальные (model.rigels,
 *  центр полигона в комнате) + закладные комнаты (rooms2[rid].rigels). */
function roomRigels(model: Model, roomId: string, room: RoomRec): Array<{ id: string; edges: Array<{ p1: Point; p2: Point }>; polygon: Point[] }> {
  const out: Array<{ id: string; edges: Array<{ p1: Point; p2: Point }>; polygon: Point[] }> = [];
  const push = (id: string, rec: { polygon?: Point[]; edges?: Record<string, Array<{ p1?: Point; p2?: Point }>> }) => {
    const poly = rec.polygon;
    if (!poly || poly.length < 3) return;
    const edges: Array<{ p1: Point; p2: Point }> = [];
    const eds = rec.edges ?? {};
    for (const side of Object.keys(eds)) {
      for (const e of eds[side] ?? []) {
        if (e.p1 && e.p2) edges.push({ p1: e.p1, p2: e.p2 });
      }
    }
    if (edges.length === 0) {
      for (let i = 0; i < poly.length; i++) edges.push({ p1: poly[i]!, p2: poly[(i + 1) % poly.length]! });
    }
    out.push({ id, edges, polygon: poly });
  };
  for (const [id, r] of Object.entries((model.rigels ?? {}) as Record<string, { polygon?: Point[]; edges?: Record<string, Array<{ p1?: Point; p2?: Point }>> }>)) {
    const c = r.polygon ? { x: r.polygon.reduce((s, p) => s + p.x, 0) / r.polygon.length, y: r.polygon.reduce((s, p) => s + p.y, 0) / r.polygon.length } : null;
    const poly = room.polygon;
    if (c && poly && pointInPolygon(c, poly)) push(id, r);
  }
  for (const [id, r] of Object.entries(room.rigels ?? {})) push(id, r as { polygon?: Point[]; edges?: Record<string, Array<{ p1?: Point; p2?: Point }>> });
  return out;
}

type Snap = { point: Point; kind: "room" | "rigel"; edgeIndex: number; pid?: string; side?: string; rigelId?: string };

/** Магнит конца линии: ближайшее ребро комнаты (≤15 см) или грань ригеля (≤10 см). */
function snapEndpoint(model: Model, roomId: string, room: RoomRec, p: Point): Snap | null {
  let best: { snap: Snap; d: number } | null = null;
  const edges = Array.isArray(room.edges) ? room.edges : [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (!e.p1 || !e.p2) continue;
    const q = projOnSeg(p, e.p1, e.p2);
    if (!q) continue;
    const d = dist(p, q);
    if (d <= ZONE_LIMITS.edgeSnapCm && (!best || d < best.d)) {
      best = { snap: { point: q, kind: "room", edgeIndex: i, pid: e.pid, side: e.side }, d };
    }
  }
  for (const rg of roomRigels(model, roomId, room)) {
    for (const e of rg.edges) {
      const q = projOnSeg(p, e.p1, e.p2);
      if (!q) continue;
      const d = dist(p, q);
      if (d <= ZONE_LIMITS.rigelSnapCm && (!best || d < best.d)) {
        best = { snap: { point: q, kind: "rigel", edgeIndex: -1, rigelId: rg.id }, d };
      }
    }
  }
  return best?.snap ?? null;
}

/** Другие разделители комнаты (линии для проверки пересечений): общий слой
 *  delimiterMapOf — верхнеуровневое zone_delimiters (ревью 261 №1: после e47382a
 *  запись идёт туда) + legacy per-room. */
function roomDelimiterLines(model: Model, roomId: string, exceptId?: string): Array<{ id: string; p1: Point; p2: Point }> {
  const out: Array<{ id: string; p1: Point; p2: Point }> = [];
  for (const [id, entry] of Object.entries(delimiterMapOf(model))) {
    if (id === exceptId || entry.roomKey !== roomId) continue;
    const rec = migrateLegacyDelimiter(entry.rec);
    const v = (rec["vertexes"] ?? []) as Array<{ point?: Point }>;
    const q1 = v[0]?.point, q2 = v[v.length - 1]?.point;
    if (v.length >= 2 && q1 && q2) {
      out.push({ id, p1: q1, p2: q2 });
    }
  }
  return out;
}

/** Точка строго внутри полигона: на границе в допуске 0.05 см (грань ригеля,
 *  куда магнитится конец линии) — не внутри (ревью 261 №3: ray-casting считает
 *  точку на левой/нижней грани внутренней). */
function strictlyInside(p: Point, poly: Point[]): boolean {
  if (!pointInPolygon(p, poly)) return false;
  for (let i = 0; i < poly.length; i++) {
    if (distToSeg(p, poly[i]!, poly[(i + 1) % poly.length]!) <= 0.05) return false;
  }
  return true;
}

/** Ревью 261 №2: линия обязана лежать внутри комнаты. Общий предикат вложенности
 *  (как в отделке ч.2 — pointInPolygon с допуском): середина и контрольные точки
 *  отрезка внутри полигона (концы на рёбрах — на границе в допуске магнита),
 *  пересечений рёбер вне концов нет, включая касание в вершине вогнутого контура
 *  (хорда через выемку проходит мимо комнаты — отвергается). */
function segmentInsidePolygon(a: Point, b: Point, poly: Point[], tolCm = 0.5): boolean {
  const len = segLen(a, b);
  const steps = Math.max(2, Math.ceil(len / 25) + 1);
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    if (!pointInPolygon(p, poly, tolCm)) return false;
  }
  return true;
}

/**
 * zone_ceiling_add: линия-разделитель зон потолка в комнате (мм; концы — точки,
 * которые магнитятся к рёбрам комнаты в 150 мм или граням потолочных ригелей
 * в 100 мм, как в UI). Линия обязана лежать внутри одной комнаты и не пересекать
 * стены, колонны, другие разделители комнаты, ригели и потолочные закладные
 * (стандарт редактора, пробы 260-zone-ui*). Атомарно: при отказе delimiters
 * комнаты не меняются.
 */
export function addZoneCeiling(
  model: Model,
  roomRef: string,
  params: { fromMm: Point; toMm: Point },
): { id: string; length_mm: number } {
  const { id: roomId, room } = roomByRef(model, roomRef);
  const poly = roomPolygonOf(room);
  if (!poly || poly.length < 3) throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomRef} нет контура`);
  const from = { x: mmToCm(params.fromMm.x), y: mmToCm(params.fromMm.y) };
  const to = { x: mmToCm(params.toMm.x), y: mmToCm(params.toMm.y) };
  const lenCm = segLen(from, to);
  if (lenCm * 10 < ZONE_LIMITS.minLineMm) {
    throw new McpError("INVALID_ARGUMENT", `длина линии ${Math.round(lenCm * 10)} мм короче минимальной ${ZONE_LIMITS.minLineMm} мм`);
  }
  // магнит концов
  const s1 = snapEndpoint(model, roomId, room, from);
  const s2 = snapEndpoint(model, roomId, room, to);
  if (!s1) throw new McpError("INVALID_ARGUMENT", "from_mm: нет ребра комнаты или грани потолочного ригеля в 150 мм — конец не магнитится");
  if (!s2) throw new McpError("INVALID_ARGUMENT", "to_mm: нет ребра комнаты или грани потолочного ригеля в 100 мм — конец не магнитится");
  // концы на одном ребре комнаты — редактор отвергает (r && A && areLinesEqual)
  if (s1.kind === "room" && s2.kind === "room" && s1.edgeIndex === s2.edgeIndex) {
    throw new McpError("INVALID_ARGUMENT", "оба конца на одном ребре комнаты — проведите линию от одной внешней стены до другой");
  }
  const p1 = s1.point, p2 = s2.point;
  // пересечения с рёбрами комнаты (не в концах; ребро, на котором стоит конец
  // линии, — это примыкание, не пересечение)
  const edges = Array.isArray(room.edges) ? room.edges : [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (!e.p1 || !e.p2) continue;
    if (distToSeg(p1, e.p1, e.p2) <= 0.05 || distToSeg(p2, e.p1, e.p2) <= 0.05) continue;
    if (segsCross(p1, p2, e.p1, e.p2)) {
      throw new McpError("INVALID_ARGUMENT", "линия пересекает ребро/стену комнаты — не пересекайте стены или колонны");
    }
  }
  // колонны
  for (const pillar of Object.values((model.pillars ?? {}) as Record<string, { polygon?: Point[] }>)) {
    const pp = pillar.polygon;
    if (!pp || pp.length < 3) continue;
    for (let i = 0; i < pp.length; i++) {
      if (segsCross(p1, p2, pp[i]!, pp[(i + 1) % pp.length]!)) {
        throw new McpError("INVALID_ARGUMENT", "линия пересекает колонну — не пересекайте стены или колонны");
      }
    }
  }
  // стены: пересечение осей проверять не нужно — рёбра комнаты уже лежат на осях
  // (проверка выше), а «пересекайте стены» в UI относится к рёбрам и колоннам
  // ригели и закладные: концы не внутри полигона ригеля (точка на грани — не
  // внутри, ревью 261 №3); линия не пересекает грани
  const rigels = roomRigels(model, roomId, room);
  for (const rg of rigels) {
    if (strictlyInside(p1, rg.polygon) || strictlyInside(p2, rg.polygon)) {
      throw new McpError("INVALID_ARGUMENT", `конец линии внутри ригеля ${rg.id} — конец должен быть на грани ригеля или ребре комнаты`);
    }
    const attached = s1.rigelId === rg.id || s2.rigelId === rg.id;
    if (attached) continue;
    for (const e of rg.edges) {
      if (segsCross(p1, p2, e.p1, e.p2)) {
        throw new McpError("INVALID_ARGUMENT", "линия пересекает ригель или потолочную закладную — не пересекайте ригели и потолочные закладные");
      }
    }
  }
  // линия внутри комнаты (ревью 261 №2: в вогнутой комнате хорда через выемку —
  // отказ, даже если оба конца легли на рёбра)
  if (!segmentInsidePolygon(p1, p2, poly)) {
    throw new McpError("INVALID_ARGUMENT", "линия проходит вне комнаты — проведите линию внутри одной комнаты от одной внешней стены до другой");
  }
  // другие разделители комнаты (общий узел или касание в точке — соединение, не пересечение)
  for (const other of roomDelimiterLines(model, roomId)) {
    const shared =
      dist(other.p1, p1) <= 0.05 || dist(other.p1, p2) <= 0.05 || dist(other.p2, p1) <= 0.05 || dist(other.p2, p2) <= 0.05 ||
      distToSeg(other.p1, p1, p2) <= 0.05 || distToSeg(other.p2, p1, p2) <= 0.05 ||
      distToSeg(p1, other.p1, other.p2) <= 0.05 || distToSeg(p2, other.p1, other.p2) <= 0.05;
    if (!shared && segsCross(p1, p2, other.p1, other.p2)) {
      throw new McpError("INVALID_ARGUMENT", "линия пересекает другой разделитель этой комнаты — соединяйте разделители в общих узлах");
    }
  }
  // запись (атомарно общим слоем ws.apply) — верхнеуровневое zone_delimiters
  // (как project.copy("server"))
  const vid1 = newId(), vid2 = newId();
  const id = newId();
  const rec: ZoneDelimiterRec = {
    id,
    matrix: [[null, { length: 1 }], [{ length: 1 }, null]],
    vertexes: [
      { id: vid1, point: { x: Math.round(p1.x * 100) / 100, y: Math.round(p1.y * 100) / 100 }, type: "node" },
      { id: vid2, point: { x: Math.round(p2.x * 100) / 100, y: Math.round(p2.y * 100) / 100 }, type: "node" },
    ],
    items: { [vid1]: "node", [vid2]: "node" },
    type: "zone_ceiling",
    length: Math.round((segLen(p1, p2) / 100) * 100) / 100,
    id_room: roomId,
    plan: "ceiling",
    on_size: 1,
  };
  model.zone_delimiters ??= {};
  model.zone_delimiters[id] = rec;
  return { id, length_mm: cmToMm(rec.length * 100) };
}

/**
 * zone_ceiling_remove: удалить разделитель зон потолка по id сайта (из ответа
 * finish_get/zone_ceiling_add) или метке ZD<n> (порядок finish_get комнаты).
 */
export function removeZoneCeiling(model: Model, delimiterRef: string): { room_id: string | null; removed: boolean } {
  const map = delimiterMapOf(model);
  // по ключу хранилища или по id записи (per-room ключ может не совпадать с id)
  const hit = Object.entries(map).find(([k, e]) => k === delimiterRef || String(e.rec["id"] ?? "") === delimiterRef);
  if (hit) {
    const [key, entry] = hit;
    delete model.zone_delimiters?.[key];
    const roomKey = entry.roomKey;
    if (roomKey) {
      const room = roomsOf(model)[roomKey];
      if (room?.delimiters) {
        delete room.delimiters[key];
        if (Object.keys(room.delimiters).length === 0) delete room.delimiters;
      }
    }
    return { room_id: roomKey, removed: true };
  }
  // метка ZD<n>: единый источник меток — zoneDelimiterList (ревью 261 №7:
  // одна нумерация для list/remove/compact, после миграции legacy points-форма
  // тоже нумеруется)
  const m = /^ZD(\d+)$/.exec(delimiterRef);
  if (m) {
    const entry = zoneDelimiterList(model)[Number(m[1]) - 1];
    if (entry && String(entry["id"] ?? "") === delimiterRef && entry["site_id"] !== undefined) {
      return removeZoneCeiling(model, String(entry["site_id"]));
    }
  }
  throw new McpError("NOT_FOUND", `разделитель ${delimiterRef} не найден`);
}

/** Список разделителей для finish_get (мм; метки ZD<n> сквозные по комнатам).
 *  roomRef фильтрует по id сайта или метке R<n> (как finishList). */
export function zoneDelimiterList(model: Model, roomRef?: string): Array<Record<string, unknown>> {
  const rooms = roomsOf(model);
  const allKeys = Object.keys(rooms);
  const wanted = roomRef
    ? new Set(allKeys.filter((rid) => rid === roomRef || `R${allKeys.indexOf(rid) + 1}` === roomRef))
    : null;
  const out: Array<Record<string, unknown>> = [];
  let n = 0;
  for (const [key, entry] of Object.entries(delimiterMapOf(model))) {
    const rid = entry.roomKey ?? "";
    if (wanted && !wanted.has(rid)) continue;
    const rec = migrateLegacyDelimiter(entry.rec);
    const v = (rec["vertexes"] ?? []) as Array<{ point?: Point }>;
    const p1 = v[0]?.point, p2 = v[v.length - 1]?.point;
    if (!p1 || !p2) continue;
    n += 1;
    out.push({
      id: `ZD${n}`,
      site_id: rec["id"] ?? key,
      room_id: rid,
      type: rec["type"] ?? "",
      plan: rec["plan"] ?? "",
      from_mm: [cmToMm(p1.x), cmToMm(p1.y)],
      to_mm: [cmToMm(p2.x), cmToMm(p2.y)],
      length_mm: cmToMm((Number(rec["length"]) ?? 0) * 100),
      ...(rec["on_size"] !== undefined ? { on_size: rec["on_size"] } : {}),
    });
  }
  return out;
}

// ---------- Семантическая сверка ----------

export type ZoneDelimiterSig = {
  key: string;
  p1: Point;
  p2: Point;
  type: string;
  plan: string;
  idRoom: string;
  length: number;
  onSize: number | undefined;
  /** Полная проекция графа (ревью 261 №4): все вершины по порядку, рёбра матрицы
   *  (i<j, длина) и items (типы узлов, устойчиво к перестановке ключей). */
  vertexes: Point[];
  vertexTypes: string[];
  matrixEdges: Array<{ i: number; j: number; length: number }>;
  itemTypes: string[];
};

/** Сигнатуры разделителей модели (top-level zone_delimiters + legacy per-room). */
function delimiterSigsOf(model: Record<string, unknown> | undefined): ZoneDelimiterSig[] {
  const out: ZoneDelimiterSig[] = [];
  const map = delimiterMapOf((model ?? {}) as Model);
  for (const [key, entry] of Object.entries(map)) {
    const rec = migrateLegacyDelimiter(entry.rec);
    const v = (rec["vertexes"] ?? []) as Array<{ point?: Point; type?: string }>;
    const q1 = v[0]?.point, q2 = v[v.length - 1]?.point;
    if (v.length < 2 || !q1 || !q2) continue;
    const n = v.length;
    const matrix = (rec["matrix"] ?? []) as Array<Array<{ length?: number } | null>>;
    const matrixEdges: Array<{ i: number; j: number; length: number }> = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const cell = matrix[i]?.[j] ?? matrix[j]?.[i];
        if (cell && Number(cell.length) > 0) matrixEdges.push({ i, j, length: Number(cell.length) });
      }
    }
    const items = (rec["items"] ?? {}) as Record<string, string>;
    out.push({
      key,
      p1: q1,
      p2: q2,
      type: String(rec["type"] ?? ""),
      plan: String(rec["plan"] ?? ""),
      idRoom: String(rec["id_room"] ?? entry.roomKey ?? ""),
      length: Number(rec["length"] ?? 0),
      onSize: rec["on_size"] === undefined ? undefined : Number(rec["on_size"]),
      vertexes: v.map((x) => x.point!).filter(Boolean),
      vertexTypes: v.map((x) => String(x.type ?? "")).sort(),
      matrixEdges,
      itemTypes: Object.values(items).map(String).sort(),
    });
  }
  return out;
}

const COORD_TOL_CM = 1;
const LENGTH_TOL_M = 0.02;

function samePointTol(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= COORD_TOL_CM && Math.abs(a.y - b.y) <= COORD_TOL_CM;
}

/** Полная проекция графа совпадает (ревью 261 №4): вершины по порядку (fwd или
 *  обратному), число и состав вершин, рёбра матрицы в обе стороны, items
 *  (мультимножество типов узлов — устойчиво к перестановке ключей). */
function sameGraph(a: ZoneDelimiterSig, b: ZoneDelimiterSig, fwd: boolean): boolean {
  if (a.vertexes.length !== b.vertexes.length) return false;
  const n = a.vertexes.length;
  for (let i = 0; i < n; i++) {
    if (!samePointTol(a.vertexes[i]!, b.vertexes[fwd ? i : n - 1 - i]!)) return false;
  }
  if (JSON.stringify(a.vertexTypes) !== JSON.stringify(b.vertexTypes)) return false;
  if (a.matrixEdges.length !== b.matrixEdges.length) return false;
  const edgeKey = (e: { i: number; j: number; length: number }): string => {
    const i = fwd ? e.i : n - 1 - e.i;
    const j = fwd ? e.j : n - 1 - e.j;
    return `${Math.min(i, j)}-${Math.max(i, j)}:${Math.round(e.length * 100) / 100}`;
  };
  const canon = (sig: ZoneDelimiterSig): string[] => sig.matrixEdges.map(edgeKey).sort();
  if (JSON.stringify(canon(a)) !== JSON.stringify(canon(b))) return false;
  if (JSON.stringify(a.itemTypes) !== JSON.stringify(b.itemTypes)) return false;
  return true;
}

function sameSig(a: ZoneDelimiterSig, b: ZoneDelimiterSig): boolean {
  const fwd = samePointTol(a.p1, b.p1) && samePointTol(a.p2, b.p2);
  const rev = samePointTol(a.p1, b.p2) && samePointTol(a.p2, b.p1);
  if (!fwd && !rev) return false;
  if (a.type !== b.type || a.plan !== b.plan) return false;
  if (Math.abs(a.length - b.length) > LENGTH_TOL_M) return false;
  if (a.onSize !== b.onSize) return false;
  return sameGraph(a, b, fwd);
}

export type ZoneCompareMode = "normalize" | "save";

export type ZoneCompareOpts = {
  /** Комнаты ожидания, затронутые изменёнными пользователем стенами
   *  (ревью 261 №5): их исчезновение при нормализации — штатный случай
   *  (ревью 127), делитель при этом не «потеря». Только режим normalize. */
  affectedRooms?: Set<string>;
};

/**
 * Сверка разделителей зон по комнатам (сопоставление комнат по каноническому
 * контуру и наследникам топологии — room-geo, как finishCompare). Совпадающая
 * комната — строгая сверка (геометрия, тип, план, длина, on_size, полная
 * проекция графа — ревью 261 №4). Топология (split/merge) в режиме normalize:
 * делитель, переживший разрез/слияние по геометрии середины, — норма; пропажа
 * при смене топологии — проблема; комната, затронутая изменёнными стенами,
 * исчезнувшая при нормализации, — предупреждение с подсказкой (ревью 261 №5);
 * в режиме save — строго (все расхождения — проблемы).
 */
export function zoneDelimiterCompare(
  expectedModel: Record<string, unknown> | undefined,
  gotModel: Record<string, unknown> | undefined,
  mode: ZoneCompareMode = "normalize",
  opts: ZoneCompareOpts = {},
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const exp = delimiterSigsOf(expectedModel);
  const got = delimiterSigsOf(gotModel);
  const expectedRooms = ((expectedModel ?? {}) as { rooms2?: Record<string, unknown>; rooms1?: Record<string, unknown> }).rooms2 ?? ((expectedModel ?? {}) as { rooms1?: Record<string, unknown> }).rooms1;
  const gotRooms = ((gotModel ?? {}) as { rooms2?: Record<string, unknown>; rooms1?: Record<string, unknown> }).rooms2 ?? ((gotModel ?? {}) as { rooms1?: Record<string, unknown> }).rooms1;
  const { pairs: exact } = matchRoomsByContour(expectedRooms, gotRooms);
  const heirOf = roomHeirs(expectedRooms, gotRooms, exact, mode);
  const gotByRoom = new Map<string, ZoneDelimiterSig[]>();
  for (const g of got) {
    const list = gotByRoom.get(g.idRoom) ?? [];
    list.push(g);
    gotByRoom.set(g.idRoom, list);
  }
  const polygonOf = (key: string): Point[] | undefined => roomPolygonOf((gotRooms ?? {})[key]);
  const sameOf = (rid: string): string | undefined => {
    const h = heirOf.get(rid);
    return h && h.kind === "same" ? h.key : undefined;
  };
  const midpoint = (e: ZoneDelimiterSig): Point => ({ x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 });
  const used = new Set<string>();
  for (const e of exp) {
    const gid = exact.get(e.idRoom) ?? sameOf(e.idRoom);
    const strictList = (gid ? gotByRoom.get(gid) : undefined) ?? [];
    const found = strictList.filter((g) => !used.has(g.key)).find((g) => sameSig(e, g));
    if (found) {
      used.add(found.key);
      continue;
    }
    const near = strictList.filter((g) => !used.has(g.key)).find((g) => (samePointTol(e.p1, g.p1) && samePointTol(e.p2, g.p2)) || (samePointTol(e.p1, g.p2) && samePointTol(e.p2, g.p1)));
    if (near) {
      problems.push(`room ${e.idRoom}: разделитель ${e.key} изменился на сервере (${JSON.stringify({ type: e.type, plan: e.plan, length: e.length })} → ${JSON.stringify({ type: near.type, plan: near.plan, length: near.length })})`);
      used.add(near.key);
      continue;
    }
    // изменившаяся топология — только в normalize (roomHeirs в save пуст)
    const heir = heirOf.get(e.idRoom) ?? null;
    // ревью 261 №5: комната затронута изменёнными стенами — её исчезновение или
    // перестройка контура при нормализации штатны (ревью 127): разделитель,
    // который редактор сохранил (под той же или другой комнатой), — не потеря;
    // удалённый/перестроенный редактором — предупреждение с подсказкой, не блок
    if (mode === "normalize" && opts.affectedRooms?.has(e.idRoom)) {
      const pool = [...gotByRoom.values()].flat().filter((g) => !used.has(g.key));
      const kept = pool.find((g) => sameSig(e, g)) ??
        pool.find((g) => (samePointTol(e.p1, g.p1) && samePointTol(e.p2, g.p2)) || (samePointTol(e.p1, g.p2) && samePointTol(e.p2, g.p1)));
      if (kept) {
        used.add(kept.key);
        continue;
      }
      warnings.push(`zone_topology_changed: room ${e.idRoom}: комната изменена стенами, редактор не сохранил разделитель зон ${e.key} (${e.type}, ${Math.round(e.length * 100)} см) — при переносе или удалении стен сначала удалите разделители (zone_ceiling_remove)`);
      continue;
    }
    if (!heir) {
      problems.push(`room ${e.idRoom}: потерян разделитель зон потолка ${e.key} (${e.type}, ${Math.round(e.length * 100)} см)`);
      continue;
    }
    const mid = midpoint(e);
    const targetKeys = heir.kind === "split" ? heir.partKeys : [heir.key];
    const inTargets = targetKeys.filter((k) => pointInPolygon(mid, polygonOf(k) ?? [], 0.5));
    if (inTargets.length === 0) {
      problems.push(`room ${e.idRoom}: потерян разделитель зон потолка ${e.key} (${e.type}, ${Math.round(e.length * 100)} см) при ${heir.kind === "split" ? "split" : "merge"}`);
      continue;
    }
    const heirFound = inTargets.flatMap((k) => gotByRoom.get(k) ?? []).filter((g) => !used.has(g.key)).find((g) => sameSig(e, g));
    if (heirFound) {
      used.add(heirFound.key);
      continue;
    }
    // делитель, чья середина внутри комнаты-результата, но запись пропала, —
    // потеря (одно правило: пропажа при split/merge — проблема; предупреждение
    // — только для комнаты, исчезнувшей после изменения стен, выше)
    problems.push(`room ${e.idRoom}: потерян разделитель зон потолка ${e.key} (${e.type}, ${Math.round(e.length * 100)} см) при ${heir.kind === "split" ? "split" : "merge"}`);
  }
  if (mode === "save") {
    for (const g of got) {
      if (!used.has(g.key)) problems.push(`room ${g.idRoom}: неожиданный разделитель ${g.key} на сервере (${g.type}, ${Math.round(g.length * 100)} см)`);
    }
  }
  return { problems, warnings };
}
