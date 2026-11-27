import type { Model, Wall, Hole, Pillar } from "./types.ts";
import { McpError } from "../errors.ts";

// Высота проекта (этап 419 + доработка, бэклог 418 §4 A): точная семантика
// $Project.setHeigth бандла (268-app.js, символ setHeigth, ~207032):
//   setHeigth(e){ var n=params.total_height;
//     params.total_height=e;
//     for (ROOMS2) r.height=e;
//     for (WALLS) if ("balcony"!==A.role){ A.height=e; clamp holes }
//     for (PILLARS) "gypsum"===a.role
//        ? (a.total_height==n||a.total_height>params.total_height)&&(a.total_height=e,a.update())
//        : a.total_height=e;
//     for (ROOMS2) ROOMS2[o].rebuildDecorPrs() }
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
//     window_height>total → window_height=total; door_height>total → total;
//   иначе "doors"===l.group && l.height>total → l.height=total.
// PILLARS — ветки бандла дословно (см. resetPillarHeights).
// rebuildDecorPrs() — раскладка обшивки стен зависит от высоты (DecorLine.buildLayouts:
// r=params.total_height); персистится она ТОЛЬКО у типов wall_tile/wall_woodbatten
// (DecorLine.serialize @951937), а пересчёт при restore (Rooms2.get, блок «Z&&q||ee||e»)
// происходит только при ПУСТОЙ polygons_layout — заполненная раскладка редактором
// сама не пересчитывается. Поэтому MCP сбрасывает раскладку таких частей
// (delete polygons_layout/polygons_layout_points), и редактор пересобирает её при
// normalize (save) уже с новой высотой — тем же своим buildLayouts (design B:
// «модель нормализует код самого сервиса»).

export const MIN_HEIGHT_MM = 500;
export const MAX_HEIGHT_MM = 9990;

/** Кламп высоты окна бандла: Math.max(Math.round(total − floor_height), 30), см. */
const MIN_WINDOW_HEIGHT_CM = 30;

/** Типы отделки стены, у которых раскладка (polygons_layout) персистится
 *  (DecorLine.serialize; $DecorLining.tools_allow_prs = ["wall_tile","wall_woodbatten"]). */
const DECOR_LAYOUT_TYPES: ReadonlySet<string> = new Set(["wall_tile", "wall_woodbatten"]);

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
  /** Сколько дверей (группа doors) поджато под новую высоту. */
  doors_clamped: number;
  /** Сколько колонн получили новую высоту (по веткам бандла). */
  pillars: number;
  /** Сколько раскладок обшивки сброшено на пересчёт редактором (rebuildDecorPrs). */
  decors_layouts_reset: number;
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
  if (hole.group === "windows") {
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
    return;
  }
  // бандл: else-ветка тернарника — "doors"===l.group && l.height>total → total
  if (hole.group === "doors" && isNum(hole.height) && hole.height > totalCm) {
    hole.height = totalCm;
    res.doors_clamped++;
  }
}

/**
 * Колонны — ветки бандла дословно: не-gypsum — total_height=e всегда;
 * role:"gypsum" — только если прежнее значение равнялось старой высоте проекта
 * (n — «штатная» колонна) или выше новой (кламп вниз); «своя» меньшая высота
 * ГКЛ-короба сохраняется.
 */
function resetPillarHeights(model: Model, prevTotalCm: number, totalCm: number, res: SetHeightResult): void {
  for (const pillar of Object.values(model.pillars ?? {})) {
    const p = pillar as Pillar;
    if (p.role === "gypsum") {
      const th = p.total_height;
      if (th === prevTotalCm || (isNum(th) && th > totalCm)) {
        p.total_height = totalCm;
        res.pillars++;
      }
    } else {
      p.total_height = totalCm;
      res.pillars++;
    }
  }
}

/**
 * Замена rebuildDecorPrs() для персистентного состояния (см. шапку): раскладка
 * частей wall_tile/wall_woodbatten с заданным type_laying сбрасывается — редактор
 * пересобирает её при normalize (Rooms2.get: условие is_empty(polygons_layout))
 * уже с новой высотой. Прочие поля частей (line, line_wall, line_decor,
 * floor_offset, height, anchor) от высоты не зависят и не трогаются; записи
 * остальных типов (раскладка не персистится — DecorLine.serialize) не меняются.
 */
function resetDecorLayouts(model: Model, res: SetHeightResult): void {
  const rooms2 = (model["rooms2"] ?? {}) as Record<string, Record<string, unknown>>;
  for (const room of Object.values(rooms2)) {
    const decors = room["decors"];
    if (!Array.isArray(decors)) continue;
    for (const rec of decors) {
      if (!rec || (rec as Record<string, unknown>)["exist"] !== true) continue;
      const parts = (rec as Record<string, unknown>)["parts"];
      if (!parts || typeof parts !== "object" || Array.isArray(parts)) continue;
      for (const part of Object.values(parts as Record<string, Record<string, unknown>>)) {
        if (!part || typeof part !== "object") continue;
        const type = part["type"];
        if (typeof type !== "string" || !DECOR_LAYOUT_TYPES.has(type)) continue;
        // без type_laying раскладки нет и buildLayouts её не строит (бандл: if(this.type_laying))
        if (!part["type_laying"]) continue;
        const layout = part["polygons_layout"];
        const empty = layout === undefined || layout === null ||
          (Array.isArray(layout) && layout.length === 0) ||
          (typeof layout === "object" && !Array.isArray(layout) && Object.keys(layout).length === 0);
        if (empty) continue;
        delete part["polygons_layout"];
        delete part["polygons_layout_points"];
        res.decors_layouts_reset++;
      }
    }
  }
}

/**
 * project_set_height v2 (этап 419 + доработка): высота проекта по семантике
 * $Project.setHeigth — params.total_height, rooms2[*].height, walls[*].height
 * (кроме role:"balcony") с клампингом окон/windoor/дверей, колонны (PILLARS) и
 * сброс раскладки обшивки (замена rebuildDecorPrs). Вне 500..9990 мм —
 * INVALID_ARGUMENT. Атомарность обеспечивает обёртка ws.apply: fn получает клон
 * модели.
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
  const res: SetHeightResult = {
    total_height_cm: e, rooms: 0, walls: 0, windows_clamped: 0, windoors_clamped: 0,
    doors_clamped: 0, pillars: 0, decors_layouts_reset: 0,
  };
  const prevTotal = model.total_height;
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
  resetPillarHeights(model, prevTotal, e, res);
  resetDecorLayouts(model, res);
  return res;
}
