// Общие гарды записывающих живых проб (ревью 319 №3, №4; ревью 321 N3/N4).
// Подключаются во ВСЕХ пробах scripts/probes/*, которые пишут на сервер.
// №3 — до первой записи: READONLY_ID и READONLY_PLAN_ID ОБЯЗАТЕЛЬНЫ (322 N3б);
//      PLAN_ID !== READONLY_PLAN_ID; GET(OBJECT_ID, PLAN_ID) вернул
//      object_id === OBJECT_ID и plan_id === PLAN_ID; PLAN_ID входит в планы
//      объекта. floors ответа GET имеет форму {prev:[…], next:[…]} (фикстура
//      tests/fixtures/api-load-response.json, дампы); нераспознанная форма —
//      отказ (322 N3а), а если список планов из GET не выводится (пустые
//      prev/next) — принадлежность объекта проверяется по project_list (ЛК)
//      тем же путём, что MCP (322 N3а).
// №4 — эталон контрольного проекта ФИКСИРОВАННЫЙ и ОБЩИЙ на пару READONLY
//      (322 N4; ревью 329 №7): файл .orca-reports/tmp/readonly-ref-<hash пары>.json
//      в КОРНЕВОМ репо (абсолютный путь, не относительно cwd/worktree);
//      отсутствующий эталон — отказ (автосоздание — только по явному
//      env-флагу REMPLANNER_PROBE_READONLY_REF_INIT=1, иначе молчаливое
//      перебазирование — инцидент 328, 27→33→39); сверка
//      с ним перед КАЖДОЙ фазой записи (assertUnchanged/guardedSave) и в
//      finally (checkFinal); «ИЗМЕНИЛСЯ» — process.exit(1) ДО следующих
//      записей (эскалация координатору, без повторных прогонов).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fetchClientPage, loadModel, parseClientPage, type ClientProject, type LoadedModel } from "../../src/api.ts";
import type { SessionState } from "../../src/session.ts";
import { sig } from "./probe-sig.ts";

export type ProbeWriteEnv = {
  objectId: string;
  planId: string;
  readonlyId: string;
  readonlyPlanId: string;
};

/** Отказ гарда (бросается ядром, для юнит-тестов; обёртки превращают в exit(1)). */
export class ProbeGuardError extends Error {}

/** Ядро коллизий env с контрольным проектом (ревью 319 №3, 322 N3б):
 *  READONLY_ID и READONLY_PLAN_ID обязательны и не равны целевой паре. */
export function checkNoReadonlyCollision(objectId: string, planId: string, readonlyId: string, readonlyPlanId: string): void {
  if (!readonlyId) throw new ProbeGuardError("нет REMPLANNER_PROBE_READONLY_ID — стоп (322 N3б: READONLY_ID обязателен)");
  if (!readonlyPlanId) throw new ProbeGuardError("нет REMPLANNER_PROBE_READONLY_PLAN_ID — стоп (322 N3б: READONLY_PLAN_ID обязателен)");
  if (objectId === readonlyId) {
    throw new ProbeGuardError("OBJECT_ID == READONLY_ID — стоп (ревью 319 №3)");
  }
  if (planId === readonlyPlanId) {
    throw new ProbeGuardError("PLAN_ID == READONLY_PLAN_ID — стоп (ревью 319 №3)");
  }
}

const guardExit = (e: unknown): never => {
  if (e instanceof ProbeGuardError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
};

/** Чтение и первичная проверка env записывающей пробы: объект/план из env,
 *  контрольный проект ОБЯЗАТЕЛЕН, коллизии — отказ до любых запросов
 *  (ревью 319 №3, 322 N3б). */
export function probeWriteEnv(): ProbeWriteEnv {
  const objectId = process.env["REMPLANNER_PROBE_OBJECT_ID"];
  const planId = process.env["REMPLANNER_PROBE_PLAN_ID"];
  const readonlyId = process.env["REMPLANNER_PROBE_READONLY_ID"];
  const readonlyPlanId = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
  if (!objectId || !planId) {
    console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID");
    process.exit(1);
  }
  if (!readonlyId || !readonlyPlanId) {
    console.error("нужны REMPLANNER_PROBE_READONLY_ID и REMPLANNER_PROBE_READONLY_PLAN_ID — стоп (322 N3б: READONLY_ID и READONLY_PLAN_ID обязательны)");
    process.exit(1);
  }
  try {
    checkNoReadonlyCollision(objectId, planId, readonlyId, readonlyPlanId);
  } catch (e) {
    guardExit(e);
  }
  return { objectId, planId, readonlyId, readonlyPlanId };
}

/** Коллизии env с контрольным проектом — для проб, читающих env сами
 *  (READONLY_ID и READONLY_PLAN_ID обязательны, 322 N3б). */
export function assertNoReadonlyCollision(objectId: string, planId: string, readonlyId: string, readonlyPlanId: string): void {
  try {
    checkNoReadonlyCollision(objectId, planId, readonlyId, readonlyPlanId);
  } catch (e) {
    guardExit(e);
  }
}

/**
 * Идентификаторы планов из сырого floors ответа GET /setup/api/planner/
 * (322 N3а). Реальная форма — объект {prev: […], next: […]} (фикстура
 * tests/fixtures/api-load-response.json, дампы .orca-reports/backup-*.json);
 * элемент этажа — объект со списком планов в поле plans. Нераспознанная форма
 * — null (caller обязан отказать, не предупреждать). Распознанная форма без
 * этажей/планов (один этаж, prev/next пусты) — пустое множество: caller
 * проверяет принадлежность объекта по project_list.
 */
export function planIdsOfFloors(floors: unknown): Set<string> | null {
  if (floors === null || typeof floors !== "object" || Array.isArray(floors)) return null;
  const rec = floors as Record<string, unknown>;
  const out = new Set<string>();
  for (const key of ["prev", "next"]) {
    const arr = rec[key];
    if (arr === undefined || !Array.isArray(arr)) return null;
    for (const f of arr) {
      if (f === null || typeof f !== "object" || Array.isArray(f)) return null;
      const plans = (f as Record<string, unknown>)["plans"];
      if (!Array.isArray(plans)) return null;
      for (const p of plans) out.add(String(p));
    }
  }
  return out;
}

/** Список проектов ЛК тем же путём, что MCP (parseClientPage по /client/). */
export async function listProjectsViaClientPage(session: SessionState): Promise<ClientProject[]> {
  return (await parseClientPage(await fetchClientPage(session))).projects;
}

/** Принадлежность плана объекту (322 N3а): список планов из floors ответа GET;
 *  если он из GET не выводится — объект обязан найтись в project_list (ЛК),
 *  иначе PLAN_ID может быть планом чужого объекта. Бросает ProbeGuardError. */
export async function checkPlanMembership(
  objectId: string,
  planId: string,
  floors: unknown,
  listProjects: () => Promise<ClientProject[]>,
): Promise<void> {
  const plans = planIdsOfFloors(floors);
  if (plans === null) {
    throw new ProbeGuardError(`гард планов (322 N3а): floors в ответе GET не распознаны (ожидался объект {prev,next}) — стоп`);
  }
  if (plans.size > 0) {
    if (!plans.has(planId)) {
      throw new ProbeGuardError(`гард планов (ревью 319 №3): PLAN_ID ${planId} не входит в планы объекта ${objectId} (${[...plans].join(", ")}) — стоп`);
    }
    return;
  }
  const projects = await listProjects();
  if (!projects.some((p) => String(p.object_id) === objectId)) {
    throw new ProbeGuardError(`гард планов (322 N3а): объект ${objectId} не найден в project_list (ЛК) — PLAN_ID ${planId} может быть планом чужого объекта — стоп`);
  }
}

/**
 * Ядро сверки модели с запрошенной парой (323 N5): модель сервера несёт
 * собственные object_id/plan_id (id и plan_id в теле модели); для непустой
 * модели они обязаны совпадать с запрошенной парой — иначе PLAN_ID может быть
 * планом другого объекта. Пустая модель (проект без сохранений) — пропуск.
 * Бросает ProbeGuardError.
 */
export function checkTargetModelPair(objectId: string, planId: string, model: Record<string, unknown>): void {
  const keys = Object.keys(model);
  if (keys.length === 0) return;
  const modelId = model["id"];
  const modelPlanId = model["plan_id"];
  if (String(modelId) !== objectId) {
    throw new ProbeGuardError(`гард пары (323 N5): model.id (${String(modelId)}) не совпадает с OBJECT_ID ${objectId} — план может принадлежать другому объекту — стоп`);
  }
  if (String(modelPlanId) !== planId) {
    throw new ProbeGuardError(`гард пары (323 N5): model.plan_id (${String(modelPlanId)}) не совпадает с PLAN_ID ${planId} — PLAN_ID может быть планом другого объекта — стоп`);
  }
}

/**
 * Гард пары «объект → план» (ревью 319 №3, 322 N3а): GET(OBJECT_ID, PLAN_ID)
 * обязан вернуть object_id === OBJECT_ID и plan_id === PLAN_ID, а PLAN_ID —
 * входить в планы объекта (floors; если из GET не выводятся — объект в ЛК).
 * Для непустой модели — model.id === OBJECT_ID и model.plan_id === PLAN_ID
 * (323 N5). Любое расхождение — process.exit(1) до первой записи.
 */
export async function assertTargetPair(session: SessionState, objectId: string, planId: string): Promise<LoadedModel> {
  const got = await loadModel(session, objectId, planId);
  if (got.object_id !== objectId || got.plan_id !== planId) {
    console.error(`гард пары (ревью 319 №3): GET(${objectId}, ${planId}) вернул object_id=${got.object_id}, plan_id=${got.plan_id} — стоп`);
    process.exit(1);
  }
  try {
    checkTargetModelPair(objectId, planId, got.model);
    await checkPlanMembership(objectId, planId, got.floors, () => listProjectsViaClientPage(session));
  } catch (e) {
    guardExit(e);
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
 * Корень репо по git (ревью 331 Н6): `git rev-parse --git-common-dir` — общий
 * каталог .git (в worktree указывает на основной репо), корень — его родитель.
 * Эвристика «самый внешний предок с .orca-reports» (ревью 329 №7) удалена:
 * каталог .orca-reports в ~ или ~/projects перехватывал бы эталон. null — git
 * недоступен (caller обязан отказать).
 */
export function gitRepoRoot(cwd: string = import.meta.dirname): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
    if (!out) return null;
    return dirname(resolve(cwd, out));
  } catch {
    return null;
  }
}

/**
 * Файл-эталон контрольного проекта на пару READONLY (322 N4; 323 N6 — ключ без
 * dev-объекта; ревью 329 №7): АБСОЛЮТНЫЙ путь в КОРНЕВОМ .orca-reports/tmp репо,
 * а не относительно cwd/worktree — иначе каждый worktree получает свой базис
 * (инцидент 328: изменение 27→33 не было замечено). Корень — по git
 * (gitRepoRoot, ревью 331 Н6), не по эвристике предков.
 */
export function readonlyRefPath(readonlyId: string, readonlyPlanId: string): string {
  const h = createHash("sha256").update(`${readonlyId}|${readonlyPlanId}`).digest("hex").slice(0, 12);
  const root = gitRepoRoot();
  if (root === null) {
    throw new ProbeGuardError("не удалось определить корень репо (git rev-parse --git-common-dir) — эталон контрольного проекта нельзя привязать к репо — стоп (ревью 329 №7, 331 Н6)");
  }
  return join(root, ".orca-reports", "tmp", `readonly-ref-${h}.json`);
}

/**
 * Решение «что делать с эталоном» в чистой функции (ревью 331 Н6): есть файл —
 * load; файла нет и стоит явный env-флаг REMPLANNER_PROBE_READONLY_REF_INIT=1 —
 * create; иначе — refuse (молчаливое автосоздание базиса запрещено — инцидент
 * 328, 27→33→39). Юнит-тесты закрепляют все три ветки.
 */
export type ReadonlyRefDecision =
  | { action: "load" }
  | { action: "create" }
  | { action: "refuse"; reason: string };

export function readonlyRefDecision(refExists: boolean, initFlag: string | undefined): ReadonlyRefDecision {
  if (refExists) return { action: "load" };
  if (initFlag === "1") return { action: "create" };
  return {
    action: "refuse",
    reason:
      "эталон контрольного проекта отсутствует — СТОП (ревью 329 №7, 331 Н6). " +
      "Молчаливое создание базиса запрещено. Создать базис можно явно одной командой:\n" +
      "  REMPLANNER_PROBE_READONLY_REF_INIT=1 <проба> run\n" +
      "Перебазирование существующего эталона (контрольный проект изменился) — только " +
      "решение координатора с подтверждением пользователя.",
  };
}

/**
 * Гард контрольного проекта (ревью 319 №4, 322 N4): эталон ФИКСИРОВАННЫЙ и
 * ОБЩИЙ на пару READONLY — файл refPath никогда не перезаписывается. Ревью
 * 329 №7: отсутствующий эталон — ОТКАЗ с понятным текстом (молчаливое
 * автосоздание базиса запрещено — инцидент 328, изменение 27→33→39); создать
 * базис можно только явно: env REMPLANNER_PROBE_READONLY_REF_INIT=1 при запуске
 * пробы. Перебазирование (смена эталона после изменения контрольного проекта) —
 * только решение координатора с подтверждением пользователя.
 */
export async function readonlyGuard(session: SessionState, readonlyId: string, readonlyPlanId: string, refPath: string): Promise<ReadonlyGuard> {
  mkdirSync(dirname(refPath), { recursive: true });
  let reference: LoadedModel;
  // решение — чистая функция readonlyRefDecision (ревью 331 Н6), ветки закреплены тестами
  const decision = readonlyRefDecision(existsSync(refPath), process.env["REMPLANNER_PROBE_READONLY_REF_INIT"]);
  if (decision.action === "load") {
    reference = JSON.parse(readFileSync(refPath, "utf8")) as LoadedModel;
  } else if (decision.action === "create") {
    const cur = await loadModel(session, readonlyId, readonlyPlanId);
    if (cur.data_empty) {
      console.error("контрольный GET пустой (data_empty) — эталон не создаётся, отказ");
      process.exit(1);
    }
    reference = cur;
    writeFileSync(refPath, JSON.stringify(reference, null, 1) + "\n");
    console.error(`эталон контрольного проекта создан (явный флаг REMPLANNER_PROBE_READONLY_REF_INIT): ${refPath}`);
  } else {
    console.error(`эталон контрольного проекта: ${refPath}\n${decision.reason}`);
    process.exit(1);
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

/**
 * Обёртка записи с гардом контрольного проекта ПЕРЕД каждой записью
 * (ревью 321 N4): assertUnchanged(tag) перед project_save / page save.
 * guard === null не допускается в записывающих пробах с хелпером —
 * передаётся для проб, где гард уже отработал (read-only ветки).
 */
export function guardedSave(guard: ReadonlyGuard, save: () => Promise<unknown>): (tag: string) => Promise<unknown> {
  return async (tag: string) => {
    await guard.assertUnchanged(tag);
    return save();
  };
}

/** Ссылка на гард для проб, где save-сайты вне области видимости локального
 *  roGuard (top-level хелперы, finally) — ревью 321 N4. */
export type ReadonlyGuardRef = { current: ReadonlyGuard | null };

export function newGuardRef(): ReadonlyGuardRef {
  return { current: null };
}

/** assertUnchanged по ссылке (ревью 321 N4): гард создаётся до первой записи,
 *  поэтому null здесь означает «записей ещё не было» — сверка пропускается. */
export async function assertUnchangedRef(ref: ReadonlyGuardRef, tag: string): Promise<void> {
  await ref.current?.assertUnchanged(tag);
}

/** Решение координатора (ревью 321 N3г, задача 322 п.1г): старые записывающие
 *  пробы без probe-guard НЕ переписываются — их запуск запрещён. Вызывается
 *  первой исполняемой строкой такой пробы. */
export function refuseLegacyProbe(): void {
  throw new Error("устаревшая пишущая проба без гардов — запуск запрещён (ревью 321 N3г, решение координатора в задаче 322)");
}
