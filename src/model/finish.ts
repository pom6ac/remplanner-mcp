import type { Model, Point } from "./types.ts";
import { newId } from "./types.ts";
import { roundTenthMm as r2 } from "./units.ts";
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

/** Отделка стен (лист «Отделка стен»; двухслойные painting_tile/wallpaper_tiles/apron — следующий PR). */
export const WALL_COVERS = [
  "wallpaper", "wallpaper_for_paint", "paint_wall", "walls_whitewash", "wall_chalk_paint",
  "wall_tile", "wall_mosaic", "wall_clinker", "wall_stone", "wall_wooden_panels", "plastic_panels",
  "wall_woodbatten", "wall_sheet_panels", "wall_tile_panels", "decorative_plaster", "venice_plaster",
] as const;

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

/** Профили потолка, известные из проб редактора (94-options-panel, эталон ui-ref-finish-ceiling). */
export const CEILING_PROFILES = ["standard"] as const;

/** Разумные пределы пользовательских параметров (ревью 95 R5): мм. */
export const FINISH_LIMITS = {
  plankMinMm: 1, plankMaxMm: 10_000,
  stitchMaxMm: 100,
  wallHeightMaxMm: 30_000,
  ceilingLevelMax: 20,
} as const;

export type FloorCover = (typeof FLOOR_COVERS)[number];
export type WallCover = (typeof WALL_COVERS)[number];
export type CeilingCover = (typeof CEILING_COVERS)[number];

type RoomRec = {
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

type RoomsMap = Record<string, RoomRec>;

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

/** Записать отделку стороны стены, обращённой к комнате (decors по рёбрам с pid=wallId). */
export function setWallFinish(model: Model, roomRef: string, wallId: string, type: WallCover, params: WallFinishParams, partId?: string): { parts: number } {
  if (!(WALL_COVERS as readonly string[]).includes(type)) {
    throw new McpError("INVALID_ARGUMENT", `неизвестная отделка стены «${type}» (допустимо: ${WALL_COVERS.join(", ")})`);
  }
  const { room } = resolveRoom(model, roomRef);
  const edges = Array.isArray(room.edges) ? room.edges : [];
  for (const [key, v] of [["height_mm", params.heightMm], ["height_from_floor_mm", params.heightFromFloorMm]] as const) {
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v < 0 || v > FINISH_LIMITS.wallHeightMaxMm) {
      throw new McpError("INVALID_ARGUMENT", `${key} должен быть числом от 0 до ${FINISH_LIMITS.wallHeightMaxMm} мм`);
    }
  }
  const targets = edges
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.pid === wallId);
  if (targets.length === 0) {
    throw new McpError("INVALID_ARGUMENT", `комната ${roomRef} не граничит со стеной ${wallId} (граничные стены — из finish_get/model_get)`);
  }
  const decors = Array.isArray(room.decors) ? [...room.decors] : [];
  while (decors.length < edges.length) decors.push({ exist: false });
  for (const { e, index } of targets) {
    const p1 = e.p1 ?? { x: 0, y: 0 };
    const p2 = e.p2 ?? { x: 0, y: 0 };
    const line = { p1: { x: r2(p1.x), y: r2(p1.y) }, p2: { x: r2(p2.x), y: r2(p2.y) } };
    const part = {
      id: partId ?? `_w${newId(8)}`,
      type,
      layer: 1,
      line,
      line_wall: { p1: { ...line.p1 }, p2: { ...line.p2 } },
      distance: e.length ?? Math.hypot(p2.x - p1.x, p2.y - p1.y),
      height: params.heightMm !== undefined ? r2(params.heightMm / 10) : 0,
      height_from_floor: params.heightFromFloorMm !== undefined ? r2(params.heightFromFloorMm / 10) : 0,
    };
    decors[index] = { exist: true, parts: { [part.id]: part } };
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

/** Записать/заменить покрытие потолка комнаты (rooms2[room].ceilings[0]). */
export function setCeilingFinish(model: Model, roomRef: string, material: CeilingCover, params: CeilingFinishParams): { id: string } {
  if (!(CEILING_COVERS as readonly string[]).includes(material)) {
    throw new McpError("INVALID_ARGUMENT", `неизвестное покрытие потолка «${material}» (допустимо: ${CEILING_COVERS.join(", ")})`);
  }
  const { id, room } = resolveRoom(model, roomRef);
  if (params.level !== undefined && (!Number.isInteger(params.level) || params.level < 0 || params.level > FINISH_LIMITS.ceilingLevelMax)) {
    throw new McpError("INVALID_ARGUMENT", `level должен быть целым числом от 0 до ${FINISH_LIMITS.ceilingLevelMax}`);
  }
  if (params.profile !== undefined && !(CEILING_PROFILES as readonly string[]).includes(params.profile)) {
    throw new McpError("INVALID_ARGUMENT", `неизвестный профиль потолка «${params.profile}» (поддержано: ${CEILING_PROFILES.join(", ")})`);
  }
  const polygon = room.polygon ?? room.points ?? [];
  const ceilings = Array.isArray(room.ceilings) ? [...room.ceilings] : [];
  while (ceilings.length < 1) ceilings.push({ exist: false });
  ceilings[0] = {
    exist: true,
    id: `_c${newId(8)}`,
    polygon: polygon.map((p) => ({ x: r2(p.x), y: r2(p.y) })),
    material,
    level: params.level ?? 0,
    profile: params.profile ?? "standard",
  };
  room.ceilings = ceilings;
  return { id: ceilings[0]!.id as string };
}

/** Снять покрытие потолка комнаты. */
export function removeCeilingFinish(model: Model, roomRef: string): void {
  const { room } = resolveRoom(model, roomRef);
  const polygon = room.polygon ?? room.points ?? [];
  const ceilings = Array.isArray(room.ceilings) ? [...room.ceilings] : [];
  while (ceilings.length < 1) ceilings.push({ exist: false });
  ceilings[0] = { exist: false, polygon: polygon.map((p) => ({ x: r2(p.x), y: r2(p.y) })) };
  room.ceilings = ceilings;
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
};

/** Проём: то, что сверке нужно от wall.holes (край на оси или центр+ширина). */
export type FinishWall = {
  p1?: Point;
  p2?: Point;
  holes?: Record<string, { pc?: Point; width?: number; p1?: Point; p2?: Point }>;
};

// ---------- геометрия полигонов ----------

const COORD_TOL = 0.5; // см: допуск сравнения вершин/границ
const COLLINEAR_TOL = 0.5; // см: вершина на хорде ближе этого — коллинеарная
const SPLIT_MIN = 0.3; // доля ожидаемой комнаты в комнате-кандидате при split/merge
const PART_SHARE_MIN = 0.5; // доля части внутри ожидаемой комнаты: комната-«часть» split (эталон 98)

function signedArea(poly: Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function distToChord(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len = Math.hypot(abx, aby);
  if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * aby - (p.y - a.y) * abx) / len;
}

function removeCollinear(poly: Point[]): Point[] {
  let pts = [...poly];
  for (let pass = 0; pass < 2; pass++) {
    const kept: Point[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n]!, next = pts[(i + 1) % n]!;
      if (distToChord(pts[i]!, prev, next) > COLLINEAR_TOL) kept.push(pts[i]!);
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
  return ca.every((p, i) => Math.abs(p.x - cb[i]!.x) <= COORD_TOL && Math.abs(p.y - cb[i]!.y) <= COORD_TOL);
}

function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function polygonArea(poly: Point[] | undefined): number {
  if (!poly || poly.length < 3) return 0;
  return Math.abs(signedArea(poly));
}

/**
 * Доля площади inner, покрытая outer (сетка ~32×32 по bbox inner): сопоставление
 * при split/merge, когда контуры не равны.
 */
function overlapShare(inner: Point[], outer: Point[]): number {
  const area = polygonArea(inner);
  if (area <= 1e-9) return 0;
  const xs = inner.map((p) => p.x), ys = inner.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const step = Math.max(Math.sqrt(area / 900), 1e-6);
  let total = 0, hit = 0;
  for (let x = x0 + step / 2; x < x1; x += step) {
    for (let y = y0 + step / 2; y < y1; y += step) {
      const p = { x, y };
      if (!pointInPolygon(p, inner)) continue;
      total++;
      if (pointInPolygon(p, outer)) hit++;
    }
  }
  return total === 0 ? 0 : hit / total;
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

/** Сигнатура отделки одной комнаты по id. */
export function finishSignature(model: Model, roomId: string): FinishSig {
  const room = roomsOf(model)[roomId] ?? {};
  const edges = Array.isArray(room.edges) ? room.edges : undefined;
  return { floor: floorSig(room), ceiling: ceilingSig(room), walls: wallSigs(room, edges) };
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

function roomPolygon(room: RoomRec): Point[] | undefined {
  return (room.polygon ?? room.points) as Point[] | undefined;
}

/** Полигон комнаты записи (polygon ?? points) — для сопоставления по каноническому контуру. */
export function roomPolygonOf(room: unknown): Point[] | undefined {
  return roomPolygon((room ?? {}) as RoomRec);
}

/**
 * Сопоставление комнат по каноническому контуру (ревью 95 R1): ID — только подсказка,
 * проверенная геометрией. Общий слой для сверки отделки и сверки комнат при save
 * (этап 126) — не дублируется.
 */
export function matchRoomsByContour(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
): { pairs: Map<string, string>; matchedGot: Set<string> } {
  const exp = (expectedRooms ?? {}) as RoomsMap;
  const got = (gotRooms ?? {}) as RoomsMap;
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

function roomHasFloorCeiling(room: RoomRec): boolean {
  return Boolean(floorSig(room) || ceilingSig(room));
}

/**
 * Классификация наследников при изменившейся топологии (только режим normalize).
 * Изменение контура — ещё не смена топологии (ревью 100 N4/N5): классификация по
 * площадям. split доказан несколькими комнатами результата, merge — несколькими
 * реальными источниками; иначе (перенос стены, деформация, расширение одной комнаты) —
 * та же комната с новой геометрией, строгая проверка без послаблений.
 */
export type RoomHeir = { key: string; kind: "split" | "merge" | "same"; partKeys: string[] } | null;

export function roomHeirs(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
  exact: Map<string, string>,
  mode: FinishMode = "normalize",
): Map<string, RoomHeir> {
  const exp = (expectedRooms ?? {}) as RoomsMap;
  const got = (gotRooms ?? {}) as RoomsMap;
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

/** Режим сверки отделки: «normalize» — до записи (штатная топология редактора),
 *  «save» — после записи по GET (строго, без освобождений). */
export type FinishMode = "normalize" | "save";

export type FinishCompareResult = { problems: string[]; warnings: string[] };

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
  const warnings: string[] = [];

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
    const expCeil = ceilingSig(room);
    if (!gid) {
      if (!expFloor && !expCeil) continue; // только стены — сверяются по рёбрам ниже
      if (mode === "save") {
        // строго: комната на сервере не совпала по контуру — освобождений нет (ревью 98 N1)
        if (expFloor) problems.push(`room ${rid}: комната исчезла или изменилась на сервере — покрытие пола (${expFloor.cover}) потеряно`);
        if (expCeil) problems.push(`room ${rid}: комната исчезла или изменилась на сервере — покрытие потолка (${expCeil.material}) потеряно`);
        continue;
      }
      const heir = heirOf.get(rid) ?? null;
      if (!heir) {
        if (expFloor) problems.push(`room ${rid}: потеряно покрытие пола (${expFloor.cover}) при split/merge`);
        if (expCeil) problems.push(`room ${rid}: потеряно покрытие потолка (${expCeil.material}) при split/merge`);
        continue;
      }
      const heirRoom = got[heir.key]!;
      if (heir.kind === "split") {
        // split: пол/потолок наследует КАЖДАЯ часть (эталон 98: split-unequal, split-3)
        for (const k of heir.partKeys) {
          const part = got[k]!;
          if (expFloor) {
            const gf = floorSig(part);
            if (!gf || !sameFloor(expFloor, gf)) problems.push(`room ${rid}: часть ${k} не унаследовала покрытие пола (${expFloor.cover}) при split`);
          }
          if (expCeil) {
            const gc = ceilingSig(part);
            if (!gc || !sameCeiling(expCeil, gc)) problems.push(`room ${rid}: часть ${k} не унаследовала покрытие потолка (${expCeil.material}) при split`);
          }
        }
      } else {
        // merge: объединённая комната сохраняет покрытие ОДНОГО из источников
        // (эталон 98: merge-diff-floors — floor_tile, merge-one-floor — laminate+потолок)
        const sources = unmatchedExp
          .map((k) => exp[k]!)
          .filter((r) => overlapShare(roomPolygon(r) ?? [], roomPolygon(heirRoom) ?? []) >= SPLIT_MIN);
        const srcFloors = sources.map(floorSig).filter((s) => s !== undefined);
        const srcCeils = sources.map(ceilingSig).filter((s) => s !== undefined);
        const gotFloor = floorSig(heirRoom);
        const gotCeil = ceilingSig(heirRoom);
        if (srcFloors.length > 0 && (!gotFloor || !srcFloors.some((s) => sameFloor(s, gotFloor)))) {
          problems.push(`room ${rid}: объединённая комната потеряла покрытие пола (${srcFloors.map((s) => s.cover).join(" / ")}) при merge`);
        }
        if (srcCeils.length > 0 && (!gotCeil || !srcCeils.some((s) => sameCeiling(s, gotCeil)))) {
          problems.push(`room ${rid}: объединённая комната потеряла покрытие потолка (${srcCeils.map((s) => s.material).join(" / ")}) при merge`);
        }
      }
      continue;
    }
    const match = got[gid]!;
    if (expFloor) {
      const gotFloor = floorSig(match);
      if (!gotFloor) problems.push(`room ${rid}: потеряно покрытие пола (${expFloor.cover})`);
      else if (!sameFloor(expFloor, gotFloor)) {
        problems.push(`room ${rid}: покрытие пола не совпало (${JSON.stringify(expFloor)} → ${JSON.stringify(gotFloor)})`);
      }
    }
    if (expCeil) {
      const gotCeil = ceilingSig(match);
      if (!gotCeil) problems.push(`room ${rid}: потеряно покрытие потолка (${expCeil.material})`);
      else if (!sameCeiling(expCeil, gotCeil)) {
        problems.push(`room ${rid}: покрытие потолка не совпало (${JSON.stringify(expCeil)} → ${JSON.stringify(gotCeil)})`);
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
          problems.push(`room ${rid}: потеряна отделка стены ${sig.pid ?? "?"} (${sig.type}, слой ${sig.layer}) — комната не найдена на сервере`);
        }
        continue;
      }
      const heir = heirOf.get(rid) ?? null;
      if (!heir) {
        for (const sig of expWallsList) {
          problems.push(`room ${rid}: потеряна отделка стены ${sig.pid ?? "?"} (${sig.type}, слой ${sig.layer}) при split/merge`);
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
          (gotPartsByRoom.get(k) ?? []).some((g) => sameParams(w)(g) && gotPartNear(w, g, gotW) !== null && overlapsExpLine(w, g)),
        );
        if (!survived) {
          problems.push(`room ${rid}: потеряна отделка стены ${w.pid ?? "?"} (${w.type}, слой ${w.layer}) при split`);
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
        if (!how) continue;
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
        problems.push(`room ${rid}: потеряна отделка стены ${w.pid ?? "?"} (${w.type}, слой ${w.layer})`);
      }
    }
  }
  return { problems, warnings };
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
    const ceiling = ceilingSig(room);
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
      ...(ceiling ? { ceiling: { material: ceiling.material, level: ceiling.level ?? 0, ...(ceiling.profile ? { profile: ceiling.profile } : {}) } } : {}),
      walls,
    };
  });
}
