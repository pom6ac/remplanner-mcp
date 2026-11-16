import type { Model, Wall, Hole, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import { pointsAroundCenter, pointAtLength, projectionLength, type Segment } from "./geometry.ts";
import type { MmPoint } from "./walls.ts";
import { wallFaces } from "./walls.ts";
import { McpError } from "../errors.ts";

/**
 * Таблица «ключ каталога → hole.type / group / дефолты».
 * Двери: door → single проверено кликами по UI (T1), остальные — по имени бандла.
 * Окна (все 7 пунктов меню «Окна»): проверены кликами по UI, эталоны
 * tests/fixtures/ui-ref-window-<тип>.json (этап 25, 2026-11-16): model.type, ширина,
 * высота, глубина (hole.depth — не толщина стены!), подоконник, дефолтное opening.
 */
export type OpeningKind = {
  type: string;
  group: "doors" | "windows";
  widthMm: number;
  heightMm: number;
  depthCm: number;
  /** Высота от пола до низа проёма, см (подоконник окна / ноль у двери). */
  sillCm: number;
  /** Только окна: дефолтное поле opening модели (сторона петель, как в UI). */
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
};

export const OPENING_KINDS: Record<string, OpeningKind> = {
  // двери (group doors)
  doorway: { type: "doorway", group: "doors", widthMm: 900, heightMm: 2100, depthCm: 10, sillCm: 0 },
  door: { type: "single", group: "doors", widthMm: 800, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_double: { type: "double", group: "doors", widthMm: 1200, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_coupe: { type: "door_coupe", group: "doors", widthMm: 800, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_coupe_double: { type: "door_coupe_double", group: "doors", widthMm: 1200, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_penal: { type: "door_penal", group: "doors", widthMm: 800, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_penal_double: { type: "door_penal_double", group: "doors", widthMm: 1200, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_roto: { type: "door_roto", group: "doors", widthMm: 800, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_roto_double: { type: "door_roto_double", group: "doors", widthMm: 1200, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_book: { type: "door_book", group: "doors", widthMm: 800, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_book_double: { type: "door_book_double", group: "doors", widthMm: 1200, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_bellows: { type: "door_bellows", group: "doors", widthMm: 800, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_glass: { type: "door_glass", group: "doors", widthMm: 800, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_garage: { type: "door_garage", group: "doors", widthMm: 3000, heightMm: 2250, depthCm: 4, sillCm: 0 },
  door_system_x2: { type: "door_system_x2", group: "doors", widthMm: 800, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_system_x3: { type: "door_system_x3", group: "doors", widthMm: 800, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_system_x4: { type: "door_system_x4", group: "doors", widthMm: 800, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_system_penal_x2: { type: "door_system_penal_x2", group: "doors", widthMm: 800, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_system_penal_x3: { type: "door_system_penal_x3", group: "doors", widthMm: 800, heightMm: 2000, depthCm: 4, sillCm: 0 },
  door_system_penal_x4: { type: "door_system_penal_x4", group: "doors", widthMm: 800, heightMm: 2000, depthCm: 4, sillCm: 0 },
  // окна (group windows) — эталоны ui-ref-window-*.json, проверено в UI
  windowway: { type: "windowway", group: "windows", widthMm: 1200, heightMm: 1500, depthCm: 6, sillCm: 85,
    defaultOpening: "r", slopesCm: 20, defaultCasements: 1, sillSide: "l" },
  window: { type: "window", group: "windows", widthMm: 1200, heightMm: 1500, depthCm: 6, sillCm: 85,
    defaultOpening: "r-l", slopesCm: 20, defaultCasements: 1, sillSide: "l" },
  window_balcony: { type: "windoor", group: "windows", widthMm: 1800, heightMm: 2250, depthCm: 6, sillCm: 10,
    defaultOpening: "r-l", defaultCasements: 1, windoor: true, sillSide: "r" },
  window_door: { type: "window_door", group: "windows", widthMm: 800, heightMm: 2250, depthCm: 6, sillCm: 10,
    defaultOpening: "r-l", slopesCm: 20, defaultCasements: 1, sillSide: "l", impostOffsetCm: 75 },
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
 * swing {hinge, into} → строка opening в модели.
 * Проверен только вариант fixture: дверь, открывающаяся от p2 влево → "r-l";
 * остальные комбинации выводятся по той же схеме и не проверены живым кругом.
 */
export function openingFromSwing(swing?: { hinge: "start" | "end"; into: "left" | "right" }): string | undefined {
  if (!swing) return undefined;
  const leaf = swing.into === "left" ? "l" : "r";
  return `${swing.hinge === "end" ? "r" : "l"}-${leaf}`;
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
};

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

function checkPlacement(wall: Wall, at: number, width: number, ignoreHoleId?: string): void {
  const len = axisLength(wall);
  const margin = wall.depth / 2;
  if (at < margin - 1e-6 || at + width > len - margin + 1e-6) {
    throw new McpError("GEOMETRY_CONFLICT", "проём выходит за границу стены", {
      details: { kind: "opening_outside_wall", wall_id: wall.id, at_cm: r2(at), width_cm: width, wall_len_cm: r2(len) },
    });
  }
  for (const other of Object.values(wall.holes)) {
    if (other.id === ignoreHoleId) continue;
    const [o1, o2] = holeRange(wall, other);
    if (at < o2 - 1e-6 && o1 < at + width) {
      throw new McpError("GEOMETRY_CONFLICT", "проём пересекает другой проём", {
        details: { kind: "openings_overlap", wall_id: wall.id, hole_id: other.id },
      });
    }
  }
}

/** Разбор параметров балконного блока (windoor): ширины окна и двери, итог = сумма. */
function windoorParts(kind: OpeningKind, p: AddOpeningParams): { ww: number; wh: number; dw: number; dh: number; widthCm: number } {
  const wh = mmToCm(p.windowHeightMm ?? 1500);
  const dh = mmToCm(p.doorHeightMm ?? 2250);
  const wwGiven = p.windowWidthMm !== undefined ? mmToCm(p.windowWidthMm) : null;
  const dwGiven = p.doorWidthMm !== undefined ? mmToCm(p.doorWidthMm) : null;
  let ww: number, dw: number;
  if (wwGiven === null && dwGiven === null) {
    const total = mmToCm(p.widthMm ?? kind.widthMm);
    dw = 80; // дефолт двери блока (эталон UI)
    ww = total - dw;
  } else if (dwGiven === null) {
    ww = wwGiven!;
    dw = mmToCm(p.widthMm ?? kind.widthMm) - ww;
  } else if (wwGiven === null) {
    dw = dwGiven;
    ww = mmToCm(p.widthMm ?? kind.widthMm) - dw;
  } else {
    ww = wwGiven;
    dw = dwGiven;
  }
  return { ww, wh, dw, dh, widthCm: ww + dw };
}

/** Поля окна из панели свойств: sill, slope_angle, casements, slopes, windoor-части. */
function applyWindowFields(hole: Hole, kind: OpeningKind, p: AddOpeningParams, widthCm: number): void {
  if (kind.windoor) {
    const { ww, wh, dw, dh } = windoorParts(kind, p);
    hole.window_width = ww;
    hole.window_height = wh;
    hole.door_width = dw;
    hole.door_height = dh;
    hole.door_position = (p.doorPosition ?? "left") === "right" ? "r" : "l";
  }
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
  const kind = OPENING_KINDS[params.type];
  if (!kind) {
    throw new McpError("INVALID_ARGUMENT", `неизвестный тип проёма: ${params.type}`, {
      hint: `доступны: ${Object.keys(OPENING_KINDS).join(", ")}`,
    });
  }
  const widthCm = kind.windoor
    ? windoorParts(kind, params).widthCm
    : mmToCm(params.widthMm ?? kind.widthMm);
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
  } else {
    at = mmToCm(0);
  }
  checkPlacement(wall, at, widthCm);

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
  const opening = openingFromSwing(params.swing) ?? (kind.group === "windows" ? kind.defaultOpening : undefined);
  if (opening) hole.opening = opening;
  if (params.arched) hole["arched"] = 1;
  if (kind.group === "windows") applyWindowFields(hole, kind, params, widthCm);
  else if (params.casing !== undefined) hole.casing = params.casing ? 1 : 0;
  if (kind.group !== "windows" && params.leaves !== undefined) hole.casements = params.leaves;

  wall.holes[holeId] = hole;
  setHolePoints(wall, hole);
  return hole;
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

/** Меняет поле sill проёма по переданным частям (мм), сохраняя остальное. */
function applySill(hole: Hole, p: WindowParams): void {
  const prev = (hole.sill ?? {}) as Partial<HoleSill>;
  hole.sill = {
    thinkness: p.sillThicknessMm !== undefined ? mmToCm(p.sillThicknessMm) : prev.thinkness ?? 4,
    overhang: p.sillOverhangMm !== undefined ? mmToCm(p.sillOverhangMm) : prev.overhang ?? 0,
    overmeasure: p.sillOvermeasureMm !== undefined ? mmToCm(p.sillOvermeasureMm) : prev.overmeasure ?? 0,
    side: prev.side ?? "l",
  };
}

/** Меняет части балконного блока; итоговая ширина — сумма окна и двери. */
function applyWindoorParts(hole: Hole, p: WindowParams): number | null {
  const ww = p.windowWidthMm !== undefined ? mmToCm(p.windowWidthMm) : (hole.window_width as number | undefined);
  const dw = p.doorWidthMm !== undefined ? mmToCm(p.doorWidthMm) : (hole.door_width as number | undefined);
  if (ww === undefined && dw === undefined) return null;
  if (ww !== undefined) hole.window_width = ww;
  if (dw !== undefined) hole.door_width = dw;
  if (p.windowHeightMm !== undefined) hole.window_height = mmToCm(p.windowHeightMm);
  if (p.doorHeightMm !== undefined) hole.door_height = mmToCm(p.doorHeightMm);
  if (p.doorPosition !== undefined) hole.door_position = p.doorPosition === "right" ? "r" : "l";
  return (hole.window_width as number) + (hole.door_width as number);
}

/** opening_update: меняет размеры/положение проёма с повторной проверкой коллизий. */
export function updateOpening(model: Model, params: UpdateOpeningParams): Hole {
  const wall = model.walls[params.wallId];
  if (!wall) throw new McpError("NOT_FOUND", `стена ${params.wallId} не найдена`);
  const hole = wall.holes[params.holeId];
  if (!hole) throw new McpError("NOT_FOUND", `проём ${params.holeId} не найден`);
  if (params.type && OPENING_KINDS[params.type]) {
    const kind = OPENING_KINDS[params.type]!;
    hole.type = kind.type;
    hole.group = kind.group;
    if (kind.group === "windows" && kind.defaultOpening !== undefined && hole.opening === undefined) {
      hole.opening = kind.defaultOpening;
    }
  }
  if (params.heightMm !== undefined) hole.height = mmToCm(params.heightMm);
  if (params.sillHeightMm !== undefined) {
    const sill = mmToCm(params.sillHeightMm);
    if (sill > 0) hole.floor_height = sill;
    else delete hole.floor_height;
  }
  if (params.swing) {
    const opening = openingFromSwing(params.swing);
    if (opening) hole.opening = opening;
  }
  if (params.arched !== undefined) hole["arched"] = params.arched ? 1 : 0;
  if (params.casing !== undefined) hole.casing = params.casing ? 1 : 0;
  if (params.casements !== undefined || params.leaves !== undefined) {
    const cas = params.casements ?? params.leaves;
    if (cas !== undefined) hole.casements = cas;
  }
  if (params.slopeAngleDeg !== undefined) hole.slope_angle = params.slopeAngleDeg;
  if (params.sillThicknessMm !== undefined || params.sillOverhangMm !== undefined || params.sillOvermeasureMm !== undefined) {
    applySill(hole, params);
  }
  if (params.impostHeightMm !== undefined) {
    const floor = (hole.floor_height as number | undefined) ?? 0;
    hole.impost_offset = mmToCm(params.impostHeightMm) - floor;
  }
  const windoorWidth = applyWindoorParts(hole, params);

  const width = windoorWidth ?? (params.widthMm !== undefined ? mmToCm(params.widthMm) : hole.width);
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
  checkPlacement(wall, at, width, hole.id);
  hole.width = r2(width);
  hole.at = r2(at);
  refreshHole(wall, hole);
  return hole;
}

/** opening_delete. */
export function deleteOpening(model: Model, wallId: string, holeId: string): void {
  const wall = model.walls[wallId];
  if (!wall) throw new McpError("NOT_FOUND", `стена ${wallId} не найдена`);
  if (!wall.holes[holeId]) throw new McpError("NOT_FOUND", `проём ${holeId} не найден`);
  delete wall.holes[holeId];
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
