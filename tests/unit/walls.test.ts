import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, Wall } from "../../src/model/types.ts";
import {
  addWall, addPolyline, addRoomRect, updateWall, moveWall, splitWall, deleteWall,
  prepareForRestore, prepareWallFaces,
} from "../../src/model/walls.ts";
import { mmToCm } from "../../src/model/units.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../fixtures");

function loadEnvelope(name: string): Model {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")).model as Model;
}

function clone(model: Model): Model {
  return structuredClone(model);
}

const close = (a: number, b: number, tol = 0.05): boolean => Math.abs(a - b) <= tol;
const closePt = (p: { x: number; y: number }, q: { x: number; y: number }, tol = 0.05): boolean =>
  close(p.x, q.x, tol) && close(p.y, q.y, tol);

test("addWall ставит wall-поля по эталону; связи Node не пишет (§12.3)", () => {
  const model = loadEnvelope("anon-rect-4000x3000.json");
  const empty: Model = { ...clone(model), walls: {} };
  const a = addWall(empty, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  assert.equal(a.plan, "a");
  assert.equal(a.role, "wall");
  assert.equal(a.depth, 20);
  assert.equal(a.height, 270);
  assert.equal(a.material, "a_block");
  assert.deepEqual(a.p1, { x: 0, y: 0 });
  const b = addWall(empty, { start: { x: 4000, y: 0 }, end: { x: 4000, y: 3000 } });
  // связи строит редактор при draw; в Node-модели их нет, узлы совпадают ТОЧНО
  assert.equal(a.p2.link, undefined, "Node не пишет link");
  assert.deepEqual(a.p2, { x: 400, y: 0 });
  assert.deepEqual(b.p1, { x: 400, y: 0 }, "узлы точно в точку (правило 1)");
});

test("addRoomRect inner 4000x3000 при толщине 200 даёт осевой контур 4200x3200", () => {
  const model = loadEnvelope("anon-rect-4000x3000.json");
  const empty: Model = { ...clone(model), walls: {} };
  const walls = addRoomRect(empty, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  assert.equal(walls.length, 4);
  for (const w of walls) assert.equal(w.depth, mmToCm(200));
  // осевые координаты: x от -100 до 4100 мм, y от -100 до 3100 мм
  const xs = walls.flatMap((w) => [w.p1.x, w.p2.x]);
  const ys = walls.flatMap((w) => [w.p1.y, w.p2.y]);
  assert.equal(Math.min(...xs), -10);
  assert.equal(Math.max(...xs), 410);
  assert.equal(Math.min(...ys), -10);
  assert.equal(Math.max(...ys), 310);
  // обход по часовой: верхняя стена +X
  const top = walls.find((w) => w.p1.y === -10 && w.p1.x === -10)!;
  assert.ok(top.p2.x > top.p1.x);
});

test("addRoomRect: dimensions=axis не добавляет толщину", () => {
  const model = loadEnvelope("anon-rect-4000x3000.json");
  const empty: Model = { ...clone(model), walls: {} };
  const walls = addRoomRect(empty, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, dimensions: "axis" });
  const xs = walls.flatMap((w) => [w.p1.x, w.p2.x]);
  const ys = walls.flatMap((w) => [w.p1.y, w.p2.y]);
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.max(...xs), 400);
});

test("addRoomRect: разная толщина сторон", () => {
  const model = loadEnvelope("anon-rect-4000x3000.json");
  const empty: Model = { ...clone(model), walls: {} };
  const walls = addRoomRect(empty, {
    origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000,
    thicknessMm: { top: 400, right: 200, bottom: 100, left: 300 },
  });
  const top = walls.find((w) => w.depth === 40)!;
  assert.ok(top);
  assert.ok(closePt(top.p1, { x: -15, y: -20 }, 0.01));
  assert.ok(closePt(top.p2, { x: 410, y: -20 }, 0.01));
  const bottom = walls.find((w) => w.depth === 10)!;
  assert.ok(closePt(bottom.p1, { x: 410, y: 305 }, 0.01));
  assert.ok(closePt(bottom.p2, { x: -15, y: 305 }, 0.01));
});

test("две комнаты с общей стеной не дублируют ось; коллинеарные продолжения сливаются", () => {
  const model = loadEnvelope("anon-rect-4000x3000.json");
  const empty: Model = { ...clone(model), walls: {} };
  addRoomRect(empty, { origin: { x: 0, y: 0 }, widthMm: 3000, depthMm: 4000 });
  assert.equal(Object.keys(empty.walls).length, 4);
  // комната B примыкает справа: её внутренний левый край = внутренний правый край A + толщина стены
  addRoomRect(empty, { origin: { x: 3200, y: 0 }, widthMm: 2000, depthMm: 4000 });
  // общая ось x=310 — ОДНА стена; верх и низ, ставшие общими, слиты (как Wall.merge редактора)
  assert.equal(Object.keys(empty.walls).length, 5);
  const onAxis310 = Object.values(empty.walls).filter((w) => w.p1.x === 310 && w.p2.x === 310);
  assert.equal(onAxis310.length, 1, `на оси x=310 одна стена, получено ${onAxis310.length}`);
  // общая стена накрывает тело обеих комнат; её концы лежат на гранях верха/низа
  assert.equal(onAxis310[0]!.p1.y, 0);
  assert.equal(onAxis310[0]!.p2.y, 400);
  // связей в Node-модели нет (их строит редактор)
  assert.equal(onAxis310[0]!.p1.link, undefined);
});

test("addPolyline замкнутый контур — углы точно в точку, без связей (§12.3)", () => {
  const model = loadEnvelope("anon-rect-4000x3000.json");
  const empty: Model = { ...clone(model), walls: {} };
  const walls = addPolyline(empty, {
    points: [
      { x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 1000 }, { x: 0, y: 1000 },
    ],
    closed: true,
    thicknessMm: 100,
  });
  assert.equal(walls.length, 4);
  // каждый угол контура — общая точка двух стен с точностью 0,01 см
  const ends = walls.flatMap((w) => [w.p1, w.p2]);
  for (const corner of [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }]) {
    const n = ends.filter((e) => Math.hypot(e.x - corner.x, e.y - corner.y) < 0.01).length;
    assert.equal(n, 2, `в углу ${JSON.stringify(corner)} ровно два конца`);
  }
  for (const w of walls) {
    assert.equal(w.p1.link, undefined);
    assert.equal(w.p2.link, undefined);
  }
});

test("updateWall: длина с якорем end двигает только p2", () => {
  const model = loadEnvelope("anon-rect-4000x3000.json");
  const empty: Model = { ...clone(model), walls: {} };
  const a = addWall(empty, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  updateWall(empty, { wallId: a.id, lengthMm: 5000, anchor: "end" });
  assert.ok(closePt(a.p2, { x: 500, y: 0 }, 0.01));
  assert.ok(closePt(a.p1, { x: 0, y: 0 }, 0.01));
  updateWall(empty, { wallId: a.id, lengthMm: 2000, anchor: "start" });
  assert.ok(closePt(a.p1, { x: 300, y: 0 }, 0.01));
  assert.ok(closePt(a.p2, { x: 500, y: 0 }, 0.01));
});

test("updateWall: толщина both/left/right", () => {
  const model = loadEnvelope("anon-rect-4000x3000.json");
  const empty: Model = { ...clone(model), walls: {} };
  const a = addWall(empty, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  prepareWallFaces(empty);
  // свободные концы: без удлинения, грань = ось ± depth/2
  assert.ok(closePt(a.l1!, { x: 0, y: -10 }, 0.01));
  updateWall(empty, { wallId: a.id, thicknessMm: 400 });
  assert.equal(a.depth, 40);
  prepareWallFaces(empty);
  assert.ok(closePt(a.l1!, { x: 0, y: -20 }, 0.01));
  // side right: правая грань остаётся на месте
  const b = addWall(empty, { start: { x: 0, y: 1000 }, end: { x: 4000, y: 1000 } });
  prepareWallFaces(empty);
  const r1Before = { ...b.r1! };
  updateWall(empty, { wallId: b.id, thicknessMm: 300, side: "right" });
  assert.equal(b.depth, 30);
  prepareWallFaces(empty);
  assert.ok(closePt(b.r1!, r1Before, 0.02));
});

test("updateWall: перенос узла тянет соседа, стоявший в том же узле (правило 5)", () => {
  const model = loadEnvelope("anon-rect-4000x3000.json");
  const empty: Model = { ...clone(model), walls: {} };
  const a = addWall(empty, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const b = addWall(empty, { start: { x: 4000, y: 0 }, end: { x: 4000, y: 3000 } });
  updateWall(empty, { wallId: a.id, end: { x: 5000, y: 0 } });
  assert.ok(closePt(b.p1, { x: 500, y: 0 }, 0.01));
  assert.ok(closePt(a.p2, { x: 500, y: 0 }, 0.01));
  void b;
});

test("moveWall: перпендикулярное смещение, +100 мм влево по ходу (+X = −Y)", () => {
  const model = loadEnvelope("anon-rect-4000x3000.json");
  const empty: Model = { ...clone(model), walls: {} };
  addWall(empty, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const b = addWall(empty, { start: { x: 4000, y: 0 }, end: { x: 4000, y: 3000 } });
  const a = Object.values(empty.walls)[0]!;
  moveWall(empty, { wallId: a.id, offsetMm: 100 });
  assert.ok(closePt(a.p1, { x: 0, y: -10 }, 0.01));
  assert.ok(closePt(a.p2, { x: 400, y: -10 }, 0.01));
  // сосед b остался на своей прямой x=400, стык в (400,-10)
  assert.ok(closePt(b.p1, { x: 400, y: -10 }, 0.01));
  assert.ok(closePt(b.p2, { x: 400, y: 300 }, 0.01));
});

test("splitWall режет стену и раздаёт проёмы", () => {
  const model = loadEnvelope("anon-rect-4000x3000.json");
  const empty: Model = { ...clone(model), walls: {} };
  const a = addWall(empty, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const b = addWall(empty, { start: { x: 4000, y: 0 }, end: { x: 4000, y: 3000 } });
  const w = empty.walls[a.id] as Wall;
  w.holes["h1"] = {
    id: "h1", plan: "a", type: "window", group: "windows",
    pc: { x: 350, y: 0 }, width: 80, height: 150, depth: 10,
  };
  const { first, second } = splitWall(empty, a.id, 3000);
  assert.equal(Object.keys(first.holes).length, 0);
  assert.equal(Object.keys(second.holes).length, 1);
  assert.ok(closePt(first.p2, { x: 300, y: 0 }, 0.01));
  assert.ok(closePt(second.p1, { x: 300, y: 0 }, 0.01));
  assert.ok(closePt(second.p2, { x: 400, y: 0 }, 0.01));
  // входящие связи редактор переназначит сам при draw (правило 6); координаты соседа не тронуты
  assert.ok(closePt(b.p1, { x: 400, y: 0 }, 0.01));
  void w;
});

test("deleteWall снимает link у соседей и считает проёмы", () => {
  const model = loadEnvelope("anon-rect-4000x3000.json");
  const empty: Model = { ...clone(model), walls: {} };
  const a = addWall(empty, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const b = addWall(empty, { start: { x: 4000, y: 0 }, end: { x: 4000, y: 3000 } });
  a.holes["h1"] = { id: "h1", plan: "a", type: "doorway", group: "doors", pc: { x: 200, y: 0 }, width: 90, height: 210, depth: 10 };
  const res = deleteWall(empty, a.id);
  assert.equal(res.removedHoles, 1);
  assert.equal(empty.walls[a.id], undefined);
  assert.equal(b.p1.link, undefined);
});

// ---------- структурное сравнение с нормализованной фикстурой T1 ----------

function stripDerived(model: Model): void {
  for (const w of Object.values(model.walls)) {
    delete w.l1;
    delete w.l2;
    delete w.r1;
    delete w.r2;
    for (const h of Object.values(w.holes)) {
      delete h.p1;
      delete h.p2;
    }
  }
}

test("prepareForRestore: результат структурно совпадает с нормализованной фикстурой T1", () => {
  const source = clone(loadEnvelope("anon-rect-4000x3000.json"));
  const expected = loadEnvelope("normalized-rect-4000x3000.json");
  stripDerived(source);
  prepareForRestore(source);
  assert.equal(Object.keys(source.walls).length, Object.keys(expected.walls).length);
  for (const [id, exp] of Object.entries(expected.walls)) {
    const got = source.walls[id];
    assert.ok(got, `стена ${id} есть`);
    assert.ok(closePt(got.p1, exp.p1, 0.01), `p1 ${id}`);
    assert.ok(closePt(got.p2, exp.p2, 0.01), `p2 ${id}`);
    assert.equal(got.depth, exp.depth);
    for (const face of ["l1", "l2", "r1", "r2"] as const) {
      assert.ok(
        closePt(got[face]!, exp[face]!, 0.05),
        `грань ${id}.${face}: got ${JSON.stringify(got[face])} expected ${JSON.stringify(exp[face])}`,
      );
    }
    assert.equal(Object.keys(got.holes ?? {}).length, Object.keys(exp.holes ?? {}).length);
    for (const hid of Object.keys(exp.holes ?? {})) {
      const expHole = exp.holes[hid]!;
      const gotHole: Wall["holes"][string] | undefined = got.holes[hid];
      assert.ok(gotHole, `проём ${hid}`);
      assert.equal(gotHole.type, expHole.type);
      assert.ok(closePt(gotHole.pc, expHole.pc, 0.01));
      assert.ok(closePt(gotHole.p1!, expHole.p1!, 0.05), `p1 проёма ${hid}`);
      assert.ok(closePt(gotHole.p2!, expHole.p2!, 0.05), `p2 проёма ${hid}`);
    }
  }
});

test("prepareWallFaces: одиночная стена без соседей — без удлинения (эталон ui-one-wall)", () => {
  const model = loadEnvelope("ui-one-wall.json");
  const w = Object.values(model.walls)[0]!;
  const expected = { l1: w.l1!, l2: w.l2!, r1: w.r1!, r2: w.r2! };
  delete w.l1;
  delete w.l2;
  delete w.r1;
  delete w.r2;
  prepareWallFaces(model);
  for (const face of ["l1", "l2", "r1", "r2"] as const) {
    assert.ok(
      closePt(w[face]!, expected[face], 0.01),
      `${face}: got ${JSON.stringify(w[face])} expected ${JSON.stringify(expected[face])}`,
    );
  }
});

test("prepareForRestore идемпотентен", () => {
  const model = clone(loadEnvelope("anon-rect-4000x3000.json"));
  stripDerived(model);
  prepareForRestore(model);
  const first = structuredClone(Object.values(model.walls)[0]!.l1);
  prepareForRestore(model);
  const second = Object.values(model.walls)[0]!.l1!;
  assert.ok(closePt(first!, second, 1e-9));
});
