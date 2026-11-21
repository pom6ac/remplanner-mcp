// Этап 359: проёмы на перегородках (стены plan:"c"). Баг 356: opening_add двери на
// перегородку даёт модель, на которой редактор падает при save — TypeError в
// Project.draw → Walls.setFloor0Offset → Wall.setHolesFloor0Offset → LIB.center(undefined):
// setHolesFloor0Offset (бандл @1837591) обходит ВСЕ стены без isAvailable() и читает
// l1/l2/r1/r2 проёма, а holes_get (единственный, кто их считает, @1702100) выполняется
// только для стен, доступных на текущем листе (calc4/UPDATE под isAvailable()) —
// перегородка на листе plan:"a" недоступна, и у MCP-проёма точек не было.
// Фикс: MCP пишет l1/l2/r1/r2 у проёмов на plan:"c" по правилу holes_get редактора
// (LIB.pointAtLinePoint(I, I.p1|I.p2, depth/2, "l"|"r")).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, Wall, Hole } from "../../src/model/types.ts";
import { addWall, prepareForRestore } from "../../src/model/walls.ts";
import { addOpening, updateOpening, setHoleEdgePoints } from "../../src/model/openings.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));

function baseModel(): Model {
  const env = JSON.parse(
    readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8"),
  ) as { model: Model };
  return structuredClone(env.model);
}

/** Перегородка plan:"c" по оси x=1500 мм, толщина 100 мм (depth 10 см). */
function partition(model: Model, material = "c_pgb", yEnd = -2900) {
  return addWall(model, { start: { x: 1500, y: yEnd }, end: { x: 1500, y: -100 }, plan: "c", material, thicknessMm: 100 });
}

// ---------- воспроизведение условия падения ----------

test("359: opening_add двери на перегородку пишет l1/l2/r1/r2, как holes_get редактора", () => {
  const m = baseModel();
  const part = partition(m);
  const hole = addOpening(m, { wallId: part.id, type: "door", centerMm: 1500, widthMm: 800 });
  // ось перегородки (150,-290)→(150,-10) см; дверь 80 см по центру: центр (150,-140),
  // края p1=(150,-180), p2=(150,-100)
  assert.deepEqual(hole.pc, { x: 150, y: -140 });
  assert.deepEqual(hole.p1, { x: 150, y: -180 });
  assert.deepEqual(hole.p2, { x: 150, y: -100 });
  // LIB.pointAtLinePoint(I, I.p1, depth/2=5, "l"): сдвиг ⊥ оси; ось направлена +y,
  // сторона "l" — +x (pointAtLineCenter "l": x += i*dy/L, y -= i*dx/L)
  assert.deepEqual(hole.l1, { x: 155, y: -180 });
  assert.deepEqual(hole.l2, { x: 155, y: -100 });
  assert.deepEqual(hole.r1, { x: 145, y: -180 });
  assert.deepEqual(hole.r2, { x: 145, y: -100 });
});

test("359: формула совпадает с проёмом из эталона UI (ui-ref-door.json, стена id7/проём id16)", () => {
  // p1/p2 и эталонные l1/r1/l2/r2 — из фикстуры проёма, поставленного мышью в UI;
  // setHoleEdgePoints при r2-округлении до мм даёт те же значения
  const wall = { id: "w", plan: "c", depth: 10, holes: {} } as unknown as Wall;
  const hole = {
    id: "h", plan: "c", type: "single", group: "doors", pc: { x: -0.03, y: 148.39 },
    width: 80, depth: 4,
    p1: { x: 39.966933092115795, y: 147.7086221338009 },
    p2: { x: -40.021593270832824, y: 149.06282602547802 },
  } as unknown as Hole;
  setHoleEdgePoints(wall, hole);
  assert.deepEqual(hole.l1, { x: 40.05, y: 152.71 });
  assert.deepEqual(hole.l2, { x: -39.94, y: 154.06 });
  assert.deepEqual(hole.r1, { x: 39.88, y: 142.71 });
  assert.deepEqual(hole.r2, { x: -40.11, y: 144.06 });
});

// ---------- все виды проёмов и все материалы перегородок ----------

test("359: все виды проёмов на перегородке получают точки граней", () => {
  const kinds: Array<[string, Record<string, unknown>]> = [
    ["door", {}],
    ["doorway", {}],
    ["door_double", {}],
    ["door_coupe", {}],
    ["door_glass", {}],
    ["window", { sillHeightMm: 850 }],
    ["windowway", { sillHeightMm: 850 }],
    ["window_balcony", { sillHeightMm: 100 }],
    ["french_window", {}],
  ];
  for (const [type, extra] of kinds) {
    const m = baseModel();
    const part = partition(m);
    // ширина — дефолт каталога (у дверей 800, у окон 1200, у балконного блока — сумма частей)
    const hole = addOpening(m, { wallId: part.id, type, centerMm: 1400, ...extra } as never);
    const pts = hole as unknown as Record<string, { x: number; y: number } | undefined>;
    for (const k of ["l1", "l2", "r1", "r2"]) {
      const p = pts[k];
      assert.ok(p !== undefined, `${type}: нет ${k}`);
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${type}: ${k} неконечна`);
    }
    // точки на гранях: расстояние от оси (x=150) до l равно depth/2
    assert.ok(Math.abs(Math.abs(pts.l1!.x - 150) - 5) < 0.01, `${type}: l1 не на грани`);
    assert.ok(Math.abs(Math.abs(pts.r1!.x - 150) - 5) < 0.01, `${type}: r1 не на грани`);
  }
});
test("359: точки граней на перегородках всех материалов (толщина = depth)", () => {
  for (const material of ["c_pgb", "c_block", "c_brick", "c_gypsum"]) {
    const m = baseModel();
    const part = partition(m, material);
    const hole = addOpening(m, { wallId: part.id, type: "door", centerMm: 1500 });
    const half = part.depth / 2;
    const l1 = (hole as unknown as Record<string, { x: number }>).l1!;
    assert.ok(Math.abs(Math.abs(l1.x - 150) - half) < 0.01, `${material}: l1 не на грани (depth ${part.depth})`);
  }
});

test("359: prepareForRestore заполняет точки у проёма перегородки из серверной модели без них", () => {
  // модель, как её отдал сервер до фикса: проём plan:"c" без l1/l2/r1/r2
  const m = baseModel();
  const part = partition(m);
  const hole = addOpening(m, { wallId: part.id, type: "door", centerMm: 1500 });
  delete hole.l1;
  delete hole.l2;
  delete hole.r1;
  delete hole.r2;
  prepareForRestore(m);
  assert.deepEqual(hole.l1, { x: 155, y: -180 });
  assert.deepEqual(hole.r2, { x: 145, y: -100 });
});

// ---------- полный путь «перегородка → opening_add → normalize как в редакторе → save» ----------

// Эмуляция редактора (бандл): holes_get выполняется только для стен, доступных на
// листе plan:"a" (перегородки — нет), после чего Project.draw безусловно зовёт
// WALLS.setFloor0Offset → setHolesFloor0Offset, где LIB.center(t.l1, t.l2) падает
// TypeError при отсутствии точек (у окон window/windoor/french_* ветка пропускается).
function editorLikeNormalize(model: Record<string, unknown>): void {
  const walls = model["walls"] as Record<string, { plan: string; depth: number; holes?: Record<string, Record<string, unknown>> }>;
  for (const wall of Object.values(walls)) {
    for (const hole of Object.values(wall.holes ?? {})) {
      // holes_get: только доступные стены (лист plan:"a"); перегородки пропускает
      if (wall.plan !== "a") continue;
      const p1 = hole["p1"] as { x: number; y: number } | undefined;
      const p2 = hole["p2"] as { x: number; y: number } | undefined;
      if (!p1 || !p2) continue; // p1/p2 ставит prepareForRestore до restore
      const dx = (p2.x - p1.x), dy = (p2.y - p1.y);
      const len = Math.hypot(dx, dy);
      if (!(len > 0)) continue;
      const ox = (wall.depth / 2) * dy / len, oy = -(wall.depth / 2) * dx / len;
      hole["l1"] = { x: p1.x + ox, y: p1.y + oy };
      hole["l2"] = { x: p2.x + ox, y: p2.y + oy };
      hole["r1"] = { x: p1.x - ox, y: p1.y - oy };
      hole["r2"] = { x: p2.x - ox, y: p2.y - oy };
    }
  }
  // setHolesFloor0Offset: ВСЕ стены, не-оконные проёмы → LIB.center(t.l1, t.l2)
  for (const wall of Object.values(walls)) {
    for (const hole of Object.values(wall.holes ?? {})) {
      if (["window", "windoor", "french_window", "french_window_coupe", "french_window_double"].includes(String(hole["type"]))) continue;
      const l1 = hole["l1"] as { x: number } | undefined;
      if (l1 === undefined) {
        throw new TypeError("Cannot read properties of undefined (reading 'x') — Wall.setHolesFloor0Offset → LIB.center(undefined)");
      }
    }
  }
}

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      const prepared = structuredClone(mm as object) as Record<string, unknown>;
      editorLikeNormalize(prepared); // draw редактора: точки у доступных стен, падение на остальных
      normalized = prepared;
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
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
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  return ws;
}

test("359: полный путь — дверь и окно на перегородке, normalize как в редакторе, save verified", async () => {
  const m = baseModel();
  const part = partition(m);
  addOpening(m, { wallId: part.id, type: "door", centerMm: 800 });
  addOpening(m, { wallId: part.id, type: "window", centerMm: 2000, widthMm: 1000, sillHeightMm: 850 });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server);
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  // записанная модель — точки граней у обоих проёмов перегородки
  const savedPart = Object.values(server.model["walls"] as Record<string, { plan: string; holes: Record<string, Record<string, unknown>> }>).find((w) => w.plan === "c")!;
  for (const hole of Object.values(savedPart.holes)) {
    assert.ok(hole["l1"] !== undefined && hole["r2"] !== undefined, `проём ${hole["id"]} записан без точек граней`);
  }
});

test("359: полный путь — doorway (проём без заполнения) и балконный блок на перегородке, save verified", async () => {
  const m = baseModel();
  const part = partition(m, "c_gypsum", -3400); // 330 см, чтобы поместились оба проёма
  addOpening(m, { wallId: part.id, type: "doorway", centerMm: 500 });
  addOpening(m, { wallId: part.id, type: "window_balcony", centerMm: 1900, sillHeightMm: 100 });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server);
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("359: normalize как в редакторе без фикса падает на двери перегородки (регрессия условия 356)", () => {
  const m = baseModel();
  const part = partition(m);
  const hole = addOpening(m, { wallId: part.id, type: "door", centerMm: 1500 });
  delete hole.l1; // состояние до фикса
  assert.throws(() => editorLikeNormalize({ walls: { [part.id]: part as unknown as Record<string, unknown> } }), TypeError);
});

// ---------- регрессия plan:a и замена ----------

test("359: регрессия plan:a — у проёма исходной стены по-прежнему нет MCP-точек граней (считает редактор)", () => {
  const m = baseModel();
  const top = Object.values(m.walls).find((w) => w.plan === "a")!;
  const hole = addOpening(m, { wallId: top.id, type: "door", offsetMm: 300, widthMm: 800 });
  assert.equal(hole.l1, undefined);
  assert.equal(hole.r2, undefined);
  // normalize как в редакторе заполняет точки доступной стены и не падает
  editorLikeNormalize({ walls: { [top.id]: top as unknown as Record<string, unknown> } });
  assert.ok(hole["l1"] !== undefined);
});

test("359: регрессия замены — замена plan:c на исходной стене plan:a без MCP-точек граней (как раньше)", () => {
  const m = baseModel();
  const corridor = Object.values(m.walls).find((w) => w.plan === "a" && Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1);
  assert.ok(corridor);
  const door = addOpening(m, { wallId: corridor!.id, type: "door", offsetMm: 2900 });
  const rep = addOpening(m, { wallId: corridor!.id, type: "doorway", replacesHoleId: door.id });
  assert.equal(rep.plan, "c");
  assert.equal(rep.l1, undefined);
  assert.equal(door.hasReplacement, 1);
  // normalize как в редакторе: стена plan:a доступна — holes_get считает и замену
  editorLikeNormalize({ walls: { [corridor!.id]: corridor as unknown as Record<string, unknown> } });
  assert.ok(rep["l1"] !== undefined);
});

// ---------- minor1 из ревью 357: гард пары ловит подоконник и части windoor ----------

test("359: minor1 — sill_height_mm участника пары window→window — replacement_pair_immutable", () => {
  const m = baseModel();
  const corridor = Object.values(m.walls).find((w) => w.plan === "a" && Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const src = addOpening(m, { wallId: corridor.id, type: "window", offsetMm: 2900, widthMm: 800, sillHeightMm: 850 });
  const rep = addOpening(m, { wallId: corridor.id, type: "window", replacesHoleId: src.id });
  assert.equal(rep.plan, "c");
  assert.throws(() => updateOpening(m, { wallId: corridor.id, holeId: src.id, sillHeightMm: 500 }), (e: McpError) => {
    assert.equal((e.details as { kind?: string }).kind, "replacement_pair_immutable");
    return true;
  });
  // у замены подоконник не изменился (гард сработал до мутации)
  assert.equal((corridor.holes[rep.id] as Hole).floor_height, src.floor_height);
});

test("359: minor1 — части windoor и impost участника пары — replacement_pair_immutable", () => {
  const m = baseModel();
  // левая стена (0,300)→(0,0), 300 см, без проёмов в базе — блок 180 см помещается
  const leftWall = Object.values(m.walls).find((w) => w.plan === "a" && w.p1.x < 1 && w.p2.x < 1)!;
  const src = addOpening(m, { wallId: leftWall.id, type: "window_balcony", offsetMm: 900, sillHeightMm: 100 });
  // UI-пара (редактор такую строит): у исходного windoor hasReplacement, замена plan:c
  src.hasReplacement = 1;
  leftWall.holes["rep_ui"] = {
    id: "rep_ui", plan: "c", type: "window", group: "windows",
    pc: { x: src.pc.x, y: src.pc.y }, width: src.width, height: 150, depth: 6,
    parent: leftWall.id, parent_depth: leftWall.depth,
  } as unknown as Hole;
  for (const params of [
    { windowWidthMm: 2300 },
    { windowHeightMm: 1200 },
    { doorWidthMm: 900 },
    { doorHeightMm: 2100 },
    { impostHeightMm: 800 },
  ]) {
    assert.throws(() => updateOpening(m, { wallId: leftWall.id, holeId: src.id, ...params }), (e: McpError) => {
      assert.equal((e.details as { kind?: string }).kind, "replacement_pair_immutable", JSON.stringify(params));
      return true;
    }, JSON.stringify(params));
  }
});

test("359: не-геометрические поля участника пары правятся как прежде (casing)", () => {
  const m = baseModel();
  const corridor = Object.values(m.walls).find((w) => w.plan === "a" && Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const src = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 2900 });
  addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: src.id });
  const updated = updateOpening(m, { wallId: corridor.id, holeId: src.id, casing: false });
  assert.equal(updated.casing, 0);
});
