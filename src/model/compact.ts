import type { Model, Wall } from "./types.ts";
import { cmToMm, round0 } from "./units.ts";
import type { RoomPolygon } from "./items.ts";
import { roomPolygons } from "./items.ts";
import { holeOffsetFromStart } from "./openings.ts";
import { wallFaces } from "./walls.ts";
import { projectionLength, type Segment } from "./geometry.ts";

// Компактное представление модели для агента (< 5 КБ): метки W/R/O/I, мм.

export type CompactWall = {
  id: string;
  site_id: string;
  /** Осевые концы, мм. */
  from: [number, number];
  to: [number, number];
  len_mm: number;
  len_inner_mm: number;
  thickness_mm: number;
  openings: CompactOpening[];
};

export type CompactOpening = {
  id: string;
  wall: string;
  type: string;
  offset_mm: number;
  width_mm: number;
  height_mm: number;
  sill_mm: number;
  /** Число створок (окна). */
  casements?: number;
  /** Угол рассвета, градусы (окна). */
  slope_angle_deg?: number;
  /** Сторона открывания из модели (окна: "r", "l", "r-l", "l-r"). */
  opening?: string;
  /** Короб с наличниками (двери и окна; 1 — включён). */
  casing?: number;
  /** Арочный проём. */
  arched?: boolean;
  /** Подоконник (окна). */
  sill?: { thickness_mm: number; overhang_mm: number; overmeasure_mm: number } | null;
  /** Балконный блок (windoor): части окна и двери. */
  window_width_mm?: number;
  window_height_mm?: number;
  door_width_mm?: number;
  door_height_mm?: number;
  door_position?: "l" | "r";
  /** Балконная дверь: импост, мм от низа двери (поле impost_offset модели; высота от пола = значение + подоконник). */
  impost_offset_mm?: number;
};

export type CompactRoom = {
  id: string;
  name: string | null;
  /** Площадь по внутренним граням (как показывает редактор), м². */
  area_m2: number;
  /** Площадь по осевым линиям, м² (null для комнат из rooms2 — осевой контур не восстанавливается). */
  area_axis_m2: number | null;
  perimeter_mm: number;
};

export type CompactItem = {
  id: string;
  name: string;
  x_mm: number;
  y_mm: number;
  angle_deg: number;
  width_mm: number;
  depth_mm: number;
  height_mm: number;
};

export type CompactPillar = {
  id: string;
  site_id: string;
  x_mm: number;
  y_mm: number;
  angle_deg: number;
  /** Габарит по X, мм. */
  width_mm: number;
  /** Габарит по Y (глубина), мм. */
  depth_mm: number;
  /** Высота, мм. */
  total_height_mm: number;
};

export type CompactModel = {
  walls: CompactWall[];
  rooms: CompactRoom[];
  items: CompactItem[];
  pillars: CompactPillar[];
  total_height_mm: number;
};

export function wallLengthMm(wall: Wall): number {
  return round0(cmToMm(Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y)));
}

/**
 * Длина по внутренним граням: берём реальные грани (wallFaces: углы стыков с соседями)
 * и проецируем на ось; из двух сторон берём ту, что короче (внутренняя грань комнаты;
 * находка №15 ревью: вычитание собственной толщины врало при разных толщинах соседей).
 */
export function wallInnerLengthMm(wall: Wall, walls: Record<string, Wall> = {}): number {
  try {
    const faces = wallFaces(wall, walls);
    const axis: Segment = { p1: wall.p1, p2: wall.p2 };
    const lenL = Math.abs(projectionLength(axis, faces.l2) - projectionLength(axis, faces.l1));
    const lenR = Math.abs(projectionLength(axis, faces.r2) - projectionLength(axis, faces.r1));
    return round0(cmToMm(Math.min(lenL, lenR)));
  } catch {
    return wallLengthMm(wall);
  }
}

/** Компактное представление: стены с метками, комнаты с площадями, проёмы с отступами, предметы.
 *  rooms — комнаты из кеша workspace (нормализованная модель), если в model.rooms2 их ещё нет. */
export function compactModel(model: Model, rooms?: RoomPolygon[]): CompactModel {
  const roomList: RoomPolygon[] = rooms && rooms.length > 0 ? rooms : roomPolygons(model);
  const roomNames = model.rooms2 as Record<string, { zones?: Array<{ name?: string }>; name?: string }> | undefined;

  const siteToLabel = new Map<string, string>();
  const walls: CompactWall[] = Object.values(model.walls).map((wall, i) => {
    const label = `W${i + 1}`;
    siteToLabel.set(wall.id, label);
    const lenInner = wallInnerLengthMm(wall, model.walls);
    const openings: CompactOpening[] = Object.values(wall.holes ?? {}).map((hole) => {
      const c: CompactOpening = {
        id: hole.id,
        wall: label,
        type: hole.type,
        offset_mm: round0(holeOffsetFromStart(wall, hole)),
        width_mm: round0(cmToMm(hole.width)),
        height_mm: hole.height !== undefined ? round0(cmToMm(hole.height)) : 0,
        sill_mm: hole.floor_height !== undefined ? round0(cmToMm(hole.floor_height)) : 0,
      };
      const sill = hole.sill as { thinkness?: number; overhang?: number; overmeasure?: number } | undefined;
      if (sill && typeof sill === "object") {
        c.sill = {
          thickness_mm: round0(cmToMm(sill.thinkness ?? 0)),
          overhang_mm: round0(cmToMm(sill.overhang ?? 0)),
          overmeasure_mm: round0(cmToMm(sill.overmeasure ?? 0)),
        };
      }
      if (hole.casements !== undefined) c.casements = hole.casements;
      if (hole.slope_angle !== undefined) c.slope_angle_deg = hole.slope_angle as number;
      if (hole.opening !== undefined) c.opening = hole.opening;
      if (hole.casing !== undefined) c.casing = hole.casing as number;
      if (hole.arched !== undefined && hole.arched !== 0) c.arched = true;
      if (hole.window_width !== undefined) c.window_width_mm = round0(cmToMm(hole.window_width as number));
      if (hole.window_height !== undefined) c.window_height_mm = round0(cmToMm(hole.window_height as number));
      if (hole.door_width !== undefined) c.door_width_mm = round0(cmToMm(hole.door_width as number));
      if (hole.door_height !== undefined) c.door_height_mm = round0(cmToMm(hole.door_height as number));
      if (hole.door_position !== undefined) c.door_position = hole.door_position as "l" | "r";
      if (hole.impost_offset !== undefined) c.impost_offset_mm = round0(cmToMm(hole.impost_offset as number));
      return c;
    });
    return {
      id: label,
      site_id: wall.id,
      from: [round0(cmToMm(wall.p1.x)), round0(cmToMm(wall.p1.y))],
      to: [round0(cmToMm(wall.p2.x)), round0(cmToMm(wall.p2.y))],
      len_mm: wallLengthMm(wall),
      len_inner_mm: lenInner,
      thickness_mm: round0(cmToMm(wall.depth)),
      openings,
    };
  });

  const compactRooms: CompactRoom[] = roomList.map((room, i) => {
    let perimeter = 0;
    for (let j = 0; j < room.polygon.length; j++) {
      const a = room.polygon[j]!;
      const b = room.polygon[(j + 1) % room.polygon.length]!;
      perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const name = room.roomId && roomNames?.[room.roomId]
      ? ((roomNames[room.roomId] as { zones?: Array<{ name?: string }> }).zones?.[0]?.name ?? null)
      : null;
    return {
      id: `R${i + 1}`,
      name,
      area_m2: Math.round((room.areaCm2 / 10_000) * 100) / 100,
      area_axis_m2: room.axisAreaCm2 === null ? null : Math.round((room.axisAreaCm2 / 10_000) * 100) / 100,
      perimeter_mm: round0(cmToMm(perimeter)),
    };
  });

  const items: CompactItem[] = Object.values(model.items).map((item, i) => ({
    id: `I${i + 1}`,
    name: item.name,
    x_mm: round0(cmToMm(item.pc.x)),
    y_mm: round0(cmToMm(item.pc.y)),
    angle_deg: item.angle,
    width_mm: round0(cmToMm(item.width)),
    depth_mm: round0(cmToMm(item.height)),
    height_mm: round0(cmToMm(item.self_height ?? 0)),
  }));

  const pillars: CompactPillar[] = Object.values(model.pillars ?? {}).map((pillar, i) => ({
    id: `P${i + 1}`,
    site_id: pillar.id,
    x_mm: round0(cmToMm(pillar.pc.x)),
    y_mm: round0(cmToMm(pillar.pc.y)),
    angle_deg: pillar.angle ?? 0,
    width_mm: round0(cmToMm(pillar.width)),
    depth_mm: round0(cmToMm(pillar.height)),
    total_height_mm: round0(cmToMm(pillar.total_height ?? 270)),
  }));

  const totalHeight = typeof model.total_height === "number" ? model.total_height : 270;
  return {
    walls,
    rooms: compactRooms,
    items,
    pillars,
    total_height_mm: round0(cmToMm(totalHeight)),
  };
}

export function compactModelJson(model: Model): string {
  return JSON.stringify(compactModel(model));
}
