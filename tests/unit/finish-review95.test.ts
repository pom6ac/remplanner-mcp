// 96 (ревью 95 R1–R6): геометрическое сопоставление комнат (коллинеарные вершины,
// перестановка id, split/merge), сверка всей отделываемой области стороны без
// процентного порога, штатная форма UI, обязательность явно заданных параметров,
// валидация параметров по материалу, метки R<n> из полного списка.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model } from "../../src/model/types.ts";
import {
  resolveRoom, setFloorFinish, setWallFinish, setCeilingFinish,
  finishMismatches, finishList,
} from "../../src/model/finish.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import { McpError } from "../../src/errors.ts";
import type { LoadedModel } from "../../src/api.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

function firstRoomId(m: Model): string {
  return Object.keys((m.rooms2 ?? m.rooms1) as Record<string, unknown>)[0]!;
}

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/* eslint-disable */
type AnyRooms = Record<string, any>;
const normRooms = (norm: Record<string, unknown>): AnyRooms => norm["rooms2"] as AnyRooms;
/* eslint-enable */

/** Mock-сервер как в ревью 95: normalize с подменой, save с подменой после записи. */
function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      afterSave(server);
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

/** Нижнее ребро первой комнаты (10,-290)-(290,-290), стена w1. */
function bottomEdge(m: Model): { pid: string; index: number; p1: { x: number; y: number }; p2: { x: number; y: number } } {
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  const edges = rooms[firstRoomId(m)]!["edges"] as Array<{ pid?: string; p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const index = edges.findIndex((e) => Math.hypot(e.p1.x - 10, e.p1.y + 290) < 0.1 && Math.hypot(e.p2.x - 290, e.p2.y + 290) < 0.1);
  assert.ok(index >= 0, "в фикстуре есть нижнее ребро первой комнаты");
  return { pid: edges[index]!.pid!, index, p1: edges[index]!.p1, p2: edges[index]!.p2 };
}

function part(id: string, p1: { x: number; y: number }, p2: { x: number; y: number }, type = "wallpaper"): Record<string, unknown> {
  const line = { p1, p2 };
  return { id, type, layer: 1, line, line_wall: { ...line }, distance: Math.hypot(p2.x - p1.x, p2.y - p1.y), height: 0, height_from_floor: 0 };
}

// ---------- R1: геометрическое сопоставление комнат ----------

test("96 R1: коллинеарная вершина и новый id комнаты — verified, без ложной блокировки", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const rooms = normRooms(norm);
    const rec = rooms[room];
    delete rooms[room];
    const poly = rec["polygon"] as Array<{ x: number; y: number }>;
    const a = poly[0]!, b = poly[1]!;
    poly.splice(1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    rooms["renamed"] = rec;
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("96 R1: перестановка id двух комнат с разными покрытиями — verified", async () => {
  const m = baseModel();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  const [r1, r2] = [Object.keys(rooms)[0]!, Object.keys(rooms)[1]!];
  setFloorFinish(m, r1, "laminate", {});
  setFloorFinish(m, r2, "floor_tile", {});
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const nr = normRooms(norm);
    const a = structuredClone(nr[r1]), b = structuredClone(nr[r2]);
    delete nr[r1]; delete nr[r2];
    nr["swapped-a"] = b;
    nr["swapped-b"] = a;
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

/** Разрезать первую комнату (10..290 × -290..-10) на две по x=150. */
function splitFirstRoom(norm: Record<string, unknown>, heirFloor: boolean, wallParts: "one-room" | "two-rooms"): void {
  const rooms = normRooms(norm);
  const rid = Object.keys(rooms)[0]!;
  const rec = rooms[rid];
  const decors = rec["decors"] as Array<Record<string, unknown>>;
  const floors = rec["floors"] as Array<Record<string, unknown>>;
  const mk = (x0: number, x1: number): Record<string, unknown> => ({
    polygon: [{ x: x1, y: -290 }, { x: x1, y: -10 }, { x: x0, y: -10 }, { x: x0, y: -290 }],
    edges: [{ p1: { x: x0, y: -290 }, p2: { x: x1, y: -290 }, pid: "w1", side: "r" }],
    decors: [{ exist: false }],
  });
  const g1 = mk(10, 150) as AnyRooms;
  const g2 = mk(150, 290) as AnyRooms;
  if (heirFloor) g1["floors"] = structuredClone(floors);
  if (wallParts === "two-rooms") {
    g1["decors"] = [{ exist: true, parts: { p1: part("pa", { x: 10, y: -290 }, { x: 150, y: -290 }) } }];
    g2["decors"] = [{ exist: true, parts: { p2: part("pb", { x: 150, y: -290 }, { x: 290, y: -290 }) } }];
  } else {
    g1["decors"] = structuredClone(decors);
  }
  delete rooms[rid];
  rooms["split-1"] = g1;
  rooms["split-2"] = g2;
}

test("96 R1: split комнаты — пол у наследника, отделка сторон по рёбрам двух комнат — verified", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  setWallFinish(m, room, bottomEdge(m).pid, "wallpaper", {});
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => splitFirstRoom(norm, true, "two-rooms"));
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("96 R1: split — отделка стороны осталась одной частью в одной комнате — verified", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  setWallFinish(m, room, bottomEdge(m).pid, "wallpaper", {});
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => splitFirstRoom(norm, true, "one-room"));
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("96 R1: split без наследования пола — NORMALIZATION_DROPPED", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => splitFirstRoom(norm, false, "one-room"));
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED");
});

test("96 R1: merge двух комнат в одну — пол и отделка сохраняются, verified", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  setWallFinish(m, room, bottomEdge(m).pid, "wallpaper", {});
  // ожидание: две комнаты (как после split), у первой пол и отделка
  const rooms = (m.rooms2 ?? {}) as AnyRooms;
  const rec = rooms[room];
  const floors = structuredClone(rec["floors"]) as Array<Record<string, unknown>>;
  const decors = structuredClone(rec["decors"]) as Array<Record<string, unknown>>;
  delete rooms[room];
  const g1 = { polygon: [{ x: 150, y: -290 }, { x: 150, y: -10 }, { x: 10, y: -10 }, { x: 10, y: -290 }],
    edges: [{ p1: { x: 10, y: -290 }, p2: { x: 150, y: -290 }, pid: "w1", side: "r" }],
    floors, decors } as Record<string, unknown>;
  const g2 = { polygon: [{ x: 290, y: -290 }, { x: 290, y: -10 }, { x: 150, y: -10 }, { x: 150, y: -290 }],
    edges: [{ p1: { x: 150, y: -290 }, p2: { x: 290, y: -290 }, pid: "w1", side: "r" }],
    decors: [{ exist: false }] } as Record<string, unknown>;
  rooms["m1"] = g1;
  rooms["m2"] = g2;
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  // нормализация: комнаты объединены обратно в исходную, пол и отделка на месте
  const ws = saveMock(server, () => {}, (norm) => {
    const nr = normRooms(norm);
    delete nr["m1"]; delete nr["m2"];
    nr[room] = structuredClone(rec);
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("96 R1: комната с отделкой исчезла целиком — расхождение", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  const got = structuredClone((m.rooms2 ?? {}) as Record<string, Record<string, unknown>>) as Record<string, Record<string, unknown>>;
  const other = Object.keys(got).find((k) => k !== room)!;
  const kept: Record<string, Record<string, unknown>> = {};
  kept[other] = got[other]!;
  assert.ok(finishMismatches(m.rooms2, kept, m.walls as never).length > 0);
});

// ---------- R2: вся отделываемая область, без процентного порога ----------

test("96 R2: сервер сократил отделку стены до 90% без проёма — SITE_ERROR (не verified)", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setWallFinish(m, room, bottomEdge(m).pid, "wallpaper", {});
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const rooms = s.model["rooms2"] as AnyRooms;
    const p = Object.values((rooms[room]["decors"][bottomEdge(m).index] as Record<string, any>)["parts"])[0] as any;
    const line = p["line"] as { p1: { x: number; y: number }; p2: { x: number; y: number } };
    line.p2.x = line.p1.x + (line.p2.x - line.p1.x) * 0.9;
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: Error) => {
    return e instanceof McpError && e.code === "SITE_ERROR";
  });
});

test("96 R2: нормализация сократила отделку стены до 90% — NORMALIZATION_DROPPED", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setWallFinish(m, room, bottomEdge(m).pid, "wallpaper", {});
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const rooms = normRooms(norm);
    const p = Object.values((rooms[room]["decors"][bottomEdge(m).index] as Record<string, any>)["parts"])[0] as any;
    const line = p["line"] as { p1: { x: number; y: number }; p2: { x: number; y: number } };
    line.p2.x = line.p1.x + (line.p2.x - line.p1.x) * 0.9;
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED");
});

test("96 R2: прямая сверка — подрезка 5 см у конца допустима, 40 см и разрыв в середине без проёма — нет", () => {
  const exp = { r: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
    edges: [{ p1: { x: 0, y: 300 }, p2: { x: 400, y: 300 }, pid: "w1" }],
    decors: [{ exist: true, parts: { p: part("p", { x: 0, y: 300 }, { x: 400, y: 300 }) } }] } };
  const trimOk = structuredClone(exp);
  (Object.values(trimOk.r.decors[0]!.parts as Record<string, Record<string, unknown>>)[0]!["line"] as { p2: { x: number } }).p2.x = 395;
  assert.deepEqual(finishMismatches(exp, trimOk, { w1: { p1: { x: 0, y: 300 }, p2: { x: 400, y: 300 } } }), []);
  const trimBad = structuredClone(exp);
  (Object.values(trimBad.r.decors[0]!.parts as Record<string, Record<string, unknown>>)[0]!["line"] as { p2: { x: number } }).p2.x = 360;
  assert.ok(finishMismatches(exp, trimBad, { w1: { p1: { x: 0, y: 300 }, p2: { x: 400, y: 300 } } }).length > 0);
  const midGap = structuredClone(exp);
  const mp = Object.values(midGap.r.decors[0]!.parts as Record<string, Record<string, unknown>>)[0]!["line"] as { p2: { x: number } };
  mp.p2.x = 360;
  assert.ok(finishMismatches(exp, midGap, { w1: { p1: { x: 0, y: 300 }, p2: { x: 400, y: 300 } } }).length > 0);
});

// ---------- R3: штатная форма UI не блокирует ----------

test("96 R3: точный эталон ui-ref-finish-wall.json в normalize — verified", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  const be = bottomEdge(m);
  setWallFinish(m, room, be.pid, "wallpaper", {});
  const wallRef = JSON.parse(readFileSync("tests/fixtures/ui-ref-finish-wall.json", "utf8")) as { decors: Array<Record<string, unknown>> };
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const rooms = normRooms(norm);
    rooms[room]["decors"][be.index] = JSON.parse(JSON.stringify(wallRef.decors[0]));
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("96 R3: отделка 1..200 + 200..400 вместо 0..400 — verified (подрезка 1 см)", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setWallFinish(m, room, bottomEdge(m).pid, "wallpaper", {});
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const rooms = normRooms(norm);
    rooms[room]["decors"][bottomEdge(m).index] = { exist: true, parts: {
      a: part("a", { x: 11, y: -290 }, { x: 150, y: -290 }),
      b: part("b", { x: 150, y: -290 }, { x: 290, y: -290 }),
    } };
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("96 R3: разрыв 0..150 + 240..400 вокруг проёма 900 мм — verified", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  const be = bottomEdge(m);
  setWallFinish(m, room, be.pid, "wallpaper", {});
  // проём 90 см на оси стены w1 в месте разрыва (центр 205 см от оси стены)
  (m.walls as unknown as Record<string, Record<string, unknown>>)[be.pid]!["holes"] = {
    h1: { pc: { x: 205, y: -300 }, width: 90 },
  };
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const rooms = normRooms(norm);
    rooms[room]["decors"][be.index] = { exist: true, parts: {
      a: part("a", { x: 10, y: -290 }, { x: 160, y: -290 }),
      b: part("b", { x: 250, y: -290 }, { x: 290, y: -290 }),
    } };
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("96 R3: разрыв в середине без проёма — расхождение (не verified)", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setWallFinish(m, room, bottomEdge(m).pid, "wallpaper", {});
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const rooms = normRooms(norm);
    rooms[room]["decors"][bottomEdge(m).index] = { exist: true, parts: {
      a: part("a", { x: 10, y: -290 }, { x: 160, y: -290 }),
      b: part("b", { x: 250, y: -290 }, { x: 290, y: -290 }),
    } };
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED");
});

// ---------- R4: явно заданные параметры обязательны ----------

test("96 R4: исчезновение каждого явно заданного параметра пола в normalize — NORMALIZATION_DROPPED", async () => {
  for (const field of ["width", "height", "stitch_width", "angle", "type_laying"]) {
    const m = baseModel();
    const room = firstRoomId(m);
    setFloorFinish(m, room, "laminate", { plankLengthMm: 1200, plankWidthMm: 180, stitchWidthMm: 2, angleDeg: 45, typeLaying: "1/2" });
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server, () => {}, (norm) => {
      const rooms = normRooms(norm);
      delete (rooms[room]!["floors"][0] as Record<string, unknown>)[field];
    });
    await ws.open("0", "1");
    await assert.rejects(() => ws.save(), (e: Error) => {
      return e instanceof McpError && e.code === "NORMALIZATION_DROPPED";
    }, `поле ${field} исчезло, но save прошёл`);
  }
});

test("96 R4: все пользовательские параметры пола на месте — verified; производные не мешают", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", { plankLengthMm: 1200, plankWidthMm: 180, stitchWidthMm: 2, angleDeg: 45, typeLaying: "1/2" });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const rooms = normRooms(norm);
    const f = rooms[room]!["floors"][0] as Record<string, unknown>;
    f["polygons_layout"] = [[0, 1, 2, 3]];
    f["patch"] = 3;
    f["f0offset"] = 0;
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("96 R4: исчезновение level потолка — расхождение; profile standard может быть опущен (умолчание)", () => {
  const poly = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }];
  const exp = { r: { polygon: poly, ceilings: [{ exist: true, material: "paint_ceiling", level: 1, profile: "standard" }] } };
  const noLevel = { r: { polygon: poly, ceilings: [{ exist: true, material: "paint_ceiling", profile: "standard" }] } };
  assert.ok(finishMismatches(exp, noLevel).length > 0);
  const noProfile = { r: { polygon: poly, ceilings: [{ exist: true, material: "paint_ceiling", level: 1 }] } };
  assert.deepEqual(finishMismatches(exp, noProfile), []);
  const noMaterial = { r: { polygon: poly, ceilings: [{ exist: false }] } };
  assert.ok(finishMismatches(exp, noMaterial).length > 0);
});

test("96 R4: исчезновение height отделки стены — расхождение", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setWallFinish(m, room, bottomEdge(m).pid, "wallpaper", { heightMm: 1200 });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const rooms = normRooms(norm);
    const p = Object.values((rooms[room]["decors"][bottomEdge(m).index] as Record<string, any>)["parts"])[0] as any;
    delete p["height"];
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED");
});

// ---------- R5: применимость и диапазоны параметров ----------

test("96 R5: параметры не по материалу и вне диапазона — INVALID_ARGUMENT, модель не меняется", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  const wallId = Object.values(m.walls)[0]!.id;
  const before = JSON.stringify(m.rooms2);
  // раскладка не по материалу
  assert.throws(() => setFloorFinish(m, room, "linoleum", { typeLaying: "tile" }), /tile/);
  assert.throws(() => setFloorFinish(m, room, "floor_tile", { typeLaying: "1/2" }), /1\/2/);
  // длины и шов
  assert.throws(() => setFloorFinish(m, room, "laminate", { plankLengthMm: 0 }), /plank_length_mm/);
  assert.throws(() => setFloorFinish(m, room, "laminate", { plankWidthMm: -5 }), /plank_width_mm/);
  assert.throws(() => setFloorFinish(m, room, "laminate", { plankLengthMm: 20000 }), /plank_length_mm/);
  assert.throws(() => setFloorFinish(m, room, "laminate", { stitchWidthMm: -10 }), /stitch_width_mm/);
  assert.throws(() => setFloorFinish(m, room, "laminate", { stitchWidthMm: 200 }), /stitch_width_mm/);
  // стены
  assert.throws(() => setWallFinish(m, room, wallId, "wallpaper", { heightMm: -5 }), /height_mm/);
  assert.throws(() => setWallFinish(m, room, wallId, "wallpaper", { heightFromFloorMm: 999999 }), /height_from_floor_mm/);
  // потолок
  assert.throws(() => setCeilingFinish(m, room, "paint_ceiling", { level: -999 }), /level/);
  assert.throws(() => setCeilingFinish(m, room, "paint_ceiling", { level: 1.5 }), /level/);
  assert.throws(() => setCeilingFinish(m, room, "paint_ceiling", { profile: "arbitrary-catalog-key" }), /профиль/);
  assert.equal(JSON.stringify(m.rooms2), before);
});

test("96 R5: через inputSchema+handler MCP — недопустимые параметры отвергаются, корректные проходят", async () => {
  const { buildServer } = await import("../../src/server.ts");
  const { ServerContext } = await import("../../src/server/context.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const FIXTURE_RECT = new URL("../../tests/fixtures/anon-rect-4000x3000.json", import.meta.url).pathname;
  const ctx = new ServerContext({ offlineFixture: FIXTURE_RECT });
  const server = buildServer(ctx);
  const client = new Client({ name: "finish-review95", version: "0.0.0" });
  const [ta, tb] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(tb), client.connect(ta)]);
  const text = (r: { content?: { type: string; text?: string }[] }): string =>
    (r.content ?? []).map((c) => c.text ?? "").join("");
  try {
    // linoleum + type_laying=tile — не по материалу
    const bad1 = await client.callTool({ name: "finish_floor_set", arguments: { room_id: "R1", cover: "linoleum", type_laying: "tile" } });
    assert.ok(bad1.isError);
    assert.match(text(bad1 as never), /INVALID_ARGUMENT/);
    assert.match(text(bad1 as never), /tile/);
    // stitch_width_mm=-10 — вне диапазона
    const bad2 = await client.callTool({ name: "finish_floor_set", arguments: { room_id: "R1", cover: "laminate", stitch_width_mm: -10 } });
    assert.ok(bad2.isError);
    assert.match(text(bad2 as never), /INVALID_ARGUMENT/);
    // paint_ceiling + level=-999 и произвольный profile
    const bad3 = await client.callTool({ name: "finish_ceiling_set", arguments: { room_id: "R1", material: "paint_ceiling", level: -999 } });
    assert.ok(bad3.isError);
    assert.match(text(bad3 as never), /INVALID_ARGUMENT/);
    const bad4 = await client.callTool({ name: "finish_ceiling_set", arguments: { room_id: "R1", material: "paint_ceiling", profile: "arbitrary-catalog-key" } });
    assert.ok(bad4.isError);
    assert.match(text(bad4 as never), /INVALID_ARGUMENT/);
    // корректный вызов проходит и не меняет модель
    const good = await client.callTool({ name: "finish_floor_set", arguments: { room_id: "R1", cover: "laminate", plank_length_mm: 1200, type_laying: "1/2" } });
    assert.ok(!good.isError, text(good as never));
    assert.match(text(good as never), /floor_id/);
  } finally {
    await client.close();
  }
});

// ---------- R6: метки R<n> из полного списка до фильтрации ----------

test("96 R6: finish_get с фильтром сохраняет метку R<n> из полного списка; метка годится для следующего вызова", () => {
  const m = baseModel();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  const keys = Object.keys(rooms);
  assert.ok(keys.length >= 3, "в фикстуре минимум 3 комнаты");
  setFloorFinish(m, keys[1]!, "laminate", {});
  setCeilingFinish(m, keys[2]!, "paint_ceiling", {});
  const all = finishList(m);
  assert.equal(all[1]!["id"], "R2");
  assert.equal(all[2]!["id"], "R3");
  const byLabel = finishList(m, "R2");
  assert.equal(byLabel.length, 1);
  assert.equal(byLabel[0]!["id"], "R2", "метка после фильтрации — из полного списка");
  assert.equal(byLabel[0]!["site_id"], keys[1]);
  // цепочка: метка из ответа годится для следующего finish_* вызова
  const again = finishList(m, byLabel[0]!["id"] as string);
  assert.equal(again[0]!["site_id"], keys[1]);
  assert.equal(resolveRoom(m, byLabel[0]!["id"] as string).id, keys[1]);
});
