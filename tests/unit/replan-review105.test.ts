// 105: резолюция ревью PR #14 «Перепланировка» — R1–R9.
// По каждой находке тест, падающий на d2480d0, и проверка исправления:
// R1 — applyWalls сверяет демонтаж кандидата; R2 — сектора при переносе/split/сокращении;
// R3 — центр замены через holeRange; R4 — жизненный цикл пары; R5 — сверка замены и
// проёмов при демонтаже целиком; R6 — строгий enum материалов; R7 — пересечение с
// проёмом без at; R8 — sector_id в компактной модели.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model, Wall } from "../../src/model/types.ts";
import { demolish, demolishCancel, demolitionMismatches, partitionMaterialCode, partitionMaterialKey } from "../../src/model/demolition.ts";
import { addWall, moveWall, updateWall, splitWall, deleteWall } from "../../src/model/walls.ts";
import { addOpening, deleteOpening } from "../../src/model/openings.ts";
import { prepareHolePoints } from "../../src/model/openings.ts";
import { compactModel } from "../../src/model/compact.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { NormalizeResult } from "../../src/editor/adapter.ts";
import type { LoadedModel } from "../../src/api.ts";
import { ServerContext } from "../../src/server/context.ts";
import { planTools } from "../../src/server/tools-plan.ts";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url));

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

const sectorsOf = (w: Wall): Record<string, { id: string; pc: { x: number; y: number }; width: number }> =>
  (w.sectors ?? {}) as Record<string, { id: string; pc: { x: number; y: number }; width: number }>;

/** Свободная горизонтальная стена 6000 мм на оси y=-3000 (как в сценарии ревью 105). */
function probeWall(m: Model): Wall {
  prepareHolePoints(m);
  return addWall(m, { start: { x: 0, y: -6000 }, end: { x: 6000, y: -6000 } });
}

function sectorByOffset(m: Model, w: Wall, offsetMm: number, lengthMm: number): string {
  const res = demolish(m, { target: "wall", id: w.id, range: { from: "start", offset_mm: offsetMm, length_mm: lengthMm } });
  return res.sectorId!;
}

// ---------- R1: applyWalls сверяет демонтаж кандидата, а не исходную модель ----------

type EditorOpts = { transformNorm?: (m: Record<string, unknown>) => void };

function identityEditor(opts: EditorOpts = {}): EditorLike {
  return {
    objectId: "123", planId: "1",
    async normalize(model) {
      const copy = structuredClone(model) as Record<string, unknown>;
      opts.transformNorm?.(copy);
      const walls = Object.keys((model as { walls: Record<string, unknown> }).walls).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: copy, rooms: [], before: c, after: c, walls: [], errors: null } as unknown as NormalizeResult;
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { global_version: null, planner_version: null, bundles: [], object_id: "123", plan_id: "1", present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } } as never; },
    async close() {},
  };
}

function wsDeps(editor: EditorLike, server: { model: Model }): WorkspaceDeps {
  return {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", data_empty: false, model: structuredClone(server.model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
}

test("105 R1: applyWalls — демонтаж целиком проходит (identity-нормализатор), demount 0 → 1", async () => {
  const m = baseModel();
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  const server = { model: m };
  const ws = new Workspace(wsDeps(identityEditor(), server));
  await ws.open("123", "1");
  const { result } = await ws.applyWalls("demolish", (mm) => demolish(mm, { target: "wall", id: top.id }));
  assert.equal(result.wallId, top.id);
  assert.equal((ws.model.walls[top.id]!).demount, 1);
});

test("105 R1: applyWalls — демонтаж участка 0 → 1 и отмена 1 → 0 проходят", async () => {
  const m = baseModel();
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  const ws = new Workspace(wsDeps(identityEditor(), { model: m }));
  await ws.open("123", "1");
  const { result } = await ws.applyWalls("demolish", (mm) => demolish(mm, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } }));
  assert.ok(result.sectorId);
  const { result: c } = await ws.applyWalls("demolish_cancel", (mm) => demolishCancel(mm, { target: "wall", id: top.id, sector_id: result.sectorId }));
  assert.equal(c.sectorId, result.sectorId);
  assert.equal(Object.keys(sectorsOf(ws.model.walls[top.id]!)).length, 0);
});

test("105 R1: applyWalls — отказ (отмена недемонтированной стены) атомарен, модель не меняется", async () => {
  const m = baseModel();
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  const ws = new Workspace(wsDeps(identityEditor(), { model: m }));
  await ws.open("123", "1");
  const before = JSON.stringify(ws.model);
  await assert.rejects(
    ws.applyWalls("demolish_cancel", (mm) => demolishCancel(mm, { target: "wall", id: top.id })),
    (e: unknown) => (e as { code?: string }).code === "INVALID_ARGUMENT",
  );
  assert.equal(JSON.stringify(ws.model), before, "модель не изменилась после отказа");
});

// ---------- R2: сектора демонтажа при переносе, изменении и split стены ----------

test("105 R2: moveWall — сектор переезжает вместе со стеной (pc на новой оси)", () => {
  const m = baseModel();
  const w = probeWall(m);
  sectorByOffset(m, w, 500, 1000);
  moveWall(m, { wallId: w.id, offsetMm: 200 });
  const s = Object.values(sectorsOf(w))[0]!;
  assert.equal(s.pc.y, -620, "pc на новой оси y=-620");
  assert.equal(s.pc.x, 100, "позиция по оси сохранена");
  assert.equal(w.p1.y, -620);
});

test("105 R2: updateWall сокращение — участок за концом стены → атомарный INVALID_ARGUMENT", () => {
  const m = baseModel();
  const w = probeWall(m);
  sectorByOffset(m, w, 500, 1000);
  const before = JSON.stringify(m.walls);
  assert.throws(
    () => updateWall(m, { wallId: w.id, lengthMm: 1000 }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      return err.code === "INVALID_ARGUMENT" && /участок демонтажа/.test(err.message ?? "");
    },
  );
  assert.equal(JSON.stringify(m.walls), before, "отказ атомарен");
});

test("105 R2: updateWall удлинение — сектор остаётся на месте по оси", () => {
  const m = baseModel();
  const w = probeWall(m);
  sectorByOffset(m, w, 500, 1000);
  updateWall(m, { wallId: w.id, lengthMm: 7000 });
  const s = Object.values(sectorsOf(w))[0]!;
  assert.equal(s.pc.x, 100);
  assert.equal(s.pc.y, -600);
});

test("105 R2: splitWall — сектор достаётся половине по положению центра (offset)", () => {
  const m = baseModel();
  const w = probeWall(m);
  sectorByOffset(m, w, 500, 1000); // центр t=100 см — в первой половине
  const { first, second } = splitWall(m, w.id, 3000);
  assert.equal(Object.keys(sectorsOf(first)).length, 1);
  assert.equal(Object.values(sectorsOf(first))[0]!.pc.x, 100);
  assert.equal(Object.keys(sectorsOf(second)).length, 0, "клон сектора не попадает во вторую стену");
});

test("105 R2: splitWall — сектор во второй половине переезжает с пересчётом pc", () => {
  const m = baseModel();
  const w = probeWall(m);
  sectorByOffset(m, w, 3500, 1000); // центр t=400 см — во второй половине
  const { first, second } = splitWall(m, w.id, 3000);
  assert.equal(Object.keys(sectorsOf(first)).length, 0);
  const s = Object.values(sectorsOf(second))[0]!;
  assert.equal(s.pc.x, 400, "центр на 100 см от начала второй стены");
  assert.equal(s.pc.y, -600);
});

test("105 R2: splitWall через участок демонтажа — GEOMETRY_CONFLICT, атомарно", () => {
  const m = baseModel();
  const w = probeWall(m);
  sectorByOffset(m, w, 500, 1000); // интервал 50..150 см
  const before = JSON.stringify(m.walls);
  assert.throws(
    () => splitWall(m, w.id, 1000),
    (e: unknown) => (e as { code?: string }).code === "GEOMETRY_CONFLICT",
  );
  assert.equal(JSON.stringify(m.walls), before);
});

// ---------- R3: позиция замены через holeRange ----------

test("105 R3: замена UI-проёма без at — центр замены = центр исходного", () => {
  const m = baseModel();
  prepareHolePoints(m);
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const door = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 2000 });
  delete door.at; // UI-модель: служебного at нет
  const rep = addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: door.id, widthMm: 800 });
  assert.ok(Math.abs(rep.pc.x - door.pc.x) < 0.05, `центры совпадают: ${rep.pc.x} vs ${door.pc.x}`);
  assert.ok(Math.abs(rep.pc.y - door.pc.y) < 0.05);
});

test("105 R3: замена с явным далёким offset — INVALID_ARGUMENT", () => {
  const m = baseModel();
  prepareHolePoints(m);
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const door = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 2000 });
  assert.throws(
    () => addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: door.id, offsetMm: 3000 }),
    (e: unknown) => (e as { code?: string }).code === "INVALID_ARGUMENT",
  );
});

// ---------- R4: жизненный цикл пары замены ----------

test("105 R4: удаление замены снимает hasReplacement у исходного, повторная замена возможна", () => {
  const m = baseModel();
  prepareHolePoints(m);
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const door = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 1100 });
  const rep = addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: door.id });
  deleteOpening(m, corridor.id, rep.id);
  assert.equal(door.hasReplacement, undefined, "hasReplacement снят");
  const rep2 = addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: door.id });
  assert.ok(rep2, "повторная замена разрешена");
});

test("105 R4: удаление исходного удаляет и замену", () => {
  const m = baseModel();
  prepareHolePoints(m);
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const door = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 1100 });
  const rep = addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: door.id });
  deleteOpening(m, corridor.id, door.id);
  assert.equal(corridor.holes[rep.id], undefined, "замена удалена вместе с исходным");
});

test("105 R4: split — пара переезжает в одну половину, parent обновляется", () => {
  const m = baseModel();
  const w = probeWall(m);
  const door = addOpening(m, { wallId: w.id, type: "door", offsetMm: 4000 });
  const rep = addOpening(m, { wallId: w.id, type: "doorway", replacesHoleId: door.id, widthMm: 800 });
  const { first, second } = splitWall(m, w.id, 3000);
  assert.ok(second.holes[door.id], "исходный во второй стене");
  assert.ok(second.holes[rep.id], "замена во второй стене");
  assert.equal(first.holes[door.id], undefined);
  assert.equal(second.holes[rep.id]!.parent, second.id, "parent замены указывает на новую стену");
  assert.equal(door.hasReplacement, 1);
  // удаление первой стены не оставляет висячего parent
  deleteWall(m, first.id);
  const wall2 = Object.values(m.walls).find((x) => x.holes[rep.id])!;
  assert.equal(wall2.holes[rep.id]!.parent, wall2.id);
});

// ---------- R5: сверка замены и проёмов при демонтаже целиком ----------

test("105 R5: сверка — потеря hasReplacement и свойств замены расхождение", () => {
  const m = baseModel();
  prepareHolePoints(m);
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const door = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 1100 });
  addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: door.id });
  // потеря флага
  let after = structuredClone(m.walls);
  delete (after[corridor.id]!.holes[door.id] as Record<string, unknown>).hasReplacement;
  assert.ok(demolitionMismatches(m.walls, after).some((p) => p.includes("hasReplacement")));
  // потеря самой замены
  after = structuredClone(m.walls);
  delete after[corridor.id]!.holes[Object.keys(corridor.holes).find((h) => h !== door.id)!];
  assert.ok(demolitionMismatches(m.walls, after).length > 0, "замена потеряна — расхождение");
  // подмена свойства замены (ширина)
  after = structuredClone(m.walls);
  const repHole = after[corridor.id]!.holes[Object.keys(corridor.holes).find((h) => h !== door.id)!]!;
  repHole.width = repHole.width + 5;
  assert.ok(demolitionMismatches(m.walls, after).length > 0, "изменение ширины замены — расхождение");
});

test("105 R5: сверка — demount проёма сверяется и при demount=1 стены; отсутствующий проём — расхождение", () => {
  const m = baseModel();
  prepareHolePoints(m);
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const hole = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 1100 });
  demolish(m, { target: "wall", id: corridor.id });
  demolish(m, { target: "opening", id: hole.id });
  const after = structuredClone(m.walls);
  assert.deepEqual(demolitionMismatches(m.walls, after), []);
  delete after[corridor.id]!.holes[hole.id]!.demount;
  assert.ok(demolitionMismatches(m.walls, after).some((p) => p.includes(hole.id)), "серверная потеря demount проёма видна при демонтаже стены целиком");
  const after2 = structuredClone(m.walls);
  delete after2[corridor.id]!.holes[hole.id];
  assert.ok(demolitionMismatches(m.walls, after2).some((p) => p.includes(hole.id)), "отсутствующий проём — расхождение");
});

// ---------- R6: строгий enum материалов перегородок ----------

test("105 R6: c_glass — канонический код принимает, ключ нормализуется к glass", () => {
  assert.equal(partitionMaterialCode("c_glass"), "c_glass");
  assert.equal(partitionMaterialKey("c_glass"), "glass");
  assert.equal(partitionMaterialKey("c_block"), "foam_block");
  assert.throws(() => partitionMaterialCode("c_nonsense"), /неизвестный материал/);
  assert.throws(() => partitionMaterialCode("constructor"), /неизвестный материал/);
});

test("105 R6: wall_add partition c_glass — NOT_AVAILABLE_ON_TARIFF (PRO-гейт по нормализованному ключу)", async () => {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const tools = planTools(ctx);
  for (const material of ["c_glass", "glass"]) {
    const res = await tools["wall_add"]!.handler({ kind: "partition", material, start: { x: 1000, y: -1500 }, end: { x: 1000, y: -500 } });
    assert.equal(res.isError, true, material);
    const payload = JSON.parse((res.content[0] as { type: string; text: string }).text) as { code: string };
    assert.equal(payload.code, "NOT_AVAILABLE_ON_TARIFF", material);
  }
  const res = await tools["wall_add"]!.handler({ kind: "partition", material: "c_nonsense", start: { x: 1000, y: -1500 }, end: { x: 1000, y: -500 } });
  const payload = JSON.parse((res.content[0] as { type: string; text: string }).text) as { code: string };
  assert.equal(payload.code, "INVALID_ARGUMENT");
});

test("105 R6: walls_add_polyline partition c_glass — NOT_AVAILABLE_ON_TARIFF", async () => {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const tools = planTools(ctx);
  const res = await tools["walls_add_polyline"]!.handler({ kind: "partition", material: "c_glass", points: [{ x: 1000, y: -1500 }, { x: 1000, y: -500 }] });
  const payload = JSON.parse((res.content[0] as { type: string; text: string }).text) as { code: string };
  assert.equal(payload.code, "NOT_AVAILABLE_ON_TARIFF");
});

// ---------- R7: пересечение сектора с проёмом без at ----------

test("105 R7: demolish участка внутри UI-проёма без at — INVALID_ARGUMENT", () => {
  const m = baseModel();
  const w = probeWall(m);
  const door = addOpening(m, { wallId: w.id, type: "door", offsetMm: 2000 });
  delete door.at;
  const before = JSON.stringify(m.walls);
  assert.throws(
    () => demolish(m, { target: "wall", id: w.id, range: { from: "start", offset_mm: 2200, length_mm: 300 } }),
    (e: unknown) => (e as { code?: string }).code === "INVALID_ARGUMENT",
  );
  assert.equal(JSON.stringify(m.walls), before, "отказ атомарен");
});

// ---------- R8: compact возвращает sector_id ----------

test("105 R8: компакт — sectors содержат актуальный sector_id", () => {
  const m = baseModel();
  const w = probeWall(m);
  const sid = sectorByOffset(m, w, 500, 1000);
  const c = compactModel(m);
  const wallC = c.walls.find((x) => x.site_id === w.id)!;
  assert.deepEqual(wallC.sectors, [{ sector_id: sid, offset_mm: 500, width_mm: 1000 }]);
});

// ---------- R5 (Workspace.save): fault injection ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };
type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c } as unknown as NormalizeResult;
    },
    async save() {
      server.model = structuredClone(normalized!);
      afterSave(server);
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return COMPAT as never; },
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

function pairScenario(): { m: Model; corridorId: string; doorId: string } {
  const m = baseModel();
  prepareHolePoints(m);
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const door = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 1100 });
  addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: door.id });
  return { m, corridorId: corridor.id, doorId: door.id };
}

test("105 R5: normalize потерял hasReplacement → NORMALIZATION_DROPPED", async () => {
  const { m, corridorId, doorId } = pairScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const hole = (norm["walls"] as Record<string, { holes: Record<string, Record<string, unknown>> }>)[corridorId]!.holes[doorId]!;
    delete hole.hasReplacement;
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => (e as { code?: string }).code === "NORMALIZATION_DROPPED");
});

test("105 R5: сервер потерял hasReplacement после save → SITE_ERROR", async () => {
  const { m, corridorId, doorId } = pairScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const hole = (s.model["walls"] as Record<string, { holes: Record<string, Record<string, unknown>> }>)[corridorId]!.holes[doorId]!;    delete hole.hasReplacement;
  });
  await ws.open("0", "1");
  await assert.rejects(
    () => ws.save(),
    (e: unknown) => {
      const err = e as { code?: string; details?: Record<string, unknown> };
      return err.code === "SITE_ERROR" && Array.isArray(err.details?.["demolition_mismatches"]);
    },
  );
});

test("105 R5: сервер потерял demount проёма при demount=1 стены → SITE_ERROR", async () => {
  const m = baseModel();
  prepareHolePoints(m);
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const hole = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 1100 });
  demolish(m, { target: "wall", id: corridor.id });
  demolish(m, { target: "opening", id: hole.id });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const h = (s.model["walls"] as Record<string, { holes: Record<string, Record<string, unknown>> }>)[corridor.id]!.holes[hole.id]!;    delete h.demount;
  });
  await ws.open("0", "1");
  await assert.rejects(
    () => ws.save(),
    (e: unknown) => {
      const err = e as { code?: string; details?: Record<string, unknown> };
      return err.code === "SITE_ERROR" && Array.isArray(err.details?.["demolition_mismatches"]);
    },
  );
});
