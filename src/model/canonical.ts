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

/**
 * Legacy-формы конструктора щитка (этап 255): SHIELDS.restore бандла app.3.0
 * мигрирует при restore — buses/rails/wires массивом → словари, rail.modules
 * массивом → словарь, inputs массивом → ввод с портами (parent_id переписывается),
 * inputs-объект с ports без группировки → стандартный ввод фаза/ноль/земля.
 * Каноническая модель MCP хранит те же формы, что сериализует редактор (словари),
 * иначе каждая сверка save видит ложную потерю.
 */
function migrateLegacyShields(model: Model): void {
  const shields = model.shields as Record<string, Record<string, unknown>> | undefined;
  if (!shields) return;
  const toDict = (v: unknown): Record<string, unknown> => {
    if (Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const e of v as Array<Record<string, unknown>>) {
        if (e && typeof e === "object" && typeof e["id"] === "string") out[e["id"]] = e;
      }
      return out;
    }
    return (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  };
  for (const shield of Object.values(shields)) {
    if (!shield || typeof shield !== "object") continue;
    if (Array.isArray(shield["buses"])) shield["buses"] = toDict(shield["buses"]);
    if (Array.isArray(shield["collectors"])) shield["collectors"] = toDict(shield["collectors"]);
    if (Array.isArray(shield["wires"])) shield["wires"] = toDict(shield["wires"]);
    if (shield["rails"] !== undefined) {
      const rails = toDict(shield["rails"]);
      for (const rail of Object.values(rails) as Array<Record<string, unknown>>) {
        if (rail && typeof rail === "object" && Array.isArray(rail["modules"])) rail["modules"] = toDict(rail["modules"]);
      }
      shield["rails"] = rails;
    }
    if (shield["inputs"] !== undefined) {
      let inputs = shield["inputs"];
      if (Array.isArray(inputs)) {
        const id = `_${Math.random().toString(36).slice(2, 7)}`;
        for (const p of inputs as Array<Record<string, unknown>>) p["parent_id"] = id;
        inputs = { [id]: { id, ports: inputs } };
      } else if (inputs && typeof inputs === "object") {
        const rec = inputs as Record<string, unknown>;
        if (Array.isArray(rec["ports"])) {
          // ports без обёртки-ввода: один ввод с портами фаза/ноль/земля
          const id = typeof rec["id"] === "string" && rec["id"] ? rec["id"] : `_${Math.random().toString(36).slice(2, 7)}`;
          const ports = rec["ports"] as Array<Record<string, unknown>>;
          const types = ["shield_wire_earth", "shield_wire_null", "shield_wire_phase"];
          inputs = {
            [id]: {
              id,
              ports: types.map((type, i) => ({
                id: typeof ports[i]?.["id"] === "string" && ports[i]!["id"] ? ports[i]!["id"] : `_${Math.random().toString(36).slice(2, 7)}`,
                parent_type: "input",
                parent_id: id,
                type,
                connected: ports[i]?.["connected"] ? 1 : 0,
              })),
            },
          };
        } else {
          // ключи ≠ id: перегруппировать по id (SHIELDS.restore, ветка «id»===r)
          const regrouped: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rec)) {
            if (v && typeof v === "object") {
              const e = v as Record<string, unknown>;
              const id = typeof e["id"] === "string" && e["id"] ? e["id"] : k;
              e["id"] = id;
              regrouped[id] = e;
            }
          }
          inputs = regrouped;
        }
      } else {
        inputs = {};
      }
      shield["inputs"] = inputs;
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
  migrateLegacyShields(model);
  return model;
}

/** Короткий хэш содержимого модели (для ревизии рендера и сверок). */
export function modelHash(model: Model): string {
  return createHash("sha256").update(JSON.stringify(model)).digest("hex").slice(0, 16);
}
