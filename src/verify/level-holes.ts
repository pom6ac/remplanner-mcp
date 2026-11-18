import type { Model } from "../model/types.ts";
import { levelHoleMismatches } from "../model/floorhole.ts";
import { missingIds } from "./ids.ts";
import type { VerificationMismatches } from "./types.ts";

/** Сверка проёмов в полу локальной модели с редактором (нормализация/save).
 *  levelHoleMismatches (этап 67) сверяет идентичности в обе стороны, включая
 *  лишние проёмы на стороне редактора/сервера. */
export function checkLevelHolesAfterNormalize(local: Model, norm: Model): VerificationMismatches {
  const wsIds = new Set(Object.keys(local.level_holes ?? {}));
  const normIds = new Set(Object.keys(norm.level_holes ?? {}));
  const lost = missingIds(wsIds, normIds);
  const mismatches = levelHoleMismatches(structuredClone(local.level_holes ?? {}), norm.level_holes ?? {});
  return [
    ...lost.map((id) => `${id}: проём в полу потерян`),
    ...mismatches.filter((m) => !lost.some((id) => m.startsWith(`${id}:`))),
  ];
}
