// Этап 6, T28: нормализация после мутаций стен — клон → правило Node → normalize →
// проверки §12.4 → замена канонической копии или откат с INVALID_GEOMETRY.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { NormalizeResult, NormalizedWall } from "../../src/editor/adapter.ts";
import type { LoadedModel } from "../../src/api.ts";
import type { Model, FixtureEnvelope } from "../../src/model/types.ts";
import { addWall, addPolyline, addRoomRect } from "../../src/model/walls.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function corridorModel(): Model {
  const env = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/editor-corridor-3rooms.json"), "utf8")) as FixtureEnvelope;
  return structuredClone(env.model);
}

type EditorOpts = {
  walls?: NormalizedWall[] | ((model: Record<string, unknown>) => NormalizedWall[]);
  errors?: Record<string, number> | null;
  rooms?: NormalizeResult["rooms"];
  /** Убрать rooms2 из копии — как у реального редактора сразу после draw. */
  stripRooms2?: boolean;
};

function mockEditor(opts: EditorOpts = {}): { editor: EditorLike; normalizeCalls: () => number } {
  let calls = 0;
  const editor: EditorLike = {
    objectId: "123", planId: "1",
    async normalize(model) {
      calls++;
      const walls = (model as { walls: Record<string, unknown> }).walls;
      const copy = structuredClone(model) as Record<string, unknown>;
      if (opts.stripRooms2) copy["rooms2"] = {};
      return {
        model: copy,
        rooms: opts.rooms ?? [],
        before: { walls: Object.keys(walls).length, holes: 0, items: 0 },
        after: { walls: Object.keys(walls).length, holes: 0, items: 0 },
        walls: typeof opts.walls === "function" ? opts.walls(model as Record<string, unknown>) : (opts.walls ?? []),
        errors: opts.errors ?? null,
      };
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { global_version: "757", planner_version: "3", bundles: [], object_id: "123", plan_id: "1", present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } } as never; },
    async close() {},
  };
  return { editor, normalizeCalls: () => calls };
}

function serverModelHas(server: { model: Model }, id: string): boolean {
  return id in server.model.walls;
}

function deps(editor: EditorLike, server: { model: Model }): WorkspaceDeps {
  return {
    session: { cookies: [] },
    async loadModel(_s, _o, _p): Promise<LoadedModel> {
      return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", model: structuredClone(server.model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
}

/** Связи «как у редактора» для модели без ссылок: пересчёт по геометрии. */
function normalizeWalls(model: Model): NormalizedWall[] {
  const walls = Object.values(model.walls);
  const out: NormalizedWall[] = [];
  for (const w of walls) {
    const linkOf = (e: { x: number; y: number }) => {
      for (const o of walls) {
        if (o.id === w.id) continue;
        if (Math.hypot(o.p1.x - e.x, o.p1.y - e.y) < 0.02 || Math.hypot(o.p2.x - e.x, o.p2.y - e.y) < 0.02) {
          return { ct: "node", id: o.id };
        }
        const dx = o.p2.x - o.p1.x;
        const dy = o.p2.y - o.p1.y;
        const len = Math.hypot(dx, dy);
        const t = ((e.x - o.p1.x) * dx + (e.y - o.p1.y) * dy) / (len * len);
        const perp = Math.abs((e.x - o.p1.x) * dy - (e.y - o.p1.y) * dx) / len;
        if (t >= -0.01 && t <= 1.01 && Math.abs(perp - o.depth / 2) <= 0.05) {
          return { ct: "edge", id: o.id };
        }
      }
      return null;
    };
    out.push({ id: w.id, p1: { ...w.p1 }, p2: { ...w.p2 }, depth: w.depth, link1: linkOf(w.p1), link2: linkOf(w.p2), overWall: false });
  }
  return out;
}

test("T28: мутация стен нормализуется и канонической становится копия редактора", async () => {
  const server = { model: corridorModel() };
  const { editor, normalizeCalls } = mockEditor();
  const ws = new Workspace(deps(editor, server));
  await ws.open("123", "1");
  const before = JSON.stringify(ws.model);
  const { result: wall } = await ws.applyWalls("wall_add", (m) => addWall(m, { start: { x: 1000, y: 7000 }, end: { x: 3000, y: 7000 } }));
  assert.ok(wall);
  assert.equal(normalizeCalls(), 1, "одна мутация — одна нормализация");
  assert.notEqual(JSON.stringify(ws.model), before, "каноническая копия заменена нормализованной");
  assert.equal(ws.project!.dirty, true);
  // undo откатывает нормализованную мутацию
  assert.equal(ws.undo().applied, 1);
  assert.equal(JSON.stringify(ws.model), before);
});

test("T28: наложение после нормализации → INVALID_GEOMETRY, модель не изменилась", async () => {
  const server = { model: corridorModel() };
  const { editor, normalizeCalls } = mockEditor({
    walls: normalizeWalls(server.model).map((w) => ({ ...w, overWall: true })),
  });
  const ws = new Workspace(deps(editor, server));
  await ws.open("123", "1");
  const before = JSON.stringify(ws.model);
  await assert.rejects(
    ws.applyWalls("wall_add", (m) => addWall(m, { start: { x: 1000, y: 7000 }, end: { x: 3000, y: 7000 } })),
    (e: unknown) => (e as { code?: string }).code === "INVALID_GEOMETRY",
  );
  assert.equal(JSON.stringify(ws.model), before, "модель не изменилась после отката");
  assert.equal(ws.project!.dirty, false);
  assert.equal(normalizeCalls(), 1);
});

test("T28/142: намеренно свободная стена (свободна уже в кандидате) → предупреждение wall_free_ends, мутация применяется", async () => {
  const server = { model: corridorModel() };
  // стена свободна геометрически уже в clone (пользователь нарисовал свободную стену) —
  // нормализатор её не ломал; стены без связей — как у реального редактора после draw
  const { editor } = mockEditor({
    walls: (model) => {
      const out = normalizeWalls(model as unknown as Model);
      // у добавленной стены (не из эталона) связи потеряны
      return out.map((w) => (out.some((x) => x.id === w.id) && !serverModelHas(server, w.id) ? { ...w, link1: null, link2: null } : w));
    },
  });
  const ws = new Workspace(deps(editor, server));
  await ws.open("123", "1");
  const { warnings } = await ws.applyWalls("wall_add", (m) => addWall(m, { start: { x: 1000, y: 7000 }, end: { x: 3000, y: 7000 } }));
  const free = warnings.find((w) => w.startsWith("wall_free_ends"));
  assert.ok(free, `wall_free_ends в warnings: ${JSON.stringify(warnings)}`);
  // ревью 144 M2: публичные имена — метка стены W<n> и конец start/end, не p1/p2
  assert.match(free!, /W\d+\.start \(1000; 7000\)/, `метка стены и start: ${free}`);
  assert.match(free!, /W\d+\.end \(3000; 7000\)/, `метка стены и end: ${free}`);
  assert.doesNotMatch(free!, /\.p[12]\b/, "внутренних имён узлов p1/p2 нет");
});

test("T28/144: нормализатор оторвал соединённый конец → INVALID_GEOMETRY, модель не изменилась", async () => {
  const server = { model: corridorModel() };
  // mock normalize сдвигает конец, соединённый в clone (стык у (0,-300)) на 0,2 см —
  // дефект нормализатора (баг 111); конец свободен только ПОСЛЕ normalize
  const { editor } = mockEditor({
    walls: (model) => {
      const out = normalizeWalls(model as unknown as Model);
      const top = out.find((w) => w.p1.y === -300 && w.p2.x === 600);
      if (top) top.p1.x += 0.2;
      return out;
    },
  });
  const ws = new Workspace(deps(editor, server));
  await ws.open("123", "1");
  const before = JSON.stringify(ws.model);
  await assert.rejects(
    ws.applyWalls("wall_add", (m) => addWall(m, { start: { x: 10000, y: 7000 }, end: { x: 12000, y: 7000 } })),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, "INVALID_GEOMETRY");
      assert.match((e as Error).message, /оторвал соединённый конец/, (e as Error).message);
      return true;
    },
  );
  assert.equal(JSON.stringify(ws.model), before, "модель не изменилась после отката");
  assert.equal(ws.project!.dirty, false);
});

test("T28: рост счётчиков ошибок редактора → INVALID_GEOMETRY", async () => {
  const server = { model: corridorModel() };
  const errors = { wallOverWall: 1, wallTooShort: 0, wallNoPointS: 0, wallNoPointE: 0, roomRebuild: 0, wallWrongLabel: 0 };
  const { editor } = mockEditor({ walls: normalizeWalls(server.model), errors });
  const ws = new Workspace(deps(editor, server));
  await ws.open("123", "1");
  const before = JSON.stringify(ws.model);
  await assert.rejects(
    ws.applyWalls("wall_add", (m) => addWall(m, { start: { x: 1000, y: 7000 }, end: { x: 3000, y: 7000 } })),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, "INVALID_GEOMETRY");
      assert.match((e as Error).message, /wallOverWall/);
      return true;
    },
  );
  assert.equal(JSON.stringify(ws.model), before);
});

test("T28: walls_add_polyline нормализуется один раз на весь пакет", async () => {
  const server = { model: corridorModel() };
  const { editor, normalizeCalls } = mockEditor({ walls: normalizeWalls(corridorModel()), errors: { wallOverWall: 0, wallTooShort: 0, wallNoPointS: 0, wallNoPointE: 0, roomRebuild: 0, wallWrongLabel: 0 } });
  const ws = new Workspace(deps(editor, server));
  await ws.open("123", "1");
  const { result: walls } = await ws.applyWalls("walls_add_polyline", (m) => addPolyline(m, {
    points: [{ x: 7000, y: 7000 }, { x: 9000, y: 7000 }, { x: 9000, y: 8000 }],
    thicknessMm: 200,
  }));
  assert.equal(walls.length, 2);
  assert.equal(normalizeCalls(), 1, "пакет — одна нормализация");
});

test("T28: офлайн-режим — без нормализации, предупреждение EDITOR_REQUIRED_FOR_ROOMS", async () => {
  const server = { model: corridorModel() };
  const { editor, normalizeCalls } = mockEditor();
  const ws = new Workspace(deps(editor, server), { offline: true });
  await ws.open("123", "1");
  const { warnings } = await ws.applyWalls("wall_add", (m) => addWall(m, { start: { x: 1000, y: 7000 }, end: { x: 3000, y: 7000 } }));
  assert.deepEqual(warnings, ["EDITOR_REQUIRED_FOR_ROOMS"]);
  assert.equal(normalizeCalls(), 0, "нормализации не было");
  assert.equal(Object.keys(ws.model.walls).length, 8, "стены меняются без нормализации");
});

test("T28: rooms_list после мутации читает комнаты из кеша нормализации", async () => {
  const server = { model: corridorModel() };
  const rooms = [
    { id: "r1", name: null, area: 7.84, area_m2: 7.84, height: null, polygon: [{ x: 10, y: -290 }, { x: 290, y: -290 }, { x: 290, y: -10 }, { x: 10, y: -10 }] },
  ];
  const { editor } = mockEditor({ rooms, stripRooms2: true });
  const ws = new Workspace(deps(editor, server));
  await ws.open("123", "1");
  assert.equal(ws.rooms().length, 4, "до мутации — комнаты из rooms2 модели");
  await ws.applyWalls("wall_add", (m) => addRoomRect(m, { origin: { x: 7000, y: 7000 }, widthMm: 2000, depthMm: 2000 }));
  const after = ws.rooms();
  assert.equal(after.length, 1, "после мутации — комнаты из кеша нормализации (в copy rooms2 ещё пуст)");
  assert.equal(Math.round(after[0]!.areaCm2 / 10_000 * 100) / 100, 7.84);
  assert.deepEqual(after[0]!.polygon[0], { x: 10, y: -290 });
});
