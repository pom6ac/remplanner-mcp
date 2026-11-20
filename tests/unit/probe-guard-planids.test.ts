// 322 N3а/N3б: юнит-тест хелпера probe-guard на фикстуре реального ответа GET.
// Своя пара проходит; план чужого объекта и PLAN_ID == READONLY_PLAN_ID — отказ.
// Форма floors — реальная из ответа GET /setup/api/planner/: объект {prev,next}
// (tests/fixtures/api-load-response.json, дампы .orca-reports/backup-*.json).
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  ProbeGuardError,
  checkNoReadonlyCollision,
  checkPlanMembership,
  planIdsOfFloors,
} from "../../scripts/probes/probe-guard.ts";
import type { ClientProject } from "../../src/api.ts";

const FIXTURE = JSON.parse(readFileSync("tests/fixtures/api-load-response.json", "utf8")) as { floors?: unknown };

test("planIdsOfFloors: реальная форма {prev,next} фикстуры распознаётся (пустой список планов)", () => {
  const plans = planIdsOfFloors(FIXTURE.floors);
  if (plans === null) throw new Error("форма {prev,next} должна распознаваться");
  if (plans.size !== 0) throw new Error(`ожидается пустой список планов, получено ${[...plans].join(",")}`);
});

test("planIdsOfFloors: этажи со списком планов собираются из prev и next", () => {
  const plans = planIdsOfFloors({
    prev: [{ floor_id: "f1", plans: ["1", "2"] }],
    next: [{ floor_id: "f2", plans: ["7"] }],
  });
  if (plans === null || plans.size !== 3 || !plans.has("1") || !plans.has("2") || !plans.has("7")) {
    throw new Error(`ожидается {1,2,7}, получено ${plans === null ? "null" : [...plans].join(",")}`);
  }
});

test("planIdsOfFloors: старая предполагаемая форма (массив этажей) НЕ распознаётся", () => {
  if (planIdsOfFloors([{ floor_id: "f1", plans: ["1"] }]) !== null) throw new Error("массив не форма GET");
  if (planIdsOfFloors("x") !== null) throw new Error("строка не форма GET");
  if (planIdsOfFloors({ prev: "x", next: [] }) !== null) throw new Error("prev не массив — не форма GET");
  if (planIdsOfFloors({ prev: [null], next: [] }) !== null) throw new Error("элемент без plans — не форма GET");
  if (planIdsOfFloors({ prev: [{ floor_id: "f1" }], next: [] }) !== null) throw new Error("этаж без plans — не форма GET");
  if (planIdsOfFloors(undefined) !== null) throw new Error("floors отсутствует — не форма GET");
});

test("checkPlanMembership: floors с планами — PLAN_ID в списке проходит", async () => {
  await checkPlanMembership("42", "1", { prev: [{ floor_id: "f1", plans: ["1", "2"] }], next: [] }, async () => {
    throw new Error("project_list не должен вызываться, если планы есть в GET");
  });
});

test("checkPlanMembership: PLAN_ID не входит в планы объекта GET — отказ", async () => {
  await checkPlanMembership(
    "42",
    "9",
    { prev: [{ floor_id: "f1", plans: ["1", "2"] }], next: [] },
    async () => [],
  ).then(
    () => { throw new Error("ожидался отказ"); },
    (e: unknown) => {
      if (!(e instanceof ProbeGuardError)) throw new Error(`ожидается ProbeGuardError, получено ${String(e)}`);
    },
  );
});

test("checkPlanMembership: планы из GET не выводятся — объект есть в project_list, пара проходит", async () => {
  const projects: ClientProject[] = [
    { object_id: "42", version: "v1", title: "dev", area_m2: null, floors: null, plans: null, backups: null, updated: null },
  ];
  await checkPlanMembership("42", "1", FIXTURE.floors, async () => projects);
});

test("checkPlanMembership: план чужого объекта — объекта нет в project_list, отказ", async () => {
  const projects: ClientProject[] = [
    { object_id: "777", version: "v1", title: "чужой", area_m2: null, floors: null, plans: null, backups: null, updated: null },
  ];
  await checkPlanMembership("42", "1", FIXTURE.floors, async () => projects).then(
    () => { throw new Error("ожидался отказ"); },
    (e: unknown) => {
      if (!(e instanceof ProbeGuardError)) throw new Error(`ожидается ProbeGuardError, получено ${String(e)}`);
      if (!e.message.includes("project_list")) throw new Error(`неожиданное сообщение: ${e.message}`);
    },
  );
});

test("checkNoReadonlyCollision: PLAN_ID == READONLY_PLAN_ID — отказ", () => {
  if (checkNoReadonlyCollisionSafe("42", "1", "43", "1") === null) throw new Error("ожидался отказ при PLAN_ID == READONLY_PLAN_ID");
});

test("checkNoReadonlyCollision: OBJECT_ID == READONLY_ID — отказ", () => {
  if (checkNoReadonlyCollisionSafe("42", "1", "42", "2") === null) throw new Error("ожидался отказ при OBJECT_ID == READONLY_ID");
});

test("checkNoReadonlyCollision: READONLY_ID или READONLY_PLAN_ID отсутствуют — отказ (322 N3б)", () => {
  if (checkNoReadonlyCollisionSafe("42", "1", "", "2") === null) throw new Error("ожидался отказ без READONLY_ID");
  if (checkNoReadonlyCollisionSafe("42", "1", "43", "") === null) throw new Error("ожидался отказ без READONLY_PLAN_ID");
});

test("checkNoReadonlyCollision: разные id и планы — проходит", () => {
  if (checkNoReadonlyCollisionSafe("42", "1", "43", "2") !== null) throw new Error("корректная пара не должна отказывать");
});

/** checkNoReadonlyCollision завершает процесс при отказе; для теста — ядро через ProbeGuardError. */
function checkNoReadonlyCollisionSafe(objectId: string, planId: string, readonlyId: string, readonlyPlanId: string): string | null {
  try {
    checkNoReadonlyCollision(objectId, planId, readonlyId, readonlyPlanId);
    return null;
  } catch (e) {
    if (!(e instanceof ProbeGuardError)) throw e;
    return e.message;
  }
}
