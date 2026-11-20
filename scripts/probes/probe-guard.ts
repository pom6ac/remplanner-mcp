// Общие гарды записывающих живых проб (ревью 319 №3, №4). Подключаются во ВСЕХ
// пробах scripts/probes/*, которые пишут на сервер.
// №3 — до первой записи: PLAN_ID !== READONLY_PLAN_ID; GET(OBJECT_ID, PLAN_ID)
//      вернул object_id === OBJECT_ID и plan_id === PLAN_ID; PLAN_ID входит в
//      планы объекта (floors ответа GET; нераспознанная форма floors — только
//      предупреждение, pair-гард остаётся).
// №4 — эталон контрольного проекта ФИКСИРОВАННЫЙ: файл-эталон создаётся, только
//      если его нет, и никогда не перезаписывается; сверка с ним перед КАЖДОЙ
//      фазой записи (assertUnchanged) и в finally (checkFinal); «ИЗМЕНИЛСЯ» —
//      process.exit(1) ДО следующих записей (эскалация координатору, без
//      повторных прогонов).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import type { SessionState } from "../../src/session.ts";
import { sig } from "./probe-sig.ts";

export type ProbeWriteEnv = {
  objectId: string;
  planId: string;
  readonlyId: string | null;
  readonlyPlanId: string | null;
};

/** Чтение и первичная проверка env записывающей пробы: объект/план из env,
 *  коллизии с контрольным проектом — отказ до любых запросов (ревью 319 №3). */
export function probeWriteEnv(): ProbeWriteEnv {
  const objectId = process.env["REMPLANNER_PROBE_OBJECT_ID"];
  const planId = process.env["REMPLANNER_PROBE_PLAN_ID"];
  const readonlyId = process.env["REMPLANNER_PROBE_READONLY_ID"] ?? null;
  const readonlyPlanId = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"] ?? process.env["REMPLANNER_PROBE_READONLY_PLAN"] ?? null;
  if (!objectId || !planId) {
    console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID");
    process.exit(1);
  }
  if (readonlyId && objectId === readonlyId) {
    console.error("OBJECT_ID == READONLY_ID — стоп");
    process.exit(1);
  }
  if (readonlyPlanId && planId === readonlyPlanId) {
    console.error("PLAN_ID == READONLY_PLAN_ID — стоп (ревью 319 №3)");
    process.exit(1);
  }
  return { objectId, planId, readonlyId, readonlyPlanId };
}

/** Коллизии env с контрольным проектом — для проб, читающих env сами. */
export function assertNoReadonlyCollision(objectId: string, planId: string, readonlyId: string | null, readonlyPlanId: string | null): void {
  if (readonlyId && objectId === readonlyId) {
    console.error("OBJECT_ID == READONLY_ID — стоп");
    process.exit(1);
  }
  if (readonlyPlanId && planId === readonlyPlanId) {
    console.error("PLAN_ID == READONLY_PLAN_ID — стоп (ревью 319 №3)");
    process.exit(1);
  }
}

/** Идентификаторы планов из сырого floors ответа GET (форма {floor_id, plans:[…]}).
 *  Нераспознанная форма — null (проверка невозможна, caller предупреждает). */
export function planIdsOfFloors(floors: unknown): Set<string> | null {
  if (!Array.isArray(floors) || floors.length === 0) return null;
  const out = new Set<string>();
  for (const f of floors) {
    if (f === null || typeof f !== "object") return null;
    const plans = (f as Record<string, unknown>)["plans"];
    if (!Array.isArray(plans)) return null;
    for (const p of plans) out.add(String(p));
  }
  return out.size > 0 ? out : null;
}

/**
 * Гард пары «объект → план» (ревью 319 №3): GET(OBJECT_ID, PLAN_ID) обязан
 * вернуть object_id === OBJECT_ID и plan_id === PLAN_ID, а PLAN_ID — входить
 * в планы объекта (floors). Любое расхождение — process.exit(1) до первой записи.
 */
export async function assertTargetPair(session: SessionState, objectId: string, planId: string): Promise<LoadedModel> {
  const got = await loadModel(session, objectId, planId);
  if (got.object_id !== objectId || got.plan_id !== planId) {
    console.error(`гард пары (ревью 319 №3): GET(${objectId}, ${planId}) вернул object_id=${got.object_id}, plan_id=${got.plan_id} — стоп`);
    process.exit(1);
  }
  const plans = planIdsOfFloors(got.floors);
  if (plans === null) {
    console.log("гард планов: floors в ответе GET не распознаны — проверка состава планов пропущена (pair-гард остаётся)");
  } else if (!plans.has(planId)) {
    console.error(`гард планов (ревью 319 №3): PLAN_ID ${planId} не входит в планы объекта ${objectId} (${[...plans].join(", ")}) — стоп`);
    process.exit(1);
  }
  return got;
}

export type ReadonlyGuard = {
  /** Проверка контрольного проекта перед фазой записи: «ИЗМЕНИЛСЯ» → process.exit(1). */
  assertUnchanged(tag: string): Promise<void>;
  /** Финальная сверка (finally): «ИЗМЕНИЛСЯ» → process.exitCode = 1; true — изменился. */
  checkFinal(tag: string): Promise<boolean>;
  /** Снимок-эталон контрольного проекта (для лога). */
  reference: LoadedModel;
};

/**
 * Гард контрольного проекта (ревью 319 №4): эталон ФИКСИРОВАННЫЙ — файл refPath
 * создаётся, только если его нет, и не перезаписывается (изменение за прошлый
 * прогон не маскируется новым базисом). Каждая сверка — GET + семантический
 * канон (sig) + save_id против эталона.
 */
export async function readonlyGuard(session: SessionState, readonlyId: string, readonlyPlanId: string, refPath: string): Promise<ReadonlyGuard> {
  mkdirSync(dirname(refPath), { recursive: true });
  let reference: LoadedModel;
  if (existsSync(refPath)) {
    reference = JSON.parse(readFileSync(refPath, "utf8")) as LoadedModel;
  } else {
    const cur = await loadModel(session, readonlyId, readonlyPlanId);
    if (cur.data_empty) {
      console.error("контрольный GET пустой (data_empty) — эталон не создаётся, отказ");
      process.exit(1);
    }
    reference = cur;
    writeFileSync(refPath, JSON.stringify(reference, null, 1) + "\n");
  }
  const changed = async (tag: string): Promise<boolean> => {
    try {
      const cur = await loadModel(session, readonlyId, readonlyPlanId);
      if (cur.data_empty) {
        console.error(`контрольный GET (${tag}) пустой (data_empty) — ИЗМЕНИЛСЯ — СТОП`);
        return true;
      }
      const ok = sig(cur.model) === sig(reference.model) && cur.save_id === reference.save_id;
      if (!ok) console.error(`контрольный проект ИЗМЕНИЛСЯ (${tag}) — СТОП до следующих записей (ревью 319 №4)`);
      return !ok;
    } catch (e) {
      console.error(`контрольный GET (${tag}) не удался: ${String((e as Error).message ?? e).slice(0, 300)} — СТОП`);
      return true;
    }
  };
  return {
    assertUnchanged: async (tag) => {
      if (await changed(tag)) process.exit(1);
    },
    checkFinal: async (tag) => {
      const isChanged = await changed(tag);
      if (isChanged) process.exitCode = 1;
      return isChanged;
    },
    reference,
  };
}
