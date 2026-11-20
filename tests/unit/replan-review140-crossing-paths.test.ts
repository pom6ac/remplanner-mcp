// Этап 140, m1 ревью 136: отказ partition_crosses_warm_floor применяется во ВСЕХ путях
// мутаций стен, а не только wall_add. Живой факт (проба p135 P4/P5, анонимный проект):
// walls_add_polyline kind=partition, room_add_rect/room_add_polygon с plan:"c",
// wall_move/wall_update перегородки в контур проходили без отказа — редактор удалял
// контур при save, потеря всплывала SITE_ERROR уже на сервере. Фикс: после операции
// в applyWalls сверяются оси plan:"c" «до → после» (assertNoNewWarmFloorCrossing);
// неизменённые перегородки моделей из UI с унаследованным сочетанием не блокируются
// (ревью 136 P3 — запрет только на новое действие). Тесты падают на f2a685b.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model, Wall } from "../../src/model/types.ts";
import { prepareForRestore, addWall, addPolyline, addRoomRect, addRoomPolygon, moveWall, updateWall, splitWall } from "../../src/model/walls.ts";
import { prepareHolePoints } from "../../src/model/openings.ts";
import { addWarmFloor } from "../../src/model/climate.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { NormalizeResult } from "../../src/editor/adapter.ts";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url));
const base = (): Model => (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;

/** Модель с контуром на правой половине комнаты 7,84 (x 160..280, y -240..-60), как в эталоне. */
function withWarmFloor(): { m: Model; wf: { id: string; id_room?: string | null } } {
  const m = base(); prepareHolePoints(m);
  const wf = addWarmFloor(m, { kind: "cable", corner1: { x: 1600, y: -2400 }, corner2: { x: 2800, y: -600 } });
  return { m, wf };
}

/** Модель из UI: перегородка x=190 уже стоит в контуре (унаследованное сочетание). */
function withInheritedCrossing(): { m: Model; partitionId: string } {
  const { m } = withWarmFloor();
  m.walls["px"] = {
    id: "px", plan: "c", role: "wall", child: 0, archive: 0, demount: 0,
    depth: 10, height: 270, p1: { x: 190, y: -290 }, p2: { x: 190, y: -10 }, p1st: 0, p2st: 0,
    material: "c_pgb", color: 0, level: "1", show_dls: true, holes: {},
  } as never;
  return { m, partitionId: "px" };
}

function editor(): EditorLike {
  return {
    objectId: "123", planId: "1",
    async normalize(model) {
      const copy = structuredClone(model) as Model;
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

function ws(m: Model): Workspace {
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel() { return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", data_empty: false, model: structuredClone(m) as never }; },
    async openEditor() { return editor(); },
  } as WorkspaceDeps;
  const w = new Workspace(deps);
  (w as unknown as { writeBackup: unknown }).writeBackup = async () => {};
  return w;
}

async function opError(w: Workspace, label: string, fn: (m: Model) => void): Promise<{ code: string; kind?: string }> {
  try {
    await w.applyWalls(label, fn);
  } catch (e) {
    const err = e as { code?: string; details?: { kind?: string } };
    return { code: err.code ?? "?", kind: err.details?.kind };
  }
  return { code: "ok" };
}

const CROSS = { code: "INVALID_GEOMETRY", kind: "partition_crosses_warm_floor" };

test("140 m1: walls_add_polyline plan:\"c\" через контур — отказ до записи", async () => {
  const { m } = withWarmFloor();
  const w = ws(m);
  await w.open("123", "1");
  assert.deepEqual(await opError(w, "walls_add_polyline", (mm) => {
    addPolyline(mm, { points: [{ x: 1900, y: -2900 }, { x: 1900, y: -100 }], thicknessMm: 100, material: "c_pgb", plan: "c" });
  }), CROSS);
  // та же ломаная левее контура — проходит
  assert.deepEqual(await opError(w, "walls_add_polyline", (mm) => {
    addPolyline(mm, { points: [{ x: 600, y: -2900 }, { x: 600, y: -100 }], thicknessMm: 100, material: "c_pgb", plan: "c" });
  }), { code: "ok" });
});

test("140 m1: room_add_rect plan:\"c\" стороной через контур — отказ до записи", async () => {
  const { m } = withWarmFloor();
  const w = ws(m);
  await w.open("123", "1");
  assert.deepEqual(await opError(w, "room_add_rect", (mm) => {
    addRoomRect(mm, { origin: { x: 1700, y: -2300 }, widthMm: 500, depthMm: 500, thicknessMm: 100, material: "c_pgb", plan: "c" });
  }), CROSS);
});

test("140 m1: room_add_polygon plan:\"c\" через контур — отказ до записи", async () => {
  const { m } = withWarmFloor();
  const w = ws(m);
  await w.open("123", "1");
  assert.deepEqual(await opError(w, "room_add_polygon", (mm) => {
    addRoomPolygon(mm, {
      points: [{ x: 1700, y: -2300 }, { x: 2300, y: -2300 }, { x: 2300, y: -1700 }, { x: 1700, y: -1700 }],
      thicknessMm: 100, material: "c_pgb", plan: "c",
    });
  }), CROSS);
});

test("140 m1: wall_move переносит перегородку в контур — отказ до записи", async () => {
  const { m } = withWarmFloor();
  const p = addWall(m, { start: { x: 1000, y: -2900 }, end: { x: 1000, y: -100 }, thicknessMm: 100, material: "c_pgb", plan: "c" });
  const w = ws(m);
  await w.open("123", "1");
  // +900 мм вправо: ось x=100 → x=190 — через контур (x 160..280)
  assert.deepEqual(await opError(w, "wall_move", (mm) => {
    moveWall(mm, { wallId: p.id, offsetMm: 900 });
  }), CROSS);
  // перенос в пределах свободного места — проходит
  assert.deepEqual(await opError(w, "wall_move", (mm) => {
    moveWall(mm, { wallId: p.id, offsetMm: -300 });
  }), { code: "ok" });
});

test("140 m1: wall_update переносит конец перегородки в контур — отказ до записи", async () => {
  const { m } = withWarmFloor();
  const p = addWall(m, { start: { x: 1000, y: -2900 }, end: { x: 1000, y: -100 }, thicknessMm: 100, material: "c_pgb", plan: "c" });
  const w = ws(m);
  await w.open("123", "1");
  assert.deepEqual(await opError(w, "wall_update", (mm) => {
    updateWall(mm, { wallId: p.id, start: { x: 2000, y: -2900 } });
  }), CROSS);
});

test("140 m1: существующая перегородка в контуре (модель из UI) — update материала и чужой wall_move не блокируются", async () => {
  const { m, partitionId } = withInheritedCrossing();
  const w = ws(m);
  await w.open("123", "1");
  // смена материала без переноса — ось не изменилась, запрет не задевает
  assert.deepEqual(await opError(w, "wall_update", (mm) => {
    updateWall(mm, { wallId: partitionId, material: "c_block" });
  }), { code: "ok" });
  assert.equal(w.model.walls[partitionId]!.material, "c_block", "материал применился");
  // перенос посторонней стены: перегородка не изменилась — не блокируется
  assert.deepEqual(await opError(w, "wall_move", (mm) => {
    moveWall(mm, { wallId: "w6", offsetMm: 100 });
  }), { code: "ok" });
  assert.equal(Object.keys(m.warm_floors ?? {}).length, 1, "контур на месте");
});

test("140 m1: отказ атомарен — рабочая модель и контур не меняются", async () => {
  const { m } = withWarmFloor();
  const w = ws(m);
  await w.open("123", "1");
  const before = JSON.stringify(m.walls);
  await opError(w, "wall_add", (mm) => {
    splitWall(mm, "w1", 1500);
    addWall(mm, { start: { x: 1900, y: -2900 }, end: { x: 1900, y: -100 }, thicknessMm: 100, material: "c_pgb", plan: "c" });
  });
  assert.equal(JSON.stringify(w.model.walls), before, "мутация откатилась целиком");
  prepareForRestore(structuredClone(w.model));
});
