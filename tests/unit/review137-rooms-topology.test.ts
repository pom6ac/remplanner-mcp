// Этап 137 (M1 ревью 136, факт проб p137-diag): редактор перестраивает rooms2 только
// при штатном сохранении (план "a" → copyRooms1 → план "c" → draw), а копия normalize
// несла старые комнаты → строгая сверка комнат после save (#17) давала ложный SITE_ERROR
// с rounds=2 на каждом save с делением/слиянием/переносом комнаты — обычными стенами.
// Фикс: normalize повторяет пересчёт комнат сохранения (inject.js), копия несёт
// перестроенные комнаты. Эталоны — точная форма редактора после save
// (tests/fixtures/ui-ref-rooms-save-{split,merge,move}.json).
// Mock save — подмена writeBackup/loadModel/openEditor (new-entity-section.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, Wall } from "../../src/model/types.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import { McpError } from "../../src/errors.ts";
import { addWall, deleteWall, moveWall } from "../../src/model/walls.ts";
import type { LoadedModel } from "../../src/api.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CORRIDOR = new URL("../fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;

function corridorModel(): Model {
  return (JSON.parse(readFileSync(CORRIDOR, "utf8")) as { model: Model }).model;
}

type Ref = {
  scenario: string;
  base_rooms2: Record<string, unknown>;
  after_save: { walls: Record<string, Wall>; rooms2: Record<string, unknown> };
};

function ref(name: string): Ref {
  return JSON.parse(readFileSync(join(here, "..", "fixtures", `ui-ref-rooms-save-${name}.json`), "utf8")) as Ref;
}

function roomsOf(m: Model | Record<string, unknown>): Record<string, Record<string, unknown>> {
  return ((m as Record<string, unknown>)["rooms2"] ?? (m as Record<string, unknown>)["rooms1"] ?? {}) as Record<string, Record<string, unknown>>;
}

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

/**
 * Mock редактора. rebuild — где редактор кладёт перестроенные комнаты:
 * "normalize" (факт фикса: копия несёт перестроенные комнаты, стены — форма редактора
 * из эталона) или "save" (доревью-поведение: копия со старыми комнатами, сервер
 * перестраивает при записи). afterSave — что делает сервер после записи.
 */
function saveMock(
  server: SaveServer,
  rebuild: "normalize" | "save",
  op: (m: Model) => void,
  ref: Ref | null,
  afterSave: (s: SaveServer) => void = () => {},
): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      const copy = structuredClone(m as object) as Record<string, unknown>;
      if (rebuild === "normalize" && ref) {
        // копия редактора с точной формой из эталона (стены и перестроенные комнаты)
        (copy as { walls?: unknown }).walls = structuredClone(ref.after_save.walls);
        (copy as { rooms2?: unknown }).rooms2 = structuredClone(ref.after_save.rooms2);
      }
      normalized = copy;
      const walls = Object.keys((copy as { walls?: Record<string, unknown> }).walls ?? {}).length;
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

/** Операция пользователя: стены базы + операция из эталона (нашими правилами). */
function opFor(name: string, r: Ref): (m: Model) => void {
  void r;
  if (name === "split") {
    // обычная стена plan:"a" (материал по умолчанию a_block — ревью 129 C4:
    // c_* на исходных стенах не применяется, конфликт слива #18)
    return (m) => addWall(m, { start: { x: 100, y: -1500 }, end: { x: 2900, y: -1500 }, thicknessMm: 100 } as never);
  }
  if (name === "merge") {
    return (m) => deleteWall(m, "w6");
  }
  return (m) => moveWall(m, { wallId: "w6", offsetMm: -1000 } as never);
}

/** База: коридор + 3 комнаты (как в эталонах), стены с holes. */
function baseServer(): SaveServer {
  const m = corridorModel();
  for (const w of Object.values(m.walls) as Wall[]) w.holes ??= {};
  return { saveId: "s1", model: m as unknown as Record<string, unknown> };
}

// ---------- 1. факт фикса: normalize несёт перестроенные комнаты — verified ----------

for (const name of ["split", "merge", "move"] as const) {
  test(`137: ${name} — редактор перестраивает комнаты в normalize, save verified (rounds=1)`, async () => {
    const r = ref(name);
    const server = baseServer();
    const ws = saveMock(server, "normalize", opFor(name, r), r);
    await ws.open("0", "1");
    const applied = await ws.applyWalls("op", (m) => { for (const w of Object.values(m.walls) as Wall[]) w.holes ??= {}; opFor(name, r)(m); });
    // предупреждения штатной топологии затронутых комнат — не блокировка
    assert.ok(applied.warnings.some((w) => w.includes("room_topology_changed") || w.includes("room_new_from_walls")), JSON.stringify(applied.warnings));
    const res = await ws.save();
    assert.equal(res.verified, true);
    assert.equal(res.rounds, 1);
    // на сервере — точная форма редактора после save
    assert.equal(Object.keys(roomsOf(server.model)).length, Object.keys(r.after_save.rooms2).length);
  });
}

// ---------- 2. свежий проект: первый save без ложной блокировки ----------

test("137: первый save нового проекта (rooms2 строит редактор) — verified", async () => {
  const server: SaveServer = { saveId: "s1", model: { v: 3, id: "0", plan_id: "1", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: false } };
  const ws = saveMock(server, "normalize", () => {}, null);
  await ws.open("0", "1");
  await ws.applyWalls("base", (m) => {
    const c = corridorModel();
    for (const w of Object.values(c.walls) as Wall[]) w.holes ??= {};
    m.walls = c.walls;
  });
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

// ---------- 3. без фикса (перестройка только при save) — прежний SITE_ERROR ----------

test("137: копия normalize со старыми комнатами, сервер перестраивает при save — SITE_ERROR (как на main до фикса)", async () => {
  const r = ref("split");
  const server = baseServer();
  // сервер после записи имеет перестроенные комнаты (эталон) — но копия была со старыми
  const ws = saveMock(server, "save", opFor("split", r), r, (s) => {
    (s.model as { rooms2?: Record<string, unknown> }).rooms2 = structuredClone(r.after_save.rooms2);
    (s.model as { walls?: unknown }).walls = structuredClone(r.after_save.walls);
  });
  await ws.open("0", "1");
  await ws.applyWalls("op", (m) => { for (const w of Object.values(m.walls) as Wall[]) w.holes ??= {}; opFor("split", r)(m); });
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { room_mismatches?: string[] } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("лишняя") || x.includes("исчезла")), JSON.stringify(details));
    return true;
  });
});

// ---------- 4. ревью 46 сохраняется: потеря незатронутой комнаты/полей — SITE_ERROR ----------

test("137: сервер потерял НЕзатронутую комнату после перестройки — SITE_ERROR", async () => {
  const r = ref("split");
  const server = baseServer();
  const ws = saveMock(server, "normalize", opFor("split", r), r, (s) => {
    const rooms = roomsOf(s.model);
    delete rooms["_d770d"]; // маленькая комната справа, операцией не затронута
  });
  await ws.open("0", "1");
  await ws.applyWalls("op", (m) => { for (const w of Object.values(m.walls) as Wall[]) w.holes ??= {}; opFor("split", r)(m); });
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { room_mismatches?: string[] } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("_d770d") && x.includes("исчезла")), JSON.stringify(details));
    return true;
  });
});

test("137: сервер стёр имя помещения у перестроенной комнаты — SITE_ERROR", async () => {
  const r = ref("split");
  const server = baseServer();
  const ws = saveMock(server, "normalize", opFor("split", r), r, (s) => {
    const rooms = roomsOf(s.model);
    const room = rooms["_uwwgk"] as { zones: Array<Record<string, unknown>> } | undefined;
    if (room?.zones?.[0]) room.zones[0]["name"] = "Спальня";
  });
  await ws.open("0", "1");
  await ws.applyWalls("op", (m) => { for (const w of Object.values(m.walls) as Wall[]) w.holes ??= {}; opFor("split", r)(m); });
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { room_mismatches?: string[] } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("Спальня")), JSON.stringify(details));
    return true;
  });
});

test("137: сервер вернул лишнюю комнату при неизменных стенах — SITE_ERROR", async () => {
  const r = ref("split");
  const server = baseServer();
  const ws = saveMock(server, "normalize", opFor("split", r), r, (s) => {
    const rooms = roomsOf(s.model) as Record<string, Record<string, unknown>>;
    const extra = structuredClone(Object.values(rooms)[0]!);
    extra["polygon"] = (extra["polygon"] as Array<{ x: number; y: number }>).map((p) => ({ x: p.x + 5000, y: p.y + 5000 }));
    rooms["extra"] = extra;
  });
  await ws.open("0", "1");
  await ws.applyWalls("op", (m) => { for (const w of Object.values(m.walls) as Wall[]) w.holes ??= {}; opFor("split", r)(m); });
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { room_mismatches?: string[] } }).details;
    assert.ok((details?.room_mismatches ?? []).some((x) => x.includes("лишняя")), JSON.stringify(details));
    return true;
  });
});
