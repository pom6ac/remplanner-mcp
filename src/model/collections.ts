import type { Model } from "./types.ts";

// Ревью 66 №2 (этап 67): общий реестр коллекций объектов планировки — единый
// список для project_clear и project_import_plan, чтобы новая сущность не
// выпадала из очистки/замены модели при добавлении в типы.

/**
 * Коллекции объектов планировки в модели (значение — Record<id, объект>).
 * walls/items/pillars/rulers/comments есть всегда; rigels/pipes_gas/terrace_borders/
 * territory_borders/level_holes — у старых моделей могут отсутствовать.
 */
export const MODEL_ENTITY_COLLECTIONS = [
  "walls",
  "items",
  "pillars",
  "rigels",
  "pipes_gas",
  "terrace_borders",
  "territory_borders",
  "level_holes",
  "rulers",
  "comments",
] as const;

export type ModelEntityCollection = (typeof MODEL_ENTITY_COLLECTIONS)[number];

/** Очистить все коллекции объектов в рабочей копии (project_clear). */
export function clearEntityCollections(model: Model): void {
  for (const key of MODEL_ENTITY_COLLECTIONS) {
    delete model[key];
  }
  delete model.rooms1;
  delete model.rooms2;
}

/**
 * Заменить коллекции объектов содержимым импортируемой модели (project_import_plan):
 * коллекция из источника копируется целиком, отсутствующая в источнике — удаляется
 * (импорт заменяет планировку, а не дополняет её). total_height и rooms2 — по
 * прежней семантике импорта; rooms1 источника переносится тоже (часть модели).
 */
export function replaceEntityCollections(target: Model, source: Model): void {
  for (const key of MODEL_ENTITY_COLLECTIONS) {
    const value = source[key];
    if (value === undefined || value === null) {
      delete target[key];
    } else {
      target[key] = structuredClone(value) as never;
    }
  }
  target.total_height = source.total_height ?? 270;
  if (source.rooms2) target.rooms2 = structuredClone(source.rooms2) as never;
  else delete target.rooms2;
  if (source.rooms1) target.rooms1 = structuredClone(source.rooms1) as never;
  else delete target.rooms1;
}
