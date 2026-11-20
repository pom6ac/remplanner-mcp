// Ревью 127 (этап 128): резолюция находок R1/R2/R4 — сравнение комнат в normalize
// с базой ДО пользовательской операции (модель с сервера / после последнего успешного
// save), а не с локальной моделью после операции.
// - R1: штатное размыкание контура пользователем — исчезновение затронутой комнаты
//   допустимо (предупреждение), как на main;
// - R2: новая комната из изменённых пользователем стен допустима; «лишняя» комната
//   без связи с изменёнными стенами — NORMALIZATION_DROPPED;
// - R4: потеря НЕзатронутой комнаты внутри applyWalls — атомарный отказ.
// Mock save — подмена writeBackup/loadModel/openEditor (new-entity-section.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "../../src/model/types.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import { McpError } from "../../src/errors.ts";
import type { LoadedModel } from "../../src/api.ts";
import { addRoomRect, addWall, deleteWall, moveWall } from "../../src/model/walls.ts";
import { affectedRoomIds, changedWallSegments, roomPolygonCm } from "../../src/model/rooms-save.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CORRIDOR = fileURLToPath(new URL("../fixtures/editor-corridor-3rooms.json", import.meta.url));
const ANON_RECT = fileURLToPath(new URL("../fixtures/anon-rect-4000x3000.json", import.meta.url));

function corridorModel(): Model {
  return (JSON.parse(readFileSync(CORRIDOR, "utf8")) as { model: Model }).model;
}

function anonRectModel(): Model {
  return (JSON.parse(readFileSync(ANON_RECT, "utf8")) as { model: Model }).model;
}

function roomsOf(m: Model | Record<string, unknown>): Record<string, Record<string, unknown>> {
  return ((m as Record<string, unknown>)["rooms2"] ?? (m as Record<string, unknown>)["rooms1"] ?? {}) as Record<string, Record<string, unknown>>;
}

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

/** Mock save: normalize — копия с возможной подменой; save — запись и afterSave. */
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

// ---------- R1: размыкание контура пользователем — не блокировка ----------

test("128 R1: deleteWall размыкает контур (offline) — save verified, комната исчезла допустимо", async () => {
  const m = anonRectModel();
  const wallId = Object.values(m.walls).find((w) => !Object.keys(w.holes ?? {}).length)!.id!;
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (norm) => {
    // штатная нормализация редактора: разомкнутый контур — комнаты убраны
    delete (norm as { rooms2?: Record<string, unknown> }).rooms2;
    (norm as { rooms2?: Record<string, unknown> }).rooms2 = {};
  });
  (ws as unknown as { offline: boolean }).offline = true;
  await ws.open("0", "1");
  await ws.applyWalls("wall_delete", (mm) => {
    deleteWall(mm, wallId);
  });
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(saves, 1);
  assert.ok(res.warnings.some((w) => w.includes("room_topology_changed")), JSON.stringify(res.warnings));
});

test("128 R1: размыкание через applyWalls с редактором — комната затронута, applyWalls не блокирует", async () => {
  const m = anonRectModel();
  const wallId = Object.values(m.walls).find((w) => !Object.keys(w.holes ?? {}).length)!.id!;
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    delete (norm as { rooms2?: Record<string, unknown> }).rooms2;
    (norm as { rooms2?: Record<string, unknown> }).rooms2 = {};
  });
  await ws.open("0", "1");
  const res = await ws.applyWalls("wall_delete", (mm) => {
    deleteWall(mm, wallId);
  });
  assert.ok(res.warnings.some((w) => w.includes("room_topology_changed")), JSON.stringify(res.warnings));
  await ws.save();
});

// ---------- R2: новая комната из изменённых стен допустима ----------

test("128 R2: первая комната пустого проекта (offline addRoomRect) — save verified", async () => {
  const server: SaveServer = { saveId: "s1", model: { walls: {}, items: {}, pillars: {}, rooms2: {} } };
  const ws = saveMock(server, () => {}, (norm) => {
    (norm as { rooms2?: Record<string, unknown> }).rooms2 = {
      new: {
        polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
        name: "none",
        zones: [{ name: "none" }],
      },
    };
  });
  (ws as unknown as { offline: boolean }).offline = true;
  await ws.open("0", "1");
  await ws.applyWalls("room_add_rect", (mm) => {
    addRoomRect(mm as Model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  });
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.ok(res.warnings.some((w) => w.includes("room_new_from_walls")), JSON.stringify(res.warnings));
});

test("128 R2: новая отдельная комната из добавленных стен — save verified", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const rooms = roomsOf(norm);
    rooms["separate"] = {
      polygon: [{ x: 5000, y: 5000 }, { x: 5400, y: 5000 }, { x: 5400, y: 5300 }, { x: 5000, y: 5300 }],
      name: "none",
      zones: [{ name: "none" }],
    };
  });
  (ws as unknown as { offline: boolean }).offline = true;
  await ws.open("0", "1");
  await ws.applyWalls("room_add_rect", (mm) => {
    addRoomRect(mm as Model, { origin: { x: 50000, y: 50000 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  });
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.ok(res.warnings.some((w) => w.includes("room_new_from_walls")), JSON.stringify(res.warnings));
});

test("128 R2: замыкание ранее открытого контура — save verified", async () => {
  const m = anonRectModel();
  // база: контур разомкнут ранее (стены 3, комнат нет)
  const openWall = Object.values(m.walls).find((w) => !Object.keys(w.holes ?? {}).length)!;
  delete (m.walls as Record<string, unknown>)[openWall.id!];
  (m as unknown as { rooms2: Record<string, unknown> }).rooms2 = {};
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    (norm as { rooms2?: Record<string, unknown> }).rooms2 = {
      closed: {
        polygon: [{ x: 10, y: 10 }, { x: 390, y: 10 }, { x: 390, y: 290 }, { x: 10, y: 290 }],
        name: "none",
        zones: [{ name: "none" }],
      },
    };
  });
  (ws as unknown as { offline: boolean }).offline = true;
  await ws.open("0", "1");
  await ws.applyWalls("wall_add", (mm) => {
    addWall(mm as Model, { start: { x: openWall.p1.x * 10, y: openWall.p1.y * 10 }, end: { x: openWall.p2.x * 10, y: openWall.p2.y * 10 }, thicknessMm: 200 });
  });
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.ok(res.warnings.some((w) => w.includes("room_new_from_walls")), JSON.stringify(res.warnings));
});

test("128 R2: «лишняя» комната без связи с изменёнными стенами — NORMALIZATION_DROPPED", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (norm) => {
    const rooms = roomsOf(norm);
    rooms["unrelated"] = {
      polygon: [{ x: 9000, y: 9000 }, { x: 9400, y: 9000 }, { x: 9400, y: 9300 }, { x: 9000, y: 9300 }],
      name: "none",
      zones: [{ name: "none" }],
    };
  });
  (ws as unknown as { offline: boolean }).offline = true;
  await ws.open("0", "1");
  await ws.applyWalls("wall_move", (mm) => {
    moveWall(mm as Model, { wallId: "w2", offsetMm: 10 });
  });
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "NORMALIZATION_DROPPED");
    const details = (e as { details?: { room_mismatches?: string[] } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("unrelated")), JSON.stringify(details));
    return true;
  });
  assert.equal(saves, 0, "до записи дело не дошло");
});

// ---------- R4: потеря НЕзатронутой комнаты внутри applyWalls — атомарный отказ ----------

test("128 R4: нормализатор в applyWalls удалил незатронутую комнату — INVALID_GEOMETRY, модель не меняется", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (norm) => {
    const rooms = roomsOf(norm);
    // mock нормализатора: теряется только дальняя комната, контур которой
    // не пересекает перенесённую стену w2 (ревью 127 R4)
    delete rooms["_uwwgk"];
  });
  await ws.open("0", "1");
  await assert.rejects(ws.applyWalls("wall_move", (mm) => {
    moveWall(mm as Model, { wallId: "w2", offsetMm: 10 });
  }), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "INVALID_GEOMETRY");
    const details = (e as { details?: { room_mismatches?: string[] } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("исчезла")), JSON.stringify(details));
    return true;
  });
  // атомарность: рабочая копия не изменилась
  assert.equal(Object.keys(roomsOf(ws.model)).length, 4);
  assert.equal(Object.keys(ws.model.walls).length, 7);
  assert.equal(saves, 0, "до записи дело не дошло");
});

test("128 R4: потеря незатронутой комнаты при save (стены изменились) — NORMALIZATION_DROPPED", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (norm) => {
    const rooms = roomsOf(norm);
    delete rooms["_uwwgk"];
  });
  (ws as unknown as { offline: boolean }).offline = true;
  await ws.open("0", "1");
  await ws.applyWalls("wall_move", (mm) => {
    moveWall(mm as Model, { wallId: "w2", offsetMm: 10 });
  });
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "NORMALIZATION_DROPPED");
    const details = (e as { details?: { room_mismatches?: string[] } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("исчезла")), JSON.stringify(details));
    return true;
  });
  assert.equal(saves, 0, "до записи дело не дошло");
});

// ---------- модульный слой: разница стен, затронутые комнаты, единицы контура ----------

test("128 rooms-save: changedWallSegments — разница «база → после операции» в обе стороны", () => {
  const base = {
    a: { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, depth: 20 },
    b: { p1: { x: 0, y: 100 }, p2: { x: 0, y: 300 }, depth: 20 },
  };
  const now = {
    a: { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, depth: 20 },
    c: { p1: { x: 50, y: 50 }, p2: { x: 150, y: 50 }, depth: 20 },
  };
  const changed = changedWallSegments(base, now);
  assert.equal(changed.length, 2, JSON.stringify(changed));
});

test("128 rooms-save: affectedRoomIds — комната у изменённой стены затронута, дальняя нет", () => {
  const rooms = {
    near: { polygon: [{ x: 10, y: 10 }, { x: 290, y: 10 }, { x: 290, y: 290 }, { x: 10, y: 290 }], area: 7.84 },
    far: { polygon: [{ x: 900, y: 900 }, { x: 1200, y: 900 }, { x: 1200, y: 1200 }, { x: 900, y: 1200 }], area: 9 },
  };
  const changed = [{ p1: { x: 300, y: 0 }, p2: { x: 300, y: 300 }, depthCm: 20 }];
  const affected = affectedRoomIds(rooms, changed);
  assert.ok(affected.has("near"), [...affected].join(","));
  assert.equal(affected.has("far"), false, [...affected].join(","));
});

test("128 rooms-save: roomPolygonCm — контур в мм приводится к см по area (fixture anon-rect)", () => {
  const m = anonRectModel();
  const room = Object.values(roomsOf(m))[0]!;
  const polyCm = roomPolygonCm(room)!;
  const xs = polyCm.map((p) => p.x);
  const ys = polyCm.map((p) => p.y);
  assert.ok(Math.min(...xs) < 15, JSON.stringify(polyCm));
  assert.ok(Math.max(...xs) > 385, JSON.stringify(polyCm));
});
