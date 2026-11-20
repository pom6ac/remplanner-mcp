import { z } from "zod";
import { mm, mmInt, mmPoint } from "./units.ts";
import { throwNotFound } from "./common.ts";
import { wallRef } from "./walls.ts";
import { compactModel } from "../model/compact.ts";
import { againstWallPlacement, faceOffsetCm, roomPolygons } from "../model/items.ts";
import { cmToMm, round0 } from "../model/units.ts";
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
    offset_mm: mmInt.describe("смещение ближнего края предмета от конца стены from (start — от начала стены, end — от конца; по умолчанию start); центр предмета = offset_mm + половина ширины"),
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
    wall_id: wallRef, offset_mm: mmInt.describe("смещение ближнего края предмета от конца стены from (start — от начала стены, end — от конца; по умолчанию start); центр предмета = offset_mm + половина ширины"), from: z.enum(["start", "end"]).optional(), gap_mm: mm.optional(),
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
 * Перенос предмета к стене (item_update against_wall): та же формула модельного
 * слоя, что у item_add against_wall (againstWallPlacement) — точка на внутренней
 * стороне стены (полутолщина стены + зазор + полуглубина предмета), offset с
 * полушириной вдоль стены, угол оси в (−90; 90]. Ревью 190: прежний дубль формулы
 * в DTO смешивал мм и см (нормаль в 10 раз короче), терял полутолщину стены и
 * полуширину и брал нормаль «вправо» без учёта помещения. Публичные мм → см
 * модели; центр ответа — целые мм. Ревью 269 М1: itemName — точка привязки по
 * виду предмета (одно правило с item_add); probePointCm — пробная точка на
 * внутренней грани (см) для видов с pc в стене (int_manifold_box).
 */
export function againstWallCenter(
  wall: Wall,
  aw: { offset_mm: number; from?: "start" | "end"; gap_mm?: number },
  itemWidthCm: number,
  itemDepthCm: number,
  rooms: RoomPolygon[],
  itemName?: string,
): { center: MmPoint; pcCm: { x: number; y: number }; angleDeg: number; probePointCm?: { x: number; y: number } } {
  // ревью 271 N1: пробная точка грани нужна только видам с pc в стене
  // (faceOffsetCm !== null) — те же виды, у которых item_add её использует;
  // item_update против обычных видов не должен получать её, иначе pc вне
  // комнат проходит без OUTSIDE_ROOM (расхождение add/update)
  const face = itemName !== undefined ? faceOffsetCm(itemName) : null;
  const { pc, angleDeg, probePoint } = againstWallPlacement(wall, {
    wallId: wall.id, offsetMm: aw.offset_mm, from: aw.from, gapMm: aw.gap_mm,
  }, itemWidthCm, itemDepthCm, rooms, face ?? undefined);
  return {
    center: { x: round0(cmToMm(pc.x)), y: round0(cmToMm(pc.y)) },
    // точный центр в см модели (точность хранения 0.1 мм) — tools-plan передаёт
    // его в updateItem centerCm, чтобы правило привязки по виду не искажалось
    // округлением до целых мм
    pcCm: { x: pc.x, y: pc.y },
    angleDeg: Math.round(angleDeg),
    ...(face !== null ? { probePointCm: { x: probePoint.x, y: probePoint.y } } : {}),
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
