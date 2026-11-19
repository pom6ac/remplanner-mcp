import type { Model, LedStrip, StripLight, LineStrip, LightStripVertex, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { McpError } from "../errors.ts";
import { assignCandidate } from "./assign.ts";
import { dist } from "./geometry.ts";
import { gasLineLengthM } from "./pipes.ts";
import { cablesReferencingLine, refreshCablesForLine } from "./electric.ts";

/**
 * Световые линии листа «Освещение» (этап 84, 2026-11-17): светодиодные ленты
 * (model.led_strips, LedStrip), трековые шины (model.stripes_light, StripLight —
 * recessed_strip/surface_stripe/pendent_strip) и линейное освещение
 * (model.line_strips, LineStrip). Графы того же формата GraphLines, что
 * pipes_gas/pipes (классы в бандле app.3.0, serialize — см. types.ts). Вершины —
 * только узлы (source_items вида {node:1}; трековые споты на шине — отдельная
 * связь spots, этап 84 её не пишет). Длина — в метрах по рёбрам matrix
 * (gasLineLengthM), округление редактора до 2 знаков. Все три вида — PRO в UI;
 * запись в модель сервер не гейтит (тарифный гейт — F2-03, как у труб).
 */

/** Допустимое расхождение длины (м) при сверке после save — общий с газовыми линиями. */
export const LIGHT_LENGTH_TOL_M = 0.02;

/** Вид световой линии: led (лента), recessed/surface/pendent (шины), line (линейный свет). */
export type LightKind = "led" | "recessed" | "surface" | "pendent" | "line";

export const LIGHT_TYPE_BY_KIND: Record<LightKind, string> = {
  led: "led_strip",
  recessed: "recessed_strip",
  surface: "surface_stripe",
  pendent: "pendent_strip",
  line: "line_light",
};

/** Коллекция модели по виду (сообщение об ошибке называет коллекцию редактора). */
export const LIGHT_COLLECTION_BY_KIND: Record<LightKind, "led_strips" | "stripes_light" | "line_strips"> = {
  led: "led_strips",
  recessed: "stripes_light",
  surface: "stripes_light",
  pendent: "stripes_light",
  line: "line_strips",
};

/** Имя коллекции/класса редактора для подсказок в ошибках item_add. */
export const LIGHT_KIND_BY_TOOL: Record<string, LightKind> = {
  led_strip: "led",
  recessed_strip: "recessed",
  surface_stripe: "surface",
  pendent_strip: "pendent",
  line_light: "line",
};

/** Трековые споты на шине (подключение spots — вне рамок этапа 84, см. отчёт). */
export const TRACK_SPOT_TOOLS = new Set([
  "track_spot", "track_pendent_spot", "track_panel_spot", "track_line_spot",
]);

/** Лимит точек пути (ревью 79 №7: матрица квадратична; у ленты достаточно). */
export const MAX_LIGHT_PATH_NODES = 32;

function finitePoint(name: string, p: MmPoint): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new McpError("INVALID_ARGUMENT", `${name}: координаты должны быть конечными числами`);
  }
}

function cmPoint(pt: MmPoint): Point {
  return { x: r2(mmToCm(pt.x)), y: r2(mmToCm(pt.y)) };
}

function validateArgs(kind: LightKind, path: { x: number; y: number }[]): void {
  if (!LIGHT_TYPE_BY_KIND[kind]) {
    throw new McpError("INVALID_ARGUMENT", `неизвестный вид световой линии «${String(kind)}»`);
  }
  if (!Array.isArray(path) || path.length < 2) {
    throw new McpError("INVALID_ARGUMENT", "путь световой линии должен содержать минимум 2 точки");
  }
  if (path.length > MAX_LIGHT_PATH_NODES) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `путь световой линии слишком длинный: ${path.length} точек (лимит ${MAX_LIGHT_PATH_NODES})`,
    );
  }
  for (const p of path) finitePoint("точка пути", p);
  for (let i = 1; i < path.length; i++) {
    if (dist(path[i - 1]!, path[i]!) < 1e-6) {
      throw new McpError("INVALID_ARGUMENT", "в пути световой линии подряд идут одинаковые точки");
    }
  }
}

function lightCandidate(id: string, kind: LightKind, points: Point[]): LedStrip | StripLight | LineStrip {
  const vertexes: LightStripVertex[] = points.map((p) => ({
    id: `_${newId(5)}`,
    point: { ...p },
    type: "node",
    id_room: "",
  }));
  const n = vertexes.length;
  const matrix: ({ length: number } | null)[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
  for (let i = 0; i + 1 < n; i++) {
    matrix[i]![i + 1] = { length: 1 };
    matrix[i + 1]![i] = { length: 1 };
  }
  const items: Record<string, string> = {};
  for (const v of vertexes) items[v.id] = "node";
  const props = { id, name: LIGHT_TYPE_BY_KIND[kind] };
  const length = gasLineLengthM({ vertexes, matrix });
  if (kind === "led") {
    return { id, matrix, vertexes, items, type: "led_strip", length, props, on_size: 1 };
  }
  if (kind === "line") {
    return { id, matrix, vertexes, items, type: "line_light", length, props, on_size: 1, plan: "light", prs: {} };
  }
  // трековые шины: у pendent_strip умолчание высоты опускания 20 (класс StripLight)
  const strip: StripLight = {
    id, matrix, vertexes, items, type: LIGHT_TYPE_BY_KIND[kind], length, props, on_size: 1,
    spots: {}, line_spots: [],
  };
  if (kind === "pendent") strip.height_lowering = 20;
  return strip;
}

/** Полная длина световой линии по рёбрам matrix, м (gasLineLengthM уже округляет до 2 знаков). */
export function lightLengthM(line: Pick<LedStrip, "vertexes" | "matrix">): number {
  return gasLineLengthM(line);
}

function collectionOf(model: Model, kind: LightKind): Record<string, LedStrip> {
  const key = LIGHT_COLLECTION_BY_KIND[kind];
  return (model[key] ?? {}) as Record<string, LedStrip>;
}

/**
 * <light>_add: световая линия по цепочке узлов (мм); соседние элементы пути
 * соединяются ребром. Кандидат-копия до записи; при ошибке модель не меняется.
 */
export function addLightLine(
  model: Model,
  params: { kind: LightKind; path: MmPoint[] },
): LedStrip | StripLight | LineStrip {
  const kind = params.kind;
  const path = params.path ?? [];
  validateArgs(kind, path);
  const candidate = lightCandidate(newId(10), kind, path.map(cmPoint));
  const key = LIGHT_COLLECTION_BY_KIND[kind];
  const had = model[key] !== undefined;
  const backup = had ? structuredClone(model[key]) : undefined;
  (model as Record<string, unknown>)[key] ??= {};
  const coll = model[key] as Record<string, LedStrip>;
  try {
    coll[candidate.id] = candidate;
  } catch (e) {
    if (backup) (model as Record<string, unknown>)[key] = backup;
    else delete (model as Record<string, unknown>)[key];
    throw e;
  }
  return candidate;
}

/**
 * Световые споты на шине (spots/line_spots) — связи этапа 84 не поддержаны
 * (ревью 85 №2/№3): редактор при нормализации пересчитывает точки спота за шиной
 * (StripLight.drawLineSpotsByLine), поэтому перенос такой шины MCP-моделью дал бы
 * ложную блокировку save. Пока связи отложены — операции над шиной со спотами
 * атомарно отвергаются.
 */
export function hasLightSpots(line: unknown): boolean {
  const l = line as { spots?: Record<string, unknown>; line_spots?: unknown[] } | null;
  return Boolean(l && ((l.spots && Object.keys(l.spots).length > 0) || (Array.isArray(l.line_spots) && l.line_spots.length > 0)));
}

/**
 * <light>_update: перенос узлов графа — positions [{vertex, x_mm, y_mm}] (0-based).
 * Кандидат-копия; при ошибке модель не меняется; длина пересчитывается по рёбрам.
 * Все вершины — узлы (у световых линий вершин-предметов нет).
 */
export function updateLightLine(
  model: Model,
  params: { kind: LightKind; lineId: string; positions?: { vertex: number; x: number; y: number }[] },
): LedStrip | StripLight | LineStrip {
  const kind = params.kind;
  const line = collectionOf(model, kind)[params.lineId];
  if (!line) {
    throw new McpError("NOT_FOUND", `световая линия ${params.lineId} не найдена в ${LIGHT_COLLECTION_BY_KIND[kind]}`);
  }
  if (hasLightSpots(line)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `шина ${params.lineId} содержит световые споты (spots/line_spots) — их перенос MCP пока не поддерживает: спот на шине пересчитывается редактором; измените шину в редакторе или удалите споты`,
    );
  }
  const positions = params.positions ?? [];
  if (positions.length === 0) return line;
  for (const p of positions) {
    if (!Number.isInteger(p.vertex) || p.vertex < 0 || p.vertex >= line.vertexes.length) {
      throw new McpError("INVALID_ARGUMENT", `vertex ${String(p.vertex)}: индекс вне диапазона 0..${line.vertexes.length - 1}`);
    }
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new McpError("INVALID_ARGUMENT", "координаты узла световой линии должны быть конечными числами");
    }
  }
  const candidate = structuredClone(line);
  for (const p of positions) {
    candidate.vertexes[p.vertex] = { ...candidate.vertexes[p.vertex]!, point: cmPoint({ x: p.x, y: p.y }) };
  }
  candidate.length = lightLengthM(candidate);
  assignCandidate(line, candidate);
  // часть 2: вершины связей «выключатель → линия» следуют за вершинами линии
  refreshCablesForLine(model, params.lineId);
  return line;
}

/**
 * Световые споты, связанные с шиной (ревью 85 №3): прямая сторона — ключи spots,
 * обратная — предметы с strip_light_id = id шины. Удаление шины со спотами
 * оставило бы висячую ссылку в items (или молча лишило спот шины) — каскад
 * не реализован, пока связи отложены, операция атомарно отвергается.
 */
function linkedSpotIds(model: Model, lineId: string): string[] {
  const items = model.items ?? {};
  const out = Object.keys(items).filter((iid) => (items[iid] as { strip_light_id?: unknown } | undefined)?.strip_light_id === lineId);
  return out;
}

/** <light>_delete. */
export function deleteLightLine(model: Model, kind: LightKind, lineId: string): void {
  const key = LIGHT_COLLECTION_BY_KIND[kind];
  const coll = model[key];
  if (!coll?.[lineId]) {
    throw new McpError("NOT_FOUND", `световая линия ${lineId} не найдена в ${key}`);
  }
  // часть 2: связь «выключатель → линия» держит обратную ссылку на линии
  // (props.cables) — удаление оставило бы висячую ссылку
  const linkedCables = cablesReferencingLine(model, lineId);
  if (linkedCables.length > 0) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `линия ${lineId} подключена к связи «выключатель → светильник» (${linkedCables.map((c) => c.id).join(", ")}) — сначала удалите связь cable_delete`,
      { details: { kind: "cable_referenced", cables: linkedCables.map((c) => c.id) } },
    );
  }
  if (key === "stripes_light") {
    const backRefs = linkedSpotIds(model, lineId);
    if (hasLightSpots(coll[lineId]) || backRefs.length > 0) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `шина ${lineId} содержит световые споты (spots/line_spots${backRefs.length > 0 ? `, обратные ссылки предметов: ${backRefs.join(", ")}` : ""}) — удаление оставило бы висячую ссылку; MCP пока не поддерживает управление спотами на шине: удалите споты в редакторе или используйте project_clear`,
      );
    }
  }
  delete coll[lineId];
}
