import type { Model, GasLine, GasLineVertex, Point, Pipe, ItemProps } from "./types.ts";
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

// ---------- Трубы водоснабжения/канализации (model.pipes, этап 78) ----------

/**
 * Трубы листа «Водоснабжение» — графы того же формата GraphLines, что pipes_gas
 * (класс Pipe, бандл app.3.0): serialize = {id, matrix, vertexes, items, type, length},
 * plan в модель не пишется (план «water» — рантайм-поле конструктора Pipe).
 * kind: water (Труба ХВС → water_pipe), hot (Труба ГВС → water_hot_pipe),
 * drainage (Канализация → drainage_pipe). PRO-инструменты в UI — запись в модель
 * не гейтится сервером; тарифный гейт MCP не вводился (вне рамок этапа, F2-03).
 */
export type PipeKind = "water" | "hot" | "drainage";

export const PIPE_TYPE_BY_KIND: Record<PipeKind, "water_pipe" | "water_hot_pipe" | "drainage_pipe"> = {
  water: "water_pipe",
  hot: "water_hot_pipe",
  drainage: "drainage_pipe",
};

/** Обратная ссылка предмета: props.pipes[`${type}_id`] = id трубы (multi — массив). */
export function pipeLinkKey(pipeType: string): string {
  return `${pipeType}_id`;
}

/**
 * Какие предметы подключаются к трубе (класс Piping редактора, бандл app.3.0,
 * source_items/waterspots): у water_pipe — холодные выводы, коллектор, стояк water,
 * ввод ceiling_water, стояк water_column_cold; у water_hot_pipe — горячие аналоги;
 * у drainage_pipe — канализационные выводы, стояк water, канализационный стояк
 * drainage_column. Комбинированные выводы (drainage_cold_hot и т.п.) подключаются
 * к нескольким трубам сразу (multi-подключение у массива props.pipes).
 * Узлы графа (type "node") — не предметы, допустимы в любой трубе.
 */
export const PIPE_CONNECTABLE: Record<PipeKind, Set<string>> = {
  water: new Set([
    "waterspot_cold", "waterspot_cold_hot", "waterspot_drainage_cold", "waterspot_drainage_cold_hot",
    "waterspot_collector", "water", "ceiling_water", "water_column_cold",
  ]),
  hot: new Set([
    "waterspot_hot", "waterspot_cold_hot", "waterspot_drainage_hot", "waterspot_drainage_cold_hot",
    "waterspot_collector", "water", "ceiling_water", "water_column_hot",
  ]),
  drainage: new Set([
    "waterspot_drainage", "waterspot_drainage_cold", "waterspot_drainage_hot", "waterspot_drainage_cold_hot",
    "water", "drainage_column",
  ]),
};

/** multi-предметы (is_multi, Piping.multi_spots): props.pipes хранит МАССИВ id труб. */
export const PIPE_MULTI_SPOTS = new Set(["waterspot_collector", "water_column_cold", "water_column_hot"]);

/** Тип вершины трубы по имени предмета (Pipe.getTypeItem: node/ceiling_water/multi/waterspot). */
export function pipeVertexType(itemName: string): string {
  if (itemName === "ceiling_water") return "ceiling_water";
  if (PIPE_MULTI_SPOTS.has(itemName)) return "multi";
  return "waterspot";
}

export type PipePathElement = { x: number; y: number } | { itemId: string };

/** Проверка аргументов трубы (до любых мутаций): конечные числа, путь ≥ 2 точек. */
function validatePipePath(path: PipePathElement[]): void {
  if (!Array.isArray(path) || path.length < 2) {
    throw new McpError("INVALID_ARGUMENT", "путь трубы должен содержать минимум 2 точки (узлы и/или предметы)");
  }
  for (const el of path) {
    if ("x" in el) {
      if (!Number.isFinite(el.x) || !Number.isFinite(el.y)) {
        throw new McpError("INVALID_ARGUMENT", "координаты узла трубы должны быть конечными числами");
      }
    } else if (typeof el.itemId !== "string" || el.itemId === "") {
      throw new McpError("INVALID_ARGUMENT", "элемент пути трубы: ожидается {x, y} (мм) или {item_id}");
    }
  }
}

/** Тип вершины и точка предмета-вывода с проверкой подключаемости к трубе. */
function itemVertex(model: Model, kind: PipeKind, itemId: string): GasLineVertex {
  const item = model.items?.[itemId] as ItemProps | undefined;
  if (!item) throw new McpError("NOT_FOUND", `предмет ${itemId} не найден`);
  if (!PIPE_CONNECTABLE[kind].has(item.name)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `предмет «${item.name}» не подключается к трубе «${PIPE_TYPE_BY_KIND[kind]}» (в редакторе у этой трубы другие выводы)`,
      { details: { kind: "not_connectable", item: item.name, pipe: PIPE_TYPE_BY_KIND[kind] } },
    );
  }
  return { id: item.id, point: { ...item.pc }, type: pipeVertexType(item.name) };
}

/** Карта обратных ссылок items → pipes для трубы (запись). */
function linkItems(model: Model, pipe: Pipe, kind: PipeKind): void {
  const key = pipeLinkKey(PIPE_TYPE_BY_KIND[kind]);
  for (const v of pipe.vertexes) {
    if (v.type === "node") continue;
    const item = model.items[v.id] as (ItemProps & { pipes?: Record<string, unknown> }) | undefined;
    if (!item) continue;
    item.pipes ??= {};
    if (PIPE_MULTI_SPOTS.has(item.name)) {
      const arr = Array.isArray(item.pipes[key]) ? (item.pipes[key] as string[]) : [];
      if (!arr.includes(pipe.id)) arr.push(pipe.id);
      item.pipes[key] = arr;
    } else {
      item.pipes[key] = pipe.id;
    }
  }
}

/** Снять обратные ссылки items для трубы (удаление/переподключение). */
export function unlinkItems(model: Model, pipe: Pipe): void {
  const key = pipeLinkKey(pipe.type);
  for (const v of pipe.vertexes) {
    if (v.type === "node") continue;
    const item = model.items[v.id] as (ItemProps & { pipes?: Record<string, unknown> }) | undefined;
    if (!item?.pipes) continue;
    const cur = item.pipes[key];
    if (Array.isArray(cur)) {
      const arr = cur.filter((x) => x !== pipe.id);
      if (arr.length > 0) item.pipes[key] = arr;
      else delete item.pipes[key];
    } else if (cur === pipe.id) {
      delete item.pipes[key];
    }
  }
}

/** Вершины трубы в цепочку: последовательные дубли запрещены. */
function chainVertices(model: Model, kind: PipeKind, path: PipePathElement[]): GasLineVertex[] {
  const out: GasLineVertex[] = [];
  let prev = "";
  for (const el of path) {
    const v = "x" in el
      ? { id: `_${newId(5)}`, point: cmPoint({ x: el.x, y: el.y }), type: "node" as const }
      : itemVertex(model, kind, el.itemId);
    const sig = v.type === "node" ? `p:${v.point.x},${v.point.y}` : `i:${v.id}`;
    if (sig === prev) {
      throw new McpError("INVALID_ARGUMENT", "в пути трубы подряд идут одинаковые точки (узел-дубликат или предмет дважды)");
    }
    prev = sig;
    out.push(v);
  }
  return out;
}

function pipeCandidate(id: string, kind: PipeKind, vertexes: GasLineVertex[]): Pipe {
  const n = vertexes.length;
  const matrix: ({ length: number } | null)[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
  for (let i = 0; i + 1 < n; i++) {
    matrix[i]![i + 1] = { length: 1 };
    matrix[i + 1]![i] = { length: 1 };
  }
  const items: Record<string, string> = {};
  for (const v of vertexes) items[v.id] = v.type;
  return {
    id,
    matrix,
    vertexes,
    items,
    type: PIPE_TYPE_BY_KIND[kind],
    length: gasLineLengthM({ vertexes, matrix }),
  };
}

/**
 * pipe_add: труба по пути из узлов ({x, y}, мм) и предметов ({item_id}: выводы воды,
 * стояки, ввод водоснабжения — см. PIPE_CONNECTABLE). Цепочка: соседние элементы
 * пути соединяются ребром. Коллекция model.pipes; у предметов-вершин ставится
 * обратная ссылка props.pipes[`${type}_id`]. Кандидат-копия до записи; при ошибке
 * модель не меняется.
 */
export function addPipe(model: Model, params: { kind: PipeKind; path: PipePathElement[] }): Pipe {
  const kind = params.kind;
  if (!PIPE_TYPE_BY_KIND[kind]) {
    throw new McpError("INVALID_ARGUMENT", `неизвестный вид трубы «${String(kind)}» (water | hot | drainage)`);
  }
  const vertexes = chainVertices(model, kind, params.path ?? []);
  const candidate = pipeCandidate(newId(10), kind, vertexes);
  const had = model.pipes !== undefined;
  const backupPipes = had ? structuredClone(model.pipes) : undefined;
  const backupItems = structuredClone(model.items);
  model.pipes ??= {};
  try {
    model.pipes[candidate.id] = candidate;
    linkItems(model, candidate, kind);
  } catch (e) {
    if (backupPipes) model.pipes = backupPipes;
    else delete model.pipes;
    model.items = backupItems;
    throw e;
  }
  return candidate;
}

/**
 * pipe_update: перенос узлов графа (только вершины type "node"; вершины-предметы
 * следуют за своими предметами — item_update пересчитывает их транзитивно).
 * positions — список {vertex, x_mm, y_mm} (vertex — индекс в vertexes, 0-based).
 * Кандидат-копия; при ошибке модель не меняется; длина пересчитывается по рёбрам.
 */
export function updatePipe(
  model: Model,
  params: { pipeId: string; positions?: { vertex: number; x: number; y: number }[] },
): Pipe {
  const pipe = model.pipes?.[params.pipeId];
  if (!pipe) throw new McpError("NOT_FOUND", `труба ${params.pipeId} не найдена`);
  const positions = params.positions ?? [];
  if (positions.length === 0) return pipe;
  for (const p of positions) {
    if (!Number.isInteger(p.vertex) || p.vertex < 0 || p.vertex >= pipe.vertexes.length) {
      throw new McpError("INVALID_ARGUMENT", `vertex ${String(p.vertex)}: индекс вне диапазона 0..${pipe.vertexes.length - 1}`);
    }
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new McpError("INVALID_ARGUMENT", "координаты узла трубы должны быть конечными числами");
    }
  }
  const candidate = structuredClone(pipe);
  for (const p of positions) {
    const v = candidate.vertexes[p.vertex]!;
    if (v.type !== "node") {
      throw new McpError(
        "INVALID_ARGUMENT",
        `вершина ${p.vertex} — предмет (${v.type}): она следует за предметом; переместите его item_update`,
      );
    }
    v.point = cmPoint({ x: p.x, y: p.y });
  }
  candidate.length = gasLineLengthM(candidate);
  assignGasLine(pipe as unknown as GasLine, candidate as unknown as GasLine);
  return pipe;
}

/** Ссылается ли какая-нибудь труба на предмет (вершина или items). */
export function pipesReferencingItem(model: Model, itemId: string): Pipe[] {
  const out: Pipe[] = [];
  for (const pipe of Object.values(model.pipes ?? {})) {
    if (pipe.vertexes.some((v) => v.id === itemId)) out.push(pipe);
  }
  return out;
}

/**
 * pipe_delete: труба удаляется, обратные ссылки props.pipes у её предметов снимаются.
 * Сам предмет (вывод воды, стояк) не удаляется — item_delete отклоняет предметы,
 * подключённые к трубам (сначала pipe_delete, затем item_delete).
 */
export function deletePipe(model: Model, pipeId: string): void {
  const pipe = model.pipes?.[pipeId];
  if (!pipe) throw new McpError("NOT_FOUND", `труба ${pipeId} не найдена`);
  unlinkItems(model, pipe);
  delete model.pipes![pipeId];
}

/** Пересчитать вершины-предметы трубы после переноса предмета (транзитивный пересчёт). */
export function refreshPipeForItem(model: Model, itemId: string, itemPc: Point): void {
  for (const pipe of Object.values(model.pipes ?? {})) {
    let changed = false;
    for (const v of pipe.vertexes) {
      if (v.id === itemId && v.type !== "node") {
        v.point = { ...itemPc };
        changed = true;
      }
    }
    if (changed) pipe.length = gasLineLengthM(pipe);
  }
}
