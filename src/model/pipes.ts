import type { Model, GasLine, GasLineVertex, Point, Pipe, ItemProps } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { McpError } from "../errors.ts";
import { assignCandidate } from "./assign.ts";
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

/**
 * Трубы других разделов (этап 122, вынесены из этапа 78): магистрали тёплого пола
 * (лист «Тёплые полы» → warm_floor_pipe, model.pipes_warm_floor), дренаж кондиционеров
 * (лист «Кондиционеры» → conditioner_drainage, model.pipes_conditioner), магистрали
 * отопления (лист «Радиаторы» → heat_pipe_hot/heat_pipe_cold, model.pipes_heat),
 * воздуховоды (лист «Вентиляция» → ventpipe_out/ventpipe_in, model.pipes_ventilation —
 * у них дописывается spots {}). Формат — тот же граф GraphLines (пробы 122-dev-*:
 * serialize без plan, длина в метрах по рёбрам). Все виды — PRO-инструменты UI.
 * Подключения предметов (климат ч.2, этап 250, пробы 250-connect*): вершина-предмет —
 * {id: item.id, point: pc, type по классу линии PipeHeat/PipeConditioner/PipeWarnFloor/
 * PipeVentilation (waterspot/multi/collector/warm_floor)}, обратная ссылка —
 * props.<коллекция>.<ключ> (name_object_lines менеджера = имя коллекции;
 * у водоснабжения box «pipes»), ключи — names_line_id_by_tool (см.
 * PIPE_LINK_KEY_BY_TYPE). У магистралей тёплого пола вершина может быть водяным
 * контуром (warm_floor_water, model.warm_floors): point = polygon[0], type
 * "warm_floor", обратная ссылка в props контура. pp редактора ({i, d} — точка
 * подключения на габарите предмета, проба 250-connect-heat) не воспроизводится:
 * правило выбора грани зависит от точки захвата мышью при рисовании.
 */

export type ClimatePipeKind = "warm_floor" | "conditioner_drainage" | "heat_hot" | "heat_cold" | "vent_out" | "vent_in";

/** Новые виды: kind → тип линии и коллекция модели. */
export const CLIMATE_PIPE_KINDS: Record<ClimatePipeKind, { type: string; coll: string }> = {
  warm_floor: { type: "warm_floor_pipe", coll: "pipes_warm_floor" },
  conditioner_drainage: { type: "conditioner_drainage", coll: "pipes_conditioner" },
  heat_hot: { type: "heat_pipe_hot", coll: "pipes_heat" },
  heat_cold: { type: "heat_pipe_cold", coll: "pipes_heat" },
  vent_out: { type: "ventpipe_out", coll: "pipes_ventilation" },
  vent_in: { type: "ventpipe_in", coll: "pipes_ventilation" },
};

/**
 * Ключ обратной ссылки предмета по типу трубы — names_line_id_by_tool менеджеров
 * редактора (бандл app.3.0, пробы 250-connect*): у водоснабжения props.pipes,
 * у климата props.<коллекция>. Отсутствующий тип — прежнее правило `${type}_id`.
 */
export const PIPE_LINK_KEY_BY_TYPE: Record<string, string> = {
  water_pipe: "water_pipe_id",
  water_hot_pipe: "water_hot_pipe_id",
  drainage_pipe: "drainage_pipe_id",
  heat_pipe_hot: "heat_pipe_hot_id",
  heat_pipe_cold: "heat_pipe_cold_id",
  conditioner_drainage: "drainage_pipe_id",
  warm_floor_pipe: "pipe_warm_floor_id",
  ventpipe_out: "ventpipe_out_id",
  ventpipe_in: "ventpipe_in_id",
};

/** Ключ обратной ссылки предмета на трубу (water_pipe_id, drainage_pipe_id, …). */
export function pipeLinkKey(pipeType: string): string {
  return PIPE_LINK_KEY_BY_TYPE[pipeType] ?? `${pipeType}_id`;
}

/** Имя бокса обратных ссылок предмета для коллекции труб (props.<box>): у
 *  водоснабжения — «pipes», у климата — имя коллекции (name_object_lines). */
export function pipeLinkBoxOfColl(coll: string): string {
  return coll === "pipes" ? "pipes" : coll;
}

/** Коллекции-боксы обратных ссылок труб в props предмета (для сверок). */
export const PIPE_LINK_BOXES = ["pipes", "pipes_heat", "pipes_conditioner", "pipes_warm_floor", "pipes_ventilation"] as const;

/**
 * Подключаемые предметы труб климата — source_items менеджеров (бандл app.3.0,
 * пробы 250-connect*): у магистралей отопления — радиаторы и конвекторы
 * (radiator_*), коллекторные узлы (multi), старый радиатор; у дренажа — блоки
 * кондиционеров и канализационные выводы/стояки; у магистралей тёплого пола —
 * коллекторные узлы (multi) и сам водяной контур (warm_floor_water,
 * model.warm_floors); у воздуховодов — вентиляторы, установки, клапаны.
 */
export const CLIMATE_PIPE_CONNECTABLE: Record<ClimatePipeKind, Set<string>> = {
  warm_floor: new Set(["radiator_collector", "ext_manifold_box", "int_manifold_box", "warm_floor_water"]),
  conditioner_drainage: new Set([
    "conditioner", "floor_conditioner", "duct_indoor_block", "cassette_indoor_block", "breezer",
    "water", "drainage_column", "waterspot_drainage", "waterspot_drainage_cold",
    "waterspot_drainage_hot", "waterspot_drainage_cold_hot", "waterspot_collector",
  ]),
  heat_hot: new Set([
    "radiator_bimetal", "radiator_steel", "radiator_iron", "radiator_tubular_vert", "radiator_tubular_horizontal",
    "vertical_radiator", "floor_convector", "convector_on_floor", "radiator_collector", "ext_manifold_box",
    "int_manifold_box", "radiator_old",
  ]),
  heat_cold: new Set([
    "radiator_bimetal", "radiator_steel", "radiator_iron", "radiator_tubular_vert", "radiator_tubular_horizontal",
    "vertical_radiator", "floor_convector", "convector_on_floor", "radiator_collector", "ext_manifold_box",
    "int_manifold_box", "radiator_old",
  ]),
  vent_out: new Set(["air", "duct_indoor_block", "inflow_valve", "ventilation_system", "fan", "fan_wall", "ventHole"]),
  vent_in: new Set(["air", "duct_indoor_block", "inflow_valve", "ventilation_system", "fan", "fan_wall", "ventHole"]),
};

/** multi-предметы труб климата (is_multi менеджеров): ссылка-МАССИВ id труб. */
export const CLIMATE_PIPE_MULTI_NAMES = new Set(["radiator_collector", "ext_manifold_box", "int_manifold_box", "ventilation_system"]);

/**
 * Сечение рёбер матрицы воздуховодов (ревью 251 №2): редактор пишет в каждое
 * ребро сечение из defs.ventilation_pipe — {length, width: 20.4, type "flat",
 * height: 6} (эталон ui-ref-climate2-vent-pipe-fan, проба 250-climate2-connect).
 * MCP воспроизводит формат, чтобы воздуховод из MCP не отличался от нарисованного
 * в UI и потеря сечения у воздуховода редактора ловилась сверкой.
 */
export const VENT_PIPE_EDGE_SECTION = { width: 20.4, type: "flat", height: 6 } as const;

/** Все multi-предметы труб (вода + климат): массив vs скаляр в props. */
export function isMultiPipeItem(itemName: string): boolean {
  return PIPE_MULTI_SPOTS.has(itemName) || CLIMATE_PIPE_MULTI_NAMES.has(itemName);
}

/** Тип вершины трубы климата по классу линии редактора (getTypeItem):
 *  warm_floor_pipe — "collector" у коллекторных узлов, "warm_floor" у контура,
 *  иначе "waterspot"; heat/vent — multi-предмет "multi", иначе "waterspot";
 *  дренаж — всегда "waterspot". */
export function climatePipeVertexType(kind: ClimatePipeKind, itemName: string): string {
  if (kind === "warm_floor") {
    if (itemName === "warm_floor_water") return "warm_floor";
    if (CLIMATE_PIPE_MULTI_NAMES.has(itemName)) return "collector";
    return "waterspot";
  }
  if (kind === "conditioner_drainage") return "waterspot";
  return CLIMATE_PIPE_MULTI_NAMES.has(itemName) ? "multi" : "waterspot";
}

/** Все коллекции-графы труб (порядок = порядок меток в компактном API). */
export const PIPE_COLLECTIONS = ["pipes", "pipes_warm_floor", "pipes_conditioner", "pipes_heat", "pipes_ventilation"] as const;

export type PipeCollKey = (typeof PIPE_COLLECTIONS)[number];

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
  assignCandidate(line, candidate);
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

/**
 * Лимит точек пути трубы (ревью 79 №7): матрица смежности квадратична по числу
 * вершин, а у U-образных водяных труб может быть до 5 сегментов — 32 точки
 * с запасом, ограничение проверяется до аллокации матрицы (и в zod-схеме).
 */
export const MAX_PIPE_PATH_NODES = 32;

/** Проверка аргументов трубы (до любых мутаций): конечные числа, путь ≥ 2 точек,
 *  лимит размера (ревью 79 №7), предмет не повторяется в пути (ревью 79 №2). */
function validatePipePath(path: PipePathElement[]): void {
  if (!Array.isArray(path) || path.length < 2) {
    throw new McpError("INVALID_ARGUMENT", "путь трубы должен содержать минимум 2 точки (узлы и/или предметы)");
  }
  if (path.length > MAX_PIPE_PATH_NODES) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `путь трубы слишком длинный: ${path.length} точек (лимит ${MAX_PIPE_PATH_NODES})`,
    );
  }
  const seenItems = new Set<string>();
  for (const el of path) {
    if ("x" in el) {
      if (!Number.isFinite(el.x) || !Number.isFinite(el.y)) {
        throw new McpError("INVALID_ARGUMENT", "координаты узла трубы должны быть конечными числами");
      }
    } else {
      if (typeof el.itemId !== "string" || el.itemId === "") {
        throw new McpError("INVALID_ARGUMENT", "элемент пути трубы: ожидается {x, y} (мм) или {item_id}");
      }
      if (seenItems.has(el.itemId)) {
        throw new McpError(
          "INVALID_ARGUMENT",
          `предмет ${el.itemId} встречается в пути трубы дважды — у вершины-предмета одно подключение`,
        );
      }
      seenItems.add(el.itemId);
    }
  }
}

/** Тип вершины и точка предмета-вывода с проверкой подключаемости к трубе. */
function itemVertex(model: Model, kind: PipeKind | ClimatePipeKind, itemId: string): GasLineVertex {
  const isClimate = kind in CLIMATE_PIPE_KINDS;
  // водяной контур тёплого пола — вершина магистрали warm_floor_pipe (проба
  // 250-connect3-wfpipe): id контура, point = polygon[0], type "warm_floor"
  if (!isClimate || kind !== "warm_floor") {
    // обычный предмет ниже
  } else {
    const wf = model.warm_floors?.[itemId];
    if (wf) {
      if (wf.type !== "warm_floor_water") {
        throw new McpError(
          "INVALID_ARGUMENT",
          `контур ${wf.id} (${wf.type}) не подключается к магистрали тёплого пола — в редакторе к ней подключается только водяной контур`,
          { details: { kind: "not_connectable", item: wf.type, pipe: "warm_floor_pipe" } },
        );
      }
      const p0 = wf.polygon[0] ?? { x: 0, y: 0 };
      return { id: wf.id, point: { ...p0 }, type: "warm_floor" };
    }
  }
  const item = model.items?.[itemId] as ItemProps | undefined;
  if (!item) throw new McpError("NOT_FOUND", `предмет ${itemId} не найден`);
  // «Узел» waterspot_node — маркер, не вершина (живая проба 360-ws-live-recon):
  // труба, нарисованная до узла в редакторе, приходит обычной вершиной type "node"
  // в точке предмета; предмет не хранит обратной ссылки и вершина за ним не следует
  if (item.name === "waterspot_node") {
    return { id: `_${newId(5)}`, point: { ...item.pc }, type: "node" };
  }
  const connectable = isClimate ? CLIMATE_PIPE_CONNECTABLE[kind as ClimatePipeKind]! : PIPE_CONNECTABLE[kind as PipeKind]!;
  if (!connectable.has(item.name)) {
    const pipeType = isClimate
      ? CLIMATE_PIPE_KINDS[kind as ClimatePipeKind]!.type
      : PIPE_TYPE_BY_KIND[kind as PipeKind]!;
    throw new McpError(
      "INVALID_ARGUMENT",
      `предмет «${item.name}» не подключается к трубе «${pipeType}» (в редакторе у этой трубы другие выводы)`,
      { details: { kind: "not_connectable", item: item.name, pipe: pipeType } },
    );
  }
  return {
    id: item.id,
    point: { ...item.pc },
    type: isClimate ? climatePipeVertexType(kind as ClimatePipeKind, item.name) : pipeVertexType(item.name),
  };
}

/** Холдер обратных ссылок вершины-предмета: предмет или водяной контур (props). */
type PipeLinkHolder = { box: Record<string, unknown>; multi: boolean };

function linkHolderOf(model: Model, vertex: GasLineVertex, coll: string): PipeLinkHolder | null {
  const box = pipeLinkBoxOfColl(coll);
  if (vertex.type === "warm_floor") {
    const wf = model.warm_floors?.[vertex.id];
    if (!wf) return null;
    const props = (wf.props ??= { id: wf.id, name: wf.type });
    props[box] ??= {};
    return { box: props[box] as Record<string, unknown>, multi: false };
  }
  const item = model.items[vertex.id] as (ItemProps & Record<string, unknown>) | undefined;
  if (!item) return null;
  item[box] ??= {};
  return { box: item[box] as Record<string, unknown>, multi: isMultiPipeItem(item.name) };
}

/** Записать обратные ссылки вершины-предметов трубы (props.<box>[ключ]). */
function linkItems(model: Model, pipe: Pipe, kind: PipeKind | ClimatePipeKind, coll: string): void {
  const key = pipeLinkKey(pipe.type);
  for (const v of pipe.vertexes) {
    if (v.type === "node") continue;
    const holder = linkHolderOf(model, v, coll);
    if (!holder) continue;
    if (holder.multi) {
      const arr = Array.isArray(holder.box[key]) ? (holder.box[key] as string[]) : [];
      if (!arr.includes(pipe.id)) arr.push(pipe.id);
      holder.box[key] = arr;
    } else {
      holder.box[key] = pipe.id;
    }
  }
}

/** Снять обратные ссылки вершины-предметов трубы (удаление/переподключение). */
export function unlinkItems(model: Model, pipe: Pipe, coll: string): void {
  const key = pipeLinkKey(pipe.type);
  const box = pipeLinkBoxOfColl(coll);
  for (const v of pipe.vertexes) {
    if (v.type === "node") continue;
    if (v.type === "warm_floor") {
      const wf = model.warm_floors?.[v.id];
      const propsBox = wf?.props?.[box] as Record<string, unknown> | undefined;
      if (propsBox && propsBox[key] === pipe.id) delete propsBox[key];
      continue;
    }
    const item = model.items[v.id] as (ItemProps & Record<string, unknown>) | undefined;
    if (!item) continue;
    const cur = (item[box] as Record<string, unknown> | undefined)?.[key];
    if (Array.isArray(cur)) {
      const arr = cur.filter((x) => x !== pipe.id);
      if (arr.length > 0) (item[box] as Record<string, unknown>)[key] = arr;
      else delete (item[box] as Record<string, unknown>)[key];
    } else if (cur === pipe.id) {
      delete (item[box] as Record<string, unknown>)[key];
    }
  }
}

/** Вершины трубы в цепочку: дубликаты предметов запрещены во всём пути (ревью 79 №2),
 *  соседние дубли узлов/точек — тоже. */
function chainVertices(model: Model, kind: PipeKind | ClimatePipeKind, path: PipePathElement[]): GasLineVertex[] {
  const out: GasLineVertex[] = [];
  const seenItems = new Set<string>();
  let prev = "";
  for (const el of path) {
    const v = "x" in el
      ? { id: `_${newId(5)}`, point: cmPoint({ x: el.x, y: el.y }), type: "node" as const }
      : itemVertex(model, kind, el.itemId);
    if (v.type !== "node") {
      if (seenItems.has(v.id)) {
        throw new McpError(
          "INVALID_ARGUMENT",
          `предмет ${v.id} встречается в пути трубы дважды — у вершины-предмета одно подключение`,
        );
      }
      seenItems.add(v.id);
    }
    const sig = v.type === "node" ? `p:${v.point.x},${v.point.y}` : `i:${v.id}`;
    if (sig === prev) {
      throw new McpError("INVALID_ARGUMENT", "в пути трубы подряд идут одинаковые точки (узел-дубликат или предмет дважды)");
    }
    prev = sig;
    out.push(v);
  }
  return out;
}

function pipeCandidate(id: string, kind: PipeKind | ClimatePipeKind, vertexes: GasLineVertex[]): Pipe {
  const n = vertexes.length;
  const isClimate = kind in CLIMATE_PIPE_KINDS;
  const type = isClimate
    ? CLIMATE_PIPE_KINDS[kind as ClimatePipeKind]!.type
    : PIPE_TYPE_BY_KIND[kind as PipeKind]!;
  // ревью 251 №2: у воздуховодов ребро несёт сечение из defs.ventilation_pipe
  const edge: { length: number } & Record<string, unknown> = type === "ventpipe_out" || type === "ventpipe_in"
    ? { length: 1, ...VENT_PIPE_EDGE_SECTION }
    : { length: 1 };
  const matrix: ({ length: number } | null)[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
  for (let i = 0; i + 1 < n; i++) {
    matrix[i]![i + 1] = { ...edge };
    matrix[i + 1]![i] = { ...edge };
  }
  const items: Record<string, string> = {};
  for (const v of vertexes) items[v.id] = v.type;
  const pipe: Pipe = {
    id,
    matrix,
    vertexes,
    items,
    type: type as Pipe["type"],
    length: gasLineLengthM({ vertexes, matrix }),
  };
  // воздуховоды: редактор пишет spots {} (эталон 122-dev-vent-*)
  if (type === "ventpipe_out" || type === "ventpipe_in") pipe.spots = {};
  return pipe;
}

/** Коллекция модели для вида трубы; неизвестный вид — INVALID_ARGUMENT. */
export function pipeCollOfKind(kind: string): PipeCollKey {
  if (kind in PIPE_TYPE_BY_KIND) return "pipes";
  const c = CLIMATE_PIPE_KINDS[kind as ClimatePipeKind];
  if (c) return c.coll as PipeCollKey;
  throw new McpError(
    "INVALID_ARGUMENT",
    `неизвестный вид трубы «${String(kind)}» (water | hot | drainage | warm_floor | conditioner_drainage | heat_hot | heat_cold | vent_out | vent_in)`,
  );
}

export function pipeColl(model: Model, coll: PipeCollKey): Record<string, Pipe> {
  return (model[coll] ?? {}) as Record<string, Pipe>;
}

/** Найти трубу по id во всех коллекциях-графах труб. */
export function findPipe(model: Model, pipeId: string): { coll: PipeCollKey; pipe: Pipe } | null {
  for (const coll of PIPE_COLLECTIONS) {
    const pipe = (model[coll] as Record<string, Pipe> | undefined)?.[pipeId];
    if (pipe) return { coll, pipe };
  }
  return null;
}

/**
 * Скалярное подключение занято? (ревью 79 №1): у обычного (не multi) вывода
 * props.<box>[ключ] — одна труба. Вторая труба того же вида не может
 * подключиться: обратная ссылка перезаписалась бы, а старая труба осталась бы
 * подключённой без ссылки. У водяного контура (warm_floor) ссылка тоже скалярная.
 * Проверка до любых мутаций.
 */
function assertScalarSlotsFree(model: Model, kind: PipeKind | ClimatePipeKind, coll: string, vertexes: GasLineVertex[]): void {
  const isClimate = kind in CLIMATE_PIPE_KINDS;
  const key = pipeLinkKey(isClimate ? CLIMATE_PIPE_KINDS[kind as ClimatePipeKind]!.type : PIPE_TYPE_BY_KIND[kind as PipeKind]!);
  const box = pipeLinkBoxOfColl(coll);
  for (const v of vertexes) {
    if (v.type === "node") continue;
    if (v.type === "warm_floor") {
      const wf = model.warm_floors?.[v.id];
      const cur = (wf?.props?.[box] as Record<string, unknown> | undefined)?.[key];
      if (typeof cur === "string" && cur !== "") {
        throw new McpError(
          "INVALID_ARGUMENT",
          `водяной контур ${v.id} уже подключён к магистрали ${cur} — у контура одно подключение; сначала удалите её (pipe_delete)`,
          { details: { kind: "already_connected", item: v.id, pipe: cur } },
        );
      }
      continue;
    }
    const item = model.items[v.id] as (ItemProps & Record<string, unknown>) | undefined;
    if (!item || isMultiPipeItem(item.name)) continue;
    const cur = (item[box] as Record<string, unknown> | undefined)?.[key];
    if (typeof cur === "string" && cur !== "") {
      throw new McpError(
        "INVALID_ARGUMENT",
        `предмет «${item.name}» (${v.id}) уже подключён к трубе ${cur} этого вида — у обычного вывода одно подключение; сначала отключите его (pipe_delete) или подключите к multi-предмету (коллектор, стояк)`,
        { details: { kind: "already_connected", item: v.id, pipe: cur } },
      );
    }
  }
}

/**
 * pipe_add: труба по пути из узлов ({x, y}, мм) и предметов ({item_id}: выводы воды,
 * стояки, ввод водоснабжения — PIPE_CONNECTABLE; радиаторы/конвекторы у магистралей
 * отопления, блоки кондиционеров у дренажа, коллекторные узлы и водяной контур
 * ({item_id: "<id контура>"}) у магистралей тёплого пола, вентиляторы и установки
 * у воздуховодов — CLIMATE_PIPE_CONNECTABLE). Виды: water/hot/drainage
 * (коллекция model.pipes, box props.pipes) и climate-виды (свои коллекции
 * CLIMATE_PIPE_KINDS, box props.<коллекция>). Цепочка: соседние элементы пути
 * соединяются ребром. У вершин-предметов ставится обратная ссылка
 * props.<box>[ключ вида]; повторное скалярное подключение того же вида
 * отклоняется (ревью 79 №1). Кандидат-копия до записи; при ошибке модель не меняется.
 */
export function addPipe(model: Model, params: { kind: PipeKind | ClimatePipeKind; path: PipePathElement[] }): Pipe {
  const kind = params.kind;
  const coll = pipeCollOfKind(kind);
  validatePipePath(params.path ?? []);
  const vertexes = chainVertices(model, kind, params.path ?? []);
  assertScalarSlotsFree(model, kind, coll, vertexes);
  const candidate = pipeCandidate(newId(10), kind, vertexes);
  const had = model[coll] !== undefined;
  const backupPipes = had ? structuredClone(model[coll]) : undefined;
  const backupItems = structuredClone(model.items);
  const backupWarmFloors = structuredClone(model.warm_floors);
  (model as Record<string, unknown>)[coll] ??= {};
  try {
    (model[coll] as Record<string, Pipe>)[candidate.id] = candidate;
    linkItems(model, candidate, kind, coll);
  } catch (e) {
    if (backupPipes) (model as Record<string, unknown>)[coll] = backupPipes;
    else delete (model as Record<string, unknown>)[coll];
    model.items = backupItems;
    if (backupWarmFloors !== undefined || model.warm_floors !== undefined) {
      if (backupWarmFloors) model.warm_floors = backupWarmFloors;
      else delete model.warm_floors;
    }
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
  const found = findPipe(model, params.pipeId);
  if (!found) throw new McpError("NOT_FOUND", `труба ${params.pipeId} не найдена`);
  const pipe = found.pipe;
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
  assignCandidate(pipe as unknown as GasLine, candidate as unknown as GasLine);
  return pipe;
}

/** Ссылается ли какая-нибудь труба (любая коллекция) на предмет (вершина или items). */
export function pipesReferencingItem(model: Model, itemId: string): Pipe[] {
  const out: Pipe[] = [];
  for (const coll of PIPE_COLLECTIONS) {
    for (const pipe of Object.values(pipeColl(model, coll))) {
      if (pipe.vertexes.some((v) => v.id === itemId)) out.push(pipe);
    }
  }
  return out;
}

/**
 * Держатели обратных ссылок труб для сверки: предметы (props.<box>) плюс водяные
 * контуры тёплого пола (вершина-контур магистрали: name = type контура, боксы —
 * из props контура). Проекция для pipeConnectionMismatches.
 */
export function pipeLinkHolders(model: Model): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, item] of Object.entries(model.items ?? {})) {
    out[id] = item as Record<string, unknown>;
  }
  for (const wf of Object.values(model.warm_floors ?? {})) {
    out[wf.id] = { ...(wf.props ?? {}), name: wf.type };
  }
  return out;
}

/**
 * pipe_delete: труба удаляется (из своей коллекции), обратные ссылки
 * props.<box> у её предметов/контура снимаются. Сам предмет (вывод воды, стояк,
 * радиатор) не удаляется — item_delete отклоняет предметы, подключённые к трубам
 * (pipe_delete для трубы снимается каскадом item_delete сам: ревью 364 №6).
 */
export function deletePipe(model: Model, pipeId: string): void {
  const found = findPipe(model, pipeId);
  if (!found) throw new McpError("NOT_FOUND", `труба ${pipeId} не найдена`);
  unlinkItems(model, found.pipe, found.coll);
  const coll = found.coll as string;
  delete (model[coll] as Record<string, Pipe>)[pipeId];
}

/** Пересчитать вершины-предметы труб (все коллекции) после переноса предмета. */
export function refreshPipeForItem(model: Model, itemId: string, itemPc: Point): void {
  for (const coll of PIPE_COLLECTIONS) {
    for (const pipe of Object.values(pipeColl(model, coll))) {
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
}

/**
 * Пересчитать вершины-контуры магистралей тёплого пола после переноса водяного
 * контура (warm_floor_update): point вершины = новый polygon[0] контура, длина
 * пересчитывается по рёбрам. Вызывается из updateWarmFloor только при реальном
 * изменении угла (пересчёт только затронутых привязок).
 */
export function refreshPipesForWarmFloor(model: Model, warmFloorId: string, polygon0: Point): boolean {
  let any = false;
  for (const pipe of Object.values(pipeColl(model, "pipes_warm_floor"))) {
    let changed = false;
    for (const v of pipe.vertexes) {
      if (v.id === warmFloorId && v.type === "warm_floor") {
        v.point = { ...polygon0 };
        changed = true;
      }
    }
    if (changed) {
      pipe.length = gasLineLengthM(pipe);
      any = true;
    }
  }
  return any;
}
