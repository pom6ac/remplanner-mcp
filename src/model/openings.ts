import type { Model, Wall, Hole, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import { pointsAroundCenter, pointAtLength, projectionLength, type Segment } from "./geometry.ts";
import type { MmPoint } from "./walls.ts";
import { wallFaces } from "./wall-geometry.ts";
import { McpError } from "../errors.ts";
import { assignCandidate } from "./assign.ts";

/**
 * Таблица «ключ каталога → hole.type / group / дефолты».
 * Окна (все 7 пунктов меню «Окна»): проверены кликами по UI, эталоны
 * tests/fixtures/ui-ref-window-<тип>.json (этап 25, 2026-11-16): model.type, ширина,
 * высота, глубина (hole.depth — не толщина стены!), подоконник, дефолтное opening.
 * Двери (все 20 пунктов-проёмов меню «Двери и проемы»): проверены кликами по UI, эталоны
 * tests/fixtures/ui-ref-door-<тип>.json (этап 37, 2026-11-16): model.type, размеры,
 * глубина 4, casing/slope_angle/casements и opening (дефолт вида, формат зависит от типа);
 * в MCP swing переопределяет opening; лимиты размеров — из defs редактора (проба 37-dbg-defs.ts).
 * Пункты doors_coupe_*, door_remote, door_videoremote — предметы каталога, не проёмы.
 */
export type OpeningKind = {
  type: string;
  group: "doors" | "windows";
  widthMm: number;
  heightMm: number;
  depthCm: number;
  /** Высота от пола до низа проёма, см (подоконник окна / ноль у двери). */
  sillCm: number;
  /** Дефолтное поле opening модели (дефолт вида из эталона UI; у дверей и окон). */
  defaultOpening?: string;
  /** Только окна: поле slopes модели (вылет откоса), если UI его создаёт. */
  slopesCm?: number;
  /** Только окна: дефолтное число створок (casements). */
  defaultCasements?: number;
  /** Балконный блок (type windoor): модель хранит окно и дверь отдельными полями, height нет. */
  windoor?: boolean;
  /** Дефолтная сторона подоконника (sill.side) — как в эталоне UI. */
  sillSide?: "l" | "r";
  /** Балконная дверь: дефолтный импост (impost_offset = высота импоста от пола − подоконник). */
  impostOffsetCm?: number;
  /** Дефолтное поле filling (конфигурация заполнения, эталон UI — только у балконной двери). */
  defaultFilling?: number;
  /** Только двери: дефолтный «Короб с наличниками» (эталон UI; 0 у doorway/door_garage). */
  defaultCasing?: 0 | 1;
  /**
   * Формат поля opening, который переживает restore у этого типа (этап 37, матрица
   * проб 37-dbg-opening-matrix): "single" — одна буква ("r"/"l", у двустворчатых
   * сдвижных и garage/x4/penal), "double" — две ("r-l" и др., у одностворчатых сдвижных).
   * Не задан — формат свободный (распашные двери).
   */
  openingFormat?: "single" | "double";
  /** Лимиты ширины/высоты из defs редактора (панель свойств), мм. */
  widthMinMm?: number;
  widthMaxMm?: number;
  heightMinMm?: number;
  heightMaxMm?: number;
};

export const OPENING_KINDS: Record<string, OpeningKind> = {
  // двери (group doors) — эталоны ui-ref-door-*.json (этап 37, 2026-11-16), лимиты из defs редактора:
  // у всех дверей depth 4, height 210 (garage 225), по умолчанию casing 1 (doorway/garage — 0),
  // slope_angle 0, casements 1; opening — дефолт вида из эталона (в MCP переопределяется swing)
  doorway: { type: "doorway", group: "doors", widthMm: 800, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 0, defaultOpening: "r", widthMinMm: 500, widthMaxMm: 6000 },
  door: { type: "single", group: "doors", widthMm: 800, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r-l", widthMinMm: 500, widthMaxMm: 6000, heightMinMm: 1000 },
  door_double: { type: "double", group: "doors", widthMm: 1200, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r", widthMinMm: 1000, widthMaxMm: 6000 },
  door_coupe: { type: "door_coupe", group: "doors", widthMm: 800, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r-l", openingFormat: "double", widthMinMm: 500, widthMaxMm: 6000 },
  door_coupe_double: { type: "door_coupe_double", group: "doors", widthMm: 1600, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r", openingFormat: "single", widthMinMm: 500, widthMaxMm: 6000 },
  door_penal: { type: "door_penal", group: "doors", widthMm: 800, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r", openingFormat: "single", widthMinMm: 500, widthMaxMm: 6000 },
  door_penal_double: { type: "door_penal_double", group: "doors", widthMm: 1600, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r", widthMinMm: 500, widthMaxMm: 6000 },
  door_roto: { type: "door_roto", group: "doors", widthMm: 800, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r-l", openingFormat: "double", widthMinMm: 500, widthMaxMm: 6000 },
  door_roto_double: { type: "door_roto_double", group: "doors", widthMm: 1600, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r", widthMinMm: 500, widthMaxMm: 6000 },
  door_book: { type: "door_book", group: "doors", widthMm: 800, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r-l", widthMinMm: 500, widthMaxMm: 6000 },
  door_book_double: { type: "door_book_double", group: "doors", widthMm: 1600, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r", openingFormat: "single", widthMinMm: 500, widthMaxMm: 6000 },
  door_bellows: { type: "door_bellows", group: "doors", widthMm: 1200, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r-l", openingFormat: "double", widthMinMm: 500, widthMaxMm: 6000 },
  door_glass: { type: "door_glass", group: "doors", widthMm: 800, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r-l", widthMinMm: 500, widthMaxMm: 6000 },
  door_garage: { type: "door_garage", group: "doors", widthMm: 3000, heightMm: 2250, depthCm: 4, sillCm: 0,
    defaultCasing: 0, defaultOpening: "r", openingFormat: "single", widthMinMm: 2000, widthMaxMm: 6000, heightMinMm: 2000, heightMaxMm: 3000 },
  door_system_x2: { type: "door_system_x2", group: "doors", widthMm: 1600, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r-l", openingFormat: "double", widthMinMm: 500, widthMaxMm: 6000 },
  door_system_x3: { type: "door_system_x3", group: "doors", widthMm: 2400, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r-l", openingFormat: "double", widthMinMm: 500, widthMaxMm: 6000 },
  door_system_x4: { type: "door_system_x4", group: "doors", widthMm: 3200, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r", openingFormat: "single", widthMinMm: 500, widthMaxMm: 6000 },
  door_system_penal_x2: { type: "door_system_penal_x2", group: "doors", widthMm: 1600, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r-l", openingFormat: "double", widthMinMm: 500, widthMaxMm: 6000 },
  door_system_penal_x3: { type: "door_system_penal_x3", group: "doors", widthMm: 2400, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r-l", openingFormat: "double", widthMinMm: 500, widthMaxMm: 6000 },
  door_system_penal_x4: { type: "door_system_penal_x4", group: "doors", widthMm: 3200, heightMm: 2100, depthCm: 4, sillCm: 0,
    defaultCasing: 1, defaultOpening: "r", openingFormat: "single", widthMinMm: 500, widthMaxMm: 6000 },
  // окна (group windows) — эталоны ui-ref-window-*.json, проверено в UI
  windowway: { type: "windowway", group: "windows", widthMm: 1200, heightMm: 1500, depthCm: 6, sillCm: 85,
    defaultOpening: "r", slopesCm: 20, defaultCasements: 1, sillSide: "l" },
  window: { type: "window", group: "windows", widthMm: 1200, heightMm: 1500, depthCm: 6, sillCm: 85,
    defaultOpening: "r-l", slopesCm: 20, defaultCasements: 1, sillSide: "l" },
  window_balcony: { type: "windoor", group: "windows", widthMm: 1800, heightMm: 2250, depthCm: 6, sillCm: 10,
    defaultOpening: "r-l", defaultCasements: 1, windoor: true, sillSide: "r" },
  window_door: { type: "window_door", group: "windows", widthMm: 800, heightMm: 2250, depthCm: 6, sillCm: 10,
    defaultOpening: "r-l", slopesCm: 20, defaultCasements: 1, sillSide: "l", impostOffsetCm: 75, defaultFilling: 1 },
  french_window: { type: "french_window", group: "windows", widthMm: 1200, heightMm: 2500, depthCm: 6, sillCm: 0,
    defaultOpening: "r", defaultCasements: 0, sillSide: "l" },
  french_window_coupe: { type: "french_window_coupe", group: "windows", widthMm: 1200, heightMm: 2500, depthCm: 14, sillCm: 0,
    defaultOpening: "r-l", defaultCasements: 0, sillSide: "l" },
  french_window_double: { type: "french_window_double", group: "windows", widthMm: 1800, heightMm: 2500, depthCm: 14, sillCm: 0,
    defaultOpening: "r", defaultCasements: 0, sillSide: "l" },
};

/** Параметры подоконника (модель, см): thinkness — так в модели редактора (опечатка сохранена). */
export type HoleSill = { thinkness: number; overhang: number; overmeasure: number; side: "l" | "r" };

/** Параметры окон из панели свойств UI (этап 25); всё в мм, угол в градусах. */
export type WindowParams = {
  /** Число створок (casements); у французских окон в модели не меняется (0). */
  casements?: number;
  /** Угол рассвета, градусы (hole.slope_angle). */
  slopeAngleDeg?: number;
  /** Толщина подоконника (sill.thinkness). */
  sillThicknessMm?: number;
  /** Вылет подоконника (sill.overhang). */
  sillOverhangMm?: number;
  /** Выпуски подоконника вбок (sill.overmeasure). */
  sillOvermeasureMm?: number;
  /** Балконный блок (windoor): ширина окна. */
  windowWidthMm?: number;
  /** Балконный блок: высота окна. */
  windowHeightMm?: number;
  /** Балконный блок: ширина двери. */
  doorWidthMm?: number;
  /** Балконный блок: высота двери. */
  doorHeightMm?: number;
  /** Балконный блок: сторона двери. */
  doorPosition?: "left" | "right";
  /** Балконная дверь: высота импоста от пола (impost_offset = значение − подоконник). */
  impostHeightMm?: number;
};

/**
 * swing {hinge, into} → строка opening в модели с учётом формата типа (этап 37):
 * у типов с openingFormat "single" (двустворчатые сдвижные, garage, penal, x4) — одна буква
 * (сторона открывания), у остальных — две (петля-направление, как в v0.1.1).
 * Комбинация fixture: дверь, открывающаяся от p2 влево → "r-l".
 */
export function openingFromSwing(
  swing?: { hinge: "start" | "end"; into: "left" | "right" },
  kind?: OpeningKind,
): string | undefined {
  if (!swing) return undefined;
  if (kind?.openingFormat === "single") return swing.into === "left" ? "l" : "r";
  const leaf = swing.into === "left" ? "l" : "r";
  return `${swing.hinge === "end" ? "r" : "l"}-${leaf}`;
}

/**
 * Приводит поле opening проёма к формату, который переживает restore у типа (этап 37):
 * у типов с openingFormat "single" двухчастная строка ("r-l") от версии v0.1.1 ломает
 * редактор (WallHole.draw: reading 'x') — нормализуем к букве направления; у типов с
 * "double" отсутствие opening (v0.1.1 без swing) тоже ломает редактор — ставим дефолт вида.
 * Возвращает true, если значение изменилось.
 */
function normalizeOpeningFormat(hole: Hole, kind: OpeningKind): boolean {
  const cur = hole.opening as string | undefined;
  if (kind.openingFormat === "single") {
    // одночастный формат: одна буква r/l
    if (cur === undefined) {
      hole.opening = kind.defaultOpening ?? "r";
      return true;
    }
    if (cur.length !== 1) {
      hole.opening = cur.includes("-") ? (cur.split("-")[1] ?? kind.defaultOpening ?? "r") : kind.defaultOpening ?? "r";
      return true;
    }
    return false;
  }
  if (kind.openingFormat === "double") {
    // двухчастный формат обязателен: отсутствие opening от v0.1.1 редактор не восстанавливает
    if (cur === undefined || !cur.includes("-")) {
      hole.opening = kind.defaultOpening ?? "r-l";
      return true;
    }
    return false;
  }
  return false;
}

export type AddOpeningParams = WindowParams & {
  wallId: string;
  /** Ключ каталога (door, window, …). */
  type: string;
  /** Смещение ближайшего края проёма от края оси стены (p1/p2), мм. */
  offsetMm?: number;
  from?: "start" | "end";
  /** От чего мерить offset: от угла внутренней грани (по умолчанию) или от осевого конца. */
  offsetFrom?: "inner" | "axis";
  /** Альтернатива offset+from: центр проёма от начала стены, мм. */
  centerMm?: number;
  widthMm?: number;
  heightMm?: number;
  sillHeightMm?: number;
  swing?: { hinge: "start" | "end"; into: "left" | "right" };
  arched?: boolean;
  casing?: boolean;
  /** Устаревшее имя casements (число створок). */
  leaves?: number;
  /**
   * Замена исходного проёма (этап 103): новый проём пишется с plan:"c" и position:"c"
   * на том же месте, а исходный получает hasReplacement:1 (эталон ui-ref-replan-replacement).
   * Демонтированный проём и уже заменённый — INVALID_ARGUMENT (проба 103-replan-extra:
   * UI doorway поверх демонтированной двери проём не ставит).
   */
  replacesHoleId?: string;
};

/** MCP-имена параметров для текстов ошибок валидатора. */
const PARAM_MCP_NAME: Record<string, string> = {
  windowWidthMm: "window_width_mm",
  windowHeightMm: "window_height_mm",
  doorWidthMm: "door_width_mm",
  doorHeightMm: "door_height_mm",
  doorPosition: "door_position",
  slopeAngleDeg: "slope_angle_deg",
  sillThicknessMm: "sill_thickness_mm",
  sillOverhangMm: "sill_overhang_mm",
  sillOvermeasureMm: "sill_overmeasure_mm",
  impostHeightMm: "impost_height_mm",
  casements: "casements",
  leaves: "leaves",
  widthMm: "width_mm",
  heightMm: "height_mm",
};

function invalidParam(msg: string): never {
  throw new McpError("INVALID_ARGUMENT", msg);
}

/** Числовой вход — конечное число > 0 (ревью 28, R3: Infinity проходит проверку «> 0»). */
function finitePositive(name: string, v: number | undefined): void {
  if (v !== undefined && !(Number.isFinite(v) && v > 0)) invalidParam(`${name} должен быть конечным числом > 0`);
}

/** Числовой вход — конечное число. */
function finiteNumber(name: string, v: number | undefined): void {
  if (v !== undefined && !Number.isFinite(v)) invalidParam(`${name} должен быть конечным числом`);
}

/**
 * Таблица применимости параметров по типам проёмов и общий валидатор (ревью 26, №1/№2/№3/№6;
 * ревью 28, R2/R3/R4). Запускается до любой мутации — и в opening_add, и в opening_update;
 * неприменимые параметры и противоречивые сочетания отвергаются INVALID_ARGUMENT:
 *  - все числовые входы — конечные числа (R3: Infinity/NaN не проходят проверку «> 0»);
 *  - части балконного блока (window_*_mm, door_*_mm, door_position) — только у windoor;
 *  - итоговые ширины окна и двери — конечные и > 0; общая ширина согласована с частями;
 *  - в update общая ширина без частей пересчитывает части пропорционально прежним
 *    (у старого объекта без частей дверь берётся 80 см по эталону UI);
 *  - у windoor нет общей высоты height;
 *  - door_position: right не поддерживается — редактор сохраняет только левую дверь (l);
 *  - impost_height_mm — только балконная дверь, значение в пределах высоты двери;
 *  - casements у французских окон не принимается (в модели всегда 0);
 *  - подоконник (sill_*) и угол рассвета — только у окон.
 *
 * Выбор поведения (ревью 28, R4): если импост не передан явно, но перестаёт помещаться
 * в дверь после изменения height_mm/sill_height_mm, выбирается ОШИБКА, а не пропорциональная
 * коррекция — молча двигать геометрию нельзя; итоговый offset проверяется по кандидат-копии
 * в assertHoleInvariants и при add, и при update.
 */
export function validateOpeningParams(kind: OpeningKind, p: Partial<AddOpeningParams>, current?: Hole): void {
  finitePositive("width_mm", p.widthMm);
  finitePositive("height_mm", p.heightMm);
  if (kind.windoor && p.heightMm !== undefined) {
    invalidParam("у балконного блока нет общей высоты — задайте высоты частей window_height_mm/door_height_mm");
  }
  const partKeys = (["windowWidthMm", "windowHeightMm", "doorWidthMm", "doorHeightMm", "doorPosition"] as const)
    .filter((k) => p[k] !== undefined);
  if (partKeys.length > 0 && !kind.windoor) {
    invalidParam(`параметры ${partKeys.map((k) => PARAM_MCP_NAME[k]).join(", ")} применимы только к балконному блоку (window_balcony)`);
  }
  if (p.doorPosition === "right") {
    invalidParam("door_position: right не поддерживается — редактор сохраняет балконный блок только с левой дверью (l)");
  }
  finitePositive("window_width_mm", p.windowWidthMm);
  finitePositive("window_height_mm", p.windowHeightMm);
  finitePositive("door_width_mm", p.doorWidthMm);
  finitePositive("door_height_mm", p.doorHeightMm);
  finiteNumber("impost_height_mm", p.impostHeightMm);
  finiteNumber("sill_height_mm", p.sillHeightMm);
  finiteNumber("center_mm", p.centerMm);
  finiteNumber("offset_mm", p.offsetMm);
  finiteNumber("slope_angle_deg", p.slopeAngleDeg);
  finiteNumber("sill_thickness_mm", p.sillThicknessMm);
  finiteNumber("sill_overhang_mm", p.sillOverhangMm);
  finiteNumber("sill_overmeasure_mm", p.sillOvermeasureMm);
  finiteNumber("casements", p.casements);
  finiteNumber("leaves", p.leaves);
  if (p.impostHeightMm !== undefined && kind.impostOffsetCm === undefined) {
    invalidParam("impost_height_mm применим только к балконной двери (window_door)");
  }
  if (kind.impostOffsetCm !== undefined && p.impostHeightMm !== undefined) {
    // импост живёт в пределах высоты двери: ниже подоконника и выше верха двери он не бывает
    const floor = p.sillHeightMm !== undefined ? mmToCm(p.sillHeightMm)
      : current ? ((current.floor_height as number | undefined) ?? 0)
      : mmToCm(kind.sillCm * 10); // add: дефолтный подоконник вида
    const doorH = p.heightMm !== undefined ? mmToCm(p.heightMm) : (current?.height ?? mmToCm(kind.heightMm));
    const off = mmToCm(p.impostHeightMm) - floor;
    if (!(off > 0) || !(off < doorH)) {
      invalidParam(`высота импоста должна быть между подоконником (${Math.round(floor * 10)} мм) и верхом двери (${Math.round((floor + doorH) * 10)} мм)`);
    }
  }
  const leafKeys = (["casements", "leaves"] as const).filter((k) => p[k] !== undefined);
  if (leafKeys.length > 0 && kind.group === "windows" && kind.type.startsWith("french_window")) {
    invalidParam("у французских окон число створок не меняется (в модели всегда 0) — параметр casements не принимается");
  }
  const sillKeys = (["slopeAngleDeg", "sillThicknessMm", "sillOverhangMm", "sillOvermeasureMm"] as const)
    .filter((k) => p[k] !== undefined);
  if (sillKeys.length > 0 && kind.group !== "windows") {
    invalidParam(`параметры ${sillKeys.map((k) => PARAM_MCP_NAME[k]).join(", ")} применимы только к окнам`);
  }
  if (p.sillHeightMm !== undefined && kind.group !== "windows") {
    invalidParam("sill_height_mm не применим к дверям — высота от пола у дверей в редакторе не задаётся (только у окон и балконной двери)");
  }
  // лимиты размеров из defs редактора (этап 37): ширина/высота дверей в панели ограничены
  if (p.widthMm !== undefined) {
    if (kind.widthMinMm !== undefined && p.widthMm < kind.widthMinMm) {
      invalidParam(`width_mm меньше минимума типа ${kind.type} (${kind.widthMinMm} мм по панели редактора)`);
    }
    if (kind.widthMaxMm !== undefined && p.widthMm > kind.widthMaxMm) {
      invalidParam(`width_mm больше максимума типа ${kind.type} (${kind.widthMaxMm} мм по панели редактора)`);
    }
  }
  if (p.heightMm !== undefined) {
    if (kind.heightMinMm !== undefined && p.heightMm < kind.heightMinMm) {
      invalidParam(`height_mm меньше минимума типа ${kind.type} (${kind.heightMinMm} мм по панели редактора)`);
    }
    if (kind.heightMaxMm !== undefined && p.heightMm > kind.heightMaxMm) {
      invalidParam(`height_mm больше максимума типа ${kind.type} (${kind.heightMaxMm} мм по панели редактора)`);
    }
  }
  // согласованность частей балконного блока проверяется один раз при построении
  // кандидат-копии (windoorParts) и в итоговых инвариантах assertHoleInvariants — без повторов
}

function wallAxis(wall: Wall): Segment {
  return { p1: wall.p1, p2: wall.p2 };
}

function axisLength(wall: Wall): number {
  return Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
}

/**
 * Отступ вдоль оси до угла внутренней грани на конце стены (№9 ревью) — геометрически,
 * без связей (design §12.3: Node не пишет link): если конец стены лежит в теле
 * перпендикулярного соседа, угол помещения — на ближней к комнате грани соседа;
 * у свободного конца и T-конца на грани — собственный торец стены.
 * Возвращает координату угла ВДОЛЬ оси в см от p1.
 */
export function innerEdgeOffsetCm(model: Model, wall: Wall, end: "start" | "end"): number {
  const axis = wallAxis(wall);
  const len = axisLength(wall);
  if (len < 1e-9) return wall.depth / 2;
  const E = end === "start" ? wall.p1 : wall.p2;
  const other = end === "start" ? wall.p2 : wall.p1;
  const dx = wall.p2.x - wall.p1.x;
  const dy = wall.p2.y - wall.p1.y;
  const u = { x: dx / len, y: dy / len };
  let best = end === "start" ? 0 : len; // свободный конец / T-конец: собственный торец
  for (const w of Object.values(model.walls)) {
    if (w.id === wall.id) continue;
    const wlen = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
    if (wlen < 1e-9) continue;
    const wdx = w.p2.x - w.p1.x;
    const wdy = w.p2.y - w.p1.y;
    // коллинеарный сосед (продолжение оси) не даёт угла — торец на срезе
    if (Math.abs(u.x * wdy / wlen - u.y * wdx / wlen) < 1e-6) continue;
    // E в системе соседа: t — доля вдоль, perp — расстояние до оси
    const tN = ((E.x - w.p1.x) * wdx + (E.y - w.p1.y) * wdy) / (wlen * wlen);
    const perpN = Math.abs((E.x - w.p1.x) * wdy - (E.y - w.p1.y) * wdx) / wlen;
    if (perpN >= w.depth / 2 || tN < 0 || tN > 1) continue; // не в теле соседа
    // грань соседа со стороны второго конца нашей стены
    const crossOther = (other.x - w.p1.x) * wdy - (other.y - w.p1.y) * wdx;
    const side = Math.sign(crossOther) || 1;
    const nx = (wdy / wlen) * side * (w.depth / 2);
    const ny = (-wdx / wlen) * side * (w.depth / 2);
    const faceA = { x: w.p1.x + nx, y: w.p1.y + ny };
    const faceB = { x: w.p2.x + nx, y: w.p2.y + ny };
    const isect = lineIntersection2(axis.p1, axis.p2, faceA, faceB);
    if (!isect) continue;
    const c = (isect.x - axis.p1.x) * u.x + (isect.y - axis.p1.y) * u.y;
    best = end === "start" ? Math.max(best, c) : Math.min(best, c);
  }
  return best;
}

/** Пересечение прямых (a1→a2) и (b1→b2) или null. */
function lineIntersection2(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
  return { x: a1.x + d1x * t, y: a1.y + d1y * t };
}

/** Диапазон проёма [от, до] в см от начала оси (при отсутствии at — проекция pc). */
export function holeRange(wall: Wall, hole: Hole): [number, number] {
  return [holeOffsetCm(wall, hole), holeOffsetCm(wall, hole) + hole.width];
}

/** at проёма в см от начала оси: поле at или проекция pc на ось минус полуширина (№6 ревью). */
export function holeOffsetCm(wall: Wall, hole: Hole): number {
  if (hole.at !== undefined) return hole.at;
  const dx = wall.p2.x - wall.p1.x;
  const dy = wall.p2.y - wall.p1.y;
  const len2 = dx * dx + dy * dy;
  const len = Math.sqrt(len2);
  if (len2 === 0) return -hole.width / 2;
  const t = ((hole.pc.x - wall.p1.x) * dx + (hole.pc.y - wall.p1.y) * dy) / len2;
  return t * len - hole.width / 2;
}

function checkPlacement(wall: Wall, at: number, width: number, ignoreHoleId?: string, ignoreHoleId2?: string): void {
  const len = axisLength(wall);
  const margin = wall.depth / 2;
  if (at < margin - 1e-6 || at + width > len - margin + 1e-6) {
    throw new McpError("GEOMETRY_CONFLICT", "проём выходит за границу стены", {
      details: { kind: "opening_outside_wall", wall_id: wall.id, at_cm: r2(at), width_cm: width, wall_len_cm: r2(len) },
    });
  }
  for (const other of Object.values(wall.holes ?? {})) {
    if (other.id === ignoreHoleId || other.id === ignoreHoleId2) continue;
    const [o1, o2] = holeRange(wall, other);
    if (at < o2 - 1e-6 && o1 < at + width) {
      throw new McpError("GEOMETRY_CONFLICT", "проём пересекает другой проём", {
        details: { kind: "openings_overlap", wall_id: wall.id, hole_id: other.id },
      });
    }
  }
}

/**
 * Разбор параметров балконного блока (windoor): ширины окна и двери, итог = сумма.
 * Приоритет — явно заданные части; недостающая часть дополняется из общей ширины.
 * Общая ширина против суммы частей — ошибка; в update общая ширина без частей
 * пересчитывает части пропорционально прежним (ревью 26, №2/№3).
 * Единицы (ревью 28, R1): в см переводятся только явно переданные мм; текущие
 * значения частей из модели уже в см и переносятся как есть.
 */
function windoorParts(kind: OpeningKind, p: Partial<AddOpeningParams>, current?: Hole): {
  ww?: number; wh: number; dw?: number; dh: number; widthCm: number;
} {
  const wh = p.windowHeightMm !== undefined
    ? mmToCm(p.windowHeightMm)
    : ((current?.window_height as number | undefined) ?? 150); // 150 см — эталон UI
  const dh = p.doorHeightMm !== undefined
    ? mmToCm(p.doorHeightMm)
    : ((current?.door_height as number | undefined) ?? 225); // 225 см — эталон UI
  const wwGiven = p.windowWidthMm !== undefined ? mmToCm(p.windowWidthMm) : undefined;
  const dwGiven = p.doorWidthMm !== undefined ? mmToCm(p.doorWidthMm) : undefined;
  const prevWw = current?.window_width as number | undefined;
  const prevDw = current?.door_width as number | undefined;
  const hasPrev = prevWw !== undefined && prevDw !== undefined;
  let ww: number | undefined, dw: number | undefined;
  if (wwGiven !== undefined && dwGiven !== undefined) {
    ww = wwGiven;
    dw = dwGiven;
  } else if (wwGiven !== undefined || dwGiven !== undefined) {
    if (p.widthMm !== undefined) {
      // общая ширина задана явно: недостающая часть = общая − заданная
      const total = mmToCm(p.widthMm);
      ww = wwGiven ?? total - dwGiven!;
      dw = dwGiven ?? total - wwGiven!;
    } else if (hasPrev) {
      // update без общей ширины: недостающая часть остаётся прежней (как в UI)
      ww = wwGiven ?? prevWw!;
      dw = dwGiven ?? prevDw!;
    } else {
      // add: недостающая часть = дефолтная общая ширина − заданная
      const total = mmToCm(kind.widthMm);
      ww = wwGiven ?? total - dwGiven!;
      dw = dwGiven ?? total - wwGiven!;
    }
  } else if (p.widthMm !== undefined) {
    const total = mmToCm(p.widthMm);
    if (hasPrev) {
      // update общей ширины без частей: прежние части масштабируются пропорционально
      const scale = total / (prevWw! + prevDw!);
      ww = r2(prevWw! * scale);
      dw = r2(prevDw! * scale);
    } else {
      dw = 80; // дефолт двери блока (эталон UI), у старого объекта частей нет
      ww = total - dw;
    }
  } else if (current) {
    if (hasPrev) {
      // update без ширин: части не трогаем, итог — прежняя ширина
      return { wh, dh, widthCm: current.width };
    }
    // у старого объекта без частей (ревью 30, N3) части нормализуются из дефолтов
    // каталога при любом update: дверь 80 см по эталону UI, окно — остаток ширины
    dw = 80;
    ww = r2(current.width - dw);
  } else {
    dw = 80; // дефолт двери блока (эталон UI)
    ww = mmToCm(p.widthMm ?? kind.widthMm) - dw;
  }
  if (!Number.isFinite(ww) || !(ww > 0)) invalidParam("итоговая ширина окна балконного блока (window_width_mm) должна быть конечной и > 0");
  if (!Number.isFinite(dw) || !(dw > 0)) invalidParam("итоговая ширина двери балконного блока (door_width_mm) должна быть конечной и > 0");
  if (p.widthMm !== undefined && Math.abs(mmToCm(p.widthMm) - (ww + dw)) > 0.03) {
    invalidParam(`width_mm противоречит частям: ширина балконного блока = window_width_mm + door_width_mm (${Math.round(ww * 10)} + ${Math.round(dw * 10)} мм)`);
  }
  return { ww, wh, dw, dh, widthCm: r2(ww + dw) };
}

/** Поля окна из панели свойств: sill, slope_angle, casements, slopes, windoor-часть. */
function applyWindowFields(hole: Hole, kind: OpeningKind, p: AddOpeningParams, parts?: { ww?: number; wh: number; dw?: number; dh: number }): void {
  if (kind.windoor && parts) {
    hole.window_width = parts.ww;
    hole.window_height = parts.wh;
    hole.door_width = parts.dw;
    hole.door_height = parts.dh;
    hole.door_position = "l"; // right отвергается валидатором (№4): редактор сохраняет только l
  }
  if (kind.defaultFilling !== undefined) hole.filling = kind.defaultFilling;
  if (kind.slopesCm !== undefined) hole.slopes = kind.slopesCm;
  hole.slope_angle = p.slopeAngleDeg ?? 0;
  const cas = p.casements ?? p.leaves ?? kind.defaultCasements;
  if (cas !== undefined) hole.casements = cas;
  const sill: HoleSill = {
    thinkness: mmToCm(p.sillThicknessMm ?? 40),
    overhang: mmToCm(p.sillOverhangMm ?? 0),
    overmeasure: mmToCm(p.sillOvermeasureMm ?? 0),
    side: kind.sillSide ?? "l",
  };
  hole.sill = sill;
  if (kind.impostOffsetCm !== undefined) {
    const floor = hole.floor_height ?? 0;
    hole.impost_offset = p.impostHeightMm !== undefined ? mmToCm(p.impostHeightMm) - floor : kind.impostOffsetCm;
  }
  // короб с наличниками: у окон UI включён по умолчанию
  hole.casing = p.casing === false ? 0 : 1;
}

/** addOpening: ставит проём на стену (мм), проверяет коллизии. */
export function addOpening(model: Model, params: AddOpeningParams): Hole {
  const wall = model.walls[params.wallId];
  if (!wall) {
    throw new McpError("NOT_FOUND", `стена ${params.wallId} не найдена`);
  }
  // на балконные ограждения проёмы не ставятся (редактор: hole__dont_install_over_balcony)
  if (wall.role === "balcony") {
    throw new McpError("INVALID_ARGUMENT", `стена ${wall.id} — балконное ограждение, на нём нельзя ставить окна и двери (правило редактора hole__dont_install_over_balcony)`, {
      hint: "для проёма в наружной стене используйте обычную стену; балконный блок (window_balcony) тоже ставится только на стену",
      details: { kind: "opening_on_balcony", wall_id: wall.id },
    });
  }
  // замена исходного проёма (этап 103): проверки до мутации
  let replaced: Hole | null = null;
  if (params.replacesHoleId !== undefined) {
    replaced = wall.holes[params.replacesHoleId] ?? null;
    if (!replaced) {
      throw new McpError("NOT_FOUND", `проём ${params.replacesHoleId} не найден на стене ${wall.id}`, {
        details: { kind: "hole_not_found", wall_id: wall.id, hole_id: params.replacesHoleId },
      });
    }
    if (replaced.plan === "c") {
      throw new McpError("INVALID_ARGUMENT", `проём ${replaced.id} — уже проём листа «Перегородки» (plan:c), заменять можно только исходные проёмы`, {
        details: { kind: "replace_plan_c", wall_id: wall.id, hole_id: replaced.id },
      });
    }
    if (replaced.hasReplacement) {
      throw new McpError("INVALID_ARGUMENT", `проём ${replaced.id} уже заменён — снимите прежнюю замену (opening_delete нового проёма)`, {
        details: { kind: "already_replaced", wall_id: wall.id, hole_id: replaced.id },
      });
    }
    if (replaced.demount === 1) {
      throw new McpError("INVALID_ARGUMENT", `проём ${replaced.id} демонтирован — заменять демонтированный проём нельзя (как в UI); сначала отмените демонтаж (demolish_cancel)`, {
        details: { kind: "replace_demounted", wall_id: wall.id, hole_id: replaced.id },
      });
    }
  }
  const kind = OPENING_KINDS[params.type];
  if (!kind) {
    throw new McpError("INVALID_ARGUMENT", `неизвестный тип проёма: ${params.type}`, {
      hint: `доступны: ${Object.keys(OPENING_KINDS).join(", ")}`,
    });
  }
  // применимость параметров и входы — до любых вычислений и мутаций (№1/№6; ревью 28, R3)
  validateOpeningParams(kind, params);
  // части балконного блока разбираются один раз: кандидат строится до мутации (ревью 28, R1–R4)
  const parts = kind.windoor ? windoorParts(kind, params) : null;
  const widthCm = parts ? parts.widthCm : mmToCm(params.widthMm ?? kind.widthMm);
  const len = axisLength(wall);
  let at: number;
  if (params.centerMm !== undefined) {
    at = mmToCm(params.centerMm) - widthCm / 2;
  } else if (params.offsetMm !== undefined) {
    const fromEnd = (params.from ?? "start") === "end";
    const offsetFrom = params.offsetFrom ?? "inner";
    // tEdge — координата угла внутренней грани вдоль оси (№9 ревью)
    const tEdge = offsetFrom === "inner" ? innerEdgeOffsetCm(model, wall, fromEnd ? "end" : "start") : fromEnd ? len : 0;
    at = fromEnd ? tEdge - mmToCm(params.offsetMm) - widthCm : tEdge + mmToCm(params.offsetMm);
  } else if (replaced) {
    // замена без смещения — по центру исходного (ревью 105 R3): диапазон через
    // holeRange/holeOffsetCm — работает и для UI-проёмов без служебного at (прежняя
    // проекция pc использовала центр как расстояние до края и сдвигала замену)
    const repCenter = holeOffsetCm(wall, replaced) + replaced.width / 2;
    at = repCenter - widthCm / 2;
  } else {
    at = mmToCm(0);
  }
  // ревью 105 R3: при replaces положение замены задаётся исходным проёмом — центр
  // замены совпадает с центром исходного; явно переданный offset/center, уводящий
  // замену с места исходного, — INVALID_ARGUMENT
  if (replaced && (params.centerMm !== undefined || params.offsetMm !== undefined)) {
    const repCenter = holeOffsetCm(wall, replaced) + replaced.width / 2;
    const newCenter = at + widthCm / 2;
    if (Math.abs(newCenter - repCenter) > 0.5) {
      throw new McpError("INVALID_ARGUMENT",
        `замена проёма ${replaced.id} ставится по центру исходного (смещение центра ${Math.round((newCenter - repCenter) * 10)} мм) — при replaces положение не задаётся`, {
          hint: "не передавайте offset_mm/center_mm вместе с replaces: замена встаёт по центру исходного проёма",
          details: { kind: "replacement_position_conflict", wall_id: wall.id, hole_id: replaced.id, shift_mm: Math.round((newCenter - repCenter) * 10) },
        });
    }
  }
  checkPlacement(wall, at, widthCm, replaced?.id);

  const pc = pointAtLength(wallAxis(wall), at + widthCm / 2);
  const holeId = newId(10);
  const hole: Hole = {
    id: holeId,
    plan: wall.plan,
    type: kind.type,
    group: kind.group,
    pc: { x: r2(pc.x), y: r2(pc.y) },
    width: r2(widthCm),
    height: mmToCm(params.heightMm ?? kind.heightMm),
    depth: kind.depthCm,
    at: r2(at),
  };
  const sill = mmToCm(params.sillHeightMm ?? kind.sillCm * 10);
  if (sill > 0) hole.floor_height = sill;
  else if (kind.group === "windows") hole.floor_height = 0; // эталон UI: у окон floor_height присутствует всегда
  // у балконного блока поле height в модели отсутствует (эталон ui-ref-window-window_balcony)
  if (kind.windoor) delete hole.height;
  // opening: swing с учётом формата типа, иначе дефолт вида (окна и двери, этап 25/37)
  const opening = openingFromSwing(params.swing, kind) ?? kind.defaultOpening;
  if (opening) hole.opening = opening;
  if (params.arched) hole["arched"] = 1;
  if (kind.group === "windows") applyWindowFields(hole, kind, params, parts ?? undefined);
  else {
    // двери (этап 37): короб с наличниками по умолчанию (у doorway/garage выключен),
    // число полотен casements 1, угол рассвета 0 — как в эталоне UI
    hole.casing = params.casing === undefined ? (kind.defaultCasing ?? 1) : params.casing ? 1 : 0;
    hole.casements = params.casements ?? params.leaves ?? 1;
    hole.slope_angle = 0;
  }

  setHolePoints(wall, hole);
  if (replaced) {
    // замена исходного проёма (эталон ui-ref-replan-replacement): проём листа «c»
    // по центру исходного, у исходного — hasReplacement:1. Без полей parent/
    // parent_depth/offset/dls_prs/pcb/p1b/p2b редактор падает на restore
    // (проба 103-norm-check, этап replacement)
    hole.plan = "c";
    hole.position = "c";
    hole.parent = wall.id;
    hole.parent_depth = wall.depth;
    hole.dls_prs = {};
    hole.offset = 0;
    hole.pcb = { x: r2(hole.pc.x), y: r2(hole.pc.y) };
    hole.p1b = { x: r2(hole.p1!.x), y: r2(hole.p1!.y) };
    hole.p2b = { x: r2(hole.p2!.x), y: r2(hole.p2!.y) };
    replaced.hasReplacement = 1;
  }
  assertHoleInvariants(hole); // все инварианты кандидата — до записи в модель (ревью 28, R3/R4)
  wall.holes ??= {};
  wall.holes[holeId] = hole;
  return hole;
}

/**
 * Итоговые инварианты кандидат-копии проёма (ревью 28, R1–R4): конечность вычисленной
 * геометрии, согласованность частей балконного блока и импост в пределах итоговой высоты
 * двери — при add и при изменении зависимых размеров, даже если impost_height_mm не передан.
 * Выбор поведения (ревью 28, R4): импост, переставший помещаться, — ОШИБКА, а не
 * пропорциональная коррекция: молча двигать сохранённую геометрию нельзя.
 * Выполняется один раз на кандидате до любого изменения модели.
 */
function assertHoleInvariants(hole: Hole): void {
  assertFiniteHole(hole);
  if (hole.type === "windoor") {
    if (hole.height !== undefined) {
      throw new McpError("INTERNAL", "у балконного блока поле height отсутствует — высоты хранятся в частях", {
        details: { kind: "windoor_has_height", hole_id: hole.id },
      });
    }
    const ww = hole.window_width;
    const dw = hole.door_width;
    if (typeof ww !== "number" || !(ww > 0) || typeof dw !== "number" || !(dw > 0)) {
      throw new McpError("INVALID_ARGUMENT", "у балконного блока должны быть положительные ширины частей window_width/door_width", {
        details: { kind: "windoor_parts_missing", hole_id: hole.id },
      });
    }
    if (Math.abs(hole.width - (ww + dw)) > 0.03) {
      throw new McpError("INVALID_ARGUMENT", `общая ширина балконного блока противоречит частям: ${Math.round(hole.width * 10)} мм ≠ ${Math.round(ww * 10)} + ${Math.round(dw * 10)} мм`, {
        details: { kind: "windoor_parts_mismatch", hole_id: hole.id },
      });
    }
  }
  const impost = hole.impost_offset as number | undefined;
  if (impost !== undefined) {
    const doorH = (hole.door_height as number | undefined) ?? hole.height;
    if (doorH === undefined || !(impost > 0) || !(impost < doorH)) {
      throw new McpError("INVALID_ARGUMENT",
        `высота импоста (${Math.round(impost * 10)} мм от низа двери) не помещается в дверь высотой ${doorH === undefined ? "—" : Math.round(doorH * 10)} мм — уменьшите impost_height_mm или увеличьте height_mm`, {
          details: { kind: "impost_outside_door", hole_id: hole.id },
        });
    }
  }
}

/**
 * Конечность вычисленной геометрии (ревью 26, №1): NaN в координатах/размерах модель сайта
 * не ловит (JSON отдаёт null) — проверяем все числовые поля проёма до записи в модель.
 */
function assertFiniteHole(hole: Hole): void {
  const fields: [string, unknown][] = [
    ["width", hole.width], ["height", hole.height],
    ["pc.x", hole.pc?.x], ["pc.y", hole.pc?.y],
    ["floor_height", hole.floor_height], ["impost_offset", hole.impost_offset],
    ["window_width", hole.window_width], ["window_height", hole.window_height],
    ["door_width", hole.door_width], ["door_height", hole.door_height],
    ["sill.thinkness", (hole.sill as { thinkness?: unknown } | undefined)?.thinkness],
    ["sill.overhang", hole.sill !== undefined ? (hole.sill as { overhang?: unknown }).overhang : undefined],
    ["sill.overmeasure", hole.sill !== undefined ? (hole.sill as { overmeasure?: unknown }).overmeasure : undefined],
  ];
  for (const [name, v] of fields) {
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      throw new McpError("INTERNAL", `вычислена неконечная геометрия проёма: ${name}`, {
        details: { kind: "opening_not_finite", hole_id: hole.id, field: name },
      });
    }
  }
}

function setHolePoints(wall: Wall, hole: Hole): void {
  const { p1, p2 } = pointsAroundCenter(wallAxis(wall), hole.pc, hole.width / 2);
  hole.p1 = { x: r2(p1.x), y: r2(p1.y) };
  hole.p2 = { x: r2(p2.x), y: r2(p2.y) };
}

/** Подгоняет pc/at под текущую ось стены: at берём из поля или проекции прежнего pc (№6 ревью). */
export function refreshHole(wall: Wall, hole: Hole): void {
  const at = holeOffsetCm(wall, hole);
  if (hole.at === undefined) hole.at = r2(at);
  const pc = pointAtLength(wallAxis(wall), at + hole.width / 2);
  hole.pc = { x: r2(pc.x), y: r2(pc.y) };
  setHolePoints(wall, hole);
}

/**
 * Пересчёт pc/p1/p2 всех проёмов стены под её текущую ось. Вызывается после трансформаций
 * стены (move/update/split); прежние at сохраняются, у UI-проёмов без at — проекция pc (№4, №6).
 */
export function refreshWallHoles(wall: Wall): void {
  for (const hole of Object.values(wall.holes)) {
    refreshHole(wall, hole);
  }
}

export type UpdateOpeningParams = Partial<Omit<AddOpeningParams, "wallId" | "type">> & {
  wallId: string;
  holeId: string;
  type?: string;
};

/** Меняет поле sill проёма по переданным частям (мм), сохраняя остальное.
 *  Прежний объект расширяется через spread (ревью 30, N5): неизвестные вложенные
 *  поля (не из четырёх известных ключей) не теряются. */
function applySill(hole: Hole, p: WindowParams): void {
  const prev = (hole.sill ?? {}) as Partial<HoleSill>;
  hole.sill = {
    ...prev,
    thinkness: p.sillThicknessMm !== undefined ? mmToCm(p.sillThicknessMm) : prev.thinkness ?? 4,
    overhang: p.sillOverhangMm !== undefined ? mmToCm(p.sillOverhangMm) : prev.overhang ?? 0,
    overmeasure: p.sillOvermeasureMm !== undefined ? mmToCm(p.sillOvermeasureMm) : prev.overmeasure ?? 0,
    side: prev.side ?? "l",
  };
}

/** Присваивает разобранные части балконного блока (вызывается после checkPlacement).
 *  Части пишутся всегда: у старого объекта без частей они нормализуются из дефолтов
 *  каталога (ревью 30, N3) — windoorParts при отсутствии прежних частей даёт
 *  дефолтные ширины и высоты (окно 150, дверь 225 по эталону UI). */
function applyWindoorPartsFrom(hole: Hole, parts: { ww?: number; wh: number; dw?: number; dh: number }): void {
  if (parts.ww !== undefined) hole.window_width = parts.ww;
  if (parts.dw !== undefined) hole.door_width = parts.dw;
  hole.window_height = parts.wh;
  hole.door_height = parts.dh;
  hole.door_position = "l"; // right отвергнут валидатором (№4); у старого объекта нормализуется из дефолта
}

/** Сопоставление type модели → вид каталога (для валидации update без явного type). */
export const KIND_BY_HOLE_TYPE: Record<string, OpeningKind> = {};
for (const k of Object.values(OPENING_KINDS)) KIND_BY_HOLE_TYPE[k.type] = k;

/**
 * Нормализация формата opening у проёмов стены, чья геометрия изменилась (ревью 38,
 * путь «перенос стены, сохраняющий недопустимый opening»): legacy-объекты v0.1.1
 * (например door_coupe без opening) после moveWall/updateWall пересчитывают точки, но
 * сохраняли недопустимый формат — MCP отдавал бы редактору проём, который restore не
 * восстанавливает. Вызывается стеновыми трансформациями рядом с refreshWallHoles только
 * для стен, чья геометрия изменилась: проёмы нетронутых стен не модифицируются.
 * Атомарность обеспечивает atomic() вызывающей трансформации. Неизвестные типы не трогаются.
 */
export function normalizeWallOpeningFormats(wall: Wall): void {
  for (const hole of Object.values(wall.holes)) {
    const kind = KIND_BY_HOLE_TYPE[normalizeHoleType(hole.type)];
    if (kind) normalizeOpeningFormat(hole, kind);
  }
}

/**
 * Legacy-имя типа балконного блока в старых моделях → каноническое type (ревью 28, R2):
 * старый объект type:"window_balcony" не находился в KIND_BY_HOLE_TYPE и обходил
 * валидатор и запрет переходов.
 */
function normalizeHoleType(type: string): string {
  return type === "window_balcony" ? "windoor" : type;
}

/**
 * opening_update: меняет размеры/положение проёма с повторной проверкой коллизий.
 * Смена типа не поддерживается (ревью 30, N1/N2/N4: каждая версия конверсии рождала
 * новые регрессии): type, отличный от текущего (после нормализации legacy-алиаса
 * window_balcony → windoor), — INVALID_ARGUMENT с подсказкой удалить проём и добавить
 * новый; передача текущего type — no-op. Новые проёмы на балконных ограждениях
 * запрещены (addOpening), уже стоящий проём ограждения правится (ревью 73 №1).
 */
export function updateOpening(model: Model, params: UpdateOpeningParams): Hole {
  const wall = model.walls[params.wallId];
  if (!wall) throw new McpError("NOT_FOUND", `стена ${params.wallId} не найдена`);
  const hole = wall.holes[params.holeId];
  if (!hole) throw new McpError("NOT_FOUND", `проём ${params.holeId} не найден`);
  // правило hole__dont_install_over_balcony запрещает только НОВЫЕ проёмы на
  // ограждениях (ban в addOpening ниже); уже стоящий проём существующего проекта
  // правится как прежде (регрессия ревью 73 №1), удаление тоже разрешено
  // смена типа — до любой мутации (№3); legacy window_balcony нормализуется к windoor
  // и в сравнении, и в сообщении об ошибке (ревью 28, R2)
  const holeType = normalizeHoleType(hole.type);
  if (params.type !== undefined) {
    // вид ищется и по ключу каталога, и по type модели (windoor/single/…): передача
    // текущего типа объекта — no-op, включая legacy-алиас window_balcony
    const kind = OPENING_KINDS[params.type] ?? KIND_BY_HOLE_TYPE[normalizeHoleType(params.type)];
    if (!kind) {
      throw new McpError("INVALID_ARGUMENT", `неизвестный тип проёма: ${params.type}`, {
        hint: `доступны: ${Object.keys(OPENING_KINDS).join(", ")}`,
      });
    }
    if (kind.type !== holeType) {
      throw new McpError("INVALID_ARGUMENT",
        `смена типа не поддерживается: удалите проём (opening_delete) и добавьте новый (opening_add) с нужным типом`);
    }
  }
  const effKind = KIND_BY_HOLE_TYPE[holeType];
  if (!effKind) {
    // неизвестный тип в модели не пропускается мимо валидатора (ревью 28, R2)
    throw new McpError("INVALID_ARGUMENT", `неизвестный тип проёма в модели: ${hole.type}`, {
      hint: `доступны: ${Object.values(OPENING_KINDS).map((k) => k.type).join(", ")}`,
    });
  }
  // применимость параметров и входы — до любой мутации (№1/№6; ревью 28, R3)
  validateOpeningParams(effKind, params, hole);

  // кандидат-копия: все проверки и вычисления — на копии, исходный hole не меняется,
  // пока не пройдут проверка коллизий и итоговые инварианты (ревью 28, R1/R3/R4)
  const candidate = structuredClone(hole);
  if (hole.type !== effKind.type || hole.group !== effKind.group) {
    candidate.type = effKind.type; // нормализация legacy-имени типа
    candidate.group = effKind.group;
  }

  // разбор частей — до мутации; присваивание только кандидату. У windoor части
  // разбираются при любом update: у старого объекта без частей они нормализуются
  // из дефолтов каталога (ревью 30, N3) до итоговых инвариантов
  const windoor = effKind.windoor ? windoorParts(effKind, params, hole) : null;

  const heightCm = params.heightMm !== undefined ? mmToCm(params.heightMm) : undefined;
  let sillFloor: number | undefined;
  if (params.sillHeightMm !== undefined) {
    const sill = mmToCm(params.sillHeightMm);
    sillFloor = sill > 0 ? sill : 0;
  }
  // импост считается от низа двери: учитываем и новый подоконник, если он меняется тем же вызовом
  const impost = params.impostHeightMm !== undefined
    ? mmToCm(params.impostHeightMm) - (sillFloor ?? (hole.floor_height as number | undefined) ?? 0)
    : undefined;

  const width = windoor ? windoor.widthCm : (params.widthMm !== undefined ? mmToCm(params.widthMm) : hole.width);
  const len = axisLength(wall);
  let at: number;
  if (params.centerMm !== undefined) {
    at = mmToCm(params.centerMm) - width / 2;
  } else if (params.offsetMm !== undefined) {
    const fromEnd = (params.from ?? "start") === "end";
    const offsetFrom = params.offsetFrom ?? "inner";
    // tEdge — координата угла внутренней грани вдоль оси (№9 ревью)
    const tEdge = offsetFrom === "inner" ? innerEdgeOffsetCm(model, wall, fromEnd ? "end" : "start") : fromEnd ? len : 0;
    at = fromEnd ? tEdge - mmToCm(params.offsetMm) - width : tEdge + mmToCm(params.offsetMm);
  } else {
    // положение не меняем: at из поля или проекции прежнего pc, а не середина стены (№6 ревью)
    at = holeOffsetCm(wall, hole);
  }
  // ревью 108 R4: партнёр по паре замены исключается из проверки пересечений
  // (высота/размеры одного участника не должны блокироваться вторым), а перенос,
  // меняющий центр, переносится согласованно на второго участника
  const pair = replacementPairOf(wall, hole);
  checkPlacement(wall, at, width, hole.id, pair?.id); // до мутации: при ошибке модель не меняется

  if (windoor) applyWindoorPartsFrom(candidate, windoor);
  // Миграция legacy-высоты (ревью 32, N3): блок, созданный прежней версией MCP (d107f87),
  // хранит общую высоту в поле height (например 225 при floor_height 80) и не имеет частей.
  // Новое представление высот в поле height не хранит, поэтому до финальной проверки
  // инвариантов общий height мигрирует в высоты частей и удаляется на кандидате:
  // - door_height = прежний общий height (дверь определяла габарит старого блока);
  // - window_height = дефолт каталога (150 см), но не больше прежнего height;
  // - существующие высоты частей не затираются; явно переданные window_height_mm/
  //   door_height_mm сильнее миграции.
  if (effKind.windoor && candidate.height !== undefined) {
    const legacyH = candidate.height;
    if (hole.door_height === undefined && params.doorHeightMm === undefined) {
      candidate.door_height = legacyH;
    }
    if (hole.window_height === undefined && params.windowHeightMm === undefined) {
      candidate.window_height = Math.min(windoor!.wh, legacyH);
    }
    delete candidate.height;
  }
  if (heightCm !== undefined) candidate.height = heightCm;
  if (sillFloor !== undefined) {
    if (sillFloor > 0) candidate.floor_height = sillFloor;
    else delete candidate.floor_height;
  }
  if (params.swing) {
    const opening = openingFromSwing(params.swing, effKind);
    if (opening) candidate.opening = opening;
  }
  // legacy-нормализация opening (этап 37): объекты v0.1.1 без opening (или с двухчастным
  // у однобуквенных типов) редактор не восстанавливает — приводим к формату вида
  normalizeOpeningFormat(candidate, effKind);
  if (params.arched !== undefined) candidate["arched"] = params.arched ? 1 : 0;
  if (params.casing !== undefined) candidate.casing = params.casing ? 1 : 0;
  if (params.casements !== undefined || params.leaves !== undefined) {
    const cas = params.casements ?? params.leaves;
    if (cas !== undefined) candidate.casements = cas;
  }
  if (params.slopeAngleDeg !== undefined) candidate.slope_angle = params.slopeAngleDeg;
  if (params.sillThicknessMm !== undefined || params.sillOverhangMm !== undefined || params.sillOvermeasureMm !== undefined) {
    applySill(candidate, params);
  }
  if (impost !== undefined) candidate.impost_offset = impost;
  candidate.width = r2(width);
  candidate.at = r2(at);
  refreshHole(wall, candidate);
  assertHoleInvariants(candidate); // финальные инварианты — тоже до изменения модели (R3/R4)
  // согласованный перенос пары (ревью 108 R4): центр сместился — второй участник
  // следует за первым. Проверка на копии стены до любой мутации: не помещается —
  // атомарный отказ с подсказкой (выбор поведения: перенос, а не разъезд пары)
  if (pair) {
    const newCenter = at + width / 2;
    const pairCenter = holeOffsetCm(wall, pair) + pair.width / 2;
    if (Math.abs(newCenter - pairCenter) > 0.005) {
      const scratch = structuredClone(wall);
      assignCandidate(scratch.holes[hole.id]!, candidate);
      const sp = scratch.holes[pair.id]!;
      if (sp.at !== undefined) {
        sp.at = r2(newCenter - sp.width / 2);
        refreshHole(scratch, sp);
      } else {
        // UI-проём без служебного at: позиция задаётся центром pc
        const pc = pointAtLength(wallAxis(scratch), newCenter);
        sp.pc = { x: r2(pc.x), y: r2(pc.y) };
        setHolePoints(scratch, sp);
      }
      try {
        checkPlacement(scratch, holeOffsetCm(scratch, sp), sp.width, sp.id, hole.id);
      } catch (cause) {
        const code = cause instanceof McpError ? cause.code : "GEOMETRY_CONFLICT";
        throw new McpError(code,
          `перенос проёма ${hole.id} уводит с места пару замены: второй участник ${pair.id} (${hole.plan === "c" ? "исходный" : "замена"}) не помещается на стене после переноса`, {
            hint: "пара замены переносится согласованно; перенесите пару в пределы стены или удалите замену (opening_delete) перед переносом",
            details: { kind: "replacement_pair_transfer_conflict", wall_id: wall.id, hole_id: hole.id, pair_id: pair.id },
          });
      }
      assignCandidate(pair, scratch.holes[pair.id]!);
    }
  }
  assignCandidate(hole, candidate);
  return hole;
}

/**
 * opening_delete (ревью 105 R4, 108 R4 — жизненный цикл пары замены):
 * - удаление замены (plan:c с parent = id стены) снимает hasReplacement у исходного —
 *   иначе повторная замена навсегда запрещена;
 * - удаление исходного (hasReplacement) удаляет и замену — висячая замена не нужна
 *   (выбор поведения описан в отчёте 106; отказ альтернативой); ревью 108 R11:
 *   возвращает все удалённые ID — инструмент показывает каскад в ответе.
 * Пара сопоставляется по связи (parent/hasReplacement), центр — только
 * для выбора между несколькими парами на стене (replacementPairOf).
 */
export function deleteOpening(model: Model, wallId: string, holeId: string): { deleted: string[] } {
  const wall = model.walls[wallId];
  if (!wall) throw new McpError("NOT_FOUND", `стена ${wallId} не найдена`);
  const hole = wall.holes[holeId];
  if (!hole) throw new McpError("NOT_FOUND", `проём ${holeId} не найден`);
  const deleted: string[] = [holeId];
  if (hole.hasReplacement) {
    // исходный: замену ищем по связи (plan:c, parent = эта стена)
    const rep = replacementPairOf(wall, hole);
    if (rep) {
      delete wall.holes[rep.id];
      deleted.push(rep.id);
    }
  } else if (hole.parent === wallId && hole.plan === "c") {
    // замена: исходный — проём этой стены с hasReplacement (связь по флагу)
    const original = replacementPairOf(wall, hole);
    if (original) delete original.hasReplacement;
  }
  delete wall.holes[holeId];
  return { deleted };
}

/**
 * Пара замены (ревью 108 R4): связь определяется структурой, а не центром —
 * у замены plan:"c" с parent = id стены, у исходного hasReplacement на той же стене.
 * Центр используется только, чтобы выбрать между несколькими парами на одной стене;
 * согласованный перенос в updateOpening держит центры пары совпадающими.
 * Единая точка поиска пары для update/delete и сверки демонтажа (replacementOf).
 * ревью 110 R4: обычный проём — не замена (нет plan:"c" с parent на стене) и сам
 * не имеет hasReplacement — ни в какой паре не состоит, возвращается null. Иначе
 * поиск по структуре подсовывает чужую замену и согласованный перенос двигает её
 * вслед за обычным проёмом (порча чужой пары без запроса).
 */
export function replacementPairOf(wall: Wall, hole: Hole): Hole | null {
  const holeIsReplacement = hole.plan === "c" && hole.parent === wall.id;
  if (!holeIsReplacement && !hole.hasReplacement) return null;
  const candidates = Object.values(wall.holes ?? {}).filter((other) => {
    if (other.id === hole.id) return false;
    if (holeIsReplacement) return Boolean(other.hasReplacement);
    return other.plan === "c" && other.parent === wall.id;
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const center = holeOffsetCm(wall, hole) + hole.width / 2;
  let best = candidates[0]!;
  let bestDist = Infinity;
  for (const other of candidates) {
    const d = Math.abs(holeOffsetCm(wall, other) + other.width / 2 - center);
    if (d < bestDist) {
      best = other;
      bestDist = d;
    }
  }
  return best;
}

/**
 * p1/p2 проёма — края на оси стены (pc ∓ width/2). Обязательны перед $Project.restore:
 * без них Walls.restore молча удаляет окно/дверь (02-feasibility).
 */
export function prepareHolePoints(model: Model): void {
  for (const wall of Object.values(model.walls)) {
    wall.holes ??= {}; // у стен из серверной модели поле holes может отсутствовать
    for (const hole of Object.values(wall.holes)) {
      setHolePoints(wall, hole);
    }
  }
}

/** Расстояние от начала стены до ближайшего края проёма, мм (для compact-модели). */
export function holeOffsetFromStart(wall: Wall, hole: Hole): number {
  const [from] = holeRange(wall, hole);
  return from * 10;
}

/** Центр проёма от начала оси, мм. */
export function holeCenterFromStart(wall: Wall, hole: Hole): number {
  return (holeOffsetCm(wall, hole) + hole.width / 2) * 10;
}

export function findHole(model: Model, holeId: string): { wall: Wall; hole: Hole } | null {
  for (const wall of Object.values(model.walls)) {
    const hole = wall.holes?.[holeId];
    if (hole) return { wall, hole };
  }
  return null;
}

// вспомогательное: точка на стене для item-привязок
export function pointOnWallAt(model: Model, wallId: string, atMm: number): MmPoint {
  const wall = model.walls[wallId];
  if (!wall) throw new McpError("NOT_FOUND", `стена ${wallId} не найдена`);
  const p = pointAtLength(wallAxis(wall), mmToCm(atMm));
  return { x: p.x, y: p.y };
}
