// 130: закрытие находок ревью 129 (.orca-reports/129-review-claude-replan.md) на ветке feat/replan (PR #14).
// Тесты падают на dd5dd27:
//   C1 (major) — demolitionSignature считает t участка и центр замены от p1; разворот оси
//     стены нормализатором (p1/p2 поменялись) даёт ложное расхождение;
//   C2 (major) — при смене ID стены сверка demount пропускается (continue): потеря
//     demount/участков/пометок проёмов проходит молча;
//   C3 — sector_id через `in` (прототип: «toString» проходит);
//   C4 — материал c_* на plan:"a" не отклоняется (обход PRO-гейта);
//   C5 — holes:null в серверной модели → TypeError вместо сообщения о расхождении;
//   C6 — в тексте расхождения участки в мм подписаны «см».
//   П.5 — перегородка (plan:"c") через комнату с контуром тёплого пола (#16):
//     guard климата не блокирует (пересечение перегородки с контуром редактор не запрещает).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model, Wall } from "../../src/model/types.ts";
import { demolish, demolishCancel, demolitionMismatches } from "../../src/model/demolition.ts";
import { addOpening, prepareHolePoints } from "../../src/model/openings.ts";
import { addWall, updateWall } from "../../src/model/walls.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { NormalizeResult } from "../../src/editor/adapter.ts";
import type { LoadedModel } from "../../src/api.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;
const base = (): Model => (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;

const topOf = (m: Model): Wall => Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
/** Разворот оси стены нормализатором: p1/p2 меняются местами. */
const flip = (w: Wall) => { const p = w.p1; w.p1 = w.p2; w.p2 = p; };

function editor(tw: (copy: Model) => void, serverModel: { v: Model | null }): EditorLike {
  return {
    objectId: "123", planId: "1",
    async normalize(model) {
      const copy = structuredClone(model) as Model;
      tw(copy);
      serverModel.v = structuredClone(copy);
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
    async loadModel() { return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", data_empty: false, model: structuredClone((m as unknown) as Record<string, unknown>) as never }; },
    async openEditor() { return ed; },
  } as WorkspaceDeps;
  const w = new Workspace(deps);
  (w as unknown as { writeBackup: unknown }).writeBackup = async () => {};
  return w;
}

// ---------- C1: разворот оси стены нормализатором ----------

test("130 C1: разворот оси стены с участком демонтажа — не расхождение", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  const after = structuredClone(m.walls) as Record<string, Wall>; flip(after[top.id]!);
  assert.deepEqual(demolitionMismatches(m.walls, after), []);
});

test("130 C1: разворот оси при паре замены без at — не расхождение", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  const a = addOpening(m, { wallId: top.id, type: "door", offsetMm: 1000 });
  const r = addOpening(m, { wallId: top.id, type: "doorway", replacesHoleId: a.id });
  delete a.at; delete r.at;
  const after = structuredClone(m.walls) as Record<string, Wall>; flip(after[top.id]!);
  assert.deepEqual(demolitionMismatches(m.walls, after), []);
});

test("130 C1: разворот оси при демонтаже целиком — не расхождение", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  demolish(m, { target: "wall", id: top.id });
  const after = structuredClone(m.walls) as Record<string, Wall>; flip(after[top.id]!);
  assert.deepEqual(demolitionMismatches(m.walls, after), []);
});

test("130 C1: workspace/normalize — demolish участка при развороте оси проходит", async () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  const serverModel = { v: null as Model | null };
  const W = ws(m, editor((c) => { const t = c.walls[top.id]; if (t?.sectors) flip(t); }, serverModel));
  await W.open("123", "1");
  await W.applyWalls("demolish", (mm) => demolish(mm, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } }));
});

test("130 C1: workspace/save — разворот оси на сервере не блокирует verified save", async () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  const serverModel = { v: structuredClone(m) as Model | null };
  const W = ws(m, editor((c) => { const t = c.walls[top.id]; if (t?.sectors) flip(t); }, serverModel));
  await W.open("123", "1");
  const res = await W.save();
  assert.equal(res.verified, true);
});

// ---------- C2: смена ID стены нормализатором ----------

test("130 C2: переименование стены без потери пометок — не расхождение", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  const after = structuredClone(m.walls) as Record<string, Wall>;
  const t = after[top.id]!; delete after[top.id]; t.id = "renum"; after["renum"] = t;
  assert.deepEqual(demolitionMismatches(m.walls, after), []);
});

test("130 C2: переименование стены с потерей demount — расхождение", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  demolish(m, { target: "wall", id: top.id });
  const after = structuredClone(m.walls) as Record<string, Wall>;
  const t = after[top.id]!; delete after[top.id]; t.id = "renum"; t.demount = 0; t.p1.demount = 0; t.p2.demount = 0; after["renum"] = t;
  const problems = demolitionMismatches(m.walls, after);
  assert.ok(problems.some((p) => p.includes("demount")), JSON.stringify(problems));
});

test("130 C2: переименование стены с потерей участка — расхождение", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  const after = structuredClone(m.walls) as Record<string, Wall>;
  const t = after[top.id]!; delete after[top.id]; t.id = "renum"; delete t.sectors; after["renum"] = t;
  const problems = demolitionMismatches(m.walls, after);
  assert.ok(problems.some((p) => p.includes("участк")), JSON.stringify(problems));
});

test("130 C2: переименование стены с потерей demount проёма — расхождение", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  const h = addOpening(m, { wallId: top.id, type: "door", offsetMm: 1000 });
  h.demount = 1;
  const after = structuredClone(m.walls) as Record<string, Wall>;
  const t = after[top.id]!; delete after[top.id]; t.id = "renum"; t.holes![h.id]!.demount = 0; after["renum"] = t;
  const problems = demolitionMismatches(m.walls, after);
  assert.ok(problems.some((p) => p.includes(`проём ${h.id}`)), JSON.stringify(problems));
});

test("130 C2: workspace/normalize — demolish стены при переименовании и потере demount отклоняется", async () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  const serverModel = { v: null as Model | null };
  const W = ws(m, editor((c) => {
    const t = c.walls[top.id];
    if (t?.demount === 1) { delete c.walls[top.id]; t.id = "renum"; t.demount = 0; t.p1.demount = 0; t.p2.demount = 0; c.walls["renum"] = t; }
  }, serverModel));
  await W.open("123", "1");
  await assert.rejects(
    W.applyWalls("demolish", (mm) => demolish(mm, { target: "wall", id: top.id })),
    (e: unknown) => (e as { code?: string }).code === "INVALID_GEOMETRY",
  );
});

test("130 C2: workspace/save — потеря demount при переименовании на сервере не verified", async () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  demolish(m, { target: "wall", id: top.id });
  // normalize пометок не трогает и serverModel не перезаписывает (pre-save сверка проходит),
  // сервер после save возвращает стену под другим ID без demount
  const serverModel = { v: structuredClone(m) as Model | null };
  const noopEditor = { v: null as Model | null };
  const W = ws(m, editor(() => {}, noopEditor));
  W.deps.loadModel = async () => {
    const src = serverModel.v!;
    return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", data_empty: false, model: structuredClone(src as unknown as Record<string, unknown>) as never };
  };
  await W.open("123", "1");
  W.model.walls[top.id]!.demount = 1;
  W.model.walls[top.id]!.p1.demount = 1;
  W.model.walls[top.id]!.p2.demount = 1;
  const raw = serverModel.v!;
  const t = raw.walls[top.id]!; delete raw.walls[top.id]; t.id = "renum"; t.demount = 0; t.p1.demount = 0; t.p2.demount = 0; raw.walls["renum"] = t;
  await assert.rejects(
    W.save(),
    (e: unknown) => (e as { code?: string }).code === "SITE_ERROR",
  );
});

// ---------- C3: sector_id и прототип ----------

test("130 C3: demolish_cancel с sector_id=toString — NOT_FOUND", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  assert.throws(() => demolishCancel(m, { target: "wall", id: top.id, sector_id: "toString" }), (e: unknown) => (e as { code?: string }).code === "NOT_FOUND");
});

// ---------- C4: материал c_* на plan:"a" ----------

test("130 C4: addWall с material c_glass на plan:a отклоняется", () => {
  const m = base(); prepareHolePoints(m);
  assert.throws(
    () => addWall(m, { start: { x: 0, y: 10000 }, end: { x: 3000, y: 10000 }, material: "c_glass", plan: "a" }),
    (e: unknown) => (e as { code?: string }).code === "INVALID_ARGUMENT",
  );
});

test("130 C4: updateWall стены plan:a материалом c_pgb отклоняется", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  assert.throws(
    () => updateWall(m, { wallId: top.id, material: "c_pgb" }),
    (e: unknown) => (e as { code?: string }).code === "INVALID_ARGUMENT",
  );
});

// ---------- C5: holes:null ----------

test("130 C5: holes:null у стены после операции — сообщение, не TypeError", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  const h = addOpening(m, { wallId: top.id, type: "door", offsetMm: 1000 });
  const after = structuredClone(m.walls) as Record<string, Wall & { holes: unknown }>;
  (after[top.id] as { holes: unknown }).holes = null;
  const problems = demolitionMismatches(m.walls, after);
  assert.ok(problems.some((p) => p.includes(`проём ${h.id}`)), JSON.stringify(problems));
});

// ---------- C6: единицы в тексте расхождения ----------

test("130 C6: текст расхождения участка — единицы мм", () => {
  const m = base(); prepareHolePoints(m);
  const top = topOf(m);
  demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  const after = structuredClone(m.walls) as Record<string, Wall>;
  const s = Object.values(after[top.id]!.sectors!)[0]!; s.width = 150;
  const problems = demolitionMismatches(m.walls, after);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /мм/);
  assert.doesNotMatch(problems[0]!, /см/);
});

// ---------- П.5: перегородка plan:c через комнату с контуром тёплого пола (#16) ----------

test("130: перегородка через комнату с тёплым полом — guard климата не блокирует", async () => {
  const { addWarmFloor } = await import("../../src/model/climate.ts");
  const { splitWall } = await import("../../src/model/walls.ts");
  const m = base(); prepareHolePoints(m);
  // контур тёплого пола внутри верхне-левой комнаты (внутренняя область x 10..290, y -290..-10)
  addWarmFloor(m, { kind: "cable", corner1: { x: 300, y: -2700 }, corner2: { x: 2700, y: -300 } });
  assert.equal(Object.keys(m.warm_floors ?? {}).length, 1, "контур добавлен");
  const serverModel = { v: null as Model | null };
  // normalize — сквозной: перегородка не меняет rooms2 (комнаты «до/после» строит
  // редактор по своим листам; в рамках этого PR контур и комнаты не перестраиваются)
  const W = ws(m, editor(() => {}, serverModel));
  await W.open("123", "1");
  // перегородка plan:c через комнату с контуром: разрезаем стены, ставим между узлами
  await W.applyWalls("wall_add", (mm) => {
    splitWall(mm, "w1", 1500);
    splitWall(mm, "w5", 1400);
    addWall(mm, { start: { x: 1500, y: -3000 }, end: { x: 1500, y: 0 }, thicknessMm: 100, material: "c_pgb", plan: "c" });
  });
  assert.ok(Object.values(W.model.walls).some((w) => w.plan === "c"), "перегородка в модели");
  assert.equal(Object.keys(W.model.warm_floors ?? {}).length, 1, "контур тёплого пола на месте");
});

test("130: перегенерация ID комнат при нормализации не блокирует контур (сверка по геометрии)", async () => {
  const { addWarmFloor } = await import("../../src/model/climate.ts");
  const m = base(); prepareHolePoints(m);
  addWarmFloor(m, { kind: "cable", corner1: { x: 300, y: -2700 }, corner2: { x: 2700, y: -300 } });
  const serverModel = { v: null as Model | null };
  const W = ws(m, editor((c) => {
    // редактор штатно регенерирует id комнат при пересчёте (и обновляет id_room контуров):
    // геометрия комнат та же, id новые
    const rooms2 = c.rooms2 as Record<string, unknown> | undefined;
    if (rooms2) {
      const map: Record<string, string> = {};
      c.rooms2 = Object.fromEntries(Object.entries(rooms2).map(([k, v], i) => { map[k] = `regen${i}`; return [`regen${i}`, v]; }));
      for (const wf of Object.values(c.warm_floors ?? {})) {
        if (wf.id_room && map[wf.id_room]) wf.id_room = map[wf.id_room]!;
      }
    }
  }, serverModel));
  await W.open("123", "1");
  const { splitWall } = await import("../../src/model/walls.ts");
  await W.applyWalls("wall_add", (mm) => {
    splitWall(mm, "w1", 1500);
    splitWall(mm, "w5", 1400);
    addWall(mm, { start: { x: 1500, y: -3000 }, end: { x: 1500, y: 0 }, thicknessMm: 100, material: "c_pgb", plan: "c" });
  });
  assert.ok(Object.values(W.model.walls).some((w) => w.plan === "c"), "перегородка в модели");
});
