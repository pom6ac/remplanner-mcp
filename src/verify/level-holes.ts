import type { Model } from "../model/types.ts";
import { levelHoleMismatches } from "../model/floorhole.ts";
import { missingIds } from "./ids.ts";
import type { VerificationMismatches } from "./types.ts";

/** Вид проёма для текста отказа (ревью 329 №10): пол/потолок — разные листы. */
function holeKind(type: unknown): string {
  return type === "ceiling_hole" ? "потолке" : "полу";
}

/** Сверка проёмов в полу/потолке локальной модели с редактором (нормализация/save).
 *  levelHoleMismatches (этап 67) сверяет идентичности в обе стороны, включая
 *  лишние проёмы на стороне редактора/сервера. Ревью 329 №10: вид проёма в тексте
 *  потери — по типу потерянной записи, а не по всем проёмам модели. */
export function checkLevelHolesAfterNormalize(local: Model, norm: Model): VerificationMismatches {
  const wsHoles = local.level_holes ?? {};
  const wsIds = new Set(Object.keys(wsHoles));
  const normIds = new Set(Object.keys(norm.level_holes ?? {}));
  const lost = missingIds(wsIds, normIds);
  const mismatches = levelHoleMismatches(structuredClone(wsHoles), norm.level_holes ?? {});
  return [
    ...lost.map((id) => `${id}: проём в ${holeKind((wsHoles as Record<string, { type?: unknown }>)[id]?.type)} потерян`),
    ...mismatches.filter((m) => !lost.some((id) => m.startsWith(`${id}:`))),
  ];
}
