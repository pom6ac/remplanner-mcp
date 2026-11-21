// 108: резолюция повторного ревью PR #14 — R2, R4, R10, R11.
// По каждой находке тест, падающий на 4cad482:
// R2 — mergeCollinear сохраняет мировые координаты секторов обеих стен;
// R4 — пара замены в updateOpening (пересечения, согласованный перенос, поиск пары);
// R10 — guard несоединённых концов отклоняет только НОВЫЕ дефекты;
// R11 — opening_delete возвращает все удалённые ID, описание говорит о каскаде.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model, Wall } from "../../src/model/types.ts";
import { demolish, demolishCancel } from "../../src/model/demolition.ts";
import { addWall, moveWall } from "../../src/model/walls.ts";
import { addOpening, updateOpening, deleteOpening, prepareHolePoints, holeOffsetCm } from "../../src/model/openings.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { NormalizeResult } from "../../src/editor/adapter.ts";
import type { LoadedModel } from "../../src/api.ts";
import { ServerContext } from "../../src/server/context.ts";
import { planTools } from "../../src/server/tools-plan.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

/** Свободная горизонтальная стена 6000 мм на оси y=-6000 (2 несоединённых конца). */
function probeWall(m: Model): Wall {
  prepareHolePoints(m);
  return addWall(m, { start: { x: 0, y: -6000 }, end: { x: 6000, y: -6000 } });
}

const centerCm = (wall: Wall, hole: { pc: { x: number; y: number }; width: number }): number =>
  holeOffsetCm(wall, hole as never) + hole.width / 2;

type Sector = { id: string; pc: { x: number; y: number }; width: number };
const sectorsOf = (w: Wall): Record<string, Sector> => (w.sectors ?? {}) as Record<string, Sector>;

// ---------- R2: mergeCollinear — мировые координаты секторов ----------

test("108 R2: продолжение слева — сектор существующей стены остаётся на месте (не сдвиг на 2000 мм)", () => {
  const m = baseModel();
  const w = probeWall(m);
  const res = demolish(m, { target: "wall", id: w.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  const sectorId = res.sectorId!;
  addWall(m, { start: { x: -2000, y: -6000 }, end: { x: 0, y: -6000 } });
  const s = sectorsOf(m.walls[w.id]!)[sectorId]!;
  assert.ok(s, "сектор пережил объединение");
  assert.equal(s.pc.x, 100, `центр сектора в мировых координатах x=100 см, получено ${s.pc.x}`);
  assert.equal(s.pc.y, -600);
});

test("108 R2: продолжение справа — сектор существующей стены остаётся на месте", () => {
  const m = baseModel();
  const w = probeWall(m);
  const res = demolish(m, { target: "wall", id: w.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  const sectorId = res.sectorId!;
  addWall(m, { start: { x: 6000, y: -6000 }, end: { x: 8000, y: -6000 } });
  const s = sectorsOf(m.walls[w.id]!)[sectorId]!;
  assert.ok(s, "сектор пережил объединение");
  assert.equal(s.pc.x, 100, `центр сектора x=100 см, получено ${s.pc.x}`);
  assert.equal(s.pc.y, -600);
});

test("108 R2: сектор на поглощаемой стене — мировые координаты сохраняются (оба порядка)", () => {
  const m = baseModel();
  prepareHolePoints(m);
  const left = addWall(m, { start: { x: -2000, y: -6000 }, end: { x: 0, y: -6000 } });
  const res = demolish(m, { target: "wall", id: left.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  const sectorId = res.sectorId!;
  addWall(m, { start: { x: 0, y: -6000 }, end: { x: 6000, y: -6000 } });
  // стена left поглощена или поглотила — сектор в мировых координатах x=-100 см
  const host = Object.values(m.walls).find((w) => sectorsOf(w)[sectorId]);
  assert.ok(host, "сектор пережил объединение");
  const s = sectorsOf(host)[sectorId]!;
  assert.equal(s.pc.x, -100, `центр сектора x=-100 см, получено ${s.pc.x}`);
  assert.equal(s.pc.y, -600);
});

// ---------- R10: guard несоединённых концов — только новые дефекты ----------

/** identity-нормализатор, отдающий реальные стены (как в воспроизведении ревью 107). */
function identityEditorRealWalls(): EditorLike {
  return {
    objectId: "123", planId: "1",
    async normalize(model) {
      const copy = structuredClone(model) as Record<string, unknown>;
      const walls = Object.values((model as { walls: Record<string, Wall> }).walls)
        .map((w) => ({ id: w.id, p1: w.p1, p2: w.p2, depth: w.depth }));
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

function wsWithIsolatedWall(): { ws: Workspace; isolated: Wall; top: Wall } {
  const m = baseModel();
  prepareHolePoints(m);
  const isolated = probeWall(m); // 2 несоединённых конца ДО операции
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  const ws = new Workspace(wsDeps(identityEditorRealWalls(), m));
  return { ws, isolated, top };
}

test("108 R10: демонтаж целой другой стены проходит при 2 унаследованных концах", async () => {
  const { ws, top } = wsWithIsolatedWall();
  await ws.open("123", "1");
  const { result } = await ws.applyWalls("demolish", (mm) => demolish(mm, { target: "wall", id: top.id }));
  assert.equal(result.wallId, top.id);
});

test("108 R10: демонтаж участка и отмена проходят при 2 унаследованных концах", async () => {
  const { ws, top } = wsWithIsolatedWall();
  await ws.open("123", "1");
  const { result } = await ws.applyWalls("demolish", (mm) => demolish(mm, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } }));
  assert.ok(result.sectorId);
  const { result: c } = await ws.applyWalls("demolish_cancel", (mm) => demolishCancel(mm, { target: "wall", id: top.id, sector_id: result.sectorId }));
  assert.equal(c.sectorId, result.sectorId);
});

test("108 R10: cancel заранее установленной пометки проходит при 2 унаследованных концах", async () => {
  const m = baseModel();
  prepareHolePoints(m);
  probeWall(m);
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  const { sectorId } = demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  const ws = new Workspace(wsDeps(identityEditorRealWalls(), m));
  await ws.open("123", "1");
  const { result } = await ws.applyWalls("demolish_cancel", (mm) => demolishCancel(mm, { target: "wall", id: top.id, sector_id: sectorId! }));
  assert.equal(result.sectorId, sectorId);
});

test("108 R10: wall_move изолированной стены проходит при 2 унаследованных концах", async () => {
  const { ws, isolated } = wsWithIsolatedWall();
  await ws.open("123", "1");
  await ws.applyWalls("wall_move", (mm) => moveWall(mm, { wallId: isolated.id, offsetMm: 200 }));
  assert.equal(ws.model.walls[isolated.id]!.p1.y, -620);
});

test("142: операция, создающая новый висячий конец, проходит с предупреждением wall_free_ends (мм)", async () => {
  const { ws } = wsWithIsolatedWall();
  await ws.open("123", "1");
  const { warnings } = await ws.applyWalls("wall_add", (mm) => addWall(mm, { start: { x: 0, y: 10000 }, end: { x: 3000, y: 10000 } }));
  const free = warnings.find((w) => w.startsWith("wall_free_ends"));
  assert.ok(free, `предупреждение wall_free_ends в warnings: ${JSON.stringify(warnings)}`);
  assert.match(free!, /\(0; 10000\)/, "первый конец в мм");
  assert.match(free!, /\(3000; 10000\)/, "второй конец в мм");
  // новая свободная стена в модели
  const added = Object.values(ws.model.walls).find((w) => w.p1.x === 0 && w.p1.y === 1000 && w.p2.x === 300 && w.p2.y === 1000);
  assert.ok(added, "свободная стена добавлена в модель");
});

// ---------- R4: пара замены в updateOpening ----------

function pairScenario(): { m: Model; wall: Wall; door: Wall["holes"][string]; rep: Wall["holes"][string] } {
  const m = baseModel();
  const wall = probeWall(m);
  const door = addOpening(m, { wallId: wall.id, type: "door", offsetMm: 2000 });
  const rep = addOpening(m, { wallId: wall.id, type: "doorway", replacesHoleId: door.id });
  delete door.at; // UI-модель: служебного at нет
  delete rep.at;
  return { m, wall, door, rep };
}

test("108 R4/354: размер и положение участников живой пары не меняются (исходный)", () => {
  const { m, wall, door, rep } = pairScenario();
  const before = structuredClone([wall.holes[door.id]!, wall.holes[rep.id]!]);
  assert.throws(
    () => updateOpening(m, { wallId: wall.id, holeId: door.id, heightMm: 2200 }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      return err.code === "INVALID_ARGUMENT" && /door_must_change/.test(err.message ?? "");
    },
  );
  assert.throws(
    () => updateOpening(m, { wallId: wall.id, holeId: door.id, offsetMm: 4000, offsetFrom: "axis" }),
    (e: unknown) => (e as { code?: string }).code === "INVALID_ARGUMENT",
  );
  assert.deepEqual([wall.holes[door.id]!, wall.holes[rep.id]!], before, "пара не изменена (отказ атомарен)");
});

test("108 R4/354: размер и положение замены не меняются (door_is_other_not_change); габарит наследуется", () => {
  const { m, wall, door, rep } = pairScenario();
  assert.equal(rep.width, door.width, "замена наследует ширину исходного");
  assert.equal(rep.height, door.height, "замена наследует высоту исходного");
  assert.equal((rep as unknown as { replacement?: number }).replacement, 1, "у замены поле replacement=1");
  const before = structuredClone([wall.holes[door.id]!, wall.holes[rep.id]!]);
  assert.throws(
    () => updateOpening(m, { wallId: wall.id, holeId: rep.id, heightMm: 2200 }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      return err.code === "INVALID_ARGUMENT" && /door_is_other_not_change/.test(err.message ?? "");
    },
  );
  assert.throws(
    () => updateOpening(m, { wallId: wall.id, holeId: rep.id, centerMm: 5000 }),
    (e: unknown) => (e as { code?: string }).code === "INVALID_ARGUMENT",
  );
  assert.deepEqual([wall.holes[door.id]!, wall.holes[rep.id]!], before, "пара не изменена");
});

test("108 R4/354: явная ширина замены — INVALID_ARGUMENT (замена ставится в габарит исходного)", () => {
  const m = baseModel();
  const wall = probeWall(m);
  const door = addOpening(m, { wallId: wall.id, type: "door", offsetMm: 2000 });
  assert.throws(
    () => addOpening(m, { wallId: wall.id, type: "doorway", replacesHoleId: door.id, widthMm: 1200 }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      return err.code === "INVALID_ARGUMENT" && /габарит исходного/.test(err.message ?? "");
    },
  );
});

test("108 R4/354: замена наследует ширину исходной двери 900 (не умолчание doorway 800)", () => {
  const m = baseModel();
  const wall = probeWall(m);
  const door = addOpening(m, { wallId: wall.id, type: "door", offsetMm: 1000, widthMm: 900 });
  const rep = addOpening(m, { wallId: wall.id, type: "doorway", replacesHoleId: door.id });
  assert.equal(door.width, 90);
  assert.equal(rep.width, 90, "габарит замены = габарит исходного (restore редактора)");
  assert.equal(rep.height, door.height);
});

test("108 R4/354: окно поверх двери пару не образует — INVALID_ARGUMENT (setReplacement)", () => {
  const m = baseModel();
  const wall = probeWall(m);
  const door = addOpening(m, { wallId: wall.id, type: "door", offsetMm: 2000 });
  assert.throws(
    () => addOpening(m, { wallId: wall.id, type: "window", replacesHoleId: door.id }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      return err.code === "INVALID_ARGUMENT" && /окно поверх двери/.test(err.message ?? "");
    },
  );
});

test("108 R4/354: снятие замены возвращает исходному правку размеров", () => {
  const { m, wall, door, rep } = pairScenario();
  deleteOpening(m, wall.id, rep.id);
  assert.equal(door.hasReplacement, undefined, "hasReplacement снят");
  updateOpening(m, { wallId: wall.id, holeId: door.id, heightMm: 2200 });
  assert.equal(wall.holes[door.id]!.height, 220, "после снятия замены размер меняется");
});

test("108 R4: пара ищется по связи — delete одной пары не ломает другую", () => {
  const m = baseModel();
  const wall = probeWall(m);
  const door1 = addOpening(m, { wallId: wall.id, type: "door", offsetMm: 1000 });
  const rep1 = addOpening(m, { wallId: wall.id, type: "doorway", replacesHoleId: door1.id });
  const door2 = addOpening(m, { wallId: wall.id, type: "door", offsetMm: 4000 });
  const rep2 = addOpening(m, { wallId: wall.id, type: "doorway", replacesHoleId: door2.id });
  delete door1.at; delete rep1.at; delete door2.at; delete rep2.at;
  deleteOpening(m, wall.id, door1.id);
  assert.equal(wall.holes[rep1.id], undefined, "замена первой пары удалена");
  assert.ok(wall.holes[door2.id], "вторая пара не тронута");
  assert.ok(wall.holes[rep2.id], "замена второй пары на месте");
  assert.equal(wall.holes[door2.id]!.hasReplacement, 1);
});

// ---------- R11: opening_delete — каскад в описании и все удалённые ID ----------

test("108 R11: deleteOpening возвращает все удалённые ID (исходный + замена)", () => {
  const { m, wall, door, rep } = pairScenario();
  const res = deleteOpening(m, wall.id, door.id);
  assert.deepEqual(res.deleted.sort(), [door.id, rep.id].sort());
  assert.equal(wall.holes[door.id], undefined);
  assert.equal(wall.holes[rep.id], undefined);
});

test("108 R11: deleteOpening без пары возвращает один ID", () => {
  const m = baseModel();
  const wall = probeWall(m);
  const door = addOpening(m, { wallId: wall.id, type: "door", offsetMm: 2000 });
  const res = deleteOpening(m, wall.id, door.id);
  assert.deepEqual(res.deleted, [door.id]);
});

test("108 R11: инструмент opening_delete — описание упоминает каскад, ответ содержит все ID", async () => {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const tools = planTools(ctx);
  const desc = tools["opening_delete"]!.description;
  assert.ok(/каскад|вместе с ним|замен/i.test(desc), `описание говорит о каскаде: ${desc}`);
  const text = (r: { content: unknown }): Record<string, unknown> =>
    JSON.parse((r.content as Array<{ text?: string }>)[0]!.text!) as Record<string, unknown>;
  const door = (text(await tools["opening_add"]!.handler({ wall_id: "W1", type: "door", offset_mm: 2000 }))["entity"] ?? {}) as { id: string };
  const rep = (text(await tools["opening_add"]!.handler({ wall_id: "W1", type: "doorway", replaces: door.id }))["entity"] ?? {}) as { id: string };
  const del = text(await tools["opening_delete"]!.handler({ opening_id: door.id })) as { deleted: string[] };
  assert.deepEqual([...del.deleted].sort(), [door.id, rep.id].sort());
});
