// Ревью v0.1.1 раунд 2 R2-3: сумма покрытия осей (wallAxisCoverageCm) не равна
// геометрической эквивалентности — сдвинутый прямоугольник, замена стены равной
// длины и лишняя стена давали то же число. Эквивалентность — по каноническому
// набору осевых отрезков (wallAxisSegments + wallAxisSetsEqual): коллинеарные
// перекрывающиеся отрезки на каждой прямой объединены, координаты округлены до
// 1 мм, множества сравнены с допуском 1 мм в обе стороны.
import test from "node:test";
import assert from "node:assert/strict";
import {
  wallAxisSegments,
  wallAxisSetsEqual,
  wallAxisCoverageCm,
} from "../../src/model/walls.ts";
import { buildHandle } from "../../src/editor/adapter.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { Model, Wall } from "../../src/model/types.ts";
import type { LoadedModel } from "../../src/api.ts";

function wall(id: string, p1: { x: number; y: number }, p2: { x: number; y: number }): Wall {
  return { id, plan: "a", role: "wall", depth: 10, height: 270, p1, p2, holes: {}, material: "a_brick" } as unknown as Wall;
}

function model(walls: Wall[]): Model {
  const m = { v: 3, id: "x", plan_id: "1", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: true } as unknown as Model;
  for (const w of walls) m.walls[w.id] = w;
  return m;
}

/** Прямоугольная комната 400×300. */
function rectModel(shiftX = 0, shiftY = 0): Model {
  return model([
    wall("top", { x: shiftX, y: shiftY }, { x: shiftX + 400, y: shiftY }),
    wall("right", { x: shiftX + 400, y: shiftY }, { x: shiftX + 400, y: shiftY + 300 }),
    wall("bottom", { x: shiftX, y: shiftY + 300 }, { x: shiftX + 400, y: shiftY + 300 }),
    wall("left", { x: shiftX, y: shiftY }, { x: shiftX, y: shiftY + 300 }),
  ]);
}

test("segments: слияние двух коллинеарных стен — эквивалентно", () => {
  const whole = rectModel();
  const split = model([
    wall("top", { x: 0, y: 0 }, { x: 250, y: 0 }),
    wall("top2", { x: 250, y: 0 }, { x: 400, y: 0 }),
    wall("right", { x: 400, y: 0 }, { x: 400, y: 300 }),
    wall("bottom", { x: 0, y: 300 }, { x: 400, y: 300 }),
    wall("left", { x: 0, y: 0 }, { x: 0, y: 300 }),
  ]);
  assert.ok(wallAxisSetsEqual(wallAxisSegments(split.walls), wallAxisSegments(whole.walls)));
  assert.ok(wallAxisSetsEqual(wallAxisSegments(whole.walls), wallAxisSegments(split.walls)), "симметрично");
  // перекрывающиеся (не стык в стык) тоже эквивалентны
  const overlap = model([
    wall("top", { x: 0, y: 0 }, { x: 300, y: 0 }),
    wall("top2", { x: 100, y: 0 }, { x: 400, y: 0 }),
    wall("right", { x: 400, y: 0 }, { x: 400, y: 300 }),
    wall("bottom", { x: 0, y: 300 }, { x: 400, y: 300 }),
    wall("left", { x: 0, y: 0 }, { x: 0, y: 300 }),
  ]);
  assert.ok(wallAxisSetsEqual(wallAxisSegments(overlap.walls), wallAxisSegments(whole.walls)));
});

test("segments: разрез стены на две — эквивалентно", () => {
  const whole = rectModel();
  const cut = model([
    wall("top", { x: 0, y: 0 }, { x: 400, y: 0 }),
    wall("right", { x: 400, y: 0 }, { x: 400, y: 300 }),
    wall("bottom", { x: 0, y: 300 }, { x: 400, y: 300 }),
    wall("left1", { x: 0, y: 0 }, { x: 0, y: 150 }),
    wall("left2", { x: 0, y: 150 }, { x: 0, y: 300 }),
  ]);
  assert.ok(wallAxisSetsEqual(wallAxisSegments(cut.walls), wallAxisSegments(whole.walls)));
});

test("segments: сдвиг прямоугольника на 10 см — НЕ эквивалентно", () => {
  const a = wallAxisSegments(rectModel().walls);
  const b = wallAxisSegments(rectModel(10, 0).walls);
  assert.equal(wallAxisCoverageCm(rectModel().walls), wallAxisCoverageCm(rectModel(10, 0).walls), "сумма длин одинакова — старая проверка пропускала");
  assert.equal(wallAxisSetsEqual(a, b), false);
  assert.equal(wallAxisSetsEqual(b, a), false);
  // сдвиг по диагонали тоже ловится
  assert.equal(wallAxisSetsEqual(a, wallAxisSegments(rectModel(10, 10).walls)), false);
});

test("segments: лишняя стена — НЕ эквивалентно", () => {
  const base = wallAxisSegments(rectModel().walls);
  const extra = model([
    wall("top", { x: 0, y: 0 }, { x: 400, y: 0 }),
    wall("right", { x: 400, y: 0 }, { x: 400, y: 300 }),
    wall("bottom", { x: 0, y: 300 }, { x: 400, y: 300 }),
    wall("left", { x: 0, y: 0 }, { x: 0, y: 300 }),
    wall("inner", { x: 100, y: 0 }, { x: 100, y: 100 }),
  ]);
  assert.equal(wallAxisSetsEqual(base, wallAxisSegments(extra.walls)), false, "лишнее покрытие отвергается");
  // лишняя коллинеарная часть на существующей прямой тоже
  const extended = model([
    wall("top", { x: -50, y: 0 }, { x: 400, y: 0 }),
    wall("right", { x: 400, y: 0 }, { x: 400, y: 300 }),
    wall("bottom", { x: 0, y: 300 }, { x: 400, y: 300 }),
    wall("left", { x: 0, y: 0 }, { x: 0, y: 300 }),
  ]);
  assert.equal(wallAxisSetsEqual(base, wallAxisSegments(extended.walls)), false);
});

test("segments: замена стены равной длины на другую — НЕ эквивалентно", () => {
  const base = wallAxisSegments(rectModel().walls);
  const swapped = rectModel();
  swapped.walls["left"] = wall("left", { x: 50, y: 0 }, { x: 50, y: 300 });
  assert.equal(wallAxisSetsEqual(base, wallAxisSegments(swapped.walls)), false);
});

test("segments: округление до 1 мм — микросдвиг в допуске эквивалентен", () => {
  const a = wallAxisSegments(rectModel().walls);
  const jitter = rectModel();
  jitter.walls["top"] = wall("top", { x: 0, y: 0.05 }, { x: 400, y: 0.05 });
  assert.ok(wallAxisSetsEqual(a, wallAxisSegments(jitter.walls)), "0.5 мм — в допуске");
  const bigJitter = rectModel();
  bigJitter.walls["top"] = wall("top", { x: 0, y: 0.2 }, { x: 400, y: 0.2 });
  assert.equal(wallAxisSetsEqual(a, wallAxisSegments(bigJitter.walls)), false, "2 мм — за допуском");
});

const COMPAT = { global_version: "1", planner_version: "3", bundles: [], object_id: "123", plan_id: "1",
  present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

function normalizePage(resultProvider: (input: Model) => { copy: Record<string, unknown>; after: { walls: number; holes: number; items: number } }) {
  let arg: unknown;
  const page = {
    async evaluate(fn: string | ((a?: unknown) => unknown), a?: unknown): Promise<unknown> {
      if (typeof fn === "function") { arg = a; return {}; }
      const src = String(fn);
      if (src.includes("planner_ui_message_fog")) return true;
      if (src.includes("$Project.restore")) {
        const input = (arg as { model: Model }).model;
        return resultProvider(input);
      }
      return {};
    },
    async waitForTimeout(_ms: number) {},
  };
  return { page: page as never, getInput: () => (arg as { model: Model }).model };
}

test("adapter: редактор СДВИНУЛ геометрию (то же покрытие) → NORMALIZATION_DROPPED", async () => {
  const { page } = normalizePage((input) => {
    const m = structuredClone(input) as unknown as Model;
    // сдвигаем левую стену на 10 см внутрь: число стен и сумма длин сохраняются
    m.walls["left2"] = wall("left2", { x: 10, y: 0 }, { x: 10, y: 300 });
    return {
      copy: m as unknown as Record<string, unknown>,
      after: { walls: Object.keys(m.walls).length, holes: 0, items: 0 },
    };
  });
  const handle = buildHandle(page, { close: async () => {} }, "123", "1", COMPAT, { acquire: async () => {} });
  const input = model([
    wall("top", { x: 0, y: 0 }, { x: 400, y: 0 }),
    wall("right", { x: 400, y: 0 }, { x: 400, y: 300 }),
    wall("bottom", { x: 0, y: 300 }, { x: 400, y: 300 }),
    wall("left2", { x: 0, y: 0 }, { x: 0, y: 300 }),
  ]);
  await assert.rejects(
    handle.normalize(input as unknown as Record<string, unknown>),
    (e: unknown) => (e as { code?: string }).code === "NORMALIZATION_DROPPED",
  );
});

function workspaceMock(serverModel: Model, normalizeFn: EditorLike["normalize"]) {
  let server = structuredClone(serverModel);
  const editor: EditorLike = {
    objectId: "123", planId: "1",
    normalize: normalizeFn,
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]); },
    async compatInfo() { throw new Error("not used"); },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(_s, _o, _p): Promise<LoadedModel> {
      return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", model: structuredClone(server) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
  return { deps, setServer: (m: Model) => { server = m; } };
}

test("workspace: save верифицируется по набору отрезков — лишняя стена на сервере → SITE_ERROR", async () => {
  const base = rectModel();
  const { deps, setServer } = workspaceMock(base, async (m) => ({
    model: structuredClone(m) as unknown as Record<string, unknown>,
    rooms: [], before: { walls: 4, holes: 0, items: 0 }, after: { walls: 4, holes: 0, items: 0 },
  }));
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  // сервер «поднял» устаревшую модель с лишней стеной: суммаcoverage выросла —
  // прежняя проверка `coverageAfter >= expected - tol` пропускала это как verified
  const withExtra = rectModel();
  withExtra.walls["inner"] = wall("inner", { x: 100, y: 0 }, { x: 100, y: 100 });
  setServer(withExtra);
  await assert.rejects(
    ws.save(),
    (e: unknown) => (e as { code?: string }).code === "SITE_ERROR",
  );
});

test("workspace: render_plan при сдвинутой геометрии редактора → RENDER_OUT_OF_SYNC", async () => {
  const base = rectModel();
  const { deps } = workspaceMock(base, async (m) => {
    const shifted = structuredClone(m) as unknown as Model;
    // редактор сдвинул левую стену на 10 см: сумма длин та же
    shifted.walls["left"] = wall("left", { x: 10, y: 0 }, { x: 10, y: 300 });
    return {
      model: shifted as unknown as Record<string, unknown>,
      rooms: [], before: { walls: 4, holes: 0, items: 0 }, after: { walls: 4, holes: 0, items: 0 },
    };
  });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  await assert.rejects(
    ws.renderPlan({ sheet: "init", dir: "/tmp/remplanner-r2-segments" }),
    (e: unknown) => (e as { code?: string }).code === "RENDER_OUT_OF_SYNC",
  );
});
