import type { Model, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, cmToMm } from "./units.ts";
import { McpError } from "../errors.ts";
import { roomPolygonOf, matchRoomsByContour, overlapShare, roomHeirs, pointInPolygon, roomsMapOf } from "./room-geo.ts";
import { collinearOverlapCm } from "./geometry.ts";

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
 * Типы разделителей зон одного класса ZoneDelimitering (бандл app.3.0: tools
 * zone_c/zone_ceiling/zone_floor/zone_hydroisolation/zone_floor_cap) и план
 * записи = лист, на котором линия нарисована (эталоны 296, проба 296-zone-ui:
 * кнопка на листах отделки одна — plannertool_zone_floor, тип записи задаёт
 * активный лист): zone_ceiling → plan "ceiling" («Потолки»), zone_floor →
 * "floor" («Напольные покрытия»), zone_hydroisolation → "hydroisolation"
 * («Гидроизоляция»), zone_floor_cap → "floor_cap" («Стяжка»). zone_c (лист
 * «Перегородки», getNameZone "c" → zones) имеет собственную семантику
 * зонирования перегородками — вынесен в следующий PR (этап 296, отчёт).
 */
export const ZONE_DELIMITER_PLANS = {
  zone_ceiling: "ceiling",
  zone_floor: "floor",
  zone_hydroisolation: "hydroisolation",
  zone_floor_cap: "floor_cap",
} as const satisfies Record<string, string>;

export type ZoneDelimiterType = keyof typeof ZONE_DELIMITER_PLANS;

/** План записи по типу (ревью 298 №1): редактор восстанавливает legacy-делитель
 *  по типу (restoreTotal: updateZones("ceiling","zone_ceiling")), то есть plan
 *  выводится из type; zone_c (лист «Перегородки») — план "c". */
export function planOfDelimiterType(type: string): string {
  if (type in ZONE_DELIMITER_PLANS) return ZONE_DELIMITER_PLANS[type as ZoneDelimiterType];
  return type === "zone_c" ? "c" : "";
}

/**
 * Legacy-миграция (convertOld ZoneDelimiter, бандл): типы «d_zone»→«zone_c»,
 * «d_*»→«zone_*»; старая форма points:[p1,p2] без vertexes разворачивается в
 * граф из двух узлов (restore 260). Возвращает каноническую запись или исходную.
 * Поля on_size/length дописываются только legacy-записям (points-форма, per-room
 * storage, старый тип d_*) — ревью 263 N3: дописывание верхнеуровневой записи
 * сервера маскирует потерю полей (сверка перестаёт видеть, что сервер потерял
 * on_size или обнулил/удалил length).
 */
export function migrateLegacyDelimiter(
  rec: Record<string, unknown>,
  opts: { legacy?: boolean } = {},
): Record<string, unknown> {
  const out = structuredClone(rec);
  const t = String(out["type"] ?? "");
  const legacyType = t === "d_zone" || t.startsWith("d_");
  if (t === "d_zone") out["type"] = "zone_c";
  else if (t.startsWith("d_")) out["type"] = `zone_${t.slice(2)}`;
  let builtFromPoints = false;
  if (!Array.isArray(out["vertexes"]) || (out["vertexes"] as unknown[]).length === 0) {
    const points = out["points"] as Array<Point> | undefined;
    if (Array.isArray(points) && points.length >= 2) {
      out["vertexes"] = points.slice(0, 2).map((p, i) => ({ id: `p${i}`, point: p, type: "node" }));
      out["items"] = { ...((out["items"] ?? {}) as Record<string, string>), v0: "node", v1: "node" };
      out["matrix"] = [[null, { length: 1 }], [{ length: 1 }, null]];
      builtFromPoints = true;
    }
  }
  // ревью 261 №6: restore редактора дополняет записи полей on_size 1 и length
  // (м, по геометрии линии) — дописываем их миграции, чтобы старая модель (points-
  // форма, per-room без length/on_size) сверялась с нормализованной в обе стороны
  // и не блокировала save. ревью 263 N3: только legacy-записям.
  if (builtFromPoints || legacyType || opts.legacy) {
    const v = (out["vertexes"] ?? []) as Array<{ point?: Point }>;
    if (v.length >= 2 && v[0]?.point && v[v.length - 1]?.point) {
      if (out["on_size"] === undefined) out["on_size"] = 1;
      const len = Number(out["length"] ?? 0);
      if (!(len > 0)) {
        const p1 = v[0]!.point!, p2 = v[v.length - 1]!.point!;
        out["length"] = Math.round((Math.hypot(p2.x - p1.x, p2.y - p1.y) / 100) * 100) / 100;
      }
    }
  }
  return out;
}

type RoomRec = {
  polygon?: Point[];
  edges?: Array<{ p1?: Point; p2?: Point; length?: number; pid?: string; side?: string; room_side?: string; material?: string }>;
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
 *  Ключ — id записи; при коллизии top-level приоритетен. legacy — запись пришла
 *  из per-room хранилища (ревью 263 N3: ей можно дописывать on_size/length). */
function delimiterMapOf(model: Model): Record<string, { rec: Record<string, unknown>; roomKey: string | null; legacy: boolean }> {
  const out: Record<string, { rec: Record<string, unknown>; roomKey: string | null; legacy: boolean }> = {};
  const rooms = roomsOf(model);
  for (const [rid, room] of Object.entries(rooms)) {
    for (const [key, raw] of Object.entries((room.delimiters ?? {}) as Record<string, Record<string, unknown>>)) {
      out[key] = { rec: raw, roomKey: rid, legacy: true };
    }
  }
  for (const [key, raw] of Object.entries((model.zone_delimiters ?? {}) as Record<string, Record<string, unknown>>)) {
    out[key] = { rec: raw, roomKey: String(raw["id_room"] ?? "") || null, legacy: false };
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

/** Магнит конца линии: ближайшее ребро комнаты (≤15 см), для zone_ceiling —
 *  ещё и грань ригеля/закладной (≤10 см; в редакторе магнит к ригелям
 *  включается только при tool zone_ceiling и plan ceiling, проба 296). */
function snapEndpoint(model: Model, roomId: string, room: RoomRec, p: Point, plan: string): Snap | null {
  let best: { snap: Snap; d: number } | null = null;
  const edges = Array.isArray(room.edges) ? room.edges : [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (!e.p1 || !e.p2) continue;
    // ревью 298 №5: рёбра-«пятна» ГКЛ (material gypsum_sm) редактор пропускает
    // и в магните, и в check_delimiter (268-app.js: "gypsum_sm"!==a.material)
    if (e.material === "gypsum_sm") continue;
    const q = projOnSeg(p, e.p1, e.p2);
    if (!q) continue;
    const d = dist(p, q);
    if (d <= ZONE_LIMITS.edgeSnapCm && (!best || d < best.d)) {
      best = { snap: { point: q, kind: "room", edgeIndex: i, pid: e.pid, side: e.side }, d };
    }
  }
  if (plan === "ceiling") {
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
  }
  return best?.snap ?? null;
}

/** Другие разделители той же комнаты и ТОГО ЖЕ плана (линии для проверки
 *  пересечений): редактор отвергает пересечение только делителей одного plan
 *  (check_delimiter: h.id_room===o.id && h.plan===plan — проба 296: делители
 *  потолка и пола в одной комнате свободно пересекаются). Общий слой
 *  delimiterMapOf — верхнеуровневое zone_delimiters + legacy per-room. */
function roomDelimiterLines(model: Model, roomId: string, plan: string, exceptId?: string): Array<{ id: string; p1: Point; p2: Point }> {
  const out: Array<{ id: string; p1: Point; p2: Point }> = [];
  for (const [id, entry] of Object.entries(delimiterMapOf(model))) {
    if (id === exceptId || entry.roomKey !== roomId) continue;
    const rec = migrateLegacyDelimiter(entry.rec, { legacy: entry.legacy });
    // ревью 298 №1 (регрессия против 8f04b2e): legacy-делитель без поля plan
    // (миграция d_*→zone_* поле plan не дописывает) участвовал в проверке
    // пересечений на 8f04b2e и обязан участвовать дальше: отсутствие plan
    // трактуем по типу (restoreTotal: plan выводится из type)
    const recPlan = String(rec["plan"] ?? "") || planOfDelimiterType(String(rec["type"] ?? ""));
    if (recPlan !== plan) continue;
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
 *  пересечений рёбер вне концов нет. Хорда, проходящая мимо комнаты через
 *  выемку, отвергается; касание линии в вершине вогнутого контура (общая точка
 *  рёбер) допустимо — поведение закреплено тестом (ревью 263 N6). */
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
 * Общий слой разделителей зон (класс ZoneDelimitering редактора): линия
 * внутри одной комнаты от ребра до ребра (магнит 150 мм), для зоны потолка —
 * ещё и от/до грани потолочного ригеля или закладной (магнит 100 мм). Линия
 * не пересекает и не идёт вдоль стен, колонн, ригелей/закладных (только для
 * plan ceiling) и других разделителей ТОГО ЖЕ плана этой комнаты (стандарт
 * редактора: check_delimiter фильтрует ZONE_DELIMITERS по h.plan===plan;
 * эталоны 296 — zone_floor/zone_hydroisolation/zone_floor_cap). Колонны
 * role_ "gypsum_sm" в проверке пересечений не участвуют (бандл). Атомарно:
 * при отказе модель не меняется.
 */
export function addZoneDelimiter(
  model: Model,
  roomRef: string,
  params: { type: ZoneDelimiterType; fromMm: Point; toMm: Point },
): { id: string; length_mm: number } {
  const type = params.type;
  const plan = ZONE_DELIMITER_PLANS[type];
  if (!plan) {
    throw new McpError("INVALID_ARGUMENT", `неизвестный тип разделителя зон ${type}`);
  }
  const { id: roomId, room } = roomByRef(model, roomRef);
  const poly = roomPolygonOf(room);
  if (!poly || poly.length < 3) throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomRef} нет контура`);
  const from = { x: mmToCm(params.fromMm.x), y: mmToCm(params.fromMm.y) };
  const to = { x: mmToCm(params.toMm.x), y: mmToCm(params.toMm.y) };
  const lenCm = segLen(from, to);
  if (lenCm * 10 < ZONE_LIMITS.minLineMm) {
    throw new McpError("INVALID_ARGUMENT", `длина линии ${Math.round(lenCm * 10)} мм короче минимальной ${ZONE_LIMITS.minLineMm} мм`);
  }
  // магнит концов (грани ригелей/закладных — только зона потолка)
  const s1 = snapEndpoint(model, roomId, room, from, plan);
  const s2 = snapEndpoint(model, roomId, room, to, plan);
  if (!s1) throw new McpError("INVALID_ARGUMENT", plan === "ceiling"
    ? "from_mm: нет ребра комнаты или грани потолочного ригеля в 150 мм — конец не магнитится"
    : "from_mm: нет ребра комнаты в 150 мм — конец не магнитится");
  if (!s2) throw new McpError("INVALID_ARGUMENT", plan === "ceiling"
    ? "to_mm: нет ребра комнаты или грани потолочного ригеля в 100 мм — конец не магнитится"
    : "to_mm: нет ребра комнаты в 100 мм — конец не магнитится");
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
    // ревью 298 №5: рёбра-«пятна» ГКЛ (material gypsum_sm) не участвуют
    // в проверке пересечений (268-app.js: "gypsum_sm"!==a.material)
    if (e.material === "gypsum_sm") continue;
    if (distToSeg(p1, e.p1, e.p2) <= 0.05 || distToSeg(p2, e.p1, e.p2) <= 0.05) continue;
    if (segsCross(p1, p2, e.p1, e.p2)) {
      throw new McpError("INVALID_ARGUMENT", "линия пересекает ребро/стену комнаты — не пересекайте стены или колонны");
    }
  }
  // ревью 263 N5: линия, коллинеарно лежащая на ребре комнаты на ненулевой
  // длине (частично или полностью вдоль стены), — отказ (точки на ребре в
  // допуске 0,5 см вложенность не видит, а пересечением касание не считается)
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (!e.p1 || !e.p2) continue;
    if (e.material === "gypsum_sm") continue; // ревью 298 №5
    if (collinearOverlapCm({ p1, p2 }, { p1: e.p1, p2: e.p2 }) > 0.5) {
      throw new McpError("INVALID_ARGUMENT", "линия идёт вдоль ребра/стены комнаты — проведите линию внутри комнаты от одной внешней стены до другой");
    }
  }
  // колонны: gypsum_sm (ГКЛ-пятна) в проверке пересечений не участвуют (бандл:
  // check_delimiter пропускает E.role_==="gypsum_sm")
  for (const pillar of Object.values((model.pillars ?? {}) as Record<string, { polygon?: Point[]; role_?: string }>)) {
    if (pillar.role_ === "gypsum_sm") continue;
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
  // ригели и закладные: проверяются только для зоны потолка (check_delimiter
  // редактора целиком под plan==="ceiling"); концы не внутри полигона ригеля
  // (точка на грани — не внутри, ревью 261 №3); линия не пересекает грани
  if (plan === "ceiling") {
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
  }
  // линия внутри комнаты (ревью 261 №2: в вогнутой комнате хорда через выемку —
  // отказ, даже если оба конца легли на рёбра)
  if (!segmentInsidePolygon(p1, p2, poly)) {
    throw new McpError("INVALID_ARGUMENT", "линия проходит вне комнаты — проведите линию внутри одной комнаты от одной внешней стены до другой");
  }
  // другие разделители этой комнаты и этого плана (общий узел или касание в
  // точке — соединение, не пересечение); делители других планов могут
  // пересекаться свободно (проба 296, check_delimiter фильтрует по plan)
  for (const other of roomDelimiterLines(model, roomId, plan)) {
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
    type,
    length: Math.round((segLen(p1, p2) / 100) * 100) / 100,
    id_room: roomId,
    plan,
    on_size: 1,
  };
  model.zone_delimiters ??= {};
  model.zone_delimiters[id] = rec;
  return { id, length_mm: cmToMm(rec.length * 100) };
}

/**
 * zone_ceiling_add: линия-разделитель зон потолка (этап 260; обёртка общего
 * слоя addZoneDelimiter с type "zone_ceiling").
 */
export function addZoneCeiling(
  model: Model,
  roomRef: string,
  params: { fromMm: Point; toMm: Point },
): { id: string; length_mm: number } {
  return addZoneDelimiter(model, roomRef, { type: "zone_ceiling", fromMm: params.fromMm, toMm: params.toMm });
}

/**
 * removeZoneDelimiter: удалить разделитель зон по id сайта (из ответа
 * finish_get/zone_*_add) или метке ZD<n> (сквозная нумерация finish_get).
 * Ожидаемый тип (ревью 298 №2): метки ZD сквозные по всем типам, поэтому
 * zone_floor_remove ZD1 молча удалял бы разделитель потолка — на несовпадение
 * отвечаем INVALID_ARGUMENT с подсказкой инструмента нужного типа.
 */
export function removeZoneDelimiter(
  model: Model,
  delimiterRef: string,
  opts: { expectedType?: ZoneDelimiterType } = {},
): { room_id: string | null; removed: boolean } {
  const map = delimiterMapOf(model);
  // по ключу хранилища или по id записи (per-room ключ может не совпадать с id)
  const hit = Object.entries(map).find(([k, e]) => k === delimiterRef || String(e.rec["id"] ?? "") === delimiterRef);
  if (hit) {
    const [key, entry] = hit;
    if (opts.expectedType) {
      const actual = String(migrateLegacyDelimiter(entry.rec, { legacy: entry.legacy })["type"] ?? "");
      if (actual !== opts.expectedType) {
        throw new McpError(
          "INVALID_ARGUMENT",
          `разделитель ${delimiterRef} — ${actual || "неизвестного типа"}, а не ${opts.expectedType}: используйте ${actual || opts.expectedType}_remove`,
        );
      }
    }
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
      return removeZoneDelimiter(model, String(entry["site_id"]), opts);
    }
  }
  throw new McpError("NOT_FOUND", `разделитель ${delimiterRef} не найден`);
}

/** zone_ceiling_remove (этап 260): обёртка removeZoneDelimiter с типом. */
export function removeZoneCeiling(model: Model, delimiterRef: string): { room_id: string | null; removed: boolean } {
  return removeZoneDelimiter(model, delimiterRef, { expectedType: "zone_ceiling" });
}

/** zone_floor_remove: обёртка removeZoneDelimiter с типом (ревью 298 №2). */
export function removeZoneFloor(model: Model, delimiterRef: string): { room_id: string | null; removed: boolean } {
  return removeZoneDelimiter(model, delimiterRef, { expectedType: "zone_floor" });
}

/** zone_hydroisolation_remove: обёртка removeZoneDelimiter с типом (ревью 298 №2). */
export function removeZoneHydroisolation(model: Model, delimiterRef: string): { room_id: string | null; removed: boolean } {
  return removeZoneDelimiter(model, delimiterRef, { expectedType: "zone_hydroisolation" });
}

/** zone_floor_cap_remove: обёртка removeZoneDelimiter с типом (ревью 298 №2). */
export function removeZoneFloorCap(model: Model, delimiterRef: string): { room_id: string | null; removed: boolean } {
  return removeZoneDelimiter(model, delimiterRef, { expectedType: "zone_floor_cap" });
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
    const rec = migrateLegacyDelimiter(entry.rec, { legacy: entry.legacy });
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
    const rec = migrateLegacyDelimiter(entry.rec, { legacy: entry.legacy });
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
   *  (ревью 261 №5). В режиме normalize (ревью 263 N2: опция действует только
   *  там) их исчезновение при нормализации — штатный случай (ревью 127),
   *  сверка нестрогая: переопределение/пропажа делителя — предупреждение.
   *  В режиме save комната сверяется строго (пропажа и смена типа — проблема),
   *  допустим только ненулевой сдвиг концов до магнита при целой остальной
   *  проекции (вершины, matrix, items, on_size, length прежний или по новой геометрии ±1 см —
   *  ревью 265 R2) — предупреждение (живой эталон 262: редактор перепривязывает
   *  конец к новой стене). */
  affectedRooms?: Set<string>;
};

/**
 * Сверка разделителей зон по комнатам (сопоставление комнат по каноническому
 * контуру и наследникам топологии — room-geo, как finishCompare). Совпадающая
 * комната — строгая сверка (геометрия, тип, план, длина, on_size, полная
 * проекция графа — ревью 261 №4). Топология (split/merge) в режиме normalize:
 * делитель, переживший разрез/слияние по геометрии середины, — норма; пропажа
 * при смене топологии — проблема. Комната, затронутая изменёнными стенами
 * (ревью 261 №5/№8, живой эталон 262: редактор перепривязывает концы
 * разделителей к новой стене и пересоздаёт id комнат): в normalize — нестрогая
 * (совпадение по полной проекции или с точностью до магнита — предупреждение,
 * пропажа — предупреждение с подсказкой); в save — строго (ревью 263 N2):
 * пропажа и смена типа — проблема, допустим только сдвиг концов до магнита при
 * целой остальной проекции (ревью 265 R2) — предупреждение. Сервер не имеет права терять делитель незатронутой комнаты.
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
  const expectedRooms = roomsMapOf(expectedModel);
  const gotRooms = roomsMapOf(gotModel);
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
  // ревью 263 N4: пул нестрогого поиска — только делители комнат got,
  // пересекающих полигон затронутой комнаты (наследники split/merge лежат
  // внутри её полигона и покрыты пересечением); комната без контура не
  // отсекается (консервативно). Строгие комнаты сопоставляются раньше.
  // Делитель, чья комната исчезла (id_room не разрешается в got), судится
  // по геометрии: середина в полигоне затронутой комнаты (ревью 261 №5:
  // редактор пересоздаёт id комнат).
  const intersectingPool = (rid: string): ZoneDelimiterSig[] => {
    const expPoly = roomPolygonOf((expectedRooms ?? {})[rid]);
    if (!expPoly) return [...gotByRoom.values()].flat();
    const intersectingRooms = new Set(
      Object.entries(gotRooms ?? {})
        .filter(([, r]) => {
          const gp = roomPolygonOf(r);
          return !gp || overlapShare(expPoly, gp) > 0 || overlapShare(gp, expPoly) > 0;
        })
        .map(([k]) => k),
    );
    return got.filter((g) => {
      if (gotRooms && g.idRoom in gotRooms) return intersectingRooms.has(g.idRoom);
      return pointInPolygon(midpoint(g), expPoly, 0.5);
    });
  };
  // сдвиг концов до магнита (≤15 см) при том же типе и плане (живой эталон 262)
  const magnetShift = (e: ZoneDelimiterSig, g: ZoneDelimiterSig): boolean =>
    g.type === e.type && g.plan === e.plan &&
    ((dist(e.p1, g.p1) <= ZONE_LIMITS.edgeSnapCm && dist(e.p2, g.p2) <= ZONE_LIMITS.edgeSnapCm) ||
      (dist(e.p1, g.p2) <= ZONE_LIMITS.edgeSnapCm && dist(e.p2, g.p1) <= ZONE_LIMITS.edgeSnapCm));
  // ревью 265 R2: в save сдвиг до магнита принимается, только если остальная
  // проекция цела — число и типы вершин, промежуточные вершины, рёбра матрицы,
  // items, on_size; length прежний или по новой геометрии (±1 см); хотя бы один
  // конец действительно сдвинут. Иначе — общий строгий путь (problem).
  const magnetShiftStrict = (e: ZoneDelimiterSig, g: ZoneDelimiterSig): boolean => {
    if (!magnetShift(e, g)) return false;
    const fwd = dist(e.p1, g.p1) <= ZONE_LIMITS.edgeSnapCm && dist(e.p2, g.p2) <= ZONE_LIMITS.edgeSnapCm;
    const ge1 = fwd ? g.p1 : g.p2;
    const ge2 = fwd ? g.p2 : g.p1;
    if (samePointTol(e.p1, ge1) && samePointTol(e.p2, ge2)) return false;
    if (e.onSize !== g.onSize) return false;
    const n = e.vertexes.length;
    if (g.vertexes.length !== n) return false;
    for (let i = 1; i < n - 1; i++) {
      if (!samePointTol(e.vertexes[i]!, g.vertexes[fwd ? i : n - 1 - i]!)) return false;
    }
    if (JSON.stringify(e.vertexTypes) !== JSON.stringify(g.vertexTypes)) return false;
    if (JSON.stringify(e.itemTypes) !== JSON.stringify(g.itemTypes)) return false;
    const edgeKeys = (sig: ZoneDelimiterSig, flip: boolean): string[] =>
      sig.matrixEdges.map((m) => {
        const i = flip ? n - 1 - m.i : m.i;
        const j = flip ? n - 1 - m.j : m.j;
        return `${Math.min(i, j)}-${Math.max(i, j)}:${Math.round(m.length * 100) / 100}`;
      }).sort();
    if (JSON.stringify(edgeKeys(e, false)) !== JSON.stringify(edgeKeys(g, !fwd))) return false;
    let geomCm = 0;
    for (let i = 0; i + 1 < n; i++) geomCm += dist(g.vertexes[i]!, g.vertexes[i + 1]!);
    // length: редактор при перепривязке конца length не пересчитывает (живой
    // эталон 262: 1,34 м при геометрии 1,27 м) — допустим прежний length или
    // согласованный с новой геометрией, оба ±1 см; прочее — порча проекции
    return Math.abs(g.length - e.length) * 100 <= 1 || Math.abs(g.length * 100 - geomCm) <= 1;
  };
  for (const e of exp) {
    const gid = exact.get(e.idRoom) ?? sameOf(e.idRoom);
    const strictList = (gid ? gotByRoom.get(gid) : undefined) ?? [];
    const found = strictList.filter((g) => !used.has(g.key)).find((g) => sameSig(e, g));
    if (found) {
      used.add(found.key);
      continue;
    }
    const affected = opts.affectedRooms?.has(e.idRoom) ?? false;
    // ревью 261 №5/№8, живой эталон 262: комната затронута изменёнными стенами —
    // редактор вправе переопределить разделитель (живой эталон: конец, попавший
    // в узел разреза, перепривязывается к новой стене со сдвигом точки до
    // величины магнита). Разделитель, совпавший по полной проекции, — норма;
    // совпавший по типу/плану с точностью до магнита, — предупреждение;
    // отсутствующий — предупреждение с подсказкой. Не блок.
    // (только normalize — ревью 263 N2)
    if (affected && mode === "normalize") {
      const pool = intersectingPool(e.idRoom).filter((g) => !used.has(g.key));
      const same = pool.find((g) => sameSig(e, g));
      if (same) {
        used.add(same.key);
        continue;
      }
      const shifted = pool.find((g) => magnetShift(e, g));
      if (shifted) {
        used.add(shifted.key);
        warnings.push(`zone_topology_changed: room ${e.idRoom}: редактор переопределил разделитель зон ${e.key} при изменении стен (${e.type}, ${Math.round(e.length * 100)} см → ${Math.round(shifted.length * 100)} см) — проверьте зоны (${e.type})`);
        continue;
      }
      warnings.push(`zone_topology_changed: room ${e.idRoom}: комната изменена стенами, редактор не сохранил разделитель зон ${e.key} (${e.type}, ${Math.round(e.length * 100)} см) — при переносе или удалении стен сначала удалите разделители (${e.type}_remove)`);
      continue;
    }
    // ревью 263 N2: в save затронутая комната сверяется строго (редактор уже
    // отработал), допустим только сдвиг концов до магнита при целой остальной
    // проекции (ревью 265 R2) — предупреждение; пропажа, смена типа и порча
    // проекции уходят в общий строгий путь ниже — проблема
    if (affected && mode === "save") {
      const pool = intersectingPool(e.idRoom).filter((g) => !used.has(g.key));
      const shifted = pool.find((g) => magnetShiftStrict(e, g));
      if (shifted) {
        used.add(shifted.key);
        warnings.push(`zone_topology_changed: room ${e.idRoom}: редактор переопределил разделитель зон ${e.key} при изменении стен (${e.type}, ${Math.round(e.length * 100)} см → ${Math.round(shifted.length * 100)} см) — проверьте зоны (${e.type})`);
        continue;
      }
    }
    const near = strictList.filter((g) => !used.has(g.key)).find((g) => (samePointTol(e.p1, g.p1) && samePointTol(e.p2, g.p2)) || (samePointTol(e.p1, g.p2) && samePointTol(e.p2, g.p1)));
    if (near) {
      problems.push(`room ${e.idRoom}: разделитель ${e.key} изменился на сервере (${JSON.stringify({ type: e.type, plan: e.plan, length: e.length })} → ${JSON.stringify({ type: near.type, plan: near.plan, length: near.length })})`);
      used.add(near.key);
      continue;
    }
    // изменившаяся топология — только в normalize (roomHeirs в save пуст)
    const heir = heirOf.get(e.idRoom) ?? null;
    if (!heir) {
      problems.push(`room ${e.idRoom}: потерян разделитель зон (${e.type}) ${e.key} (${Math.round(e.length * 100)} см)`);
      continue;
    }
    const mid = midpoint(e);
    const targetKeys = heir.kind === "split" ? heir.partKeys : [heir.key];
    const inTargets = targetKeys.filter((k) => pointInPolygon(mid, polygonOf(k) ?? [], 0.5));
    if (inTargets.length === 0) {
      problems.push(`room ${e.idRoom}: потерян разделитель зон (${e.type}) ${e.key} (${Math.round(e.length * 100)} см) при ${heir.kind === "split" ? "split" : "merge"}`);
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
    problems.push(`room ${e.idRoom}: потерян разделитель зон (${e.type}) ${e.key} (${Math.round(e.length * 100)} см) при ${heir.kind === "split" ? "split" : "merge"}`);
  }
  if (mode === "save") {
    for (const g of got) {
      if (!used.has(g.key)) problems.push(`room ${g.idRoom}: неожиданный разделитель ${g.key} на сервере (${g.type}, ${Math.round(g.length * 100)} см)`);
    }
  }
  return { problems, warnings };
}
