import type { Model, Point } from "./types.ts";
import { McpError } from "../errors.ts";
import { MAX_NAME_CHARS } from "../limits.ts";
import { resolveRoom } from "./finish.ts";
import { polygonArea } from "./geometry.ts";

/**
 * Пользовательские поля помещения (этап 347, бэклог 328 §7 «Отделка»): имя
 * (zones[0].name — контекстное меню зоны, #cm-room2--zone-name) и цвет зоны
 * (zones[0].color — палитра #cm-room2). Номер зоны — производное редактора
 * (number_by_area: зоны всех помещений сортируются по убыванию площади,
 * ROOMS2.draw) — читается в компактном API, не задаётся и не сверяется.
 *
 * Формы записи — по бандлу:
 * - имя: "" и "?" трактуются редактором как «без имени» → в модели "none"
 *   (#cm-room2--zone-name change); удаление имени — тоже "none" (#cm-room2
 *   [action="delete"]).
 * - цвет: строка "#rrggbb" (hex палитры, lowercase); "ffffff" удаляет поле
 *   (delete selected.zone.color).
 */

/** Имя без имени в модели редактора (эталон 318: зоны name:"none"). */
export const ROOM_NO_NAME = "none";

/** Контрольные символы запрещены: имя попадает в SVG-текст легенды редактора. */
const ROOM_NAME_CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function setRoomName(model: Model, roomRef: string, name: string | null): { id: string; name: string | null } {
  if (name !== null) {
    if (typeof name !== "string") throw new McpError("INVALID_ARGUMENT", "name должен быть строкой или null");
    if (name.length > MAX_NAME_CHARS) {
      throw new McpError("INVALID_ARGUMENT", `name длиннее ${MAX_NAME_CHARS} символов`);
    }
    if (ROOM_NAME_CONTROL_RE.test(name)) {
      throw new McpError("INVALID_ARGUMENT", "name не должен содержать управляющие символы и переводы строк");
    }
  }
  const { id, room } = resolveRoom(model, roomRef);
  const zones = Array.isArray(room.zones) ? room.zones as Array<Record<string, unknown>> : [];
  if (zones.length === 0 || !zones[0]) {
    throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomRef} нет зон редактора (zones[0]) — имя помещения не задаётся`);
  }
  // как в редакторе: "" и "?" — «без имени» ("none")
  const value = name === null || name === "" || name === "?" ? ROOM_NO_NAME : name;
  zones[0]!["name"] = value;
  return { id, name: value === ROOM_NO_NAME ? null : value };
}

const ROOM_COLOR_RE = /^#?([0-9a-fA-F]{6})$/;

export function setRoomColor(model: Model, roomRef: string, color: string | null): { id: string; color: string | null } {
  const { id, room } = resolveRoom(model, roomRef);
  const zones = Array.isArray(room.zones) ? room.zones as Array<Record<string, unknown>> : [];
  if (zones.length === 0 || !zones[0]) {
    throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomRef} нет зон редактора (zones[0]) — цвет зоны не задаётся`);
  }
  if (color === null || color.toLowerCase() === "#ffffff" || color.toLowerCase() === "ffffff") {
    // как в редакторе: белый (#ffffff) удаляет цвет (delete selected.zone.color)
    delete zones[0]!["color"];
    return { id, color: null };
  }
  const m = ROOM_COLOR_RE.exec(color);
  if (!m) {
    throw new McpError("INVALID_ARGUMENT", "color должен быть hex-цветом #rrggbb или null (белый — сброс, как в редакторе)");
  }
  const value = `#${m[1]!.toLowerCase()}`;
  zones[0]!["color"] = value;
  return { id, color: value };
}

/**
 * Номера зон по правилу редактора (ROOMS2.draw, бандл @93695): зоны всех
 * помещений (кроме террас; микрозоны is_micro_zone и записи-заглушки без
 * площади не нумеруются) сортируются по убыванию площади и нумеруются с 1.
 * area в модели в м² (число), при отсутствии — из полигона (см²).
 * Возвращает (roomId → (индекс зоны → номер)).
 */
export function zoneNumbersByEditorRule(model: Model): Map<string, Map<number, number>> {
  const rooms = (model.rooms2 ?? model.rooms1 ?? {}) as Record<string, Record<string, unknown>>;
  type Entry = { roomId: string; zoneIndex: number; area: number };
  const entries: Entry[] = [];
  for (const [rid, room] of Object.entries(rooms)) {
    if (room["role"] === "terrace") continue;
    const zoneList = Array.isArray(room["zones"]) ? room["zones"] as Array<Record<string, unknown>> : [];
    zoneList.forEach((z, zi) => {
      if (!z || z["is_micro_zone"] === true) return;
      const area = typeof z["area"] === "number" && (z["area"] as number) > 0
        ? (z["area"] as number) * 10_000 // м² → см²
        : (Array.isArray(z["polygon"]) && (z["polygon"] as Point[]).length >= 3 ? polygonArea(z["polygon"] as Point[]) : 0);
      if (area <= 0.01) return; // вырожденные зоны редактор не нумерует (area < 1 см²)
      entries.push({ roomId: rid, zoneIndex: zi, area });
    });
  }
  // сравнение площадей по убыванию (compareAreasDesc), равные — в порядке обхода
  entries.sort((a, b) => b.area - a.area);
  const out = new Map<string, Map<number, number>>();
  entries.forEach((e, i) => {
    let m = out.get(e.roomId);
    if (!m) { m = new Map(); out.set(e.roomId, m); }
    m.set(e.zoneIndex, i + 1);
  });
  return out;
}
