// 305: минорные находки ревью 304 (m2, m3, m4, m8) — потолочные закладные.
import test from "node:test";
import assert from "node:assert/strict";
import { addCeilingRigel, ceilingRigelCompare, ceilingRigelList } from "../../src/model/ceiling-rigels.ts";
import type { Model, Wall, Pillar } from "../../src/model/types.ts";

const mkWall = (id: string, p1: { x: number; y: number }, p2: { x: number; y: number }): Wall =>
  ({ id, plan: "a", role: "wall", child: 0, archive: 0, demount: 0, depth: 20, height: 270, p1: { ...p1, role: "p1", link: 0 }, p2: { ...p2, role: "p2", link: 0 } }) as unknown as Wall;

function modelBase(extraWalls: Wall[] = []): Model {
  return {
    walls: {
      wall1: mkWall("wall1", { x: 400, y: 0 }, { x: 400, y: 320 }),
      wall2: mkWall("wall2", { x: 0, y: 320 }, { x: 400, y: 320 }),
      wall3: mkWall("wall3", { x: 0, y: 0 }, { x: 0, y: 320 }),
      wall4: mkWall("wall4", { x: 0, y: 0 }, { x: 400, y: 0 }),
      ...Object.fromEntries(extraWalls.map((w) => [w.id, w])),
    },
    pillars: {},
    items: {},
    rigels: {},
    rooms2: {
      room1: {
        polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }],
      },
    },
  } as unknown as Model;
}

// ---------- m2: метки CR<n> нумеруются по полному списку ----------

test("305 m2: метки CR<n> сквозные по комнатам (нумерация по полному списку)", () => {
  const m = modelBase([
    mkWall("w0b", { x: 0, y: 390 }, { x: 400, y: 390 }),
    mkWall("w0t", { x: 0, y: 610 }, { x: 400, y: 610 }),
    mkWall("w0l", { x: 0, y: 390 }, { x: 0, y: 610 }),
    mkWall("w0r", { x: 400, y: 390 }, { x: 400, y: 610 }),
  ]);
  addCeilingRigel(m, "room1", { start: { x: 2000, y: 100 }, end: { x: 2000, y: 3100 } });
  (m.rooms2 as Record<string, unknown>)["room0"] = {
    polygon: [{ x: 390, y: 400 }, { x: 390, y: 600 }, { x: 10, y: 600 }, { x: 10, y: 400 }],
  };
  addCeilingRigel(m, "room0", { start: { x: 2000, y: 4000 }, end: { x: 2000, y: 6000 } });
  const list = ceilingRigelList(m);
  assert.deepEqual(list.map((r) => r["id"]), ["CR1", "CR2"], "нумерация по полному списку комнат, порядок обхода устойчив");
  assert.deepEqual(list.map((r) => r["room_id"]), ["room1", "room0"]);
});

// ---------- m3: gypsum_sm пропускается; торцы стен s/e связываются ----------

test("305 m3: грань колонны gypsum_sm (ГКЛ-пятно) не магнитит конец закладной", () => {
  const m = modelBase();
  const gp = {
    id: "gp", plan: "c", role: "gypsum", role_: "gypsum_sm", width: 40, height: 20, angle: 0,
    pc: { x: 200, y: 160 },
    p1: { x: 180, y: 150 }, p2: { x: 220, y: 150 }, p3: { x: 220, y: 170 }, p4: { x: 180, y: 170 },
  } as unknown as Pillar;
  (m.pillars as Record<string, Pillar>)["gp"] = gp;
  // конец в 20 мм от грани ГКЛ-пятна (x=220), других граней рядом нет
  assert.throws(
    () => addCeilingRigel(m, "room1", { start: { x: 2220, y: 1600 }, end: { x: 2220, y: 1601 } }),
    /от стены до стены/,
  );
});

test("305 m3: конец закладной на торце стены связывается (z1 s/e, как в редакторе)", () => {
  const m = modelBase([mkWall("stub", { x: 110, y: 160 }, { x: 210, y: 160 })]);
  // горизонтальная закладная: левый конец точно на торце s пробочной стены
  // (x=110 — торец у её начала p1)
  const rec = addCeilingRigel(m, "room1", { start: { x: 1100, y: 1600 }, end: { x: 3900, y: 1600 } });
  assert.deepEqual(rec.p1.link, { ot: "wall", id: "stub", z1: "s" }, "торец стены — связь z1 s, как mouseup редактора");
});

// ---------- m4: оба конца на одном объекте — отказ без учёта грани ----------

test("305 m4: оба конца на одном объекте (разные торцы одной стены) → отказ", () => {
  const m = modelBase([mkWall("stub", { x: 110, y: 160 }, { x: 210, y: 160 })]);
  assert.throws(
    () => addCeilingRigel(m, "room1", { start: { x: 1100, y: 1600 }, end: { x: 2100, y: 1600 } }),
    /оба конца на одном объекте/,
  );
});

// ---------- m8: подсказка «сначала удалите закладную» в warning затронутой комнаты ----------

test("305 m8: пропажа закладной у затронутой комнаты — warning с подсказкой ceiling_rigel_delete", () => {
  const rg = {
    id: "rg1", id_room: "room1",
    p1: { x: 200, y: 10, link: { ot: "wall", id: "wall4", z1: "r" } },
    p2: { x: 200, y: 310, link: { ot: "wall", id: "wall2", z1: "l" } },
    width: 10, ceiling_type: "", polygon: [{ x: 205, y: 10 }, { x: 205, y: 310 }, { x: 195, y: 310 }, { x: 195, y: 10 }],
  };
  const exp = { room1: { polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }], rigels: { rg1: structuredClone(rg) } } };
  const got = { room1: { polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }] } };
  const norm = ceilingRigelCompare(exp, got, "normalize", { affectedRooms: new Set(["room1"]) });
  assert.deepEqual(norm.problems, []);
  assert.ok(
    norm.warnings.some((w) => w.includes("не найдена") && w.includes("ceiling_rigel_delete")),
    `подсказка в warning: ${JSON.stringify(norm.warnings)}`,
  );
  const save = ceilingRigelCompare(exp, got, "save", { affectedRooms: new Set(["room1"]) });
  assert.ok(
    save.problems.some((p) => p.includes("потеряна") && p.includes("ceiling_rigel_delete")),
    `подсказка в problem: ${JSON.stringify(save.problems)}`,
  );
});
