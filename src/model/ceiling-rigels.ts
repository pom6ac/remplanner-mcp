import type { Model, Point, RigelEndpoint, RigelLink } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, cmToMm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { wallFaces } from "./wall-geometry.ts";
import { McpError } from "../errors.ts";
import { dist, lineIntersection, offsetSegment, pointOnSegment, type Segment } from "./geometry.ts";
import { RIGEL_CEILING_TYPES } from "./rigels.ts";
import { zoneCeilingDelimiterLines, segmentInsidePolygon } from "./zone.ts";
import { roomPolygonOf, roomsMapOf, matchRoomsByContour, roomHeirs, overlapShare, pointInPolygon, distToSeg } from "./room-geo.ts";

/**
 * Потолочные закладные (ceiling_rigel, лист «Потолки», инструмент «Потолочная
 * закладная»; PRO; этап 303, 2026-11-20). Класс CeilingRigel редактора, хранится
 * per-room в rooms2[rid].rigels (внутри описания комнаты, как отделка). Формат
 * записи — живой эталон probes/303-ceiling-rigel.ts + fixtures/ui-ref-ceiling-rigel.json:
 *   {id, id_room, p1 {x,y,link {ot:"wall"|"pillar", id, z1}}, p2 {…}, width (см),
 *    ceiling_type, polygon [l1,l2,r2,r1]}
 * Связи концов — к боковым граням стен (l/r), торцам стен (s/e) и граням колонн
 * (t/r/b/l) — ХРАНИМОЕ поле записи (M6 ревью 304: CeilingRigel.calc связи только
 * читает, restoreRigels их не вычисляет — связь ставит mouseup при создании; от
 * связи зависят подрезка полигона по грани и edges.s/e), в API не протекает.
 * Ширина width: умолчание 10 см, панель 10..100 см (defs.ceiling_rigel:
 * width 10, widthMin 10, widthMax 100 — проба 303). ceiling_type — отделка потолка
 * на закладной (инструменты группы ceiling_elements), "" — без отделки.
 *
 * Стандарт редактора (бандл app.3.0, mousedown/mouseup cursor ceiling_rigels +
 * пробы 303): закладная — полоса «от стены до стены» внутри одной комнаты; оба
 * конца на боковых гранях стен (или гранях колонн), радиус магнита конца в UI —
 * ширина полосы (умолчание 10 см, до 100 см; MCP — консервативные 30 мм, как у
 * rigel_add); угол оси к грани конца 45..135°; концы не ближе width/2 к углам
 * грани; оба конца не на одном объекте (ot+id, грань не важна — l10n
 * ceiling_rigel_wall_in_room); ось не пересекает разделители зон потолка
 * (zone_ceiling), боковые грани потолочных ригелей (l10n
 * no_cross_ceiling_rigel_and_delimiter) и оси других закладных той же комнаты —
 * пересекающуюся закладную редактор удаляет при restore (restoreRigels), поэтому
 * MCP отказывает сразу (ревью 304 M2/M3). Перенос закладной редактором не поддержан
 * (контекстное меню: ширина, удалить, сбросить отделку) — ceiling_rigel_update
 * меняет только width/ceiling_type; перенос = удалить и создать заново.
 */

export type CeilingRigelRec = {
  id: string;
  id_room?: string;
  p1: RigelEndpoint;
  p2: RigelEndpoint;
  /** Толщина полосы, см (панель 10..100). */
  width: number;
  ceiling_type: string;
  polygon: Point[];
  [key: string]: unknown;
};

export const CEILING_RIGEL_DEFS = {
  widthCm: 10,
  widthMinCm: 10,
  widthMaxCm: 100,
  /** Магнит конца к грани, см — консервативный MCP (в UI радиус = width ≤ 100 см). */
  snapTolCm: 3,
  /** Допуск контакта конца с гранью для связи, см. */
  linkTolCm: 0.05,
  /** Угол оси к грани конца, градусы (cursor редактора: 45..135). */
  minAngleDeg: 45,
  maxAngleDeg: 135,
} as const;

function finite(name: string, v: number | undefined): void {
  if (v !== undefined && !Number.isFinite(v)) {
    throw new McpError("INVALID_ARGUMENT", `${name} должен быть конечным числом`);
  }
}

/** Угол между осью и гранью, градусы 0..180 (как две прямые). */
function axisEdgeAngleDeg(axis: Segment, edge: Segment): number {
  const a1 = Math.atan2(axis.p2.y - axis.p1.y, axis.p2.x - axis.p1.x);
  const a2 = Math.atan2(edge.p2.y - edge.p1.y, edge.p2.x - edge.p1.x);
  let d = Math.abs((a1 - a2) * 180) / Math.PI;
  d = d % 180;
  return d > 90 ? 180 - d : d;
}

/** Боковые грани стен в формате связей: только l/r (CeilingRigel.calc связывает
 *  концы закладной с боковыми гранями стен; торцы s/e — не боковые). */
function wallSideSegments(wall: Model["walls"][string]): [string, Segment][] {
  try {
    const f = wallFaces(wall, {});
    return [
      ["l", { p1: f.l1, p2: f.l2 }],
      ["r", { p1: f.r1, p2: f.r2 }],
    ];
  } catch {
    return [];
  }
}

/** Грани колонны: t/r/b/l по углам p1..p4. */
function pillarSegments(pillar: Model["pillars"][string]): [string, Segment][] {
  if (!pillar.p1 || !pillar.p2 || !pillar.p3 || !pillar.p4) return [];
  return [
    ["t", { p1: pillar.p1, p2: pillar.p2 }],
    ["r", { p1: pillar.p2, p2: pillar.p3 }],
    ["b", { p1: pillar.p3, p2: pillar.p4 }],
    ["l", { p1: pillar.p4, p2: pillar.p1 }],
  ];
}

/** Все грани-кандидаты для магнита концов закладной. */
function candidateEdges(model: Model): { ot: RigelLink["ot"]; id: string; z1: string; edge: Segment }[] {
  const out: { ot: RigelLink["ot"]; id: string; z1: string; edge: Segment }[] = [];
  for (const wall of Object.values(model.walls ?? {})) {
    for (const [z1, edge] of wallSideSegments(wall)) out.push({ ot: "wall", id: wall.id, z1, edge });
  }
  for (const pillar of Object.values(model.pillars ?? {})) {
    for (const [z1, edge] of pillarSegments(pillar)) out.push({ ot: "pillar", id: pillar.id, z1, edge });
  }
  return out;
}

/**
 * Магнит конца закладной (как cursor редактора): конец в пределах snapTolCm от
 * боковой грани стены/колонны, угол оси к грани 45..135°, проекция внутрь грани
 * не ближе width/2 к её углам (cursor: точка конца отодвигается от углов ребра
 * на width/2 — конец не попадает в угол комнаты). Возвращает точку и связь.
 */
function snapEndpoint(pt: Point, other: Point, model: Model, halfWidth: number): { pt: Point; link: RigelLink | 0 } {
  const axis: Segment = { p1: pt, p2: other };
  let best: { d: number; point: Point; link: RigelLink } | null = null;
  for (const { ot, id, z1, edge } of candidateEdges(model)) {
    const angle = axisEdgeAngleDeg(axis, edge);
    if (!(angle > CEILING_RIGEL_DEFS.minAngleDeg && angle < CEILING_RIGEL_DEFS.maxAngleDeg)) continue;
    const vx = edge.p2.x - edge.p1.x, vy = edge.p2.y - edge.p1.y;
    const l2 = vx * vx + vy * vy;
    if (l2 < 1e-12) continue;
    const t = ((pt.x - edge.p1.x) * vx + (pt.y - edge.p1.y) * vy) / l2;
    if (t <= 0 || t >= 1) continue; // внутрь грани, не к её концам
    const q = { x: edge.p1.x + t * vx, y: edge.p1.y + t * vy };
    const d = dist(q, pt);
    if (d > CEILING_RIGEL_DEFS.snapTolCm) continue;
    // отодвигаем от углов грани на width/2 (cursor редактора)
    const dl = dist(q, edge.p1), dr = dist(q, edge.p2);
    const len = Math.sqrt(l2);
    let clamped = q;
    if (dl < halfWidth) clamped = { x: edge.p1.x + (vx / len) * halfWidth, y: edge.p1.y + (vy / len) * halfWidth };
    else if (dr < halfWidth) clamped = { x: edge.p2.x - (vx / len) * halfWidth, y: edge.p2.y - (vy / len) * halfWidth };
    if (!best || d < best.d) best = { d, point: clamped, link: { ot, id, z1 } };
  }
  if (best) return { pt: { x: r2(best.point.x), y: r2(best.point.y) }, link: best.link };
  return { pt: { x: r2(pt.x), y: r2(pt.y) }, link: 0 };
}

/**
 * Связь конца закладной с гранью (как CeilingRigel.calc): конец лежит на конечном
 * отрезке грани, ось не параллельна грани (2..178°, предикат Rigel.link). Порядок:
 * стены (l/r), колонны (t/r/b/l); последний совпавший выигрывает.
 */
function ceilingRigelLink(endpoint: Point, axis: Segment, model: Model): RigelLink | 0 {
  let link: RigelLink | 0 = 0;
  const match = (ot: RigelLink["ot"], id: string, z1: string, edge: Segment): void => {
    if (!pointOnSegment(edge, endpoint, CEILING_RIGEL_DEFS.linkTolCm)) return;
    const angle = axisEdgeAngleDeg(axis, edge);
    if (!(angle > 2 && angle < 178)) return;
    link = { ot, id, z1 };
  };
  for (const wall of Object.values(model.walls ?? {})) {
    for (const [z1, edge] of wallSideSegments(wall)) match("wall", wall.id, z1, edge);
  }
  for (const pillar of Object.values(model.pillars ?? {})) {
    for (const [z1, edge] of pillarSegments(pillar)) match("pillar", pillar.id, z1, edge);
  }
  return link;
}

/** Округление до 4 знаков (как LIB.l редактора для граней полигона). */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Полигон закладной (как CeilingRigel.calc): параллели оси на ±width/2; концы,
 * привязанные к грани, срезаются по линии грани (пересечение параллели с линией
 * грани). polygon = [l1, l2, r2, r1].
 */
function buildPolygon(p1: Point, p2: Point, width: number, model: Model, links: { p1: RigelLink | 0; p2: RigelLink | 0 }): Point[] {
  const axis: Segment = { p1, p2 };
  const l = offsetSegment(axis, width / 2);
  const rr = offsetSegment(axis, -width / 2);
  let l1: Point = { ...l.p1 };
  let l2: Point = { ...l.p2 };
  let r1: Point = { ...rr.p1 };
  let r2: Point = { ...rr.p2 };
  const edgeLine = (link: RigelLink | 0): Segment | null => {
    if (!link) return null;
    if (link.ot === "wall") {
      const wall = model.walls[link.id];
      if (!wall) return null;
      for (const [z1, edge] of wallSideSegments(wall)) if (z1 === link.z1) return edge;
      return null;
    }
    const pillar = model.pillars[link.id];
    if (!pillar) return null;
    for (const [z1, edge] of pillarSegments(pillar)) if (z1 === link.z1) return edge;
    return null;
  };
  const trim = (link: RigelLink | 0): { a: Point; b: Point } | null => {
    const edge = edgeLine(link);
    if (!edge) return null;
    const a = lineIntersection(l, edge);
    const b = lineIntersection(rr, edge);
    if (!a || !b) return null;
    return { a, b };
  };
  const trimP1 = trim(links.p1);
  if (trimP1) { l1 = trimP1.a; r1 = trimP1.b; }
  const trimP2 = trim(links.p2);
  if (trimP2) { l2 = trimP2.a; r2 = trimP2.b; }
  return [
    { x: round4(l1.x), y: round4(l1.y) },
    { x: round4(l2.x), y: round4(l2.y) },
    { x: round4(r2.x), y: round4(r2.y) },
    { x: round4(r1.x), y: round4(r1.y) },
  ];
}

function validateParams(p: { widthMm?: number; ceilingType?: string }): void {
  finite("width_mm", p.widthMm);
  if (p.widthMm !== undefined) {
    if (!(p.widthMm > 0)) throw new McpError("INVALID_ARGUMENT", "width_mm должен быть > 0");
    if (p.widthMm < CEILING_RIGEL_DEFS.widthMinCm * 10) {
      throw new McpError("INVALID_ARGUMENT", `width_mm меньше минимума (${CEILING_RIGEL_DEFS.widthMinCm * 10} мм по панели редактора)`);
    }
    if (p.widthMm > CEILING_RIGEL_DEFS.widthMaxCm * 10) {
      throw new McpError("INVALID_ARGUMENT", `width_mm больше максимума (${CEILING_RIGEL_DEFS.widthMaxCm * 10} мм по панели редактора)`);
    }
  }
  if (p.ceilingType !== undefined && typeof p.ceilingType !== "string") {
    throw new McpError("INVALID_ARGUMENT", "ceiling_type должен быть строкой");
  }
  if (typeof p.ceilingType === "string" && p.ceilingType !== "" && !(RIGEL_CEILING_TYPES as readonly string[]).includes(p.ceilingType)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `ceiling_type: допустимо "" или одно из значений инструментов листа потолка: ${RIGEL_CEILING_TYPES.join(", ")}`,
    );
  }
}

function roomByRef(model: Model, ref: string): { id: string; room: Record<string, unknown> } {
  const rooms = (model.rooms2 ?? model.rooms1 ?? {}) as Record<string, Record<string, unknown>>;
  if (rooms[ref]) return { id: ref, room: rooms[ref]! };
  const m = /^R(\d+)$/.exec(ref);
  if (m) {
    const found = Object.entries(rooms)[Number(m[1]) - 1];
    if (found) return { id: found[0], room: found[1]! };
  }
  throw new McpError("NOT_FOUND", `комната ${ref} не найдена`);
}

/**
 * Общие проверки оси закладной (как mouseup редактора): оба конца на гранях
 * (связи не пустые), концы не на одной грани одного объекта, ось не пересекает
 * разделители зон потолка и боковые грани потолочных ригелей. Ось обязана быть
 * внутри комнаты (обе точки на её рёбрах; курсор редактора строит закладную,
 * только пока обе точки над одной комнатой).
 */
function assertAxisChecks(model: Model, roomId: string, p1: Point, p2: Point, links: { p1: RigelLink | 0; p2: RigelLink | 0 }): void {
  const noLink = !links.p1 || !links.p2;
  if (noLink) {
    throw new McpError(
      "INVALID_ARGUMENT",
      "концы закладной должны лежать на боковых гранях стен или гранях колонн (закладная строится «от стены до стены»; магнит MCP 30 мм)",
    );
  }
  if (links.p1 && links.p2 && links.p1.ot === links.p2.ot && links.p1.id === links.p2.id && links.p1.z1 === links.p2.z1) {
    throw new McpError("INVALID_ARGUMENT", "оба конца на одной грани одного объекта — проведите закладную от одной стены до другой");
  }
  const room = ((model.rooms2 ?? model.rooms1 ?? {}) as Record<string, Record<string, unknown>>)[roomId];
  if (!room) throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomId} нет контура`);
  const poly = roomPolygonOf(room);
  if (!poly || poly.length < 3) throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomId} нет контура`);
  // пересечение с разделителями зон потолка (mouseup редактора: ZONE_DELIMITERS
  // типа zone_ceiling; пересечение отрезков)
  for (const line of zoneCeilingDelimiterLines(model)) {
    if (segmentsCross(p1, p2, line.p1, line.p2)) {
      throw new McpError("INVALID_ARGUMENT", "закладная пересекает разделитель зон потолка — не пересекайте разделители зон");
    }
  }
  // пересечение с осями других закладных той же комнаты (ревью 304 M3):
  // restore редактора (restoreRigels) удаляет пересекающуюся закладную —
  // после такого save падает NORMALIZATION_DROPPED или закладная пропадает
  const rigelsOfRoom = (room["rigels"] ?? {}) as Record<string, { p1?: Point; p2?: Point }>;
  for (const other of Object.values(rigelsOfRoom)) {
    if (!other.p1 || !other.p2) continue;
    if (segmentsCross(p1, p2, other.p1, other.p2)) {
      throw new McpError(
        "INVALID_ARGUMENT",
        "закладная пересекает другую потолочную закладную этой комнаты — редактор при открытии удалит пересекающуюся закладную",
      );
    }
  }
  // пересечение с боковыми гранями потолочных ригелей (eds.l/eds.r)
  for (const rigel of Object.values(model.rigels ?? {})) {
    for (const side of ["l", "r"] as const) {
      const seg = rigel[side];
      if (!seg?.p1 || !seg?.p2) continue;
      if (segmentsCross(p1, p2, seg.p1, seg.p2)) {
        throw new McpError("INVALID_ARGUMENT", "закладная пересекает потолочный ригель — не пересекайте потолочные ригели");
      }
    }
  }
  // концы и ось — внутри комнаты (курсор редактора отпускает закладную только
  // над комнатой). Ревью 304 M4: честная проверка — пересечение оси с рёбрами
  // комнаты (кроме рёбер, на которых лежат концы — это примыкание) + общий
  // предикат вложенности segmentInsidePolygon (зоны, ревью 261 №2). Выборка
  // точек через ≤25 см пропускала короткий заход оси в тело стены у рефлекс-
  // угла Г-комнаты (304-exp3: 11/11 ACCEPTED), а restore редактора (restoreRigels)
  // такую закладную удаляет.
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    // конец на ребре — примыкание, не пересечение
    if (distToSeg(p1, a, b) <= 0.05 || distToSeg(p2, a, b) <= 0.05) continue;
    if (segmentsCross(p1, p2, a, b)) {
      // касание в вершине контура (общая точка рёбер, ось остаётся внутри —
      // как в зонировании, ревью 263 N6) — не пересечение
      const q = lineIntersection({ p1, p2 }, { p1: a, p2: b });
      if (q && poly.some((v) => dist(q, v) <= 0.05)) continue;
      throw new McpError("INVALID_ARGUMENT", "закладная пересекает ребро/стену комнаты — проведите её внутри одной комнаты от стены до стены");
    }
  }
  if (!segmentInsidePolygon(p1, p2, poly)) {
    throw new McpError("INVALID_ARGUMENT", "закладная проходит вне комнаты — проведите её внутри одной комнаты от стены до стены");
  }
}

/** Пересечение отрезков ненулевой длины (общая точка-касание не считается). */
function segmentsCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d = (o: Point, p: Point, q: Point) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const EPS = 1e-9;
  const d1 = d(a1, a2, b1), d2 = d(a1, a2, b2), d3 = d(b1, b2, a1), d4 = d(b1, b2, a2);
  if (((d1 > EPS) !== (d2 > EPS)) && ((d3 > EPS) !== (d4 > EPS))) return true;
  return false;
}

/**
 * ceiling_rigel_add: ставит потолочную закладную в комнате (мм): ось start→end,
 * ширина width_mm (по умолчанию 100, панель 100..1000 мм), отделка ceiling_type
 * ("" по умолчанию). Концы в пределах 30 мм от боковой грани стены/грани колонны
 * прилипают к ней (консервативный магнит MCP; в редакторе радиус = ширина полосы,
 * до 100 см). Атомарно: при отказе модель не меняется.
 */
export function addCeilingRigel(
  model: Model,
  roomRef: string,
  params: { start: MmPoint; end: MmPoint; widthMm?: number; ceilingType?: string },
): CeilingRigelRec {
  validateParams(params);
  const { id: roomId } = roomByRef(model, roomRef);
  const width = params.widthMm !== undefined ? mmToCm(params.widthMm) : CEILING_RIGEL_DEFS.widthCm;
  const halfWidth = width / 2;
  const p1Cm = { x: mmToCm(params.start.x), y: mmToCm(params.start.y) };
  const p2Cm = { x: mmToCm(params.end.x), y: mmToCm(params.end.y) };
  if (dist(p1Cm, p2Cm) < 1e-6) {
    throw new McpError("INVALID_ARGUMENT", "начало и конец оси закладной совпадают — задайте ось ненулевой длины");
  }
  // магнит концов (как в UI: каждый конец к ближайшей подходящей грани)
  const snap1 = snapEndpoint(p1Cm, p2Cm, model, halfWidth);
  const snap2 = snapEndpoint(p2Cm, snap1.pt, model, halfWidth);
  const axis: Segment = { p1: snap1.pt, p2: snap2.pt };
  if (dist(snap1.pt, snap2.pt) < 1e-6) {
    throw new McpError("INVALID_ARGUMENT", "после магнита начало и конец оси совпадают");
  }
  // связи пересчитываются по фактическим (после магнита и отодвижения от углов)
  // точкам — как CeilingRigel.calc
  const links = {
    p1: ceilingRigelLink(snap1.pt, axis, model),
    p2: ceilingRigelLink(snap2.pt, axis, model),
  };
  assertAxisChecks(model, roomId, snap1.pt, snap2.pt, links);
  const id = newId(10);
  const rec: CeilingRigelRec = {
    id,
    id_room: roomId,
    p1: { ...snap1.pt, link: links.p1 },
    p2: { ...snap2.pt, link: links.p2 },
    width: r2(width),
    ceiling_type: params.ceilingType ?? "",
    polygon: buildPolygon(snap1.pt, snap2.pt, width, model, links),
  };
  const room = roomByRef(model, roomRef).room as { rigels?: Record<string, CeilingRigelRec> };
  room.rigels ??= {};
  room.rigels[id] = rec;
  return rec;
}

/**
 * ceiling_rigel_update: ширина и отделка закладной (как контекстное меню
 * редактора). Перенос закладной редактором не поддержан — ось не меняем
 * (перенос = удалить и создать заново). При изменении ширины полигон
 * пересчитывается (как в редакторе после #cm-ceiling-rigel--width).
 */
export function updateCeilingRigel(
  model: Model,
  rigelId: string,
  params: { widthMm?: number; ceilingType?: string },
): CeilingRigelRec {
  validateParams(params);
  for (const room of Object.values((model.rooms2 ?? model.rooms1 ?? {}) as Record<string, Record<string, unknown>>)) {
    const rigels = room.rigels as Record<string, CeilingRigelRec> | undefined;
    const rec = rigels?.[rigelId];
    if (!rec) continue;
    const backup = structuredClone(rigels!);
    try {
      if (params.widthMm !== undefined) {
        rec.width = r2(mmToCm(params.widthMm));
        rec.polygon = buildPolygon({ x: rec.p1.x, y: rec.p1.y }, { x: rec.p2.x, y: rec.p2.y }, rec.width, model, {
          p1: rec.p1.link ?? 0,
          p2: rec.p2.link ?? 0,
        });
      }
      if (params.ceilingType !== undefined) rec.ceiling_type = params.ceilingType;
    } catch (e) {
      room.rigels = backup;
      throw e;
    }
    return rec;
  }
  throw new McpError("NOT_FOUND", `закладная ${rigelId} не найдена`);
}

/**
 * ceiling_rigel_delete: удалить закладную. Судьба разделителей зон потолка —
 * как в редакторе (живая проба 303): никаких каскадов, разделители остаются
 * (привязка узлов zone — производное редактора, пересчитывается при restore).
 */
export function deleteCeilingRigel(model: Model, rigelId: string): { room_id: string } {
  for (const [rid, room] of Object.entries((model.rooms2 ?? model.rooms1 ?? {}) as Record<string, Record<string, unknown>>)) {
    const rigels = room.rigels as Record<string, CeilingRigelRec> | undefined;
    if (rigels && rigels[rigelId]) {
      delete rigels[rigelId];
      if (Object.keys(rigels).length === 0) delete room.rigels;
      return { room_id: rid };
    }
  }
  throw new McpError("NOT_FOUND", `закладная ${rigelId} не найдена`);
}

/** Список закладных для finish_get/compact (мм; метки CR<n> сквозные по комнатам). */
export function ceilingRigelList(model: Model, roomRef?: string): Array<Record<string, unknown>> {
  const rooms = (model.rooms2 ?? model.rooms1 ?? {}) as Record<string, Record<string, unknown>>;
  const allKeys = Object.keys(rooms);
  const wanted = roomRef
    ? new Set(allKeys.filter((rid) => rid === roomRef || `R${allKeys.indexOf(rid) + 1}` === roomRef))
    : null;
  const out: Array<Record<string, unknown>> = [];
  let n = 0;
  for (const [rid, room] of Object.entries(rooms)) {
    if (wanted && !wanted.has(rid)) continue;
    const rigels = (room.rigels ?? {}) as Record<string, CeilingRigelRec>;
    for (const rec of Object.values(rigels)) {
      n += 1;
      out.push({
        id: `CR${n}`,
        site_id: rec.id,
        room_id: rid,
        from_mm: [cmToMm(rec.p1.x), cmToMm(rec.p1.y)],
        to_mm: [cmToMm(rec.p2.x), cmToMm(rec.p2.y)],
        width_mm: cmToMm(rec.width),
        ceiling_type: rec.ceiling_type ?? "",
      });
    }
  }
  return out;
}

// ---------- Семантическая сверка ----------

const COORD_TOL_CM = 1;

/** Связь конца в сверке: объект {ot,id,z1}, 0 (связи нет) или undefined
 *  (поля нет). Ревью 304 M6: связь — ХРАНИМОЕ поле (CeilingRigel.calc его
 *  только читает, restoreRigels не вычисляет — связь ставит mouseup), от него
 *  зависят подрезка полигона по грани и edges.s/e, поэтому сверяется. */
type RigelLinkNorm = { ot: string; id: string; z1: string } | 0 | undefined;

function normLink(v: unknown): RigelLinkNorm {
  if (v === undefined) return undefined;
  if (v === null || v === 0) return 0;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o["ot"] === undefined && o["id"] === undefined && o["z1"] === undefined) return 0;
    return { ot: String(o["ot"] ?? ""), id: String(o["id"] ?? ""), z1: String(o["z1"] ?? "") };
  }
  return 0;
}

type CeilingRigelSig = {
  id: string;
  roomId: string;
  p1: Point;
  p2: Point;
  width: number;
  ceilingType: string;
  polygon: Point[];
  /** Связи концов (M6 ревью 304): хранимое поле, сверяется с обеих сторон. */
  p1Link: RigelLinkNorm;
  p2Link: RigelLinkNorm;
  /** id_room относительно своего хранилища: undefined — поля нет, "self" —
   *  указывает на комнату записи, иначе — чужой id (M6 ревью 304). */
  idRoomRef: string | undefined;
};

function rigelSigsOf(roomsModel: Record<string, unknown> | undefined): CeilingRigelSig[] {
  const out: CeilingRigelSig[] = [];
  for (const [rid, room] of Object.entries((roomsModel ?? {}) as Record<string, Record<string, unknown>>)) {
    for (const rec of Object.values((room.rigels ?? {}) as Record<string, CeilingRigelRec>)) {
      if (!rec.p1 || !rec.p2) continue;
      out.push({
        id: String(rec.id ?? ""),
        roomId: rid,
        p1: { x: rec.p1.x, y: rec.p1.y },
        p2: { x: rec.p2.x, y: rec.p2.y },
        width: Number(rec.width ?? 0),
        ceilingType: String(rec.ceiling_type ?? ""),
        polygon: Array.isArray(rec.polygon) ? rec.polygon.map((p) => ({ x: p.x, y: p.y })) : [],
        p1Link: normLink((rec.p1 as { link?: unknown }).link),
        p2Link: normLink((rec.p2 as { link?: unknown }).link),
        idRoomRef: rec.id_room === undefined ? undefined : (String(rec.id_room) === rid ? "self" : String(rec.id_room)),
      });
    }
  }
  return out;
}

function samePt(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= COORD_TOL_CM && Math.abs(a.y - b.y) <= COORD_TOL_CM;
}

export type CeilingRigelLinkContext = {
  walls?: Record<string, unknown>;
  pillars?: Record<string, unknown>;
};

/** Грань, на которую указывает связь, в геометрии своей модели (M6 ревью 304:
 *  id стен может смениться при пересоздании — сопоставляем по геометрии). */
function linkEdge(link: RigelLinkNorm, ctx: CeilingRigelLinkContext | undefined): Segment | null {
  if (!link || !ctx) return null;
  if (link.ot === "wall" && ctx.walls) {
    const wall = ctx.walls[link.id] as Model["walls"][string] | undefined;
    if (wall) for (const [z1, edge] of wallSideSegments(wall)) if (z1 === link.z1) return edge;
    return null;
  }
  if (link.ot === "pillar" && ctx.pillars) {
    const pillar = ctx.pillars[link.id] as Model["pillars"][string] | undefined;
    if (pillar) for (const [z1, edge] of pillarSegments(pillar)) if (z1 === link.z1) return edge;
    return null;
  }
  return null;
}

function sameEdge(a: Segment, b: Segment): boolean {
  return (samePt(a.p1, b.p1) && samePt(a.p2, b.p2)) || (samePt(a.p1, b.p2) && samePt(a.p2, b.p1));
}

/** Связи совпадают: наличие поля с обеих сторон — отдельно (M6 ревью 304);
 *  объекты — по ot/id/z1 или по геометрии грани (id мог смениться). */
function sameLink(a: RigelLinkNorm, b: RigelLinkNorm, ctx: CeilingRigelLinkContext | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a === 0 || b === 0) return a === b;
  if (a.ot === b.ot && a.id === b.id && a.z1 === b.z1) return true;
  const ea = linkEdge(a, ctx), eb = linkEdge(b, ctx);
  return ea !== null && eb !== null && sameEdge(ea, eb);
}

function sameSig(a: CeilingRigelSig, b: CeilingRigelSig, ctx?: CeilingRigelLinkContext): boolean {
  if (Math.abs(a.width - b.width) > COORD_TOL_CM) return false;
  if (a.ceilingType !== b.ceilingType) return false;
  if (!sameLink(a.p1Link, b.p1Link, ctx) || !sameLink(a.p2Link, b.p2Link, ctx)) return false;
  if (a.idRoomRef !== b.idRoomRef) return false;
  const fwd = samePt(a.p1, b.p1) && samePt(a.p2, b.p2);
  const rev = samePt(a.p1, b.p2) && samePt(a.p2, b.p1);
  if (!fwd && !rev) return false;
  // полигон: та же форма (4 вершины с допуском, в прямом или обратном порядке)
  if (a.polygon.length !== b.polygon.length) return false;
  const n = a.polygon.length;
  for (let start = 0; start < n; start++) {
    for (const dir of [1, -1] as const) {
      let ok = true;
      for (let i = 0; i < n; i++) {
        const q = b.polygon[(start + (dir === 1 ? i : n - i) % n) % n]!;
        if (!samePt(a.polygon[i]!, q)) { ok = false; break; }
      }
      if (ok) return true;
    }
  }
  return false;
}

export type CeilingRigelCompareOpts = {
  /** Комнаты, затронутые изменёнными стенами (затронутость по грани —
   *  zoneAffectedRoomIds); в них сверка нестрогая. */
  affectedRooms?: Set<string>;
  /** Стены/колонны обеих моделей (M6 ревью 304): связи сверяются по геометрии
   *  граней, когда id объекта сменился при пересоздании. */
  walls?: Record<string, unknown>;
  pillars?: Record<string, unknown>;
};

/**
 * Сверка закладных по комнатам (сопоставление комнат по каноническому контуру и
 * наследникам топологии — как zoneDelimiterCompare). Совпадающая комната —
 * строгая сверка по id записи (+ геометрический запасной путь для записей с
 * новым id, один-к-одному); с ревью 304 M5/M6 в сверку входят ceiling_type,
 * связи концов (p1.link/p2.link — хранимое поле, calc его не пересчитывает) и
 * id_room. Комната, затронутая изменёнными стенами: в normalize расхождение/
 * пропажа — предупреждение; в save — проблема; послабление «форма/связи» —
 * только для полигона (его calc действительно пересчитывает), ceiling_type и
 * связи в save сверяются строго.
 */
export function ceilingRigelCompare(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
  mode: "normalize" | "save",
  opts: CeilingRigelCompareOpts = {},
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const ctx: CeilingRigelLinkContext = { walls: opts.walls, pillars: opts.pillars };
  const exp = rigelSigsOf(expectedRooms);
  const got = rigelSigsOf(gotRooms);
  if (exp.length === 0 && got.length === 0) return { problems, warnings };
  const expRoomsMap = (expectedRooms ?? {}) as Record<string, { polygon?: Point[] }>;
  const gotRoomsMap = (gotRooms ?? {}) as Record<string, { polygon?: Point[] }>;
  const { pairs: exact } = matchRoomsByContour(expRoomsMap, gotRoomsMap);
  const heirOf = roomHeirs(expRoomsMap, gotRoomsMap, exact, mode);
  const gotByRoom = new Map<string, CeilingRigelSig[]>();
  for (const g of got) {
    const list = gotByRoom.get(g.roomId) ?? [];
    list.push(g);
    gotByRoom.set(g.roomId, list);
  }
  const midpoint = (e: CeilingRigelSig): Point => ({ x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 });
  const used = new Set<string>();
  const expectedIds = new Set(exp.map((e) => e.id));
  // пул нестрогого поиска — закладные комнат got, пересекающих полигон затронутой
  for (const e of exp) {
    const gid = exact.get(e.roomId);
    const heir = heirOf.get(e.roomId) ?? null;
    const affected = opts.affectedRooms?.has(e.roomId) ?? false;
    const targetKeys = heir === null ? [] : heir.kind === "split" ? heir.partKeys : [heir.key];
    const strictList = (gid ? gotByRoom.get(gid) : undefined) ?? [];
    // по id: парная комната, комнаты-наследники, или пул затронутой комнаты
    const poolForAffected = (): CeilingRigelSig[] => {
      const expPoly = (expRoomsMap[e.roomId] ?? {}).polygon;
      if (!expPoly || expPoly.length < 3) return [...gotByRoom.values()].flat();
      return got.filter((g) => {
        if (g.roomId in gotRoomsMap) {
          const gp = roomPolygonOf((gotRoomsMap[g.roomId] ?? {}) as Record<string, unknown>);
          return !gp || overlapShare(expPoly, gp) > 0 || overlapShare(gp, expPoly) > 0;
        }
        return pointInPolygon(midpoint(g), expPoly, 0.5);
      });
    };
    const byId = got.find(
      (g) => !used.has(g.id) && g.id === e.id &&
        ((gid !== undefined && g.roomId === gid) || targetKeys.includes(g.roomId) || (affected && mode === "normalize" && poolForAffected().some((p) => p.id === g.id))),
    );
    if (byId) {
      used.add(byId.id);
      if (sameSig(e, byId, ctx)) continue;
      if (!affected) {
        problems.push(`room ${e.roomId}: закладная ${e.id} изменилась на сервере (width ${e.width} → ${byId.width}, ceiling_type ${e.ceilingType || '""'} → ${byId.ceilingType || '""'})`);
        continue;
      }
      // затронутая комната: форма могла перестроиться — сопоставим по оси
      // с допуском. Ревью 304 M5/M6: в save отделка и связи сверяются строго
      // (calc читает связи, а не пересчитывает; пересчитывает только полигон)
      const axisKept = samePt(e.p1, byId.p1) && samePt(e.p2, byId.p2);
      if (axisKept && Math.abs(e.width - byId.width) <= COORD_TOL_CM) {
        if (mode === "save" && e.ceilingType !== byId.ceilingType) {
          problems.push(`room ${e.roomId}: закладная ${e.id} потеряла отделку на сервере (ceiling_type ${e.ceilingType || '""'} → ${byId.ceilingType || '""'}) — редактор отделку закладной не пересчитывает`);
          continue;
        }
        if (mode === "save" && (!sameLink(e.p1Link, byId.p1Link, ctx) || !sameLink(e.p2Link, byId.p2Link, ctx))) {
          problems.push(`room ${e.roomId}: закладная ${e.id} потеряла связь конца на сервере (p1.link ${JSON.stringify(e.p1Link ?? null)} → ${JSON.stringify(byId.p1Link ?? null)}, p2.link ${JSON.stringify(e.p2Link ?? null)} → ${JSON.stringify(byId.p2Link ?? null)}) — редактор связи не пересчитывает`);
          continue;
        }
        warnings.push(`room ${e.roomId}: редактор пересчитал закладную ${e.id} (форма/связи)`);
        continue;
      }
      if (mode === "normalize") {
        warnings.push(`room ${e.roomId}: закладная ${e.id} изменилась у затронутой комнаты (width ${e.width} → ${byId.width})`);
        continue;
      }
      problems.push(`room ${e.roomId}: закладная ${e.id} изменилась на сервере у затронутой комнаты (width ${e.width} → ${byId.width})`);
      continue;
    }
    // геометрический запасной путь — записи got с действительно новым id
    const found = got.find((g) => !used.has(g.id) && !expectedIds.has(g.id) && sameSig(e, g, ctx));
    if (found) {
      used.add(found.id);
      warnings.push(`room ${e.roomId}: редактор сменил id закладной: ${e.id} → ${found.id}`);
      continue;
    }
    if (affected && mode === "normalize") {
      warnings.push(`room ${e.roomId}: закладная ${e.id} не найдена после нормализации у затронутой комнаты`);
      continue;
    }
    problems.push(`room ${e.roomId}: закладная ${e.id} потеряна (width ${e.width}, ceiling_type ${e.ceilingType || '""'})`);
  }
  // лишние закладные
  for (const g of got) {
    if (used.has(g.id)) continue;
    if (expectedIds.has(g.id)) continue; // уже судился по id выше
    const gid = exact.get(g.roomId);
    // комната got — наследник (split-часть или merge-результат) исходной
    let heirSource: string | null = null;
    if (gid === undefined && mode === "normalize") {
      for (const h of heirOf.values()) {
        if (!h) continue;
        if (h.kind === "split" && h.partKeys.includes(g.roomId)) { heirSource = h.key; break; }
        if (h.kind !== "same" && h.key === g.roomId) { heirSource = h.key; break; }
      }
    }
    const expRoomId = gid ?? heirSource ?? g.roomId;
    const affected = opts.affectedRooms?.has(expRoomId) ?? false;
    if (mode === "normalize") {
      // неожиданная закладная после нормализации — предупреждение (как у
      // разделителей зон: отказ только в save-сверке по GET)
      warnings.push(`room ${g.roomId}: неожиданная закладная ${g.id}${affected ? " у затронутой комнаты" : ""}`);
      used.add(g.id);
      continue;
    }
    problems.push(`room ${g.roomId}: unexpected закладная ${g.id} (width ${g.width})`);
    used.add(g.id);
  }
  return { problems, warnings };
}
