// Регрессионные тесты ревью этапов 1–2 (находки №2–№9, №19).
// Эталоны link/граней — normalized-rect-4000x3000.json и ui-ref-*.json, не «свои» представления.
import test from "node:test";
import assert from "node:assert/strict";
import { addWall, addRoomRect, updateWall, moveWall, splitWall, wallFaces, prepareForRestore } from "../../src/model/walls.ts";
import { addOpening, updateOpening, holeRange } from "../../src/model/openings.ts";
import { validateModel } from "../../src/model/validate.ts";
import type { Model, Wall } from "../../src/model/types.ts";

function emptyModel(): Model {
  return {
    v: 3, id: "0", plan_id: "0",
    walls: {}, items: {}, pillars: {}, rulers: {}, comments: {},
    total_height: 270, final: false,
  };
}

/** Взаимная node-связь двух узлов — как её ставит link1 редактора (§12.3). */
function linkNode(a: Wall, na: "p1" | "p2", b: Wall, nb: "p1" | "p2"): void {
  a[na].link = { ct: "node", ot: "wall", id: b.id, z0: "c", z1: nb };
  b[nb].link = { ct: "node", ot: "wall", id: a.id, z0: "c", z1: na };
}

function rect(model: Model): Record<"top" | "right" | "bottom" | "left", Wall> {
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  return { top: walls[0]!, right: walls[1]!, bottom: walls[2]!, left: walls[3]! };
}

test("№2: updateWall(start) двигает узел СОСЕДА по z1, а не противоположный", () => {
  const model = emptyModel();
  const { top, left } = rect(model);
  // top.p1 = (−10,−10) связан с left.p2 (левая стена идёт (−10,310) → (−10,−10))
  assert.deepEqual({ x: top.p1.x, y: top.p1.y }, { x: -10, y: -10 });
  updateWall(model, { wallId: top.id, start: { x: 0, y: 0 } });
  // узел соседа, стоявший в точке стыка (left.p2), переехал в (0,0)
  assert.deepEqual({ x: left.p2.x, y: left.p2.y }, { x: 0, y: 0 });
  // противоположный конец левой стены не тронут
  assert.deepEqual({ x: left.p1.x, y: left.p1.y }, { x: -10, y: 310 });
});

test("№3: moveWall — узлы соседей следуют за стеной, повторная операция работает (правило 5)", () => {
  const model = emptyModel();
  const { top, left, right } = rect(model);
  moveWall(model, { wallId: top.id, offsetMm: 100 });
  // узлы стены и соседей совпадают физически (связи строит редактор, §12.3)
  assert.ok(Math.hypot(left.p2.x - top.p1.x, left.p2.y - top.p1.y) < 0.01, "левый узел следует");
  assert.ok(Math.hypot(right.p1.x - top.p2.x, right.p1.y - top.p2.y) < 0.01, "правый узел следует");
  // повторная операция тоже видит геометрию
  moveWall(model, { wallId: top.id, offsetMm: 100 });
  assert.ok(Math.hypot(left.p2.x - top.p1.x, left.p2.y - top.p1.y) < 0.01, "после второй moveWall узлы совпадают");
  assert.ok(Math.hypot(right.p1.x - top.p2.x, right.p1.y - top.p2.y) < 0.01);
});

test("№3: толщина по одной стороне тянет узлы соседей (правило 5)", () => {
  const model = emptyModel();
  const { top, left } = rect(model);
  updateWall(model, { wallId: top.id, thicknessMm: 400, side: "left" });
  assert.ok(Math.hypot(left.p2.x - top.p1.x, left.p2.y - top.p1.y) < 0.01, "узел соседа следует за осью");
});

test("№4: moveWall переносит проёмы — pc/p1/p2 остаются на новой оси", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const hole = addOpening(model, { wallId: top.id, type: "door", offsetMm: 500, widthMm: 800 });
  moveWall(model, { wallId: top.id, offsetMm: 100 });
  // ось была y=-10, после +100 мм влево (−Y) стала y=-20; проём обязан переехать на неё
  assert.equal(hole.pc.y, -20, `pc.y = ${hole.pc.y}, ожидалось −20`);
  const seg = { p1: top.p1, p2: top.p2 };
  for (const p of [hole.p1!, hole.p2!, hole.pc]) {
    const dx = seg.p2.x - seg.p1.x, dy = seg.p2.y - seg.p1.y;
    const len = Math.hypot(dx, dy);
    const d = Math.abs((p.x - seg.p1.x) * dy - (p.y - seg.p1.y) * dx) / len;
    assert.ok(d < 0.05, `точка проёма (${p.x},${p.y}) на расстоянии ${d} см от оси — должна быть на оси`);
  }
  const problems = validateModel(model).filter((p) => p.code.startsWith("OPENING"));
  assert.equal(problems.length, 0, `валидатор не должен находить проблемы: ${JSON.stringify(problems)}`);
});

test("№4: валидатор ловит проём, сорванный с оси", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const hole = addOpening(model, { wallId: top.id, type: "door", offsetMm: 500, widthMm: 800 });
  // портим: pc в стороне от оси
  hole.pc = { x: hole.pc.x, y: hole.pc.y + 5 };
  const problems = validateModel(model);
  assert.ok(problems.some((p) => p.code === "OPENING_OFF_AXIS"), "OPENING_OFF_AXIS должен ловить срыв pc с оси");
});

test("№5: splitWall запрещает разрез через проём", () => {
  const model = emptyModel();
  const { bottom } = rect(model);
  addOpening(model, { wallId: bottom.id, type: "door", offsetMm: 3000, widthMm: 800, from: "start" });
  assert.throws(
    () => splitWall(model, bottom.id, 3200),
    (e: unknown) => (e as { code?: string }).code === "GEOMETRY_CONFLICT",
    "разрез внутри проёма должен быть запрещён",
  );
});

test("№5: splitWall пересчитывает at проёма во второй части", () => {
  const model = emptyModel();
  const { bottom } = rect(model);
  const hole = addOpening(model, { wallId: bottom.id, type: "door", offsetMm: 3000, widthMm: 800, from: "start" });
  const { second } = splitWall(model, bottom.id, 2000);
  const [from, to] = holeRange(second, hole);
  const len2 = Math.hypot(second.p2.x - second.p1.x, second.p2.y - second.p1.y);
  assert.ok(from >= 0 && to <= len2 + 1e-6, `проём [${from}, ${to}] в стене длиной ${len2}`);
  assert.equal(validateModel(model).some((p) => p.code === "OPENING_OUTSIDE_WALL"), false);
  assert.equal(validateModel(model).some((p) => p.code === "OPENING_OFF_AXIS"), false);
});

test("№6: updateOpening только высоты не двигает проём без at (UI-формат)", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const hole = addOpening(model, { wallId: top.id, type: "window", offsetMm: 1000, widthMm: 1200 });
  delete hole.at; // UI-проёмы поля at не имеют
  const pcBefore = { ...hole.pc };
  updateOpening(model, { wallId: top.id, holeId: hole.id, heightMm: 1600 });
  assert.ok(Math.abs(hole.pc.x - pcBefore.x) < 0.01 && Math.abs(hole.pc.y - pcBefore.y) < 0.01,
    `pc сдвинулся: было (${pcBefore.x},${pcBefore.y}), стало (${hole.pc.x},${hole.pc.y})`);
});

test("№7: грани L-стыка p2–p2 (связи как у редактора): внешний угол (410,−10), внутренний (390,10)", () => {
  const model = emptyModel();
  const a = addWall(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const b = addWall(model, { start: { x: 4000, y: 3000 }, end: { x: 4000, y: 0 } });
  linkNode(a, "p2", b, "p2");
  linkNode(b, "p2", a, "p2");
  const fa = wallFaces(a, model.walls);
  assert.deepEqual({ x: Math.round(fa.l2.x), y: Math.round(fa.l2.y) }, { x: 410, y: -10 }, "A.l2 — внешний угол");
  assert.deepEqual({ x: Math.round(fa.r2.x), y: Math.round(fa.r2.y) }, { x: 390, y: 10 }, "A.r2 — внутренний угол");
  const fb = wallFaces(b, model.walls);
  assert.deepEqual({ x: Math.round(fb.l2.x), y: Math.round(fb.l2.y) }, { x: 390, y: 10 }, "B.l2 — внутренний угол");
  assert.deepEqual({ x: Math.round(fb.r2.x), y: Math.round(fb.r2.y) }, { x: 410, y: -10 }, "B.r2 — внешний угол");
  // направление рисования B не должно менять результат физического стыка
  const model2 = emptyModel();
  const a2 = addWall(model2, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const b2 = addWall(model2, { start: { x: 4000, y: 0 }, end: { x: 4000, y: 3000 } });
  linkNode(a2, "p2", b2, "p1");
  linkNode(b2, "p1", a2, "p2");
  const fa2 = wallFaces(a2, model2.walls);
  assert.deepEqual({ x: Math.round(fa2.l2.x), y: Math.round(fa2.l2.y) }, { x: 410, y: -10 }, "A.l2 при обратном направлении B — тот же внешний угол");
  assert.deepEqual({ x: Math.round(fa2.r2.x), y: Math.round(fa2.r2.y) }, { x: 390, y: 10 }, "A.r2 при обратном направлении B — тот же внутренний угол");
  void b;
});

test("№7: коллинеарный стык — грани без удлинения, как после split", () => {
  const model = emptyModel();
  const a = addWall(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const c = splitWall(model, a.id, 2000);
  const b = c.second;
  linkNode(a, "p2", b, "p1");
  linkNode(b, "p1", a, "p2");
  const fa = wallFaces(a, model.walls);
  assert.deepEqual({ x: fa.l2.x, y: fa.l2.y }, { x: 200, y: -10 }, "грань до среза, без +10 см");
  assert.deepEqual({ x: fa.r2.x, y: fa.r2.y }, { x: 200, y: 10 });
});

test("№9: offset от внутреннего угла при разных толщинах соседей", () => {
  const model = emptyModel();
  // комната inner 4000×3000: верхняя стена 300 мм, остальные 200
  const walls = addRoomRect(model, {
    origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000,
    thicknessMm: { top: 300, right: 200, bottom: 200, left: 200 },
  });
  const top = walls[0]!;
  // ось верхней стены: от (−10,−15) до (410,−15); внутренний угол помещения x=0 (осевая координата 10 см)
  const hole = addOpening(model, { wallId: top.id, type: "door", offsetMm: 300, widthMm: 800 });
  // край на 300 мм от угла → осевая координата 10+30=40 см, центр 80 см → x = −10+80 = 70 см
  assert.ok(Math.abs(hole.pc.x - 70) < 0.05, `pc.x=${hole.pc.x}, ожидалось 70 (а не 60, как при отсчёте от оси)`);
});
