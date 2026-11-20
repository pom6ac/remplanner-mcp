// Этап 126 — надёжность save по комнатам (финальный пункт плана, урок ревью 46):
// прежняя сверка ловила только полное исчезновение комнат (N→0). Пример: fixture
// editor-corridor-3rooms, стены не менялись, mock server удаляет одну комнату →
// было verified=true, warnings=[]. Теперь: частичная потеря и потеря пользовательских
// полей (имя/зоны) — SITE_ERROR; перенумерация id и перестановка стартовой вершины —
// verified; штатные split/merge до save — без ложной блокировки.
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
import { roomsSaveCompare, roomsNormalizeMismatches, roomsSaveMismatches, roomUserSig } from "../../src/model/rooms-save.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const CORRIDOR = new URL("../fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;

function corridorModel(): Model {
  return (JSON.parse(readFileSync(CORRIDOR, "utf8")) as { model: Model }).model;
}

function roomsOf(m: Model | Record<string, unknown>): Record<string, Record<string, unknown>> {
  return ((m as Record<string, unknown>)["rooms2"] ?? (m as Record<string, unknown>)["rooms1"] ?? {}) as Record<string, Record<string, unknown>>;
}

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

/** Mock save: normalize — копия с возможной подменой; save — запись и afterSave. */
function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
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

// ---------- 1. пример из ревью 46: частичная потеря N→M>0 ----------

test("126: mock server удаляет одну комнату из четырёх при неизменных стенах — SITE_ERROR (было verified)", async () => {
  const m = corridorModel();
  assert.equal(Object.keys(roomsOf(m)).length, 4);
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const rooms = roomsOf(s.model);
    delete rooms[Object.keys(rooms)[0]!];
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { room_mismatches?: string[]; rooms_expected?: number; rooms_on_server?: number } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("исчезла")), JSON.stringify(details));
    assert.equal(details?.rooms_expected, 4);
    assert.equal(details?.rooms_on_server, 3);
    return true;
  });
});

// ---------- 2. потеря пользовательских полей сервером ----------

test("126: сервер стёр имя/тип комнаты (zones) — SITE_ERROR", async () => {
  const m = corridorModel();
  // этап 318: безымянные зоны (умолчание name "none") не считаются
  // пользовательскими — именуем зону явно, чтобы стирание было потерей
  const rooms = roomsOf(m);
  const first = rooms[Object.keys(rooms)[0]!]!;
  ((first["zones"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)["name"] = "Гостиная";
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const gotRooms = roomsOf(s.model);
    const gotFirst = gotRooms[Object.keys(rooms)[0]!]!;
    gotFirst["zones"] = [];
    gotFirst["name"] = "none";
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { room_mismatches?: string[] } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("зоны")), JSON.stringify(details));
    return true;
  });
});

test("126: сервер подменил имя помещения (zones[0].name) — SITE_ERROR", async () => {
  const m = corridorModel();
  const rooms = roomsOf(m);
  const first = rooms[Object.keys(rooms)[0]!]!;
  ((first["zones"] as Record<string, unknown>[])[0] as Record<string, unknown>)["name"] = "Гостиная";
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const got = roomsOf(s.model);
    const gotFirst = got[Object.keys(rooms)[0]!]!;
    ((gotFirst["zones"] as Record<string, unknown>[])[0] as Record<string, unknown>)["name"] = "Спальня";
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { room_mismatches?: string[] } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("Гостиная") && x.includes("Спальня")), JSON.stringify(details));
    return true;
  });
});

// ---------- 3. штатная нормализация без ложной блокировки ----------

test("126: перенумерация id комнат и перестановка стартовой вершины — verified", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const rooms = roomsOf(s.model) as Record<string, Record<string, unknown>>;
    const entries = Object.entries(rooms);
    const renumbered: Record<string, Record<string, unknown>> = {};
    for (const [i, [, room]] of entries.entries()) {
      const rec = structuredClone(room);
      // перестановка стартовой вершины контура
      const poly = (rec["polygon"] ?? rec["points"]) as Array<{ x: number; y: number }>;
      poly.push(poly.shift()!);
      renumbered[`new-id-${i}`] = rec;
    }
    delete (s.model as { rooms2?: Record<string, unknown> }).rooms2;
    (s.model as { rooms2?: Record<string, unknown> }).rooms2 = renumbered;
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

test("126: лишняя комната на сервере — SITE_ERROR", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const rooms = roomsOf(s.model);
    const extra = structuredClone(rooms[Object.keys(rooms)[0]!]!);
    const poly = (extra["polygon"] ?? extra["points"]) as Array<{ x: number; y: number }>;
    extra["polygon"] = poly.map((p) => ({ x: p.x + 5000, y: p.y + 5000 }));
    rooms["extra-room"] = extra!;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { room_mismatches?: string[] } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("лишняя")), JSON.stringify(details));
    return true;
  });
});

// ---------- 4. штатные split/merge до save — без ложной блокировки ----------

/** Разрез первой комнаты на две части (как эталон ui-ref-finish-topo-split). */
function splitFirstRoom(m: Record<string, unknown>): void {
  const rooms = roomsOf(m);
  const [rid, room] = Object.entries(rooms)[0]! as [string, Record<string, unknown>];
  const poly = (room["polygon"] ?? room["points"]) as Array<{ x: number; y: number }>;
  const xs = poly.map((p) => p.x);
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  const sorted = [...poly].sort((a, b) => a.x - b.x || a.y - b.y);
  const [x0, x1] = [sorted[0]!.x, sorted[sorted.length - 1]!.x];
  const top = [...sorted].sort((a, b) => a.y - b.y).slice(0, 2);
  const bottom = [...sorted].sort((a, b) => b.y - a.y).slice(0, 2);
  const partA = [
    { x: x0, y: top[0]!.y }, { x: mid, y: top[0]!.y },
    { x: mid, y: bottom[0]!.y }, { x: x0, y: bottom[0]!.y },
  ];
  const partB = [
    { x: mid, y: top[1]!.y }, { x: x1, y: top[1]!.y },
    { x: x1, y: bottom[1]!.y }, { x: mid, y: bottom[1]!.y },
  ];
  delete rooms[rid];
  const base = structuredClone(room);
  base["polygon"] = partA;
  base["points"] = partA;
  rooms[`${rid}-a`] = structuredClone(base);
  const base2 = structuredClone(room);
  base2["polygon"] = partB;
  base2["points"] = partB;
  rooms[`${rid}-b`] = base2;
}

test("126: штатный split комнаты при нормализации — без ложной блокировки, предупреждение", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => splitFirstRoom(norm));
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.ok(res.warnings.some((w) => w.includes("room_topology_changed")), JSON.stringify(res.warnings));
});

test("126: штатный merge двух комнат при нормализации — без ложной блокировки", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const rooms = roomsOf(norm);
    const [ridA, ridB] = Object.keys(rooms) as [string, string];
    const a = rooms[ridA]!, b = rooms[ridB]!;
    const polyA = (a["polygon"] ?? a["points"]) as Array<{ x: number; y: number }>;
    const polyB = (b["polygon"] ?? b["points"]) as Array<{ x: number; y: number }>;
    const xs = [...polyA.map((q) => q.x), ...polyB.map((q) => q.x)];
    const ys = [...polyA.map((q) => q.y), ...polyB.map((q) => q.y)];
    const merged = [
      { x: Math.min(...xs), y: Math.min(...ys) },
      { x: Math.max(...xs), y: Math.min(...ys) },
      { x: Math.max(...xs), y: Math.max(...ys) },
      { x: Math.min(...xs), y: Math.max(...ys) },
    ];
    const mergedRoom = structuredClone(a);
    mergedRoom["polygon"] = merged;
    mergedRoom["points"] = merged;
    delete rooms[ridA];
    delete rooms[ridB];
    rooms["merged"] = mergedRoom;
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

// ---------- 5. нормализатор потерял комнату при неизменных стенах ----------

test("126: нормализатор убрал комнату при неизменных стенах — NORMALIZATION_DROPPED, save не вызывался", async () => {
  const m = corridorModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (norm) => {
    const rooms = roomsOf(norm);
    delete rooms[Object.keys(rooms)[0]!];
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "NORMALIZATION_DROPPED");
    const details = (e as { details?: { room_mismatches?: string[] } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("исчезла")), JSON.stringify(details));
    return true;
  });
  assert.equal(saves, 0, "до записи дело не дошло");
});

// ---------- 6. модульный слой rooms-save ----------

test("126 rooms-save: нормализация с переносом стены (та же комната) — строгое имя, без блокировки контура", () => {
  const m = corridorModel();
  const rooms = roomsOf(m);
  const [rid, room] = Object.entries(rooms)[0]! as [string, Record<string, unknown>];
  const got = structuredClone(rooms);
  const rec = structuredClone(room) as Record<string, unknown>;
  const poly = (rec["polygon"] ?? rec["points"]) as Array<{ x: number; y: number }>;
  // контур деформирован (перенос стены) — канонический контур другой
  rec["polygon"] = poly.map((p, i) => (i === 0 ? { x: p.x + 30, y: p.y } : p));
  delete got[rid];
  got["moved"] = rec;
  // та же комната (kind=same): имя сохранено — пусто
  assert.deepEqual(roomsNormalizeMismatches(rooms, got), []);
  // имя потеряно — расхождение (этап 318: безымянные зоны с умолчанием name
  // "none" не считаются пользовательскими, поэтому зона именуется явно
  // и на стороне ожидания, и на стороне got)
  const recNamed = structuredClone(rec);
  const baseNamed = structuredClone(rooms);
  ((baseNamed[rid] as Record<string, unknown>)["zones"] as Array<Record<string, unknown>>)[0]!["name"] = "Гостиная";
  ((recNamed["zones"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)["name"] = "Гостиная";
  const gotNamed = structuredClone(got);
  gotNamed["moved"] = recNamed;
  assert.deepEqual(roomsNormalizeMismatches(baseNamed, gotNamed), []);
  const recNoName = structuredClone(recNamed);
  recNoName["zones"] = [];
  const gotNoName = structuredClone(gotNamed);
  gotNoName["moved"] = recNoName;
  const problems = roomsNormalizeMismatches(baseNamed, gotNoName);
  assert.ok(problems.some((x) => x.includes("зоны")), JSON.stringify(problems));
});

test("126 roomUserSig: имя и состав зон, производные не входят", () => {
  const m = corridorModel();
  const rooms = roomsOf(m);
  const [, room] = Object.entries(rooms)[0]! as [string, Record<string, unknown>];
  const sig = roomUserSig(room);
  assert.equal(typeof sig.name, "string");
  assert.ok(Array.isArray(sig.zones));
  // area/number_by_area/height — производные, в сигнатуре отсутствуют
  assert.equal(JSON.stringify(sig).includes("number_by_area"), false);
  assert.ok(roomsSaveCompare(rooms, rooms, "save").problems.length === 0);
  assert.ok(roomsSaveMismatches(rooms, rooms).length === 0);
});
