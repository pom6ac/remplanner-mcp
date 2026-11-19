// Ревью 241 (PR #36 «электрика ч.2»): резолюция находок.
// №1 (major): граф-коллекции схемы импорта выводятся из реестра
// MODEL_ENTITY_COLLECTIONS — новые cables_socket/warm_floor/conditioner проходят
// схему графа и лимиты; сторож: каждая граф-коллекция реестра отклоняет мусорную
// сущность, лимит MAX_IMPORT_ENTITIES действует.
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { parseModelImport } from "../../src/model/import-schema.ts";
import { MODEL_ENTITY_COLLECTIONS } from "../../src/model/collections.ts";
import { MAX_IMPORT_ENTITIES } from "../../src/limits.ts";
import { McpError } from "../../src/errors.ts";

function baseModel(): Record<string, unknown> {
  return {
    v: 3, id: "0", plan_id: "0",
    walls: {}, items: {}, pillars: {}, rulers: {}, comments: {},
    total_height: 270, final: true,
  };
}

// Коллекции, у которых своя (не графовая) схема: обязательные и предметы/ригели/
// линейки/комментарии. Всё остальное в реестре — графы (graphEntity).
const NON_GRAPH_COLLECTIONS = new Set(["walls", "items", "pillars", "rigels", "rulers", "comments"]);

function garbageEntity(): Record<string, unknown> {
  return { id: "e0", vertexes: "garbage", matrix: 5, items: 7, length: -1 };
}

test("ревью 241 №1: каждая граф-коллекция реестра есть в схеме импорта (мусор отклоняется)", () => {
  const graphColls = MODEL_ENTITY_COLLECTIONS.filter((c) => !NON_GRAPH_COLLECTIONS.has(c));
  assert.ok(graphColls.includes("cables_socket"), "cables_socket — граф-коллекция реестра");
  assert.ok(graphColls.includes("cables_warm_floor"), "cables_warm_floor — граф-коллекция реестра");
  assert.ok(graphColls.includes("cables_conditioner"), "cables_conditioner — граф-коллекция реестра");
  for (const coll of graphColls) {
    assert.throws(
      () => parseModelImport({ ...baseModel(), [coll]: { e0: garbageEntity() } }),
      (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT",
      `${coll}: мусорная сущность должна отклоняться схемой графа`,
    );
  }
});

test("ревью 241 №1: лимит MAX_IMPORT_ENTITIES действует для cables_socket", () => {
  const entities: Record<string, unknown> = {};
  for (let i = 0; i <= MAX_IMPORT_ENTITIES; i++) entities[`e${i}`] = { id: `e${i}` };
  assert.throws(
    () => parseModelImport({ ...baseModel(), cables_socket: entities }),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT"
      && String((e as McpError).message).includes("слишком много сущностей"),
    `больше ${MAX_IMPORT_ENTITIES} сущностей — отказ`,
  );
});
