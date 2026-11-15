// T17: рабочее пространство — история undo/redo (до 50), dirty, снимок в backups/,
// SAVE_CONFLICT при чужом сохранении, верификация по GET.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import type { Model, FixtureEnvelope } from "../../src/model/types.ts";
import { addWall } from "../../src/model/walls.ts";
import { McpError } from "../../src/errors.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function fixtureModel(): Model {
  const env = JSON.parse(
    readFileSync(join(ROOT, "tests/fixtures/anon-rect-4000x3000.json"), "utf8"),
  ) as FixtureEnvelope;
  return structuredClone(env.model);
}

type Server = { saveId: string; model: Model };

function mockDeps(server: Server, editorOpts: { failSave?: boolean } = {}) {
  let lastNormalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "123", planId: "1",
    async normalize(model) {
      const walls = (model as { walls: Record<string, unknown> }).walls;
      lastNormalized = structuredClone(model) as Record<string, unknown>;
      return {
        model: structuredClone(model) as Record<string, unknown>,
        rooms: [],
        before: { walls: Object.keys(walls).length, holes: 0, items: 0 },
        after: { walls: Object.keys(walls).length, holes: 0, items: 0 },
      };
    },
    async save() {
      if (editorOpts.failSave) return { ok: false, saveId: null, conflict: false };
      server.saveId = `s${Math.random()}`;
      server.model = (lastNormalized ?? fixtureModel()) as unknown as Model;
      return { ok: true, saveId: server.saveId, conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { throw new Error("not used"); },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(_s, _oid, _pid): Promise<LoadedModel> {
      return { object_id: "123", plan_id: "1", save_id: server.saveId, units: "cm", model: structuredClone(server.model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
  return { deps, editor };
}

function newWorkspace(server: Server, editorOpts?: { failSave?: boolean }): Workspace {
  return new Workspace(mockDeps(server, editorOpts).deps);
}

test("workspace: открытие — каноническая модель по GET, не dirty", async () => {
  const server = { saveId: "s1", model: fixtureModel() };
  const ws = newWorkspace(server);
  const p = await ws.open("123", "1");
  assert.equal(p.saveId, "s1");
  assert.equal(p.dirty, false);
  assert.equal(Object.keys(ws.model.walls).length, 4);
  assert.equal(ws.historyInfo().steps, 0);
});

test("workspace: undo/redo — мутация откатывается и повторяется, dirty отслеживается", async () => {
  const server = { saveId: "s1", model: fixtureModel() };
  const ws = newWorkspace(server);
  await ws.open("123", "1");
  const before = Object.keys(ws.model.walls).length;
  ws.apply("wall_add", (m) => addWall(m, { start: { x: 0, y: 6000 }, end: { x: 1000, y: 6000 } }));
  assert.equal(Object.keys(ws.model.walls).length, before + 1);
  assert.equal(ws.project!.dirty, true);
  const back = ws.undo();
  assert.equal(back.applied, 1);
  assert.equal(Object.keys(ws.model.walls).length, before);
  const fwd = ws.redo();
  assert.equal(fwd.applied, 1);
  assert.equal(Object.keys(ws.model.walls).length, before + 1);
  // после undo новая мутация обрезает redo-ветку
  ws.undo();
  ws.apply("wall_add2", (m) => addWall(m, { start: { x: 0, y: 6000 }, end: { x: 2000, y: 6000 } }));
  assert.equal(ws.redo().applied, 0);
});

test("workspace: история ограничена 50 шагами", async () => {
  const server = { saveId: "s1", model: fixtureModel() };
  const ws = newWorkspace(server);
  await ws.open("123", "1");
  for (let i = 0; i < 60; i++) {
    // стены разнесены шире их толщины: наложение тел теперь INVALID_GEOMETRY (§12.3)
    ws.apply(`step${i}`, (m) => addWall(m, { start: { x: i * 1000, y: 6000 }, end: { x: i * 1000, y: 6100 } }));
  }
  const info = ws.historyInfo();
  assert.ok(info.steps <= 50, `история ${info.steps} шагов`);
  const back = ws.undo(100);
  assert.ok(back.applied <= 50, `undo ${back.applied} шагов`);
  assert.equal(ws.historyInfo().canUndo, 0);
});

test("workspace: SAVE_CONFLICT при чужом сохранении; force пишет поверх", async () => {
  const server = { saveId: "s1", model: fixtureModel() };
  const ws = newWorkspace(server);
  await ws.open("123", "1");
  ws.apply("wall_add", (m) => addWall(m, { start: { x: 0, y: 6000 }, end: { x: 1000, y: 6000 } }));
  // в другой вкладке сохранились: save_id сервера убежал вперёд
  server.saveId = "s_other";
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SAVE_CONFLICT");
    return true;
  });
  // force: true — принудительная запись
  const res = await ws.save({ force: true });
  assert.equal(res.verified, true);
  assert.equal(ws.project!.dirty, false);
});

test("workspace: перед сохранением — снимок в backups/, после — верификация по GET", async () => {
  const dir = mkdtempSync(join(tmpdir(), "remplanner-ws-"));
  const realBackups = await import("../../src/config.ts");
  const orig = realBackups.BACKUPS_DIR;
  // подменяем каталог бэкапов через модуль нельзя (const) — проверяем реальный путь создания
  try {
    const server = { saveId: "s1", model: fixtureModel() };
    const ws = newWorkspace(server);
    await ws.open("123", "1");
    ws.apply("wall_add", (m) => addWall(m, { start: { x: 0, y: 6000 }, end: { x: 1000, y: 6000 } }));
    const res = await ws.save();
    assert.equal(res.rounds, 1);
    assert.ok(existsSync(res.backup_path), `бэкап ${res.backup_path} создан`);
    assert.match(res.backup_path, /123-1-.*\.json$/);
    const backup = JSON.parse(readFileSync(res.backup_path, "utf8")) as { model: Model; save_id: string };
    assert.equal(backup.save_id, "s1", "в бэкапе — модель ДО сохранения");
    assert.equal(Object.keys(backup.model.walls).length, 5);
    void dir; void orig;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace: редактор удалил стены при нормализации → NORMALIZATION_DROPPED", async () => {
  const server = { saveId: "s1", model: fixtureModel() };
  const { deps, editor } = mockDeps(server);
  // имитируем удаление стен редактором при normalize
  editor.normalize = async (model) => {
    const m = structuredClone(model) as { walls: Record<string, unknown> };
    const ids = Object.keys(m.walls);
    for (const id of ids.slice(0, 2)) delete m.walls[id];
    return {
      model: m as unknown as Record<string, unknown>,
      rooms: [],
      before: { walls: ids.length, holes: 0, items: 0 },
      after: { walls: ids.length - 2, holes: 0, items: 0 },
    };
  };
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "NORMALIZATION_DROPPED");
    return true;
  });
});

test("workspace: SAVE_CONFLICT от диалога редактора («Сохранить все равно»)", async () => {
  const server = { saveId: "s1", model: fixtureModel() };
  const { deps, editor } = mockDeps(server);
  (editor as unknown as { save: EditorLike["save"] }).save =
    async () => ({ ok: false, saveId: null, conflict: true });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SAVE_CONFLICT");
    return true;
  });
});

test("workspace: неуспешное сохранение → SITE_ERROR", async () => {
  const server = { saveId: "s1", model: fixtureModel() };
  const ws = newWorkspace(server, { failSave: true });
  await ws.open("123", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    return true;
  });
});
