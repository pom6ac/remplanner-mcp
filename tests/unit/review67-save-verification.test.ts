// Ревью 67, major №3: полная семантическая сверка после save — порча matrix/vertexes/
// items/length/id_room проёма в полу, лишний проём на сервере (удаление не состоялось),
// смена role столба террасы и role стены-ограждения не проходят как verified.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, LevelHole, Pillar } from "../../src/model/types.ts";
import { addBorderRing, addTerraceFence, addTerraceColumn } from "../../src/model/terraces.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addFloorHole } from "../../src/model/floorhole.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";
import type { RoomPolygon } from "../../src/model/items.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {} };
}

const ROOM_POLY: RoomPolygon = {
  roomId: "r1",
  polygon: [{ x: 10, y: -10 }, { x: 390, y: -10 }, { x: 390, y: -290 }, { x: 10, y: -290 }],
  areaCm2: 9.64 * 10_000,
  axisAreaCm2: null,
};

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(m.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: Object.keys(m.pillars as Record<string, unknown>).length, rigels: 0 };
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
  return new Workspace(deps);
}

function scenario(): { model: Model; hole: LevelHole; column: Pillar } {
  const model = emptyModel();
  addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  addBorderRing(model, "terrace_borders", "терраса", {
    points: [{ x: 6000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 3000 }, { x: 6000, y: 3000 }],
  });
  addTerraceFence(model, { start: { x: 6000, y: 1000 }, end: { x: 10000, y: 1000 } });
  const column = addTerraceColumn(model, { center: { x: 7000, y: 2000 } });
  const hole = addFloorHole(model, { corner1: { x: 1000, y: -2500 }, corner2: { x: 2000, y: -1500 } }, [ROOM_POLY]);
  return { model, hole, column };
}

test("rev67 M3: испорчены matrix/vertexes/items/length/id_room проёма — SITE_ERROR, verified нет", async () => {
  const { model } = scenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    for (const h of Object.values((s.model as { level_holes?: Record<string, LevelHole> }).level_holes ?? {})) {
      h.matrix = [];
      h.vertexes = [];
      h.items = {};
      h.length = 0;
      h.id_room = "wrong";
    }
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { level_hole_mismatches?: string[] } }).details;
    const msgs = JSON.stringify(details?.level_hole_mismatches ?? []);
    assert.ok(msgs.includes("matrix") || msgs.includes("вершин"), `нет матрицы/вершин: ${msgs}`);
    assert.ok(msgs.includes("id_room") || msgs.includes("комнат"), `нет id_room: ${msgs}`);
    return true;
  });
});

test("rev67 M3: лишний проём на сервере (удаление не состоялось) — SITE_ERROR", async () => {
  const { model, hole } = scenario();
  // локально проём удалён (floor_hole_delete), но сервер вернул его же — verified нет
  delete model.level_holes![hole.id];
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const holes = (s.model as { level_holes?: Record<string, LevelHole> }).level_holes ?? {};
    holes[hole.id] = structuredClone(hole);
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { level_hole_mismatches?: string[] } }).details;
    assert.ok((details?.level_hole_mismatches ?? []).some((x) => x.includes("лишний") || x.includes("добавлен")), JSON.stringify(details));
    return true;
  });
});

test("rev67 M3: роль столба terrace_column сменилась на pillar — SITE_ERROR", async () => {
  const { model, column } = scenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const p = (s.model as { pillars?: Record<string, Pillar> }).pillars![column.id]!;
    p.role = "pillar";
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { pillar_mismatches?: string[] } }).details;
    assert.ok((details?.pillar_mismatches ?? []).some((x) => x.toLowerCase().includes("role") || x.includes("роль")), JSON.stringify(details));
    return true;
  });
});

test("rev67 M3: роль стены-ограждения terrace_fence сменилась на wall — SITE_ERROR", async () => {
  const { model } = scenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    for (const w of Object.values((s.model as { walls?: Record<string, { role?: string }> }).walls ?? {})) {
      if (w.role === "terrace_fence") w.role = "wall";
    }
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: Record<string, unknown> }).details ?? {};
    assert.ok(
      JSON.stringify(details).includes("terrace_fence") || JSON.stringify(details).includes("роль"),
      JSON.stringify(details),
    );
    return true;
  });
});

test("rev67 M3: лишний проём появился при нормализации — NORMALIZATION_DROPPED до записи", async () => {
  const { model } = scenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    const holder = m as { level_holes?: Record<string, LevelHole> };
    const holes = holder.level_holes ?? (holder.level_holes = {});
    const extra = structuredClone(Object.values(holes)[0]!);
    extra.id = "extra_hole";
    extra.pc = { x: extra.pc.x + 200, y: extra.pc.y };
    extra.polygon = extra.polygon.map((p) => ({ x: p.x + 200, y: p.y }));
    holes["extra_hole"] = extra;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "NORMALIZATION_DROPPED");
    return true;
  });
  assert.equal(saves, 0, "до записи дело не дошло");
});
