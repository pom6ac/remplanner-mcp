// Ревью v0.1.1 №4: точное равенство числа стен отвергало допустимую нормализацию —
// редактор сливает коллинеарные стены (design §12: разрез/слияние). Сравнивается то,
// что важно для рендера: покрытие осей стен (wallAxisCoverageCm); предметы и проёмы —
// по id. NORMALIZATION_DROPPED не должен маскировать слияние, но ловит реальную потерю.
// R2-1: save-тесты пишут бэкапы — состояние изолируется во временный каталог.
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { buildHandle } from "../../src/editor/adapter.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import { wallAxisCoverageCm, wallCoverageToleranceCm } from "../../src/model/walls.ts";
import type { Model, Wall } from "../../src/model/types.ts";
import type { LoadedModel } from "../../src/api.ts";

function wall(id: string, p1: { x: number; y: number }, p2: { x: number; y: number }): Wall {
  return { id, plan: "a", role: "wall", depth: 10, height: 270, p1, p2, holes: {}, material: "a_brick" } as unknown as Wall;
}

/** Прямоугольная комната 400×300 см; split — левая стена разрезана пополам (5 стен). */
function roomModel(split: boolean): Model {
  const m = { v: 3, id: "x", plan_id: "1", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: true } as unknown as Model;
  m.walls["top"] = wall("top", { x: 0, y: 0 }, { x: 400, y: 0 });
  m.walls["right"] = wall("right", { x: 400, y: 0 }, { x: 400, y: 300 });
  m.walls["bottom"] = wall("bottom", { x: 0, y: 300 }, { x: 400, y: 300 });
  if (split) {
    m.walls["left1"] = wall("left1", { x: 0, y: 0 }, { x: 0, y: 150 });
    m.walls["left2"] = wall("left2", { x: 0, y: 150 }, { x: 0, y: 300 });
  } else {
    m.walls["left"] = wall("left", { x: 0, y: 0 }, { x: 0, y: 300 });
  }
  return m;
}

test("coverage: слияние и разрез коллинеарных стен сохраняют покрытие осей", () => {
  const whole = wallAxisCoverageCm(roomModel(false).walls);
  const split = wallAxisCoverageCm(roomModel(true).walls);
  assert.ok(Math.abs(whole - split) < 1e-9, `цельная ${whole} == разрезанной ${split}`);
  // потеря стены уменьшает покрытие сильнее допуска
  const lost = { ...roomModel(false).walls };
  delete lost["left"];
  assert.ok(wallAxisCoverageCm(lost) < whole - wallCoverageToleranceCm(whole));
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

test("adapter: редактор СЛИЛ коллинеарные стены (стало меньше, покрытие то же) — не NORMALIZATION_DROPPED", async () => {
  const { page } = normalizePage((input) => {
    // слияние: left1 + left2 → одна стена left
    const merged = structuredClone(input) as unknown as Model;
    delete merged.walls["left1"];
    delete merged.walls["left2"];
    merged.walls["left"] = wall("left", { x: 0, y: 0 }, { x: 0, y: 300 });
    return {
      copy: merged as unknown as Record<string, unknown>,
      after: { walls: Object.keys(merged.walls).length, holes: 0, items: 0 },
    };
  });
  const handle = buildHandle(page, { close: async () => {} }, "123", "1", COMPAT, { acquire: async () => {} });
  const res = await handle.normalize(roomModel(true) as unknown as Record<string, unknown>);
  assert.equal(res.after.walls, 4, "стало меньше стен — слияние");
});

test("adapter: реальная потеря стены (покрытие меньше) → NORMALIZATION_DROPPED", async () => {
  const { page } = normalizePage((input) => {
    const m = structuredClone(input) as unknown as Model;
    delete m.walls["left1"]; // стена исчезла, покрытия нет
    return {
      copy: m as unknown as Record<string, unknown>,
      after: { walls: Object.keys(m.walls).length, holes: 0, items: 0 },
    };
  });
  const handle = buildHandle(page, { close: async () => {} }, "123", "1", COMPAT, { acquire: async () => {} });
  await assert.rejects(
    handle.normalize(roomModel(true) as unknown as Record<string, unknown>),
    (e: unknown) => (e as { code?: string }).code === "NORMALIZATION_DROPPED",
  );
});

function workspaceMock(serverModel: Model, normalizeFn: EditorLike["normalize"]) {
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
      return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", model: structuredClone(serverModel) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
  return deps;
}

test("workspace: save при слиянии стен редактором проходит (verified), покрытие сохранено", async () => {
  const merged = roomModel(false);
  const deps = workspaceMock(merged, async (model) => {
    // редактор слил две коллинеарные стены
    const m = structuredClone(model) as unknown as Model;
    delete m.walls["left1"];
    delete m.walls["left2"];
    m.walls["left"] = wall("left", { x: 0, y: 0 }, { x: 0, y: 300 });
    return { model: m as unknown as Record<string, unknown>, rooms: [], before: { walls: 5, holes: 0, items: 0 }, after: { walls: 4, holes: 0, items: 0 } };
  });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  // офлайн-мутация без нормализации: локально левая стена разрезана на две
  ws.apply("split", (m) => {
    const left = m.walls["left"]!;
    m.walls["left1"] = wall("left1", left.p1, { x: 0, y: 150 });
    m.walls["left2"] = wall("left2", { x: 0, y: 150 }, left.p2);
    delete m.walls["left"];
    return true;
  });
  const res = await ws.save();
  assert.equal(res.verified, true, "сохранение с допустимым слиянием верифицировано");
});

test("workspace: save при потере стены → NORMALIZATION_DROPPED", async () => {
  const deps = workspaceMock(roomModel(false), async (model) => {
    const m = structuredClone(model) as unknown as Model;
    delete m.walls["left1"];
    return { model: m as unknown as Record<string, unknown>, rooms: [], before: { walls: 5, holes: 0, items: 0 }, after: { walls: 4, holes: 0, items: 0 } };
  });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  ws.apply("split", (m) => {
    const left = m.walls["left"]!;
    m.walls["left1"] = wall("left1", left.p1, { x: 0, y: 150 });
    m.walls["left2"] = wall("left2", { x: 0, y: 150 }, left.p2);
    delete m.walls["left"];
    return true;
  });
  await assert.rejects(ws.save(), (e: unknown) => (e as { code?: string }).code === "NORMALIZATION_DROPPED");
});

test("workspace: render_plan при слиянии стен не даёт RENDER_OUT_OF_SYNC, при потере — даёт", async () => {
  const model = roomModel(true);
  const deps = workspaceMock(model, async (m) => {
    const merged = structuredClone(m) as unknown as Model;
    delete merged.walls["left1"];
    delete merged.walls["left2"];
    merged.walls["left"] = wall("left", { x: 0, y: 0 }, { x: 0, y: 300 });
    return { model: merged as unknown as Record<string, unknown>, rooms: [], before: { walls: 5, holes: 0, items: 0 }, after: { walls: 4, holes: 0, items: 0 } };
  });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const dir = "/tmp/remplanner-review3-render";
  const res = await ws.renderPlan({ sheet: "init", dir });
  assert.ok(res.revision, "слияние — не расхождение");
  assert.equal(res.revision!.editor.walls, 4);
  assert.equal(res.revision!.walls, 5, "в ревизии — счётчик модели workspace");

  const depsLoss = workspaceMock(model, async (m) => {
    const lost = structuredClone(m) as unknown as Model;
    delete lost.walls["left1"];
    return { model: lost as unknown as Record<string, unknown>, rooms: [], before: { walls: 5, holes: 0, items: 0 }, after: { walls: 4, holes: 0, items: 0 } };
  });
  const wsLoss = new Workspace(depsLoss);
  await wsLoss.open("123", "1");
  await assert.rejects(
    wsLoss.renderPlan({ sheet: "init", dir }),
    (e: unknown) => (e as { code?: string }).code === "RENDER_OUT_OF_SYNC",
  );
});
