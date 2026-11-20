// 305 (ревью 304): проверки оси закладной (M2–M4) и сверка save (M5–M6).
// Порядок правил: тест красный на 18610c4 → фикс → зелёный.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseModelImport } from "../../src/model/import-schema.ts";
import { addCeilingRigel, ceilingRigelCompare } from "../../src/model/ceiling-rigels.ts";
import { zoneCeilingDelimiterLines } from "../../src/model/zone.ts";
import type { Model, Wall } from "../../src/model/types.ts";

const REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-zones3-ceiling-rigel.json", "utf8")) as {
  room: { polygon: { x: number; y: number }[] };
  rigels: Record<string, Record<string, unknown>>;
};

function baseModel(): Record<string, unknown> {
  return { v: 1, plan_id: "1", walls: {}, items: {}, pillars: {} };
}

// ---------- M1: схема импорта rooms2[].rigels ----------

test("305 M1: мусор в rooms2[].rigels отклоняется импортом (схема+лимиты)", () => {
  const m = {
    ...baseModel(),
    rooms2: { a: { rigels: { r1: { p1: "x", p2: 5, width: -1e9, polygon: "bad" } } } },
  };
  assert.throws(() => parseModelImport(m), (e: unknown) => {
    const msg = (e as Error).message;
    assert.match(msg, /model\.rooms2\.a\.rigels/);
    return true;
  });
});

test("305 M1: превышение лимита числа закладных по комнатам отклоняется", () => {
  const mk = (i: number) => ({ id: `r${i}`, p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 }, width: 10 });
  const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`r${i}`, mk(i)]));
  const m = { ...baseModel(), rooms2: { a: { rigels: many }, b: { rigels: { z: mk(0) } } } };
  assert.throws(() => parseModelImport(m), /лимит|слишком много/);
});

test("305 M1: живой формат закладной (эталон 303) проходит импорт", () => {
  const m = {
    ...baseModel(),
    rooms2: {
      room1: {
        polygon: structuredClone(REF.room.polygon),
        rigels: structuredClone(REF.rigels),
      },
    },
  };
  const out = parseModelImport(m) as Record<string, unknown>;
  const room = ((out["rooms2"] as Record<string, Record<string, unknown>>)["room1"] ?? {}) as Record<string, unknown>;
  assert.ok(room["rigels"], "закладная прошла импорт");
});

// ---------- M2: пересечение оси с разделителем по ВСЕМ рёбрам графа ----------

function refWalls(): Record<string, Wall> {
  const mk = (id: string, p1: { x: number; y: number }, p2: { x: number; y: number }): Wall =>
    ({ id, plan: "a", role: "wall", child: 0, archive: 0, demount: 0, depth: 20, height: 270, p1: { ...p1, role: "p1", link: 0 }, p2: { ...p2, role: "p2", link: 0 } }) as unknown as Wall;
  return {
    wall1: mk("wall1", { x: 400, y: 0 }, { x: 400, y: 320 }),
    wall2: mk("wall2", { x: 0, y: 320 }, { x: 400, y: 320 }),
    wall3: mk("wall3", { x: 0, y: 0 }, { x: 0, y: 320 }),
    wall4: mk("wall4", { x: 0, y: 0 }, { x: 400, y: 0 }),
  };
}

/** П-образный zone_ceiling (3 вершины, 2 ребра графа) в комнате 10..390 × 10..310. */
function modelWithPShapedDelimiter(): Model {
  return {
    walls: refWalls(),
    pillars: {},
    items: {},
    rigels: {},
    rooms2: {
      room1: {
        polygon: [
          { x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 },
        ],
      },
    },
    zone_delimiters: {
      zd1: {
        id: "zd1",
        matrix: [
          [null, { length: 1 }, null, null],
          [{ length: 1 }, null, { length: 1 }, null],
          [null, { length: 1 }, null, { length: 1 }],
          [null, null, { length: 1 }, null],
        ],
        vertexes: [
          { id: "v1", point: { x: 390, y: 100 }, type: "node" },
          { id: "v2", point: { x: 300, y: 100 }, type: "node" },
          { id: "v3", point: { x: 300, y: 200 }, type: "node" },
          { id: "v4", point: { x: 390, y: 200 }, type: "node" },
        ],
        items: { v1: "node", v2: "node", v3: "node", v4: "node" },
        type: "zone_ceiling",
        length: 2.7,
        id_room: "room1",
        plan: "ceiling",
        on_size: 1,
      },
    },
  } as unknown as Model;
}

test("305 M2: П-образный разделитель — ось пересекает средний отрезок → отказ; хорда не принимается во внимание", () => {
  const m = modelWithPShapedDelimiter();
  // рёбра графа (не хорда v1→v4) участвуют в проверке
  const lines = zoneCeilingDelimiterLines(m);
  assert.equal(lines.length, 3, `zoneCeilingDelimiterLines возвращает все рёбра графа, получено ${lines.length}`);
  // закладная x=350 (вертикаль, концы на стенах) пересекает горизонтальные
  // отрезки П-разделителя (y=100 и y=200)
  assert.throws(
    () => addCeilingRigel(m, "room1", { start: { x: 3500, y: 100 }, end: { x: 3500, y: 3100 } }),
    /пересекает разделитель зон/,
  );
});

// ---------- M3: пересечение закладных между собой ----------

test("305 M3: пересечение осей двух закладных одной комнаты → отказ (restore редактора удалит)", () => {
  const m = modelWithPShapedDelimiter();
  delete (m as unknown as Record<string, unknown>)["zone_delimiters"];
  addCeilingRigel(m, "room1", { start: { x: 2000, y: 300 }, end: { x: 2000, y: 3000 } });
  // горизонтальная закладная пересекает вертикальную
  assert.throws(
    () => addCeilingRigel(m, "room1", { start: { x: 500, y: 1600 }, end: { x: 3500, y: 1600 } }),
    /пересекает (другую )?закладную|удалит пересекающуюся/,
  );
  // другая комната — не мешает
  (m.rooms2 as Record<string, unknown>)["room2"] = {
    polygon: [{ x: 500, y: 500 }, { x: 500, y: 700 }, { x: 300, y: 700 }, { x: 300, y: 500 }],
  };
});

// ---------- M4: вложенность оси в комнату (Г-комната) ----------

test("305 M4: Г-образная комната — ось, срезающая внутренний угол → отказ", () => {
  const m = {
    walls: refWalls(),
    pillars: {},
    items: {},
    rigels: {},
    rooms2: {
      room1: {
        // Г-комната: вырезан правый нижний угол (внутренний угол в (200,200))
        polygon: [
          { x: 10, y: 10 }, { x: 390, y: 10 }, { x: 390, y: 200 }, { x: 200, y: 200 }, { x: 200, y: 310 }, { x: 10, y: 310 },
        ],
      },
    },
  } as unknown as Model;
  // ось под 60° к нижней стене, проходит в 1..6 см мимо внутреннего угла —
  // срезает тело стены угла (пересекает рёбра комнаты)
  assert.throws(
    () => addCeilingRigel(m, "room1", { start: { x: 1500, y: 100 }, end: { x: 3600, y: 2600 } }),
    /вне комнаты|пересекает/,
  );
});

// ---------- M5: save затронутой комнаты — ceiling_type строго ----------

const REF_RG = REF.rigels["rg1"] as Record<string, unknown>;

function roomsLike(rigels: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    room1: {
      polygon: structuredClone(REF.room.polygon),
      ...(rigels ? { rigels: structuredClone(rigels) } : {}),
    },
  };
}

test("305 M5: save + затронутая комната + смена ceiling_type → problem (не warning)", () => {
  const exp = roomsLike({ rg1: structuredClone(REF_RG) });
  const changed = roomsLike({ rg1: { ...structuredClone(REF_RG), ceiling_type: "gypsum_ceiling" } });
  const res = ceilingRigelCompare(exp, changed, "save", { affectedRooms: new Set(["room1"]) });
  assert.ok(res.problems.length > 0, `ceiling_type потерян сервером в save → problem, получено: ${JSON.stringify(res)}`);
});

test("305 M5: save + затронутая комната + пересчитанный полигон (ось цела) → предупреждение", () => {
  const exp = roomsLike({ rg1: structuredClone(REF_RG) });
  const reshaped = roomsLike({
    rg1: { ...structuredClone(REF_RG), polygon: [{ x: 206, y: 10 }, { x: 206, y: 310 }, { x: 194, y: 310 }, { x: 194, y: 10 }] },
  });
  const res = ceilingRigelCompare(exp, reshaped, "save", { affectedRooms: new Set(["room1"]) });
  assert.deepEqual(res.problems, [], "полигон редактор пересчитывает (calc) — не отказ");
  assert.ok(res.warnings.length > 0);
});

// ---------- M6: связи p1.link/p2.link и id_room в сверке ----------

test("305 M6: мутация link→0 у затронутой комнаты в save → problem", () => {
  const exp = roomsLike({ rg1: structuredClone(REF_RG) });
  const stripped = structuredClone(exp) as Record<string, unknown>;
  const rg = (((stripped as Record<string, Record<string, unknown>>)["room1"] as Record<string, Record<string, unknown>>)["rigels"] as Record<string, Record<string, unknown>>)["rg1"] as Record<string, { link?: unknown }>;
  rg["p1"]!.link = 0;
  const res = ceilingRigelCompare(exp, stripped, "save", { affectedRooms: new Set(["room1"]) });
  assert.ok(res.problems.length > 0, `связь потеряна → problem, получено: ${JSON.stringify(res)}`);
});

test("305 M6: мутация z1 связи (r → l) в save → problem", () => {
  const exp = roomsLike({ rg1: structuredClone(REF_RG) });
  const swapped = structuredClone(exp) as Record<string, unknown>;
  const rg = (((swapped as Record<string, Record<string, unknown>>)["room1"] as Record<string, Record<string, unknown>>)["rigels"] as Record<string, Record<string, unknown>>)["rg1"] as Record<string, { link: { z1: string } }>;
  rg["p1"]!.link.z1 = "l";
  const res = ceilingRigelCompare(exp, swapped, "save", { affectedRooms: new Set(["room1"]) });
  assert.ok(res.problems.length > 0, `связь подменена → problem, получено: ${JSON.stringify(res)}`);
});

test("305 M6: расхождение id_room при наличии с обеих сторон → problem", () => {
  const exp = roomsLike({ rg1: structuredClone(REF_RG) });
  const moved = structuredClone(exp) as Record<string, unknown>;
  const rg = (((moved as Record<string, Record<string, unknown>>)["room1"] as Record<string, Record<string, unknown>>)["rigels"] as Record<string, Record<string, unknown>>)["rg1"] as Record<string, unknown>;
  rg["id_room"] = "room2";
  const res = ceilingRigelCompare(exp, moved, "save");
  assert.ok(res.problems.length > 0, `id_room подменён → problem, получено: ${JSON.stringify(res)}`);
});
