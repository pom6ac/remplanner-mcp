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

/** Контрольные символы запрещены: имя попадает в SVG-текст легенды редактора.
 *  n1 ревью 348: кроме ASCII-управляющих — переводы строк U+2028/U+2029,
 *  bidi-управляющие (U+202A–202E, U+2066–2069) и zero-width (U+200B–200F):
 *  подмена отображения в легенде возможна и без инъекции. */
const ROOM_NAME_CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

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

/** Площадь комнаты в м²: поле area (м², как у Room2 редактора) либо из полигона (см²). */
function roomAreaM2(room: Record<string, unknown>): number {
  if (typeof room["area"] === "number" && room["area"] > 0) return room["area"] as number;
  const poly = Array.isArray(room["polygon"]) ? room["polygon"] as Point[] : Array.isArray(room["points"]) ? room["points"] as Point[] : [];
  return poly.length >= 3 ? polygonArea(poly) / 10_000 : 0;
}

/**
 * Микрокомната редактора (Room2.isMicroRoom, бандл 268-app.js): площадь меньше
 * defs.areaMicroRoom (= 1 м²) и нет проёмов (holes_polygons пуст — вторая
 * реализация isMicroRoom в бандле; у Room1 проверка проёмов идёт по стенам).
 * FIELD m2 ревью 348: такие комнаты редактор не нумерует.
 */
function isMicroRoom(room: Record<string, unknown>): boolean {
  if (roomAreaM2(room) >= 1) return false;
  const hp = room["holes_polygons"];
  if (hp === undefined || hp === null) return true;
  if (Array.isArray(hp)) return hp.length === 0;
  if (typeof hp === "object") return Object.keys(hp as object).length === 0;
  return true;
}

/**
 * Номера зон по правилу редактора (ROOMS2.draw → updateNumbers, бандл @93695):
 * комнаты — кроме террас и микрокомнат (isMicroRoom: площадь < 1 м² без
 * проёмов, FIELD m2 ревью 348); зоны — кроме микрозон (is_micro_zone) и записей
 * без класса (is_class, бандл: `!zones[e].is_class || zones[e].is_micro_zone`
 * — не нумеруются). is_class null/undefined в данных GET — артефакт сериализации
 * (api-dump.rooms2-reopen: number_by_area записан при is_class true, после
 * перечитывания is_class null) — такие зоны нумеруются; явно false — нет.
 * Зоны всех помещений сортируются по убыванию площади и нумеруются с 1.
 * area в модели в м² (число), при отсутствии — из полигона (см²).
 * Возвращает (roomId → (индекс зоны → номер)).
 */
export function zoneNumbersByEditorRule(model: Model): Map<string, Map<number, number>> {
  const rooms = (model.rooms2 ?? model.rooms1 ?? {}) as Record<string, Record<string, unknown>>;
  type Entry = { roomId: string; zoneIndex: number; area: number };
  const entries: Entry[] = [];
  for (const [rid, room] of Object.entries(rooms)) {
    if (room["role"] === "terrace") continue;
    if (isMicroRoom(room)) continue;
    const zoneList = Array.isArray(room["zones"]) ? room["zones"] as Array<Record<string, unknown>> : [];
    zoneList.forEach((z, zi) => {
      if (!z || z["is_class"] === false || z["is_micro_zone"] === true) return;
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
