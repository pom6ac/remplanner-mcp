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

const ROOT = join(import.meta.dirname, "..", "..");

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
