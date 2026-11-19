// 246 №5/№6: настоящие топологические операции с плинтусами и нишей — split,
// merge, удаление, перенос стены (не тавтологии): часть переживает разрез,
// merge — предупреждение, потеря покрытия (M4), смена типа (M3), потеря
// потолочного плинтуса (M2) и строгость режима save (M9) дают problems.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model, Point } from "../../src/model/types.ts";
import {
  setFloorMolding, setCeilingMolding, setCeilingFinish, addCeilingNiche,
  removeFloorMolding, removeCeilingMolding, removeCeilingNiche,
  setFloorFinish, finishCompare, finishMismatches,
} from "../../src/model/finish.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

function roomsOf(m: Model): Record<string, Record<string, unknown>> {
  return (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
}

/** Модель с одной прямоугольной комнатой 280×280 (10..290 × -290..-10),
 *  ребро 0 — стена wallId на x=290 (p1=(290,-290) → p2=(290,-10)). */
function rectRoom(): { m: Model; room: string; wallId: string; edges: Array<{ pid?: string; p1?: Point; p2?: Point }> } {
  const m = baseModel();
  const room = Object.keys(roomsOf(m))[0]!;
  const rooms = roomsOf(m);
  rooms[room]!["polygon"] = [
    { x: 290, y: -290 }, { x: 290, y: -10 }, { x: 10, y: -10 }, { x: 10, y: -290 },
  ];
  const wallId = Object.values(m.walls)[0]!.id;
  const edges = rooms[room]!["edges"] as Array<{ pid?: string; p1?: Point; p2?: Point }>;
  assert.ok(edges.length >= 4);
  for (let i = 1; i < edges.length; i++) {
    if (edges[i]!.pid === wallId) edges[i]!.pid = `w${i}x`;
  }
  edges[0]!.pid = wallId;
  edges[0]!.p1 = { x: 290, y: -290 };
  edges[0]!.p2 = { x: 290, y: -10 };
  return { m, room, wallId, edges };
}

/** Комната с полным набором: пол, потолок, плинтусы пола и потолка, ниша. */
function dressedRoom(): { rooms: Record<string, Record<string, unknown>>; room: string; wallId: string } {
  const { m, room, wallId } = rectRoom();
  setFloorFinish(m, room, "laminate", {});
  setCeilingFinish(m, room, "gypsum_ceiling", {});
  setFloorMolding(m, room, wallId, "floor_molding_mdf");
  setCeilingMolding(m, room, wallId);
  addCeilingNiche(m, room, wallId);
  return { rooms: structuredClone(roomsOf(m)) as Record<string, Record<string, unknown>>, room, wallId };
}

/** Комната-«часть» с унаследованными полом и потолком (эталон 98: split). */
function partOf(
  rooms: Record<string, Record<string, unknown>>,
  src: string,
  key: string,
  polygon: Point[],
  opts: { moldings?: boolean; niche?: boolean } = {},
): Record<string, unknown> {
  const s = structuredClone(rooms[src]!) as unknown as Record<string, unknown>;
  s["polygon"] = polygon;
  if (opts.moldings === false) {
    for (const k of ["floorMoldings", "ceilingMoldings"] as const) {
      const arr = (s[k] as Array<Record<string, unknown>> | undefined) ?? [];
      for (const rec of arr) rec["exist"] = false;
    }
  }
  if (opts.niche === false) {
    const c0 = (s["ceilings"] as Array<Record<string, unknown>>)[0]!;
    for (const rec of (c0["niches"] as Array<Record<string, unknown>>) ?? []) rec["exist"] = false;
  }
  return s;
}

test("246 №5/№6: настоящий split — плинтусы и ниша переживают разрез в части, потеря в единственной части — problems (M8)", () => {
  const { rooms, room } = dressedRoom();
  const exp = structuredClone(rooms) as Record<string, Record<string, unknown>>;
  // сервер: комната разрезана на левую и правую половины
  const got: Record<string, Record<string, unknown>> = {
    _part1: partOf(rooms, room, "_part1", [{ x: 150, y: -290 }, { x: 290, y: -290 }, { x: 290, y: -10 }, { x: 150, y: -10 }]),
    _part2: partOf(rooms, room, "_part2", [{ x: 10, y: -290 }, { x: 150, y: -290 }, { x: 150, y: -10 }, { x: 10, y: -10 }], { moldings: false, niche: false }),
  };
  // ниша части ссылается на потолок своей части (id перегенерируется)
  const c1 = (got["_part1"]!["ceilings"] as Array<Record<string, unknown>>)[0]!;
  for (const n of (c1["niches"] as Array<Record<string, unknown>>) ?? []) {
    for (const p of Object.values((n["parts"] ?? {}) as Record<string, Record<string, unknown>>)) p["id_ceiling"] = c1["id"];
  }
  const survived = finishCompare(exp, got, undefined, undefined, "normalize");
  assert.deepEqual(survived.problems, [], "плинтус/ниша в одной из частей — не потеря");
  assert.deepEqual(survived.warnings, []);
  // обе части без плинтусов и ниши — problems (мутант M8 «split → warning» падает)
  const gotEmpty: Record<string, Record<string, unknown>> = {
    _part1: partOf(rooms, room, "_part1", [{ x: 150, y: -290 }, { x: 290, y: -290 }, { x: 290, y: -10 }, { x: 150, y: -10 }], { moldings: false, niche: false }),
    _part2: partOf(rooms, room, "_part2", [{ x: 10, y: -290 }, { x: 150, y: -290 }, { x: 150, y: -10 }, { x: 10, y: -10 }], { moldings: false, niche: false }),
  };
  const lost = finishCompare(exp, gotEmpty, undefined, undefined, "normalize");
  assert.ok(lost.problems.some((p) => p.includes("плинтус")), "потеря плинтуса при split — problem");
  assert.ok(lost.problems.some((p) => p.includes("потолочный плинтус")), "потеря потолочного плинтуса при split — problem");
  assert.ok(lost.problems.some((p) => p.includes("ниша")), "потеря ниши при split — problem");
});

test("246 №5/№6: настоящий merge — предупреждение finish_topology_changed, проблем по плинтусам/нише нет", () => {
  const { rooms, room } = dressedRoom();
  // источник A — комната, источник B — соседняя справа (свои пол/потолок)
  const exp: Record<string, Record<string, unknown>> = {
    [room]: rooms[room]!,
    _srcB: {
      polygon: [{ x: 290, y: -290 }, { x: 290, y: -10 }, { x: 570, y: -10 }, { x: 570, y: -290 }],
      floors: [{ exist: true, polygon: [{ x: 290, y: -290 }, { x: 290, y: -10 }, { x: 570, y: -10 }, { x: 570, y: -290 }], cover: "floor_tile" }],
      ceilings: [{ exist: true, id: "_cb", polygon: [], material: "stretch_ceiling" }],
    },
  };
  // сервер: обе объединены в одну комнату (пол/потолок одного из источников)
  const merged = structuredClone(rooms[room]!) as unknown as Record<string, unknown>;
  merged["polygon"] = [{ x: 570, y: -290 }, { x: 570, y: -10 }, { x: 10, y: -10 }, { x: 10, y: -290 }];
  ((merged["floors"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)["polygon"] = structuredClone(merged["polygon"] as Point[]);
  for (const k of ["floorMoldings", "ceilingMoldings"] as const) {
    for (const rec of (merged[k] as Array<Record<string, unknown>>) ?? []) rec["exist"] = false;
  }
  const c0 = (merged["ceilings"] as Array<Record<string, unknown>>)[0]!;
  for (const rec of (c0["niches"] as Array<Record<string, unknown>>) ?? []) rec["exist"] = false;
  const got: Record<string, Record<string, unknown>> = { _merged: merged as Record<string, Record<string, unknown>> };
  const res = finishCompare(exp, got, undefined, undefined, "normalize");
  assert.ok(res.warnings.some((w) => w.includes("finish_topology_changed")), "merge — предупреждение");
  assert.deepEqual(res.problems, [], "плинтусы/ниша при merge — предупреждение, не блокировка");
});

test("246 №5: удаление плинтусов и ниши — расхождение exp↔got", () => {
  const { m, room, wallId } = rectRoom();
  setFloorFinish(m, room, "laminate", {});
  setCeilingFinish(m, room, "gypsum_ceiling", {});
  setFloorMolding(m, room, wallId, "floor_molding_mdf");
  setCeilingMolding(m, room, wallId);
  addCeilingNiche(m, room, wallId);
  const exp = structuredClone(roomsOf(m)) as Record<string, Record<string, unknown>>;
  removeFloorMolding(m, room, wallId);
  removeCeilingMolding(m, room, wallId);
  removeCeilingNiche(m, room, wallId);
  const got = structuredClone(roomsOf(m)) as Record<string, Record<string, unknown>>;
  const problems = finishMismatches(exp, got);
  assert.ok(problems.some((p) => p.includes("плинтус") && !p.includes("потолочный")), "напольный плинтус удалён — расхождение");
  assert.ok(problems.some((p) => p.includes("потолочный плинтус")), "потолочный плинтус удалён — расхождение");
  assert.ok(problems.some((p) => p.includes("ниша")), "ниша удалена — расхождение");
});

test("246 №6: потеря покрытия (укорочение вдвое) и смена типа плинтуса — расхождения (M4/M3)", () => {
  const { rooms, room } = dressedRoom();
  const exp = structuredClone(rooms) as Record<string, Record<string, unknown>>;
  // укорочение вдвое: покрытие середины ребра, концы не покрыты (допуск UI 6 см)
  const gotShort = structuredClone(rooms) as Record<string, Record<string, unknown>>;
  const part = Object.values((gotShort[room]!["floorMoldings"] as Array<Record<string, unknown>>)[0]!["parts"] as Record<string, Record<string, unknown>>)[0]!;
  const line = part["line"] as { p1: Point; p2: Point };
  const midY = (line.p1.y + line.p2.y) / 2;
  part["line"] = { p1: { x: line.p1.x, y: midY - 70 }, p2: { x: line.p2.x, y: midY + 70 } };
  assert.ok(finishMismatches(exp, gotShort).some((p) => p.includes("плинтус")), "укорочение вдвое — потеря покрытия (M4)");
  // смена типа
  const gotType = structuredClone(rooms) as Record<string, Record<string, unknown>>;
  const part2 = Object.values((gotType[room]!["floorMoldings"] as Array<Record<string, unknown>>)[0]!["parts"] as Record<string, Record<string, unknown>>)[0]!;
  part2["type"] = "floor_molding_wood";
  assert.ok(finishMismatches(exp, gotType).some((p) => p.includes("floor_molding_mdf")), "смена типа плинтуса — расхождение (M3)");
  // потеря потолочного плинтуса (M2)
  const gotCeil = structuredClone(rooms) as Record<string, Record<string, unknown>>;
  for (const rec of (gotCeil[room]!["ceilingMoldings"] as Array<Record<string, unknown>>) ?? []) rec["exist"] = false;
  assert.ok(finishMismatches(exp, gotCeil).some((p) => p.includes("потолочный плинтус")), "потеря потолочного плинтуса — расхождение (M2)");
});

test("246 №5: перенос стены — плинтус и ниша переезжают со стеной (line/line_wall/pid), без расхождений", () => {
  const { m, room, wallId } = rectRoom();
  setCeilingFinish(m, room, "gypsum_ceiling", {});
  setFloorMolding(m, room, wallId, "floor_molding_mdf");
  setCeilingMolding(m, room, wallId);
  addCeilingNiche(m, room, wallId);
  const rooms = roomsOf(m);
  const exp = structuredClone(rooms) as Record<string, Record<string, unknown>>;
  // стена переехала на x=230: полигон, ребро, плинтусы и ниша — вместе со стеной
  const shift = (p: Point): Point => ({ x: p.x - 60, y: p.y });
  rooms[room]!["polygon"] = (rooms[room]!["polygon"] as Point[]).map(shift);
  const edges = rooms[room]!["edges"] as Array<{ pid?: string; p1?: Point; p2?: Point }>;
  edges[0]!.p1 = shift(edges[0]!.p1!);
  edges[0]!.p2 = shift(edges[0]!.p2!);
  for (const key of ["floorMoldings", "ceilingMoldings"] as const) {
    for (const p of Object.values(((rooms[room]![key] as Array<Record<string, unknown>>)[0]!["parts"]) as Record<string, Record<string, unknown>>)) {
      p["line"] = { p1: shift((p["line"] as { p1: Point; p2: Point }).p1), p2: shift((p["line"] as { p1: Point; p2: Point }).p2) };
      p["line_wall"] = { p1: shift((p["line_wall"] as { p1: Point; p2: Point }).p1), p2: shift((p["line_wall"] as { p1: Point; p2: Point }).p2) };
    }
  }
  const c0 = (rooms[room]!["ceilings"] as Array<Record<string, unknown>>)[0]!;
  for (const n of (c0["niches"] as Array<Record<string, unknown>>) ?? []) {
    for (const p of Object.values((n["parts"] ?? {}) as Record<string, Record<string, unknown>>)) {
      p["line"] = { p1: shift((p["line"] as { p1: Point; p2: Point }).p1), p2: shift((p["line"] as { p1: Point; p2: Point }).p2) };
      p["line_wall"] = { p1: shift((p["line_wall"] as { p1: Point; p2: Point }).p1), p2: shift((p["line_wall"] as { p1: Point; p2: Point }).p2) };
    }
  }
  const got = structuredClone(rooms) as Record<string, Record<string, unknown>>;
  const expWalls = { [wallId]: { p1: { x: 290, y: -290 }, p2: { x: 290, y: -10 } } };
  const gotWalls = { [wallId]: { p1: { x: 230, y: -290 }, p2: { x: 230, y: -10 } } };
  assert.deepEqual(
    finishCompare(exp, got, expWalls, gotWalls, "normalize").problems,
    [],
    "плинтусы и ниша пережили перенос стены",
  );
  // плинтус остался на старом месте, стена уехала — расхождение
  const gotStale = structuredClone(got) as Record<string, Record<string, unknown>>;
  const expPart = Object.values((exp[room]!["floorMoldings"] as Array<Record<string, unknown>>)[0]!["parts"] as Record<string, Record<string, unknown>>)[0]!;
  const stalePart = Object.values((gotStale[room]!["floorMoldings"] as Array<Record<string, unknown>>)[0]!["parts"] as Record<string, Record<string, unknown>>)[0]!;
  stalePart["line"] = structuredClone(expPart["line"]);
  stalePart["line_wall"] = structuredClone(expPart["line_wall"]);
  assert.ok(
    finishCompare(exp, gotStale, expWalls, gotWalls, "normalize").problems.some((p) => p.includes("плинтус")),
    "плинтус не переехал со стеной — расхождение",
  );
});

test("246 №6: режим save строг — split без наследования и пропавшая комната дают problems (M9)", () => {
  const { rooms, room } = dressedRoom();
  const exp = structuredClone(rooms) as Record<string, Record<string, unknown>>;
  // «сервер» вернул split без плинтусов: в save-режиме освобождений нет
  const got: Record<string, Record<string, unknown>> = {
    _part1: partOf(rooms, room, "_part1", [{ x: 150, y: -290 }, { x: 290, y: -290 }, { x: 290, y: -10 }, { x: 150, y: -10 }], { moldings: false, niche: false }),
    _part2: partOf(rooms, room, "_part2", [{ x: 10, y: -290 }, { x: 150, y: -290 }, { x: 150, y: -10 }, { x: 10, y: -10 }], { moldings: false, niche: false }),
  };
  const save = finishCompare(exp, got, undefined, undefined, "save");
  assert.ok(save.problems.some((p) => p.includes("плинтус") && p.includes("не найдена")), "save: плинтус без наследника — problem");
  assert.ok(save.problems.some((p) => p.includes("ниша")), "save: ниша без наследника — problem");
  assert.ok(save.problems.some((p) => p.includes("потолочный плинтус")), "save: потолочный плинтус без наследника — problem");
});
