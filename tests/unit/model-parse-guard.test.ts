// Дефект 3 (отчёт 11-user-trial-1): project_open не возвращает пустую модель молча —
// если сервер отдал непустой data или save_id > 0, а разобранная модель пустая,
// то MODEL_PARSE_EMPTY; сохранение такого проекта блокируется без force;
// project_save сверяет счётчики с серверной версией и предупреждает об удалениях.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace, type WorkspaceDeps, type EditorLike, type SaveOutcome } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import type { Model, FixtureEnvelope } from "../../src/model/types.ts";
import { McpError } from "../../src/errors.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function fixtureModel(): Model {
  const env = JSON.parse(
    readFileSync(join(ROOT, "tests/fixtures/anon-rect-4000x3000.json"), "utf8"),
  ) as FixtureEnvelope;
  return structuredClone(env.model);
}

function emptyModel(): Model {
  return { v: 3, id: "0", plan_id: "0", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: true };
}

type Server = { saveId: string; model: Model; dataEmpty: boolean };

function mockDeps(server: Server) {
  let lastNormalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "123", planId: "1",
    async normalize(model) {
      const walls = (model as { walls: Record<string, unknown> }).walls;
      lastNormalized = structuredClone(model) as Record<string, unknown>;
      return {
        model: structuredClone(model) as unknown as Record<string, unknown>,
        rooms: [],
        before: { walls: Object.keys(walls).length, holes: 0, items: 0 },
        after: { walls: Object.keys(walls).length, holes: 0, items: 0 },
      };
    },
    async save() {
      server.saveId = "s_saved";
      server.model = (lastNormalized ?? emptyModel()) as unknown as Model;
      return { ok: true, saveId: server.saveId, conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { throw new Error("not used"); },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(_s, _oid, _pid): Promise<LoadedModel> {
      return {
        object_id: "123", plan_id: "1", save_id: server.saveId, units: "cm",
        data_empty: server.dataEmpty,
        model: structuredClone(server.model) as unknown as Record<string, unknown>,
      };
    },
    async openEditor() { return editor; },
  };
  return { deps, editor };
}

test("parse-guard: data непустой, а разобранная модель пустая → MODEL_PARSE_EMPTY", async () => {
  const server: Server = { saveId: "0", model: emptyModel(), dataEmpty: false };
  const ws = new Workspace(mockDeps(server).deps);
  await assert.rejects(
    ws.open("123", "1"),
    (e: unknown) => {
      assert.ok(e instanceof McpError);
      assert.equal(e.code, "MODEL_PARSE_EMPTY");
      return true;
    },
  );
});

test("parse-guard: data пустой, но save_id > 0 (инцидент с пустым открытием) → MODEL_PARSE_EMPTY", async () => {
  const server: Server = { saveId: "8", model: emptyModel(), dataEmpty: true };
  const ws = new Workspace(mockDeps(server).deps);
  await assert.rejects(ws.open("123", "1"), (e: unknown) => e instanceof McpError && e.code === "MODEL_PARSE_EMPTY");
});

test("parse-guard: пустой проект без сохранений (data пустой, save_id 0) открывается", async () => {
  const server: Server = { saveId: "0", model: emptyModel(), dataEmpty: true };
  const ws = new Workspace(mockDeps(server).deps);
  const p = await ws.open("123", "1");
  assert.equal(p.saveId, "0");
  assert.equal(Object.keys(ws.model.walls).length, 0);
});

test("parse-guard: project_save на проекте, открытом пустым, при непустой серверной — ошибка; force пишет", async () => {
  const server: Server = { saveId: "0", model: emptyModel(), dataEmpty: true };
  const { deps } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  // в другой вкладке на сервере появилась модель
  server.model = fixtureModel();
  server.dataEmpty = false;
  await assert.rejects(
    ws.save(),
    (e: unknown) => {
      assert.ok(e instanceof McpError);
      assert.equal(e.code, "SAVE_CONFLICT");
      assert.match(e.message, /пустой/);
      return true;
    },
  );
  // force: true — принудительная запись пустой модели
  const res = await ws.save({ force: true });
  assert.ok(res.save_id);
});

test("parse-guard: project_save предупреждает, сколько объектов сервера будет удалено", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel(), dataEmpty: false };
  // на сервере есть предметы, которых нет в локальной модели
  const serverModel = server.model as Model;
  serverModel.items["srv1"] = {
    id: "srv1", name: "sofa", pc: { x: 200, y: 150 }, angle: 0, width: 100, height: 100,
    plan: { furniture: 1 },
  };
  serverModel.items["srv2"] = {
    id: "srv2", name: "table", pc: { x: 250, y: 150 }, angle: 0, width: 100, height: 100,
    plan: { furniture: 1 },
  };
  const { deps } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  // локально предмет srv2 удалён: серверная версия имеет на 1 предмет больше —
  // при записи он пропадёт с сервера, project_save обязан об этом предупредить
  ws.apply("item_delete", (m) => { delete m.items["srv2"]; return true; });
  const res: SaveOutcome = await ws.save();
  assert.deepEqual(res.will_delete, { walls: 0, openings: 0, items: 1 });
  assert.ok(res.warnings.some((w) => w.includes("1") && w.includes("предмет")), res.warnings.join("; "));
});
