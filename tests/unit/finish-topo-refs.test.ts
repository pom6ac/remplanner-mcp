// 98 (ревью 97 N1/N2/N3): эталоны топологии редактора ui-ref-finish-topo-*.json —
// правило наследования отделки при split/merge/переносе стены, «эталон → verified»;
// строгий режим save (после GET) против fault injection; ориентированная
// принадлежность отделки стороне комнаты.
// Эталоны сняты настоящим headless-нормализатором (проба scripts/probes/98-finish-topo.ts,
// синтетическая база editor-corridor-3rooms, анонимный проект, без записи на сервер).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finishCompare } from "../../src/model/finish.ts";

type Line = [[number, number], [number, number]];
type TopoRoom = {
  poly: [number, number][];
  edges: Array<[string, number, number, number, number]>;
  floor: Record<string, unknown> | null;
  ceiling: Record<string, unknown> | null;
  decor: Record<string, Array<{ type: string; line: Line; height?: number; height_from_floor?: number }>>;
};
type Topo = {
  op: string;
  walls_before: Record<string, [number, number, number, number]>;
  walls_after: Record<string, [number, number, number, number]>;
  before: { rooms: Record<string, TopoRoom> };
  after: { rooms: Record<string, TopoRoom> };
};

const OPS = ["split-unequal", "split-3", "merge-diff-floors", "merge-one-floor", "wall-move"] as const;

function loadTopo(op: string): Topo {
  return JSON.parse(readFileSync(`tests/fixtures/ui-ref-finish-topo-${op}.json`, "utf8")) as Topo;
}

function buildRooms(rooms: Record<string, TopoRoom>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [label, r] of Object.entries(rooms)) {
    const edges = r.edges.map(([pid, x1, y1, x2, y2]) => ({
      pid, p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, length: Math.hypot(x2 - x1, y2 - y1),
    }));
    const decors = edges.map((_e, i) => {
      const parts = r.decor[String(i)];
      if (!parts) return { exist: false };
      const built: Record<string, unknown> = {};
      parts.forEach((p, j) => {
        const line = { p1: { x: p.line[0]![0], y: p.line[0]![1] }, p2: { x: p.line[1]![0], y: p.line[1]![1] } };
        built[`part${j}`] = {
          id: `part${j}`, type: p.type, layer: 1, line, line_wall: structuredClone(line),
          distance: Math.hypot(line.p2.x - line.p1.x, line.p2.y - line.p1.y),
          height: p.height ?? 0, height_from_floor: p.height_from_floor ?? 0,
        };
      });
      return { exist: true, parts: built };
    });
    out[label] = {
      polygon: r.poly.map(([x, y]) => ({ x, y })),
      edges, decors,
      floors: r.floor ? [{ exist: true, ...r.floor }] : [{ exist: false }],
      ceilings: r.ceiling ? [{ exist: true, ...r.ceiling }] : [{ exist: false }],
    };
  }
  return out;
}

function buildWalls(w: Record<string, [number, number, number, number]>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(w).map(([id, [x1, y1, x2, y2]]) => [id, { p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } }]));
}

// ---------- эталон → verified ----------

for (const op of OPS) {
  test(`98 эталон ${op}: normalize против правила наследования — без расхождений`, () => {
    const t = loadTopo(op);
    const res = finishCompare(
      buildRooms(t.before.rooms), buildRooms(t.after.rooms),
      buildWalls(t.walls_before), buildWalls(t.walls_after), "normalize",
    );
    assert.deepEqual(res.problems, [], JSON.stringify(res));
    assert.deepEqual(res.warnings, [], "эталоны не содержат merge с отделкой сторон — предупреждений нет");
  });
}

test("98 правило (эталон split-unequal): пол/потолок наследует каждая часть", () => {
  const t = loadTopo("split-unequal");
  // у обеих частей (N1 1.68 м² и A 5.6 м²) пол и потолок — эталон; убираем у части N1
  t.after.rooms["N1"]!.floor = null;
  const res = finishCompare(
    buildRooms(t.before.rooms), buildRooms(t.after.rooms),
    buildWalls(t.walls_before), buildWalls(t.walls_after), "normalize",
  );
  assert.ok(res.problems.some((p) => p.includes("N1") && p.includes("не унаследовала покрытие пола")), JSON.stringify(res.problems));
});

test("98 правило (эталон split-3): все три части наследуют пол", () => {
  const t = loadTopo("split-3");
  t.after.rooms["N2"]!.floor = null;
  const res = finishCompare(
    buildRooms(t.before.rooms), buildRooms(t.after.rooms),
    buildWalls(t.walls_before), buildWalls(t.walls_after), "normalize",
  );
  assert.ok(res.problems.some((p) => p.includes("N2") && p.includes("не унаследовала покрытие пола")), JSON.stringify(res.problems));
});

test("98 правило (эталон split): отделка стороны переживает разрез только в одной части — достаточно; полное исчезновение — расхождение", () => {
  const t = loadTopo("split-unequal");
  // штатно (эталон): обои остались только в части A — verified (проверено выше);
  // удаляем отделку и у наследника — потеря
  delete t.after.rooms["A"]!.decor["3"];
  const res = finishCompare(
    buildRooms(t.before.rooms), buildRooms(t.after.rooms),
    buildWalls(t.walls_before), buildWalls(t.walls_after), "normalize",
  );
  assert.ok(res.problems.some((p) => p.includes("потеряна отделка стены w1")), JSON.stringify(res.problems));
});

// ---------- N1: merge ----------

test("98 N1: merge — наследник без пола — расхождение (эталон merge-one-floor: пол сохраняется)", () => {
  const t = loadTopo("merge-one-floor");
  t.after.rooms["N1"]!.floor = null;
  const res = finishCompare(
    buildRooms(t.before.rooms), buildRooms(t.after.rooms),
    buildWalls(t.walls_before), buildWalls(t.walls_after), "normalize",
  );
  assert.ok(res.problems.some((p) => p.includes("потеряла покрытие пола")), JSON.stringify(res.problems));
});

test("98 N1: merge — у наследника чужое покрытие (не одно из исходных) — расхождение", () => {
  const t = loadTopo("merge-diff-floors");
  t.after.rooms["N1"]!.floor = { cover: "parquet" };
  const res = finishCompare(
    buildRooms(t.before.rooms), buildRooms(t.after.rooms),
    buildWalls(t.walls_before), buildWalls(t.walls_after), "normalize",
  );
  assert.ok(res.problems.some((p) => p.includes("потеряла покрытие пола")), JSON.stringify(res.problems));
});

test("98 N1: merge — наследник сохранил пол ОДНОГО из источников (floor_tile) — эталон verified, потолок одного из источников тоже", () => {
  const t = loadTopo("merge-one-floor");
  // эталон: наследник получил laminate и paint_ceiling комнаты A; подменяем на потолок,
  // которого не было ни у одного источника — расхождение
  t.after.rooms["N1"]!.ceiling = { material: "gypsum_ceiling", level: 0, profile: "standard" };
  const res = finishCompare(
    buildRooms(t.before.rooms), buildRooms(t.after.rooms),
    buildWalls(t.walls_before), buildWalls(t.walls_after), "normalize",
  );
  assert.ok(res.problems.some((p) => p.includes("потеряла покрытие потолка")), JSON.stringify(res.problems));
});

// ---------- N1: fault injection только в GET — режим save строгий ----------

test("98 N1: fault injection в GET (полигон удвоен, пол удалён) — режим save обнаруживает, освобождений нет", () => {
  const t = loadTopo("merge-one-floor");
  const got = structuredClone(t.before.rooms);
  const a = got["A"]!;
  const minX = Math.min(...a.poly.map(([x]) => x));
  a.poly = a.poly.map(([x, y]) => [minX + (x - minX) * 2, y]);
  a.floor = null;
  const res = finishCompare(
    buildRooms(t.before.rooms), buildRooms(got),
    buildWalls(t.walls_before), buildWalls(t.walls_before), "save",
  );
  assert.ok(res.problems.length > 0, "строгий режим после GET не пропускает подмену топологии");
  // тот же сценарий в режиме normalize — тоже расхождение (нет сопоставления по контуру,
  // наследник не найден: обе комнаты на месте)
  const resNorm = finishCompare(
    buildRooms(t.before.rooms), buildRooms(got),
    buildWalls(t.walls_before), buildWalls(t.walls_before), "normalize",
  );
  assert.ok(resNorm.problems.length > 0);
});

test("98 N1: save-режим — потеря пола без изменения топологии — расхождение", () => {
  const t = loadTopo("merge-one-floor");
  const got = structuredClone(t.before.rooms);
  got["A"]!.floor = null;
  const res = finishCompare(
    buildRooms(t.before.rooms), buildRooms(got),
    buildWalls(t.walls_before), buildWalls(t.walls_before), "save",
  );
  assert.ok(res.problems.some((p) => p.includes("потеряно покрытие пола")), JSON.stringify(res.problems));
});

// ---------- N2: ориентированная принадлежность стороне ----------

/** Две смежные комнаты с общей стеной w6 (ось x=300), одинаковые обои с двух сторон. */
function twoRoomsSharedWall(): { exp: Record<string, unknown>; walls: Record<string, unknown> } {
  const mk = (label: string, x0: number, x1: number, withDecor: boolean): Record<string, unknown> => {
    const edge = { pid: "w6", p1: { x: x1, y: -290 }, p2: { x: x1, y: -10 }, length: 280 };
    const line = { p1: { x: x1, y: -290 }, p2: { x: x1, y: -10 } };
    return {
      polygon: [{ x: x1, y: -290 }, { x: x1, y: -10 }, { x: x0, y: -10 }, { x: x0, y: -290 }],
      edges: [edge],
      decors: [withDecor ? { exist: true, parts: { p: { id: "p", type: "wallpaper", layer: 1, line, line_wall: structuredClone(line), distance: 280, height: 0, height_from_floor: 0 } } } : { exist: false }],
      floors: [{ exist: false }],
      ceilings: [{ exist: false }],
      [label]: true,
    };
  };
  return {
    exp: { R1: mk("R1", 10, 290, true), R2: mk("R2", 310, 490, true) },
    walls: { w6: { p1: { x: 300, y: -290 }, p2: { x: 300, y: -10 } } },
  };
}

test("98 N2: сервер удалил отделку одной из двух сторон общей стены — save-режим: чужая сторона не компенсирует", () => {
  const { exp, walls } = twoRoomsSharedWall();
  const got = structuredClone(exp) as Record<string, Record<string, unknown>>;
  (got["R1"]!["decors"] as Array<Record<string, unknown>>)[0] = { exist: false };
  const res = finishCompare(exp, got, walls, walls, "save");
  assert.ok(res.problems.some((p) => p.includes("R1") && p.includes("потеряна отделка стены w6")), JSON.stringify(res.problems));
});

test("98 N2: то же в normalize без изменения топологии — расхождение (NORMALIZATION_DROPPED)", () => {
  const { exp, walls } = twoRoomsSharedWall();
  const got = structuredClone(exp) as Record<string, Record<string, unknown>>;
  (got["R1"]!["decors"] as Array<Record<string, unknown>>)[0] = { exist: false };
  const res = finishCompare(exp, got, walls, walls, "normalize");
  assert.ok(res.problems.some((p) => p.includes("R1") && p.includes("потеряна отделка стены w6")), JSON.stringify(res.problems));
});

test("98 N2: обе стороны на месте — совпадение", () => {
  const { exp, walls } = twoRoomsSharedWall();
  const got = structuredClone(exp);
  assert.deepEqual(finishCompare(exp, got, walls, walls, "save").problems, []);
  assert.deepEqual(finishCompare(exp, got, walls, walls, "normalize").problems, []);
});

// ---------- N3 fallback: merge с отделкой сторон — предупреждение, не блокировка ----------

test("98 N3: merge комнат с отделкой сторон — предупреждение finish_topology_changed, не расхождение", () => {
  const t = loadTopo("merge-one-floor");
  // эталон без отделки сторон — добавим обои на внешней стороне комнаты A до merge
  t.before.rooms["A"]!.decor["3"] = [{ type: "wallpaper", line: [[10, -290], [290, -290]] }];
  const res = finishCompare(
    buildRooms(t.before.rooms), buildRooms(t.after.rooms),
    buildWalls(t.walls_before), buildWalls(t.walls_after), "normalize",
  );
  assert.deepEqual(res.problems, [], JSON.stringify(res.problems));
  assert.ok(res.warnings.some((w) => w.includes("finish_topology_changed") && w.includes("A")), JSON.stringify(res.warnings));
});
