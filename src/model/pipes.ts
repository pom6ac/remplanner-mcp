import type { Model, GasLine, GasLineVertex, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { McpError } from "../errors.ts";
import { dist } from "./geometry.ts";

/**
 * Газовая линия (пункт меню «Коммуникации» → «Газовый трубопровод», model.pipes_gas,
 * этап 57, 2026-11-16). Эталон tests/fixtures/ui-ref-comm-gas_line.json: граф из узлов
 * (vertexes, point в см), матрица смежности matrix N×N — у связной пары {length:1},
 * диагональ и несвязные пары null; items — карта id узла → "node"; type "gas_line";
 * plan "a"; length — длина трубы в метрах (сумма сегментов, округление редактора
 * до 2 знаков — 103.9 см → 1.04, 158.1 см → 1.58). Лимитов в defs редактора нет
 * (ключей gas* в defs не существует) — ограничение только конечные координаты.
 * Связи узлов с вершинами других линий (магнит при рисовании) редактор пересчитывает
 * сам при draw; MCP их не воспроизводит (как магнит лестниц к стенам, этап 53).
 */

/** Допустимое расхождение длины (м) при сверке после save. */
export const GAS_LENGTH_TOL_M = 0.02;

function finite(name: string, v: number | undefined): void {
  if (v !== undefined && !Number.isFinite(v)) {
    throw new McpError("INVALID_ARGUMENT", `${name} должен быть конечным числом`);
  }
}

/** Округление длины в метрах до 2 знаков (как в модели редактора). */
function roundM(lengthCm: number): number {
  return Math.round((lengthCm / 100) * 100) / 100;
}

function cmPoint(pt: MmPoint): Point {
  return { x: r2(mmToCm(pt.x)), y: r2(mmToCm(pt.y)) };
}

/** Проверка аргументов (до любых мутаций): конечные числа, ненулевая длина. */
function validateAxis(p1: Point, p2: Point): void {
  for (const [name, pt] of [["start", p1], ["end", p2]] as const) {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      throw new McpError("INVALID_ARGUMENT", `${name}: координаты должны быть конечными числами`);
    }
  }
  if (dist(p1, p2) < 1e-6) {
    throw new McpError("INVALID_ARGUMENT", "начало и конец газовой линии совпадают — задайте линию ненулевой длины");
  }
}

/**
 * Полная длина трубы по рёбрам matrix, м (ревью 59 №2: топология графа задаётся
 * матрицей смежности, порядок vertexes её не отражает). Сумма длин связных пар
 * узлов, округление до 2 знаков. Если матрицы нет (не должен случаться в
 * model.pipes_gas), резерв — сумма по порядку соседних вершин.
 */
export function gasLineLengthM(line: Pick<GasLine, "vertexes" | "matrix">): number {
  let cm = 0;
  const m = line.matrix;
  if (Array.isArray(m) && m.length > 0) {
    for (let i = 0; i < line.vertexes.length; i++) {
      for (let j = i + 1; j < line.vertexes.length; j++) {
        if ((m[i]?.[j] ?? null) !== null) cm += dist(line.vertexes[i]!.point, line.vertexes[j]!.point);
      }
    }
  } else {
    for (let i = 1; i < line.vertexes.length; i++) {
      cm += dist(line.vertexes[i - 1]!.point, line.vertexes[i]!.point);
    }
  }
  return roundM(cm);
}

/** Собирает линию-кандидат (без записи в модель): 2 узла, матрица 2×2, длина. */
function buildCandidate(id: string, p1: Point, p2: Point): GasLine {
  const v1: GasLineVertex = { id: `_${newId(5)}`, point: { ...p1 }, type: "node" };
  const v2: GasLineVertex = { id: `_${newId(5)}`, point: { ...p2 }, type: "node" };
  const matrix = [[null, { length: 1 }], [{ length: 1 }, null]];
  return {
    id,
    matrix,
    vertexes: [v1, v2],
    items: { [v1.id]: "node", [v2.id]: "node" },
    type: "gas_line",
    plan: "a",
    length: gasLineLengthM({ vertexes: [v1, v2], matrix }),
  };
}

/** Переносит проверенного кандидата в объект модели, сохраняя identity (паттерн assignRigel). */
function assignGasLine(target: GasLine, candidate: GasLine): void {
  const keys = new Set([...Object.keys(target), ...Object.keys(candidate)]);
  for (const k of keys) {
    if (k in candidate) (target as Record<string, unknown>)[k] = (candidate as Record<string, unknown>)[k];
    else delete (target as Record<string, unknown>)[k];
  }
}

/**
 * gas_line_add: прямая труба от start до end (мм), коллекция model.pipes_gas.
 * Кандидат-копия до записи; при ошибке модель не меняется.
 */
export function addGasLine(model: Model, params: { start: MmPoint; end: MmPoint }): GasLine {
  finite("start.x", params.start.x);
  finite("start.y", params.start.y);
  finite("end.x", params.end.x);
  finite("end.y", params.end.y);
  const p1 = cmPoint(params.start);
  const p2 = cmPoint(params.end);
  validateAxis(p1, p2);
  const candidate = buildCandidate(newId(10), p1, p2);
  const had = model.pipes_gas !== undefined;
  const backup = had ? structuredClone(model.pipes_gas) : undefined;
  model.pipes_gas ??= {};
  try {
    model.pipes_gas[candidate.id] = candidate;
  } catch (e) {
    if (backup) model.pipes_gas = backup;
    else delete model.pipes_gas;
    throw e;
  }
  return candidate;
}

/**
 * gas_line_update: перемещение концов (start/end, мм — только явно переданные),
 * пересчёт длины по рёбрам matrix (ревью 59 №2). Кандидат-копия; при ошибке
 * модель не меняется. Без start/end — но-оп (длина не пересчитывается).
 * Инструменты создают только прямые линии из 2 узлов: графы с другим числом
 * узлов (произвольная топология из редактора) update'ом не правятся —
 * INVALID_ARGUMENT до любых мутаций.
 */
export function updateGasLine(
  model: Model,
  params: { gasLineId: string; start?: MmPoint; end?: MmPoint },
): GasLine {
  const line = model.pipes_gas?.[params.gasLineId];
  if (!line) throw new McpError("NOT_FOUND", `газовая линия ${params.gasLineId} не найдена`);
  if (params.start === undefined && params.end === undefined) return line;
  if (line.vertexes.length !== 2) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `инструменты создают только прямые газовые линии из 2 узлов (у линии ${line.vertexes.length} узлов) — измените её в редакторе`,
    );
  }
  finite("start.x", params.start?.x);
  finite("start.y", params.start?.y);
  finite("end.x", params.end?.x);
  finite("end.y", params.end?.y);
  const candidate = structuredClone(line);
  if (params.start !== undefined) candidate.vertexes[0] = { ...candidate.vertexes[0]!, point: cmPoint(params.start) };
  if (params.end !== undefined) candidate.vertexes[1] = { ...candidate.vertexes[1]!, point: cmPoint(params.end) };
  validateAxis(candidate.vertexes[0]!.point, candidate.vertexes[1]!.point);
  candidate.length = gasLineLengthM(candidate);
  assignGasLine(line, candidate);
  return line;
}

/** gas_line_delete. */
export function deleteGasLine(model: Model, gasLineId: string): void {
  if (!model.pipes_gas?.[gasLineId]) throw new McpError("NOT_FOUND", `газовая линия ${gasLineId} не найдена`);
  delete model.pipes_gas[gasLineId];
}
