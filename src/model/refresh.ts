import type { Model } from "./types.ts";
import { refreshPillarsAfterWallChange } from "./pillars.ts";
import { refreshRigelsAfterWallOrPillarChange } from "./rigels.ts";

/**
 * Оркестрация пересчёта зависимых привязок после мутаций стен (аудит 65, C3):
 * entity-модули (walls, pillars, rigels, openings) не импортируют друг друга для
 * пересчёта — порядок вызовов финализаторов задан здесь, выше entity-модулей.
 * Entity-specific финализаторы остаются в своих модулях: refreshPillarsAfterWallChange
 * (pillars.ts), refreshRigelsAfterWallOrPillarChange (rigels.ts).
 */

/**
 * Атомарность (правило 7, R2-3): мутация выполняется на клоне стен; при ошибке
 * model.walls и model.pillars восстанавливаются побайтно. После успешной мутации —
 * финализация колонн (ревью 43 №1): пересчёт eds/edges/inRoom и проверка коллизий
 * в той же атомарной операции; конфликт откатывает и стены, и колонны.
 * Общий механизм атомарности — используется и пакетными операциями вне модуля
 * (addBalcony, ревью 73 №3): откатываются walls, pillars и rigels.
 */
export function atomic<T>(model: Model, fn: () => T): T {
  const backupWalls = structuredClone(model.walls);
  const backupPillars = structuredClone(model.pillars ?? {});
  const backupRigels = structuredClone(model.rigels ?? {});
  const hadRigels = model.rigels !== undefined;
  try {
    const result = fn();
    refreshPillarsAfterWallChange(model);
    refreshRigelsAfterWallOrPillarChange(model);
    return result;
  } catch (e) {
    model.walls = backupWalls;
    model.pillars = backupPillars;
    // побайтная атомарность: у модели без rigels ключ не появляется
    if (hadRigels) model.rigels = backupRigels;
    else delete model.rigels;
    throw e;
  }
}
