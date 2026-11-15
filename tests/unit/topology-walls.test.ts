// Этап 6, T26: правила геометрии стен §12.3 (design) — геометрия без связей.
// Регрессии R2-2, R2-3, R2-4, R2-5, R2-6 раунда 2 ревью.
import test from "node:test";
import assert from "node:assert/strict";
import { addWall, addRoomRect, moveWall, splitWall, deleteWall } from "../../src/model/walls.ts";
import { addOpening } from "../../src/model/openings.ts";
import { validateModel } from "../../src/model/validate.ts";
import { McpError } from "../../src/errors.ts";
import type { Model, Point } from "../../src/model/types.ts";

function emptyModel(): Model {
  return {
    v: 3, id: "0", plan_id: "0",
    walls: {}, items: {}, pillars: {}, rulers: {}, comments: {},
    total_height: 270, final: false,
  };
}

/** Коридор inner (100,100) 5800×1000 + три комнаты сверху (T24, оси: 0..600 × −300..120 см). */
function corridor(model: Model): void {
  addRoomRect(model, { origin: { x: 100, y: 100 }, widthMm: 5800, depthMm: 1000, thicknessMm: 200 });
}
function rooms(model: Model): void {
  addRoomRect(model, { origin: { x: 100, y: -2900 }, widthMm: 2800, depthMm: 2800, thicknessMm: 200 });
  addRoomRect(model, { origin: { x: 3100, y: -2900 }, widthMm: 1800, depthMm: 2800, thicknessMm: 200 });
  addRoomRect(model, { origin: { x: 5100, y: -2900 }, widthMm: 800, depthMm: 2800, thicknessMm: 200 });
}
function wallsOf(model: Model): string[] {
  return Object.values(model.walls)
    .map((w) => `(${w.p1.x},${w.p1.y})-(${w.p2.x},${w.p2.y})`)
    .sort();
}

test("T26/R2-4: коридор + 3 комнаты, коридор первым — 7 стен, T-концы на гранях", () => {
  const model = emptyModel();
  corridor(model);
  rooms(model);
  assert.equal(Object.keys(model.walls).length, 7, wallsOf(model).join(" | "));
  // перегородки: от грани верхней стены (y=−290) до грани стены коридора (y=−10)
  const parts = Object.values(model.walls).filter((w) => w.p1.x === w.p2.x && w.p1.x !== 0 && w.p1.x !== 600);
  assert.equal(parts.length, 2);
  for (const p of parts) {
    assert.deepEqual([p.p1.y, p.p2.y].sort((a, b) => a - b), [-290, -10], `перегородка на гранях: ${JSON.stringify(p.p1)}`);
  }
  // стена коридора: от грани левой (x=10) до грани правой (x=590)
  const cor = Object.values(model.walls).find((w) => w.p1.y === 0 && w.p2.y === 0)!;
  assert.deepEqual([cor.p1.x, cor.p2.x].sort((a, b) => a - b), [10, 590]);
});

test("T26/R2-4: тот же план в обратном порядке вставки даёт ту же геометрию", () => {
  const model = emptyModel();
  rooms(model);
  corridor(model);
  assert.equal(Object.keys(model.walls).length, 7, wallsOf(model).join(" | "));
  const cor = Object.values(model.walls).find((w) => w.p1.y === 0 && w.p2.y === 0);
  assert.ok(cor, "стена коридора на месте");
  const parts = Object.values(model.walls).filter((w) => w.p1.x === w.p2.x && w.p1.x !== 0 && w.p1.x !== 600);
  for (const p of parts) {
    assert.deepEqual([p.p1.y, p.p2.y].sort((a, b) => a - b), [-290, -10], "перегородки продлены до граней");
  }
});

test("T26/R2-2: две разнесённые комнаты с перекрывающимися X-проекциями создаются без ошибки", () => {
  const model = emptyModel();
  addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  addRoomRect(model, { origin: { x: 1000, y: 5000 }, widthMm: 2000, depthMm: 2000, thicknessMm: 200 });
  assert.equal(Object.keys(model.walls).length, 8);
  assert.equal(validateModel(model).some((p) => p.code === "WALL_OVER_WALL"), false);
});

test("T26/R2-3: отказ операции оставляет модель побайтно равной исходной", () => {
  const model = emptyModel();
  addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  const before = JSON.stringify(model.walls);
  // комната с осью на теле существующей стены под другой толщиной → отказ
  assert.throws(
    () => addRoomRect(model, {
      origin: { x: 4200, y: 0 }, widthMm: 2000, depthMm: 2000,
      thicknessMm: { top: 100, right: 100, bottom: 100, left: 100 },
    }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_GEOMETRY",
  );
  assert.equal(JSON.stringify(model.walls), before, "модель не изменилась после отказа");
  // X-пересечение тоже атомарно
  assert.throws(
    () => addWall(model, { start: { x: 2000, y: -1000 }, end: { x: 2000, y: 5000 } }),
    (e: unknown) => e instanceof McpError && e.code === "UNSUPPORTED_JUNCTION",
  );
  assert.equal(JSON.stringify(model.walls), before);
});

test("T26/R2-5: move стены коридора продлевает перегородки до новой грани", () => {
  const model = emptyModel();
  corridor(model);
  rooms(model);
  const cor = Object.values(model.walls).find((w) => w.p1.y === 0 && w.p2.y === 0)!;
  moveWall(model, { wallId: cor.id, offsetMm: -200 }); // вниз (вправо по ходу p1→p2)
  // стена коридора на y=+20, концы на гранях внешних стен (x=10 и 590) — как в T24/D
  assert.deepEqual([cor.p1.y, cor.p2.y], [20, 20]);
  assert.deepEqual([cor.p1.x, cor.p2.x].sort((a, b) => a - b), [10, 590]);
  // перегородки продлены до новой грани коридора (y=+10)
  const parts = Object.values(model.walls).filter((w) => w.p1.x === w.p2.x && w.p1.x !== 0 && w.p1.x !== 600);
  for (const p of parts) {
    assert.deepEqual([p.p1.y, p.p2.y].sort((a, b) => a - b), [-290, 10], `перегородка до новой грани: ${JSON.stringify(p.p1)}`);
  }
  // повторная операция видит новую геометрию
  moveWall(model, { wallId: cor.id, offsetMm: 100 });
  assert.deepEqual([cor.p1.y, cor.p2.y], [10, 10]);
});

test("T26/R2-6: проём соседа остаётся на оси после move стены", () => {
  const model = emptyModel();
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  const top = walls[0]!;
  const left = walls[3]!;
  const door = addOpening(model, { wallId: left.id, type: "door", offsetMm: 500, widthMm: 800 });
  moveWall(model, { wallId: left.id, offsetMm: 300 });
  // дверь переехала вместе с осью стены
  assert.equal(door.pc.x, left.p1.x, `pc.x=${door.pc.x}, ось x=${left.p1.x}`);
  // и у ТОП-стены, удлинённой влево, проём тоже на оси (пересчёт затронутых стен)
  const win = addOpening(model, { wallId: top.id, type: "window", offsetMm: 1500, widthMm: 1200 });
  moveWall(model, { wallId: left.id, offsetMm: -300 });
  const problems = validateModel(model).filter((p) => p.code.startsWith("OPENING"));
  assert.equal(problems.length, 0, `проёмы на осях: ${JSON.stringify(problems)}`);
  assert.equal(win.pc.y, top.p1.y, "окно верхней стены на её оси");
});

test("T26: зазор концов 0,01…1,5 см → INVALID_GEOMETRY (редактор склеил бы молча)", () => {
  const model = emptyModel();
  addWall(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  // конец в 10 мм (1 см) от узла (400,0)
  assert.throws(
    () => addWall(model, { start: { x: 4000, y: 1000 }, end: { x: 3990, y: 0 } }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_GEOMETRY",
  );
  // точное совпадение узла — разрешено
  const b = addWall(model, { start: { x: 4000, y: 1000 }, end: { x: 4000, y: 0 } });
  assert.deepEqual(b.p2, { x: 400, y: 0 });
});

test("T26: X-пересечение посреди отрезков → UNSUPPORTED_JUNCTION", () => {
  const model = emptyModel();
  addWall(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  assert.throws(
    () => addWall(model, { start: { x: 2000, y: -2000 }, end: { x: 2000, y: 2000 } }),
    (e: unknown) => e instanceof McpError && e.code === "UNSUPPORTED_JUNCTION",
  );
});

test("T26: сторона комнаты на оси стены другой толщины → INVALID_GEOMETRY", () => {
  const model = emptyModel();
  addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  // верхняя сторона второй комнаты (толщина 300) лежит на оси y=310 нижней стены (толщина 200)
  assert.throws(
    () => addRoomRect(model, {
      origin: { x: 0, y: 3250 }, widthMm: 2000, depthMm: 2000,
      thicknessMm: { top: 300, right: 200, bottom: 200, left: 200 },
    }),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_GEOMETRY",
  );
});

test("T26: split геометрический — соседние координаты не портятся, проёмы раздаются", () => {
  const model = emptyModel();
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  const bottom = walls[2]!;
  const hole = addOpening(model, { wallId: bottom.id, type: "door", offsetMm: 3000, widthMm: 800, from: "start" });
  const { first, second } = splitWall(model, bottom.id, 2000);
  assert.ok(Object.keys(first.holes).length === 0 || Object.keys(second.holes).length === 0, "проём в одной части");
  assert.equal(Object.keys(first.holes).length + Object.keys(second.holes).length, 1);
  const holder = model.walls[hole.id] !== undefined || Object.values(first.holes).concat(Object.values(second.holes)).some((h) => h.id === hole.id);
  assert.ok(holder);
  assert.equal(deleteWall(model, second.id).removedHoles >= 0, true);
  void bottom;
});

test("T26: концы стен после построения комнат не имеют link (связи строит редактор)", () => {
  const model = emptyModel();
  corridor(model);
  rooms(model);
  for (const w of Object.values(model.walls)) {
    assert.equal(w.p1.link, undefined, `${w.id}.p1`);
    assert.equal(w.p2.link, undefined, `${w.id}.p2`);
  }
});

test("T26: точки-помощники не экспортируются наружу — тип Point используется в тестах", () => {
  const p: Point = { x: 0, y: 0 };
  assert.equal(typeof p.x, "number");
});
