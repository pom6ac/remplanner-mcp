// Регрессионные тесты ревью (№8, №10, №14, №15, №19) — переписаны под вариант G
// (design §12.3): Node задаёт только геометрию, связи и комнаты строит редактор.
// Комнаты читаются из rooms2 нормализованной модели (этап 6, T27).
import test from "node:test";
import assert from "node:assert/strict";
import { addRoomRect, addRoomPolygon, addWall, wallFaces } from "../../src/model/walls.ts";
import { addItem } from "../../src/model/items.ts";
import { compactModel } from "../../src/model/compact.ts";
import { validateModel } from "../../src/model/validate.ts";
import { addOpening } from "../../src/model/openings.ts";
import { splitWall } from "../../src/model/walls.ts";
function splitWallForTest(model: Model, id: string, at: number) {
  return splitWall(model, id, at);
}
import { McpError } from "../../src/errors.ts";
import type { Model, Wall } from "../../src/model/types.ts";

function emptyModel(): Model {
  return {
    v: 3, id: "0", plan_id: "0",
    walls: {}, items: {}, pillars: {}, rulers: {}, comments: {},
    total_height: 270, final: false,
  };
}

/** Связи node как их ставит редактор (для wallFaces — грани на node-стыках). */
function linkNodes(model: Model): void {
  const walls = Object.values(model.walls);
  for (const a of walls) {
    for (const na of ["p1", "p2"] as const) {
      if (a[na].link) continue;
      for (const b of walls) {
        if (b.id === a.id) continue;
        for (const nb of ["p1", "p2"] as const) {
          if (Math.hypot(a[na].x - b[nb].x, a[na].y - b[nb].y) < 0.01) {
            a[na].link = { ct: "node", ot: "wall", id: b.id, z0: "c", z1: nb };
          }
        }
      }
    }
  }
}

test("№8: две соседние комнаты с общей стеной — общая ось одна, дубликатов нет", () => {
  const model = emptyModel();
  addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  // вторая комната примыкает справа: inner origin x = 4200 мм (общая стена — правая стена первой)
  addRoomRect(model, { origin: { x: 4200, y: 0 }, widthMm: 2000, depthMm: 3000, thicknessMm: 200 });
  // общая ось x=410 — одна стена (вычитание покрытых интервалов, правило 3);
  // верх и низ, ставшие общими, слиты в одинарные стены, как Wall.merge редактора
  const onAxis = Object.values(model.walls).filter((w) => w.p1.x === 410 && w.p2.x === 410);
  assert.equal(onAxis.length, 1, `на общей оси одна стена, получено ${onAxis.length}`);
  assert.equal(Object.keys(model.walls).length, 5);
});

test("№8: T-конец ставится на грань несущей стены, а не на ось (T24, правило 2)", () => {
  const model = emptyModel();
  addWall(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const part = addWall(model, { start: { x: 2000, y: 3000 }, end: { x: 2000, y: 0 } });
  assert.deepEqual({ x: part.p2.x, y: part.p2.y }, { x: 200, y: 10 }, "T-конец на грани (ось ± depth/2)");
});

test("№8: частичное примыкание комнаты по оси — покрытые интервалы вычитаются", () => {
  const model = emptyModel();
  addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  // комната ниже: её верхняя сторона лежит на оси y=320 нижней стены и частично покрыта
  addRoomRect(model, { origin: { x: 0, y: 3200 }, widthMm: 2000, depthMm: 2000, thicknessMm: 200 });
  // ось y=310 (общая с нижней стеной первой комнаты): один участок, без дублей
  const onAxis = Object.values(model.walls).filter((w) => w.p1.y === 310 && w.p2.y === 310);
  assert.equal(onAxis.length, 1, `на общей оси один участок, получено ${onAxis.length}`);
  const xs = [onAxis[0]!.p1.x, onAxis[0]!.p2.x];
  assert.equal(Math.min(...xs), 0, "конец общей стены на грани левой стены");
  assert.equal(Math.max(...xs), 410);
});

test("№10: предмет у стены — ширина вдоль стены (угол оси), без пересечения грани", () => {
  const model = emptyModel();
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  model.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } };
  const bottom = walls[2]!;
  const sofa = addItem(model, {
    name: "sofa_double",
    position: { againstWall: { wallId: bottom.id, offsetMm: 1000, gapMm: 0 } },
    widthMm: 1400, depthMm: 800, heightMm: 850,
  });
  assert.ok(Math.abs(Math.abs(sofa.angle) - 0) < 2 || Math.abs(Math.abs(sofa.angle) - 180) < 2,
    `angle=${sofa.angle} — ширина должна лежать вдоль стены`);
  const yMaxMm = sofa.pc.y * 10 + 400;
  assert.ok(yMaxMm <= 3000.5, `нижний край предмета ${yMaxMm} мм — касание грани 3000 мм`);
});

test("№14: addRoomPolygon с dimensions=inner строит стены наружу (осевой контур 4200x3200)", () => {
  const model = emptyModel();
  addRoomPolygon(model, {
    points: [
      { x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 },
    ],
    thicknessMm: 200,
    dimensions: "inner",
  });
  const xs = Object.values(model.walls).flatMap((w) => [w.p1.x, w.p2.x]);
  const ys = Object.values(model.walls).flatMap((w) => [w.p1.y, w.p2.y]);
  assert.equal(Math.round(Math.max(...xs) - Math.min(...xs)), 420);
  assert.equal(Math.round(Math.max(...ys) - Math.min(...ys)), 320);
});

test("№15: len_inner_mm по граням при разных толщинах соседей (связи как у редактора)", () => {
  const model = emptyModel();
  addRoomRect(model, {
    origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000,
    thicknessMm: { top: 400, right: 200, bottom: 100, left: 300 },
  });
  linkNodes(model);
  const compact = compactModel(model);
  const bottomWall = compact.walls.find((w) => w.from[1] === w.to[1] && w.from[1] > 3000);
  assert.ok(bottomWall, "нижняя стена найдена");
  assert.equal(bottomWall!.len_inner_mm, 4000, `len_inner_mm=${bottomWall!.len_inner_mm}, ожидалось 4000`);
});

test("№19: две стены с совпадающими осями → INVALID_GEOMETRY сразу при addWall", () => {
  const model = emptyModel();
  addWall(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  assert.throws(
    () => addWall(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_GEOMETRY",
  );
});

test("№19: стены-дубликаты в готовой модели → WALL_OVER_WALL (валидатор)", () => {
  const model = emptyModel();
  const a = addWall(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const dup: Wall = structuredClone(a);
  dup.id = "dup1";
  model.walls[dup.id] = dup;
  assert.ok(validateModel(model).some((p) => p.code === "WALL_OVER_WALL"));
});

test("№19: предметы без комнат → ITEM_OUTSIDE_ROOM (kind=no_rooms)", () => {
  const model = emptyModel();
  addWall(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  model.items = { i1: { id: "i1", name: "sofa", pc: { x: 100, y: 100 }, angle: 0, width: 100, height: 80, plan: {} } };
  const problems = validateModel(model);
  assert.ok(problems.some((p) => p.code === "ITEM_OUTSIDE_ROOM" && (p.details as { kind?: string }).kind === "no_rooms"));
});

test("№7: грани L-стыка p2–p2 при связях редактора: внешний угол (410,−10), внутренний (390,10)", () => {
  const model = emptyModel();
  const a = addWall(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const b = addWall(model, { start: { x: 4000, y: 3000 }, end: { x: 4000, y: 0 } });
  linkNodes(model);
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
  linkNodes(model2);
  const fa2 = wallFaces(a2, model2.walls);
  assert.deepEqual({ x: Math.round(fa2.l2.x), y: Math.round(fa2.l2.y) }, { x: 410, y: -10 }, "A.l2 при обратном направлении B — тот же внешний угол");
  assert.deepEqual({ x: Math.round(fa2.r2.x), y: Math.round(fa2.r2.y) }, { x: 390, y: 10 }, "A.r2 при обратном направлении B — тот же внутренний угол");
  void b;
});

test("№7: коллинеарный стык — грани без удлинения, как после split", () => {
  const model = emptyModel();
  const a = addWall(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  // разрез даёт два коллинеарных куска встык (split не сливает)
  const { second } = splitWallForTest(model, a.id, 2000);
  void second;
  linkNodes(model);
  const fa = wallFaces(a, model.walls);
  assert.deepEqual({ x: fa.l2.x, y: fa.l2.y }, { x: 200, y: -10 }, "грань до среза, без +10 см");
  assert.deepEqual({ x: fa.r2.x, y: fa.r2.y }, { x: 200, y: 10 });
});

test("№9: offset от внутреннего угла при разных толщинах соседей (геометрия без link)", () => {
  const model = emptyModel();
  const walls = addRoomRect(model, {
    origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000,
    thicknessMm: { top: 300, right: 200, bottom: 200, left: 200 },
  });
  const top = walls[0]!;
  const hole = addOpening(model, { wallId: top.id, type: "door", offsetMm: 300, widthMm: 800 });
  assert.ok(Math.abs(hole.pc.x - 70) < 0.05, `pc.x=${hole.pc.x}, ожидалось 70 (а не 60, как при отсчёте от оси)`);
});
