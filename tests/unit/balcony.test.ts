// Этап 71 «Нарисовать балкон»: сверка с эталоном UI (ui-ref-balcony.json), дефолты и
// лимиты defs.wall, атомарность (снимок до вызова), цепочки update, удаление, смежные
// операции (проёмы на ограждениях — запрет редактора), mock-верификация save.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, Wall } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addBalcony, updateBalcony, deleteBalcony, balconyWall, BALCONY_DEFS } from "../../src/model/balcony.ts";
import { addOpening, updateOpening, deleteOpening } from "../../src/model/openings.ts";
import { addRigel } from "../../src/model/rigels.ts";
import { validateModel } from "../../src/model/validate.ts";
import { compactModel } from "../../src/model/compact.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {} };
}

/** Комната 4000×3000, толщина 200: нижняя стена — ось y=310 от x=-10 до 410. */
function roomModel(): { model: Model; bottom: Wall } {
  const model = emptyModel();
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  return { model, bottom: walls[2]! };
}

const near = (a: number | undefined, b: number | undefined, tol = 0.01): boolean =>
  a !== undefined && b !== undefined && Math.abs(a - b) <= tol;

// ---------- эталон UI ----------

type BalconyRef = { _source: string; global_version: string; balcony_walls: Record<string, Wall> };
const REF = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/ui-ref-balcony.json"), "utf8")) as BalconyRef;

test("эталон ui-ref-balcony: role balcony, план a, depth 10, height 100, a_block", () => {
  const walls = Object.values(REF.balcony_walls);
  assert.equal(walls.length, 3);
  for (const w of walls) {
    assert.equal(w.role, "balcony");
    assert.equal(w.plan, "a");
    assert.equal(w.depth, 10);
    assert.equal(w.height, 100);
    assert.equal(w.material, "a_block");
  }
  // концы пристают к наружной стене гранью (edge), между собой — узлом
  const edgeEnds = walls.filter((w) => w.p1.link?.ct === "edge" || w.p2.link?.ct === "edge");
  assert.equal(edgeEnds.length, 2);
  const nodeEnds = walls.filter((w) => w.p1.link?.ct === "node" && w.p2.link?.ct === "node");
  assert.equal(nodeEnds.length, 1);
});

// ---------- balcony_add ----------

/** U-образный балкон на нижней стене комнаты (как в эталоне): мм. */
function uBalcony() {
  return [
    { x: 1500, y: 3100 },
    { x: 1500, y: 5100 },
    { x: 4000, y: 5100 },
    { x: 4000, y: 3100 },
  ];
}

test("balcony_add: U-ограждение пристало к стене гранью, дефолты как у инструмента редактора", () => {
  const { model, bottom } = roomModel();
  const created = addBalcony(model, { points: uBalcony() });
  assert.equal(created.length, 3);
  for (const w of created) {
    assert.equal(w.role, "balcony");
    assert.equal(w.plan, "a");
    assert.equal(w.depth, BALCONY_DEFS.depthCm);
    assert.equal(w.height, BALCONY_DEFS.heightCm);
    assert.equal(w.material, "a_block");
  }
  // концы у стены — на грани (ось y=310, толщина 20 → наружная грань y=320)
  const first = created[0]!;
  assert.ok(near(first.p1.y, 320), `первый конец на грани стены (${first.p1.y})`);
  const last = created[2]!;
  assert.ok(near(last.p2.y, 320), `последний конец на грани стены (${last.p2.y})`);
  void bottom;
});

test("balcony_add: замкнутый контур", () => {
  const { model } = roomModel();
  const created = addBalcony(model, {
    points: [
      { x: 8000, y: 0 }, { x: 8000, y: 2000 }, { x: 10000, y: 2000 }, { x: 10000, y: 0 },
    ],
    closed: true,
  });
  assert.equal(created.length, 4);
});

test("balcony_add: кастомная толщина и высота; лимиты defs.wall", () => {
  const { model } = roomModel();
  const [w] = addBalcony(model, { points: uBalcony(), thicknessMm: 60, heightMm: 1200 });
  assert.equal(w!.depth, 6);
  assert.equal(w!.height, 120);
  // ниже depthMin 40 мм
  assert.throws(() => addBalcony(emptyModel(), { points: uBalcony(), thicknessMm: 30 }), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
  // выше depthMax 1000 мм
  assert.throws(() => addBalcony(emptyModel(), { points: uBalcony(), thicknessMm: 1100 }), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
  // высота должна быть конечной и > 0
  assert.throws(() => addBalcony(emptyModel(), { points: uBalcony(), heightMm: 0 }), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
});

test("balcony_add: короткий сегмент, совпадающие точки, <2 точек — INVALID_ARGUMENT", () => {
  assert.throws(() => addBalcony(emptyModel(), { points: [{ x: 0, y: 0 }] }), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.throws(() => addBalcony(emptyModel(), { points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1000, y: 0 }] }), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.throws(() => addBalcony(emptyModel(), { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 3000, y: 0 }] }), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
  // неконечные координаты
  assert.throws(() => addBalcony(emptyModel(), { points: [{ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 0 }] }), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
});

test("balcony_add: самопересечение контура — GEOMETRY_CONFLICT", () => {
  const { model } = roomModel();
  const before = JSON.stringify(model);
  assert.throws(() => addBalcony(model, {
    points: [
      { x: 6000, y: 0 }, { x: 6000, y: 2000 }, { x: 8000, y: 0 }, { x: 8000, y: 2000 },
    ],
    closed: true,
  }), (e: unknown) => e instanceof McpError && e.code === "GEOMETRY_CONFLICT");
  assert.equal(JSON.stringify(model), before);
});

test("balcony_add: отказ второго сегмента отменяет всё (атомарность пакета)", () => {
  const { model } = roomModel();
  addBalcony(model, { points: uBalcony() });
  const afterFirst = JSON.stringify(model);
  // второй балкон: сегмент 2 — X-пересечение с правым ограждением первого (ось x=400, y 320..510)
  assert.throws(() => addBalcony(model, {
    points: [
      { x: 4500, y: 4100 }, { x: 4500, y: 4600 }, { x: 3000, y: 4600 },
    ],
  }), (e: unknown) => e instanceof McpError);
  assert.equal(JSON.stringify(model), afterFirst);
});

test("balcony_add: отказ пакета с ригелем откатывает rigels (ревью 73 №3)", () => {
  const model = emptyModel();
  addRigel(model, { start: { x: 0, y: 50 }, end: { x: 0, y: 2000 } });
  const before = JSON.stringify(model);
  // второй сегмент коллинеарен первому (наложение сам на себя) — INVALID_GEOMETRY
  assert.throws(() => addBalcony(model, {
    points: [{ x: -2000, y: 0 }, { x: 2000, y: 0 }, { x: -2000, y: 0 }],
  }), (e: unknown) => e instanceof McpError);
  assert.equal(JSON.stringify(model), before, "модель после отката не равна снимку до вызова");
});

test("balcony_add: наложение на существующую стену (коллинеарное) — INVALID_GEOMETRY", () => {
  const { model } = roomModel();
  const before = JSON.stringify(model);
  // сегмент вдоль нижней стены поверх неё (ось y=310)
  assert.throws(() => addBalcony(model, {
    points: [{ x: 1000, y: 3100 }, { x: 3000, y: 3100 }],
    thicknessMm: 200,
  }), (e: unknown) => e instanceof McpError);
  assert.equal(JSON.stringify(model), before);
});

// ---------- balcony_update / balcony_delete ----------

test("balcony_update: цепочка length/anchor и thickness; identity сохраняется", () => {
  const { model } = roomModel();
  const [w] = addBalcony(model, { points: [{ x: 1000, y: 0 }, { x: 1000, y: 2000 }] });
  const id = w!.id;
  // длина с якорем end (по умолчанию): p1 остаётся, p2 уезжает
  const u1 = updateBalcony(model, { wallId: id, lengthMm: 2500, anchor: "end" });
  assert.ok(near(u1.p1.x, 100));
  assert.ok(near(u1.p2.y, 250));
  // толщина
  const u2 = updateBalcony(model, { wallId: id, thicknessMm: 80 });
  assert.ok(near(u2.depth, 8));
  assert.equal(u2.id, id);
  // перенос конца
  const u3 = updateBalcony(model, { wallId: id, end: { x: 2000, y: 2500 } });
  assert.ok(near(u3.p2.x, 200) && near(u3.p2.y, 250));
});

test("balcony_update: anchor — переносимый конец (семантика wall_update, ревью 73 №6)", () => {
  const { model } = roomModel();
  const [w] = addBalcony(model, { points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }] });
  const u = updateBalcony(model, { wallId: w!.id, lengthMm: 2000, anchor: "start" });
  // начало переносится, конец остаётся на месте — как в wall_update
  assert.ok(near(u.p1.x, 200), `p1.x=${u.p1.x}`);
  assert.ok(near(u.p2.x, 400), `p2.x=${u.p2.x}`);
});

test("balcony_update: лимиты defs действуют и при update (ревью 73 №4)", () => {
  const { model } = roomModel();
  const [w] = addBalcony(model, { points: [{ x: 1000, y: 0 }, { x: 1000, y: 2000 }] });
  const id = w!.id;
  const before = JSON.stringify(model);
  // толщина ниже/выше depthMin/depthMax
  assert.throws(() => updateBalcony(model, { wallId: id, thicknessMm: 1 }), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.throws(() => updateBalcony(model, { wallId: id, thicknessMm: 1001 }), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
  // короче min_length
  assert.throws(() => updateBalcony(model, { wallId: id, lengthMm: 100 }), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.equal(JSON.stringify(model), before, "модель после отказов не изменилась");
});

test("balcony_update/delete: не-балконная стена — NOT_FOUND; несуществующая — NOT_FOUND", () => {
  const { model, bottom } = roomModel();
  assert.throws(() => updateBalcony(model, { wallId: bottom.id, lengthMm: 1000 }), (e: unknown) =>
    e instanceof McpError && e.code === "NOT_FOUND");
  assert.throws(() => deleteBalcony(model, bottom.id), (e: unknown) =>
    e instanceof McpError && e.code === "NOT_FOUND");
  assert.throws(() => balconyWall(model, "nope"), (e: unknown) =>
    e instanceof McpError && e.code === "NOT_FOUND");
});

test("balcony_delete: удаляет ограждение; смежное ограждение остаётся", () => {
  const { model } = roomModel();
  const created = addBalcony(model, { points: uBalcony() });
  const res = deleteBalcony(model, created[1]!.id);
  assert.equal(res.removedHoles, 0);
  assert.equal(model.walls[created[1]!.id], undefined);
  assert.ok(model.walls[created[0]!.id]);
});

// ---------- проёмы на балконных ограждениях ----------

test("opening_add на балконном ограждении — INVALID_ARGUMENT (hole__dont_install_over_balcony)", () => {
  const { model } = roomModel();
  const created = addBalcony(model, { points: uBalcony() });
  const before = JSON.stringify(model);
  assert.throws(() => addOpening(model, {
    wallId: created[0]!.id,
    type: "door",
    offsetMm: 500,
  }), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "INVALID_ARGUMENT");
    assert.equal((e as { details?: { kind?: string } }).details?.kind, "opening_on_balcony");
    return true;
  });
  assert.equal(JSON.stringify(model), before);
});

test("opening_update: уже стоящий проём на ограждении правится (регрессия ревью 73 №1)", () => {
  const { model, bottom } = roomModel();
  const hole = addOpening(model, { wallId: bottom.id, type: "window", centerMm: 2000, widthMm: 1000, heightMm: 1200 });
  // существующий проект: стена стала ограждением, проём остался — правка высоты
  // обязана работать (новые проёмы на ограждения по-прежнему запрещены)
  bottom.role = "balcony";
  const updated = updateOpening(model, { wallId: bottom.id, holeId: hole.id, heightMm: 1300 });
  assert.equal(updated.height, 130);
});

test("validate: проём на балконном ограждении — OPENING_ON_BALCONY", () => {
  const { model } = roomModel();
  const created = addBalcony(model, { points: uBalcony() });
  const wall = balconyWall(model, created[0]!.id);
  wall.holes["h1"] = {
    id: "h1", plan: "a", type: "door", group: "doors",
    pc: { x: 150, y: 400 }, width: 80, height: 200, depth: 4,
    p1: { x: 110, y: 400 }, p2: { x: 190, y: 400 },
  } as never;
  const problems = validateModel(model);
  assert.ok(problems.some((p) => p.code === "OPENING_ON_BALCONY"), JSON.stringify(problems.map((p) => p.code)));
  deleteOpening(model, wall.id, "h1");
  assert.ok(!validateModel(model).some((p) => p.code === "OPENING_ON_BALCONY"));
});

// ---------- компакт ----------

test("compact: роль balcony видна, у обычных стен role нет", () => {
  const { model } = roomModel();
  addBalcony(model, { points: uBalcony() });
  const compact = compactModel(model);
  const balconies = compact.walls.filter((w) => w.role === "balcony");
  assert.equal(balconies.length, 3);
  assert.equal(compact.walls.filter((w) => w.role === undefined).length, compact.walls.length - 3);
});

// ---------- верификация save (mock) ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(m.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      afterSave(server);
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return COMPAT; },
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

test("save: балкон сохраняется штатно — verified=true, без ложных блокировок", async () => {
  const model = roomModel().model;
  addBalcony(model, { points: uBalcony() });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const out = await ws.save();
  assert.equal(out.verified, true);
  assert.equal(out.rounds, 1);
});

test("save: нормализатор сменил роль ограждения — NORMALIZATION_DROPPED до записи", async () => {
  const model = roomModel().model;
  addBalcony(model, { points: uBalcony() });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    const walls = m.walls as Record<string, { role?: string }>;
    for (const w of Object.values(walls)) {
      if (w.role === "balcony") w.role = "wall";
    }
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "NORMALIZATION_DROPPED");
    const details = (e as { details?: { wall_role_mismatches?: string[] } }).details;
    assert.ok((details?.wall_role_mismatches ?? []).some((x) => x.includes("role")), JSON.stringify(details));
    return true;
  });
  assert.equal(saves, 0, "до записи дело не дошло");
});

test("save: ограждение стало обычной стеной на сервере — SITE_ERROR, verified не выставляется", async () => {
  const model = roomModel().model;
  addBalcony(model, { points: uBalcony() });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const walls = s.model.walls as Record<string, { role?: string }>;
    for (const w of Object.values(walls)) {
      if (w.role === "balcony") w.role = "wall";
    }
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { wall_role_mismatches?: string[] } }).details;
    assert.ok((details?.wall_role_mismatches ?? []).length > 0, JSON.stringify(details));
    return true;
  });
});

// ревью 73 №2: роль и ось — не вся семантика ограждения; height/depth/material
// сверяются после save так же, как роль

test("save: подмена height ограждения на сервере — SITE_ERROR (ревью 73 №2)", async () => {
  const model = roomModel().model;
  addBalcony(model, { points: uBalcony() });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const walls = s.model.walls as Record<string, { role?: string; height?: number }>;
    for (const w of Object.values(walls)) {
      if (w.role === "balcony") w.height = 123;
    }
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { wall_property_mismatches?: string[] } }).details;
    assert.ok((details?.wall_property_mismatches ?? []).some((x) => x.includes("height")), JSON.stringify(details));
    return true;
  });
});

test("save: подмена depth ограждения на сервере — SITE_ERROR (ревью 73 №2)", async () => {
  const model = roomModel().model;
  addBalcony(model, { points: uBalcony() });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const walls = s.model.walls as Record<string, { role?: string; depth?: number }>;
    for (const w of Object.values(walls)) {
      if (w.role === "balcony") w.depth = 123;
    }
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { wall_property_mismatches?: string[] } }).details;
    assert.ok((details?.wall_property_mismatches ?? []).some((x) => x.includes("depth")), JSON.stringify(details));
    return true;
  });
});

test("save: подмена material ограждения на сервере — SITE_ERROR (ревью 73 №2)", async () => {
  const model = roomModel().model;
  addBalcony(model, { points: uBalcony() });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const walls = s.model.walls as Record<string, { role?: string; material?: string }>;
    for (const w of Object.values(walls)) {
      if (w.role === "balcony") w.material = "changed";
    }
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { wall_property_mismatches?: string[] } }).details;
    assert.ok((details?.wall_property_mismatches ?? []).some((x) => x.includes("material")), JSON.stringify(details));
    return true;
  });
});

test("save: нормализатор сменил height ограждения — NORMALIZATION_DROPPED до записи (ревью 73 №2)", async () => {
  const model = roomModel().model;
  addBalcony(model, { points: uBalcony() });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    const walls = m.walls as Record<string, { role?: string; height?: number }>;
    for (const w of Object.values(walls)) {
      if (w.role === "balcony") w.height = 123;
    }
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "NORMALIZATION_DROPPED");
    const details = (e as { details?: { wall_property_mismatches?: string[] } }).details;
    assert.ok((details?.wall_property_mismatches ?? []).some((x) => x.includes("height")), JSON.stringify(details));
    return true;
  });
  assert.equal(saves, 0, "до записи дело не дошло");
});
