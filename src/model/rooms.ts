import type { Model, Point, Wall } from "./types.ts";
import { polygonArea, pointInPolygon, scale, add, type Polygon } from "./geometry.ts";

// ---------- комнаты (канонические полигоны считает редактор: rooms2) ----------

export type RoomPolygon = {
  roomId: string | null;
  polygon: Polygon;
  areaCm2: number;
  /** Площадь по осевым линиям, см² (для комнат из rooms2 недоступна — null). */
  axisAreaCm2: number | null;
};

/**
 * Полигоны помещений — ТОЛЬКО из rooms2 нормализованной модели редактора (design §12.5).
 * Самодельные контуры по связям стен удалены (wallCycles, R2-7): редактор считает комнаты
 * из геометрии при draw, Node не дублирует эту работу. Если rooms2 нет (модель не
 * нормализовалась) — комнат нет, инструменты сообщат no_rooms.
 */
export function roomPolygons(model: Model): RoomPolygon[] {
  const rooms2 = model.rooms2 as Record<string, { polygon?: Point[]; area?: number }> | undefined;
  if (!rooms2) return [];
  return Object.entries(rooms2)
    .filter(([, r]) => r && Array.isArray(r.polygon) && r.polygon.length >= 3)
    .map(([rid, room]) => ({
      roomId: rid,
      polygon: room.polygon as Polygon,
      areaCm2: typeof room.area === "number" ? (room.area as number) * 10_000 : polygonArea(room.polygon as Polygon),
      axisAreaCm2: null, // осевой контур для комнат редактора не восстанавливаем (№15)
    }));
}

/** ε пробной точки стороны стены: 0.01 см = 0.1 мм, больше допуска pointInPolygon (ревью 198 №4). */
export const PROBE_EPS_CM = 0.01;

/**
 * Сторона стены по пробным точкам (ревью 198 №4; общий хелпер постановки у стены
 * и электрики — ревью 209 №3): внутренняя сторона — та, чья пробная точка
 * (depth/2 + ε от оси стены в точке anchor, по нормали nl и против неё) попала
 * в полигон комнаты. Попали обе (перегородка) или ни одна (стена вне помещений) —
 * null: запасное правило выбирает вызывающий.
 */
export function inwardSideByProbe(wall: Wall, nl: Point, anchor: Point, rooms: RoomPolygon[]): Point | null {
  const plus = add(anchor, scale(nl, wall.depth / 2 + PROBE_EPS_CM));
  const minus = add(anchor, scale(scale(nl, -1), wall.depth / 2 + PROBE_EPS_CM));
  const inPlus = rooms.find((room) => pointInPolygon(room.polygon, plus));
  const inMinus = rooms.find((room) => pointInPolygon(room.polygon, minus));
  if (inPlus && !inMinus) return nl;
  if (inMinus && !inPlus) return scale(nl, -1);
  return null;
}
