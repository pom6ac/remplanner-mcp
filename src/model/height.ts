import type { Model, Wall, Hole } from "./types.ts";
import { McpError } from "../errors.ts";

// Высота проекта (этап 419, бэклог 418 §4 A): точная семантика $Project.setHeigth
// бандла (268-app.js, символ setHeigth):
//   setHeigth(e){ params.total_height=e;
//     for (ROOMS2) r.height=e;
//     for (WALLS) if ("balcony"!==A.role){ A.height=e; clamp holes }
//     … (PILLARS и rebuildDecorPrs — производные/рантайм, см. ниже) }
// Обработчик меню «Высота» (#cm-room2--zone-height): e=LIB.lengthInSystemUnits(e);
// e=LIB.correctValue(e,50,999) — диапазон 50..999 см; MCP отклоняет вне 500..9990 мм
// (INVALID_ARGUMENT, без молчаливой обрезки — согласованное правило «не имитировать
// молчаливые правки», как у finish_floor_offset_set m4 ревью 348).
// Клампинг проёмов — дословно ветки бандла (внутри цикла WALLS, т.е. только у стен
// не-balcony):
//   "windows"===l.group && "window"===l.type:
//     l.height > Math.round(total−floor_height) → l.height=Math.max(Math.round(total−floor_height),30)
//     (floor_height не число → сравнение с NaN ложно в JS — ветка не срабатывает, здесь пропуск);
//   "windows"===l.group && "windoor"===l.type:
//     window_height>total → window_height=total; door_height>total → door_height=total.
// Вне скоупа этапа (зафиксировано в отчёте 419): бандл также патчит PILLARS[*].total_height
// (ветка gypsum с переносом старого значения), клампит высоту дверей группы "doors"
// и вызывает rebuildDecorPrs() — производные развёртки пересчитывает редактор.

export const MIN_HEIGHT_MM = 500;
export const MAX_HEIGHT_MM = 9990;

/** Кламп высоты окна бандла: Math.max(Math.round(total − floor_height), 30), см. */
const MIN_WINDOW_HEIGHT_CM = 30;

export type SetHeightResult = {
  /** Новая высота, см (как в модели редактора). */
  total_height_cm: number;
  /** Сколько записей rooms2 получили высоту. */
  rooms: number;
  /** Сколько стен (кроме balcony) получили высоту. */
  walls: number;
  /** Сколько окон поджато под новую высоту. */
  windows_clamped: number;
  /** Сколько балконных блоков (windoor) поджато (окно и/или дверь). */
  windoors_clamped: number;
};

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Клампинг проёмов одной стены — ветки бандла дословно (см. шапку). */
function clampHoles(wall: Wall, totalCm: number, res: SetHeightResult): void {
  for (const hole of Object.values(wall.holes ?? {})) {
    clampHole(hole, totalCm, res);
  }
}

export function clampHole(hole: Hole, totalCm: number, res: SetHeightResult): void {
  if (hole.group !== "windows") return;
  if (hole.type === "window") {
    const h = hole.height;
    if (!isNum(h)) return;
    const floor = hole.floor_height;
    // floor_height не число → Math.round(total−floor)=NaN, сравнение ложно — пропуск
    if (!isNum(floor)) return;
    const limit = Math.round(totalCm - floor);
    if (h > limit) {
      hole.height = Math.max(limit, MIN_WINDOW_HEIGHT_CM);
      res.windows_clamped++;
    }
    return;
  }
  if (hole.type === "windoor") {
    let touched = false;
    if (isNum(hole.window_height) && (hole.window_height as number) > totalCm) {
      hole.window_height = totalCm;
      touched = true;
    }
    if (isNum(hole.door_height) && (hole.door_height as number) > totalCm) {
      hole.door_height = totalCm;
      touched = true;
    }
    if (touched) res.windoors_clamped++;
  }
}

/**
 * project_set_height v2 (этап 419): высота проекта по семантике $Project.setHeigth —
 * params.total_height, rooms2[*].height (сохранённая высота комнаты побеждает при
 * reopen: конструктор Room2 `height = e.height || params.total_height`), walls[*].height
 * (кроме role:"balcony") с клампингом окон/windoor. Вне 500..9990 мм — INVALID_ARGUMENT.
 * Атомарность обеспечивает обёртка ws.apply: fn получает клон модели.
 */
export function projectSetHeight(model: Model, heightMm: number): SetHeightResult {
  if (typeof heightMm !== "number" || !Number.isFinite(heightMm) || !Number.isInteger(heightMm)) {
    throw new McpError("INVALID_ARGUMENT", "height_mm должен быть целым числом", {
      details: { kind: "height_invalid", height_mm: heightMm },
    });
  }
  if (heightMm < MIN_HEIGHT_MM || heightMm > MAX_HEIGHT_MM) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `height_mm вне диапазона редактора (LIB.correctValue(e,50,999) — ${MIN_HEIGHT_MM}..${MAX_HEIGHT_MM} мм): ${heightMm}`,
      {
        hint: "редактор молча обрезает, MCP отклоняет — задайте значение в диапазоне",
        details: { kind: "height_out_of_range", height_mm: heightMm, min_mm: MIN_HEIGHT_MM, max_mm: MAX_HEIGHT_MM },
      },
    );
  }
  const e = heightMm / 10;
  const res: SetHeightResult = { total_height_cm: e, rooms: 0, walls: 0, windows_clamped: 0, windoors_clamped: 0 };
  model.total_height = e;
  const rooms2 = (model["rooms2"] ?? {}) as Record<string, Record<string, unknown>>;
  for (const room of Object.values(rooms2)) {
    if (room && typeof room === "object") {
      room["height"] = e;
      res.rooms++;
    }
  }
  for (const wall of Object.values(model.walls)) {
    // бандл: if ("balcony"!==A.role){ A.height=e; … holes }
    if (wall.role === "balcony") continue;
    wall.height = e;
    res.walls++;
    clampHoles(wall, e, res);
  }
  return res;
}
