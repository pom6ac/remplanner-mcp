import type { Model, Point } from "./types.ts";
import { newId } from "./types.ts";
import { roundTenthMm as r2 } from "./units.ts";
import { edgeInwardNormal } from "./rooms.ts";
import { zoneDelimiterList } from "./zone.ts";
import { ceilingRigelList } from "./ceiling-rigels.ts";
import {
  canonicalPolygon, polygonsEqual, roomPolygonOf, matchRoomsByContour,
  signedArea, distToChord, removeCollinear, polygonArea, polygonEdgesOf,
} from "./room-geo.ts";
export {
  canonicalPolygon, polygonsEqual, roomPolygonOf, matchRoomsByContour,
};
import { McpError } from "../errors.ts";

// Отделка (фаза 2, раздел «Отделка», этап 94, 2026-11-17). Материалы/покрытия
// пола, стен и потолка хранятся редактором не отдельными коллекциями, а в комнатах
// (rooms2, при листе init — rooms1): floors[0] — покрытие пола комнаты,
// ceilings[0] — покрытие потолка, decors[i] — отделка стороны стены по ребру i
// (decors выровнен по edges комнаты, у каждого ребра pid — id стены).
// Эталоны UI: tests/fixtures/ui-ref-finish-*.json (этап 94).
//
// Публичный API — только ключи материалов (как в UI: пункт листа) и параметры в мм;
// формат редактора (patch, polygons_layout, line_decor) в API не протекает.

/** Покрытия пола (лист «Напольные покрытия», без плинтусов — они отдельные PRO-пункты). */
export const FLOOR_COVERS = [
  "laminate", "laminate_corky", "laminate_vinyl", "laminate_quartz_vinyl", "laminate_spc", "laminate_pvh",
  "parquet_board", "engineer_board", "wood_board", "parquet", "terrace_board",
  "floor_tile", "stoneware_wood", "stoneware_marble", "metlah", "mosaic", "hex_tile",
  "linoleum", "fitted_carpet", "corky_floor", "floor_3d",
] as const;

/** Отделка стен (лист «Отделка стен»). Двухслойные пункты UI painting_tile/
 *  wallpaper_tiles (плитка+краска/обои) и фартук wall_apron пишутся двумя/одним
 *  слоем decors (layer 1/2) — setWallFinish, эталоны 245f5. */
export const WALL_COVERS = [
  "wallpaper", "wallpaper_for_paint", "paint_wall", "walls_whitewash", "wall_chalk_paint",
  "wall_tile", "wall_mosaic", "wall_clinker", "wall_stone", "wall_wooden_panels", "plastic_panels",
  "wall_woodbatten", "wall_sheet_panels", "wall_tile_panels", "decorative_plaster", "venice_plaster",
  "painting_tile", "wallpaper_tiles", "wall_apron",
] as const;

/** Двухслойные пункты UI: слой 1 — wall_tile, слой 2 — краска/обои (фартук — только слой 2). */
export const WALL_TWO_LAYER = ["painting_tile", "wallpaper_tiles", "wall_apron"] as const;

/** Покрытия потолка (лист «Потолки», простые; многоуровневые complex_ceiling/ниши — следующий PR). */
export const CEILING_COVERS = [
  "paint_ceiling", "whitewash_ceiling", "gypsum_ceiling", "stretch_ceiling", "stretch_ceiling_tissue",
  "rack_ceiling", "wooden_ceiling", "plastic_panels_ceiling", "armstrong_ceiling", "grillato_ceiling",
] as const;

/** Раскладка покрытия пола (type_laying редактора): доска — 1/2 или 1/3, плитка — tile. */
export const FLOOR_TYPE_LAYINGS = ["1/2", "1/3", "tile", "line"] as const;

/** Покрытия-плитка: раскладка tile; доска/панель: 1/2, 1/3 (line — везде). */
const TILE_FLOOR_COVERS = new Set(["floor_tile", "stoneware_wood", "stoneware_marble", "metlah", "mosaic", "hex_tile"]);
const BOARD_FLOOR_COVERS = new Set([
  "laminate", "laminate_corky", "laminate_vinyl", "laminate_quartz_vinyl", "laminate_spc", "laminate_pvh",
  "parquet_board", "engineer_board", "wood_board", "parquet", "terrace_board",
]);

/** Профили потолка, известные из проб редактора (94-options-panel, эталон ui-ref-finish-ceiling).
 *  Разведка 245: в бандле редактора других значений profile нет (только "standard"). */
export const CEILING_PROFILES = ["standard"] as const;

/** Напольные плинтусы (лист «Напольные покрытия», группа molding — все PRO; эталоны 245). */
export const FLOOR_MOLDING_TYPES = [
  "floor_molding_plastic", "floor_molding_polyurethane", "floor_molding_mdf", "floor_molding_wood",
  "floor_molding_tile", "floor_molding_with_light", "floor_molding_hidden",
] as const;

/** Потолочный плинтус (инструмент molding листа «Потолки», PRO) — один тип части. */
export const CEILING_MOLDING_TYPE = "molding";

/** Разумные пределы пользовательских параметров (ревью 95 R5): мм. */
export const FINISH_LIMITS = {
  plankMinMm: 1, plankMaxMm: 10_000,
  stitchMaxMm: 100,
  wallHeightMaxMm: 30_000,
  ceilingLevelMax: 20,
  /** Минимальная длина ребра для плинтуса (UI: отрезок короче ~20 см не создаётся, проба 245). */
  moldingEdgeMinMm: 250,
  /** Минимальная длина ребра для закарнизной ниши (UI: > 1.5*depth = 30 см). */
  nicheEdgeMinMm: 300,
} as const;

/** Геометрия частей по эталонам 245 (см): отступ линии от ребра внутрь комнаты и подрезка.
 *  ДОПУЩЕНИЕ (ревью 246 №7): отступы 6/5 см в «эталонах UI» задала сама проба
 *  (create_line ins(0.3, 6/5)); UI-отступ кликами офлайн не снят — значения приняты
 *  как допущение, сверка покрытия рёбер допускает штатный отступ ±6 см (PERP_TOL). */
export const FINISH_GEOMETRY = {
  /** Напольный плинтус: линия в 6 см от грани (эталон 245f4: x=284 у ребра x=290; отступ задан пробой). */
  floorMoldingInsetCm: 6,
  /** Потолочный плинтус и слои отделки стен: линия в 5 см от грани (эталон 245f5; отступ задан пробой). */
  ceilingMoldingInsetCm: 5,
  decorInsetCm: 5,
  /** Закарнизная ниша: линия короче ребра на 2.5 см с каждого конца (бандл, cursor_click). */
  nicheEndTrimCm: 2.5,
  /** Закарнизная ниша: глубина по умолчанию (defs.ceiling_niche.depth). */
  nicheDepthCm: 20,
  /** Фартук (wall_apron): слой 2, от пола 92 см, высота 60 см (эталон 245f5, decor-2 бандла). */
  apronFromFloorCm: 92,
  apronHeightCm: 60,
  /** Второй слой painting_tile/wallpaper_tiles: краска/обои от 120 см до верха (бандл decor-2). */
  twoLayerFromFloorCm: 120,
} as const;

export type FloorCover = (typeof FLOOR_COVERS)[number];
export type WallCover = (typeof WALL_COVERS)[number];
export type CeilingCover = (typeof CEILING_COVERS)[number];

export type RoomRec = {
  polygon?: Point[];
  points?: Point[];
  area?: number;
  pc?: Point;
  edges?: Array<{ p1?: Point; p2?: Point; length?: number; pid?: string; room_side?: string; side?: string }>;
  floors?: Array<Record<string, unknown>>;
  ceilings?: Array<Record<string, unknown>>;
  decors?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type RoomsMap = Record<string, RoomRec>;

function roomsOf(model: Model): RoomsMap {
  return (model.rooms2 ?? model.rooms1 ?? {}) as RoomsMap;
}

/** Комната по id сайта или метке R<n> (порядок — как в model_get). */
export function resolveRoom(model: Model, ref: string): { id: string; room: RoomRec } {
  const rooms = roomsOf(model);
  if (rooms[ref]) return { id: ref, room: rooms[ref]! };
  const m = /^R(\d+)$/.exec(ref);
  if (m) {
    const list = Object.entries(rooms);
    const found = list[Number(m[1]) - 1];
    if (found) return { id: found[0], room: found[1] };
  }
  throw new McpError("NOT_FOUND", `комната ${ref} не найдена (id сайта из model_get или метка R<n>)`);
}

function floorEntry(cover: string, room: RoomRec, id: string, extra: Record<string, unknown>): Record<string, unknown> {
  const polygon = room.polygon ?? room.points ?? [];
  return {
    exist: true,
    id,
    polygon: polygon.map((p) => ({ x: r2(p.x), y: r2(p.y) })),
    cover,
    ...(room.pc ? { pc: { x: r2(room.pc.x), y: r2(room.pc.y) } } : {}),
    ...extra,
  };
}

export type FloorFinishParams = {
  /** мм (в модели см). */
  plankLengthMm?: number;
  /** мм (в модели см). */
  plankWidthMm?: number;
  /** мм (в модели см). */
  stitchWidthMm?: number;
  angleDeg?: number;
  typeLaying?: (typeof FLOOR_TYPE_LAYINGS)[number];
};

/** Записать/заменить покрытие пола комнаты (rooms2[room].floors[0]). */
export function setFloorFinish(model: Model, roomRef: string, cover: FloorCover, params: FloorFinishParams): { id: string } {
  if (!(FLOOR_COVERS as readonly string[]).includes(cover)) {
    throw new McpError("INVALID_ARGUMENT", `неизвестное покрытие пола «${cover}» (допустимо: ${FLOOR_COVERS.join(", ")})`);
  }
  const { id, room } = resolveRoom(model, roomRef);
  const extra: Record<string, unknown> = {};
  if (params.angleDeg !== undefined) {
    if (!Number.isFinite(params.angleDeg)) throw new McpError("INVALID_ARGUMENT", "angle_deg должен быть конечным числом");
    extra.angle = params.angleDeg;
  }
  for (const [key, v] of [["plank_length_mm", params.plankLengthMm], ["plank_width_mm", params.plankWidthMm]] as const) {
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v < FINISH_LIMITS.plankMinMm || v > FINISH_LIMITS.plankMaxMm) {
      throw new McpError("INVALID_ARGUMENT", `${key} должен быть числом от ${FINISH_LIMITS.plankMinMm} до ${FINISH_LIMITS.plankMaxMm} мм`);
    }
  }
  if (params.stitchWidthMm !== undefined && (params.stitchWidthMm < 0 || params.stitchWidthMm > FINISH_LIMITS.stitchMaxMm)) {
    throw new McpError("INVALID_ARGUMENT", `stitch_width_mm должен быть от 0 до ${FINISH_LIMITS.stitchMaxMm} мм`);
  }
  if (params.typeLaying !== undefined) {
    if (params.typeLaying === "tile" && !TILE_FLOOR_COVERS.has(cover)) {
      throw new McpError("INVALID_ARGUMENT", `раскладка tile применима только к плиточным покрытиям (${[...TILE_FLOOR_COVERS].join(", ")}), а не к ${cover}`);
    }
    if ((params.typeLaying === "1/2" || params.typeLaying === "1/3") && !BOARD_FLOOR_COVERS.has(cover)) {
      throw new McpError("INVALID_ARGUMENT", `раскладка ${params.typeLaying} применима только к доске/панели, а не к ${cover}`);
    }
  }
  if (params.plankLengthMm !== undefined) extra.width = r2(params.plankLengthMm / 10);
  if (params.plankWidthMm !== undefined) extra.height = r2(params.plankWidthMm / 10);
  if (params.stitchWidthMm !== undefined) extra.stitch_width = r2(params.stitchWidthMm / 10);
  if (params.typeLaying !== undefined) extra.type_laying = params.typeLaying;
  const floors = Array.isArray(room.floors) ? [...room.floors] : [];
  while (floors.length < 1) floors.push({ exist: false });
  floors[0] = floorEntry(cover, room, `_f${newId(8)}`, extra);
  room.floors = floors;
  return { id: floors[0]!.id as string };
}

/** Снять покрытие пола комнаты. */
export function removeFloorFinish(model: Model, roomRef: string): void {
  const { room } = resolveRoom(model, roomRef);
  const polygon = room.polygon ?? room.points ?? [];
  const floors = Array.isArray(room.floors) ? [...room.floors] : [];
  while (floors.length < 1) floors.push({ exist: false });
  floors[0] = { exist: false, polygon: polygon.map((p) => ({ x: r2(p.x), y: r2(p.y) })) };
  room.floors = floors;
}

export type WallFinishParams = {
  /** мм от пола до низа отделки (в модели см; 0 — от пола). */
  heightFromFloorMm?: number;
  /** мм высота отделки (в модели см; 0 — на всю высоту стены). */
  heightMm?: number;
};

/** Линия, параллельная ребру комнаты, со смещением внутрь комнаты (insetCm)
 *  и подрезкой концов (trimCm с каждого конца). Направление внутрь — общим
 *  помощником edgeInwardNormal (проба точки на ε от середины ребра, как
 *  inwardSideByProbe для стен; ревью 246 №3: по центроиду вогнутая комната
 *  уводила линию ребра выемки наружу), запасное правило — ориентация полигона. */
function edgeInsetLine(room: RoomRec, edge: { p1?: Point; p2?: Point }, insetCm: number, trimCm = 0): { p1: Point; p2: Point } {
  const p1 = edge.p1 ?? { x: 0, y: 0 };
  const p2 = edge.p2 ?? { x: 0, y: 0 };
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (len < 1e-9) return { p1: { x: r2(p1.x), y: r2(p1.y) }, p2: { x: r2(p2.x), y: r2(p2.y) } };
  const poly = (room.polygon ?? room.points ?? []) as Point[];
  const nx = (p2.y - p1.y) / len, ny = -(p2.x - p1.x) / len;
  let ix = nx, iy = ny;
  const inward = edgeInwardNormal(p1, p2, poly);
  if (inward) {
    ix = inward.x; iy = inward.y;
  } else if (poly.length >= 3 && signedArea(poly) > 0) {
    // полигон против часовой стрелки: внутренность слева от направления ребра
    ix = -nx; iy = -ny;
  }
  const t1 = Math.min(trimCm / len, 0.5), t2 = Math.max(1 - trimCm / len, 0.5);
  return {
    p1: { x: r2(p1.x + (p2.x - p1.x) * t1 + ix * insetCm), y: r2(p1.y + (p2.y - p1.y) * t1 + iy * insetCm) },
    p2: { x: r2(p1.x + (p2.x - p1.x) * t2 + ix * insetCm), y: r2(p1.y + (p2.y - p1.y) * t2 + iy * insetCm) },
  };
}

function edgeLenCm(edge: { p1?: Point; p2?: Point }): number {
  const p1 = edge.p1, p2 = edge.p2;
  if (!p1 || !p2) return 0;
  return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

/** Контейнер-массив по рёбрам комнаты в форме пустого проекта ({exist:false}×n). */
function edgeContainer(room: RoomRec, key: string, edgesLen: number): Array<Record<string, unknown>> {
  const arr = Array.isArray(room[key]) ? [...(room[key] as Array<Record<string, unknown>>)] : [];
  while (arr.length < edgesLen) arr.push({ exist: false });
  return arr;
}

/** Рёбра комнаты, приходящиеся на стену wallId (сторона комнаты). */
function edgesOfWall(room: RoomRec, wallId: string): Array<{ edge: { p1?: Point; p2?: Point; pid?: string; length?: number }; index: number }> {
  const edges = Array.isArray(room.edges) ? room.edges : [];
  const out: Array<{ edge: { p1?: Point; p2?: Point; pid?: string; length?: number }; index: number }> = [];
  edges.forEach((e, index) => {
    if (e.pid === wallId) out.push({ edge: e, index });
  });
  return out;
}

/** Часть отрезка line между долями t1..t2 его длины. */
function lineOnSpan(line: { p1: Point; p2: Point }, t1: number, t2: number): { p1: Point; p2: Point } {
  return {
    p1: { x: r2(line.p1.x + (line.p2.x - line.p1.x) * t1), y: r2(line.p1.y + (line.p2.y - line.p1.y) * t1) },
    p2: { x: r2(line.p1.x + (line.p2.x - line.p1.x) * t2), y: r2(line.p1.y + (line.p2.y - line.p1.y) * t2) },
  };
}

function moldingPart(id: string, type: string, layer: number, line: { p1: Point; p2: Point }, lineWall: { p1: Point; p2: Point }): Record<string, unknown> {
  return {
    id, type, layer,
    line: { p1: { ...line.p1 }, p2: { ...line.p2 } },
    line_wall: { p1: { ...lineWall.p1 }, p2: { ...lineWall.p2 } },
    distance: r2(Math.hypot(line.p2.x - line.p1.x, line.p2.y - line.p1.y)),
  };
}

const MOLDING_MIN_ERROR = (kind: string) =>
  `ребро короче ${FINISH_LIMITS.moldingEdgeMinMm / 10} см — плинтус не ставится (${kind}); выберите стену длиннее`;

/** Отрезок вдоль ребра [t1..t2] (доли 0..1) из смещений от начала стороны, мм. */
function moldingSpan(edge: { p1?: Point; p2?: Point }, fromMm: number | undefined, toMm: number | undefined, minSegMm: number): [number, number] {
  const lenMm = edgeLenCm(edge) * 10;
  const t1 = Math.max(Math.min(fromMm ?? 0, lenMm), 0) / lenMm;
  const t2 = Math.max(Math.min(toMm ?? lenMm, lenMm), 0) / lenMm;
  if (t2 - t1 < minSegMm / lenMm) {
    throw new McpError("INVALID_ARGUMENT", `отрезок плинтуса короче ${minSegMm / 10} см (from_mm/to_mm по стороне от её начала)`);
  }
  return [t1, t2];
}

/** Записать напольный плинтус вдоль стороны стены комнаты (floorMoldings по рёбрам; PRO).
 *  from_mm/to_mm — границы отрезка по стороне от её начала (по умолчанию вся сторона). */
export function setFloorMolding(model: Model, roomRef: string, wallId: string, type: (typeof FLOOR_MOLDING_TYPES)[number], params: { fromMm?: number; toMm?: number } = {}): { parts: number } {
  if (!(FLOOR_MOLDING_TYPES as readonly string[]).includes(type)) {
    throw new McpError("INVALID_ARGUMENT", `неизвестный плинтус «${type}» (допустимо: ${FLOOR_MOLDING_TYPES.join(", ")})`);
  }
  const { room } = resolveRoom(model, roomRef);
  const targets = edgesOfWall(room, wallId);
  if (targets.length === 0) {
    throw new McpError("INVALID_ARGUMENT", `комната ${roomRef} не граничит со стеной ${wallId} (граничные стены — из finish_get/model_get)`);
  }
  for (const { edge } of targets) {
    if (edgeLenCm(edge) * 10 < FINISH_LIMITS.moldingEdgeMinMm) throw new McpError("INVALID_ARGUMENT", MOLDING_MIN_ERROR("floor_molding"));
  }
  const edges = Array.isArray(room.edges) ? room.edges : [];
  const moldings = edgeContainer(room, "floorMoldings", edges.length);
  for (const { edge, index } of targets) {
    const [t1, t2] = moldingSpan(edge, params.fromMm, params.toMm, 200);
    const line = edgeInsetLine(room, edge, FINISH_GEOMETRY.floorMoldingInsetCm);
    const seg = lineOnSpan(line, t1, t2);
    const id = `_fm${newId(8)}`;
    moldings[index] = { exist: true, parts: { [id]: moldingPart(id, type, 1, seg, { p1: { ...(edge.p1 as Point) }, p2: { ...(edge.p2 as Point) } }) } };
  }
  room.floorMoldings = moldings;
  return { parts: targets.length };
}

/** Снять напольные плинтусы комнаты: со всех сторон или только со стороны стены wallId. */
export function removeFloorMolding(model: Model, roomRef: string, wallId?: string): { parts: number } {
  const { room } = resolveRoom(model, roomRef);
  const edges = Array.isArray(room.edges) ? room.edges : [];
  const moldings = edgeContainer(room, "floorMoldings", edges.length);
  let n = 0;
  for (let i = 0; i < edges.length; i++) {
    if (wallId && edges[i]!.pid !== wallId) continue;
    if (moldings[i]!["exist"] !== true) continue;
    moldings[i] = { exist: false };
    n++;
  }
  if (wallId && n === 0) {
    throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomRef} нет плинтусов на стене ${wallId}`);
  }
  room.floorMoldings = moldings;
  return { parts: n };
}

/** Записать потолочный плинтус вдоль стороны стены комнаты (ceilingMoldings по рёбрам; PRO).
 *  from_mm/to_mm — границы отрезка по стороне от её начала (по умолчанию вся сторона). */
export function setCeilingMolding(model: Model, roomRef: string, wallId: string, params: { fromMm?: number; toMm?: number } = {}): { parts: number } {
  const { room } = resolveRoom(model, roomRef);
  const targets = edgesOfWall(room, wallId);
  if (targets.length === 0) {
    throw new McpError("INVALID_ARGUMENT", `комната ${roomRef} не граничит со стеной ${wallId} (граничные стены — из finish_get/model_get)`);
  }
  for (const { edge } of targets) {
    if (edgeLenCm(edge) * 10 < FINISH_LIMITS.moldingEdgeMinMm) throw new McpError("INVALID_ARGUMENT", MOLDING_MIN_ERROR("molding"));
  }
  const edges = Array.isArray(room.edges) ? room.edges : [];
  const moldings = edgeContainer(room, "ceilingMoldings", edges.length);
  for (const { edge, index } of targets) {
    const [t1, t2] = moldingSpan(edge, params.fromMm, params.toMm, 200);
    const line = edgeInsetLine(room, edge, FINISH_GEOMETRY.ceilingMoldingInsetCm);
    const seg = lineOnSpan(line, t1, t2);
    const id = `_cm${newId(8)}`;
    moldings[index] = { exist: true, parts: { [id]: moldingPart(id, CEILING_MOLDING_TYPE, 1, seg, { p1: { ...(edge.p1 as Point) }, p2: { ...(edge.p2 as Point) } }) } };
  }
  room.ceilingMoldings = moldings;
  return { parts: targets.length };
}

/** Снять потолочные плинтусы комнаты: со всех сторон или только со стороны стены wallId. */
export function removeCeilingMolding(model: Model, roomRef: string, wallId?: string): { parts: number } {
  const { room } = resolveRoom(model, roomRef);
  const edges = Array.isArray(room.edges) ? room.edges : [];
  const moldings = edgeContainer(room, "ceilingMoldings", edges.length);
  let n = 0;
  for (let i = 0; i < edges.length; i++) {
    if (wallId && edges[i]!.pid !== wallId) continue;
    if (moldings[i]!["exist"] !== true) continue;
    moldings[i] = { exist: false };
    n++;
  }
  if (wallId && n === 0) {
    throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomRef} нет потолочных плинтусов на стене ${wallId}`);
  }
  room.ceilingMoldings = moldings;
  return { parts: n };
}

/** Потолки, на которые нельзя ставить закарнизную нишу (правило UI, бандл cursor_click). */
const NICHE_FORBIDDEN_MATERIALS = new Set(["paint_ceiling", "whitewash_ceiling"]);

/** Добавить закарнизную нишу вдоль стороны стены комнаты (ceilings[0].niches; PRO).
 *  Зонированный потолок (после пересчёта зон, ревью 311 №1): ниша ставится в каждую
 *  зону, чьё ребро лежит на стороне стены (линия — по ребру зоны, как в UI). */
export function addCeilingNiche(model: Model, roomRef: string, wallId: string): { id: string } {
  const { id: roomId, room } = resolveRoom(model, roomRef);
  const ceilings = Array.isArray(room.ceilings) ? room.ceilings : [];
  const targets = edgesOfWall(room, wallId);
  if (targets.length === 0) {
    throw new McpError("INVALID_ARGUMENT", `комната ${roomRef} не граничит со стеной ${wallId} (граничные стены — из finish_get/model_get)`);
  }
  /** Ребро зоны лежит на ребре комнаты (коллинеарно, в допуске UI-магнита). */
  const onEdge = (e: { p1?: Point; p2?: Point }, base: { p1?: Point; p2?: Point }): boolean =>
    Boolean(e.p1 && e.p2 && base.p1 && base.p2 &&
      projD(e.p1, base.p1, base.p2) <= 0.05 && projD(e.p2, base.p1, base.p2) <= 0.05);
  if (ceilings.length > 1) {
    const zones = ceilings.filter((c) => (c as Record<string, unknown> | undefined)?.exist === true) as Array<Record<string, unknown>>;
    if (zones.length === 0) {
      throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomRef} нет покрытия потолка — сначала finish_ceiling_set (в UI: «сначала добавьте потолок»)`);
    }
    for (const zone of zones) {
      if (typeof zone["material"] === "string" && NICHE_FORBIDDEN_MATERIALS.has(zone["material"])) {
        throw new McpError("INVALID_ARGUMENT", `закарнизная ниша не ставится на ${zone["material"]} (в UI доступна только для встраиваемых потолков)`);
      }
    }
    let id = "";
    let placed = 0;
    for (const zone of zones) {
      const zoneEdges = Array.isArray(zone["edges"]) ? zone["edges"] as Array<{ p1?: Point; p2?: Point }> : [];
      for (let j = 0; j < zoneEdges.length; j++) {
        const ze = zoneEdges[j]!;
        const host = targets.find(({ edge }) => onEdge(ze, edge));
        if (!host) continue;
        if (edgeLenCm(ze) * 10 < FINISH_LIMITS.nicheEdgeMinMm) {
          throw new McpError("INVALID_ARGUMENT", `ребро короче ${FINISH_LIMITS.nicheEdgeMinMm / 10} см — ниша не ставится; выберите стену длиннее`);
        }
        const line = edgeInsetLine(room, ze, 0, FINISH_GEOMETRY.nicheEndTrimCm);
        id = `_ni${newId(8)}`;
        const niches = edgeContainer(zone as RoomRec, "niches", zoneEdges.length);
        niches[j] = {
          exist: true,
          parts: {
            [id]: {
              is_class: true, id, id_old: "", plan: "ceiling",
              id_room: roomId,
              id_ceiling: zone["id"],
              line: { p1: { ...line.p1 }, p2: { ...line.p2 } },
              line_wall: { p1: { ...(ze.p1 as Point) }, p2: { ...(ze.p2 as Point) } },
              polygon: [], width: 0, area: 0, depth: FINISH_GEOMETRY.nicheDepthCm,
            },
          },
        };
        zone["niches"] = niches;
        placed += 1;
      }
    }
    if (placed === 0) {
      throw new McpError("INVALID_ARGUMENT", `у зон потолка комнаты ${roomRef} нет ребра на стене ${wallId} — ниша не ставится`);
    }
    return { id };
  }
  const c0 = ceilings[0] as Record<string, unknown> | undefined;
  if (!c0 || c0.exist !== true) {
    throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomRef} нет покрытия потолка — сначала finish_ceiling_set (в UI: «сначала добавьте потолок»)`);
  }
  if (typeof c0.material === "string" && NICHE_FORBIDDEN_MATERIALS.has(c0.material)) {
    throw new McpError("INVALID_ARGUMENT", `закарнизная ниша не ставится на ${c0.material} (в UI доступна только для встраиваемых потолков)`);
  }
  for (const { edge } of targets) {
    if (edgeLenCm(edge) * 10 < FINISH_LIMITS.nicheEdgeMinMm) {
      throw new McpError("INVALID_ARGUMENT", `ребро короче ${FINISH_LIMITS.nicheEdgeMinMm / 10} см — ниша не ставится; выберите стену длиннее`);
    }
  }
  const edges = Array.isArray(room.edges) ? room.edges : [];
  const niches = edgeContainer(c0 as RoomRec, "niches", edges.length);
  let id = "";
  for (const { edge, index } of targets) {
    const line = edgeInsetLine(room, edge, 0, FINISH_GEOMETRY.nicheEndTrimCm);
    id = `_ni${newId(8)}`;
    niches[index] = {
      exist: true,
      parts: {
        [id]: {
          is_class: true, id, id_old: "", plan: "ceiling",
          id_room: resolveRoom(model, roomRef).id,
          id_ceiling: c0["id"],
          line: { p1: { ...line.p1 }, p2: { ...line.p2 } },
          line_wall: { p1: { ...(edge.p1 as Point) }, p2: { ...(edge.p2 as Point) } },
          polygon: [], width: 0, area: 0, depth: FINISH_GEOMETRY.nicheDepthCm,
        },
      },
    };
  }
  c0["niches"] = niches;
  return { id };
}

/** Убрать закарнизные ниши комнаты: со всех сторон или только со стороны стены wallId.
 *  Зонированный потолок: ниши снимаются во всех записях (ребро зоны — по геометрии
 *  на стороне стены; ревью 311 №1). */
export function removeCeilingNiche(model: Model, roomRef: string, wallId?: string): { parts: number } {
  const { room } = resolveRoom(model, roomRef);
  const ceilings = Array.isArray(room.ceilings) ? room.ceilings : [];
  const edges = Array.isArray(room.edges) ? room.edges : [];
  const targets = wallId ? edgesOfWall(room, wallId) : [];
  if (wallId && targets.length === 0) {
    throw new McpError("INVALID_ARGUMENT", `комната ${roomRef} не граничит со стеной ${wallId} (граничные стены — из finish_get/model_get)`);
  }
  const onEdge = (p: Point, base: { p1?: Point; p2?: Point }): boolean =>
    Boolean(base.p1 && base.p2 && projD(p, base.p1, base.p2) <= 0.05);
  let n = 0;
  if (ceilings.length > 1) {
    for (const rec of ceilings) {
      const c = rec as Record<string, unknown> | undefined;
      const recEdges = c && Array.isArray(c["edges"]) ? c["edges"] as Array<{ p1?: Point; p2?: Point }> : [];
      if (!c || !Array.isArray(c["niches"])) continue;
      const niches = [...c["niches"] as Array<Record<string, unknown>>];
      for (let i = 0; i < niches.length; i++) {
        const cont = niches[i];
        if (!cont || cont.exist !== true) continue;
        const parts = (cont.parts ?? {}) as Record<string, Record<string, unknown>>;
        const hit = wallId
          ? Object.values(parts).some((part) => {
              const line = part["line"] as { p1?: Point; p2?: Point } | undefined;
              return Boolean(line?.p1 && line?.p2 && targets.some(({ edge }) => onEdge(line.p1!, edge) && onEdge(line.p2!, edge)));
            })
          : true;
        if (!hit) continue;
        niches[i] = { exist: false };
        n++;
      }
      c["niches"] = niches;
    }
    if (wallId && n === 0) {
      throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomRef} нет ниш на стене ${wallId}`);
    }
    return { parts: n };
  }
  const c0 = ceilings[0] as Record<string, unknown> | undefined;
  if (!c0 || c0.exist !== true) {
    throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomRef} нет покрытия потолка — ниш нет`);
  }
  const niches = edgeContainer(c0 as RoomRec, "niches", edges.length);
  for (let i = 0; i < edges.length; i++) {
    if (wallId && edges[i]!.pid !== wallId) continue;
    if (niches[i]!["exist"] !== true) continue;
    niches[i] = { exist: false };
    n++;
  }
  if (wallId && n === 0) {
    throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomRef} нет ниш на стене ${wallId}`);
  }
  c0["niches"] = niches;
  return { parts: n };
}

/** Записать отделку стороны стены, обращённой к комнате (decors по рёбрам с pid=wallId).
 *  Двухслойные пункты UI (painting_tile/wallpaper_tiles/wall_apron) пишут слой 2
 *  (фартук) или слои 1+2 (плитка+краска/обои); части других слоёв на ребре
 *  сохраняются — как union/split редактора. */
export function setWallFinish(model: Model, roomRef: string, wallId: string, type: WallCover, params: WallFinishParams, partId?: string): { parts: number } {
  if (!(WALL_COVERS as readonly string[]).includes(type)) {
    throw new McpError("INVALID_ARGUMENT", `неизвестная отделка стены «${type}» (допустимо: ${WALL_COVERS.join(", ")})`);
  }
  const twoLayer = (WALL_TWO_LAYER as readonly string[]).includes(type);
  if (twoLayer && (params.heightMm !== undefined || params.heightFromFloorMm !== undefined)) {
    throw new McpError("INVALID_ARGUMENT", `у ${type} высота фиксирована редактором; height_mm/height_from_floor_mm не принимаются`);
  }
  const { room } = resolveRoom(model, roomRef);
  const edges = Array.isArray(room.edges) ? room.edges : [];
  for (const [key, v] of [["height_mm", params.heightMm], ["height_from_floor_mm", params.heightFromFloorMm]] as const) {
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v < 0 || v > FINISH_LIMITS.wallHeightMaxMm) {
      throw new McpError("INVALID_ARGUMENT", `${key} должен быть числом от 0 до ${FINISH_LIMITS.wallHeightMaxMm} мм`);
    }
  }
  const targets = edgesOfWall(room, wallId);
  if (targets.length === 0) {
    throw new McpError("INVALID_ARGUMENT", `комната ${roomRef} не граничит со стеной ${wallId} (граничные стены — из finish_get/model_get)`);
  }
  const decors = edgeContainer(room, "decors", edges.length);
  for (const { edge: e, index } of targets) {
    const p1 = e.p1 ?? { x: 0, y: 0 };
    const p2 = e.p2 ?? { x: 0, y: 0 };
    const line = { p1: { x: r2(p1.x), y: r2(p1.y) }, p2: { x: r2(p2.x), y: r2(p2.y) } };
    const lineWall = { p1: { ...line.p1 }, p2: { ...line.p2 } };
    const existing = (decors[index] as { exist?: unknown; parts?: Record<string, Record<string, unknown>> } | undefined);
    const parts: Record<string, Record<string, unknown>> = {};
    for (const [pid, part] of Object.entries(existing?.parts ?? {})) {
      const layer = num(part.layer) ?? 1;
      const keep = twoLayer
        ? (type === "wall_apron" ? layer !== 2 : !(layer === 1 || layer === 2))
        : layer !== 1;
      if (keep) parts[pid] = part;
    }
    const mkPart = (layer: number, ptype: string, hffCm: number, hCm: number, pid?: string): Record<string, unknown> => ({
      id: pid ?? `_w${newId(8)}`,
      type: ptype,
      layer,
      line: { p1: { ...line.p1 }, p2: { ...line.p2 } },
      line_wall: { p1: { ...lineWall.p1 }, p2: { ...lineWall.p2 } },
      distance: e.length ?? Math.hypot(p2.x - p1.x, p2.y - p1.y),
      height: hCm,
      height_from_floor: hffCm,
    });
    const put = (layer: number, ptype: string, hffCm: number, hCm: number) => {
      const part = mkPart(layer, ptype, hffCm, hCm);
      parts[part["id"] as string] = part;
    };
    if (!twoLayer) {
      put(1, type, params.heightFromFloorMm !== undefined ? r2(params.heightFromFloorMm / 10) : 0, params.heightMm !== undefined ? r2(params.heightMm / 10) : 0);
    } else if (type === "wall_apron") {
      put(2, "wall_tile", FINISH_GEOMETRY.apronFromFloorCm, FINISH_GEOMETRY.apronHeightCm);
    } else {
      put(1, "wall_tile", 0, 0);
      put(2, type === "painting_tile" ? "paint_wall" : "wallpaper", FINISH_GEOMETRY.twoLayerFromFloorCm, 0);
    }
    decors[index] = { exist: true, parts };
  }
  room.decors = decors;
  return { parts: targets.length };
}

/** Снять отделку комнаты: со всех сторон или только со стороны стены wallId. */
export function removeWallFinish(model: Model, roomRef: string, wallId?: string): { parts: number } {
  const { room } = resolveRoom(model, roomRef);
  const edges = Array.isArray(room.edges) ? room.edges : [];
  const decors = Array.isArray(room.decors) ? [...room.decors] : [];
  while (decors.length < edges.length) decors.push({ exist: false });
  let n = 0;
  for (let i = 0; i < edges.length; i++) {
    if (wallId && edges[i]!.pid !== wallId) continue;
    decors[i] = { exist: false };
    n++;
  }
  if (wallId && n === 0) {
    throw new McpError("INVALID_ARGUMENT", `комната ${roomRef} не граничит со стеной ${wallId}`);
  }
  room.decors = decors;
  return { parts: n };
}

export type CeilingFinishParams = {
  /** Уровень потолка (0 — основной). */
  level?: number;
  /** Профиль (по умолчанию standard). */
  profile?: string;
};

/** Записать/заменить покрытие потолка комнаты (rooms2[room].ceilings).
 *  Однозонная комната (одна запись) — запись в ceilings[0] с полигоном комнаты,
 *  как на 141fd2b. Зонированная (записей несколько после пересчёта зон —
 *  закладная/делитель, ревью 311 №1) — покрытие ставится во ВСЕ зоны: полигоны
 *  записей (зон) сохраняются, полигон [0] полигоном всей комнаты не
 *  переписывается. Закарнизные ниши переживают смену материала (переносятся на
 *  новый потолок с обновлением id_ceiling — ревью 246 №2; ищутся во всех
 *  записях); на краску/побелку ниша в UI не ставится, поэтому при нишах такой
 *  материал отклоняется до правки. */
/** Результат смены/снятия покрытия потолка: complexRemoved — была ли снята
 *  двухуровневая отделка (ревью 329 №5: в редакторе смена материала на ДРУГОЙ
 *  делает complex=false и стирает offset/radius/material2 — бандл 268-app.js:
 *  «tool!==r.material&&(r.exist=!0,r.complex=!1,…delete r.offset,delete
 *  r.radius,delete r.material2…»); MCP делает то же и сообщает об этом явно.
 *  Ревью 331 Н4а: смена на ТОТ же материал в редакторе — no-op (условие
 *  tool!==r.material ложно, обработчик не вызывается) — MCP тоже не меняет
 *  запись и complex не трогает (complexRemoved=false). */
export type CeilingFinishResult = { id: string; complexRemoved: boolean };

/** Запись покрытия для одной зоны потолка (общий слой setCeilingFinish):
 *  полигон и рёбра зоны сохраняются (записи без edges — строятся по полигону,
 *  ревью 313 C), ниши переносятся с перепривязкой id_ceiling на новую запись. */
function zoneCeilingEntry(
  prev: Record<string, unknown> | undefined,
  material: CeilingCover,
  level: number,
  profile: string,
): Record<string, unknown> {
  const zoneId = `_c${newId(8)}`;
  const entry: Record<string, unknown> = {
    exist: true,
    id: zoneId,
    material,
    level,
    profile,
  };
  const prevPoly = prev?.["polygon"];
  if (Array.isArray(prevPoly) && prevPoly.length >= 3) entry["polygon"] = structuredClone(prevPoly);
  const prevEdges = prev?.["edges"];
  if (Array.isArray(prevEdges) && prevEdges.length > 0) {
    entry["edges"] = structuredClone(prevEdges);
  } else if (Array.isArray(prevPoly) && prevPoly.length >= 3) {
    entry["edges"] = polygonEdgesOf(prevPoly as Point[]);
  }
  const prevNiches = prev && Array.isArray(prev["niches"]) ? prev["niches"] as Array<Record<string, unknown>> : [];
  if (prevNiches.some((n) => n?.exist === true)) {
    entry["niches"] = structuredClone(prevNiches).map((n) => {
      const rec = n as { exist?: unknown; parts?: Record<string, Record<string, unknown>> };
      if (rec?.exist !== true) return n;
      for (const part of Object.values(rec.parts ?? {})) part["id_ceiling"] = zoneId;
      return n;
    });
  }
  return entry;
}

export function setCeilingFinish(model: Model, roomRef: string, material: CeilingCover, params: CeilingFinishParams): CeilingFinishResult {
  if (!(CEILING_COVERS as readonly string[]).includes(material)) {
    throw new McpError("INVALID_ARGUMENT", `неизвестное покрытие потолка «${material}» (допустимо: ${CEILING_COVERS.join(", ")})`);
  }
  const { id, room } = resolveRoom(model, roomRef);
  // ревью 333 Р1: валидация level/profile ДО раннего no-op выхода — иначе
  // невалидные значения на том же материале проходили молча
  if (params.level !== undefined && (!Number.isInteger(params.level) || params.level < 0 || params.level > FINISH_LIMITS.ceilingLevelMax)) {
    throw new McpError("INVALID_ARGUMENT", `level должен быть целым числом от 0 до ${FINISH_LIMITS.ceilingLevelMax}`);
  }
  if (params.profile !== undefined && !(CEILING_PROFILES as readonly string[]).includes(params.profile)) {
    throw new McpError("INVALID_ARGUMENT", `неизвестный профиль потолка «${params.profile}» (поддержано: ${CEILING_PROFILES.join(", ")})`);
  }
  // ревью 331 Н4а: смена на тот же материал — no-op, как в редакторе (обработчик
  // смены материала вызывается только при tool!==r.material). Ревью 333 Р1:
  // no-op ТОЛЬКО когда level/profile не переданы или совпадают с текущими
  // (в редакторе уровень меняется отдельно от клика материалом); иначе
  // level/profile обновляются на месте, complex-поля записи
  // (complex/offset/radius/material2) сохраняются, complexRemoved=false.
  const ceilings0 = Array.isArray(room.ceilings) ? room.ceilings as Array<Record<string, unknown>> : [];
  const existRecs = ceilings0.filter((c) => c?.["exist"] === true);
  // ревью 335 m1: непокрытые зоны зонированного потолка (в редакторе отделку ставят
  // по зоне кликом — часть зон может быть без покрытия). Тот же материал покрывает
  // ИХ ТОЖЕ (клик ластика/материала по зоне без отделки ставит покрытие — r.material
  // не совпал, обработчик вызывается); существующие записи не трогаются, complex
  // на покрытых зонах сохраняется.
  const uncoveredZones = ceilings0
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !c || c["exist"] !== true);
  if (existRecs.length > 0 && existRecs.every((c) => c["material"] === material)) {
    const head = existRecs[0]!;
    const levelSame = params.level === undefined || params.level === head["level"];
    const profileSame = params.profile === undefined || params.profile === head["profile"];
    if (levelSame && profileSame && uncoveredZones.length === 0) {
      return { id: (head["id"] as string) ?? id, complexRemoved: false };
    }
    for (const c of existRecs) {
      if (params.level !== undefined) c["level"] = params.level;
      if (params.profile !== undefined) c["profile"] = params.profile;
    }
    if (uncoveredZones.length > 0 && ceilings0.length > 1) {
      const ceilings = [...ceilings0];
      for (const { c, i } of uncoveredZones) {
        // n3 ревью 337: без переданного level/profile непокрытая зона наследует
        // level/profile соседних покрытых зон (head), а не сбрасывается в 0
        ceilings[i] = zoneCeilingEntry(c, material, params.level ?? (num(head["level"]) ?? 0), params.profile ?? (typeof head["profile"] === "string" ? head["profile"] : "standard"));
      }
      room.ceilings = ceilings;
    }
    return { id: (head["id"] as string) ?? id, complexRemoved: false };
  }
  // ревью 329 №5: двухуровневый потолок при смене материала на ДРУГОЙ снимается
  // (как в редакторе: r.exist=!0, r.complex=!1, delete offset/radius/material2) —
  // caller получает complexRemoved для явного warning в ответе
  const complexRemoved = ceilingHasComplex(room);
  const ceilings = Array.isArray(room.ceilings) ? [...room.ceilings] : [];
  while (ceilings.length < 1) ceilings.push({ exist: false });
  const hasNiches = roomHasCeilingNiches(room);
  if (hasNiches && NICHE_FORBIDDEN_MATERIALS.has(material)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `у комнаты ${roomRef} есть закарнизные ниши — на ${material} ниша не ставится; сначала finish_ceiling_niche_remove (в UI ниша доступна только для встраиваемых потолков)`,
    );
  }
  // Зонированный потолок (ревью 311 №1): отделка — во все зоны, полигоны зон
  // не трогаем (полигон [0] полигоном всей комнаты переписывал зоны).
  if (ceilings.length > 1) {
    for (let i = 0; i < ceilings.length; i++) {
      ceilings[i] = zoneCeilingEntry(ceilings[i] as Record<string, unknown> | undefined, material, params.level ?? 0, params.profile ?? "standard");
    }
    room.ceilings = ceilings;
    return { id: (ceilings[0] as Record<string, unknown>).id as string, complexRemoved };
  }
  const prev = ceilings[0] as Record<string, unknown> | undefined;
  const prevNiches = prev && Array.isArray(prev["niches"]) ? prev["niches"] as Array<Record<string, unknown>> : [];
  const polygon = room.polygon ?? room.points ?? [];
  const id0 = `_c${newId(8)}`;
  const entry: Record<string, unknown> = {
    exist: true,
    id: id0,
    polygon: polygon.map((p) => ({ x: r2(p.x), y: r2(p.y) })),
    material,
    level: params.level ?? 0,
    profile: params.profile ?? "standard",
  };
  if (hasNiches) {
    // ниши переносятся как есть (line/depth/plan), id_ceiling — на новый потолок
    entry["niches"] = structuredClone(prevNiches).map((n) => {
      const rec = n as { exist?: unknown; parts?: Record<string, Record<string, unknown>> };
      if (rec?.exist !== true) return n;
      for (const part of Object.values(rec.parts ?? {})) part["id_ceiling"] = id0;
      return n;
    });
  }
  ceilings[0] = entry;
  room.ceilings = ceilings;
  return { id: ceilings[0]!.id as string, complexRemoved };
}

/** Есть ли в записях потолков комнаты двухуровневая отделка (complex=true). */
function ceilingHasComplex(room: RoomRec): boolean {
  const arr = Array.isArray(room.ceilings) ? room.ceilings as Array<Record<string, unknown>> : [];
  return arr.some((c) => c?.["complex"] === true);
}

/** Снять покрытие потолка комнаты. При закарнизных нишах — отказ с подсказкой
 *  finish_ceiling_niche_remove (по стандарту UI, как в setCeilingFinish):
 *  молчаливо стирать ниши нельзя (ревью 248 A). Зонированный потолок: exist:false
 *  ставится во ВСЕ записи, полигоны зон сохраняются (ревью 311 №1).
 *  Ревью 331 Н3/Н4б (решение координатора): при двухуровневой отделке — ОТКАЗ:
 *  в редакторе ластик (ceiling_remove) complex не снимает (живая проба
 *  328-complex, шаг 3; бандл 268-app.js: Ceiling.delete() заменяет запись на
 *  {polygon, edges, exist:!1} — комплексные поля с exist:false сохранить нельзя,
 *  а клик ластика по complex-зоне до delete не доходит). Путь снятия — смена
 *  материала (setCeilingFinish с другим материалом снимает комплекс с warning
 *  complex_removed, как в редакторе). */
export function removeCeilingFinish(model: Model, roomRef: string): CeilingFinishResult {
  const { room } = resolveRoom(model, roomRef);
  if (ceilingHasComplex(room)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `у комнаты ${roomRef} двухуровневый потолок — в редакторе ластик (ceiling_remove) его не снимает ` +
        "(живая проба 328-complex, шаг 3); смените материал (finish_ceiling_set с другим покрытием) — " +
        "двухуровневая отделка снимется с предупреждением complex_removed",
    );
  }
  if (roomHasCeilingNiches(room)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `у комнаты ${roomRef} есть закарнизные ниши — сначала finish_ceiling_niche_remove (в UI ниша снимается до снятия потолка)`,
    );
  }
  const polygon = room.polygon ?? room.points ?? [];
  const list = Array.isArray(room.ceilings) ? [...room.ceilings] : [];
  while (list.length < 1) list.push({ exist: false });
  if (list.length > 1) {
    // зоны: у каждой записи свой полигон — не переписываем полигоном комнаты;
    // edges сохраняем (ревью 313 C): без них следующий set не восстановит рёбра,
    // и finish_ceiling_niche_add ложно отказывает «у зон потолка нет ребра»
    for (let i = 0; i < list.length; i++) {
      const prev = list[i] as Record<string, unknown> | undefined;
      const prevPoly = prev?.["polygon"];
      const prevEdges = prev?.["edges"];
      const entry: Record<string, unknown> = { exist: false };
      if (Array.isArray(prevPoly) && prevPoly.length >= 3) entry["polygon"] = structuredClone(prevPoly);
      if (Array.isArray(prevEdges) && prevEdges.length > 0) entry["edges"] = structuredClone(prevEdges);
      list[i] = entry;
    }
    room.ceilings = list;
    return { id: "", complexRemoved: false };
  }
  list[0] = { exist: false, polygon: polygon.map((p) => ({ x: r2(p.x), y: r2(p.y) })) };
  room.ceilings = list;
  return { id: "", complexRemoved: false };
}

// ---------- семантическая сверка ----------
// Ревью 95 (R1–R4): сопоставление комнат по геометрии контура (канонический полигон
// без коллинеарных вершин, независимо от стартовой вершины и направления), ID — только
// подсказка с проверкой геометрии; отделываемая область стороны сверяется целиком без
// процентного порога — допустимы только сокращения, объяснимые геометрией (проёмы,
// подрезка UI ~5 см у концов, малый абсолютный допуск); явно заданные пользовательские
// параметры обязательны.
//
// Ревью 98 — сверка в два режима (эталоны редактора tests/fixtures/ui-ref-finish-topo-*.json,
// сняты настоящим headless-нормализатором пробой scripts/probes/98-finish-topo.ts):
// - режим «normalize» (до записи, локальная модель против результата normalize):
//   послабления топологии — ТОЛЬКО при доказанной топологической операции (классификация
//   по площадям, ревью 100 N4/N5; «контур изменён» ≠ «топология изменена»):
//   split — одна исходная комната → несколько комнат результата (части в основном лежат
//   внутри исходной); merge — несколько исходных комнат → одна; иначе (перенос стены,
//   деформация или расширение одной комнаты) — ТА ЖЕ комната с новой геометрией:
//   строгая проверка, как при неизменном контуре — покрытие интервалов своей стороны
//   по новой оси стены (допуски R2/R3: штатный отступ, проёмы, изменение длины стены),
//   пол/потолок/параметры обязательны. Правила доказанных операций — по эталонам:
//   split — пол/потолок наследует КАЖДАЯ часть, отделка сторон переживает разрез
//   в комнате-наследнике; merge — объединённая комната сохраняет покрытие одного из
//   источников; отделка сторон при merge не сверяется (эталона нет — предупреждение
//   finish_topology_changed);
// - режим «save» (после записи, GET против нормализованной модели): СТРОГО — каждая
//   комната (по каноническому контуру) и каждая сторона стены (ориентированно, часть
//   принадлежит своей комнате) сохраняет отделку и параметры; никаких merge/split-
//   освобождений — порча после записи не «verified».

export type FinishSig = {
  floor?: { cover: string; width?: number; height?: number; stitch?: number; angle?: number; laying?: string };
  ceiling?: { material: string; level?: number; profile?: string };
  walls?: Array<{ pid?: string; line: [Point, Point]; type: string; layer: number; height: number; fromFloor: number }>;
  /** Напольные плинтусы (245): части по рёбрам комнаты (полная проекция — ревью 246 №10). */
  floorMoldings?: Array<{ pid?: string; type: string; layer: number; line: [Point, Point]; lineWall?: [Point, Point] }>;
  /** Потолочный плинтус (245): части по рёбрам комнаты (полная проекция — ревью 246 №10). */
  ceilingMoldings?: Array<{ pid?: string; type: string; layer: number; line: [Point, Point]; lineWall?: [Point, Point] }>;
  /** Закарнизные ниши (245): части по рёбрам потолка ceilings[0]; pid — стена ребра
   *  (перенос стены), idCeiling — ссылка части, selfCeiling — id ceilings[0] этой же
   *  комнаты (проверка привязки, ревью 246 №10). */
  niches?: Array<{ pid?: string; line: [Point, Point]; depth?: number; plan?: string; idCeiling?: string; selfCeiling?: string }>;
};

/** Проём: то, что сверке нужно от wall.holes (край на оси или центр+ширина). */
export type FinishWall = {
  p1?: Point;
  p2?: Point;
  holes?: Record<string, { pc?: Point; width?: number; p1?: Point; p2?: Point }>;
};

// ---------- геометрия полигонов ----------

const COORD_TOL = 0.5; // см: допуск сравнения вершин/границ

// Общая геометрия комнат (канонический контур, сопоставление, площади, наследники
// топологии) — в room-geo.ts, чтобы модули-сверки не циклили импорты (сторож 181-c3b).
import { overlapShare, roomHeirs, SPLIT_MIN, type RoomHeir } from "./room-geo.ts";
export { roomHeirs, type RoomHeir };

function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Периметр полигона, см. */
function perimeterCm(poly: Point[]): number {
  let per = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    per += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return per;
}

// ---------- интервалы на прямой ----------

type Span = [number, number];

function mergeSpans(spans: Span[]): Span[] {
  const s = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1e-9) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function subtractSpans(base: Span, cuts: Span[]): Span[] {
  let rest: Span[] = [base];
  for (const [a, b] of mergeSpans(cuts)) {
    const next: Span[] = [];
    for (const [s0, s1] of rest) {
      if (b <= s0 || a >= s1) { next.push([s0, s1]); continue; }
      if (a > s0) next.push([s0, Math.min(a, s1)]);
      if (b < s1) next.push([Math.max(b, s0), s1]);
    }
    rest = next;
  }
  return rest;
}

/** Первый недопустимый зазор (см) или null: концы и разрешённые интервалы вычтены. */
function firstBadGap(base: Span, got: Span[], allowed: Span[], lenCm: number, endTrimCm: number, gapTolCm: number): number | null {
  const cuts = [...got, ...allowed, ...[
    [base[0], Math.min(base[0] + endTrimCm / lenCm, base[1])] as Span,
    [Math.max(base[1] - endTrimCm / lenCm, base[0]), base[1]] as Span,
  ]];
  const gaps = subtractSpans(base, cuts);
  for (const [a, b] of gaps) {
    if ((b - a) * lenCm > gapTolCm) return (b - a) * lenCm;
  }
  return null;
}

// ---------- сигнатуры ----------

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function floorSig(room: RoomRec): FinishSig["floor"] | undefined {
  const f = (room.floors ?? [])[0] as Record<string, unknown> | undefined;
  if (!f || f.exist !== true) return undefined;
  const cover = typeof f.cover === "string" ? f.cover : undefined;
  if (!cover) return undefined;
  const angle = num(f.angle);
  return {
    cover,
    width: num(f.width),
    height: num(f.height),
    stitch: num(f.stitch_width),
    angle: angle !== undefined ? ((angle % 360) + 360) % 360 : undefined,
    laying: typeof f.type_laying === "string" ? f.type_laying : undefined,
  };
}

function ceilingSig(room: RoomRec): FinishSig["ceiling"] | undefined {
  const c = (room.ceilings ?? [])[0] as Record<string, unknown> | undefined;
  if (!c || c.exist !== true) return undefined;
  const material = typeof c.material === "string" ? c.material : undefined;
  if (!material) return undefined;
  return { material, level: num(c.level) ?? 0, profile: typeof c.profile === "string" ? c.profile : undefined };
}

/**
 * Отделка ВСЕХ потолочных зон комнаты (этап 310, m11 ревью 304): закладная и
 * zone_ceiling-делитель режут контейнер ceilings на зоны — сверка только по [0]
 * пропускала потерю отделки второй зоны и блокировала штатный перенос отделки
 * между зонами при нормализации. Мультимножество записей {material, level, profile}.
 */
function ceilingSigsOf(room: RoomRec): string[] {
  const arr = Array.isArray(room.ceilings) ? room.ceilings as Array<Record<string, unknown>> : [];
  const out: string[] = [];
  for (const c of arr) {
    if (!c || c.exist !== true) continue;
    const material = typeof c.material === "string" ? c.material : undefined;
    if (!material) continue;
    // level 0 / profile standard — умолчания: отсутствие эквивалентно значению (96 R4)
    const level = num(c.level);
    const profile = typeof c.profile === "string" ? c.profile : "standard";
    // двухуровневый потолок (этап 328): явно заданные пользователем поля complex/
    // material2/level2/offset/radius обязательны после normalize и GET — их
    // исчезновение потеря (new-entity-section.md); при complex=false сигнатура та же
    const complex = c.complex === true ? {
      material2: typeof c.material2 === "string" ? c.material2 : "",
      level2: num(c.level2) ?? 0,
      offset: num(c.offset) ?? 0,
      radius: num(c.radius) ?? 0,
      type: typeof c.type === "string" ? c.type : "",
    } : null;
    out.push(JSON.stringify({ material, level: level ?? 0, profile: profile === "" ? "standard" : profile, complex }));
  }
  return out.sort();
}

/**
 * Отделка по зонам потолка для публичного ответа (этап 312, ревью 311 №1;
 * ревью 313 A — общий слой для finishList, model_get (compact.ts) и
 * roomHasFloorCeiling): записи exist===true с материалом, по порядку контейнера
 * ceilings. После пересчёта зон (закладная/делитель) отделка может стоять в
 * любой записи — чтение только ceilings[0] показывало null (регрессия против
 * 141fd2b).
 */
/** Поля двухуровневой отделки зоны (ревью 329 №5: finish_get показывает complex,
 *  level2, material2 — пользователь MCP видит двухуровневый потолок). */
export type CeilingZoneFinish = {
  index: number;
  material: string;
  level: number | undefined;
  profile: string | undefined;
  complex: boolean;
  level2: number | undefined;
  material2: string | undefined;
};
export function ceilingFinishZones(room: RoomRec): CeilingZoneFinish[] {
  const arr = Array.isArray(room.ceilings) ? room.ceilings as Array<Record<string, unknown>> : [];
  const out: CeilingZoneFinish[] = [];
  arr.forEach((c, index) => {
    if (!c || c.exist !== true) return;
    const material = typeof c.material === "string" ? c.material : undefined;
    if (!material) return;
    const complex = c.complex === true;
    out.push({
      index,
      material,
      level: num(c.level),
      profile: typeof c.profile === "string" ? c.profile : undefined,
      complex,
      level2: complex ? num(c.level2) : undefined,
      material2: complex && typeof c.material2 === "string" ? c.material2 : undefined,
    });
  });
  return out;
}

/** Есть ли закарнизные ниши хоть в одной записи потолков комнаты. */
function roomHasCeilingNiches(room: RoomRec): boolean {
  const arr = Array.isArray(room.ceilings) ? room.ceilings as Array<Record<string, unknown>> : [];
  return arr.some((c) =>
    c && Array.isArray(c["niches"]) &&
    (c["niches"] as Array<Record<string, unknown>>).some((n) => n?.exist === true),
  );
}

function wallSigs(room: RoomRec, edges: RoomRec["edges"]): NonNullable<FinishSig["walls"]> {
  const out: NonNullable<FinishSig["walls"]> = [];
  const decors = Array.isArray(room.decors) ? room.decors : [];
  for (let i = 0; i < decors.length; i++) {
    const d = decors[i] as { exist?: unknown; parts?: Record<string, Record<string, unknown>> } | undefined;
    if (!d || d.exist !== true) continue;
    const e = edges?.[i];
    for (const part of Object.values(d.parts ?? {})) {
      const type = typeof part.type === "string" ? part.type : undefined;
      if (!type) continue;
      const line = part.line as { p1?: Point; p2?: Point } | undefined;
      if (!line?.p1 || !line?.p2) continue;
      out.push({
        pid: e?.pid,
        line: [line.p1, line.p2],
        type,
        layer: num(part.layer) ?? 1,
        height: num(part.height) ?? 0,
        fromFloor: num(part.height_from_floor) ?? 0,
      });
    }
  }
  return out;
}

/** Ось ребра части (line_wall) в виде пары точек или undefined. */
function lineWallOf(part: Record<string, unknown>): [Point, Point] | undefined {
  const lw = part["line_wall"] as { p1?: Point; p2?: Point } | undefined;
  return lw?.p1 && lw?.p2 ? [lw.p1, lw.p2] : undefined;
}

/** Части контейнера по рёбрам комнаты (floorMoldings/ceilingMoldings) в виде сигнатур. */
function moldingSigs(room: RoomRec, key: "floorMoldings" | "ceilingMoldings", edges: RoomRec["edges"]): NonNullable<FinishSig["floorMoldings"]> {
  const out: NonNullable<FinishSig["floorMoldings"]> = [];
  const arr = Array.isArray(room[key]) ? room[key] as Array<Record<string, unknown>> : [];
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i] as { exist?: unknown; parts?: Record<string, Record<string, unknown>> } | undefined;
    if (!e || e.exist !== true) continue;
    const edge = edges?.[i];
    for (const part of Object.values(e.parts ?? {})) {
      const type = typeof part.type === "string" ? part.type : undefined;
      const line = part.line as { p1?: Point; p2?: Point } | undefined;
      if (!type || !line?.p1 || !line?.p2) continue;
      out.push({ pid: edge?.pid, type, layer: num(part.layer) ?? 1, line: [line.p1, line.p2], lineWall: lineWallOf(part) });
    }
  }
  return out;
}

/** Ребро комнаты, на котором целиком лежит линия (допуск UI-магнита 0.05 см):
 *  pid ребра или undefined — общий помощник ниш (ревью 313 E, «Что упростить» 2:
 *  nichesSig и finishList определяют стену ниши геометрически, не по индексу).
 *  Ревью 315 F2: концы линии должны проектироваться В ПРЕДЕЛЫ отрезка
 *  (-ε ≤ projT ≤ 1+ε, ε — те же 0.05 см вдоль ребра), иначе в комнате с
 *  коллинеарными рёбрами (стена из двух отрезков в линию) линия ниши на втором
 *  отрезке получала метку первого — регрессия против 141fd2b. */
function edgePidByLine(edges: Array<{ p1?: Point; p2?: Point; pid?: string }>, line: { p1: Point; p2: Point }): string | undefined {
  for (const e of edges) {
    if (!e?.p1 || !e?.p2) continue;
    const len = Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y);
    if (len < 1e-9) continue;
    const tEps = 0.05 / len;
    const onSeg = (p: Point): boolean => {
      const t = projT(p, e.p1!, e.p2!);
      return projD(p, e.p1!, e.p2!) <= 0.05 && -tEps <= t && t <= 1 + tEps;
    };
    if (onSeg(line.p1) && onSeg(line.p2)) return e.pid;
  }
  return undefined;
}

/** Закарнизные ниши (niches по записям ceilings) в виде сигнатур (полная проекция —
 *  ревью 246 №10). Зонированный потолок (ревью 311 №1): ниши могут стоять в любой
 *  записи — обходятся все; pid — ребро комнаты, на котором лежит линия ниши
 *  (геометрически; для однозонной записи (ceilings.length ≤ 1) сначала индексная
 *  привязка — как на 141fd2b, ревью 315 F2). */
function nichesSig(room: RoomRec): NonNullable<FinishSig["niches"]> {
  const out: NonNullable<FinishSig["niches"]> = [];
  const edges = Array.isArray(room.edges) ? room.edges : [];
  const ceilings = Array.isArray(room.ceilings) ? room.ceilings as Array<Record<string, unknown>> : [];
  const pidByLine = (line: { p1: Point; p2: Point }): string | undefined => edgePidByLine(edges, line);
  ceilings.forEach((rec, ci) => {
    if (!rec) return;
    const selfCeiling = typeof rec["id"] === "string" ? rec["id"] as string : undefined;
    const arr = Array.isArray(rec["niches"]) ? rec["niches"] as Array<Record<string, unknown>> : [];
    for (let i = 0; i < arr.length; i++) {
      const nrec = arr[i] as { exist?: unknown; parts?: Record<string, Record<string, unknown>> } | undefined;
      if (!nrec || nrec.exist !== true) continue;
      const indexPid = edges[i]?.pid as string | undefined;
      for (const part of Object.values(nrec.parts ?? {})) {
        const line = part.line as { p1?: Point; p2?: Point } | undefined;
        if (!line?.p1 || !line?.p2) continue;
        const pid = ceilings.length <= 1
          ? indexPid ?? pidByLine(line as { p1: Point; p2: Point })
          : pidByLine(line as { p1: Point; p2: Point }) ?? (ci === 0 ? indexPid : undefined);
        out.push({
          pid,
          line: [line.p1, line.p2],
          depth: num(part.depth),
          plan: typeof part.plan === "string" ? part.plan : undefined,
          idCeiling: typeof part.id_ceiling === "string" ? part.id_ceiling : undefined,
          selfCeiling,
        });
      }
    }
  });
  return out;
}

/** Сигнатура отделки одной комнаты по id. */
export function finishSignature(model: Model, roomId: string): FinishSig {
  const room = roomsOf(model)[roomId] ?? {};
  const edges = Array.isArray(room.edges) ? room.edges : undefined;
  return {
    floor: floorSig(room), ceiling: ceilingSig(room), walls: wallSigs(room, edges),
    floorMoldings: moldingSigs(room, "floorMoldings", edges),
    ceilingMoldings: moldingSigs(room, "ceilingMoldings", edges),
    niches: nichesSig(room),
  };
}

// ---------- сравнение значений (ревью 95 R4) ----------

const NUM_TOL = 0.05; // см/градус: численный шум
/** Умолчания редактора: отсутствующее поле эквивалентно такому значению (R4). */
function sameOptional(exp: number | undefined, got: number | undefined, defaults: readonly number[]): boolean {
  if (exp === undefined) return true;
  if (got === undefined) return defaults.includes(exp);
  return Math.abs(exp - got) <= NUM_TOL;
}

function sameFloor(exp: NonNullable<FinishSig["floor"]>, got: NonNullable<FinishSig["floor"]>): boolean {
  // пользовательские параметры обязательны: исчезновение явно заданного значения — расхождение;
  // производные поля (polygons_layout, patch, f0offset) не сверяются
  if (exp.cover !== got.cover) return false;
  if (!sameOptional(exp.width, got.width, [])) return false;
  if (!sameOptional(exp.height, got.height, [])) return false;
  // шов 0 и угол 0 редактор может не записать (значения по умолчанию)
  if (!sameOptional(exp.stitch, got.stitch, [0])) return false;
  if (!sameOptional(exp.angle, got.angle, [0])) return false;
  if (exp.laying !== undefined && got.laying !== exp.laying) return false;
  return true;
}

function sameCeiling(exp: NonNullable<FinishSig["ceiling"]>, got: NonNullable<FinishSig["ceiling"]>): boolean {
  if (exp.material !== got.material) return false;
  // level 0 / profile standard — умолчания: их отсутствие эквивалентно значению
  if (!sameOptional(exp.level, got.level, [0])) return false;
  if (exp.profile !== undefined && got.profile !== exp.profile && !(exp.profile === "standard" && got.profile === undefined)) return false;
  return true;
}

// ---------- отделка сторон стен: покрытие области (ревью 95 R2/R3) ----------

const PERP_TOL = 6; // см: штатный отступ линии UI внутрь комнаты (~5 см) + допуск
const END_TRIM_TOL = 6; // см: штатная подрезка UI у концов (~5 см) + допуск
const GAP_TOL = 0.6; // см: численный зазор
const OPENING_TOL = 2; // см: разрыв вокруг проёма может быть уже проёма (наличник)

function projT(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return 0;
  return ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
}

function projD(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = projT(p, a, b);
  return Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t);
}

function lineLen(l: [Point, Point]): number {
  return Math.hypot(l[1].x - l[0].x, l[1].y - l[0].y);
}

/** Проёмы стены, спроецированные на прямую (расширенные на OPENING_TOL). */
function openingSpansOnLine(wall: FinishWall | undefined, a: Point, b: Point, lenCm: number): Span[] {
  if (!wall?.holes) return [];
  const wp1 = wall.p1, wp2 = wall.p2;
  if (!wp1 || !wp2 || lineLen([wp1, wp2]) < 1e-9) return [];
  const out: Span[] = [];
  for (const h of Object.values(wall.holes)) {
    let e1: Point | undefined, e2: Point | undefined;
    if (h.p1 && h.p2) { e1 = h.p1; e2 = h.p2; }
    else if (h.pc && h.width) {
      const wpx = wp2.x - wp1.x, wpy = wp2.y - wp1.y;
      const wlen = Math.hypot(wpx, wpy);
      const c = projT(h.pc, wp1, wp2) * wlen;
      const half = Math.min(h.width / 2, wlen / 2);
      const t1 = Math.max((c - half) / wlen, 0), t2 = Math.min((c + half) / wlen, 1);
      e1 = { x: wp1.x + wpx * t1, y: wp1.y + wpy * t1 };
      e2 = { x: wp1.x + wpx * t2, y: wp1.y + wpy * t2 };
    }
    if (!e1 || !e2) continue;
    const t1 = Math.min(projT(e1, a, b), projT(e2, a, b));
    const t2 = Math.max(projT(e1, a, b), projT(e2, a, b));
    if (t2 - t1 <= 0) continue;
    const pad = OPENING_TOL / lenCm;
    out.push([t1 - pad, t2 + pad]);
  }
  return out;
}

/**
 * Ожидаемая отделываемая область (отрезок exp) покрыта частями got той же отделки:
 * та же прямая (перпендикуляр ≤ tol), каждая часть покрывает свой интервал; допустимы
 * только концевая подрезка UI, разрывы вокруг проёмов и малый численный зазор.
 * Процентные пороги не используются (ревью 95 R2): любое необъяснимое сокращение —
 * расхождение.
 */
function expectedAreaCovered(
  exp: [Point, Point],
  gotParts: Array<[Point, Point]>,
  openings: Span[],
): boolean {
  const lenCm = lineLen(exp);
  if (lenCm < 1e-9) return gotParts.length > 0;
  const spans: Span[] = [];
  for (const line of gotParts) {
    const t1 = projT(line[0], exp[0], exp[1]), t2 = projT(line[1], exp[0], exp[1]);
    const s: Span = [Math.max(Math.min(t1, t2), 0), Math.min(Math.max(t1, t2), 1)];
    if (s[1] - s[0] > 1e-9) spans.push(s);
  }
  return firstBadGap([0, 1], spans, openings, lenCm, END_TRIM_TOL, GAP_TOL) === null;
}

/**
 * Часть отделки стены принадлежит той же стороне: геометрия на ожидаемой линии
 * (стена на месте) либо на оси той же стены после переноса (id совпадает, линия
 * переехала вместе со стеной — отчёт 94: отделка переживает сдвиг стены).
 */
function gotPartNear(
  w: { pid?: string; line: [Point, Point] },
  g: { pid?: string; line: [Point, Point] },
  gotWalls?: Record<string, FinishWall>,
): "line" | "wall" | null {
  if (w.pid && g.pid && w.pid === g.pid) {
    const gw = gotWalls?.[g.pid];
    if (gw?.p1 && gw?.p2) {
      // линия части должна лежать на переносимой стене (любая сторона, с отступом UI)
      if (projD(g.line[0], gw.p1, gw.p2) <= PERP_TOL + 12 && projD(g.line[1], gw.p1, gw.p2) <= PERP_TOL + 12) return "wall";
    } else {
      // ось стены недоступна (в сверку переданы только комнаты) — сопоставляем по линии
      return "line";
    }
  }
  const nearExp = projD(g.line[0], w.line[0], w.line[1]) <= PERP_TOL && projD(g.line[1], w.line[0], w.line[1]) <= PERP_TOL;
  if (nearExp) return "line";
  return null;
}

// ---------- сопоставление комнат (ревью 95 R1) ----------
// roomPolygonOf и matchRoomsByContour — в room-geo.ts (переэкспортируются выше).

const roomPolygon = (room: unknown): Point[] | undefined => roomPolygonOf(room);

function roomHasFloorCeiling(room: RoomRec): boolean {
  // ревью 313 A: отделка потолка по зонам — общий слой ceilingFinishZones
  // (после пересчёта зон отделка может стоять в любой записи)
  return Boolean(floorSig(room) || ceilingFinishZones(room).length > 0);
}

/**
 * Классификация наследников при изменившейся топологии — общий слой в room-geo.ts
 * (переэкспортируется выше; используется сверкой отделки, зон потолка и комнат при save).
 */

/** Режим сверки отделки: «normalize» — до записи (штатная топология редактора),
 *  «save» — после записи по GET (строго, без освобождений). */
export type FinishMode = "normalize" | "save";

/**
 * Виды потери отделки — единственный источник кодов (ревью 337 M1-а): finishCompare
 * помечает каждую problem кодом вида (структурно, рядом с текстом), а finishLossHint
 * сопоставляет по коду через FINISH_LOSS_REGISTRY, не регулярками по русскому тексту.
 * Новый вид потери — новая строка здесь И запись в FINISH_LOSS_REGISTRY (сторож в
 * wall-delete-finish-hint.test.ts краснеет, если записи в реестре нет).
 */
export const FINISH_LOSS_KINDS = [
  "floor_molding", "ceiling_molding", "niche",
  "ceiling_complex", "ceiling",
  "floor", "wall_side",
  "foreign_ceiling",
] as const;
export type FinishLossKind = (typeof FINISH_LOSS_KINDS)[number];
/** problem с кодом вида: text — ровно та же строка, что и в problems. */
export type FinishLoss = { kind: FinishLossKind; text: string };

/** Правило реестра «вид потери → чем снимать → порядок» (ревью 337 M1-а). */
export type FinishLossRule = {
  kind: FinishLossKind;
  /** что называем в подсказке как мешающее (винительный падеж) */
  label: string;
  /** инструмент(ы) снятия; null — вида без однозначного инструмента (запасной текст) */
  tool: string | null;
  /** порядок снятия в подсказке: меньше — раньше (ниша и плинтусы раньше ластиков:
   *  ластик потолка при нише отказывает; двухуровневый — смена материала раньше ластика) */
  order: number;
};

/**
 * Реестр «вид потери отделки → инструмент снятия → порядок» — единственный источник
 * подсказки (ревью 337 M1-а): и finishCompare (коды видов), и finishLossHint
 * (инструменты и порядок) берут данные отсюда, новых списков инструментов в текстах нет.
 */
export const FINISH_LOSS_REGISTRY: readonly FinishLossRule[] = [
  { kind: "niche", label: "закарнизную нишу", tool: "finish_ceiling_niche_remove", order: 1 },
  { kind: "ceiling_molding", label: "потолочный плинтус", tool: "finish_ceiling_molding_remove", order: 2 },
  { kind: "floor_molding", label: "плинтус пола", tool: "finish_floor_molding_remove", order: 3 },
  { kind: "ceiling_complex", label: "двухуровневое покрытие потолка", tool: "finish_ceiling_set с другим покрытием (снимет двухуровневый с warning complex_removed), затем finish_ceiling_remove", order: 4 },
  { kind: "ceiling", label: "покрытие потолка", tool: "finish_ceiling_remove", order: 5 },
  { kind: "floor", label: "покрытие пола", tool: "finish_floor_remove", order: 6 },
  { kind: "wall_side", label: "отделку сторон стен", tool: "finish_wall_remove", order: 7 },
  { kind: "foreign_ceiling", label: "чужое покрытие потолка", tool: null, order: 8 },
];

export type FinishCompareResult = { problems: string[]; warnings: string[]; losses: FinishLoss[] };

type WallPartSig = { pid?: string; line: [Point, Point]; type: string; layer: number; height: number; fromFloor: number };

/**
 * Семантическая сверка отделки по комнатам (сопоставление по геометрии контура, не по id;
 * ID — только подсказка с проверкой геометрии). Правила топологии — эталоны 98
 * (tests/fixtures/ui-ref-finish-topo-*.json): см. комментарий в начале раздела.
 * Возвращает problems (расхождения → ошибка) и warnings (штатные изменения топологии,
 * при которых отделка сторон не сверяется — предупреждение finish_topology_changed).
 */
export function finishCompare(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
  expectedWalls?: Record<string, unknown>,
  gotWalls?: Record<string, unknown>,
  mode: FinishMode = "normalize",
): FinishCompareResult {
  const exp = (expectedRooms ?? {}) as RoomsMap;
  const got = (gotRooms ?? {}) as RoomsMap;
  const asFinishWalls = (walls: Record<string, unknown> | undefined): Record<string, FinishWall> =>
    Object.fromEntries(Object.entries(walls ?? {}).map(([k, w]) => [k, (w ?? {}) as FinishWall]));
  const expW = asFinishWalls(expectedWalls);
  const gotW = asFinishWalls(gotWalls);
  const problems: string[] = [];
  const losses: FinishLoss[] = [];
  const warnings: string[] = [];
  // ревью 337 M1-а: каждая problem получает код вида потери (структурно, рядом
  // с текстом) — подсказка строится по кодам из FINISH_LOSS_REGISTRY
  const add = (kind: FinishLossKind, text: string): void => {
    losses.push({ kind, text });
    problems.push(text);
  };
  /** Вид потери потолка (n4 ревью 337): complex — только по записям ceilings
   *  самой комнаты (complex:true), не по чужому покрытию и не по правой части
   *  «не совпало (exp → got)» в тексте. */
  const ceilingKind = (room: RoomRec, also?: RoomRec): FinishLossKind =>
    ceilingHasComplex(room) || (also !== undefined && ceilingHasComplex(also)) ? "ceiling_complex" : "ceiling";
  /** Код вида для плинтусов и ниши (раздел 5). */
  const containerKind = (key: "floorMoldings" | "ceilingMoldings" | "__niches"): FinishLossKind =>
    key === "__niches" ? "niche" : key === "floorMoldings" ? "floor_molding" : "ceiling_molding";

  // 1. точное сопоставление по каноническому контуру (id — подсказка, проверенная геометрией)
  const { pairs: exact } = matchRoomsByContour(expectedRooms, gotRooms);
  const unmatchedExp = Object.keys(exp).filter((rid) => !exact.has(rid));

  // 2. наследники при изменившейся топологии (только режим normalize) — общий слой
  //    (используется и сверкой комнат при save, этап 126)
  const heirOf = roomHeirs(expectedRooms, gotRooms, exact, mode);
  /** Наследник без смены топологии: сверять строго, как совпадающую комнату. */
  const sameMatch = (rid: string): string | undefined => {
    const h = heirOf.get(rid);
    return h && h.kind === "same" ? h.key : undefined;
  };

  // 3. пол/потолок
  for (const [rid, room] of Object.entries(exp)) {
    const gid = exact.get(rid) ?? sameMatch(rid);
    const expFloor = floorSig(room);
    // отделка ВСЕХ зон во всех ветках (ревью 311 №2): сверка только по ceilings[0]
    // пропускала потерю зоны [1] при изменившемся контуре, split и merge
    const expCeils = ceilingSigsOf(room);
    if (!gid) {
      if (!expFloor && expCeils.length === 0) continue; // только стены — сверяются по рёбрам ниже
      if (mode === "save") {
        // строго: комната на сервере не совпала по контуру — освобождений нет (ревью 98 N1)
        if (expFloor) add("floor", `room ${rid}: комната исчезла или изменилась на сервере — покрытие пола (${expFloor.cover}) потеряно`);
        if (expCeils.length > 0) add(ceilingKind(room), `room ${rid}: комната исчезла или изменилась на сервере — покрытие потолка потеряно (${expCeils.join(" | ")})`);
        continue;
      }
      const heir = heirOf.get(rid) ?? null;
      if (!heir) {
        if (expFloor) add("floor", `room ${rid}: потеряно покрытие пола (${expFloor.cover}) при split/merge`);
        if (expCeils.length > 0) add(ceilingKind(room), `room ${rid}: потеряно покрытие потолка (${expCeils.join(" | ")}) при split/merge`);
        continue;
      }
      const heirRoom = got[heir.key]!;
      if (heir.kind === "split") {
        // split: пол наследует КАЖДАЯ часть (эталон 98: split-unequal, split-3);
        // потолок (ревью 313 B): отделка зон исходной комнаты расходится по частям
        // (каждая зона уходит в часть, содержащую её полигон), поэтому требовать
        // всё мультимножество в каждой части — ложная проблема на штатном
        // wall_add комнаты с закладной и одинаковой отделкой зон. Правило: у
        // каждой части отделка непуста и каждая её запись ∈ множеству исходных
        // (как в merge), а объединение частей покрывает исходные материалы.
        if (expFloor) {
          for (const k of heir.partKeys) {
            const gf = floorSig(got[k]!);
            if (!gf || !sameFloor(expFloor, gf)) add("floor", `room ${rid}: часть ${k} не унаследовала покрытие пола (${expFloor.cover}) при split`);
          }
        }
        if (expCeils.length > 0) {
          const allowed = new Set(expCeils);
          const covered = new Set<string>();
          for (const k of heir.partKeys) {
            const partCeils = ceilingSigsOf(got[k]!);
            if (partCeils.length === 0) {
              add(ceilingKind(room), `room ${rid}: часть ${k} не унаследовала покрытие потолка (${expCeils.join(" | ")}) при split`);
              continue;
            }
            const foreign = partCeils.filter((c) => !allowed.has(c));
            if (foreign.length > 0) {
              // n4 ревью 337: чужое покрытие — не потеря отделки самой комнаты,
              // код foreign_ceiling (подсказка без инструментов снятия)
              add("foreign_ceiling", `room ${rid}: часть ${k} получила чужое покрытие потолка (${foreign.join(" | ")}) при split`);
              continue;
            }
            for (const c of partCeils) covered.add(c);
          }
          const uncovered = [...new Set(expCeils)].filter((c) => !covered.has(c));
          if (uncovered.length > 0) {
            add(ceilingKind(room), `room ${rid}: ни одна часть split не унаследовала покрытие потолка (${uncovered.join(" | ")})`);
          }
        }
      } else {
        // merge: объединённая комната сохраняет покрытие ОДНОГО из источников
        // (эталон 98: merge-diff-floors — floor_tile, merge-one-floor — laminate+потолок).
        // По зонам (ревью 311 №2): restoreTotal редактора переносит записи источников
        // по getZone — при схлопывании зон часть записей легитимно перезаписывается,
        // поэтому сверяем подмножество: у результата есть отделка источников и нет чужой
        const sources = unmatchedExp
          .map((k) => exp[k]!)
          .filter((r) => overlapShare(roomPolygon(r) ?? [], roomPolygon(heirRoom) ?? []) >= SPLIT_MIN);
        const srcFloors = sources.map(floorSig).filter((s) => s !== undefined);
        const srcCeils = sources.flatMap((r) => ceilingSigsOf(r));
        const gotFloor = floorSig(heirRoom);
        const gotCeils = ceilingSigsOf(heirRoom);
        if (srcFloors.length > 0 && (!gotFloor || !srcFloors.some((s) => sameFloor(s, gotFloor)))) {
          add("floor", `room ${rid}: объединённая комната потеряла покрытие пола (${srcFloors.map((s) => s.cover).join(" / ")}) при merge`);
        }
        if (srcCeils.length > 0) {
          const allowed = new Set(srcCeils);
          if (gotCeils.length === 0 || gotCeils.some((c) => !allowed.has(c))) {
            add(ceilingKind(room), `room ${rid}: объединённая комната потеряла покрытие потолка (${srcCeils.join(" | ")}) при merge`);
          }
        }
      }
      continue;
    }
    const match = got[gid]!;
    if (expFloor) {
      const gotFloor = floorSig(match);
      if (!gotFloor) add("floor", `room ${rid}: потеряно покрытие пола (${expFloor.cover})`);
      else if (!sameFloor(expFloor, gotFloor)) {
        add("floor", `room ${rid}: покрытие пола не совпало (${JSON.stringify(expFloor)} → ${JSON.stringify(gotFloor)})`);
      }
      // площадь покрытия пола (хвост ревью 95, ревью 246 №4): сравнение до/после —
      // блокируется только прирост незакрытой площади внутри комнаты (потеря
      // полигона при операции/на сервере). Унаследованный малый пол (зонирование
      // пола в UI) не блокирует — дефицит не вырос; пол, следующий за сузившейся
      // комнатой при переносе стены, тоже. Без процентных порогов: абсолютный
      // допуск на численный шум вершин — периметр комнаты × COORD_TOL.
      // Полигон пола у got пропал (cover цел) — это и есть потеря, не пропуск
      // проверки (ревью 248 C).
      const expFloorPoly = ((room.floors as Array<Record<string, unknown>> | undefined) ?? [])[0]?.["polygon"] as Point[] | undefined;
      if (expFloorPoly && expFloorPoly.length >= 3) {
        const gotFloorPoly = ((match.floors as Array<Record<string, unknown>> | undefined) ?? [])[0]?.["polygon"] as Point[] | undefined;
        if (!gotFloorPoly || gotFloorPoly.length < 3) {
          add("floor", `room ${rid}: потерян полигон пола`);
        } else {
          const expRoomPoly = roomPolygon(room) ?? [];
          const gotRoomPoly = roomPolygon(match) ?? [];
          /** Незакрытая площадь внутри комнаты: комната минус (пол ∩ комната). */
          const uncovered = (floorPoly: Point[], roomPoly: Point[]): number => {
            if (roomPoly.length < 3 || polygonArea(roomPoly) <= 1) return 0;
            return polygonArea(roomPoly) - overlapShare(floorPoly, roomPoly) * polygonArea(floorPoly);
          };
          const grewCm2 = uncovered(gotFloorPoly, gotRoomPoly) - uncovered(expFloorPoly, expRoomPoly);
          if (grewCm2 > Math.max(perimeterCm(gotRoomPoly) * COORD_TOL, 1)) {
            add("floor", `room ${rid}: незакрытая полом площадь комнаты выросла на ${grewCm2.toFixed(1)} см² — потеря покрытия пола`);
          }
        }
      }
    }
    // этап 310 (m11 ревью 304): отделка ВСЕХ потолочных зон комнаты —
    // мультимножество записей, не только ceilings[0]; штатный перенос отделки
    // между зонами при нормализации не блокируется, потеря записи — расхождение
    if (expCeils.length > 0) {
      const gotCeils = ceilingSigsOf(match);
      if (expCeils.length !== gotCeils.length || expCeils.some((c, i) => c !== gotCeils[i])) {
        // n4 ревью 337: complex — по записям комнат (exp и got), не по правой части текста
        add(ceilingKind(room, match), `room ${rid}: покрытие потолка не совпало (${expCeils.join(" | ") || "нет"} → ${gotCeils.join(" | ") || "нет"})`);
      }
    }
  }

  // 4. отделка сторон стен: каждая ожидаемая сторона должна быть покрыта частями got
  //    по рёбрам. Принадлежность стороне ориентированная (ревью 98 N2): часть может
  //    покрывать только сторону СВОЕЙ комнаты — чужая сторона той же стены не компенсирует
  //    потерю. При изменившейся топологии (normalize) отделка переживает разрез в
  //    комнате-наследнике (эталон 98: split), при merge не сверяется — предупреждение.
  const gotPartsByRoom = new Map<string, WallPartSig[]>();
  for (const [gk, gr] of Object.entries(got)) {
    gotPartsByRoom.set(gk, wallSigs(gr, Array.isArray(gr.edges) ? gr.edges : undefined));
  }
  /** Часть отделки пересекает ожидаемый отрезок по длине (хоть немного). */
  const overlapsExpLine = (w: { line: [Point, Point] }, g: { line: [Point, Point] }): boolean => {
    const t1 = projT(g.line[0], w.line[0], w.line[1]);
    const t2 = projT(g.line[1], w.line[0], w.line[1]);
    const lo = Math.max(Math.min(t1, t2), 0);
    const hi = Math.min(Math.max(t1, t2), 1);
    return hi - lo > 1e-9;
  };
  /** Часть лежит у СВОЕЙ комнаты (ревью 98 N2, уточнение 246 №5): внутри полигона
   *  или на его границе в пределах допуска UI. Плинтус/отделка, оставшаяся на
   *  старом месте после переноса стены (вне комнаты got), — потеря. */
  const nearRoom = (g: { line: [Point, Point] }, roomKey: string): boolean => {
    const poly = roomPolygon(got[roomKey]!) ?? [];
    if (poly.length < 3) return true;
    const mid = { x: (g.line[0].x + g.line[1].x) / 2, y: (g.line[0].y + g.line[1].y) / 2 };
    if (pointInPolygon(mid, poly)) return true;
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      best = Math.min(best, projD(mid, poly[i]!, poly[(i + 1) % poly.length]!));
    }
    return best <= PERP_TOL;
  };
  for (const [rid, room] of Object.entries(exp)) {
    const expWallsList = wallSigs(room, Array.isArray(room.edges) ? room.edges : undefined);
    if (expWallsList.length === 0) continue;
    const sameParams = (w: WallPartSig) => (g: { type: string; layer: number; height: number; fromFloor: number }): boolean =>
      g.type === w.type && g.layer === w.layer &&
      Math.abs(g.height - w.height) <= NUM_TOL && Math.abs(g.fromFloor - w.fromFloor) <= NUM_TOL;
    const gid = exact.get(rid) ?? sameMatch(rid);
    if (!gid) {
      if (mode === "save") {
        for (const sig of expWallsList) {
          add("wall_side", `room ${rid}: потеряна отделка стены ${sig.pid ?? "?"} (${sig.type}, слой ${sig.layer}) — комната не найдена на сервере`);
        }
        continue;
      }
      const heir = heirOf.get(rid) ?? null;
      if (!heir) {
        for (const sig of expWallsList) {
          add("wall_side", `room ${rid}: потеряна отделка стены ${sig.pid ?? "?"} (${sig.type}, слой ${sig.layer}) при split/merge`);
        }
        continue;
      }
      if (heir.kind === "merge") {
        // merge: эталона наследования отделки сторон нет — не блокируем, предупреждение
        warnings.push(`finish_topology_changed: room ${rid}: отделка сторон (${expWallsList.length}) при merge не сверяется — проверьте finish_get после сохранения`);
        continue;
      }
      // split: отделка переживает разрез в одной из частей (эталон 98: обе части без
      // отделки — потеря); укорачивание линии — штатно, площадь не сверяется
      for (const w of expWallsList) {
        const survived = heir.partKeys.some((k) =>
          (gotPartsByRoom.get(k) ?? []).some((g) => sameParams(w)(g) && nearRoom(g, k) && gotPartNear(w, g, gotW) !== null && overlapsExpLine(w, g)),
        );
        if (!survived) {
          add("wall_side", `room ${rid}: потеряна отделка стены ${w.pid ?? "?"} (${w.type}, слой ${w.layer}) при split`);
        }
      }
      continue;
    }
    for (const w of expWallsList) {
      // только части этой комнаты: чужая сторона не компенсирует потерю (ревью 98 N2)
      const candidates = (gotPartsByRoom.get(gid) ?? []).filter(sameParams(w));
      const near: Array<"line" | "wall"> = [];
      const onLine: Array<[Point, Point]> = [];
      const onWall: Array<[Point, Point]> = [];
      for (const g of candidates) {
        const how = gotPartNear(w, g, gotW);
        if (!how || !nearRoom(g, gid)) continue;
        near.push(how);
        (how === "wall" ? onWall : onLine).push(g.line);
      }
      const expWall = w.pid ? expW[w.pid] : undefined;
      const gotWallForAxis = w.pid ? gotW[w.pid] : undefined;
      // проёмы ожидаемой стены (и появившиеся при нормализации) в координатах
      // ожидаемой линии и оси стены
      const openingsLine = [
        ...openingSpansOnLine(expWall, w.line[0], w.line[1], lineLen(w.line)),
        ...openingSpansOnLine(gotWallForAxis, w.line[0], w.line[1], lineLen(w.line)),
      ];
      let covered = false;
      if (onLine.length > 0) {
        covered = expectedAreaCovered(w.line, onLine, openingsLine);
      }
      if (!covered && onWall.length > 0 && gotWallForAxis?.p1 && gotWallForAxis.p2) {
        // перенос стены: сверяем в координатах новой оси той же стены
        const axis: [Point, Point] = [gotWallForAxis.p1, gotWallForAxis.p2];
        const axisLen = lineLen(axis);
        const expSpan: Span = [
          Math.min(projT(w.line[0], axis[0], axis[1]), projT(w.line[1], axis[0], axis[1])),
          Math.max(projT(w.line[0], axis[0], axis[1]), projT(w.line[1], axis[0], axis[1])),
        ];
        const spans: Span[] = [];
        for (const line of onWall) {
          const t1 = projT(line[0], axis[0], axis[1]), t2 = projT(line[1], axis[0], axis[1]);
          const s: Span = [Math.max(Math.min(t1, t2), expSpan[0]), Math.min(Math.max(t1, t2), expSpan[1])];
          if (s[1] - s[0] > 1e-9) spans.push(s);
        }
        const openingsAxis = [
          ...openingSpansOnLine(expWall, axis[0], axis[1], axisLen),
          ...openingSpansOnLine(gotWallForAxis, axis[0], axis[1], axisLen),
        ];
        covered = firstBadGap(expSpan, spans, openingsAxis, axisLen, END_TRIM_TOL, GAP_TOL) === null;
      }
      if (!covered) {
        add("wall_side", `room ${rid}: потеряна отделка стены ${w.pid ?? "?"} (${w.type}, слой ${w.layer})`);
      }
    }
  }

  // 5. плинтусы и ниши (245) — правила сопоставления те же, что у отделки сторон
  //    (точное совпадение комнаты — строгое покрытие рёбер с допусками UI; split —
  //    часть переживает разрез; merge — предупреждение; режим save — строго).
  //    Полная проекция (ревью 246 №10): у плинтуса — layer и line_wall (ось своей
  //    стены, в том числе переехавшей); у ниши — depth (с допуском), plan и
  //    id_ceiling (ссылка на потолок СВОЕЙ комнаты — устойчиво к перегенерации id).
  type EdgePartSig = {
    pid?: string; type: string; layer: number; height: number; fromFloor: number; line: [Point, Point];
    lineWall?: [Point, Point];
    depth?: number; plan?: string; idCeiling?: string; selfCeiling?: string;
  };
  const containerSigsOf = (room: RoomRec, key: "floorMoldings" | "ceilingMoldings" | "__niches"): EdgePartSig[] => {
    if (key === "__niches") {
      return nichesSig(room).map((n) => ({ pid: n.pid, type: "ceiling_niche", layer: 1, height: 0, fromFloor: 0, line: n.line, depth: n.depth, plan: n.plan, idCeiling: n.idCeiling, selfCeiling: n.selfCeiling }));
    }
    return moldingSigs(room, key, Array.isArray(room.edges) ? room.edges : undefined)
      .map((m) => ({ pid: m.pid, type: m.type, layer: m.layer, height: 0, fromFloor: 0, line: m.line, lineWall: m.lineWall }));
  };
  for (const key of ["floorMoldings", "ceilingMoldings", "__niches"] as const) {
    const label = key === "__niches" ? "ниша" : key === "floorMoldings" ? "плинтус" : "потолочный плинтус";
    const kind = containerKind(key);
    const gotSigsByRoom = new Map<string, EdgePartSig[]>();
    for (const [gk, gr] of Object.entries(got)) {
      gotSigsByRoom.set(gk, containerSigsOf(gr, key));
    }
    /** Полные поля части (ревью 246 №10): у плинтуса — layer; у ниши — depth (допуск),
     *  plan и привязка id_ceiling к потолку своей комнаты. */
    const sameParams = (w: EdgePartSig) => (g: EdgePartSig): boolean => {
      if (g.type !== w.type || g.layer !== w.layer) return false;
      if (key === "__niches") {
        if (w.depth !== undefined && (g.depth === undefined || Math.abs(g.depth - w.depth) > NUM_TOL)) return false;
        if (w.plan !== undefined && g.plan !== w.plan) return false;
        if (w.idCeiling !== undefined && (g.idCeiling === undefined || g.selfCeiling === undefined || g.idCeiling !== g.selfCeiling)) return false;
      }
      return true;
    };
    /** line_wall части лежит на оси своей стены: ожидаемой либо (после переноса)
     *  фактической оси той же стены. Поле не записано — сверить нечего. */
    const lineWallOk = (w: EdgePartSig, g: EdgePartSig): boolean => {
      if (!g.lineWall || !w.lineWall) return true;
      if (projD(g.lineWall[0], w.lineWall[0], w.lineWall[1]) <= PERP_TOL &&
          projD(g.lineWall[1], w.lineWall[0], w.lineWall[1]) <= PERP_TOL) return true;
      const gw = g.pid ? gotW[g.pid] : undefined;
      if (gw?.p1 && gw?.p2 &&
          projD(g.lineWall[0], gw.p1, gw.p2) <= PERP_TOL + 12 &&
          projD(g.lineWall[1], gw.p1, gw.p2) <= PERP_TOL + 12) return true;
      return false;
    };
    for (const [rid, room] of Object.entries(exp)) {
      const expList = containerSigsOf(room, key);
      if (expList.length === 0) continue;
      const gid = exact.get(rid) ?? sameMatch(rid);
      if (!gid) {
        if (mode === "save") {
          for (const sig of expList) {
            add(kind, `room ${rid}: потерян ${label} ${sig.pid ?? ""} (${sig.type}) — комната не найдена на сервере`);
          }
          continue;
        }
        const heir = heirOf.get(rid) ?? null;
        if (!heir) {
          for (const sig of expList) {
            add(kind, `room ${rid}: потерян ${label} ${sig.pid ?? ""} (${sig.type}) при split/merge`);
          }
          continue;
        }
        if (heir.kind === "merge") {
          warnings.push(`finish_topology_changed: room ${rid}: ${label} (${expList.length}) при merge не сверяется — проверьте finish_get после сохранения`);
          continue;
        }
        for (const w of expList) {
          const survived = heir.partKeys.some((k) =>
            (gotSigsByRoom.get(k) ?? []).some((g) => sameParams(w)(g) && nearRoom(g, k) && gotPartNear(w, g, gotW) !== null && overlapsExpLine(w, g)),
          );
          if (!survived) {
            add(kind, `room ${rid}: потерян ${label} ${w.pid ?? ""} (${w.type}) при split`);
          }
        }
        continue;
      }
      for (const w of expList) {
        const candidates = (gotSigsByRoom.get(gid) ?? []).filter(sameParams(w));
        const onLine: Array<[Point, Point]> = [];
        for (const g of candidates) {
          if (gotPartNear(w, g, gotW) !== null && nearRoom(g, gid) && lineWallOk(w, g)) onLine.push(g.line);
        }
        const expWall = w.pid ? expW[w.pid] : undefined;
        const gotWallForAxis = w.pid ? gotW[w.pid] : undefined;
        const openingsLine = [
          ...openingSpansOnLine(expWall, w.line[0], w.line[1], lineLen(w.line)),
          ...openingSpansOnLine(gotWallForAxis, w.line[0], w.line[1], lineLen(w.line)),
        ];
        const covered = onLine.length > 0 && expectedAreaCovered(w.line, onLine, openingsLine);
        if (!covered) {
          add(kind, `room ${rid}: потерян ${label} ${w.pid ?? ""} (${w.type})`);
        }
      }
    }
  }
  return { problems, warnings, losses };
}

/** Список расхождений (режим normalize, до записи): пусто — совпало. */
export function finishMismatches(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
  expectedWalls?: Record<string, unknown>,
  gotWalls?: Record<string, unknown>,
): string[] {
  return finishCompare(expectedRooms, gotRooms, expectedWalls, gotWalls, "normalize").problems;
}

/**
 * Подсказка к отказу из-за потери отделки при нормализации (ревью 335 M1,
 * фикс-5 ревью 337 M1-а): первый отказ, в который упирается агент, — wall_delete
 * с общим текстом из дюжины категорий, в котором нет порядка снятия отделки.
 * Текст строится по ОДНОМУ реестру FINISH_LOSS_REGISTRY («вид потери → чем
 * снимать → порядок»): вход — фактические problems с кодами видов от
 * finishCompare, сопоставление ПО КОДАМ, не регулярками по русскому тексту.
 * Порядок снятия — поле order: ниша и плинтусы раньше ластиков (ластик потолка
 * при нише отказывает), двухуровневый потолок — смена материала раньше ластика.
 * Запасной вариант (виды без инструмента в реестре, например чужое покрытие при
 * split) — без перечня инструментов, со ссылкой на details.finish_mismatches
 * и finish_get.
 */
export function finishLossHint(losses: readonly FinishLoss[]): string {
  const kinds = new Set(losses.map((l) => l.kind));
  const rules = FINISH_LOSS_REGISTRY
    .filter((r) => kinds.has(r.kind))
    .sort((a, b) => a.order - b.order);
  const withTool = rules.filter((r) => r.tool !== null);
  if (withTool.length === 0) {
    return "отделка комнаты, которая исчезает или сливается при изменении стен, не переживает операцию — какие именно расхождения — в details.finish_mismatches; проверьте текущую отделку через finish_get, снимите её до операции и повторите";
  }
  const what = withTool.map((r) => r.label);
  const steps = withTool.map((r) => r.tool as string);
  const extra = withTool.length < rules.length
    ? "; есть и расхождения без однозначного инструмента — см. details.finish_mismatches и finish_get"
    : "";
  return `отделка комнаты, которая исчезает или сливается при изменении стен, не переживает операцию — ` +
    `мешает ${what.join(", ")}; снимите её до операции и повторите: ${steps.join("; ")}${extra}`;
}

/** Список отделки для публичного ответа (finish_get): по одной или всем комнатам. */
export function finishList(model: Model, roomRef?: string): Record<string, unknown>[] {
  const rooms = roomsOf(model);
  const allKeys = Object.keys(rooms);
  const wallLabel = (pid: string | undefined, model2: Model): string | null => {
    if (!pid) return null;
    const walls = Object.values(model2.walls);
    const i = walls.findIndex((w) => w.id === pid);
    return i >= 0 ? `W${i + 1}` : null;
  };
  // метка R<n> — из полного списка комнат до фильтрации (ревью 95 R6), чтобы ссылка
  // из ответа годилась для следующего finish_* вызова
  const entries = allKeys
    .map((rid, index) => ({ rid, label: `R${index + 1}`, room: rooms[rid]! }))
    .filter(({ rid, label }) => !roomRef || rid === roomRef || label === roomRef);
  return entries.map(({ rid, label, room }) => {
    const edges = Array.isArray(room.edges) ? room.edges : [];
    const walls: Record<string, unknown>[] = [];
    const decors = Array.isArray(room.decors) ? room.decors : [];
    for (let i = 0; i < decors.length; i++) {
      const d = decors[i] as { exist?: unknown; parts?: Record<string, Record<string, unknown>> } | undefined;
      if (!d || d.exist !== true) continue;
      for (const part of Object.values(d.parts ?? {})) {
        if (typeof part.type !== "string") continue;
        walls.push({
          wall: wallLabel(edges[i]?.pid as string | undefined, model),
          side: edges[i]?.side ?? null,
          type: part.type,
          layer: num(part.layer) ?? 1,
          height_mm: Math.round((num(part.height) ?? 0) * 10),
          height_from_floor_mm: Math.round((num(part.height_from_floor) ?? 0) * 10),
        });
      }
    }
    const floor = floorSig(room);
    // покрытие потолка по зонам (ревью 311 №1): после пересчёта зон отделка может
    // стоять в любой записи — чтение только ceilings[0] показывало null (регрессия
    // против 141fd2b). ceiling — покрытие первой зоны с отделкой; если зоны отделаны
    // по-разному, поле ceiling не выводится (вводило бы в заблуждение), перечень —
    // ceiling_zones (zone — индекс записи ceilings, с 1). Однозонная комната —
    // формат вывода как на 141fd2b.
    const ceilingZones = ceilingFinishZones(room);
    const head = ceilingZones[0];
    const uniform = ceilingZones.every((z) =>
      z.material === head!.material && (z.level ?? 0) === (head!.level ?? 0) && (z.profile ?? "standard") === (head!.profile ?? "standard")
      && z.complex === head!.complex && z.material2 === head!.material2 && (z.level2 ?? 0) === (head!.level2 ?? 0),
    );
    const ceiling = head && uniform ? head : undefined;
    const floorMoldings: Array<{ wall: string | null; type: string }> = [];
    for (const m of moldingSigs(room, "floorMoldings", edges)) {
      floorMoldings.push({ wall: wallLabel(m.pid, model), type: m.type });
    }
    const ceilingMoldings: Array<{ wall: string | null }> = [];
    for (const m of moldingSigs(room, "ceilingMoldings", edges)) {
      ceilingMoldings.push({ wall: wallLabel(m.pid, model) });
    }
    const niches: Array<{ wall: string | null }> = [];
    {
      const edgesArr = Array.isArray(room.edges) ? room.edges : [];
      const ceilingsArr = Array.isArray(room.ceilings) ? room.ceilings as Array<Record<string, unknown>> : [];
      ceilingsArr.forEach((c0, ci) => {
        if (!c0) return;
        const arr = Array.isArray(c0["niches"]) ? c0["niches"] as Array<Record<string, unknown>> : [];
        for (let i = 0; i < arr.length; i++) {
          const rec = arr[i] as { exist?: unknown; parts?: Record<string, Record<string, unknown>> } | undefined;
          if (rec?.exist !== true) continue;
          // ревью 313 E: стена ниши — по линии части (геометрически, в любой зоне);
          // для однозонной записи сначала индексная привязка (как на 141fd2b, F2),
          // запасной путь — индекс для ci === 0
          const singleZone = ceilingsArr.length <= 1;
          const indexPid = edgesArr[i]?.pid as string | undefined;
          let pid: string | undefined = singleZone ? indexPid : undefined;
          if (!pid) {
            for (const part of Object.values(rec.parts ?? {})) {
              const line = part["line"] as { p1?: Point; p2?: Point } | undefined;
              if (line?.p1 && line?.p2) {
                pid = edgePidByLine(edgesArr, line as { p1: Point; p2: Point });
                if (pid) break;
              }
            }
          }
          pid ??= ci === 0 ? indexPid : undefined;
          niches.push({ wall: wallLabel(pid, model) });
        }
      });
    }
    // метки ZD<n> сквозные по всем комнатам — фильтрация после нумерации
    const zoneDelims = zoneDelimiterList(model).filter((d) => d["room_id"] === rid);
    // потолочные закладные комнаты (этап 303); метки CR<n> сквозные
    const ceilingRigels = ceilingRigelList(model).filter((r) => r["room_id"] === rid);
    return {
      id: label,
      site_id: rid,
      ...(floor ? { floor: {
        cover: floor.cover,
        ...(floor.angle !== undefined ? { angle_deg: floor.angle } : {}),
        ...(floor.width !== undefined ? { plank_length_mm: Math.round(floor.width * 10) } : {}),
        ...(floor.height !== undefined ? { plank_width_mm: Math.round(floor.height * 10) } : {}),
        ...(floor.stitch !== undefined ? { stitch_width_mm: Math.round(floor.stitch * 10) } : {}),
        ...(floor.laying !== undefined ? { type_laying: floor.laying } : {}),
      } } : {}),
      ...(ceiling ? { ceiling: {
        material: ceiling.material,
        level: ceiling.level ?? 0,
        ...(ceiling.profile ? { profile: ceiling.profile } : {}),
        // ревью 329 №5: двухуровневая отделка видна в finish_get
        complex: ceiling.complex,
        ...(ceiling.complex && ceiling.level2 !== undefined ? { level2: ceiling.level2 } : {}),
        ...(ceiling.complex && ceiling.material2 !== undefined ? { material2: ceiling.material2 } : {}),
      } } : {}),
      ...(ceilingZones.length > 1 ? {
        ceiling_zones: ceilingZones.map((z) => ({
          zone: z.index + 1,
          material: z.material,
          level: z.level ?? 0,
          ...(z.profile ? { profile: z.profile } : {}),
          complex: z.complex,
          ...(z.complex && z.level2 !== undefined ? { level2: z.level2 } : {}),
          ...(z.complex && z.material2 !== undefined ? { material2: z.material2 } : {}),
        })),
      } : {}),
      walls,
      ...(floorMoldings.length > 0 ? { floor_moldings: floorMoldings } : {}),
      ...(ceilingMoldings.length > 0 ? { ceiling_moldings: ceilingMoldings } : {}),
      ...(niches.length > 0 ? { niches } : {}),
      ...(zoneDelims.length > 0 ? { zone_delimiters: zoneDelims } : {}),
      ...(ceilingRigels.length > 0 ? { ceiling_rigels: ceilingRigels } : {}),
    };
  });
}
