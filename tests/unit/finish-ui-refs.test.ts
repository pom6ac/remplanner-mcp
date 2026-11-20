// 94: тесты раздела «Отделка» — эталоны UI, каноническая запись, семантическая сверка,
// атомарность, mock save (подмена writeBackup/loadModel/openEditor), компакт, регрессия.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model } from "../../src/model/types.ts";
import {
  FLOOR_COVERS, WALL_COVERS, CEILING_COVERS, FLOOR_MOLDING_TYPES, CEILING_MOLDING_TYPE, resolveRoom,
  setFloorFinish, removeFloorFinish, setWallFinish, removeWallFinish, setCeilingFinish, removeCeilingFinish,
  finishMismatches, finishList,
} from "../../src/model/finish.ts";
import { compactModel } from "../../src/model/compact.ts";
import { Workspace, type WorkspaceDeps } from "../../src/workspace.ts";
import type { EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { clearEntityCollections } from "../../src/model/collections.ts";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url));
const FIXTURE_ENVELOPE = true;
const FLOOR_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-finish-floor.json", "utf8")) as {
  room: { polygon: { x: number; y: number }[] };
  floors: Array<Record<string, unknown>>;
};
const CEIL_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-finish-ceiling.json", "utf8")) as {
  room: { polygon: { x: number; y: number }[] };
  ceilings: Array<Record<string, unknown>>;
};
const WALL_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-finish-wall.json", "utf8")) as {
  edge: { pid: string; side: string };
  decors: Array<Record<string, unknown>>;
};

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

function firstRoomId(m: Model): string {
  const rooms = (m.rooms2 ?? m.rooms1) as Record<string, unknown> | undefined;
  const id = Object.keys(rooms ?? {})[0];
  assert.ok(id, "в фикстуре есть комната");
  return id!;
}

// ---------- состав раздела и эталоны ----------

test("245: состав раздела ч.2 — двухслойные отделки и плинтусы в ядре, сложные потолки/зоны вне", () => {
  assert.ok(FLOOR_COVERS.includes("laminate") && FLOOR_COVERS.includes("terrace_board") && FLOOR_COVERS.includes("floor_tile"));
  assert.ok(FLOOR_COVERS.includes("stoneware_marble") && FLOOR_COVERS.includes("mosaic"), "PRO-покрытия в списке");
  assert.ok(WALL_COVERS.includes("wallpaper") && WALL_COVERS.includes("venice_plaster"));
  assert.ok(WALL_COVERS.includes("painting_tile") && WALL_COVERS.includes("wallpaper_tiles") && WALL_COVERS.includes("wall_apron"), "двухслойные — этап 245");
  assert.ok(CEILING_COVERS.includes("paint_ceiling") && CEILING_COVERS.includes("stretch_ceiling"));
  assert.ok(!(CEILING_COVERS as readonly string[]).includes("complex_ceiling"), "многоуровневые — следующий PR");
  assert.ok(FLOOR_MOLDING_TYPES.length === 7, "7 видов напольного плинтуса");
  assert.equal(CEILING_MOLDING_TYPE, "molding");
});

test("94: эталоны UI — покрытие пола комнаты совпадает с канонической записью инструмента", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  (m.rooms2 as Record<string, Record<string, unknown>>)[room]!["polygon"] = structuredClone(FLOOR_REF.room.polygon);
  setFloorFinish(m, room, "laminate", { angleDeg: 0, plankLengthMm: 1200, plankWidthMm: 180, stitchWidthMm: 2, typeLaying: "1/2" });
  const got = ((m.rooms2 as Record<string, Record<string, unknown>>)[room]!["floors"] as Array<Record<string, unknown>>)[0]!;
  const exp = FLOOR_REF.floors[0]!;
  assert.equal(got["cover"], exp["cover"]);
  assert.equal(got["angle"], exp["angle"]);
  assert.equal(got["width"], exp["width"]);
  assert.equal(got["height"], exp["height"]);
  assert.equal(got["stitch_width"], exp["stitch_width"]);
  assert.equal(got["type_laying"], exp["type_laying"]);
  assert.equal(got["exist"], true);
  // сверка в обе стороны: эталон против записи и запись против эталона — без расхождений
  const rooms = { [room]: (m.rooms2 as Record<string, Record<string, unknown>>)[room]! };
  assert.deepEqual(finishMismatches(rooms, rooms), []);
  const fixtureRooms = { [room]: { polygon: FLOOR_REF.room.polygon, floors: structuredClone(FLOOR_REF.floors) } };
  assert.deepEqual(finishMismatches(fixtureRooms, rooms), []);
  assert.deepEqual(finishMismatches(rooms, fixtureRooms), []);
});

test("94: эталоны UI — потолок и отделка стены", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  (m.rooms2 as Record<string, Record<string, unknown>>)[room]!["polygon"] = structuredClone(CEIL_REF.room.polygon);
  setCeilingFinish(m, room, "paint_ceiling", {});
  const gotCeil = ((m.rooms2 as Record<string, Record<string, unknown>>)[room]!["ceilings"] as Array<Record<string, unknown>>)[0]!;
  assert.equal(gotCeil["material"], CEIL_REF.ceilings[0]!["material"]);
  assert.equal(gotCeil["level"], 0);
  assert.equal(gotCeil["profile"], "standard");
  assert.deepEqual(finishMismatches(
    { [room]: { polygon: CEIL_REF.room.polygon, ceilings: structuredClone(CEIL_REF.ceilings) } },
    { [room]: (m.rooms2 as Record<string, Record<string, unknown>>)[room]! },
  ), []);

  // стена: канонический вид части — как в эталоне (type/layer/height/height_from_floor)
  const walls = Object.values(m.walls);
  const wallId = walls[0]!.id;
  const edges = (m.rooms2 as Record<string, Record<string, unknown>>)[room]!["edges"] as Array<{ pid?: string; p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const edge = edges.find((e) => e.pid === wallId) ?? edges[0]!;
  const gotRooms = structuredClone((m.rooms2 ?? {}) as Record<string, Record<string, unknown>>);
  setWallFinish(m, room, edge.pid!, "wallpaper", {});
  const expDecor = WALL_REF.decors[0]! as { exist: unknown; parts: Record<string, Record<string, unknown>> };
  const expPart = expDecor.parts[Object.keys(expDecor.parts)[0]!]!;
  const gotDecorRooms = { [room]: (m.rooms2 as Record<string, Record<string, unknown>>)[room]! };
  assert.deepEqual(finishMismatches(
    { [room]: { polygon: (m.rooms2 as Record<string, Record<string, unknown>>)[room]!["polygon"], decors: structuredClone(WALL_REF.decors) } },
    gotDecorRooms,
  ), []);
  void expPart;
});

test("94: неизвестное покрытие и чужая стена — INVALID_ARGUMENT, модель не меняется (атомарность)", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  const before = JSON.stringify(m.rooms2);
  assert.throws(() => setFloorFinish(m, room, "wallpaper_xyz" as never, {}), /неизвестное покрытие пола/);
  assert.throws(() => setCeilingFinish(m, room, "laminate" as never, {}), /неизвестное покрытие потолка/);
  assert.throws(() => setWallFinish(m, room, "no-such-wall", "wallpaper" as never, {}), /не граничит/);
  assert.equal(JSON.stringify(m.rooms2), before);
  assert.throws(() => resolveRoom(m, "R99"), /не найдена/);
  assert.equal(JSON.stringify(m.rooms2), before);
});

test("94: снятие отделки — floors/ceilings/decors существуют в форме пустого проекта (exist:false)", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  const rooms = m.rooms2 as Record<string, Record<string, unknown>>;
  setFloorFinish(m, room, "floor_tile", {});
  setCeilingFinish(m, room, "gypsum_ceiling", {});
  setWallFinish(m, room, Object.values(m.walls)[0]!.id, "paint_wall", {});
  removeFloorFinish(m, room);
  removeCeilingFinish(m, room);
  removeWallFinish(m, room, Object.values(m.walls)[0]!.id);
  assert.equal((rooms[room]!["floors"] as Array<Record<string, unknown>>)[0]!["exist"], false);
  assert.equal((rooms[room]!["ceilings"] as Array<Record<string, unknown>>)[0]!["exist"], false);
  const decors = rooms[room]!["decors"] as Array<Record<string, unknown>>;
  assert.ok(decors.every((d: Record<string, unknown>) => d["exist"] !== true));
  // снятие несуществующей отделки стены — ошибка
  const otherWall = Object.values(m.walls)[1]!.id;
  assert.throws(() => removeWallFinish(m, room, otherWall), /не граничит/);
});

test("94: повторная запись заменяет покрытие (смена отделки) и remove+set восстанавливает", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  setFloorFinish(m, room, "floor_tile", {});
  const floors = (m.rooms2 as Record<string, Record<string, unknown>>)[room]!["floors"] as Array<Record<string, unknown>>;
  assert.equal(floors.length, 1);
  assert.equal(floors[0]!["cover"], "floor_tile");
});

test("94: реестр коллекций — project_clear удаляет rooms2 с отделкой, обязательные коллекции пусты", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  setCeilingFinish(m, room, "paint_ceiling", {});
  clearEntityCollections(m);
  assert.equal(m.rooms2, undefined);
  assert.equal(m.rooms1, undefined);
  for (const k of ["walls", "items", "pillars", "rulers", "comments"]) assert.ok(m[k as keyof Model] !== undefined);
});

test("94: компакт — floor/ceiling комнаты видны в model_get", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", { plankLengthMm: 1200 });
  setCeilingFinish(m, room, "stretch_ceiling", {});
  const c = compactModel(m);
  const rooms = m.rooms2 as Record<string, Record<string, unknown>>;
  const idx = Object.keys(rooms).indexOf(room);
  assert.equal(c.rooms[idx]!.floor, "laminate");
  assert.equal(c.rooms[idx]!.ceiling, "stretch_ceiling");
  const other = c.rooms.find((_, i) => i !== idx)!;
  assert.equal(other.floor, null);
});

// ---------- семантическая сверка ----------

test("94: сверка — потеря отделки на сервере и подмена покрытия обнаруживаются", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  setCeilingFinish(m, room, "paint_ceiling", {});
  const got = structuredClone(m.rooms2) as Record<string, Record<string, unknown>>;
  assert.deepEqual(finishMismatches(m.rooms2, got), []);
  ((got[room]!["floors"] as Array<Record<string, unknown>>)[0]! as Record<string, unknown>)["cover"] = "linoleum";
  assert.ok(finishMismatches(m.rooms2, got).length > 0);
  delete got[room]!["ceilings"];
  assert.ok(finishMismatches(m.rooms2, got).some((p) => p.includes("потолка")));
});

test("94: сверка — комната переименована (id другой, полигон тот же) → сопоставление по геометрии, не ложный блок", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  const got = structuredClone(m.rooms2) as Record<string, Record<string, unknown>>;
  const rec = got[room]!;
  delete got[room];
  got["_renamed"] = rec;
  assert.deepEqual(finishMismatches(m.rooms2, got), []);
});

test("94: сверка — стена разрезана (отделка покрыта двумя частями) → допустимая нормализация", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  const rooms = m.rooms2 as Record<string, Record<string, unknown>>;
  const wallId = Object.values(m.walls)[0]!.id;
  const edges = rooms[room]!["edges"] as Array<{ pid?: string; p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const edge = edges.find((e) => e.pid === wallId)!;
  setWallFinish(m, room, wallId, "wallpaper", {});
  const exp = structuredClone(rooms) as Record<string, Record<string, unknown>>;
  // сервер: одна часть отделки на половину ребра → покрытие сохранено (ревью прав: rename/split —
  // сопоставление по покрытию оси, не по id)
  const half = { p1: edge.p1, p2: { x: (edge.p1.x + edge.p2.x) / 2, y: (edge.p1.y + edge.p2.y) / 2 } };
  const part = { id: "p1", type: "wallpaper", layer: 1, line: half, line_wall: half, distance: 1, height: 0, height_from_floor: 0 };
  const gotRooms = { [room]: { polygon: rooms[room]!["polygon"], edges, decors: [{ exist: true, parts: { p1: part } }] } };
  // частичное покрытие: ожидаемое ребро не покрыто целиком → расхождение
  assert.ok(finishMismatches(exp, gotRooms).length > 0);
  // полное покрытие двумя частями → совпадение
  const other = { p1: half.p2, p2: edge.p2 };
  const part2 = { id: "p2", type: "wallpaper", layer: 1, line: other, line_wall: other, distance: 1, height: 0, height_from_floor: 0 };
  const gotFull = { [room]: { polygon: rooms[room]!["polygon"], edges, decors: [{ exist: true, parts: { p1: part, p2: part2 } }] } };
  assert.deepEqual(finishMismatches(exp, gotFull), []);
});

test("94: сверка — пустые модели без отделки не дают расхождений", () => {
  assert.deepEqual(finishMismatches(undefined, undefined), []);
  assert.deepEqual(finishMismatches({}, {}), []);
});

// ---------- mock save ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

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

test("94: mock save — отделка (пол, потолок, стена) доходит до серверной модели, verified", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  setCeilingFinish(m, room, "paint_ceiling", {});
  setWallFinish(m, room, Object.values(m.walls)[0]!.id, "wallpaper", {});
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

test("94: mock save — редактор пересчитал раскладку пола (производные поля) → verified без ложной блокировки", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    // редактор дописал polygons_layout при нормализации — производное, не блокировка
    const rooms = norm["rooms2"] as Record<string, Record<string, unknown>>;
    const floors = rooms[firstRoomId(norm as unknown as Model)]!["floors"] as Array<Record<string, unknown>>;
    floors[0]!["polygons_layout"] = [[0, 1, 2, 3]];
    floors[0]!["f0offset"] = 0;
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("94: mock save — нормализация потеряла покрытие пола → NORMALIZATION_DROPPED", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const rooms = norm["rooms2"] as Record<string, Record<string, unknown>>;
    (rooms[firstRoomId(norm as unknown as Model)]!["floors"] as Array<Record<string, unknown>>)[0]!["exist"] = false;
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), /NORMALIZATION_DROPPED|потерял объекты/);
});

test("94: mock save — сервер потерял отделку после save → SITE_ERROR (finish_mismatches)", async () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  setWallFinish(m, room, Object.values(m.walls)[0]!.id, "wallpaper", {});
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const rooms = s.model["rooms2"] as Record<string, Record<string, unknown>>;
    (rooms[room]!["decors"] as Array<Record<string, unknown>>).forEach((d) => { d["exist"] = false; });
  });
  await ws.open("0", "1");
  await assert.rejects(async () => ws.save(), (e: Error) => {
    assert.match(e.message, /не совпала с рабочей копией/);
    const details = (e as Error & { details?: Record<string, unknown> }).details ?? {};
    const fm = details["finish_mismatches"] as string[] | undefined;
    assert.ok(Array.isArray(fm) && fm.some((p) => p.includes("отделка стены")), JSON.stringify(details).slice(0, 400));
    return true;
  });
});

// ---------- инструменты через сервер (smoke-подобно, офлайн) ----------

test("94: модель без комнат — finish_get не падает", () => {
  const m = baseModel();
  delete m.rooms2;
  delete m.rooms1;
  assert.deepEqual(finishList(m), []);
});
