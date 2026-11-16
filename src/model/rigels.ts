import type { Model, Point, Rigel, RigelEndpoint, RigelLink } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { wallFaces } from "./walls.ts";
import { McpError } from "../errors.ts";
import { dist, closestPoint, lineIntersection, offsetSegment, pointOnSegment, type Segment } from "./geometry.ts";

/**
 * Потолочные ригели (пункт меню «Потолочный ригель», model.rigels, этап 47, 2026-11-16).
 * Эталоны tests/fixtures/ui-ref-rigel-<вариант>.json: ось p1→p2 (см), depth — толщина
 * на плане (см), height — опускание от потолка (см), ceiling_type — тип отделки
 * потолка ("" — нет), polygon/l/r — расчёт редактора (Rigel.calc/serialize).
 * Лимиты — defs.rigel редактора (проба 47-rigels-ui-scout.ts): depth 10..100 см,
 * height 10..100 см. Концы магнитятся к граням стен (l/r/s/e), колонн (t/r/b/l)
 * и других ригелей (l/r/s/e); связь ставится, когда конец лежит на КОНЕЧНОМ отрезке
 * грани, а ось ригеля не параллельна грани (угол 2..178°, как Rigel.link редактора);
 * одинаковые связи обоих концов гасятся (z1 у p2 → 0).
 */
export const RIGEL_DEFS = {
  depthCm: 30,
  heightCm: 30,
  depthMinCm: 10,
  depthMaxCm: 100,
  heightMinCm: 10,
  heightMaxCm: 100,
  /** Допуск прилипания конца к грани, см (магнит MCP; в редакторе радиус ≥ 40 см, проба 47). */
  snapTolCm: 3,
  /** Допуск контакта конца с гранью для связи, см. */
  linkTolCm: 0.05,
};

/**
 * Допустимые ceiling_type — ключи инструментов группы ceiling_elements редактора
 * (проба 49-ceiling-elements-tools.ts: window.tools, planner.tools___94___*.js),
 * которые Rigel.mousedown ставит в ceiling_type ("ceiling"===plan, tool не
 * "molding" и не "complex_ceiling"; ceiling_remove до ригеля не доходит —
 * заменяется на eraser). Редактор рисует отделку цветом tools[type].filling;
 * пустая строка — без отделки.
 */
export const RIGEL_CEILING_TYPES = [
  "stretch_ceiling",
  "stretch_ceiling_tissue",
  "paint_ceiling",
  "gypsum_ceiling",
  "rack_ceiling",
  "wooden_ceiling",
  "plastic_panels_ceiling",
  "whitewash_ceiling",
  "armstrong_ceiling",
  "grillato_ceiling",
  "plaster_visual_ceiling",
  "plaster_full_ceiling",
  "isolation_ceiling_cotton",
  "ceiling_niche",
] as const;

export type RigelCeilingType = (typeof RIGEL_CEILING_TYPES)[number];

export type AddRigarParams = {
  /** Начало оси, мм. */
  start: MmPoint;
  /** Конец оси, мм. */
  end: MmPoint;
  depthMm?: number;
  heightMm?: number;
  ceilingType?: string;
};

export type UpdateRigarParams = Partial<Omit<AddRigarParams, "start" | "end">> & {
  rigelId: string;
  start?: MmPoint;
  end?: MmPoint;
};

function finite(name: string, v: number | undefined): void {
  if (v !== undefined && !Number.isFinite(v)) {
    throw new McpError("INVALID_ARGUMENT", `${name} должен быть конечным числом`);
  }
}

/** Применимость параметров и лимиты defs (панель редактора) — до любых мутаций. */
export function validateRigelsParams(p: Partial<AddRigarParams>): void {
  finite("depth_mm", p.depthMm);
  finite("height_mm", p.heightMm);
  if (p.depthMm !== undefined) {
    if (!(p.depthMm > 0)) throw new McpError("INVALID_ARGUMENT", "depth_mm должен быть > 0");
    if (p.depthMm < RIGEL_DEFS.depthMinCm * 10) {
      throw new McpError("INVALID_ARGUMENT", `depth_mm меньше минимума (${RIGEL_DEFS.depthMinCm * 10} мм по панели редактора)`);
    }
    if (p.depthMm > RIGEL_DEFS.depthMaxCm * 10) {
      throw new McpError("INVALID_ARGUMENT", `depth_mm больше максимума (${RIGEL_DEFS.depthMaxCm * 10} мм по панели редактора)`);
    }
  }
  if (p.heightMm !== undefined) {
    if (!(p.heightMm > 0)) throw new McpError("INVALID_ARGUMENT", "height_mm должен быть > 0");
    if (p.heightMm < RIGEL_DEFS.heightMinCm * 10) {
      throw new McpError("INVALID_ARGUMENT", `height_mm меньше минимума (${RIGEL_DEFS.heightMinCm * 10} мм по панели редактора)`);
    }
    if (p.heightMm > RIGEL_DEFS.heightMaxCm * 10) {
      throw new McpError("INVALID_ARGUMENT", `height_mm больше максимума (${RIGEL_DEFS.heightMaxCm * 10} мм по панели редактора)`);
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

/** Угол между осью ригеля и гранью, градусы 0..180 (как две прямые). */
function axisEdgeAngleDeg(axis: Segment, edge: Segment): number {
  const a1 = Math.atan2(axis.p2.y - axis.p1.y, axis.p2.x - axis.p1.x);
  const a2 = Math.atan2(edge.p2.y - edge.p1.y, edge.p2.x - edge.p1.x);
  let d = Math.abs((a1 - a2) * 180) / Math.PI;
  d = d % 180;
  return d > 90 ? 180 - d : d;
}

/** Грани стены в формате связей редактора: l/r — боковые, s/e — торцы. */
function wallEdgeSegments(wall: Model["walls"][string]): [string, Segment][] {
  try {
    const f = wallFaces(wall, {});
    return [
      ["l", { p1: f.l1, p2: f.l2 }],
      ["r", { p1: f.r1, p2: f.r2 }],
      ["s", { p1: f.l1, p2: f.r1 }],
      ["e", { p1: f.l2, p2: f.r2 }],
    ];
  } catch {
    return [];
  }
}

/** Грани колонны: t/r/b/l по углам p1..p4. */
function pillarEdgeSegments(pillar: Model["pillars"][string]): [string, Segment][] {
  if (!pillar.p1 || !pillar.p2 || !pillar.p3 || !pillar.p4) return [];
  return [
    ["t", { p1: pillar.p1, p2: pillar.p2 }],
    ["r", { p1: pillar.p2, p2: pillar.p3 }],
    ["b", { p1: pillar.p3, p2: pillar.p4 }],
    ["l", { p1: pillar.p4, p2: pillar.p1 }],
  ];
}

/** Грани ригеля: l/r — боковые (сохранённые), s/e — торцы (по polygon). */
function rigelEdgeSegments(rigel: Rigel): [string, Segment][] {
  const out: [string, Segment][] = [];
  if (rigel.l) out.push(["l", { p1: rigel.l.p1, p2: rigel.l.p2 }]);
  if (rigel.r) out.push(["r", { p1: rigel.r.p1, p2: rigel.r.p2 }]);
  const poly = rigel.polygon;
  if (Array.isArray(poly) && poly.length === 4) {
    out.push(["s", { p1: poly[0]!, p2: poly[3]! }]);
    out.push(["e", { p1: poly[1]!, p2: poly[2]! }]);
  }
  return out;
}

/**
 * Связь конца ригеля с гранью (как Rigel.link редактора): конец лежит на КОНЕЧНОМ
 * отрезке грани (не бесконечной прямой), ось ригеля не параллельна грани
 * (угол 2..178°). Порядок поиска: стены (l/r/s/e), колонны (t/r/b/l), ригели
 * (l/r/s/e); последний совпавший выигрывает, как в редакторе. Совпадение связи
 * у обоих концов (тот же id и z1) гасится — возвращает null.
 */
export function rigelLink(
  endpoint: Point,
  axis: Segment,
  model: Model,
  selfId: string,
): RigelLink | 0 {
  let link: RigelLink | 0 = 0;
  const match = (ot: RigelLink["ot"], id: string, z1: string, edge: Segment): void => {
    if (!pointOnSegment(edge, endpoint, RIGEL_DEFS.linkTolCm)) return;
    const angle = axisEdgeAngleDeg(axis, edge);
    if (!(angle > 2 && angle < 178)) return;
    link = { ot, id, z1 };
  };
  for (const wall of Object.values(model.walls ?? {})) {
    for (const [z1, edge] of wallEdgeSegments(wall)) match("wall", wall.id, z1, edge);
  }
  for (const pillar of Object.values(model.pillars ?? {})) {
    for (const [z1, edge] of pillarEdgeSegments(pillar)) match("pillar", pillar.id, z1, edge);
  }
  for (const rigel of Object.values(model.rigels ?? {})) {
    if (rigel.id === selfId) continue;
    for (const [z1, edge] of rigelEdgeSegments(rigel)) match("rigel", rigel.id, z1, edge);
  }
  return link;
}

/** Боковые линии оси: параллели на ±depth/2 (как Rigel.getSts0/getPts0 редактора). */
function sideLines(p1: Point, p2: Point, depth: number): { l: Segment; r: Segment } {
  const axis: Segment = { p1, p2 };
  return {
    l: offsetSegment(axis, depth / 2),
    r: offsetSegment(axis, -depth / 2),
  };
}

/** Округление до 4 знаков (как LIB.l редактора для граней l/r). */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function roundSeg(s: Segment): { p1: Point; p2: Point } {
  return { p1: { x: round4(s.p1.x), y: round4(s.p1.y) }, p2: { x: round4(s.p2.x), y: round4(s.p2.y) } };
}

/** Гашение одинаковых связей (как в редакторе): у обоих концов тот же id и z1 → p2.link = 0. */
export function cancelSameLinks(
  l1: RigelLink | 0,
  l2: RigelLink | 0,
): { p1: RigelLink | 0; p2: RigelLink | 0 } {
  if (l1 !== 0 && l2 !== 0 && l1.id === l2.id && l1.z1 === l2.z1) return { p1: l1, p2: 0 };
  return { p1: l1, p2: l2 };
}

/**
 * Полигон ригеля (как Rigel.calc редактора): концы, привязанные к грани,
 * срезаются по линии грани (пересечение боковой параллели с линией грани).
 */
function buildPolygon(
  p1: Point,
  p2: Point,
  depth: number,
  model: Model,
  selfId: string,
  links: { p1: RigelLink | 0; p2: RigelLink | 0 },
): { polygon: Point[]; l: { p1: Point; p2: Point }; r: { p1: Point; p2: Point } } {
  const sides = sideLines(p1, p2, depth);
  let l1: Point = { ...sides.l.p1 };
  let l2: Point = { ...sides.l.p2 };
  let r1: Point = { ...sides.r.p1 };
  let r2: Point = { ...sides.r.p2 };
  const edgeLine = (link: RigelLink | 0): Segment | null => {
    if (!link) return null;
    if (link.ot === "wall") {
      const wall = model.walls[link.id];
      if (!wall) return null;
      for (const [z1, edge] of wallEdgeSegments(wall)) if (z1 === link.z1) return edge;
      return null;
    }
    if (link.ot === "pillar") {
      const pillar = model.pillars[link.id];
      if (!pillar) return null;
      for (const [z1, edge] of pillarEdgeSegments(pillar)) if (z1 === link.z1) return edge;
      return null;
    }
    const rigel = model.rigels?.[link.id];
    if (!rigel || rigel.id === selfId) return null;
    for (const [z1, edge] of rigelEdgeSegments(rigel)) if (z1 === link.z1) return edge;
    return null;
  };
  const trimEnd = (link: RigelLink | 0): { a: Point; b: Point } | null => {
    const edge = edgeLine(link);
    if (!edge) return null;
    // как в редакторе: l1 = пересечение sts.l с линией грани, r1 = sts.r с линией грани
    const a = lineIntersection(sides.l, edge);
    const b = lineIntersection(sides.r, edge);
    if (!a || !b) return null;
    return { a, b };
  };
  const trimP1 = trimEnd(links.p1);
  if (trimP1) {
    l1 = trimP1.a;
    r1 = trimP1.b;
  }
  const trimP2 = trimEnd(links.p2);
  if (trimP2) {
    l2 = trimP2.a;
    r2 = trimP2.b;
  }
  return { polygon: [l1, l2, r2, r1], l: { p1: l1, p2: l2 }, r: { p1: r1, p2: r2 } };
}

/** Проверка оси: конечные точки и ненулевая длина (иначе restore/расчёт редактора падает). */
function assertAxis(p1: Point, p2: Point): void {
  for (const [name, pt] of [["p1", p1], ["p2", p2]] as const) {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      throw new McpError("INVALID_ARGUMENT", `${name}: координаты оси должны быть конечными числами`);
    }
  }
  if (dist(p1, p2) < 1e-6) {
    throw new McpError("INVALID_ARGUMENT", "начало и конец оси ригеля совпадают — задайте ось ненулевой длины");
  }
}

/** Все грани-кандидаты для магнита: стены (l/r/s/e), колонны (t/r/b/l), ригели (l/r/s/e). */
function allEdgeSegments(model: Model, selfId: string): { ot: RigelLink["ot"]; id: string; z1: string; edge: Segment }[] {
  const out: { ot: RigelLink["ot"]; id: string; z1: string; edge: Segment }[] = [];
  for (const wall of Object.values(model.walls ?? {})) {
    for (const [z1, edge] of wallEdgeSegments(wall)) out.push({ ot: "wall", id: wall.id, z1, edge });
  }
  for (const pillar of Object.values(model.pillars ?? {})) {
    for (const [z1, edge] of pillarEdgeSegments(pillar)) out.push({ ot: "pillar", id: pillar.id, z1, edge });
  }
  for (const rigel of Object.values(model.rigels ?? {})) {
    if (rigel.id === selfId) continue;
    for (const [z1, edge] of rigelEdgeSegments(rigel)) out.push({ ot: "rigel", id: rigel.id, z1, edge });
  }
  return out;
}

/**
 * Магнит конца оси (как в UI): конец в пределах snapTolCm от конечного отрезка грани,
 * ось не параллельна грани (угол 2..178°) → конец проецируется на грань перпендикулярно
 * (только внутрь отрезка). Возвращает точку после прилипания и связь (или 0).
 */
function snapEndpoint(
  pt: Point,
  other: Point,
  model: Model,
  selfId: string,
): { pt: Point; link: RigelLink | 0 } {
  const axis: Segment = { p1: pt, p2: other };
  let best: { d: number; point: Point; link: RigelLink } | null = null;
  for (const { ot, id, z1, edge } of allEdgeSegments(model, selfId)) {
    const angle = axisEdgeAngleDeg(axis, edge);
    if (!(angle > 2 && angle < 178)) continue;
    const cp = closestPoint(edge, pt);
    if (cp.t <= 0 || cp.t >= 1) continue; // магнит внутрь грани, не к её концам
    const d = dist(cp.point, pt);
    if (d > RIGEL_DEFS.snapTolCm) continue;
    if (!best || d < best.d) best = { d, point: cp.point, link: { ot, id, z1 } };
  }
  if (best) {
    return { pt: { x: r2(best.point.x), y: r2(best.point.y) }, link: best.link };
  }
  return { pt: { x: r2(pt.x), y: r2(pt.y) }, link: 0 };
}

/** Собирает кандидат-копию ригеля (связи, полигон) без записи в модель. */
function buildCandidate(
  model: Model,
  id: string,
  p1Cm: Point,
  p2Cm: Point,
  depth: number,
  height: number,
  ceilingType: string,
  snap: boolean = true,
): Rigel {
  assertAxis(p1Cm, p2Cm);
  // магнит концов к граням (как в UI); связь — по предикату конечных отрезков
  const snap1 = snap ? snapEndpoint(p1Cm, p2Cm, model, id) : { pt: { x: r2(p1Cm.x), y: r2(p1Cm.y) }, link: 0 as const };
  const snap2 = snap ? snapEndpoint(p2Cm, snap1.pt, model, id) : { pt: { x: r2(p2Cm.x), y: r2(p2Cm.y) }, link: 0 as const };
  const candidate: Rigel = {
    id,
    p1: { ...snap1.pt, link: 0 },
    p2: { ...snap2.pt, link: 0 },
    height: r2(height),
    depth: r2(depth),
    ceiling_type: ceilingType,
    polygon: [],
    l: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 } },
    r: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 } },
  };
  // ревью 48 №3: ось после магнита и округления — до записи любых полей
  assertAxis(candidate.p1, candidate.p2);
  const axis: Segment = { p1: candidate.p1, p2: candidate.p2 };
  const canceled = cancelSameLinks(rigelLink(candidate.p1, axis, model, id), rigelLink(candidate.p2, axis, model, id));
  candidate.p1.link = canceled.p1;
  candidate.p2.link = canceled.p2;
  const shape = buildPolygon(candidate.p1, candidate.p2, candidate.depth, model, id, {
    p1: candidate.p1.link,
    p2: candidate.p2.link,
  });
  candidate.polygon = shape.polygon;
  candidate.l = roundSeg(shape.l);
  candidate.r = roundSeg(shape.r);
  return candidate;
}

/** Переносит проверенного кандидата в модель, сохраняя identity (паттерн assignPillar). */
function assignRigel(target: Rigel, candidate: Rigel): void {
  const keys = new Set([...Object.keys(target), ...Object.keys(candidate)]);
  for (const k of keys) {
    if (k in candidate) (target as Record<string, unknown>)[k] = (candidate as Record<string, unknown>)[k];
    else delete (target as Record<string, unknown>)[k];
  }
}

/**
 * rigel_add: ставит потолочный ригель (мм): ось start→end, толщина depth_mm
 * (по умолчанию 300), высота height_mm (по умолчанию 300). Концы при расстоянии
 * ≤ 30 мм от грани стены/колонны/ригеля прилипают к ней, как в UI.
 * Ревью 48 №1: вход в общую атомарную финализацию — зависимые ригели
 * пересчитывают связи и полигоны; при ошибке модель идентична snapshot.
 */
export function addRigel(model: Model, params: AddRigarParams): Rigel {
  validateRigelsParams(params);
  const p1Cm = { x: mmToCm(params.start.x), y: mmToCm(params.start.y) };
  const p2Cm = { x: mmToCm(params.end.x), y: mmToCm(params.end.y) };
  const depth = params.depthMm !== undefined ? mmToCm(params.depthMm) : RIGEL_DEFS.depthCm;
  const height = params.heightMm !== undefined ? mmToCm(params.heightMm) : RIGEL_DEFS.heightCm;
  // ось проверяем до создания коллекции: при ошибке модель не меняется вовсе
  assertAxis(p1Cm, p2Cm);
  const candidate = buildCandidate(model, newId(10), p1Cm, p2Cm, depth, height, params.ceilingType ?? "");
  const hadRigels = model.rigels !== undefined;
  const backup = hadRigels ? structuredClone(model.rigels) : undefined;
  model.rigels ??= {};
  try {
    model.rigels[candidate.id] = candidate;
    refreshRigelsAfterWallOrPillarChange(model);
  } catch (e) {
    if (backup) model.rigels = backup;
    else delete model.rigels;
    throw e;
  }
  return candidate;
}

/**
 * rigel_update: меняет ось/толщину/высоту/тип отделки с пересчётом связей и полигона.
 * Мм→см только для явно переданных значений; candidate-копия, при ошибке модель не меняется.
 */
export function updateRigel(model: Model, params: UpdateRigarParams): Rigel {
  const rigel = model.rigels?.[params.rigelId];
  if (!rigel) throw new McpError("NOT_FOUND", `ригель ${params.rigelId} не найден`);
  validateRigelsParams(params);
  const candidate = structuredClone(rigel);
  if (params.start !== undefined) candidate.p1 = { x: r2(mmToCm(params.start.x)), y: r2(mmToCm(params.start.y)), link: candidate.p1.link ?? 0 };
  if (params.end !== undefined) candidate.p2 = { x: r2(mmToCm(params.end.x)), y: r2(mmToCm(params.end.y)), link: candidate.p2.link ?? 0 };
  if (params.depthMm !== undefined) candidate.depth = r2(mmToCm(params.depthMm));
  if (params.heightMm !== undefined) candidate.height = r2(mmToCm(params.heightMm));
  if (params.ceilingType !== undefined) candidate.ceiling_type = params.ceilingType;
  const moved = params.start !== undefined || params.end !== undefined;
  const rebuilt = buildCandidate(model, candidate.id, candidate.p1, candidate.p2, candidate.depth, candidate.height, candidate.ceiling_type, moved);
  rebuilt.id = candidate.id;
  // ревью 48 №1: изменённый ригель входит в общую атомарную финализацию —
  // зависимые ригели пересчитываются; при ошибке модель идентична snapshot
  const backup = structuredClone(model.rigels ?? {});
  try {
    assignRigel(rigel, rebuilt);
    refreshRigelsAfterWallOrPillarChange(model);
  } catch (e) {
    model.rigels = backup;
    throw e;
  }
  return rigel;
}

/** rigel_delete: удаляет ригель с атомарным пересчётом зависимых ригелей (ревью 48 №1). */
export function deleteRigel(model: Model, rigelId: string): void {
  if (!model.rigels?.[rigelId]) throw new McpError("NOT_FOUND", `ригель ${rigelId} не найден`);
  const backup = structuredClone(model.rigels);
  try {
    delete model.rigels[rigelId];
    refreshRigelsAfterWallOrPillarChange(model);
  } catch (e) {
    model.rigels = backup;
    throw e;
  }
}

/**
 * Пересчёт связей ригелей после изменения стен/колонн/ригелей (этап 47; ревью 48
 * №1 и №2): связи, указывающие на изменившиеся/удалённые грани, пересчитываются
 * предикатом Rigel.link, а у ригелей с ненулевыми связями пересчитывается форма
 * (polygon/l/r) даже при неизменных id/z1 — геометрия связанной грани могла
 * измениться (поворот колонны, перенос стены). Ригели с погашенными связями
 * (обе 0) и без изменений не трогаются — побайтово прежние. Положение ригеля
 * (p1/p2) редактор не двигает — связи не притягивают ригель. Ошибок не даёт
 * (модель не меняется при невозможности пересчёта — связи просто гасятся).
 * Вызывается внутри atomic() стен и атомарных операций колонн и ригелей.
 */
export function refreshRigelsAfterWallOrPillarChange(model: Model): void {
  const rigels = model.rigels;
  if (!rigels || Object.keys(rigels).length === 0) return;
  for (const rigel of Object.values(rigels)) {
    const axis: Segment = { p1: rigel.p1, p2: rigel.p2 };
    const canceled = cancelSameLinks(rigelLink(rigel.p1, axis, model, rigel.id), rigelLink(rigel.p2, axis, model, rigel.id));
    const link1 = canceled.p1;
    const link2 = canceled.p2;
    const linksSame =
      JSON.stringify(rigel.p1.link ?? 0) === JSON.stringify(link1) &&
      JSON.stringify(rigel.p2.link ?? 0) === JSON.stringify(link2);
    if (linksSame && link1 === 0 && link2 === 0) {
      continue; // несвязанный ригель не трогаем (байт в байт)
    }
    const candidate = structuredClone(rigel);
    candidate.p1.link = link1;
    candidate.p2.link = link2;
    const shape = buildPolygon(candidate.p1, candidate.p2, candidate.depth, model, candidate.id, {
      p1: link1,
      p2: link2,
    });
    candidate.polygon = shape.polygon;
    candidate.l = roundSeg(shape.l);
    candidate.r = roundSeg(shape.r);
    if (
      linksSame &&
      sameShape(candidate.polygon, rigel.polygon) &&
      samePoint(candidate.l.p1, rigel.l.p1) && samePoint(candidate.l.p2, rigel.l.p2) &&
      samePoint(candidate.r.p1, rigel.r.p1) && samePoint(candidate.r.p2, rigel.r.p2)
    ) {
      continue; // связи и форма не изменились — ригель не трогаем (байт в байт)
    }
    assignRigel(rigel, candidate);
  }
}

/** Совпадение точек с допуском (шум точности редактора не считается изменением). */
function samePoint(a: Point, b: Point, tol = 1e-3): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}

function sameShape(a: Point[], b: Point[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => samePoint(p, b[i]!));
}
