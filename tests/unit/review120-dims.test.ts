// Этап 120: закрытие R2 ревью 119 — сверка item-target больше не подставляет
// `?? 0`: наличие каждой компоненты point_delta_x/y сравнивается отдельно,
// потеря или появление компоненты — расхождение (серверная потеря поля
// пользовательских данных не должна проходить как verified), присутствующие
// числа — с прежним допуском. Ruler-target (форма split() без delta) сверяется
// по target_id/target_name, как в 118.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dimsMismatches } from "../../src/model/dims.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import type { Model, RulerEntity, RulerTarget } from "../../src/model/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

/** Предметная привязка с заданными delta (форма item-target, как в пробе 119). */
function itemTarget(id: string, dx: number | undefined, dy: number | undefined): RulerTarget {
  const t: Record<string, unknown> = { target_id: id, target_name: "sofa", target_plan: { a: 1 }, target_angle: 0 };
  if (dx !== undefined) t["point_delta_x"] = dx;
  if (dy !== undefined) t["point_delta_y"] = dy;
  return t as unknown as RulerTarget;
}

/** Один размер с предметной привязкой p2. */
function itemTargetModel(dx: number | undefined, dy: number | undefined): Model {
  const m = JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model };
  const model = m.model;
  model.rulers = {
    r1: {
      id: "r1", p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, p1_target: null, p2_target: itemTarget("item1", dx, dy),
      offset: { val: 0, side: "a" }, plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, color: "#ed143d",
    },
  } as unknown as Record<string, RulerEntity>;
  model.comments = {};
  return model;
}

test("120 R2: у item-target обе стороны без delta — не расхождение (форма не блокирует save)", () => {
  const m = itemTargetModel(undefined, undefined);
  const d = dimsMismatches(m, structuredClone(m) as unknown as Record<string, unknown>);
  assert.deepEqual(d, [], `обе стороны без delta — не расхождение: ${JSON.stringify(d)}`);
});

test("120 R2: у item-target delta (7,8) на обеих сторонах — не расхождение", () => {
  const m = itemTargetModel(7, 8);
  const d = dimsMismatches(m, structuredClone(m) as unknown as Record<string, unknown>);
  assert.deepEqual(d, [], `присутствующие равные delta — не расхождение: ${JSON.stringify(d)}`);
});

for (const [dx, dy, drop] of [
  [0, 0, "both"],
  [0, 7, "x"],
  [7, 0, "y"],
] as const) {
  test(`120 R2: потеря delta (${dx},${dy}), сервер удаляет ${drop === "both" ? "оба поля" : drop === "x" ? "point_delta_x" : "point_delta_y"} — расхождение`, () => {
    const m = itemTargetModel(dx, dy);
    const got = structuredClone(m) as unknown as Record<string, unknown>;
    const t = (got["rulers"] as Record<string, { p2_target: Record<string, unknown> }>)["r1"]!.p2_target;
    if (drop === "both") {
      delete t["point_delta_x"];
      delete t["point_delta_y"];
    } else if (drop === "x") delete t["point_delta_x"];
    else delete t["point_delta_y"];
    const d = dimsMismatches(m, got);
    assert.ok(d.some((s) => s.includes("r1") && s.includes("смещение привязки изменилось")), `потеря компоненты delta — расхождение: ${JSON.stringify(d)}`);
  });
}

/** Mock save с предметной привязкой (writeBackup/loadModel/openEditor подменены):
 *  normalize возвращает модель без изменений — checkLinkedRulers редактора
 *  пересчитывает только ruler-target, item-target не трогает. Искажение
 *  вносится после editor.save (сервер «потерял» поля), loadModel возвращает
 *  изменённый объект. */
function saveMockItem(server: { saveId: string; model: Record<string, unknown> }): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm as object) as Record<string, unknown>;
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() {
      return { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };
    },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: server.saveId, units: "cm", data_empty: false, model: structuredClone(server.model) };
    },
    async openEditor() { return editor; },
  };
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  return ws;
}

/** После записи сервер удаляет указанные поля delta у r1.p2_target. */
function dropDeltaAfterSave(ws: Workspace, server: { model: Record<string, unknown> }, fields: Array<"point_delta_x" | "point_delta_y">): void {
  void ws.deps.openEditor(ws.deps.session, "0", "1").then((editor) => {
    const origSave = editor.save.bind(editor);
    editor.save = async () => {
      const res = await origSave();
      const t = (server.model["rulers"] as Record<string, { p2_target: Record<string, unknown> }>)["r1"]!.p2_target;
      for (const f of fields) delete t[f];
      return res;
    };
  });
}

for (const [dx, dy, fields, what] of [
  [0, 0, ["point_delta_x", "point_delta_y"], "оба поля"],
  [0, 7, ["point_delta_x"], "point_delta_x"],
  [7, 0, ["point_delta_y"], "point_delta_y"],
] as const) {
  test(`120 R2: mock save, delta (${dx},${dy}), сервер удаляет ${what} — SITE_ERROR`, async () => {
    const m = itemTargetModel(dx, dy);
    const server: { saveId: string; model: Record<string, unknown> } = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMockItem(server);
    await ws.open("0", "1");
    dropDeltaAfterSave(ws, server, [...fields]);
    await assert.rejects(
      () => ws.save(),
      (err: { code?: string; details?: { dims_mismatches?: string[] } }) => {
        assert.equal(err.code, "SITE_ERROR", `код ошибки: ${err.code}`);
        assert.ok((err.details?.dims_mismatches ?? []).some((s) => s.includes("r1") && s.includes("смещение привязки изменилось")), `потеря delta обнаружена: ${JSON.stringify(err.details?.dims_mismatches)}`);
        return true;
      },
    );
  });
}

test("120 R2: mock save, у item-target обе стороны без delta — verified (форма не блокирует save)", async () => {
  const m = itemTargetModel(undefined, undefined);
  const server: { saveId: string; model: Record<string, unknown> } = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMockItem(server);
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, "item-target без delta на обеих сторонах сохраняется");
  assert.equal(res.rounds, 1);
});
