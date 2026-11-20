// 306 (повторное ревью PR #47): исправления m8 (решение координатора), N3, N4 —
// потолочные закладные. Порядок: тест красный на 3106004 → фикс → зелёный.
import test from "node:test";
import assert from "node:assert/strict";
import { addCeilingRigel, ceilingRigelCompare } from "../../src/model/ceiling-rigels.ts";
import type { Model, Wall } from "../../src/model/types.ts";

const mkWall = (id: string, p1: { x: number; y: number }, p2: { x: number; y: number }): Wall =>
  ({ id, plan: "a", role: "wall", child: 0, archive: 0, demount: 0, depth: 20, height: 270, p1: { ...p1, role: "p1", link: 0 }, p2: { ...p2, role: "p2", link: 0 } }) as unknown as Wall;

/** Комната 10..390 × 10..310 с рамкой стен. */
function modelBase(): Model {
  return {
    walls: {
      wall1: mkWall("wall1", { x: 400, y: 0 }, { x: 400, y: 320 }),
      wall2: mkWall("wall2", { x: 0, y: 320 }, { x: 400, y: 320 }),
      wall3: mkWall("wall3", { x: 0, y: 0 }, { x: 0, y: 320 }),
      wall4: mkWall("wall4", { x: 0, y: 0 }, { x: 400, y: 0 }),
    },
    pillars: {},
    items: {},
    rigels: {},
    rooms2: {
      room1: { polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }] },
    },
  } as unknown as Model;
}

/** Запись закладной как у MCP (вертикаль x=200, ширина 10). */
function rgRec(id: string): Record<string, unknown> {
  return {
    id,
    p1: { x: 200, y: 10, link: { ot: "wall", id: "wall4", z1: "r" } },
    p2: { x: 200, y: 310, link: { ot: "wall", id: "wall2", z1: "l" } },
    width: 10, ceiling_type: "",
    polygon: [{ x: 205, y: 10 }, { x: 205, y: 310 }, { x: 195, y: 310 }, { x: 195, y: 10 }],
  };
}

function roomsLike(rigels: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    room1: {
      polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }],
      ...(rigels ? { rigels: structuredClone(rigels) } : {}),
    },
  };
}

// ---------- m8: нормализация удалила закладную затронутой комнаты — отказ ----------

test("306 m8: нормализация удалила закладную затронутой комнаты → problem с подсказкой ceiling_rigel_delete CR<n>", () => {
  const exp = roomsLike({ rg1: rgRec("rg1") });
  const got = roomsLike(undefined);
  const norm = ceilingRigelCompare(exp, got, "normalize", { affectedRooms: new Set(["room1"]) });
  assert.ok(
    norm.problems.some((p) => p.includes("удалила закладную") && p.includes("CR1") && p.includes("ceiling_rigel_delete")),
    `отказ до записи с подсказкой, получено: ${JSON.stringify({ problems: norm.problems, warnings: norm.warnings })}`,
  );
});

test("306 m8: нормализация только сдвинула конец оси затронутой комнаты → предупреждение, без отказов", () => {
  const exp = roomsLike({ rg1: rgRec("rg1") });
  const moved = roomsLike({ rg1: { ...rgRec("rg1"), p1: { x: 200, y: 20, link: { ot: "wall", id: "wall4", z1: "r" } } } });
  const norm = ceilingRigelCompare(exp, moved, "normalize", { affectedRooms: new Set(["room1"]) });
  assert.deepEqual(norm.problems, [], `сдвиг конца оси — не отказ: ${JSON.stringify(norm.problems)}`);
  assert.ok(norm.warnings.length > 0, "но с предупреждением");
});

// ---------- N3: общий конец — пересечение (LIB.twoLinesIntersection, режим 0) ----------

test("306 N3: V-пара закладных из одной точки грани → отказ (редактор удалит одну при restore)", () => {
  const m = modelBase();
  addCeilingRigel(m, "room1", { start: { x: 2000, y: 100 }, end: { x: 2000, y: 3100 } });
  assert.throws(
    () => addCeilingRigel(m, "room1", { start: { x: 2000, y: 100 }, end: { x: 3900, y: 3100 } }),
    /пересекает.*закладную|удалит пересекающуюся/,
  );
});

test("306 N3: касание концом разделителя зон оси закладной → отказ (mouseup редактора, режим 0)", () => {
  const m = modelBase();
  // делитель от правой стены (390,160) до точки ровно на будущей оси x=200
  // (запись напрямую — эталон П-разделителя review305-zones3-fixes)
  (m as unknown as Record<string, unknown>)["zone_delimiters"] = {
    zd1: {
      id: "zd1",
      matrix: [[null, { length: 1.9 }], [{ length: 1.9 }, null]],
      vertexes: [
        { id: "v1", point: { x: 390, y: 160 }, type: "node" },
        { id: "v2", point: { x: 200, y: 160 }, type: "node" },
      ],
      items: { v1: "node", v2: "node" },
      type: "zone_ceiling",
      length: 1.9,
      id_room: "room1",
      plan: "ceiling",
      on_size: 1,
    },
  };
  assert.throws(
    () => addCeilingRigel(m, "room1", { start: { x: 2000, y: 100 }, end: { x: 2000, y: 3100 } }),
    /пересекает разделитель зон/,
  );
});

// ---------- N4: текст problem называет различающееся поле ----------

test("306 N4: расхождение связи — problem называет p1.link, а не только width/ceiling_type", () => {
  const exp = roomsLike({ rg1: rgRec("rg1") });
  const swapped = roomsLike({
    rg1: { ...rgRec("rg1"), p1: { x: 200, y: 10, link: { ot: "wall", id: "wall4", z1: "l" } } },
  });
  const res = ceilingRigelCompare(exp, swapped, "save");
  assert.ok(res.problems.length > 0, "расхождение связи — problem");
  assert.match(res.problems[0]!, /p1\.link/, `поле названо: ${res.problems[0]}`);
  assert.ok(!res.problems[0]!.includes("width 10 → 10"), `без ложной пары width: ${res.problems[0]}`);
});

test("306 N4: расхождение оси — problem называет ось", () => {
  const exp = roomsLike({ rg1: rgRec("rg1") });
  const shifted = roomsLike({ rg1: { ...rgRec("rg1"), p1: { x: 210, y: 10, link: { ot: "wall", id: "wall4", z1: "r" } } } });
  const res = ceilingRigelCompare(exp, shifted, "save");
  assert.ok(res.problems.length > 0);
  assert.match(res.problems[0]!, /ось|p1/, `поле названо: ${res.problems[0]}`);
});
