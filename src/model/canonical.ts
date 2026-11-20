// Канонические модельные помощники (аудит 65 C2, задача 192-c2s п.2): чистые
// функции без сети — общий слой workspace и save-оркестрации. Тела перенесены
// из src/workspace.ts без изменения поведения.
import { createHash } from "node:crypto";
import { entityCounts, hasEntities, publicCollectionCounts, PUBLIC_COLLECTION_KEYS, type ModelEntityCollection } from "./collections.ts";
import type { Model } from "./types.ts";

export type ModelCounts = { walls: number; openings: number } & {
  [K in Exclude<ModelEntityCollection, "walls"> as (typeof PUBLIC_COLLECTION_KEYS)[K]]: number;
};

/**
 * Счётчики объектов модели. Специальные ключи: walls (число стен) и openings
 * (число проёмов в стенах); остальные — по общему реестру коллекций
 * MODEL_ENTITY_COLLECTIONS (C1, аудит 65) под публичными ключами
 * PUBLIC_COLLECTION_KEYS (как в compact model_get; газовые линии — gas_lines),
 * чтобы новая сущность не выпадала из счётчиков (раньше вручную отставали
 * cables/rulers/comments).
 */
export function modelCounts(model: Model | Record<string, unknown>): ModelCounts {
  const m = model as Model;
  const walls = m.walls ?? {};
  return {
    ...publicCollectionCounts(entityCounts(m)),
    walls: Object.keys(walls).length,
    openings: Object.values(walls).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0),
  };
}

/** Разобранная модель без содержимого: ни одной сущности планировки (по общему
 *  реестру коллекций, C1) и без комнат. */
export function modelIsContentEmpty(model: Model): boolean {
  if (hasEntities(model)) return false;
  const nonEmpty = (v: unknown): boolean => v !== null && v !== undefined && typeof v === "object" && Object.keys(v as object).length > 0;
  if (nonEmpty(model.rooms2) || nonEmpty(model.rooms1)) return false;
  return true;
}

/**
 * Ревью 251 №3 (регрессия против 58a382d): модели, записанные PR #36 (этап 239),
 * хранят обратную ссылку трассы кондиционера под ключом cable_conditioner_id;
 * редактор (проба 250-connect4, эталон ui-ref-elec2-conditioner) —
 * conditioner_cable_id. Legacy-ключ при чтении мигрируется (скаляр и массив —
 * по форме предмета, включая под-розетки групп), иначе модель PR #36 не проходит
 * сверку подключений при каждом save.
 */
function migrateLegacyConditionerCable(model: Model): void {
  const rename = (holder: Record<string, unknown> | undefined): void => {
    const box = holder?.["cables_conditioner"] as Record<string, unknown> | undefined;
    if (!box || typeof box !== "object") return;
    if ("cable_conditioner_id" in box) {
      if (box["conditioner_cable_id"] === undefined) box["conditioner_cable_id"] = box["cable_conditioner_id"];
      delete box["cable_conditioner_id"];
    }
  };
  for (const item of Object.values(model.items ?? {})) {
    const rec = item as unknown as Record<string, unknown>;
    rename(rec);
    if (!Array.isArray(rec.socket_group)) continue;
    for (const sub of rec.socket_group as unknown[]) {
      if (sub && typeof sub === "object") rename(sub as Record<string, unknown>);
    }
  }
}

/** Сырая модель редактора/сервера → каноническая модель: гарантированные
 *  коллекции и holes: {} у стен без проёмов. */
export function toModel(raw: Record<string, unknown>): Model {
  const model = raw as Model;
  model.walls ??= {};
  model.items ??= {};
  model.pillars ??= {};
  model.rigels ??= {};
  model.rulers ??= {};
  model.comments ??= {};
  // сервер отдаёт holes: null у стен без проёмов — нормализуем в {}
  for (const w of Object.values(model.walls)) {
    w.holes ??= {};
  }
  migrateLegacyConditionerCable(model);
  return model;
}

/** Короткий хэш содержимого модели (для ревизии рендера и сверок). */
export function modelHash(model: Model): string {
  return createHash("sha256").update(JSON.stringify(model)).digest("hex").slice(0, 16);
}
