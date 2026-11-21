// Ревью 335 M1: полный путь — комната с двухуровневым потолком исчезает при
// wall_delete → отказ с подсказкой (какая отделка мешает и порядок снятия) →
// выполнение подсказанного пути (finish_ceiling_set другим покрытием →
// finish_ceiling_remove) → wall_delete проходит. Офлайн: Workspace с mock
// редактором normalize, который как настоящий редактор пересобирает комнаты
// (комната, чья стена удалена, исчезает из rooms2).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import type { Model } from "../../src/model/types.ts";
import { deleteWall } from "../../src/model/walls.ts";
import { setCeilingFinish, removeCeilingFinish } from "../../src/model/finish.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function corridorModel(): Model {
  const env = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/editor-corridor-3rooms.json"), "utf8")) as { model: Model };
  return structuredClone(env.model);
}

/** Mock normalize: как настоящий редактор, комнаты пересобраны — dropRooms
 *  исчезли (их стены удалены), остальное без изменений. */
function mockEditor(dropRooms: string[]): EditorLike {
  return {
    objectId: "123", planId: "1",
    async normalize(model) {
      const copy = structuredClone(model) as Record<string, unknown>;
      const rooms = (copy["rooms2"] ?? {}) as Record<string, unknown>;
      for (const rid of dropRooms) delete rooms[rid];
      return {
        model: copy,
        rooms: [],
        before: { walls: 0, holes: 0, items: 0 },
        after: { walls: 0, holes: 0, items: 0 },
        walls: [],
        errors: null,
      };
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { global_version: "757", planner_version: "3", bundles: [], object_id: "123", plan_id: "1", present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } } as never; },
    async close() {},
  };
}

function deps(editor: EditorLike, model: Model): WorkspaceDeps {
  return {
    session: { cookies: [] },
    async loadModel(_s, _o, _p): Promise<LoadedModel> {
      return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", model: structuredClone(model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
}

/** Средняя верхняя комната (x 310..490) с двухуровневым потолком; стена w7
 *  (x=500) — её граница. */
function modelWithComplex(): Model {
  const m = corridorModel();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  const room = rooms["_dvxjh"]!;
  room["ceilings"] = [{
    exist: true,
    id: "_cx1",
    material: "gypsum_ceiling",
    material2: "stretch_ceiling",
    level: 15,
    level2: 75,
    offset: 40,
    radius: 10,
    type: "closed",
    profile: "standard",
    complex: true,
    polygon: structuredClone(room["polygon"]),
  }];
  return m;
}

test("335 M1: wall_delete при complex-отделке исчезающей комнаты — отказ с подсказкой, подсказанный путь проходит, wall_delete проходит", async () => {
  const ws = new Workspace(deps(mockEditor(["_dvxjh"]), modelWithComplex()));
  await ws.open("123", "1");
  // 1. wall_delete → отказ с подсказкой (не общий текст из дюжины категорий)
  await assert.rejects(
    ws.applyWalls("wall_delete", (m) => deleteWall(m, "w7")),
    (e: unknown) => {
      const err = e as { code?: string; message?: string; details?: Record<string, unknown> };
      assert.equal(err.code, "INVALID_GEOMETRY");
      assert.match(err.message ?? "", /двухуровнев/, `в отказе назван двухуровневый потолок: ${err.message}`);
      assert.match(err.message ?? "", /finish_ceiling_set/, `в отказе первый шаг снятия: ${err.message}`);
      assert.match(err.message ?? "", /finish_ceiling_remove/, `в отказе ластик: ${err.message}`);
      const mismatches = err.details?.["finish_mismatches"] as string[] | undefined;
      assert.ok(Array.isArray(mismatches) && mismatches.some((p) => p.includes("_dvxjh")), `finish_mismatches с фактическим расхождением: ${JSON.stringify(err.details)}`);
      return true;
    },
  );
  // модель не изменилась: complex на месте
  const rooms0 = (ws.model.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  assert.equal((rooms0["_dvxjh"]!.ceilings as Array<Record<string, unknown>>)[0]!.complex, true, "после отказа complex на месте");
  // 2. подсказанный путь: смена материала (complex_removed) → ластик
  const changed = ws.apply("finish_ceiling_set", (m) => setCeilingFinish(m, "_dvxjh", "stretch_ceiling", {}));
  assert.equal(changed.complexRemoved, true, "смена материала снимает complex");
  ws.apply("finish_ceiling_remove", (m) => { removeCeilingFinish(m, "_dvxjh"); return true; });
  const rooms1 = (ws.model.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  const ceilings1 = (rooms1["_dvxjh"]!.ceilings ?? []) as Array<Record<string, unknown>>;
  assert.ok(ceilings1.every((c) => c.exist !== true), "покрытие снято");
  // 3. wall_delete проходит
  const res = await ws.applyWalls("wall_delete", (m) => deleteWall(m, "w7"));
  assert.ok(res, "wall_delete после снятия отделки проходит");
  assert.equal(JSON.stringify((ws.model.rooms2 as Record<string, unknown>)["_dvxjh"]), undefined, "комната исчезла после нормализации");
});
