// 112: закрытие переоткрытой major R10 из ревью 111 (.orca-reports/111-rereview3-replan.md).
// Тест, падающий на 260da3d: split с зазором в normalize пропускает новый разрыв
// стыка — наследование свободного конца переносилось по прежнему wallId.node на
// внутренний узел разреза, а независимый `some` оправдывал одной точкой оба конца.
// Ревью 111: не переносить наследование на внутренний узел разреза (внутренние
// узлы разреза ожидаемо соединены); сопоставление унаследованных концов
// один-к-одному.
// Ревью 144 M1 (PR #19): разрыв стыка после split — оторванный нормализатором
// соединённый конец, снова INVALID_GEOMETRY (предупреждение только для концов,
// свободных уже в кандидате).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model, Wall } from "../../src/model/types.ts";
import { addWall, splitWall, findUnattachedEnds } from "../../src/model/walls.ts";
import { prepareHolePoints } from "../../src/model/openings.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { NormalizeResult } from "../../src/editor/adapter.ts";
import type { LoadedModel } from "../../src/api.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

/** Свободная горизонтальная стена 6000 мм на оси y=-6000 (2 несоединённых конца). */
function probeWall(m: Model): Wall {
  prepareHolePoints(m);
  return addWall(m, { start: { x: 0, y: -6000 }, end: { x: 6000, y: -6000 } });
}

/**
 * Нормализатор пробы ревью 111: после split сдвигает p1 второй половины
 * (точка разреза (300,-600)) на gapCm — mock разрыва стыка.
 */
function gapAfterSplitEditor(gapCm: number): EditorLike {
  return {
    objectId: "123", planId: "1",
    async normalize(model) {
      const copy = structuredClone(model) as Model & Record<string, unknown>;
      if (gapCm > 0) {
        const second = Object.values(copy.walls).find(
          (w) => w.p1.x === 300 && w.p1.y === -600 && w.p2.x === 600 && w.p2.y === -600,
        );
        if (second) second.p1.x += gapCm;
      }
      const walls = Object.values(copy.walls).map((w) => ({ id: w.id, p1: w.p1, p2: w.p2, depth: w.depth }));
      const c = { walls: walls.length, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: copy, rooms: [], before: c, after: c, walls, errors: null } as unknown as NormalizeResult;
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { global_version: null, planner_version: null, bundles: [], object_id: "123", plan_id: "1", present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } } as never; },
    async close() {},
  };
}

function wsDeps(editor: EditorLike, model: Model): WorkspaceDeps {
  return {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", data_empty: false, model: structuredClone(model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
}

function wsWithIsolatedWall(editor: EditorLike): { ws: Workspace; isolated: Wall } {
  const m = baseModel();
  const isolated = probeWall(m);
  return { ws: new Workspace(wsDeps(editor, m)), isolated };
}

// ---------- Workspace: fault injection в нормализатор на разрезанной стене ----------

test("142/144: разрыв стыка 2 мм после split в normalize — INVALID_GEOMETRY (нормализатор оторвал соединённый конец)", async () => {
  const { ws, isolated } = wsWithIsolatedWall(gapAfterSplitEditor(0.2));
  await ws.open("123", "1");
  await assert.rejects(
    ws.applyWalls("wall_split", (mm) => splitWall(mm, isolated.id, 3000)),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, "INVALID_GEOMETRY");
      assert.match((e as Error).message, /оторвал соединённый конец/, (e as Error).message);
      assert.match((e as Error).message, /\(3000; -6000\)/, "точка разрыва внутреннего стыка в мм");
      return true;
    },
  );
  // результат split не применён: модель без второй половины
  const halves = Object.values(ws.model.walls as Record<string, Wall>).filter((w) => Math.abs(w.p1.y + 600) < 1e-9 && Math.abs(w.p2.y + 600) < 1e-9);
  assert.equal(halves.length, 1, "разрез откачен: исходная стена на месте");
});

test("112 R10: штатный split изолированной стены проходит, стык соединён", async () => {
  const { ws, isolated } = wsWithIsolatedWall(gapAfterSplitEditor(0));
  await ws.open("123", "1");
  const { result } = await ws.applyWalls("wall_split", (mm) => splitWall(mm, isolated.id, 3000));
  assert.ok(ws.model.walls[result.second.id], "вторая половина в модели");
  const dangling = findUnattachedEnds(Object.values(ws.model.walls as Record<string, Wall>));
  assert.equal(dangling.length, 2, `ровно 2 внешних свободных конца, получено ${dangling.length}`);
  const cut = dangling.filter((d) => Math.abs(d.point.x - 300) < 1e-9);
  assert.equal(cut.length, 0, "внутренний узел разреза соединён");
});

test("142/144: зазор 0,51 см после split — тоже INVALID_GEOMETRY, допуск сопоставления не оправдывает отрыв", async () => {
  const { ws, isolated } = wsWithIsolatedWall(gapAfterSplitEditor(0.51));
  await ws.open("123", "1");
  await assert.rejects(
    ws.applyWalls("wall_split", (mm) => splitWall(mm, isolated.id, 3000)),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, "INVALID_GEOMETRY");
      assert.match((e as Error).message, /оторвал соединённый конец/, (e as Error).message);
      return true;
    },
  );
});
