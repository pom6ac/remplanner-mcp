import type { Model, Point, Pipe } from "./types.ts";
import { newId } from "./types.ts";
import { McpError } from "../errors.ts";
import { assignCandidate } from "./assign.ts";
import { gasLineLengthM, unlinkItems, PIPE_COLLECTIONS, pipeColl, type PipeCollKey } from "./pipes.ts";

/**
 * Группы выводов воды (этап 360): класс GroupWaterSpots бандла app.3.0 — механика
 * «поставить вывод на вывод» и контекстного меню «Убрать …» комбинированных точек
 * воды (лист «Водоснабжение»). Обработчики бандла перенесены по правилу урока
 * new-entity-section §49: поведение одного пути не переносится на соседний —
 * merge (клик инструмента на цель), unset (меню) и каскад труб (deleteByItem)
 * разведаны отдельно (отчёт 360 §1.1–1.3).
 *
 * Merge: существующий вывод ПЕРЕИМЕНОВЫВАЕТСЯ в комбинированный (id сохраняется —
 * вершины труб продолжают ссылаться на предмет), габариты — из каталога результата.
 * over_floor правится только у пристенного вывода (freeAndWallIsWall ≈ id_wall в
 * модели MCP) и результате из composite_items: цель-«вода» получает value_2=40
 * (умолчание канализации), цель-канализация — value_2=value, value=50. Результат
 * waterspot_cold_hot (не composite) и свободные выводы over_floor не меняют.
 *
 * Unset: переименование по structure_items; over_floor — только у composite и
 * пристенного: результат-канализация забирает value=value_2, результат-вода
 * сохраняет value; value_2 удаляется. Снимаемая часть удаляет подключённую трубу
 * своего вида как в редакторе (props.pipes.<вид>_id → deleteByItem, п. ниже).
 *
 * Сдвиг pc иконки на 3 см (LIB.pointOnLine(bp, projection, 3)) не воспроизводится:
 * зависит от производных projection/bp, которых в модели MCP нет (редактор
 * восстанавливает их при draw). change_sequence (0↔1) — производный косметический
 * флаг отрисовки, редактор дописывает 1 сам при init.
 */

/** Выводы с водой (водяная группа $PipingWater.water_items). */
export const WS_WATER_ITEMS = new Set(["waterspot_cold", "waterspot_hot", "waterspot_cold_hot"]);

/** Канализационные выводы ($PipingWater.drainage_items). */
export const WS_DRAINAGE_ITEMS = new Set([
  "waterspot_drainage", "waterspot_drainage_cold", "waterspot_drainage_hot", "waterspot_drainage_cold_hot",
]);

/** Все 7 точек воды (water_drainage_items) — им редактор дописывает change_sequence. */
export const WS_ALL_SPOTS = new Set([...WS_WATER_ITEMS, ...WS_DRAINAGE_ITEMS]);

/** Комбинированные с канализацией ($PipingWater.composite_items; cold_hot НЕ composite). */
export const WS_COMPOSITE_ITEMS = new Set([
  "waterspot_drainage_cold", "waterspot_drainage_hot", "waterspot_drainage_cold_hot",
]);

/** Одиночные выводы — инструменты, которыми в редакторе делается merge (все PRO). */
export const WS_SINGLE_SPOTS = new Set(["waterspot_cold", "waterspot_hot", "waterspot_drainage"]);

/** Обратная ссылка вывода на трубу по снимаемой части (bандл unset_item). */
export const WS_PART_PIPE_KEY: Record<string, "water_pipe_id" | "water_hot_pipe_id" | "drainage_pipe_id"> = {
  waterspot_cold: "water_pipe_id",
  waterspot_hot: "water_hot_pipe_id",
  waterspot_drainage: "drainage_pipe_id",
};

/**
 * source_items GroupWaterSpots: инструмент (part) → имя цели → комбинированный результат.
 * Целью может быть и комбинированный вывод (cold → drainage_hot → drainage_cold_hot).
 */
export const WS_MERGE_RESULT: Record<string, Record<string, string>> = {
  waterspot_cold: {
    waterspot_hot: "waterspot_cold_hot",
    waterspot_drainage: "waterspot_drainage_cold",
    waterspot_drainage_hot: "waterspot_drainage_cold_hot",
  },
  waterspot_hot: {
    waterspot_cold: "waterspot_cold_hot",
    waterspot_drainage_cold: "waterspot_drainage_cold_hot",
    waterspot_drainage: "waterspot_drainage_hot",
  },
  waterspot_drainage: {
    waterspot_hot: "waterspot_drainage_hot",
    waterspot_cold: "waterspot_drainage_cold",
    waterspot_cold_hot: "waterspot_drainage_cold_hot",
  },
  waterspot_cold_hot: { waterspot_drainage: "waterspot_drainage_cold_hot" },
  waterspot_drainage_cold: { waterspot_hot: "waterspot_drainage_cold_hot" },
  waterspot_drainage_hot: { waterspot_cold: "waterspot_drainage_cold_hot" },
};

/** structure_items GroupWaterSpots: комбинированный → снимаемая часть → результат. */
export const WS_UNSET_RESULT: Record<string, Record<string, string>> = {
  waterspot_drainage_cold_hot: {
    waterspot_hot: "waterspot_drainage_cold",
    waterspot_cold: "waterspot_drainage_hot",
    waterspot_drainage: "waterspot_cold_hot",
  },
  waterspot_drainage_hot: { waterspot_hot: "waterspot_drainage", waterspot_drainage: "waterspot_hot" },
  waterspot_drainage_cold: { waterspot_cold: "waterspot_drainage", waterspot_drainage: "waterspot_cold" },
  waterspot_cold_hot: { waterspot_cold: "waterspot_hot", waterspot_hot: "waterspot_cold" },
};

type OverFloor = { value: number; display: boolean; value_2?: number; vd?: number } | null;

/** Результат объединения (pure, для серверного слоя до apply): null — пара недопустима. */
export function waterSpotMergeResult(part: string, itemName: string): string | null {
  return WS_MERGE_RESULT[part]?.[itemName] ?? null;
}

/** Канонический отказ merge (один текст у серверного слоя и модельного). */
export function waterSpotMergeError(part: string, itemName: string): McpError {
  return new McpError(
    "INVALID_ARGUMENT",
    `вывод «${itemName}» не объединяется с «${part}» — в редакторе у этой пары нет комбинированного результата (GroupWaterSpots.source_items)`,
    { details: { kind: "not_mergeable", item: itemName, part } },
  );
}

/** Результат разделения (pure): null — у комбинированного нет такой снимаемой части. */
export function waterSpotUnsetResult(itemName: string, part: string): string | null {
  return WS_UNSET_RESULT[itemName]?.[part] ?? null;
}

/** Канонический отказ unset (один текст у серверного слоя и модельного). */
export function waterSpotUnsetError(itemName: string, part: string): McpError {
  return new McpError(
    "INVALID_ARGUMENT",
    `у вывода «${itemName}» нет снимаемой части «${part}» — в редакторе контекстное меню «Убрать» этого сочетания не содержит (GroupWaterSpots.structure_items)`,
    { details: { kind: "not_unsettable", item: itemName, part } },
  );
}

/** Пристенный ли вывод (бандл freeAndWallIsWall: projection + привязка к грани). */
function isWallAttached(props: { id_wall?: string | null; id_pillar?: string | null }): boolean {
  return Boolean(props.id_wall || props.id_pillar);
}

/**
 * waterspot_merge: объединение выводов «как в редакторе» (клик инструмента part на
 * существующий вывод). widthCm/heightCm — габариты результата из каталога (.ToolEntry).
 * Кандидат-копия; при ошибке модель не меняется. Возвращает переименованный предмет.
 */
export function mergeWaterSpot(
  model: Model,
  params: { itemId: string; part: string; widthCm: number; heightCm: number },
): { item: Model["items"][string]; result: string } {
  const item = model.items?.[params.itemId];
  if (!item) throw new McpError("NOT_FOUND", `предмет ${params.itemId} не найден`);
  const result = waterSpotMergeResult(params.part, item.name);
  if (!result) throw waterSpotMergeError(params.part, item.name);
  const candidate = structuredClone(item) as typeof item;
  candidate.name = result;
  const of = candidate.over_floor as OverFloor;
  if (
    WS_COMPOSITE_ITEMS.has(result) && !WS_COMPOSITE_ITEMS.has(item.name) && isWallAttached(candidate)
  ) {
    if (WS_WATER_ITEMS.has(item.name)) {
      const base = (of ?? { value: 50, display: false }) as { value: number; display: boolean; value_2?: number };
      candidate.over_floor = { ...base, value_2: 40 };
    } else {
      const base = (of ?? { value: 50, display: false }) as { value: number; display: boolean; value_2?: number };
      candidate.over_floor = { value_2: base.value, value: 50, display: base.display };
    }
  }
  candidate.width = params.widthCm;
  candidate.height = params.heightCm;
  assignCandidate(item, candidate);
  return { item, result };
}

/**
 * waterspot_unset: разделение комбинированного вывода (контекстное меню «Убрать …»).
 * Каскад труб — как в редакторе: снимаемая часть теряет подключённую трубу своего
 * вида (props.pipes.<вид>_id), труба переезжает по deleteByItem (removePipeVertex).
 * widthCm/heightCm — габариты результата из каталога.
 */
export function unsetWaterSpot(
  model: Model,
  params: { itemId: string; part: string; widthCm: number; heightCm: number },
): { item: Model["items"][string]; result: string; pipes: { deleted: string[]; created: string[] } } {
  const item = model.items?.[params.itemId];
  if (!item) throw new McpError("NOT_FOUND", `предмет ${params.itemId} не найден`);
  const result = waterSpotUnsetResult(item.name, params.part);
  if (!result) throw waterSpotUnsetError(item.name, params.part);
  // каскад трубы снимаемой части — до переименования (ссылка props.pipes ещё жива)
  const key = WS_PART_PIPE_KEY[params.part];
  const pipes = { deleted: [] as string[], created: [] as string[] };
  const pipeId = (item as Record<string, unknown>)["pipes"] as Record<string, unknown> | undefined;
  const linked = key && typeof pipeId?.[key] === "string" ? (pipeId[key] as string) : undefined;
  if (linked) {
    const res = removePipeVertex(model, linked, params.itemId);
    pipes.deleted.push(...res.deleted);
    pipes.created.push(...res.created);
  }
  const candidate = structuredClone(item) as typeof item;
  candidate.name = result;
  const of = candidate.over_floor as OverFloor;
  if (WS_COMPOSITE_ITEMS.has(item.name) && isWallAttached(candidate) && of && typeof of === "object") {
    if (!WS_WATER_ITEMS.has(result) && of.value_2 !== undefined) {
      candidate.over_floor = { value: of.value_2, display: of.display };
    } else if (WS_WATER_ITEMS.has(result)) {
      candidate.over_floor = { value: of.value, display: of.display };
    }
  }
  candidate.width = params.widthCm;
  candidate.height = params.heightCm;
  assignCandidate(item, candidate);
  return { item, result, pipes };
}

// ---------- Удаление вершины трубы (GraphLines.deleteByItem, бандл 272301) ----------

export type PipeVertexRemoval = { deleted: string[]; created: string[]; removed: boolean };

/** Компоненты связности оставшихся вершин графа (индексы в исходном vertexes). */
function componentsOf(matrix: (unknown | null)[][], indices: number[]): number[][] {
  const set = new Set(indices);
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const start of indices) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const i = queue.shift()!;
      comp.push(i);
      for (const j of indices) {
        if (!seen.has(j) && matrix[i]![j] !== null && matrix[i]![j] !== undefined && set.has(j)) {
          seen.add(j);
          queue.push(j);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * Удаление вершины трубы (узла или предмета) как в редакторе (deleteByItem):
 * труба из 2 вершин удаляется целиком; иначе рёбра вершины вычищаются и граф
 * распадается — один связный кусок остаётся той же трубой (без вершины), несколько
 * кусков ≥2 вершин становятся НОВЫМИ трубами (новый id, тот же type, длина по
 * рёбрам), одиночные вершины-предметы теряют обратную ссылку, узлы исчезают;
 * пустой граф — труба удаляется. Обратные ссылки снимаются/переписываются как у
 * редактора (unsetFromItems/set_tree_id). Работает по всем коллекциям-графам труб.
 */
export function removePipeVertex(model: Model, pipeId: string, vertexId: string): PipeVertexRemoval {
  const found = findPipeAny(model, pipeId);
  if (!found) throw new McpError("NOT_FOUND", `труба ${pipeId} не найдена`);
  const { coll, pipe } = found;
  const n = pipe.vertexes.findIndex((v) => v.id === vertexId);
  if (n === -1) {
    throw new McpError("NOT_FOUND", `вершина ${vertexId} не найдена в трубе ${pipeId}`);
  }
  const deleted: string[] = [];
  const created: string[] = [];
  const removeWhole = (): void => {
    unlinkItems(model, pipe, coll);
    delete (model[coll] as Record<string, Pipe>)[pipeId];
    deleted.push(pipeId);
  };
  if (pipe.vertexes.length === 2) {
    removeWhole();
    return { deleted, created, removed: true };
  }
  // копия графа без вершины n: матрица с вычищенными рёбрами
  const matrix = pipe.matrix.map((row, i) => row.map((cell, j) => (i === n || j === n ? null : cell)));
  const rest = pipe.vertexes.map((_, i) => i).filter((i) => i !== n);
  const comps = componentsOf(matrix, rest);
  const linked = comps.filter((c) => c.length >= 2);
  if (linked.length === 0) {
    // рёбер не осталось (одиночки или пусто) — труба удаляется целиком
    removeWhole();
    return { deleted, created, removed: true };
  }
  if (comps.length === 1 && comps[0]!.length === rest.length) {
    // один связный кусок на все оставшиеся вершины — та же труба без вершины
    const candidate = structuredClone(pipe);
    candidate.vertexes = candidate.vertexes.filter((_, i) => i !== n);
    candidate.matrix = candidate.matrix
      .filter((_, i) => i !== n)
      .map((row) => row.filter((_, j) => j !== n));
    delete candidate.items[vertexId];
    candidate.length = gasLineLengthM(candidate);
    assignCandidate(pipe, candidate);
    return { deleted, created, removed: true };
  }
  // граф распался: исходная труба удаляется, куски ≥2 вершин — новые трубы
  unlinkItems(model, pipe, coll);
  delete (model[coll] as Record<string, Pipe>)[pipeId];
  deleted.push(pipeId);
  for (const comp of linked) {
    const vertexes = comp.map((i) => structuredClone(pipe.vertexes[i]!));
    const size = comp.length;
    const m: (null | { length: number })[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => null));
    for (let a = 0; a < size; a++) {
      for (let b = 0; b < size; b++) {
        const cell = pipe.matrix[comp[a]!]![comp[b]!];
        if (cell) m[a]![b] = { ...cell };
      }
    }
    const items: Record<string, string> = {};
    for (const v of vertexes) items[v.id] = v.type;
    const fresh: Pipe = {
      id: newId(10),
      matrix: m,
      vertexes,
      items,
      type: pipe.type,
      length: gasLineLengthM({ vertexes, matrix: m }),
    };
    (model[coll] as Record<string, Pipe>)[fresh.id] = fresh;
    relinkPipe(model, fresh, coll);
    created.push(fresh.id);
  }
  for (const comp of comps.filter((c) => c.length === 1)) {
    const v = pipe.vertexes[comp[0]!]!;
    if (v.type !== "node") unlinkVertexRef(model, v.id, coll, pipeLinkKeyOf(pipe.type));
  }
  return { deleted, created, removed: true };
}

function findPipeAny(model: Model, pipeId: string): { coll: PipeCollKey; pipe: Pipe } | null {
  for (const coll of PIPE_COLLECTIONS) {
    const pipe = pipeColl(model, coll)[pipeId];
    if (pipe) return { coll, pipe };
  }
  return null;
}

function pipeLinkKeyOf(pipeType: string): string {
  // ключ обратной ссылки (PIPE_LINK_KEY_BY_TYPE не импортируется, чтобы не
  // расширять цикл: формат `${type}_id` покрывает все виды труб)
  return `${pipeType}_id`;
}

/** Записать обратные ссылки вершины-предметов новой трубы (после split). */
function relinkPipe(model: Model, pipe: Pipe, coll: PipeCollKey): void {
  const key = pipeLinkKeyOf(pipe.type);
  const box = coll === "pipes" ? "pipes" : coll;
  for (const v of pipe.vertexes) {
    if (v.type === "node") continue;
    const item = model.items?.[v.id] as (Record<string, unknown> & { name?: string }) | undefined;
    if (!item) continue;
    const holder = (item[box] ??= {}) as Record<string, unknown>;
    if (isMultiName(item.name)) {
      const arr = Array.isArray(holder[key]) ? (holder[key] as string[]) : [];
      if (!arr.includes(pipe.id)) arr.push(pipe.id);
      holder[key] = arr;
    } else {
      holder[key] = pipe.id;
    }
  }
}

/** Снять обратную ссылку одной вершины-предмета (одиночка после split). */
function unlinkVertexRef(model: Model, itemId: string, coll: PipeCollKey, key: string): void {
  const box = coll === "pipes" ? "pipes" : coll;
  const item = model.items?.[itemId] as (Record<string, unknown> & { name?: string }) | undefined;
  if (!item) return;
  const holder = item[box] as Record<string, unknown> | undefined;
  if (!holder) return;
  const cur = holder[key];
  if (Array.isArray(cur)) {
    // multi-массив не чистится по одиночке: ссылка на удалённую трубу снята
    // unlinkItems при удалении исходной трубы
    return;
  }
  delete holder[key];
}

function isMultiName(name: string | undefined): boolean {
  return name === "waterspot_collector" || name === "water_column_cold" || name === "water_column_hot"
    || name === "radiator_collector" || name === "ext_manifold_box" || name === "int_manifold_box"
    || name === "ventilation_system";
}

/** Точка предмета в см модели (для тестов и сверок). */
export function itemPointCm(item: { pc: Point }): Point {
  return { ...item.pc };
}
