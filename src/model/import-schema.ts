import { z } from "zod";
import { McpError } from "../errors.ts";
import { MODEL_ENTITY_COLLECTIONS } from "./collections.ts";
import {
  MAX_IMPORT_WALLS,
  MAX_IMPORT_ENTITIES,
  MAX_IMPORT_GRAPH_NODES,
  MAX_IMPORT_HOLES_PER_WALL,
  MAX_IMPORT_JSON_DEPTH,
  MAX_SERVICE_COMMENT_CHARS,
  SHIELD_MAX_WIRES,
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

/** Порт модуля/ввода щитка (этап 255). */
const shieldPort = z.looseObject({
  id: idStr,
  parent_id: idStr.optional(),
  parent_type: shortStr.optional(),
  connected: z.number().finite().min(0).max(1).optional(),
  type: shortStr.optional(),
});

/** Провод щитка (этап 284, эталон ui-ref-shield-wires): связь портов.
 *  Ревью 285 №7: id_source/id_target/type обязательны — их требует тип ShieldWire,
 *  необязательные поля пропускали мусор, который падал позже TypeError. */
const shieldWire = z.looseObject({
  id: idStr,
  id_source: idStr,
  id_target: idStr,
  type: shortStr,
  thickness: z.number().finite().min(0).max(100).optional(),
  is_broken: z.number().finite().min(0).max(1).optional(),
});

/** Модуль на DIN-рейке щитка. */
const shieldModule = z.looseObject({
  id: idStr,
  rail_id: idStr.optional(),
  index: z.number().finite().min(0).max(MODEL_SIZE_LIMIT_CM).optional(),
  width: cmSize.optional(),
  type: shortStr.optional(),
  group_number: z.number().finite().min(0).max(9999).optional(),
  subtype: shortStr.optional(),
  comment: z.string().max(MAX_SERVICE_COMMENT_CHARS).optional(),
  ports: z.array(shieldPort).max(MAX_IMPORT_GRAPH_NODES).optional(),
});

/** Конструктор электрощитка (этап 255): рейки с модулями, вводы, шины/провода — passthrough. */
const shield = z.looseObject({
  id: idStr,
  shield_id: idStr.optional(),
  on_auto_length_rails: z.number().finite().min(0).max(1).optional(),
  length_rails: z.number().finite().min(0).max(MODEL_SIZE_LIMIT_CM).optional(),
  rails: collection(
    z.looseObject({
      id: idStr,
      index: z.number().finite().min(0).max(MODEL_SIZE_LIMIT_CM).optional(),
      modules: collection(shieldModule, MAX_IMPORT_GRAPH_NODES).optional(),
    }),
    MAX_IMPORT_GRAPH_NODES,
  ).optional(),
  // ревью 285 №7: у шины проверяются ports (массив портов) и connection (строка) —
  // раньше looseObject({id}) пропускал ports: 5, на котором падали операции с модулями.
  // Ревью 293 №3: ports и type ОБЯЗАТЕЛЬНЫ (редактор всегда их сериализует) —
  // раньше шина без них проходила импорт, и compactModel падал на b.ports.length
  // (model_get не работал), а shield_bus_update — на bus.type.startsWith.
  buses: collection(
    z.looseObject({
      id: idStr,
      type: shortStr,
      ports: z.array(shieldPort).max(MAX_IMPORT_GRAPH_NODES),
      connection: shortStr.optional(),
      distance: z.number().finite().optional(),
    }),
    MAX_IMPORT_GRAPH_NODES,
  ).optional(),
  // этап 291: коллектор — {id, rail_id, module_width, modules {moduleId: 1}, position}.
  // Ревью 293 №6: лимит импорта для шин и коллекторов одинаковый —
  // MAX_IMPORT_GRAPH_NODES (лимит импорта не ниже реалистичного: model_import
  // не должен отвергать экспорт реального щитка); SHIELD_MAX_BUSES/SHIELD_MAX_
  // COLLECTORS действуют только на add (src/model/shield.ts) — как в редакторе,
  // где лимита на число шин/коллекторов нет.
  collectors: collection(
    z.looseObject({
      id: idStr,
      rail_id: idStr.optional(),
      module_width: cmSize.optional(),
      modules: z.record(z.string(), z.number().finite().min(0).max(9999)).optional(),
      position: shortStr.optional(),
    }),
    MAX_IMPORT_GRAPH_NODES,
  ).optional(),
  inputs: collection(
    z.looseObject({
      id: idStr,
      ports: z.array(shieldPort).max(MAX_IMPORT_GRAPH_NODES).optional(),
      index: z.number().finite().min(0).max(MODEL_SIZE_LIMIT_CM).optional(),
      phase: z.number().finite().min(0).max(MODEL_SIZE_LIMIT_CM).optional(),
    }),
    MAX_IMPORT_GRAPH_NODES,
  ).optional(),
  wires: collection(shieldWire, SHIELD_MAX_WIRES).optional(),
});

/**
 * Тёплая стена (этап 273, rev 274 №11): часть WarmLine в
 * rooms2[rid].warms_walls[edge].parts. Части итерируют list/резолв/сверка,
 * поэтому число частей ограничено MAX_IMPORT_ENTITIES; line/line_wall — точки
 * в допустимом диапазоне. Неизвестные поля passthrough.
 */
const warmWallPart = z.looseObject({
  id: idStr,
  type: shortStr.optional(),
  layer: z.number().finite().optional(),
  line: z.looseObject({ p1: point, p2: point }),
  line_wall: z.looseObject({ p1: point, p2: point }).optional(),
  distance: z.number().finite().min(0).max(MODEL_SIZE_LIMIT_CM).optional(),
  height: z.number().finite().min(0).max(MODEL_SIZE_LIMIT_CM).optional(),
  height_from_floor: z.number().finite().min(0).max(MODEL_SIZE_LIMIT_CM).optional(),
  props: z.looseObject({ id: idStr, name: nameStr.optional() }).optional(),
});

const warmWallGroup = z.looseObject({
  exist: z.boolean().optional(),
  parts: collection(warmWallPart, MAX_IMPORT_ENTITIES).optional(),
});

/**
 * Потолочная закладная (этап 303, M1 ревью 304): запись rooms2[rid].rigels —
 * класс CeilingRigel редактора, формат — эталон ui-ref-zones3-ceiling-rigel.json:
 * {id, id_room?, p1/p2 (link или 0), width (см, панель редактора 10..100),
 * ceiling_type, polygon}. Части итерируют list/резолв/сверку, поэтому число
 * ограничено MAX_IMPORT_ENTITIES (лимит — src/limits.ts). Неизвестные поля
 * passthrough.
 */
const ceilingRigel = z.looseObject({
  id: idStr,
  id_room: idStr.optional(),
  p1: rigelNode,
  p2: rigelNode,
  width: z.number().finite().min(10).max(100),
  ceiling_type: shortStr.optional(),
  polygon: z.array(point).max(MAX_IMPORT_GRAPH_NODES).optional(),
});

const room2 = z.looseObject({
  warms_walls: z.array(warmWallGroup).max(MAX_IMPORT_ENTITIES).optional(),
  // M1 ревью 304: потолочные закладные комнаты — со схемой и лимитом,
  // раньше проходили импорт без проверки (looseObject = passthrough)
  rigels: collection(ceilingRigel, MAX_IMPORT_ENTITIES).optional(),
});

/**
 * Граф-коллекции схемы импорта — выводятся из реестра MODEL_ENTITY_COLLECTIONS
 * (ревью 241 №1): у схемы импорта больше нет своего перечня, который отстал от
 * реестра (cables_socket/cables_warm_floor/cables_conditioner проходили импорт
 * без схемы графа и лимитов). Не-графовые коллекции реестра имеют собственные
 * схемы в collectionsSchema() (walls/items/pillars/rigels/rulers/comments/shields).
 */
const NON_GRAPH_COLLECTIONS = new Set(["walls", "items", "pillars", "rigels", "rulers", "comments", "shields"]);

const GRAPH_COLLECTIONS = MODEL_ENTITY_COLLECTIONS.filter((c) => !NON_GRAPH_COLLECTIONS.has(c));

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
    shields: collection(shield, MAX_IMPORT_ENTITIES).optional(),
  };
  for (const key of GRAPH_COLLECTIONS) out[key] = collection(graphEntity, MAX_IMPORT_ENTITIES).optional();
  return out;
}

export const importModelSchema: z.ZodType = z
  .looseObject({
    v: z.number().finite().optional(),
    id: idStr.optional(),
    plan_id: idStr.optional(),
    total_height: cmSize.optional(),
    final: z.boolean().optional(),
    // комнаты редактора (этап 273 rev 274 №11): warms_walls с лимитами; прочие
    // поля комнаты — passthrough (унаследованный долг rooms2 сохранён)
    rooms2: z.record(z.string(), room2).optional(),
    ...collectionsSchema(),
  })
  // ревью 276 N7: лимит частей задан на каждом уровне (группа, массив комнаты) —
  // общий объём держим суммой по всем комнатам ≤ MAX_IMPORT_ENTITIES
  .superRefine((data, ctx) => {
    const rooms2 = (data as Record<string, unknown>)["rooms2"];
    if (!rooms2 || typeof rooms2 !== "object") return;
    let total = 0;
    for (const room of Object.values(rooms2 as Record<string, { warms_walls?: Array<{ parts?: Record<string, unknown> }> }>)) {
      for (const g of room?.warms_walls ?? []) {
        if (g?.parts && typeof g.parts === "object") total += Object.keys(g.parts).length;
      }
    }
    if (total > MAX_IMPORT_ENTITIES) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: MAX_IMPORT_ENTITIES,
        type: "number",
        origin: "number",
        inclusive: true,
        path: ["rooms2"],
        message: `суммарное число частей warms_walls по всем комнатам (${total}) превышает ${MAX_IMPORT_ENTITIES}`,
      });
    }
    // M1 ревью 304: суммарное число потолочных закладных по всем комнатам
    let rigelsTotal = 0;
    for (const room of Object.values(rooms2 as Record<string, { rigels?: Record<string, unknown> }>)) {
      if (room?.rigels && typeof room.rigels === "object") rigelsTotal += Object.keys(room.rigels).length;
    }
    if (rigelsTotal > MAX_IMPORT_ENTITIES) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: MAX_IMPORT_ENTITIES,
        type: "number",
        origin: "number",
        inclusive: true,
        path: ["rooms2"],
        message: `суммарное число потолочных закладных по всем комнатам (${rigelsTotal}) превышает ${MAX_IMPORT_ENTITIES}`,
      });
    }
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
 * Связь «предмет ↔ содержимое» щитков однозначна (ревью 256 №6): SHIELDS.restore
 * перекладывает щитки по s.id и дополняет предметам записи по умолчанию. Поэтому:
 * ключ записи ≠ id и два щитка на один предмет — INVALID_ARGUMENT (иначе сверка
 * до записи видит ложные «потерян/лишняя» и блокирует save); щиток-сирота
 * (shield_id не из items, в том числе без shield_id) отбрасывается — редактор
 * сам создаёт предметам-щиткам записи при restore.
 */
function normalizeShields(data: Record<string, unknown>): void {
  const shields = data["shields"] as Record<string, Record<string, unknown>> | undefined;
  if (!shields) return;
  const items = data["items"] as Record<string, unknown> | undefined;
  const byShieldId = new Map<string, string>();
  for (const [key, s] of Object.entries(shields)) {
    if (s["id"] !== key) {
      throw new McpError("INVALID_ARGUMENT", `модель не прошла валидацию (model.shields.${key}): ключ записи ≠ id (${String(s["id"])})`);
    }
  }
  for (const [key, s] of Object.entries(shields)) {
    const sid = s["shield_id"];
    if (typeof sid !== "string" || sid === "") continue;
    const prev = byShieldId.get(sid);
    if (prev !== undefined) {
      throw new McpError("INVALID_ARGUMENT", `модель не прошла валидацию (model.shields.${key}): shield_id «${sid}» уже у записи ${prev} — два щитка на один предмет`);
    }
    byShieldId.set(sid, key);
  }
  for (const [key, s] of Object.entries(shields)) {
    const sid = s["shield_id"];
    if (typeof sid !== "string" || !(items !== undefined && sid in items)) {
      delete shields[key];
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
  normalizeShields(res.data as Record<string, unknown>);
  return res.data;
}
