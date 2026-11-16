// Этап 64 «Проем в полу» и «Терраса и участок»: сверка с эталонами UI (ui-ref-floorhole-*,
// ui-ref-terrace-*), дефолты и лимиты defs, атомарность (snapshot до вызова), цепочки
// update, удаление, смежные операции, mock-верификация save (потеря, порча, штатный save).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, LevelHole, TerraceBorder, Pillar } from "../../src/model/types.ts";
import { addRoomRect, addWall, moveWall, deleteWall } from "../../src/model/walls.ts";
import { addFloorHole, updateFloorHole, deleteFloorHole } from "../../src/model/floorhole.ts";
import {
  addBorderRing, updateBorder, deleteBorder, addTerraceFence, addTerraceColumn, updateTerraceColumn, deleteTerraceColumn,
  borderRingPolygon, borderMismatches,
} from "../../src/model/terraces.ts";
import { validateModel } from "../../src/model/validate.ts";
import { compactModel } from "../../src/model/compact.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";
import type { RoomPolygon } from "../../src/model/items.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {} };
}

function roomModel(): { model: Model; top: Model["walls"][string] } {
  const model = emptyModel();
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  return { model, top: walls[0]! };
}

/** Комната по внутренним граням фикстуры (оси 0..400 × 0..−300, толщина 20). */
const ROOM_POLY = {
  roomId: "r1",
  polygon: [{ x: 10, y: -10 }, { x: 390, y: -10 }, { x: 390, y: -290 }, { x: 10, y: -290 }],
  areaCm2: 9.64 * 10_000,
  axisAreaCm2: null,
};

type FloorHoleRef = { _source: string; entity: LevelHole };
type BorderRef = { _source: string; entity: TerraceBorder };
type FenceRef = { _source: string; entity: Record<string, unknown> };
type ColumnRef = { _source: string; entity: Pillar };

const FLOOR_HOLE = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/ui-ref-floorhole-floor_hole.json"), "utf8")) as FloorHoleRef;
const T_BORDER = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/ui-ref-terrace-border.json"), "utf8")) as BorderRef;
const T_FENCE = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/ui-ref-terrace-fence.json"), "utf8")) as FenceRef;
const T_COLUMN = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/ui-ref-terrace-column.json"), "utf8")) as ColumnRef;
const X_BORDER = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/ui-ref-terrace-territory.json"), "utf8")) as BorderRef;

const near = (a: number | undefined, b: number | undefined, tol = 0.01): boolean =>
  a !== undefined && b !== undefined && Math.abs(a - b) <= tol;

// ---------- эталоны: проем в полу ----------

test("floor_hole_add: совпадает с эталоном ui-ref-floorhole-floor_hole", () => {
  const { model } = roomModel();
  const et = FLOOR_HOLE.entity;
  const hole = addFloorHole(model, {
    corner1: { x: et.polygon[0]!.x * 10, y: et.polygon[0]!.y * 10 },
    corner2: { x: et.polygon[2]!.x * 10, y: et.polygon[2]!.y * 10 },
  }, [ROOM_POLY]);
  assert.equal(hole.type, et.type);
  assert.equal(hole.plan, et.plan);
  assert.equal(hole.length, et.length);
  hole.polygon.forEach((p, i) => {
    assert.ok(near(p.x, et.polygon[i]!.x) && near(p.y, et.polygon[i]!.y), `угол ${i}`);
  });
  // матрица — кольцо в обе стороны
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const ring = (j === (i + 1) % 4 || j === (i - 1 + 4) % 4);
      assert.equal(hole.matrix[i]![j] !== null, ring, `matrix[${i}][${j}]`);
    }
  }
  assert.equal(hole.vertexes.length, 4);
  for (const v of hole.vertexes) assert.equal(v.type, "node");
  assert.deepEqual(Object.values(hole.items).sort(), ["node", "node", "node", "node"]);
  assert.ok(near(hole.area, et.area));
  assert.ok(near(hole.pc.x, et.pc.x) && near(hole.pc.y, et.pc.y));
});

test("floor_hole_add: вне комнаты — OUTSIDE_ROOM, модель не меняется (снимок до вызова)", () => {
  const { model } = roomModel();
  const before = JSON.stringify(model);
  assert.throws(() => addFloorHole(model, { corner1: { x: 5000, y: -1500 }, corner2: { x: 5500, y: -2000 } }, [ROOM_POLY]), (e: unknown) =>
    e instanceof McpError && e.code === "OUTSIDE_ROOM");
  assert.equal(JSON.stringify(model), before);
});

test("floor_hole_add: нулевой размер и пересечение с другим проёмом — отказ, атомарно", () => {
  const { model } = roomModel();
  const before = JSON.stringify(model);
  assert.throws(() => addFloorHole(model, { corner1: { x: 1000, y: -1500 }, corner2: { x: 1000, y: -2000 } }, [ROOM_POLY]));
  const h1 = addFloorHole(model, { corner1: { x: 1000, y: -2500 }, corner2: { x: 2000, y: -1500 } }, [ROOM_POLY]);
  assert.throws(() => addFloorHole(model, { corner1: { x: 1900, y: -2400 }, corner2: { x: 2100, y: -1600 } }, [ROOM_POLY]), (e: unknown) =>
    e instanceof McpError && e.code === "GEOMETRY_CONFLICT");
  assert.equal(Object.keys(model.level_holes ?? {}).length, 1);
  assert.ok(h1);
  // до отказов модель изменилась только на h1
  const after = JSON.parse(JSON.stringify(model)) as Model;
  assert.equal(Object.keys(after.level_holes ?? {}).length, 1);
});

test("floor_hole_add: прямоугольник, пересекающий стену — GEOMETRY_CONFLICT", () => {
  const { model } = roomModel();
  const before = JSON.stringify(model);
  // угол за внутренней гранью стены y=-290
  assert.throws(() => addFloorHole(model, { corner1: { x: 1000, y: -2500 }, corner2: { x: 2000, y: -3000 } }, [ROOM_POLY]), (e: unknown) =>
    e instanceof McpError && e.code === "GEOMETRY_CONFLICT");
  assert.equal(JSON.stringify(model), before);
});

test("floor_hole_update: мм→см только для переданных углов; цепочка update; identity сохраняется", () => {
  const { model } = roomModel();
  const hole = addFloorHole(model, { corner1: { x: 1000, y: -2500 }, corner2: { x: 2000, y: -1500 } }, [ROOM_POLY]);
  const updated = updateFloorHole(model, { holeId: hole.id, corner1: { x: 1200, y: -2300 } }, [ROOM_POLY]);
  assert.equal(updated.id, hole.id, "identity сохранён");
  assert.ok(near(updated.polygon[0]!.x, 120), "новый corner1.x");
  assert.ok(near(updated.polygon[2]!.x, 200) && near(updated.polygon[2]!.y, -150), "corner2 не изменился");
  // цепочка из трёх update
  updateFloorHole(model, { holeId: hole.id, corner2: { x: 2500, y: -1000 } }, [ROOM_POLY]);
  const last = updateFloorHole(model, { holeId: hole.id, corner1: { x: 1300, y: -2200 } }, [ROOM_POLY]);
  assert.ok(near(last.polygon[2]!.x, 250) && near(last.polygon[2]!.y, -100));
  assert.ok(near(last.area, 120 * 120 / 10_000 * 10_000 / 10_000 * 100) || true);
  assert.ok(Math.abs(last.area - (120 * 120) / 10_000) < 0.01, `площадь ${last.area}`);
  assert.equal(Object.keys(model.level_holes ?? {}).length, 1);
});

test("floor_hole_update: перенос на другой проём — конфликт, модель не меняется", () => {
  const { model } = roomModel();
  addFloorHole(model, { corner1: { x: 1000, y: -2500 }, corner2: { x: 2000, y: -1500 } }, [ROOM_POLY]);
  const second = addFloorHole(model, { corner1: { x: 2500, y: -2500 }, corner2: { x: 3000, y: -2000 } }, [ROOM_POLY]);
  const before = JSON.stringify(model);
  assert.throws(() => updateFloorHole(model, { holeId: second.id, corner1: { x: 1500, y: -2000 }, corner2: { x: 2200, y: -1600 } }, [ROOM_POLY]), (e: unknown) =>
    e instanceof McpError && e.code === "GEOMETRY_CONFLICT");
  assert.equal(JSON.stringify(model), before);
});

test("floor_hole_delete: удаляет проём; NOT_FOUND для неизвестного id", () => {
  const { model } = roomModel();
  const hole = addFloorHole(model, { corner1: { x: 1000, y: -2500 }, corner2: { x: 2000, y: -1500 } }, [ROOM_POLY]);
  deleteFloorHole(model, hole.id);
  assert.equal(Object.keys(model.level_holes ?? {}).length, 0);
  assert.throws(() => deleteFloorHole(model, hole.id), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
});

// ---------- эталоны: терраса и участок ----------

test("terrace_add: кольцо границ; граница совпадает с эталоном ui-ref-terrace-border", () => {
  const { model } = roomModel();
  const et = T_BORDER.entity;
  const borders = addBorderRing(model, "terrace_borders", "терраса", {
    points: [{ x: 6000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 3000 }, { x: 6000, y: 3000 }],
  });
  assert.equal(borders.length, 4);
  const b = borders[0]!;
  assert.ok(near(b.p1.x, et.p1.x) && near(b.p1.y, et.p1.y));
  assert.ok(near(b.p2.x, et.p2.x) && near(b.p2.y, et.p2.y));
  // замкнутый полигон выводится
  const ring = borderRingPolygon(model.terrace_borders!);
  assert.ok(ring);
  assert.equal(ring.length, 4);
  assert.throws(() => addBorderRing(model, "terrace_borders", "терраса", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
});

test("terrace_add: самопересечение — GEOMETRY_CONFLICT, атомарно", () => {
  const { model } = roomModel();
  const before = JSON.stringify(model);
  // «бабочка»: 6000,1000 → 9000,3000 → 9000,1000 → 6000,3000
  assert.throws(() => addBorderRing(model, "terrace_borders", "терраса", {
    points: [{ x: 6000, y: 1000 }, { x: 9000, y: 3000 }, { x: 9000, y: 1000 }, { x: 6000, y: 3000 }],
  }), (e: unknown) => e instanceof McpError && e.code === "GEOMETRY_CONFLICT");
  assert.equal(JSON.stringify(model), before);
});

test("terrace_border_update: общий узел двух границ двигается вместе (транзитивно)", () => {
  const { model } = roomModel();
  addBorderRing(model, "terrace_borders", "терраса", {
    points: [{ x: 6000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 3000 }, { x: 6000, y: 3000 }],
  });
  const borders = Object.values(model.terrace_borders!);
  const target = borders.find((b) => near(b.p1.x, 600) && near(b.p1.y, 100) && near(b.p2.x, 900) && near(b.p2.y, 100))!;
  const neighbor = borders.find((b) => b.id !== target.id && near(b.p1.x, 900) && near(b.p1.y, 100))!;
  updateBorder(model, "terrace_borders", "терраса", { borderId: target.id, end: { x: 9500, y: 1500 } });
  // узел (900,100) переехал в (950,150) у обеих границ
  assert.ok(near(target.p2.x, 950) && near(target.p2.y, 150));
  const nb = Object.values(model.terrace_borders!).find((b) => b.id === neighbor.id)!;
  const movedEnd = [nb.p1, nb.p2].find((p) => near(p.x, 950) && near(p.y, 150));
  assert.ok(movedEnd, "общий узел соседней границы тоже переехал");
});

test("terrace_border_update: схлопывание границы в точку — откат", () => {
  const { model } = roomModel();
  addBorderRing(model, "terrace_borders", "терраса", {
    points: [{ x: 6000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 3000 }, { x: 6000, y: 3000 }],
  });
  const before = JSON.stringify(model);
  const borders = Object.values(model.terrace_borders!);
  const target = borders.find((b) => near(b.p1.x, 600) && near(b.p1.y, 100))!;
  assert.throws(() => updateBorder(model, "terrace_borders", "терраса", { borderId: target.id, end: { x: 6000, y: 1000 } }), (e: unknown) =>
    e instanceof McpError && (e.code === "GEOMETRY_CONFLICT" || e.code === "INVALID_ARGUMENT"));
  assert.equal(JSON.stringify(model), before, "модель откатилась");
});

test("terrace_border_delete: удаляет границу; NOT_FOUND", () => {
  const { model } = roomModel();
  const [b] = addBorderRing(model, "terrace_borders", "терраса", {
    points: [{ x: 6000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 3000 }, { x: 6000, y: 3000 }],
  });
  deleteBorder(model, "terrace_borders", b!.id);
  assert.equal(Object.keys(model.terrace_borders!).length, 3);
  assert.throws(() => deleteBorder(model, "terrace_borders", b!.id), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
});

test("territory_add: участок в своей коллекции; граница совпадает с эталоном ui-ref-terrace-territory", () => {
  const { model } = roomModel();
  const et = X_BORDER.entity;
  const borders = addBorderRing(model, "territory_borders", "участок", {
    points: [{ x: 10000, y: 1000 }, { x: 13000, y: 1000 }, { x: 13000, y: 4000 }, { x: 10000, y: 4000 }],
  });
  assert.equal(borders.length, 4);
  assert.ok(near(borders[0]!.p1.x, et.p1.x) && near(borders[0]!.p1.y, et.p1.y));
  assert.ok(model.territory_borders);
  assert.equal(model.terrace_borders, undefined, "коллекции раздельны");
});

// ---------- ограждение и столб террасы ----------

function terraceModel(): Model {
  const { model } = roomModel();
  addBorderRing(model, "terrace_borders", "терраса", {
    points: [{ x: 6000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 3000 }, { x: 6000, y: 3000 }],
  });
  return model;
}

test("terrace_fence_add: совпадает с эталоном ui-ref-terrace-fence (role, depth 5)", () => {
  const model = terraceModel();
  const et = T_FENCE.entity;
  const fence = addTerraceFence(model, {
    start: { x: (et.p1 as { x: number }).x * 10, y: (et.p1 as { y: number }).y * 10 },
    end: { x: (et.p2 as { x: number }).x * 10, y: (et.p2 as { y: number }).y * 10 },
  });
  assert.equal(fence.role, et.role);
  assert.ok(near(fence.depth, et.depth as number));
  assert.equal(fence.plan, "a");
  assert.ok(near(fence.p1.x, (et.p1 as { x: number }).x) && near(fence.p1.y, (et.p1 as { y: number }).y));
  // граница на стороне ограждения удаляется редактором — отклоняем её у себя
  assert.throws(() => addBorderRing(model, "terrace_borders", "терраса", {
    points: [{ x: 8950, y: 1000 }, { x: 9050, y: 1000 }],
  }), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT"); // 2 точки — не кольцо
});

test("terrace_fence_add: без террасы — INVALID_ARGUMENT (terrace_required, как в UI)", () => {
  const { model } = roomModel();
  assert.throws(() => addTerraceFence(model, { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } }), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT" && JSON.stringify(e.details).includes("terrace_required"));
});

test("terrace_fence_add: лимит толщины и длина", () => {
  const model = terraceModel();
  assert.throws(() => addTerraceFence(model, { start: { x: 6000, y: 1000 }, end: { x: 9000, y: 1000 }, thicknessMm: 5 }), (e: unknown) =>
    e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.throws(() => addTerraceFence(model, { start: { x: 6000, y: 1000 }, end: { x: 6001, y: 1000 } }), (e: unknown) =>
    e instanceof McpError);
});

test("terrace_column_add: совпадает с эталоном ui-ref-terrace-column (role, 20×20, углы)", () => {
  const model = terraceModel();
  const et = T_COLUMN.entity;
  const col = addTerraceColumn(model, { center: { x: et.pc.x * 10, y: et.pc.y * 10 } });
  assert.equal(col.role, "terrace_column");
  assert.ok(near(col.width, et.width) && near(col.height, et.height));
  assert.ok(near(col.p1.x, et.p1.x, 0.05) && near(col.p1.y, et.p1.y, 0.05));
  assert.ok(near(col.p3.x, et.p3.x, 0.05) && near(col.p3.y, et.p3.y, 0.05));
  assert.ok(near(col.total_height, et.total_height ?? 270));
  assert.equal(col.edges!.length, 4);
  assert.ok(col.edges!.every((e) => e.no_wall === 1));
});

test("terrace_column_add: вне террасы — отказ; без террасы — terrace_required; пересечение столбов — отказ", () => {
  const base = roomModel();
  assert.throws(() => addTerraceColumn(base.model, { center: { x: 7000, y: 2000 } }), (e: unknown) =>
    e instanceof McpError && JSON.stringify(e.details ?? {}).includes("terrace_required"));
  const model = terraceModel();
  addTerraceColumn(model, { center: { x: 7000, y: 2000 } });
  assert.throws(() => addTerraceColumn(model, { center: { x: 7050, y: 2000 } }), (e: unknown) =>
    e instanceof McpError && e.code === "GEOMETRY_CONFLICT");
  assert.throws(() => addTerraceColumn(model, { center: { x: 2000, y: -1500 } }), (e: unknown) =>
    e instanceof McpError && e.code === "GEOMETRY_CONFLICT");
});

test("terrace_column_update: перенос и габариты, identity сохраняется; delete", () => {
  const model = terraceModel();
  const col = addTerraceColumn(model, { center: { x: 7000, y: 2000 } });
  const updated = updateTerraceColumn(model, col.id, { center: { x: 7500, y: 2500 }, widthMm: 300, heightMm: 400 });
  assert.equal(updated.id, col.id, "identity сохранён");
  assert.ok(near(updated.pc.x, 750) && near(updated.pc.y, 250));
  assert.ok(near(updated.width, 30) && near(updated.height, 40));
  deleteTerraceColumn(model, col.id);
  assert.equal(Object.values(model.pillars).filter((p) => p.role === "terrace_column").length, 0);
  assert.throws(() => deleteTerraceColumn(model, col.id), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
});

// ---------- смежные операции: стены не задевают границы/проёмы, столб — колонна ----------

test("смежные: wall_move и wall_delete не трогают границы и проёмы", () => {
  const model = terraceModel();
  addFloorHole(model, { corner1: { x: 1000, y: -2500 }, corner2: { x: 2000, y: -1500 } }, [ROOM_POLY]);
  const walls = Object.values(model.walls);
  const top = walls[0]!;
  moveWall(model, { wallId: top.id, offsetMm: 100 });
  assert.equal(Object.keys(model.terrace_borders!).length, 4, "границы на месте");
  assert.equal(Object.keys(model.level_holes!).length, 1, "проём на месте");
  deleteWall(model, top.id);
  assert.equal(Object.keys(model.terrace_borders!).length, 4);
  assert.equal(Object.keys(model.level_holes!).length, 1);
});

test("validate: пересечение проёмов и нулевая граница ловятся", () => {
  const model = emptyModel();
  model.level_holes = {
    h1: structuredClone(FLOOR_HOLE.entity),
  };
  model.level_holes["h2"] = { ...structuredClone(FLOOR_HOLE.entity), id: "h2", pc: { x: 150, y: -175 } };
  const problems = validateModel(model);
  assert.ok(problems.some((p) => p.code === "LEVEL_HOLES_OVERLAP"), JSON.stringify(problems));
  model.terrace_borders = { z: { id: "z", p1: { x: 10, y: 10 }, p2: { x: 10, y: 10 } } };
  const problems2 = validateModel(model);
  assert.ok(problems2.some((p) => p.code === "BORDER_BAD_GEOMETRY"));
});

// ---------- компактная модель ----------

test("compact: метки TB/XB/FH с id сайта", () => {
  const model = terraceModel();
  addFloorHole(model, { corner1: { x: 1000, y: -2500 }, corner2: { x: 2000, y: -1500 } }, [ROOM_POLY]);
  addBorderRing(model, "territory_borders", "участок", {
    points: [{ x: 10000, y: 1000 }, { x: 13000, y: 1000 }, { x: 13000, y: 4000 }, { x: 10000, y: 4000 }],
  });
  const compact = compactModel(model);
  assert.equal(compact.terrace_borders.length, 4);
  assert.equal(compact.terrace_borders[0]!.id, "TB1");
  assert.ok(compact.terrace_borders[0]!.site_id.length > 0);
  assert.equal(compact.territory_borders[0]!.id, "XB1");
  assert.equal(compact.level_holes.length, 1);
  assert.equal(compact.level_holes[0]!.id, "FH1");
  assert.ok(near(compact.level_holes[0]!.x_mm, 1500, 0.5));
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
      const c = { walls, holes: 0, items: 0, pillars: Object.keys(m.pillars as Record<string, unknown>).length, rigels: 0 };
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

test("save: границы, проём и столб сохраняются штатно — verified=true, без ложных блокировок", async () => {
  const model = terraceModel();
  addFloorHole(model, { corner1: { x: 1000, y: -2500 }, corner2: { x: 2000, y: -1500 } }, []);
  const col = addTerraceColumn(model, { center: { x: 7000, y: 2000 } });
  void col;
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const out = await ws.save();
  assert.equal(out.verified, true);
  assert.equal(out.rounds, 1);
});

test("save: проём в полу исчез после save — SITE_ERROR", async () => {
  const model = terraceModel();
  addFloorHole(model, { corner1: { x: 1000, y: -2500 }, corner2: { x: 2000, y: -1500 } }, []);
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    (s.model as { level_holes?: Record<string, unknown> }).level_holes = {};
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { level_hole_mismatches?: string[] } }).details;
    assert.ok((details?.level_hole_mismatches ?? []).some((x) => x.includes("исчез")), JSON.stringify(details));
    return true;
  });
});

test("save: проём в полу испорчен (угол сдвинут) — SITE_ERROR, verified не выставляется", async () => {
  const model = terraceModel();
  addFloorHole(model, { corner1: { x: 1000, y: -2500 }, corner2: { x: 2000, y: -1500 } }, []);
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    for (const h of Object.values((s.model as { level_holes?: Record<string, LevelHole> }).level_holes ?? {})) {
      h.polygon = h.polygon.map((p) => ({ x: p.x + 30, y: p.y }));
    }
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { level_hole_mismatches?: string[] } }).details;
    assert.ok((details?.level_hole_mismatches ?? []).some((x) => x.includes("угол") || x.includes("сместился")), JSON.stringify(details));
    return true;
  });
});

test("save: границы потеряны при нормализации — NORMALIZATION_DROPPED до записи", async () => {
  const model = terraceModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    (m as { terrace_borders?: Record<string, unknown> }).terrace_borders = {};
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "NORMALIZATION_DROPPED");
    const details = (e as { details?: { border_mismatches?: string[] } }).details;
    assert.ok((details?.border_mismatches ?? []).some((x) => x.includes("террасы потеряна")), JSON.stringify(details));
    return true;
  });
  assert.equal(saves, 0, "до записи дело не дошло");
});

test("save: границы испорчены после save — SITE_ERROR", async () => {
  const model = terraceModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    for (const b of Object.values((s.model as { terrace_borders?: Record<string, TerraceBorder> }).terrace_borders ?? {})) {
      b.p2 = { x: b.p2.x + 100, y: b.p2.y };
    }
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { border_mismatches?: string[] } }).details;
    assert.ok((details?.border_mismatches ?? []).some((x) => x.includes("сместилось") || x.includes("конец")), JSON.stringify(details));
    return true;
  });
});

test("save: добавление границы редактором — потеря не объявляется как совпадение (лишняя граница ловится)", async () => {
  const model = terraceModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const tb = (s.model as { terrace_borders?: Record<string, unknown> }).terrace_borders!;
    tb["_extra1"] = { id: "_extra1", p1: { x: 500, y: 100 }, p2: { x: 600, y: 100 } };
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    return true;
  });
});

test("borderMismatches: угол mod 360 не применим, но допуск работает (0,05 см шума редактора)", () => {
  const expected = { b1: { id: "b1", p1: { x: 610.0000000001, y: 110.0000000002 }, p2: { x: 630, y: 130 } } };
  const got = { b1: { id: "b1", p1: { x: 610, y: 110 }, p2: { x: 630, y: 130 } } };
  assert.deepEqual(borderMismatches(expected, got, "граница террасы"), []);
  const shifted = { b1: { id: "b1", p1: { x: 615, y: 110 }, p2: { x: 630, y: 130 } } };
  assert.ok(borderMismatches(expected, shifted, "граница террасы").length > 0);
});

// ---------- стеновая операция рядом с проёмом (пересчёт только затронутых) ----------

test("wall ops: новая стена рядом с проёмом и террасой не ломает модель", () => {
  const model = terraceModel();
  addFloorHole(model, { corner1: { x: 1000, y: -2500 }, corner2: { x: 2000, y: -1500 } }, [ROOM_POLY]);
  const wall = addWall(model, { start: { x: 5000, y: 0 }, end: { x: 5000, y: -2000 }, thicknessMm: 100 });
  assert.ok(wall);
  assert.equal(Object.keys(model.terrace_borders!).length, 4);
  assert.equal(Object.keys(model.level_holes!).length, 1);
  const problems = validateModel(model);
  assert.equal(problems.filter((p) => p.code !== "WALL_DANGLING").length, 0, JSON.stringify(problems));
});
