// 133: закрытие находок повторного ревью PR #14 (.orca-reports/133-rereview-claude-replan.md).
// Тесты падают на 932edf2:
//   N1 (major) — перегородка plan:"c" через комнату с тёплым полом: живая проба
//     (p135-n1/n1b/n1c, анонимный проект) установила, что редактор перестраивает rooms2
//     ПРИ SAVE и сам переназначает id_room контура на новую комнату (эталон
//     ui-ref-replan-partition-warmfloor.json); сверка id_room в режиме save была строгой —
//     ложный блок штатного save. Перегородка, ось которой проходит через контур, удаляет
//     контур при save молча — теперь осознанный отказ до записи.
//   N2 — центр замены считался из служебного at: при развороте оси с сохранённым at
//     ложное расхождение «центр 1500 → 4500».
//   N3 — слитая коллинеарная стена с пометкой demount проёма: пара не находилась
//     (точное совпадение оси) — «стена с пометками демонтажа отсутствует».
//   N5 — прямое совпадение по ID не проверяло usedAfter: сопоставление переставало
//     быть один-к-одному при пересечении ID.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model, Wall } from "../../src/model/types.ts";
import { demolish, demolitionMismatches } from "../../src/model/demolition.ts";
import { addOpening, prepareHolePoints } from "../../src/model/openings.ts";
import { addWall, splitWall } from "../../src/model/walls.ts";
import { addWarmFloor, warmFloorMismatches } from "../../src/model/climate.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { NormalizeResult } from "../../src/editor/adapter.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;
const base = (): Model => (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
const REF = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/ui-ref-replan-partition-warmfloor.json", import.meta.url).pathname, "utf8"),
) as { after_partition: { rooms2: Record<string, unknown>; warm_floors: Record<string, unknown> } };

const topOf = (m: Model): Wall => Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
/** Разворот оси стены нормализатором: p1/p2 меняются местами. */
const flip = (w: Wall) => { const p = w.p1; w.p1 = w.p2; w.p2 = p; };

function editor(tw: (copy: Model) => void): EditorLike {
  return {
    objectId: "123", planId: "1",
    async normalize(model) {
      const copy = structuredClone(model) as Model;
      tw(copy);
      const walls = Object.values(copy.walls).map((w) => ({ id: w.id, p1: w.p1, p2: w.p2, depth: w.depth }));
      const c = { walls: walls.length, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: copy, rooms: [], before: c, after: c, walls, errors: null } as unknown as NormalizeResult;
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { present: {} } as never; },
    async close() {},
  } as EditorLike;
}
function ws(m: Model, ed: EditorLike): Workspace {
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel() { return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", data_empty: false, model: structuredClone(m) as never }; },
    async openEditor() { return ed; },
  } as WorkspaceDeps;
  const w = new Workspace(deps);
  (w as unknown as { writeBackup: unknown }).writeBackup = async () => {};
  return w;
}

// ---------- N1: перегородка через комнату с тёплым полом ----------

test("133 N1: точная форма редактора (эталон) — переназначение id_room при save не расхождение", () => {
  // нормализованное ожидание: контур в комнате rA с комнатами ДО перегородки
  const roomsBefore: Record<string, unknown> = {
    rA: { area: 7.84, polygon: [{ x: 290, y: -290 }, { x: 290, y: -10 }, { x: 10, y: -10 }, { x: 10, y: -290 }] },
  };
  const wf = structuredClone(REF.after_partition.warm_floors) as Record<string, { id_room?: string | null; polygon?: { x: number; y: number }[] }>;
  wf["wf1"]!.id_room = "rA";
  const problems = warmFloorMismatches(
    wf as never,
    structuredClone(REF.after_partition.warm_floors) as never,
    { mode: "save", roomsExpected: roomsBefore, roomsGot: REF.after_partition.rooms2 as never },
  );
  assert.deepEqual(problems, [], JSON.stringify(problems));
});

test("133 N1: подмена id_room на комнату без контура — расхождение (save)", () => {
  const rooms: Record<string, unknown> = {
    rA: { area: 7.84, polygon: [{ x: 290, y: -290 }, { x: 290, y: -10 }, { x: 10, y: -10 }, { x: 10, y: -290 }] },
    rX: { area: 5.04, polygon: [{ x: 490, y: -290 }, { x: 490, y: -10 }, { x: 310, y: -10 }, { x: 310, y: -290 }] },
  };
  const wf = structuredClone(REF.after_partition.warm_floors) as Record<string, { id_room?: string | null }>;
  wf["wf1"]!.id_room = "rX";
  const problems = warmFloorMismatches(
    structuredClone(REF.after_partition.warm_floors) as never,
    wf as never,
    { mode: "save", roomsExpected: rooms, roomsGot: rooms },
  );
  assert.ok(problems.some((p) => p.includes("id_room изменился")), JSON.stringify(problems));
});

test("133 N1: mock перестраивает rooms2 как редактор — перегородка не блокируется", async () => {
  const { addWarmFloor: awf } = await import("../../src/model/climate.ts");
  const m = base(); prepareHolePoints(m);
  // контур на ПРАВОЙ половине будущей перегородки (как в эталоне): x 160..280 см
  const wf = awf(m, { kind: "cable", corner1: { x: 1600, y: -2400 }, corner2: { x: 2800, y: -600 } });
  assert.ok(wf.id_room, "контур привязан к комнате");
  const W = ws(m, editor((c) => {
    // редактор перестраивает rooms2 при save: комната делится перегородкой x=150,
    // id_room контура переназначается на новую комнату (живая проба p135-n1b)
    if (!Object.values(c.walls).some((w) => w.plan === "c")) return;
    const rooms2 = c.rooms2 as Record<string, { polygon: { x: number; y: number }[] }>;
    const r = rooms2[wf.id_room!]!;
    const right = structuredClone(r);
    r.polygon = [{ x: 145, y: -290 }, { x: 145, y: -10 }, { x: 10, y: -10 }, { x: 10, y: -290 }];
    right.polygon = [{ x: 290, y: -290 }, { x: 290, y: -10 }, { x: 155, y: -10 }, { x: 155, y: -290 }];
    rooms2["_newroom"] = right;
    wf.id_room = "_newroom";
    for (const g of Object.values(c.warm_floors ?? {})) g.id_room = "_newroom";
  }));
  await W.open("123", "1");
  const r = await W.applyWalls("wall_add", (mm) => {
    splitWall(mm, "w1", 1500);
    splitWall(mm, "w5", 1400);
    addWall(mm, { start: { x: 1500, y: -3000 }, end: { x: 1500, y: 0 }, thicknessMm: 100, material: "c_pgb", plan: "c" });
  }).then((res) => `ok:${res.warnings.filter((w) => w.startsWith("room_")).join("|")}`, (e) => `${e.code}: ${e.message} ${JSON.stringify(e.details)}`);
  assert.equal(r, "ok:room_topology_changed: room _uwwgk: split при нормализации — имя помещения (none) не сверяется, проверьте rooms_list после сохранения", String(r));
  assert.equal(Object.keys(W.model.warm_floors ?? {}).length, 1, "контур на месте");
});

test("133 N1: перегородка через контур тёплого пола — отказ до записи с hint", async () => {
  const { addWarmFloor: awf } = await import("../../src/model/climate.ts");
  const m = base(); prepareHolePoints(m);
  awf(m, { kind: "cable", corner1: { x: 300, y: -2700 }, corner2: { x: 2700, y: -300 } });
  assert.throws(
    () => addWall(m, { start: { x: 1500, y: -3000 }, end: { x: 1500, y: 0 }, thicknessMm: 100, material: "c_pgb", plan: "c" }),
    (e: unknown) => {
      const err = e as { code?: string; details?: { kind?: string }; hint?: string };
      return err.code === "INVALID_GEOMETRY" && err.details?.kind === "partition_crosses_warm_floor" && Boolean(err.hint);
    },
    "перегородка через контур должна отклоняться",
  );
  // исходная стена план:a — проверка не применяется (демонтаж исходных стен не удаляет контуры)
  addWall(m, { start: { x: 1500, y: -3000 }, end: { x: 1500, y: 0 }, thicknessMm: 100, material: "a_block" });
  assert.equal(Object.keys(m.warm_floors ?? {}).length, 1, "контур на месте");
});

// ---------- N2: центр замены при развороте оси с сохранённым at ----------

test("133 N2: разворот оси при сохранённом at — центр замены по проекции pc", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  const a = addOpening(m, { wallId: top.id, type: "door", offsetMm: 1000 });
  addOpening(m, { wallId: top.id, type: "doorway", replacesHoleId: a.id });
  const after = structuredClone(m.walls); flip(after[top.id]!);
  assert.deepEqual(demolitionMismatches(m.walls, after), []);
});

// ---------- N3: слитая коллинеарная стена с пометкой demount проёма ----------

test("133 N3: пара по включению отрезка — проём с demount на слитой стене сохранён", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  const { first, second } = splitWall(m, top.id, 3000);
  const h = addOpening(m, { wallId: second.id, type: "door", offsetMm: 1000 });
  demolish(m, { target: "opening", id: h.id });
  const after = structuredClone(m.walls);
  const f = after[first.id]!; const s = after[second.id]!;
  f.p2 = s.p2; f.holes = { ...(f.holes ?? {}), ...(s.holes ?? {}) };
  delete after[second.id];
  assert.deepEqual(demolitionMismatches(m.walls, after), [], JSON.stringify(demolitionMismatches(m.walls, after)));
});

test("133 N3: участок демонтажа на слитой стене — сдвиг начала оси учитывается", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  const { second } = splitWall(m, top.id, 3000);
  demolish(m, { target: "wall", id: second.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  const after = structuredClone(m.walls);
  const f = after[top.id]!; const s = after[second.id]!;
  f.p2 = s.p2; f.sectors = { ...(f.sectors ?? {}), ...(s.sectors ?? {}) };
  delete after[second.id];
  assert.deepEqual(demolitionMismatches(m.walls, after), [], JSON.stringify(demolitionMismatches(m.walls, after)));
});

test("133 N3: стена не покрывает прежнюю ось — расхождение остаётся", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  const { second } = splitWall(m, top.id, 3000);
  demolish(m, { target: "wall", id: second.id });
  const after = structuredClone(m.walls);
  const f = after[top.id]!;
  f.p2 = { ...f.p2, x: f.p2.x - 500 }; // after-стена КОРОЧЕ прежней — покрытия нет
  delete after[second.id];
  const problems = demolitionMismatches(m.walls, after);
  assert.ok(problems.some((p) => p.includes("стена с пометками демонтажа отсутствует")), JSON.stringify(problems));
});

// ---------- N5: один-к-одному — сначала все прямые ID, затем геометрия ----------

test("133 N5: прямой ID не используется дважды (пересечение ID и геометрии)", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const other = Object.values(m.walls).find((w) => w.id !== top.id && w.id !== corridor.id)!;
  // перенумерация с пересечением ID: коридорная стена → «C», другая стена → «W2»;
  // в after коридорная стена получает id «W2» (совпадает с before-«W2»)
  const idC = "C", idW2 = "W2";
  m.walls[idC] = corridor; delete m.walls[corridor.id];
  m.walls[idW2] = other; delete m.walls[other.id];
  m.walls[idC]!.demount = 1;
  m.walls[idW2]!.demount = 1;
  const after = structuredClone(m.walls);
  // после: стена «W2» (before-«other») исчезла, коридорная «C» переименована в «W2»
  delete after[idW2];
  const c = after[idC]!; delete after[idC]; c.id = idW2; after[idW2] = c;
  assert.ok(after[idW2] && !after[idC]);
  const problems = demolitionMismatches(m.walls, after);
  // старый код: W2 (по ID) и C (по геометрии) ссылались на одну after-стену — 0 проблем,
  // потеря пометки W2 проходила молча; теперь остаётся ровно одна расхождение
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0]!, /wall W2: стена с пометками демонтажа отсутствует/);
});
