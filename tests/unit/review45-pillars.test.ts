// Этап 45: второй круг исправлений ревью PR #4 «Несущая колонна»
// (.orca-reports/44-rereview-pillars.md).
// №5 — потеря комнат меряется относительно результата нормализации (то, что ушло
// на save), а не устаревших rooms2 рабочей копии: разомкнутый пользователем
// контур штатно убирает комнату при нормализации.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FixtureEnvelope } from "../../src/model/types.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { deleteWall } from "../../src/model/walls.ts";
import { McpError } from "../../src/errors.ts";
import { validateModel } from "../../src/model/validate.ts";
import { addPillar, pillarCorners, pillarEdges } from "../../src/model/pillars.ts";
import type { Model, Pillar } from "../../src/model/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/** Комната [0,0]…[600,300] (внутренние грани), как в ревью 42/43. */
const ROOMS = [{
  roomId: null,
  polygon: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 300 }, { x: 0, y: 300 }],
  areaCm2: 180000,
  axisAreaCm2: null,
}];

/** Стена-эталон примыкания: ось y=100.5, толщина 25 (грани y=88 и y=113). */
function pillarModel(): Model {
  return {
    walls: {
      w: {
        id: "w", plan: "a", role: "wall", depth: 25, height: 270, material: "a_block",
        p1: { x: 32.7, y: 100.5 }, p2: { x: 523.7, y: 100.5 }, holes: {},
      },
    },
    items: {},
    pillars: {},
  } as unknown as Model;
}

/** Колонна, прижатая гранью b к верхней грани стены w (pc ≈ (452.08, 78)). */
function attachPillar(m: Model): Pillar {
  return addPillar(m, { center: { x: 4520.8, y: 780 } }, ROOMS);
}

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

// ---------- №5: штатное исчезновение комнаты после размыкания контура ----------

test("№5 wall_delete размыкает контур: комната уходит при нормализации — verified=true, один save (как на main)", async () => {
  const env = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/anon-rect-4000x3000.json"), "utf8")) as FixtureEnvelope;
  let server = structuredClone(env.model) as unknown as Record<string, unknown>;
  let normalized: Record<string, unknown> | null = null;
  let saves = 0;
  // Нормализатор моделирует закономерный результат размыкания прямоугольника —
  // комнат нет (контракт Workspace, как в воспроизведении ревью 44).
  const editor: EditorLike = {
    objectId: "0", planId: "0",
    async normalize(m) {
      normalized = structuredClone(m as object) as unknown as Record<string, unknown>;
      (normalized as { rooms2?: Record<string, unknown> }).rooms2 = {};
      const c = { walls: Object.keys(m.walls as Record<string, unknown>).length, holes: 2, items: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      saves++;
      server = structuredClone(normalized!);
      return { ok: true, saveId: "0", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return COMPAT; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "0", save_id: "0", units: "cm", data_empty: false, model: structuredClone(server) };
    },
    async openEditor() { return editor; },
  };
  const ws = new Workspace(deps);
  (ws as unknown as { writeBackup: () => string }).writeBackup = () => "/offline";
  await ws.open("0", "0");
  assert.equal(Object.keys(ws.model.rooms2 ?? {}).length, 1, "в фикстуре одна комната");
  const wall = Object.values(ws.model.walls).find((w) => Object.keys(w.holes).length === 0);
  assert.ok(wall, "в фикстуре есть стена без проёмов");
  await ws.applyWalls("wall_delete", (mm) => deleteWall(mm, wall.id));
  const out = await ws.save();
  assert.equal(out.verified, true);
  assert.equal(out.rounds, 1, "одна запись, без повторной попытки");
  assert.equal(saves, 1);
  assert.equal(Object.keys((server as { rooms2?: Record<string, unknown> }).rooms2 ?? {}).length, 0);
});

// ---------- №3 (остаток ревью 44): валидатор на конечном предикате контакта ----------

test("№3 model_validate: далёкая колонна без eds за концом стены — PILLAR_OUTSIDE_ROOM", () => {
  const m = pillarModel();
  const p = attachPillar(m);
  // переносим уже существующую колонну далеко за конец стены (pc.x=10000),
  // eds очищен — модель «как с сервера», в обход исправленного addPillar
  p.pc = { x: 10000, y: 78 };
  const corners = pillarCorners(p.pc, p.width, p.height, p.angle ?? 0);
  [p.p1, p.p2, p.p3, p.p4] = corners;
  p.edges = pillarEdges(corners);
  p.eds = {};
  const problems = validateModel(m, ROOMS).filter((x) => x.code === "PILLAR_OUTSIDE_ROOM");
  assert.equal(problems.length, 1, JSON.stringify(problems));
});

test("№3 model_validate: примыкающая колонна по-прежнему без PILLAR-ошибок (регрессия эталона)", () => {
  const m = pillarModel();
  attachPillar(m);
  assert.equal(validateModel(m, ROOMS).filter((x) => x.code.startsWith("PILLAR")).length, 0);
});

// ---------- №6: циклическое сравнение угла при верификации ----------

type SaveServer = { saveId: string; model: Record<string, unknown> };

/** Workspace с редактором «как есть» и сервером, меняющим модель сразу после save. */
function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      const walls = Object.keys(m.walls as Record<string, unknown>).length;
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: { walls, holes: 0, items: 0 }, after: { walls, holes: 0, items: 0 } };
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

test("№6 угол 360° на сервере нормализован в 0° — эквивалент, verified=true с одной записи", async () => {
  const server: SaveServer = { saveId: "s1", model: pillarModel() as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    for (const p of Object.values(s.model.pillars as Record<string, { angle?: number }>)) p.angle = 0;
  });
  await ws.open("0", "1");
  ws.apply("pillar_add", (mm) => void addPillar(mm, { center: { x: 2000, y: 1500 }, angleDeg: 360 }, ROOMS));
  const out = await ws.save();
  assert.equal(out.verified, true);
  assert.equal(out.rounds, 1);
});

test("№6 угол 0° на сервере нормализован в 360° — тоже эквивалент", async () => {
  const server: SaveServer = { saveId: "s1", model: pillarModel() as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    for (const p of Object.values(s.model.pillars as Record<string, { angle?: number }>)) p.angle = 360;
  });
  await ws.open("0", "1");
  ws.apply("pillar_add", (mm) => void addPillar(mm, { center: { x: 2000, y: 1500 } }, ROOMS));
  const out = await ws.save();
  assert.equal(out.verified, true);
  assert.equal(out.rounds, 1);
});

test("№6 некратный сдвиг угла +50° по-прежнему SITE_ERROR (регрессия №2)", async () => {
  const server: SaveServer = { saveId: "s1", model: pillarModel() as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    for (const p of Object.values(s.model.pillars as Record<string, { angle?: number }>)) p.angle = (p.angle ?? 0) + 50;
  });
  await ws.open("0", "1");
  ws.apply("pillar_add", (mm) => void addPillar(mm, { center: { x: 2000, y: 1500 } }, ROOMS));
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { pillar_mismatches?: string[] } }).details;
    assert.ok((details?.pillar_mismatches ?? []).some((x) => x.includes("угол")), JSON.stringify(details));
    return true;
  });
});
