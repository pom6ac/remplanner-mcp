// 349 — фикс по ревью 348 (PR #52, отделка ч.9):
// - M1: finish_floor_set не стирает f0offset/anchor и прочие поля, которые
//   редактор сохраняет при смене покрытия (мутация записи in place, бандл
//   @3266628); полный путь через Workspace — краснеет без фикса;
//   фикс-2 (ревью 350, M1-R): панельные поля (width/height/stitch_width/
//   type_laying) при смене покрытия НЕ наследуются — в редакторе они из
//   настроек нового инструмента; переносятся только при том же покрытии;
// - M2: отметки пользовательских правок комнат (userEditedRooms) переживают
//   смену id комнаты редактором после wall_move (полный путь через Workspace
//   с mock-нормализатором, который перенумеровывает комнату); сырая правка
//   мимо инструментов и потеря имени на сервере по-прежнему ловятся;
//   фикс-2 (ревью 350, M2-R): при перенумерации отметки ДОПОЛНЯЮТСЯ
//   наследниками — цепочка rename → wall_move → undo → save проходит;
// - m2: номера зон — микрокомнаты и записи зон без is_class не нумеруются
//   (ROOMS2.draw, бандл @93695).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model } from "../../src/model/types.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import { McpError } from "../../src/errors.ts";
import type { LoadedModel } from "../../src/api.ts";
import { setFloorFinish, setFloorOffset, setFloorAnchor, removeFloorFinish } from "../../src/model/finish.ts";
import { setRoomName, zoneNumbersByEditorRule } from "../../src/model/room-fields.ts";
import { moveWall } from "../../src/model/walls.ts";

const CORRIDOR = new URL("../fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;

function corridorModel(): Model {
  return (JSON.parse(readFileSync(CORRIDOR, "utf8")) as { model: Model }).model;
}

function roomsOf(m: Model | Record<string, unknown>): Record<string, Record<string, unknown>> {
  return ((m as Record<string, unknown>)["rooms2"] ?? (m as Record<string, unknown>)["rooms1"] ?? {}) as Record<string, Record<string, unknown>>;
}

function floorOf(m: Model | Record<string, unknown>, room: string): Record<string, unknown> {
  return ((roomsOf(m)[room]!["floors"] as Array<Record<string, unknown>>))[0]!;
}

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

/** Mock save (как в review126): normalize — копия с возможной подменой (mock-редактор);
 *  save — запись и afterSave. */
function saveMock(
  server: SaveServer,
  afterSave: (s: SaveServer) => void,
  transformNorm?: (m: Record<string, unknown>) => void,
): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(m.walls as Record<string, unknown>).length;
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

// ---------- M2: mock-редактор перенумеровывает комнату ($Restorer.restore_rooms) ----------

let renumberSeq = 0;

/** Перенос стены w5 (ось x=300) редактором меняет контуры обеих смежных комнат. */
function rebuildRoomsNearW5(norm: Record<string, unknown>): void {
  const w5 = (norm["walls"] as Record<string, { p1: { x: number } }>)["w6"]!;
  const axis = w5.p1.x;
  for (const room of Object.values(roomsOf(norm))) {
    const poly = room["polygon"] as Array<{ x: number; y: number }> | undefined;
    if (!poly) continue;
    const xs = poly.map((p) => p.x);
    if (Math.abs(Math.max(...xs) - 290) < 1) {
      for (const p of poly) if (p.x > 200) p.x = axis - 10;
    } else if (Math.abs(Math.min(...xs) - 310) < 1) {
      for (const p of poly) if (p.x < 400) p.x = axis + 10;
    }
  }
}

function renumberFirstRoom(norm: Record<string, unknown>): string {
  const rooms = roomsOf(norm);
  const [oldId, room] = Object.entries(rooms)[0]!;
  const rec = structuredClone(room);
  rec["id"] = `_ren${++renumberSeq}`;
  const rest: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(rooms)) {
    if (k !== oldId) rest[k] = v;
  }
  rest[rec["id"] as string] = rec;
  (norm as { rooms2?: Record<string, unknown> })["rooms2"] = rest;
  return rec["id"] as string;
}

function firstRoomId(m: Model | Record<string, unknown>): string {
  const id = Object.keys(roomsOf(m))[0];
  assert.ok(id, "в фикстуре есть комната");
  return id!;
}

test("348 M2: room_set_name → wall_move (новый id комнаты) → save — без ложной блокировки, имя на сервере", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    rebuildRoomsNearW5(norm);
    renumberFirstRoom(norm);
  });
  await ws.open("0", "1");
  const rid = firstRoomId(m);
  // как настоящий обработчик room_set_name (tools-plan): apply + markRoomFieldEdited
  ws.apply("room_set_name", (mm) => setRoomName(mm, rid, "Кабинет"));
  ws.markRoomFieldEdited(rid);
  // стена переносится — редактор пересоздаёт комнату с новым id
  await ws.applyWalls("wall_move", (mm) => moveWall(mm, { wallId: "w6", offsetMm: -500 }));
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res.warnings));
  const after = roomsOf(server.model);
  const named = Object.values(after).find((r) => ((r["zones"] as Array<Record<string, unknown>>)[0]?.["name"]) === "Кабинет");
  assert.ok(named, "имя «Кабинет» сохранилось на сервере после перенумерации id");
});

test("348 M2: wall_move → room_set_name → save — без ложной блокировки", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    rebuildRoomsNearW5(norm);
    renumberFirstRoom(norm);
  });
  await ws.open("0", "1");
  await ws.applyWalls("wall_move", (mm) => moveWall(mm, { wallId: "w6", offsetMm: -500 }));
  const newId = firstRoomId(ws.model);
  assert.notEqual(newId, firstRoomId(m), "mock-редактор перенумеровал комнату");
  ws.apply("room_set_name", (mm) => setRoomName(mm, newId, "Кабинет"));
  ws.markRoomFieldEdited(newId);
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res.warnings));
  const after = roomsOf(server.model);
  const named = Object.values(after).find((r) => ((r["zones"] as Array<Record<string, unknown>>)[0]?.["name"]) === "Кабинет");
  assert.ok(named, "имя сохранилось на сервере");
});

test("348 M2: сырая правка имени мимо инструментов по-прежнему ловится (NORMALIZATION_DROPPED)", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  ws.apply("raw_edit", (mm) => {
    ((roomsOf(mm)[firstRoomId(mm)]!["zones"] as Array<Record<string, unknown>>)[0]!)["name"] = "Хак";
  });
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "NORMALIZATION_DROPPED");
    const details = (e as { details?: { room_mismatches?: string[] } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("Хак")), JSON.stringify(details));
    return true;
  });
});


test("348 M2: потеря имени на сервере после save — SITE_ERROR (verified=false)", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const room = roomsOf(s.model)[firstRoomId(s.model)]!;
    ((room["zones"] as Array<Record<string, unknown>>)[0]!)["name"] = "none";
  });
  await ws.open("0", "1");
  const rid = firstRoomId(m);
  ws.apply("room_set_name", (mm) => setRoomName(mm, rid, "Кабинет"));
  ws.markRoomFieldEdited(rid);
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { room_mismatches?: string[] } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("Кабинет")), JSON.stringify(details));
    return true;
  });
});

// ---------- M2-R 350: отметки дополняются наследниками (undo/redo) ----------

test("350 M2-R: rename → wall_move (новый id) → undo → save без ложной NORMALIZATION_DROPPED", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    rebuildRoomsNearW5(norm);
    renumberFirstRoom(norm); // редактор перенумеровывает комнату при каждой нормализации
  });
  await ws.open("0", "1");
  const rid = firstRoomId(m);
  ws.apply("room_set_name", (mm) => setRoomName(mm, rid, "Кабинет"));
  ws.markRoomFieldEdited(rid);
  await ws.applyWalls("wall_move", (mm) => moveWall(mm, { wallId: "w6", offsetMm: -500 }));
  // M2-R: отметки ДОПОЛНЯЮТСЯ наследником, прежний id не выбрасывается
  assert.ok(ws.roomFieldEditedRooms().has(rid), "отметка прежнего id сохранена");
  assert.ok(ws.roomFieldEditedRooms().size >= 2, "наследник добавлен к отметкам");
  ws.undo(1);
  assert.equal(firstRoomId(ws.model), rid, "undo вернул прежний id комнаты");
  // без фикса отметки заменяются {movedId}, и save отклоняется ложным
  // NORMALIZATION_DROPPED — тест краснеет здесь
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res.warnings));
  const after = roomsOf(server.model);
  const named = Object.values(after).find((r) => ((r["zones"] as Array<Record<string, unknown>>)[0]?.["name"]) === "Кабинет");
  assert.ok(named, "имя «Кабинет» дошло до сервера после undo");
});

test("350 M2-R: rename → wall_move → undo → redo → повторный wall_move → save — отметки переживают", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    rebuildRoomsNearW5(norm);
    renumberFirstRoom(norm);
  });
  await ws.open("0", "1");
  const rid = firstRoomId(m);
  ws.apply("room_set_name", (mm) => setRoomName(mm, rid, "Кабинет"));
  ws.markRoomFieldEdited(rid);
  await ws.applyWalls("wall_move", (mm) => moveWall(mm, { wallId: "w6", offsetMm: -500 }));
  ws.undo(1);
  ws.redo(1);
  // повторный wall_move — редактор перенумеровывает комнату снова
  await ws.applyWalls("wall_move", (mm) => moveWall(mm, { wallId: "w6", offsetMm: 500 }));
  assert.ok(ws.roomFieldEditedRooms().has(rid), "отметка прежнего id не вытеснена перенумерациями");
  assert.ok(ws.roomFieldEditedRooms().size >= 2, "наследники добавлены к отметкам");
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res.warnings));
  const after = roomsOf(server.model);
  const named = Object.values(after).find((r) => ((r["zones"] as Array<Record<string, unknown>>)[0]?.["name"]) === "Кабинет");
  assert.ok(named, "имя «Кабинет» дошло до сервера после undo/redo и повторного wall_move");
});

// ---------- M1: finish_floor_set сохраняет f0offset/anchor и поля редактора ----------

test("348 M1: смена покрытия пола переносит f0offset/anchor/angle/custom_angle/id; панельные поля — умолчания нового покрытия (M1-R)", () => {
  const m = corridorModel();
  const rid = firstRoomId(m);
  setFloorFinish(m, rid, "laminate", { plankLengthMm: 1200, plankWidthMm: 180, stitchWidthMm: 2, typeLaying: "1/2" });
  const first = floorOf(m, rid);
  const firstId = first["id"];
  setFloorOffset(m, rid, 300);
  // угол с якорем (контекстное меню #cm-floor-anchor--angle): angle=30, custom_angle=1
  setFloorAnchor(m, rid, { x: 1500, y: -1500 }, 30);
  // смена покрытия — как клик другого материала в редакторе: запись мутируется,
  // f0offset/anchor/angle/custom_angle/id остаются
  setFloorFinish(m, rid, "parquet", {});
  const f0 = floorOf(m, rid);
  assert.equal(f0["cover"], "parquet");
  assert.equal(f0["f0offset"], 30, "подъём пола пережил смену покрытия");
  assert.deepEqual(f0["anchor"], { p: { x: 150, y: -150 } }, "точка укладки пережила смену покрытия");
  assert.equal(f0["angle"], 30, "угол не сбрасывается сменой покрытия (сбрасывает только anchor_floor)");
  assert.equal(f0["custom_angle"], 1);
  assert.equal(f0["id"], firstId, "id записи редактор не меняет (мутация in place)");
  // M1-R ревью 350: панельные поля при смене покрытия НЕ наследуются —
  // в редакторе они из настроек нового инструмента (@3413380 tools[tool] →
  // placeholder @3415531 → клик @3266628), width/height остаются конструктору
  // Floor (умолчания нового покрытия); без фикса тест краснеет здесь
  assert.equal(f0["width"], undefined, "размер плашки не переносится с прежнего покрытия");
  assert.equal(f0["height"], undefined);
  assert.equal(f0["stitch_width"], undefined);
  assert.equal(f0["type_laying"], undefined);
  assert.equal(f0["polygons_layout"], undefined, "раскладка не переносится (редактор сбрасывает)");
  // явные параметры перезаписывают
  setFloorFinish(m, rid, "floor_tile", { plankLengthMm: 600, typeLaying: "tile" });
  const f1 = floorOf(m, rid);
  assert.equal(f1["width"], 60);
  assert.equal(f1["type_laying"], "tile");
  assert.equal(f1["height"], undefined);
  assert.equal(f1["stitch_width"], undefined);
  assert.equal(f1["f0offset"], 30, "подъём не сброшен");
  // снятие покрытия сбрасывает подъём и якорь (ластик редактора), id записи сохраняется (n1-R)
  removeFloorFinish(m, rid);
  const f2 = floorOf(m, rid);
  assert.equal(f2["f0offset"], undefined);
  assert.equal(f2["anchor"], undefined);
  assert.equal(f2["exist"], false);
  assert.equal(f2["id"], firstId, "ластик редактора сохраняет id записи (Floor.delete)");
});

test("350 M1-R: смена покрытия без параметров — панельные поля прежнего покрытия не наследуются (tile 400×400 → laminate)", () => {
  const m = corridorModel();
  const rid = firstRoomId(m);
  setFloorFinish(m, rid, "floor_tile", { typeLaying: "tile", plankLengthMm: 400, plankWidthMm: 400, stitchWidthMm: 3 });
  setFloorFinish(m, rid, "laminate", {});
  const f = floorOf(m, rid);
  assert.equal(f["cover"], "laminate");
  assert.equal(f["type_laying"], undefined, "раскладка «tile» не наследуется ламинатом");
  assert.equal(f["width"], undefined, "размер плитки не наследуется ламинатом");
  assert.equal(f["height"], undefined);
  assert.equal(f["stitch_width"], undefined);
  // явный typeLaying:'tile' для laminate — INVALID_ARGUMENT, унаследованным быть не может
  assert.throws(() => setFloorFinish(m, rid, "laminate", { typeLaying: "tile" }), /tile/);
});

test("350 M1-R (m1): тот же материал — поля записи сохраняются; новые размеры перезаписывают только заданное", () => {
  const m = corridorModel();
  const rid = firstRoomId(m);
  setFloorFinish(m, rid, "laminate", { plankLengthMm: 1200, plankWidthMm: 180, stitchWidthMm: 2, typeLaying: "1/2" });
  setFloorOffset(m, rid, 300);
  setFloorAnchor(m, rid, { x: 1500, y: -1500 }, 30);
  const firstId = floorOf(m, rid)["id"];
  // тот же материал без параметров — поля сохраняются (панель редактора не тронута)
  setFloorFinish(m, rid, "laminate", {});
  const f = floorOf(m, rid);
  assert.equal(f["width"], 120);
  assert.equal(f["height"], 18);
  assert.equal(f["stitch_width"], 0.2);
  assert.equal(f["type_laying"], "1/2");
  assert.equal(f["f0offset"], 30);
  assert.deepEqual(f["anchor"], { p: { x: 150, y: -150 } });
  assert.equal(f["angle"], 30);
  assert.equal(f["custom_angle"], 1);
  // тот же материал, новый размер: явное перезаписывает, незаданное переносится
  setFloorFinish(m, rid, "laminate", { plankLengthMm: 900 });
  const f2 = floorOf(m, rid);
  assert.equal(f2["width"], 90);
  assert.equal(f2["height"], 18, "незаданная высота перенесена (тот же материал)");
  assert.equal(f2["stitch_width"], 0.2);
  assert.equal(f2["type_laying"], "1/2");
  assert.equal(f2["id"], firstId, "id записи сохраняется");
});

test("348 M1: полный путь через Workspace — offset → anchor → смена покрытия → save verified, поля на сервере", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const rid = firstRoomId(m);
  ws.apply("finish_floor_set", (mm) => setFloorFinish(mm, rid, "laminate", { plankLengthMm: 1200, plankWidthMm: 180 }));
  ws.apply("finish_floor_offset_set", (mm) => setFloorOffset(mm, rid, 300));
  ws.apply("finish_floor_anchor_set", (mm) => setFloorAnchor(mm, rid, { x: 1500, y: -1500 }));
  ws.apply("finish_floor_set", (mm) => setFloorFinish(mm, rid, "parquet", {}));
  const f0 = floorOf(ws.model, rid);
  assert.equal(f0["f0offset"], 30, "без фикса поля стираются молча — тест краснеет здесь");
  assert.ok(f0["anchor"]);
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res.warnings));
  const onServer = floorOf(server.model, rid);
  assert.equal(onServer["f0offset"], 30, "подъём дошёл до сервера");
  assert.ok(onServer["anchor"], "точка укладки дошла до сервера");
  assert.equal(onServer["cover"], "parquet");
});

test("348 M1: нормализатор потерял f0offset — NORMALIZATION_DROPPED (сверка ловит потерю)", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const f = floorOf(norm, firstRoomId(norm));
    delete f["f0offset"];
  });
  await ws.open("0", "1");
  const rid = firstRoomId(m);
  ws.apply("finish_floor_set", (mm) => setFloorFinish(mm, rid, "laminate", {}));
  ws.apply("finish_floor_offset_set", (mm) => setFloorOffset(mm, rid, 300));
  ws.apply("finish_floor_set", (mm) => setFloorFinish(mm, rid, "parquet", {}));
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "NORMALIZATION_DROPPED");
    const details = (e as { details?: { finish_mismatches?: string[] } }).details;
    assert.ok((details?.finish_mismatches ?? []).some((x) => x.includes("f0")), JSON.stringify(details));
    return true;
  });
});

// ---------- m2: нумерация зон — микрокомнаты и записи без is_class ----------

test("348 m2: микрокомнаты (< 1 м² без проёмов) и зоны без is_class не нумеруются (ROOMS2.draw)", () => {
  const m = corridorModel();
  const rooms = roomsOf(m);
  rooms["micro"] = {
    id: "micro", role: "room", name: "none", area: 0.5,
    polygon: [{ x: 900, y: 0 }, { x: 950, y: 0 }, { x: 950, y: 100 }, { x: 900, y: 100 }],
    zones: [{ id: "z1", name: "none", is_micro_zone: 0, area: 0.5 }],
  } as never;
  rooms["micro-with-door"] = {
    id: "micro-with-door", role: "room", name: "none", area: 0.5,
    holes_polygons: { h1: [{}] },
    polygon: [{ x: 1000, y: 0 }, { x: 1050, y: 0 }, { x: 1050, y: 100 }, { x: 1000, y: 100 }],
    zones: [{ id: "z2", name: "none", is_micro_zone: 0, area: 0.5 }],
  } as never;
  rooms["noclass"] = {
    id: "noclass", role: "room", name: "none", area: 20,
    polygon: [{ x: 1100, y: 0 }, { x: 1200, y: 0 }, { x: 1100, y: 100 }, { x: 1000, y: 100 }],
    zones: [
      { id: "z3", name: "Кладовка", is_micro_zone: 0, is_class: false, area: 5 },
      { id: "z4", name: "Зал", is_micro_zone: 0, area: 15 },
    ],
  } as never;
  const nums = zoneNumbersByEditorRule(m);
  assert.equal(nums.get("micro"), undefined, "микрокомната без проёмов не нумеруется");
  assert.ok(nums.get("micro-with-door")?.get(0), "микрокомната с проёмом нумеруется (не isMicroRoom)");
  assert.equal(nums.get("noclass")?.get(0), undefined, "зона без is_class не нумеруется");
  assert.equal(nums.get("noclass")?.get(1), 1, "зона с классом нумеруется");
});
