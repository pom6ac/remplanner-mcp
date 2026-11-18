import { z } from "zod";
import { mm, mmInt, mmPoint } from "./units.ts";
import { throwNotFound } from "./common.ts";
import { wallRef } from "./walls.ts";
import { compactModel, wallLengthMm } from "../model/compact.ts";
import { roomPolygons } from "../model/items.ts";
import type { MmPoint } from "../model/walls.ts";
import type { Model, ItemProps, Wall } from "../model/types.ts";
import type { RoomPolygon } from "../model/items.ts";

// DTO группы «каталог и предметы»: позиционные схемы (center/against_wall/in_room),
// разрешение ссылок I<n>, перевод позиций мм↔см и публичный вид позиции каталога
// (см каталога → мм ответа).

/** Позиция предмета при постановке: центр / у стены / в углу комнаты. */
export const position = z.union([
  z.object({ center: mmPoint }),
  z.object({ against_wall: z.object({
    wall_id: wallRef,
    offset_mm: mmInt.describe("смещение центра предмета от начала стены (учитывая from)"),
    from: z.enum(["start", "end"]).optional(),
    gap_mm: mm.optional().describe("зазор до внутренней грани стены (0 — вплотную, по умолчанию)"),
  }) }),
  z.object({ in_room: z.object({
    room_id: z.string().min(1).describe("метка комнаты R<n> из model_get"),
    corner: z.enum(["nw", "ne", "se", "sw", "center"]),
  }) }),
]);

/** Позиция при переносе существующего предмета (без in_room). */
export const positionMove = z.union([
  z.object({ center: mmPoint }),
  z.object({ against_wall: z.object({
    wall_id: wallRef, offset_mm: mmInt, from: z.enum(["start", "end"]).optional(), gap_mm: mm.optional(),
  }) }),
]);

/** Предмет по site-id или метке I1…I_n. */
export function resolveItem(model: Model, ref: string): ItemProps {
  if (model.items[ref]) return model.items[ref]!;
  const m = /^I(\d+)$/.exec(ref);
  if (m) {
    const items = Object.values(model.items);
    const item = items[Number(m[1]) - 1];
    if (item) return item;
  }
  return throwNotFound(`предмет ${ref} не найден (id сайта или метка I<n> из model_get)`);
}

/** Публичный вид найденной позиции каталога (см каталога → мм). */
export function catalogFoundView(t: {
  name: string; title: string; group: string; width: number; height: number; self_height: number; resizable?: boolean;
}): Record<string, unknown> {
  return {
    name: t.name, title: t.title, group: t.group,
    width_mm: t.width * 10, depth_mm: t.height * 10, height_mm: t.self_height * 10,
    resizable: t.resizable ?? false,
  };
}

/** Публичный вид позиции каталога catalog_get (см каталога → мм). */
export function catalogEntryView(entry: {
  name: string; title: string; group: string; subgroup?: string; width: number; height: number;
  self_height: number; resizable?: boolean; anchor?: string; is_magnetized?: boolean; can_be_outside?: boolean;
}): Record<string, unknown> {
  return {
    name: entry.name, title: entry.title, group: entry.group, subgroup: entry.subgroup ?? null,
    width_mm: entry.width * 10, depth_mm: entry.height * 10, height_mm: entry.self_height * 10,
    resizable: entry.resizable ?? false, anchor: entry.anchor ?? null,
    magnetized: entry.is_magnetized ?? false, can_be_outside: entry.can_be_outside ?? false,
  };
}

/** Перевод публичной позиции (center|against_wall|in_room) в позицию модельного слоя. */
export function normalizePosition(raw: Record<string, unknown>, model: Model, rooms?: RoomPolygon[]): Parameters<typeof import("../model/items.ts").addItem>[1]["position"] {
  if ("center" in raw) return { center: raw["center"] as MmPoint };
  if ("against_wall" in raw) {
    const aw = raw["against_wall"] as Record<string, unknown>;
    const wall = model.walls[aw["wall_id"] as string];
    if (!wall) {
      const m = /^W(\d+)$/.exec(aw["wall_id"] as string);
      const walls = Object.values(model.walls);
      const byLabel = m ? walls[Number(m[1]) - 1] : undefined;
      if (!byLabel) throwNotFound(`стена ${String(aw["wall_id"])} не найдена`);
      aw["wall_id"] = byLabel.id;
    }
    return { againstWall: {
      wallId: aw["wall_id"] as string,
      offsetMm: aw["offset_mm"] as number,
      from: aw["from"] as "start" | "end" | undefined,
      gapMm: aw["gap_mm"] as number | undefined,
    } };
  }
  if ("in_room" in raw) {
    const ir = raw["in_room"] as Record<string, unknown>;
    const roomList = rooms ?? roomPolygons(model);
    const idx = Number(/^R(\d+)$/.exec(ir["room_id"] as string)?.[1] ?? 0) - 1;
    const room = roomList[idx];
    if (!room) throwNotFound(`комната ${String(ir["room_id"])} не найдена (метки комнат — из model_get)`);
    // модельный слой берёт первую комнату — для выбранной считаем точку угла сами (в мм)
    const xs = room.polygon.map((p) => p.x);
    const ys = room.polygon.map((p) => p.y);
    const minX = Math.min(...xs) * 10, maxX = Math.max(...xs) * 10;
    const minY = Math.min(...ys) * 10, maxY = Math.max(...ys) * 10;
    void ir;
    return { center: cornerPoint(ir["corner"] as string, minX, maxX, minY, maxY) };
  }
  throw Object.assign(new Error("position: нужен center | against_wall | in_room"), { code: "INVALID_ARGUMENT" });
}

function cornerPoint(corner: string, minX: number, maxX: number, minY: number, maxY: number): MmPoint {
  // точный прижим в угол делал addItem; здесь — точка у угла с отступом полгабарита предмета,
  // addItem сам проверит попадание в комнату (OUTSIDE_ROOM при ошибке)
  const inset = 150; // мм от стен — предмет войдёт в комнату с типовыми габаритами
  switch (corner) {
    case "nw": return { x: minX + inset, y: minY + inset };
    case "ne": return { x: maxX - inset, y: minY + inset };
    case "se": return { x: maxX - inset, y: maxY - inset };
    case "sw": return { x: minX + inset, y: maxY - inset };
    default: return { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2) };
  }
}

/**
 * Перенос предмета к стене (item_update against_wall): точка на оси с зазором
 * (см модели) и угол по направлению оси. Публичные мм → см модели.
 */
export function againstWallCenter(
  wall: Wall,
  aw: { offset_mm: number; from?: "start" | "end"; gap_mm?: number },
  itemHeightCm: number,
): { center: MmPoint; angleDeg: number } {
  const len = wallLengthMm(wall);
  const off = aw.from === "end" ? len - aw.offset_mm : aw.offset_mm;
  const t = Math.min(Math.max(off / len, 0), 1);
  const px = wall.p1.x + (wall.p2.x - wall.p1.x) * t;
  const py = wall.p1.y + (wall.p2.y - wall.p1.y) * t;
  const dirx = (wall.p2.x - wall.p1.x) / len;
  const diry = (wall.p2.y - wall.p1.y) / len;
  const angleDeg = Math.atan2(diry, dirx) * 180 / Math.PI;
  // нормаль в сторону комнаты подберёт gap при updateItem? — упрощённо: центр на оси + gap по нормали вправо
  const gap = (aw.gap_mm ?? 0) / 10 + itemHeightCm / 2;
  return {
    center: { x: Math.round((px + diry * gap) * 10), y: Math.round((py - dirx * gap) * 10) },
    angleDeg: Math.round(angleDeg),
  };
}

/** Индексы предметов (в порядке compactModel) внутри комнаты с индексом roomIndex. */
export function itemsInRoom(model: Model, rooms: RoomPolygon[], roomIndex: number): Set<number> {
  const compact = compactModel(model, rooms);
  const siteItems = Object.values(model.items);
  const out = new Set<number>();
  compact.items.forEach((ci, i) => {
    const site = siteItems[i];
    void site;
    void rooms;
    if (ci && roomIndex >= 0) {
      // принадлежность по точке центра: комнаты в том же порядке, что и в model_get
      const inside = rooms[roomIndex] ? pointInside(model, rooms[roomIndex]!, compact.items[i]!) : false;
      if (inside) out.add(i);
    }
  });
  return out;
}

function pointInside(model: Model, room: { polygon: { x: number; y: number }[]; roomId: string | null }, item: { x_mm: number; y_mm: number }): boolean {
  void model;
  // roomPolygons возвращает полигон в см
  const x = item.x_mm / 10;
  const y = item.y_mm / 10;
  let s = 0;
  const poly = room.polygon;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(s) < 1e-9) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
