import type { Model, Point } from "./types.ts";
import { polygonArea, type Polygon } from "./geometry.ts";

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
