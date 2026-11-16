// Этап 43: резолюция ревью PR #4 «Несущая колонна».
// №1 — стеновые операции учитывают колонны в атомарной финализации;
// №2 — верификация колонн и комнат после save по GET;
// №3 — общий предикат контакта конечных отрезков (за концами стены, повёрнутая грань).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, FixtureEnvelope } from "../../src/model/types.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { addPillar } from "../../src/model/pillars.ts";
import { moveWall, updateWall, splitWall, deleteWall } from "../../src/model/walls.ts";
import { validateModel } from "../../src/model/validate.ts";
import { McpError } from "../../src/errors.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function baseModel(): Model {
  const env = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/anon-rect-4000x3000.json"), "utf8")) as FixtureEnvelope;
  return structuredClone(env.model);
}

/** Комната [0,0]…[600,300] (внутренние грани), как в воспроизведении ревью 42. */
const ROOMS = [{
  roomId: null,
  polygon: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 300 }, { x: 0, y: 300 }],
  areaCm2: 180000,
  axisAreaCm2: null,
}];

/** Стена-эталон примыкания ревью 42: ось y=100.5, толщина 25 (грани y=88 и y=113). */
function pillarModel(): Model {
  const m = baseModel();
  m.walls = {
    w: {
      id: "w", plan: "a", role: "wall", depth: 25, height: 270, material: "a_block",
      p1: { x: 32.7, y: 100.5 }, p2: { x: 523.7, y: 100.5 }, holes: {},
    },
  };
  m.pillars = {};
  return m;
}

/** Колонна, прижатая гранью b к верхней грани стены w (pc ≈ (452.08, 78)). */
function attachPillar(m: Model): import("../../src/model/types.ts").Pillar {
  return addPillar(m, { center: { x: 4520.8, y: 780 } }, ROOMS);
}

type E = { code?: string };

// ---------- №1: стеновые операции и колонны ----------

test("№1 moveWall в колонну — GEOMETRY_CONFLICT, модель не меняется (снимок до вызова)", () => {
  const m = pillarModel();
  const p = attachPillar(m);
  const snapshot = JSON.stringify({ walls: m.walls, pillars: m.pillars });
  assert.throws(() => moveWall(m, { wallId: "w", offsetMm: 200 }), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "GEOMETRY_CONFLICT");
    return true;
  });
  assert.equal(JSON.stringify({ walls: m.walls, pillars: m.pillars }), snapshot, "стены и колонны не изменились");
  assert.equal(validateModel(m, ROOMS).filter((x) => x.code.startsWith("PILLAR")).length, 0);
});

test("№1 moveWall от колонны — eds очищен, 4 свободные грани, inRoom пересчитан", () => {
  const m = pillarModel();
  const p = attachPillar(m);
  assert.ok((p.eds as Record<string, unknown>)["b"], "до переноса eds.b записан");
  moveWall(m, { wallId: "w", offsetMm: -200 });
  assert.deepEqual(p.eds, {}, "примыкание снято");
  assert.deepEqual((p.edges ?? []).map((e) => e.side), ["t", "r", "b", "l"], "свободные грани возвращены");
  assert.equal(p.inRoom, 1);
  assert.equal(validateModel(m, ROOMS).filter((x) => x.code.startsWith("PILLAR")).length, 0);
});

test("№1 deleteWall — eds без ссылки на удалённую стену, грани и inRoom пересчитаны", () => {
  const m = pillarModel();
  const p = attachPillar(m);
  deleteWall(m, "w");
  assert.deepEqual(p.eds, {}, "eds пуст — стены нет");
  assert.ok(!(p.eds as Record<string, unknown>)["b"]);
  assert.deepEqual((p.edges ?? []).map((e) => e.side), ["t", "r", "b", "l"]);
  assert.equal(p.inRoom, 1);
});

test("№1 splitWall — привязка колонны переходит к части, у которой она стоит", () => {
  const m = pillarModel();
  const p = attachPillar(m);
  const { second } = splitWall(m, "w", 2000);
  // колонна у x≈452 — у второй части (разрез на x≈232.7)
  assert.equal((p.eds as Record<string, { wall: { id: string } }>)["b"]?.wall.id, second.id, "eds указывает на вторую часть");
  assert.deepEqual((p.edges ?? []).map((e) => e.side), ["t", "r", "l"]);
  assert.equal(validateModel(m, ROOMS).filter((x) => x.code.startsWith("PILLAR")).length, 0);
});

test("№1 updateWall толщиной в колонну — GEOMETRY_CONFLICT, модель не меняется", () => {
  const m = pillarModel();
  attachPillar(m);
  const snapshot = JSON.stringify({ walls: m.walls, pillars: m.pillars });
  // толщина 25 → 2000 мм: грань стены уходит за колонну (pc.y=78, грань была y=88)
  assert.throws(() => updateWall(m, { wallId: "w", thicknessMm: 2000, side: "right" }), /пересекает стену/);
  assert.equal(JSON.stringify({ walls: m.walls, pillars: m.pillars }), snapshot);
});

test("№1 Workspace.applyWalls offline: moveWall в колонну — отказ, модель workspace не меняется", async () => {
  const m = pillarModel();
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: "0", units: "cm", data_empty: false, model: structuredClone(m) as unknown as Record<string, unknown> };
    },
    async openEditor(): Promise<EditorLike> {
      throw new Error("offline: редактор не нужен");
    },
  };
  const ws = new Workspace(deps, { offline: true });
  await ws.open("0", "1");
  ws.apply("pillar_add", (mm) => void addPillar(mm, { center: { x: 4520.8, y: 780 } }, ws.rooms()));
  const before = JSON.stringify(ws.model);
  await assert.rejects(ws.applyWalls("wall_move", (mm) => moveWall(mm, { wallId: "w", offsetMm: 200 })), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "GEOMETRY_CONFLICT");
    return true;
  });
  assert.equal(JSON.stringify(ws.model), before, "модель workspace не изменилась");
});

test("№1 Workspace.applyWalls online: редактор потерял колонну при нормализации — INVALID_GEOMETRY", async () => {
  const server = { saveId: "s1", model: pillarModel() };
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(model) {
      const copy = structuredClone(model) as Record<string, unknown>;
      copy["pillars"] = {};
      const walls = Object.keys(model.walls as Record<string, unknown>).length;
      return { model: copy, rooms: [], before: { walls, holes: 0, items: 0 }, after: { walls, holes: 0, items: 0 } };
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } }; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: server.saveId, units: "cm", data_empty: false, model: structuredClone(server.model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
  const ws = new Workspace(deps);
  await ws.open("0", "1");
  ws.apply("pillar_add", (mm) => void addPillar(mm, { center: { x: 4520.8, y: 780 } }, ws.rooms()));
  await assert.rejects(ws.applyWalls("wall_move", (mm) => moveWall(mm, { wallId: "w", offsetMm: -200 })), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "INVALID_GEOMETRY");
    return true;
  });
});

// ---------- №2: верификация колонн и комнат после save ----------

type SaveServer = { saveId: string; model: Record<string, unknown> };

/** Workspace с редактором, который оставляет модель как есть, и сервером с подкруткой после save. */
function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(model) {
      normalized = structuredClone(model) as Record<string, unknown>;
      const walls = Object.keys(model.walls as Record<string, unknown>).length;
      return { model: structuredClone(model) as Record<string, unknown>, rooms: [], before: { walls, holes: 0, items: 0 }, after: { walls, holes: 0, items: 0 } };
    },
    async save() {
      server.model = structuredClone(normalized!);
      afterSave(server);
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } }; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: server.saveId, units: "cm", data_empty: false, model: structuredClone(server.model) };
    },
    async openEditor() { return editor; },
  };
  return new Workspace(deps);
}

test("№2 колонна исчезла после save — SITE_ERROR, verified=false, локальная модель не заменена", async () => {
  const server: SaveServer = { saveId: "s1", model: pillarModel() as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => { s.model["pillars"] = {}; });
  await ws.open("0", "1");
  ws.apply("pillar_add", (mm) => void addPillar(mm, { center: { x: 2000, y: 1500 } }, ROOMS));
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as E & { details?: { pillar_mismatches?: string[] } }).details;
    assert.ok((details?.pillar_mismatches ?? []).some((x) => x.includes("исчезла")), JSON.stringify(details));
    return true;
  });
  // локальная модель не заменена серверной: колонна на месте, dirty не снят
  assert.equal(Object.keys(ws.model.pillars).length, 1);
  assert.equal(ws.project!.dirty, true);
});

test("№2 id колонны сохранился, геометрия изменилась — SITE_ERROR с расхождением", async () => {
  const server: SaveServer = { saveId: "s1", model: pillarModel() as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const pillars = s.model["pillars"] as Record<string, { pc: { x: number; y: number }; width: number; height: number; angle: number }>;
    for (const p of Object.values(pillars)) p.pc = { x: p.pc.x + 50, y: p.pc.y };
  });
  await ws.open("0", "1");
  ws.apply("pillar_add", (mm) => void addPillar(mm, { center: { x: 2000, y: 1500 } }, ROOMS));
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as E & { details?: { pillar_mismatches?: string[] } }).details;
    assert.ok((details?.pillar_mismatches ?? []).some((x) => x.includes("сместился")), JSON.stringify(details));
    return true;
  });
  assert.equal(Object.keys(ws.model.pillars).length, 1);
});

test("№2 комнаты 1→0 после save — SITE_ERROR (молча терять комнаты недопустимо)", async () => {
  const server: SaveServer = { saveId: "s1", model: pillarModel() as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => { s.model["rooms2"] = {}; });
  await ws.open("0", "1");
  assert.ok(Object.keys(ws.model.rooms2 ?? {}).length > 0, "в фикстуре есть комнаты");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as E & { details?: { rooms_expected?: number; rooms_on_server?: number } }).details;
    assert.ok((details?.rooms_expected ?? 0) > 0 && details?.rooms_on_server === 0, JSON.stringify(details));
    return true;
  });
});

test("№2 комнаты исчезли при нормализации, сервер их сохранил — предупреждение в результате save", async () => {
  const server: SaveServer = { saveId: "s1", model: pillarModel() as unknown as Record<string, unknown> };
  // редактор отдаёт копию без rooms2, но на сервере комнаты остаются (save не пишет нормализацию)
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(model) {
      const copy = structuredClone(model) as Record<string, unknown>;
      copy["rooms2"] = {};
      const walls = Object.keys(model.walls as Record<string, unknown>).length;
      return { model: copy, rooms: [], before: { walls, holes: 0, items: 0 }, after: { walls, holes: 0, items: 0 } };
    },
    async save() {
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } }; },
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
  await ws.open("0", "1");
  const res = await ws.save();
  assert.ok(res.warnings.some((w) => w.includes("комнат")), JSON.stringify(res.warnings));
});

// ---------- №3: общий предикат контакта ----------

test("№3 колонна за концом стены (дальше p2) — без eds, вне помещений отклоняется атомарно", () => {
  const m = pillarModel();
  const snapshot = JSON.stringify({ walls: m.walls, pillars: m.pillars });
  // центр в 10000 см от начала стены — за концом p2 (x=523.7) на ~95 м
  assert.throws(() => addPillar(m, { center: { x: 100000, y: 780 } }, ROOMS), /вне помещений/);
  assert.equal(JSON.stringify({ walls: m.walls, pillars: m.pillars }), snapshot);
  assert.equal(validateModel(m, ROOMS).filter((x) => x.code.startsWith("PILLAR")).length, 0);
});

test("№3 колонна за другим концом стены (дальше p1) — тоже отклоняется", () => {
  const m = pillarModel();
  const snapshot = JSON.stringify({ walls: m.walls, pillars: m.pillars });
  // центр на x=-100 см — за концом p1 (x=32.7), грань b на линии грани стены
  assert.throws(() => addPillar(m, { center: { x: -1000, y: 780 } }, ROOMS), /вне помещений/);
  assert.equal(JSON.stringify({ walls: m.walls, pillars: m.pillars }), snapshot);
});

test("№3 повёрнутая грань с серединой на линии стены — не примыкание и не «вплотную»", () => {
  const m = pillarModel();
  const snapshot = JSON.stringify({ walls: m.walls, pillars: m.pillars });
  // колонна 20×20 с поворотом 45°: середина нижней грани на линии y=88, но грань не параллельна
  assert.throws(() => addPillar(m, { center: { x: 4520.8, y: 780 + 141 }, angleDeg: 45 }, ROOMS), /вне помещений|пересекает стену/);
  assert.equal(JSON.stringify({ walls: m.walls, pillars: m.pillars }), snapshot);
});

test("№3 примыкание у середины стены по-прежнему работает (регрессия эталона)", () => {
  const m = pillarModel();
  const p = attachPillar(m);
  assert.equal(p.p3.y, 88);
  assert.ok((p.eds as Record<string, unknown>)["b"]);
  assert.equal(p.inRoom, 0);
  assert.equal(validateModel(m, ROOMS).filter((x) => x.code.startsWith("PILLAR")).length, 0);
});
