import type { Model } from "../model/types.ts";
import { borderMismatches } from "../model/terraces.ts";
import { missingIds } from "./ids.ts";
import type { VerificationMismatches } from "./types.ts";

/** Потеря/изменение границ террас и участка (сверка семантики, этап 64). */
export function borderMismatchesOf(model: Model, got: { terrace_borders?: Record<string, unknown>; territory_borders?: Record<string, unknown> }): VerificationMismatches {
  return [
    ...borderMismatches(structuredClone(model.terrace_borders ?? {}), got.terrace_borders ?? {}, "граница террасы"),
    ...borderMismatches(structuredClone(model.territory_borders ?? {}), got.territory_borders ?? {}, "граница участка"),
  ];
}

/** Сверка границ террас/участка локальной модели с редактором (нормализация/save). */
export function checkBordersAfterNormalize(local: Model, norm: { terrace_borders?: Record<string, unknown>; territory_borders?: Record<string, unknown> }): VerificationMismatches {
  const mismatches = borderMismatchesOf(local as unknown as Model, norm);
  const wsTerraceIds = new Set(Object.keys(local.terrace_borders ?? {}));
  const wsTerritoryIds = new Set(Object.keys(local.territory_borders ?? {}));
  const normTerraceIds = new Set(Object.keys(norm.terrace_borders ?? {}));
  const normTerritoryIds = new Set(Object.keys(norm.territory_borders ?? {}));
  const missing = [
    ...missingIds(wsTerraceIds, normTerraceIds).map((id) => `${id}: граница террасы потеряна`),
    ...missingIds(wsTerritoryIds, normTerritoryIds).map((id) => `${id}: граница участка потеряна`),
  ];
  const extra = [
    ...missingIds(normTerraceIds, wsTerraceIds).map((id) => `${id}: граница террасы добавлена редактором`),
    ...missingIds(normTerritoryIds, wsTerritoryIds).map((id) => `${id}: граница участка добавлена редактором`),
  ];
  return [...missing, ...extra, ...mismatches.filter((m) => !missing.some((k) => m.startsWith(`${k.split(":")[0]!}:`)))];
}
