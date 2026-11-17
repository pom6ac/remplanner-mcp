import { z } from "zod";
import { McpError } from "../errors.ts";
import {
  MAX_IMPORT_WALLS,
  MAX_IMPORT_ENTITIES,
  MAX_IMPORT_GRAPH_NODES,
  MAX_IMPORT_HOLES_PER_WALL,
  MAX_IMPORT_JSON_DEPTH,
  MODEL_COORD_LIMIT_CM,
  MODEL_SIZE_LIMIT_CM,
} from "../limits.ts";

/**
 * B5 (аудит 65): Zod-схема модели/конверта .plan для project_import_plan.
 * Раньше JSON приводился к Model через TS-cast — walls: "bad" уходил в модель.
 * Схема проверяет: коллекции — словари правильного типа, конечные числа и
 * разумные диапазоны координат/размеров, лимиты числа сущностей. Неизвестные
 * поля редактора СОХРАНЯЮТСЯ (looseObject = passthrough), а не удаляются молча.
 * Диапазоны заданы с запасом против реальных планов (значения — src/limits.ts).
 */

const cmCoord = z.number().finite().min(-MODEL_COORD_LIMIT_CM).max(MODEL_COORD_LIMIT_CM);
const cmSize = z.number().finite().min(0).max(MODEL_SIZE_LIMIT_CM);
const idStr = z.string().max(128);
const shortStr = z.string().max(64);
const nameStr = z.string().max(256);

const point = z.looseObject({ x: cmCoord, y: cmCoord });

const wallLink = z.looseObject({
  ct: shortStr,
  ot: shortStr,
  id: idStr,
  z0: shortStr,
  z1: shortStr,
  pos: shortStr.optional(),
});

// Ревью 170 №1: у ригеля своя связь конца — RigelLink {ot, id, z1} из
// src/model/types.ts (эталон ui-ref-rigel-wall.json: ot wall/pillar/rigel,
// id и сторона грани z1; ct/z0/pos ригель не пишет).
const rigelLink = z.looseObject({
  ot: shortStr,
  id: idStr,
  z1: shortStr,
});

const wallNode = z.looseObject({
  x: cmCoord,
  y: cmCoord,
  // link: связь конца или 0 (нет связи) — 0 встречается у ригелей (RigelEndpoint)
  link: z.union([wallLink, z.literal(0)]).optional(),
});

const rigelNode = z.looseObject({
  x: cmCoord,
  y: cmCoord,
  // связь конца ригеля (RigelLink) или 0 (RigelEndpoint, ui-ref-rigel-*)
  link: z.union([rigelLink, z.literal(0)]).optional(),
});

const hole = z.looseObject({
  id: idStr,
  plan: idStr.optional(),
  type: shortStr.optional(),
  group: shortStr.optional(),
  pc: point,
  width: cmSize.optional(),
  height: cmSize.optional(),
  depth: cmSize.optional(),
  p1: point.optional(),
  p2: point.optional(),
});

const wall = z.looseObject({
  id: idStr,
  plan: idStr.optional(),
  role: shortStr.optional(),
  depth: cmSize,
  // Ревью 170 №2: ограждение террасы (role terrace_fence) и прочие ограждения
  // редактора рисуются без height (эталон ui-ref-terrace-fence.json) — optional.
  height: cmSize.optional(),
  p1: wallNode,
  p2: wallNode,
  holes: collection(hole, MAX_IMPORT_HOLES_PER_WALL).optional(),
});

const item = z.looseObject({
  id: idStr,
  name: nameStr,
  pc: point,
  angle: z.number().finite().optional(),
  width: cmSize,
  height: cmSize,
  plan: z.record(z.string(), z.number().finite()).optional(),
});

const pillar = z.looseObject({
  id: idStr,
  plan: idStr.optional(),
  role: shortStr.optional(),
  width: cmSize,
  height: cmSize,
  angle: z.number().finite(),
  pc: point,
  p1: point,
  p2: point,
  p3: point,
  p4: point,
});

const rigel = z.looseObject({
  id: idStr,
  p1: rigelNode,
  p2: rigelNode,
  depth: cmSize,
  height: cmSize,
  ceiling_type: shortStr.optional(),
  polygon: z.array(point).max(MAX_IMPORT_GRAPH_NODES).optional(),
});

const ruler = z.looseObject({
  id: idStr,
  p1: point.optional(),
  p2: point.optional(),
  offset: z.looseObject({ val: z.number().finite(), side: shortStr }).optional(),
  plan: idStr.optional(),
  color: z.string().max(32).optional(),
});

const comment = z.looseObject({
  id: idStr,
  pc: point.optional(),
  points: z.array(point).max(100).optional(),
  text: z.string().max(2000).optional(),
  label: shortStr.optional(),
  plan: idStr.optional(),
});

/** Графовая сущность (трубы/кабели/свет/границы/проёмы пола/тёплые полы). */
const graphEntity = z.looseObject({
  id: idStr,
  type: shortStr.optional(),
  plan: idStr.optional(),
  p1: point.optional(),
  p2: point.optional(),
  pc: point.optional(),
  polygon: z.array(point).max(MAX_IMPORT_GRAPH_NODES).optional(),
  matrix: z
    .array(z.array(z.union([z.looseObject({ length: z.number().finite().min(0).max(MODEL_SIZE_LIMIT_CM) }), z.null()])).max(MAX_IMPORT_GRAPH_NODES))
    .max(MAX_IMPORT_GRAPH_NODES)
    .optional(),
  vertexes: z
    .array(z.looseObject({ id: idStr, point: point.optional(), type: shortStr.optional() }))
    .max(MAX_IMPORT_GRAPH_NODES)
    .optional(),
  items: z.record(z.string(), shortStr).optional(),
  length: z.number().finite().min(0).max(MODEL_SIZE_LIMIT_CM).optional(),
  area: z.number().finite().min(0).max(MODEL_SIZE_LIMIT_CM).optional(),
  id_room: z.union([idStr, z.null()]).optional(),
  props: z.looseObject({ id: idStr, name: nameStr.optional() }).optional(),
});

/** Словарь сущностей с лимитом числа (limits — единственный источник значений). */
function collection(schema: z.ZodType, max: number): z.ZodType {
  return z.record(z.string(), schema).refine((r) => Object.keys(r).length <= max, {
    message: `слишком много сущностей (лимит ${max})`,
  });
}

const GRAPH_COLLECTIONS = [
  "pipes_gas",
  "pipes",
  "terrace_borders",
  "territory_borders",
  "level_holes",
  "led_strips",
  "stripes_light",
  "line_strips",
  "cables",
  "warm_floors",
  "pipes_warm_floor",
  "pipes_conditioner",
  "pipes_heat",
  "pipes_ventilation",
] as const;

function collectionsSchema(): Record<string, z.ZodType> {
  const out: Record<string, z.ZodType> = {
    // коллекции необязательны (у старых моделей могут отсутствовать), но если
    // есть — обязаны быть словарями правильного типа с лимитом числа
    walls: collection(wall, MAX_IMPORT_WALLS).optional(),
    items: collection(item, MAX_IMPORT_ENTITIES).optional(),
    pillars: collection(pillar, MAX_IMPORT_ENTITIES).optional(),
    rigels: collection(rigel, MAX_IMPORT_ENTITIES).optional(),
    rulers: collection(ruler, MAX_IMPORT_ENTITIES).optional(),
    comments: collection(comment, MAX_IMPORT_ENTITIES).optional(),
  };
  for (const key of GRAPH_COLLECTIONS) out[key] = collection(graphEntity, MAX_IMPORT_ENTITIES).optional();
  return out;
}

export const importModelSchema: z.ZodType = z.looseObject({
  v: z.number().finite().optional(),
  id: idStr.optional(),
  plan_id: idStr.optional(),
  total_height: cmSize.optional(),
  final: z.boolean().optional(),
  ...collectionsSchema(),
});

function formatPath(path: (string | number | symbol)[]): string {
  return path
    .map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`))
    .join("");
}

/**
 * Конечные числа во ВСЕХ полях (включая неизвестные редакторские, которые
 * passthrough не проверяет) и лимит вложенности. Бросает McpError с путём,
 * без содержимого файла.
 */
function assertFiniteAndDepth(value: unknown, path: string, depth: number): void {
  if (depth > MAX_IMPORT_JSON_DEPTH) {
    throw new McpError("INVALID_ARGUMENT", `модель не прошла валидацию (${path}): вложенность глубже ${MAX_IMPORT_JSON_DEPTH}`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new McpError("INVALID_ARGUMENT", `модель не прошла валидацию (${path}): число не конечное`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertFiniteAndDepth(value[i], `${path}[${i}]`, depth + 1);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      assertFiniteAndDepth(v, path ? `${path}.${k}` : k, depth + 1);
    }
  }
}

/**
 * Разобрать модель импорта: Zod-схема + проверка чисел/вложенности.
 * Ошибка — McpError INVALID_ARGUMENT с путём к полю (без содержимого файла).
 */
export function parseModelImport(value: unknown): unknown {
  const res = importModelSchema.safeParse(value);
  if (!res.success) {
    const issue = res.error.issues[0];
    const path = formatPath(["model", ...(issue?.path ?? [])]);
    throw new McpError(
      "INVALID_ARGUMENT",
      `модель не прошла валидацию (${path}): ${issue?.message ?? "неверный формат"}`,
    );
  }
  assertFiniteAndDepth(res.data, "model", 0);
  return res.data;
}
