// Этап 118: закрытие R2 повторного ревью 117 — штатная связь цепочки размеров
// из UI (Ruler.split() пишет p2_target={target_id, target_name:"ruler"} без
// point_delta/target_plan/target_angle, эталон .orca-reports/phase2-ui-refs/
// 113-ruler-src-full.json). Сверка не должна считать неизменившуюся связь
// расхождением (undefined−undefined → NaN), Workspace.save не блокируется.
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

/** Точная форма связи из split() редактора: без point_delta и производных. */
function rulerTarget(id: string): RulerTarget {
  return { target_id: id, target_name: "ruler" } as unknown as RulerTarget;
}

/** Цепочка из 4 размеров в форме UI (113-ruler-src-full.json): r_i.p2_target →
 *  r_{i-1} и r_i.p2 = r_{i-1}.p1 (порядок источника — как у checkLinkedRulers).
 *  closed=true — замкнутая цепь: r1.p2_target → r4. */
function uiChainModel(closed: boolean): Model {
  const m = JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model };
  const model = m.model;
  const base = { offset: { val: 0, side: "a" as const }, plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, color: "#ed143d" };
  const mk = (id: string, x1: number, x2: number, target: RulerTarget | null): RulerEntity =>
    ({ id, p1: { x: x1, y: 0 }, p2: { x: x2, y: 0 }, p1_target: null, p2_target: target, ...base }) as unknown as RulerEntity;
  model.rulers = {
    r1: mk("r1", 0, closed ? 400 : 100, closed ? rulerTarget("r4") : null),
    r2: mk("r2", 200, 0, rulerTarget("r1")),
    r3: mk("r3", 300, 200, rulerTarget("r2")),
    r4: mk("r4", 400, 300, rulerTarget("r3")),
  } as unknown as Record<string, RulerEntity>;
  model.comments = {};
  return model;
}

test("118 R2: самосравнение UI-цепочки из 4 размеров (target без delta, форма split()) — расхождений нет", () => {
  const m = uiChainModel(false);
  const d = dimsMismatches(m, structuredClone(m) as unknown as Record<string, unknown>);
  assert.deepEqual(d, [], `штатная UI-цепочка не расхождение: ${JSON.stringify(d)}`);
});

test("118 R2: самосравнение замкнутой UI-цепочки — расхождений нет", () => {
  const m = uiChainModel(true);
  const d = dimsMismatches(m, structuredClone(m) as unknown as Record<string, unknown>);
  assert.deepEqual(d, [], `замкнутая UI-цепочка не расхождение: ${JSON.stringify(d)}`);
});

/** Mock save (writeBackup/loadModel/openEditor подменены): normalize повторяет
 *  checkLinkedRulers редактора — конец прицепленного (p2_target → ruler) равен
 *  p1 источника; трансформаций больше нет. */
function saveMockPlain(server: { saveId: string; model: Record<string, unknown> }): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm as object) as Record<string, unknown>;
      const rulers = (normalized as Record<string, unknown>)["rulers"] as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number }; p2_target: { target_id: string; target_name: string } | null }> | undefined;
      if (rulers) {
        for (const r of Object.values(rulers)) {
          if (r.p2_target && r.p2_target.target_name === "ruler" && rulers[r.p2_target.target_id]) {
            r.p2 = { ...rulers[r.p2_target.target_id]!.p1 };
          }
        }
      }
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

test("118 R2: mock save штатной UI-цепочки — verified, без NORMALIZATION_DROPPED", async () => {
  const m = uiChainModel(false);
  const server: { saveId: string; model: Record<string, unknown> } = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMockPlain(server);
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, "штатная UI-форма сохраняется без ложной блокировки");
  assert.equal(res.rounds, 1);
});

test("118 R2: mock save замкнутой UI-цепочки — verified", async () => {
  const m = uiChainModel(true);
  const server: { saveId: string; model: Record<string, unknown> } = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMockPlain(server);
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, "замкнутая цепь сохраняется без ложной блокировки");
  assert.equal(res.rounds, 1);
});

test("118 R2: подмена target_id сервером в UI-цепочке — SITE_ERROR (сверку не ослабляем)", async () => {
  const m = uiChainModel(false);
  const server: { saveId: string; model: Record<string, unknown> } = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMockPlain(server);
  // подмена target_id привязки r2 после записи (сервер исказил связь цепочки)
  ws.writeBackup = () => "/mock/no-write";
  await ws.open("0", "1");
  const editor = await ws.deps.openEditor(ws.deps.session, "0", "1");
  const origSave = editor.save.bind(editor);
  editor.save = async () => {
    const res = await origSave();
    const rulers = server.model["rulers"] as Record<string, { p2_target: { target_id: string; target_name: string } | null }>;
    rulers["r2"]!.p2_target = { target_id: "rX", target_name: "ruler" };
    return res;
  };
  await assert.rejects(
    () => ws.save(),
    (err: { code?: string; details?: { dims_mismatches?: string[] } }) => {
      assert.equal(err.code, "SITE_ERROR", `код ошибки: ${err.code}`);
      assert.ok((err.details?.dims_mismatches ?? []).some((s) => s.includes("r2") && s.includes("привязка сменилась")), `расхождение привязки найдено: ${JSON.stringify(err.details?.dims_mismatches)}`);
      return true;
    },
  );
});
