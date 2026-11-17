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

export type FinishSig = {
  floor?: { cover: string; width?: number; height?: number; stitch?: number; angle?: number; laying?: string };
  ceiling?: { material: string; level?: number; profile?: string };
  walls?: Array<{ pid?: string; line: [Point, Point]; type: string; layer: number; height: number; fromFloor: number }>;
};

const POLY_TOL = 1; // см: идентификация комнаты по геометрии

function polyKey(poly: Point[] | undefined): string {
  if (!poly || poly.length < 3) return "";
  let sx = 0, sy = 0;
  for (const p of poly) { sx += p.x; sy += p.y; }
  return `${Math.round(sx / poly.length / POLY_TOL)},${Math.round(sy / poly.length / POLY_TOL)}`;
}

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

function pointOnLineTol(p: Point, a: Point, b: Point, tol: number): boolean {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return Math.hypot(apx, apy) <= tol;
  const t = (apx * abx + apy * aby) / len2;
  if (t < -1e-9 || t > 1 + 1e-9) return false;
  return Math.hypot(apx - abx * t, apy - aby * t) <= tol;
}

/**
 * Покрытие отрезка expected отрезком got: та же прямая (перпендикуляр ≤ tol) и проекция
 * expected покрыта got не короче чем на 90% (редактор поджимает концы отделки к проёмам
 * и смещает линию внутрь комнаты на половину шва при нанесении через UI).
 */
function lineCovered(exp: [Point, Point], got: [Point, Point], tol = 6): boolean {
  const abx = got[1].x - got[0].x, aby = got[1].y - got[0].y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return false;
  const proj = (p: Point): { t: number; d: number } => {
    const apx = p.x - got[0].x, apy = p.y - got[0].y;
    const t = (apx * abx + apy * aby) / len2;
    return { t, d: Math.hypot(apx - abx * t, apy - aby * t) };
  };
  const a = proj(exp[0]);
  const b = proj(exp[1]);
  const covered = Math.min(Math.max(a.t, b.t), 1) - Math.max(Math.min(a.t, b.t), 0);
  const expLen = Math.hypot(exp[1].x - exp[0].x, exp[1].y - exp[0].y);
  if (a.d > tol || b.d > tol) return false;
  return covered * Math.sqrt(len2) >= expLen * 0.9 - 0.5;
}

/** Сумма проекций отрезков got (на прямую exp) покрывает отрезок exp не короче чем на 90%. */
function expSpanCovered(exp: [Point, Point], got: [Point, Point][], tol = 6): boolean {
  const expLen = Math.hypot(exp[1].x - exp[0].x, exp[1].y - exp[0].y);
  if (expLen < 1e-9) return true;
  const ex = exp[1].x - exp[0].x, ey = exp[1].y - exp[0].y;
  const spans: Array<[number, number]> = [];
  for (const line of got) {
    const p1 = { t: ((line[0].x - exp[0].x) * ex + (line[0].y - exp[0].y) * ey) / (expLen * expLen),
      d: (() => { const t = ((line[0].x - exp[0].x) * ex + (line[0].y - exp[0].y) * ey) / (expLen * expLen);
        return Math.hypot(line[0].x - exp[0].x - ex * t, line[0].y - exp[0].y - ey * t); })() };
    const p2 = { t: ((line[1].x - exp[0].x) * ex + (line[1].y - exp[0].y) * ey) / (expLen * expLen),
      d: (() => { const t = ((line[1].x - exp[0].x) * ex + (line[1].y - exp[0].y) * ey) / (expLen * expLen);
        return Math.hypot(line[1].x - exp[0].x - ex * t, line[1].y - exp[0].y - ey * t); })() };
    if (p1.d > tol || p2.d > tol) continue;
    spans.push([Math.max(Math.min(p1.t, p2.t), 0), Math.min(Math.max(p1.t, p2.t), 1)]);
  }
  spans.sort((s1, s2) => s1[0] - s2[0]);
  let reached = 0;
  for (const [a, b] of spans) {
    if (b <= reached) continue;
    if (a > reached + 1e-6) return false;
    reached = Math.max(reached, b);
    if (reached * expLen >= expLen * 0.9 - 0.5) return true;
  }
  return reached * expLen >= expLen * 0.9 - 0.5;
}

function sameFloor(exp: NonNullable<FinishSig["floor"]>, got: NonNullable<FinishSig["floor"]>): boolean {
  // умолчания редактора: сравниваем только то, что задал пользователь; значения,
  // появившиеся у редактора при нормализации (раскладка/швы по умолчанию), не блокируют
  if (exp.cover !== got.cover) return false;
  for (const k of ["width", "height", "stitch"] as const) {
    if (exp[k] !== undefined && got[k] !== undefined && Math.abs((exp[k] ?? 0) - (got[k] ?? 0)) > 0.05) return false;
  }
  if (exp.angle !== undefined && got.angle !== undefined && Math.abs(exp.angle - got.angle) > 0.05) return false;
  if (exp.laying !== undefined && got.laying !== undefined && exp.laying !== got.laying) return false;
  return true;
}

function sameCeiling(exp: NonNullable<FinishSig["ceiling"]>, got: NonNullable<FinishSig["ceiling"]>): boolean {
  if (exp.material !== got.material) return false;
  if (exp.level !== undefined && got.level !== undefined && exp.level !== got.level) return false;
  if (exp.profile !== undefined && got.profile !== undefined && exp.profile !== got.profile) return false;
  return true;
}

/** Список отделки для публичного ответа (finish_get): по одной или всем комнатам. */
export function finishList(model: Model, roomRef?: string): Record<string, unknown>[] {
  const rooms = roomsOf(model);
  const wallLabel = (pid: string | undefined, model2: Model): string | null => {
    if (!pid) return null;
    const walls = Object.values(model2.walls);
    const i = walls.findIndex((w) => w.id === pid);
    return i >= 0 ? `W${i + 1}` : null;
  };
  const entries = Object.entries(rooms).filter(([rid]) => !roomRef || rid === roomRef || `R${Object.keys(rooms).indexOf(rid) + 1}` === roomRef);
  if (roomRef && entries.length === 0) {
    // по метке R<n>
    const m = /^R(\d+)$/.exec(roomRef);
    if (m) {
      const found = Object.entries(rooms)[Number(m[1]) - 1];
      if (found) entries.push(found);
    }
  }
  return entries.map(([rid, room], index) => {
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
      id: `R${index + 1}`,
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

/**
 * Семантическая сверка отделки по комнатам (сопоставление по геометрии, не по id:
 * при изменении количества граней редактор пересоздаёт комнаты и decors).
 * Возвращает список расхождений (пусто — совпало).
 */
export function finishMismatches(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
): string[] {
  const exp = (expectedRooms ?? {}) as RoomsMap;
  const got = (gotRooms ?? {}) as RoomsMap;
  const problems: string[] = [];
  const gotKeys = Object.keys(got);
  for (const [rid, room] of Object.entries(exp)) {
    const key = polyKey(room.polygon ?? room.points);
    // сопоставление: по id, затем по центроиду полигона
    let match = got[rid];
    if (!match && key) {
      match = gotKeys.map((k) => got[k]!).find((r) => polyKey(r.polygon ?? r.points) === key);
    }
    if (!match) {
      const hasFinish = room.floors?.[0]?.exist || room.ceilings?.[0]?.exist || (room.decors ?? []).some((d) => d.exist);
      if (hasFinish) problems.push(`room ${rid}: комната с отделкой исчезла`);
      continue;
    }
    const expFloor = floorSig(room);
    const gotFloor = floorSig(match);
    if (expFloor && !gotFloor) problems.push(`room ${rid}: потеряно покрытие пола (${expFloor.cover})`);
    if (expFloor && gotFloor && !sameFloor(expFloor, gotFloor)) {
      problems.push(`room ${rid}: покрытие пола не совпало (${JSON.stringify(expFloor)} → ${JSON.stringify(gotFloor)})`);
    }
    const expCeil = ceilingSig(room);
    const gotCeil = ceilingSig(match);
    if (expCeil && !gotCeil) problems.push(`room ${rid}: потеряно покрытие потолка (${expCeil.material})`);
    if (expCeil && gotCeil && !sameCeiling(expCeil, gotCeil)) {
      problems.push(`room ${rid}: покрытие потолка не совпало (${JSON.stringify(expCeil)} → ${JSON.stringify(gotCeil)})`);
    }
    // отделка стен: каждая ожидаемая сторона должна найтись среди сторон got; сопоставление
    // геометрией (стена могла быть разрезана/переименована): сумма частей должна покрывать
    // ожидаемый отрезок (стена разрезана — частей несколько; потерян кусок — покрытие меньше)
    const expWalls = wallSigs(room, Array.isArray(room.edges) ? room.edges : undefined);
    const gotWalls = wallSigs(match, Array.isArray(match.edges) ? match.edges : undefined);
    for (const w of expWalls) {
      const sameParams = (g: { type: string; layer: number; height: number; fromFloor: number }): boolean =>
        g.type === w.type && g.layer === w.layer &&
        Math.abs(g.height - w.height) <= 0.05 && Math.abs(g.fromFloor - w.fromFloor) <= 0.05;
      const onLine = (g: { pid?: string; line: [Point, Point]; type: string; layer: number; height: number; fromFloor: number }): boolean => {
        if (w.pid && g.pid && w.pid === g.pid) return true;
        return lineCovered(w.line, g.line) || lineCovered(g.line, w.line);
      };
      const parts = gotWalls.filter((g) => sameParams(g) && onLine(g));
      if (!expSpanCovered(w.line, parts.map((g) => g.line))) {
        problems.push(`room ${rid}: потеряна отделка стены ${w.pid ?? "?"} (${w.type}, слой ${w.layer})`);
      }
    }
  }
  return problems;
}
