import type { Model } from "./types.ts";

// Ревью 66 №2 (этап 67): общий реестр коллекций объектов планировки — единый
// список для project_clear и project_import_plan, чтобы новая сущность не
// выпадала из очистки/замены модели при добавлении в типы.

/**
 * Коллекции объектов планировки в модели (значение — Record<id, объект>).
 * walls/items/pillars/rulers/comments есть всегда; rigels/pipes_gas/pipes/terrace_borders/
 * territory_borders/level_holes/led_strips/stripes_light/line_strips/warm_floors/
 * pipes_warm_floor/pipes_conditioner/pipes_heat/pipes_ventilation — у старых моделей
 * могут отсутствовать.
 */
export const MODEL_ENTITY_COLLECTIONS = [
  "walls",
  "items",
  "pillars",
  "rigels",
  "pipes_gas",
  "pipes",
  "terrace_borders",
  "territory_borders",
  "level_holes",
  "led_strips",
  "stripes_light",
  "line_strips",
  "cables",
  "rulers",
  "comments",
  "warm_floors",
  "pipes_warm_floor",
  "pipes_conditioner",
  "pipes_heat",
  "pipes_ventilation",
] as const;

export type ModelEntityCollection = (typeof MODEL_ENTITY_COLLECTIONS)[number];

/**
 * Публичные ключи коллекций в ответах инструментов (will_delete, счётчики
 * details.server, revision.editor): как в словаре compact model_get. Внутреннее
 * имя коллекции модели не покидает модель — единственное место отображения
 * (газовые линии: внутреннее pipes_gas → публичное gas_lines).
 */
export const PUBLIC_COLLECTION_KEYS = {
  walls: "walls",
  items: "items",
  pillars: "pillars",
  rigels: "rigels",
  pipes_gas: "gas_lines",
  pipes: "pipes",
  terrace_borders: "terrace_borders",
  territory_borders: "territory_borders",
  level_holes: "level_holes",
  led_strips: "led_strips",
  stripes_light: "stripes_light",
  line_strips: "line_strips",
  cables: "cables",
  rulers: "rulers",
  comments: "comments",
  warm_floors: "warm_floors",
  pipes_warm_floor: "pipes_warm_floor",
  pipes_conditioner: "pipes_conditioner",
  pipes_heat: "pipes_heat",
  pipes_ventilation: "pipes_ventilation",
} as const satisfies Record<ModelEntityCollection, string>;

export type PublicCollectionKey = (typeof PUBLIC_COLLECTION_KEYS)[ModelEntityCollection];

/** Счётчики реестра под публичными ключами (для ответов инструментов). */
export function publicCollectionCounts(counts: Record<ModelEntityCollection, number>): Record<PublicCollectionKey, number> {
  const out = {} as Record<PublicCollectionKey, number>;
  for (const key of MODEL_ENTITY_COLLECTIONS) out[PUBLIC_COLLECTION_KEYS[key]] = counts[key];
  return out;
}

/**
 * Сторож компиляции (C1, аудит 65): реестр обязан совпадать с набором коллекций
 * сущностей в типе Model. Новая коллекция в types.ts без регистрации в реестре —
 * ошибка компиляции (npm run typecheck красный); ключ реестра, которого нет в
 * Model (переименование, опечатка), — тоже. Коллекция сущности — поле Model,
 * значение которого Record<id, объект с id>.
 */
type EntityCollectionKeyMap<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]-?: NonNullable<T[K]> extends
    Record<string, { id: string }>
    ? K
    : never;
};
type EntityCollectionKeysOf<T> = EntityCollectionKeyMap<T>[keyof EntityCollectionKeyMap<T>];

type RegistryVsModel =
  | Exclude<EntityCollectionKeysOf<Model>, ModelEntityCollection>
  | Exclude<ModelEntityCollection, EntityCollectionKeysOf<Model>>;
const registryMatchesModelType: RegistryVsModel extends never ? true : never = true;
void registryMatchesModelType;

/** Счётчик сущностей каждой коллекции реестра (отсутствующая коллекция — 0). */
export function entityCounts(model: Model): Record<ModelEntityCollection, number> {
  const out = {} as Record<ModelEntityCollection, number>;
  for (const key of MODEL_ENTITY_COLLECTIONS) {
    const v = model[key];
    out[key] = v !== null && typeof v === "object" ? Object.keys(v).length : 0;
  }
  return out;
}

/** Есть ли в модели хоть одна сущность планировки (комнаты не считаются). */
export function hasEntities(model: Model): boolean {
  for (const key of MODEL_ENTITY_COLLECTIONS) {
    const v = model[key];
    if (v !== null && typeof v === "object" && Object.keys(v).length > 0) return true;
  }
  return false;
}

/**
 * Обязательные коллекции (ревью 68 №1): инвариант Model — walls/items/pillars/
 * rulers/comments существуют всегда (как в пустом проекте редактора и как clear
 * в main до этапа 67). Очистка/замена оставляет их пустыми объектами, а не
 * отсутствующими — иначе validate/add падают на undefined.
 */
export const MODEL_REQUIRED_COLLECTIONS = ["walls", "items", "pillars", "rulers", "comments"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Очистить все коллекции объектов в рабочей копии (project_clear). */
export function clearEntityCollections(model: Model): void {
  for (const key of MODEL_ENTITY_COLLECTIONS) {
    if ((MODEL_REQUIRED_COLLECTIONS as readonly string[]).includes(key)) {
      model[key] = {} as never;
    } else {
      delete model[key];
    }
  }
  delete model.rooms1;
  delete model.rooms2;
}

/**
 * Заменить коллекции объектов содержимым импортируемой модели (project_import_plan):
 * коллекция из источника копируется целиком; отсутствующая в источнике обязательная
 * — оставляется пустой (инвариант Model, ревью 68 №1), необязательная — удаляется
 * (импорт заменяет планировку, а не дополняет её). total_height и rooms2 — по
 * прежней семантике импорта; rooms1 источника переносится тоже (часть модели).
 */
export function replaceEntityCollections(target: Model, source: Model): void {
  for (const key of MODEL_ENTITY_COLLECTIONS) {
    const value = source[key];
    if (isRecord(value)) {
      target[key] = structuredClone(value) as never;
    } else if ((MODEL_REQUIRED_COLLECTIONS as readonly string[]).includes(key)) {
      target[key] = {} as never;
    } else {
      delete target[key];
    }
  }
  target.total_height = source.total_height ?? 270;
  if (source.rooms2) target.rooms2 = structuredClone(source.rooms2) as never;
  else delete target.rooms2;
  if (source.rooms1) target.rooms1 = structuredClone(source.rooms1) as never;
  else delete target.rooms1;
}
