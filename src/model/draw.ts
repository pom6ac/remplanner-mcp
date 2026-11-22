import type { Model, Point, GraphDrawRec, FreeFigureEntity } from "./types.ts";
export type { GraphDrawRec, FreeFigureEntity };
import { newId } from "./types.ts";
import { McpError } from "../errors.ts";

/**
 * «Нарисовать элемент» нижней панели (этап 375, бандл app.3.0; кнопка
 * #freelines_opener, класс is_pro — PRO-инструмент):
 * - freelines — свободные линии (класс FreeLine extends GraphLines; тип
 *   "freeline"),_serialize: {id, matrix, vertexes, items, type, length,
 *   color_custom, plan, plan_, prs, width_stroke, type_stroke, on_size,
 *   on_area, fill, show_everywhere, id_shield, on_visual, visual_*,
 *   f0offset, id_room, pc, level_layer, id_group};
 * - thick_lines — толстые линии (ThickLine extends GraphLines, тип
 *   "thick_line"; ширина линии — в ячейке matrix {length, width}, умолчание
 *   defs.thick_line.width = 20 см, on_width — флаг индивидуальной ширины);
 * - free_figures — фигуры (класс FreeFigure, не граф): {id, type, pc, width,
 *   height, angle, rotated, radius, depth, color, plan, plan_, prs,
 *   width_stroke, type_stroke, on_size, on_area, area, fill, …}. Типы
 *   (preparePlanGeometry бандла): rect, rect_2, rect_round, rect_round_2,
 *   round, round_2, hexagon, octagon, triangle, triangle_2, semicircle,
 *   anticircle, quartercircle, roof.
 *
 * Единицы модели — см; MCP-инструменты принимают мм. Свободные линии и
 * фигуры — независимая геометрия: привязок к стенам у них нет, стены их
 * не трогают; план — произвольный лист (встроенный или custom_<id>
 * пользовательского листа).
 */

export const FREE_FIGURE_TYPES: readonly string[] = [
  "rect", "rect_2", "rect_round", "rect_round_2", "round", "round_2",
  "hexagon", "octagon", "triangle", "triangle_2", "semicircle", "anticircle",
  "quartercircle", "roof",
];

/** Фигура «Нарисовать элемент» (FreeFigure бандла): геометрия + стиль. */
/** Умолчания бандла (defs): фигура 50×50 см, толстая линия 20 см (widthDef). */
export const DEF_FIGURE_SIZE_CM = 50;
export const DEF_THICK_LINE_WIDTH_CM = 20;
/** Индивидуальная ширина толстой линии, мм (заявление отчёта 375, minor 376 №8:
 *  раньше width_mm: 0 проходил — ширина 0 см). */
export const THICK_LINE_WIDTH_MM_MIN = 2;
export const THICK_LINE_WIDTH_MM_MAX = 1500;

type StrokeStyle = {
  color_custom?: string;
  width_stroke?: number;
  type_stroke?: string;
};

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const STROKE_TYPES = new Set(["solid", "dash", "dot"]);

function validateStyle(style: StrokeStyle): void {
  if (style.color_custom !== undefined && !COLOR_RE.test(style.color_custom)) {
    throw new McpError("INVALID_ARGUMENT", "color — hex-код палитры редактора вида #148515", { details: { kind: "bad_color" } });
  }
  if (style.type_stroke !== undefined && !STROKE_TYPES.has(style.type_stroke)) {
    throw new McpError("INVALID_ARGUMENT", "type_stroke — solid | dash | dot", { details: { kind: "bad_type_stroke" } });
  }
  if (style.width_stroke !== undefined && (style.width_stroke < 0.5 || style.width_stroke > 10)) {
    throw new McpError("INVALID_ARGUMENT", "width_stroke — толщина контура 0.5..10", { details: { kind: "bad_width_stroke" } });
  }
}

/** План: встроенный «исходный» (plan/a), мебель (furniture) или существующий
 *  пользовательский лист (custom_<id>). Minor 376 №6: произвольная строка
 *  (no_such_sheet, zzz) ставила объект на несуществующий лист — объект
 *  становился невидимым; белый список = контракт инструментов раздела. */
export function validateDrawPlan(model: Model, plan: string): string {
  if (plan === "plan" || plan === "furniture") return plan;
  if (plan.startsWith("custom_")) {
    const id = plan.slice("custom_".length);
    const known = (model.custom_plans as Record<string, unknown> | undefined)?.[id];
    if (!known) throw new McpError("NOT_FOUND", `пользовательский лист ${plan} не найден`);
    return plan;
  }
  throw new McpError("INVALID_ARGUMENT", `plan — «plan», «furniture» или custom_<id> существующего пользовательского листа (получено «${plan.slice(0, 40)}»)`, {
    details: { kind: "bad_plan", plan },
  });
}

function polylineRec(
  model: Model,
  coll: "freelines" | "thick_lines",
  params: {
    points: Point[];
    plan: string;
    color?: string;
    widthStroke?: number;
    typeStroke?: string;
    widthMm?: number;
    fill?: string;
  },
  type: string,
): GraphDrawRec {
  const pts = params.points;
  if (pts.length < 2) throw new McpError("INVALID_ARGUMENT", "нужны минимум 2 точки (мм)");
  if (pts.length > 200) throw new McpError("INVALID_ARGUMENT", "максимум 200 точек ломаной");
  validateStyle({ color_custom: params.color, width_stroke: params.widthStroke, type_stroke: params.typeStroke });
  if (coll === "thick_lines" && params.widthMm !== undefined &&
      (params.widthMm < THICK_LINE_WIDTH_MM_MIN || params.widthMm > THICK_LINE_WIDTH_MM_MAX)) {
    throw new McpError("INVALID_ARGUMENT", `width_mm — ширина толстой линии ${THICK_LINE_WIDTH_MM_MIN}..${THICK_LINE_WIDTH_MM_MAX} мм`, {
      details: { kind: "bad_width_mm", width_mm: params.widthMm },
    });
  }
  const n = pts.length;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(newId());
  const matrix: ({ length: number; width?: number } | null)[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
  let lengthCm = 0;
  for (let i = 0; i + 1 < n; i++) {
    const d = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
    lengthCm += d;
    const cell: { length: number; width?: number } = { length: 1, ...(coll === "thick_lines" && params.widthMm !== undefined ? { width: Math.round((params.widthMm / 10) * 100) / 100 } : {}) };
    matrix[i]![i + 1] = cell;
    matrix[i + 1]![i] = cell;
  }
  const rec: GraphDrawRec = {
    id: newId(),
    matrix,
    vertexes: pts.map((p, i) => ({ id: ids[i]!, point: { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }, type: "node" })),
    items: Object.fromEntries(ids.map((id) => [id, "node"])),
    type,
    length: Math.round(lengthCm / 100 * 100) / 100,
    plan: params.plan,
    ...(params.color ? { color_custom: params.color } : {}),
    ...(params.widthStroke !== undefined ? { width_stroke: params.widthStroke } : {}),
    ...(params.typeStroke ? { type_stroke: params.typeStroke } : {}),
    ...(params.fill ? { fill: params.fill } : {}),
    level_layer: 7,
  };
  if (coll === "thick_lines") rec.on_width = params.widthMm !== undefined ? 1 : 0;
  const m = (model[coll] ??= {}) as Record<string, GraphDrawRec>;
  m[rec.id] = rec;
  return rec;
}

export function addFreeline(
  model: Model,
  params: { points: Point[]; plan: string; color?: string; widthStroke?: number; typeStroke?: string; fill?: string },
): GraphDrawRec {
  return polylineRec(model, "freelines", params, "freeline");
}

export function addThickLine(
  model: Model,
  params: { points: Point[]; plan: string; color?: string; widthStroke?: number; typeStroke?: string; widthMm?: number; fill?: string },
): GraphDrawRec {
  return polylineRec(model, "thick_lines", params, "thick_line");
}

export function addFigure(
  model: Model,
  params: { type: string; center: Point; widthMm?: number; heightMm?: number; angleDeg?: number; color?: string; fill?: string; plan: string; widthStroke?: number; typeStroke?: string },
): Record<string, unknown> {
  if (!FREE_FIGURE_TYPES.includes(params.type)) {
    throw new McpError("INVALID_ARGUMENT", `тип фигуры «${params.type}» не поддерживается (фигуры «Нарисовать элемент»: ${FREE_FIGURE_TYPES.join(", ")})`, {
      details: { kind: "bad_figure_type" },
    });
  }
  validateStyle({ color_custom: params.color, width_stroke: params.widthStroke, type_stroke: params.typeStroke });
  const widthCm = params.widthMm !== undefined ? params.widthMm / 10 : DEF_FIGURE_SIZE_CM;
  const heightCm = params.heightMm !== undefined ? params.heightMm / 10 : DEF_FIGURE_SIZE_CM;
  if (widthCm <= 0 || heightCm <= 0) throw new McpError("INVALID_ARGUMENT", "размеры фигуры — положительные числа (мм)");
  const angle = params.angleDeg ?? 0;
  const rec: FreeFigureEntity = {
    id: newId(),
    type: params.type,
    pc: { x: Math.round(params.center.x * 100) / 100, y: Math.round(params.center.y * 100) / 100 },
    width: Math.round(widthCm * 100) / 100,
    height: Math.round(heightCm * 100) / 100,
    angle,
    rotated: angle !== 0 ? 1 : 0,
    radius: params.type === "rect_round" || params.type === "rect_round_2" ? 5 : 0,
    depth: 0,
    color: params.color ?? "#148515",
    plan: params.plan,
    prs: {},
    width_stroke: params.widthStroke ?? 1,
    type_stroke: params.typeStroke ?? "solid",
    level_layer: 7,
  };
  if (params.fill) rec.fill = params.fill;
  const m = (model.free_figures ??= {}) as Record<string, FreeFigureEntity>;
  m[rec.id as string] = rec;
  return rec;
}

/** Метки DE/TL/FL — нумерация по полному списку коллекции. */
function numbered<M extends { id: string }>(src: Record<string, M> | undefined, label: string, ref: string): M {
  const list = Object.values(src ?? {});
  const idx = list.findIndex((v) => v.id === ref);
  if (idx < 0) throw new McpError("NOT_FOUND", `${label} ${ref} не найден`);
  return list[idx]!;
}

export function resolveFigure(model: Model, ref: string): FreeFigureEntity {
  if (ref.startsWith("DE")) {
    const n = Number(ref.slice(2));
    return numbered(model.free_figures, "фигура", Object.values(model.free_figures ?? {})[n - 1]?.id ?? ref);
  }
  return numbered(model.free_figures, "фигура", ref);
}

export function resolveLine(model: Model, coll: "freelines" | "thick_lines", ref: string): GraphDrawRec {
  const label = coll === "freelines" ? "линия" : "толстая линия";
  if (ref.startsWith(coll === "freelines" ? "FL" : "TL")) {
    const n = Number(ref.slice(2));
    const list = Object.values(model[coll] ?? {});
    const at = list[n - 1];
    if (!at) throw new McpError("NOT_FOUND", `${label} ${ref} не найдена`);
    return at as GraphDrawRec;
  }
  return numbered(model[coll] as Record<string, GraphDrawRec>, label, ref);
}

/** Обновление стиля/плана линии (геометрия — отдельный инструмент с вершинами). */
export function updateLine(
  model: Model,
  coll: "freelines" | "thick_lines",
  ref: string,
  params: { plan?: string; color?: string | null; widthStroke?: number; typeStroke?: string; fill?: string | null; widthMm?: number },
): GraphDrawRec {
  const rec = resolveLine(model, coll, ref);
  validateStyle({ color_custom: params.color ?? undefined, width_stroke: params.widthStroke, type_stroke: params.typeStroke });
  if (params.plan !== undefined) rec.plan = params.plan;
  if (params.color !== undefined) {
    if (params.color === null) delete rec.color_custom;
    else rec.color_custom = params.color;
  }
  if (params.widthStroke !== undefined) rec.width_stroke = params.widthStroke;
  if (params.typeStroke !== undefined) rec.type_stroke = params.typeStroke;
  if (params.fill !== undefined) {
    if (params.fill === null) delete rec.fill;
    else rec.fill = params.fill;
  }
  if (params.widthMm !== undefined) {
    const w = Math.round((params.widthMm / 10) * 100) / 100;
    for (const row of rec.matrix) {
      for (let j = 0; j < row.length; j++) {
        const cell = row[j];
        if (cell) (cell as { width?: number }).width = w;
      }
    }
    rec.on_width = 1;
  }
  return rec;
}

export function updateFigure(
  model: Model,
  ref: string,
  params: { center?: Point; widthMm?: number; heightMm?: number; angleDeg?: number; color?: string; fill?: string | null; plan?: string; widthStroke?: number; typeStroke?: string },
): Record<string, unknown> {
  const rec = resolveFigure(model, ref);
  validateStyle({ color_custom: params.color, width_stroke: params.widthStroke, type_stroke: params.typeStroke });
  if (params.center !== undefined) rec.pc = { x: Math.round(params.center.x * 100) / 100, y: Math.round(params.center.y * 100) / 100 };
  if (params.widthMm !== undefined) rec.width = Math.round((params.widthMm / 10) * 100) / 100;
  if (params.heightMm !== undefined) rec.height = Math.round((params.heightMm / 10) * 100) / 100;
  if (params.angleDeg !== undefined) {
    rec.angle = params.angleDeg;
    rec.rotated = params.angleDeg !== 0 ? 1 : 0;
  }
  if (params.color !== undefined) rec.color = params.color;
  if (params.fill !== undefined) {
    if (params.fill === null) delete rec.fill;
    else rec.fill = params.fill;
  }
  if (params.plan !== undefined) rec.plan = params.plan;
  if (params.widthStroke !== undefined) rec.width_stroke = params.widthStroke;
  if (params.typeStroke !== undefined) rec.type_stroke = params.typeStroke;
  return rec;
}

function deleteFrom(model: Model, coll: string, id: string): void {
  const m = model[coll] as Record<string, unknown> | undefined;
  if (m) delete m[id];
}

export function deleteLine(model: Model, coll: "freelines" | "thick_lines", ref: string): void {
  const rec = resolveLine(model, coll, ref);
  deleteFrom(model, coll, rec.id);
}

export function deleteFigure(model: Model, ref: string): void {
  const rec = resolveFigure(model, ref);
  deleteFrom(model, "free_figures", rec.id);
}
