// Инцидент 2026-11-15: живой прогон записал модель теста в проект пользователя 1234567.
// Причина: (1) анонимные потоки могли пойти с cookies аккаунта (ServerContext.session()
// берёт state.json); (2) workspace принимал object_id/plan_id редактора без сверки;
// (3) save не проверял целевой object_id.Guard-тесты: сначала красные, потом зелёные.
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { openEditorInContext, buildHandle } from "../../src/editor/adapter.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import type { Model, FixtureEnvelope } from "../../src/model/types.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

function fixtureModel(): Model {
  const env = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/anon-rect-4000x3000.json"), "utf8")) as FixtureEnvelope;
  return structuredClone(env.model);
}

const COMPAT_PRESENT = { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true };

/** Мок страницы для openEditorInContext: goto/waitForFunction/evaluate без сети. */
function guardPage(opts: { objectId: string; planId: string }) {
  let savedPlanCalled = false;
  const page = {
    async route() {}, // перехват ответа модели (382): мок не делает сетевых запросов
    async goto() { return {}; },
    async waitForResponse() { return null; },
    async waitForFunction() { return true; },
    async waitForTimeout() {},
    async evaluate(fn: string | ((a: unknown) => unknown), a?: unknown): Promise<unknown> {
      if (typeof fn === "function") return {}; // установка __remplanner_arg
      const src = String(fn);
      if (src.includes("planner_ui_message_fog")) return true;
      if (src.includes("global_version")) {
        return {
          global_version: "757", planner_version: "3", bundles: [],
          object_id: opts.objectId, plan_id: opts.planId, present: COMPAT_PRESENT,
        };
      }
      if (src.includes("project.save")) { savedPlanCalled = true; return { started: true }; }
      if (src.includes("$Project.restore")) {
        return { copy: {}, rooms: [], before: { walls: 0, holes: 0, items: 0 }, after: { walls: 0, holes: 0, items: 0 } };
      }
      // текущие id страницы для предсохранительной сверки
      return { object_id: opts.objectId, plan_id: opts.planId };
    },
    on() {}, off() {},
  };
  return { page: page as never, wasSaved: () => savedPlanCalled };
}

test("guard: редактор открыл ЧУЖОЙ object_id (не тот, что запрошен) → EDITOR_PROJECT_MISMATCH, контекст закрыт", async () => {
  let closed = 0;
  const { page } = guardPage({ objectId: "1234567", planId: "765432" });
  const context = {
    newPage: async () => page,
    close: async () => { closed++; },
  };
  await assert.rejects(
    // НЕ анонимный поток: запрошен проект 123, редактор открыл 1234567
    openEditorInContext({ cookies: [] } as never, "123", "1", context as never, 2000),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal((e as { code?: string }).code, "EDITOR_PROJECT_MISMATCH");
      return true;
    },
  );
  assert.equal(closed, 1, "контекст закрыт при несовпадении проекта");
});

test("guard: plan_id не совпал с запрошенным (не аноним) → EDITOR_PROJECT_MISMATCH", async () => {
  let closed = 0;
  const { page } = guardPage({ objectId: "123", planId: "999031" });
  const context = { newPage: async () => page, close: async () => { closed++; } };
  await assert.rejects(
    openEditorInContext({ cookies: [] } as never, "123", "1", context as never, 2000),
    (e: unknown) => (e as { code?: string }).code === "EDITOR_PROJECT_MISMATCH",
  );
  assert.equal(closed, 1);
});

test("guard: анонимный поток с cookies АККАУНТА запрещён до всякой навигации", async () => {
  let newPageCalled = 0;
  const context = { newPage: async () => { newPageCalled++; return {} as never; }, close: async () => {} };
  await assert.rejects(
    openEditorInContext({ cookies: [], account: true } as never, "123", "1", context as never, 2000, { anonymous: true }),
    (e: unknown) => (e as { code?: string }).code === "EDITOR_PROJECT_MISMATCH",
  );
  assert.equal(newPageCalled, 0, "навигация не начиналась");
});

test("guard: save при СМЕНИВШЕМСЯ object_id на странице не отправляет project.save", async () => {
  const { page, wasSaved } = guardPage({ objectId: "1234567", planId: "765432" });
  // открытие сообщило 123, к моменту save страница уже на чужом проекте
  const compat = { global_version: "757", planner_version: "3", bundles: [], object_id: "123", plan_id: "1", present: COMPAT_PRESENT };
  const handle = buildHandle(page, { close: async () => {} }, "123", "1", compat as never, { acquire: async () => {} });
  await assert.rejects(handle.save(2000), (e: unknown) => (e as { code?: string }).code === "EDITOR_PROJECT_MISMATCH");
  assert.equal(wasSaved(), false, "project.save не вызывался");
});

test("guard: workspace анонимного проекта открывает редактор с anonymous: true", async () => {
  const server = { saveId: "s1", model: fixtureModel() };
  const calls: Array<{ objectId: string; planId: string; options?: { anonymous?: boolean } }> = [];
  const editor: EditorLike = {
    objectId: "anon-1", planId: "p1",
    async normalize(model) {
      const walls = (model as { walls: Record<string, unknown> }).walls;
      return { model: structuredClone(model) as Record<string, unknown>, rooms: [], before: { walls: Object.keys(walls).length, holes: 0, items: 0 }, after: { walls: Object.keys(walls).length, holes: 0, items: 0 } };
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { throw new Error("not used"); },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(_s, oid, pid): Promise<LoadedModel> {
      void oid; void pid;
      return { object_id: "123", plan_id: "1", save_id: server.saveId, units: "cm", model: structuredClone(server.model) as unknown as Record<string, unknown> };
    },
    async openEditor(_s, objectId, planId, options) {
      calls.push({ objectId, planId, options });
      return editor;
    },
  };
  const ws = new Workspace(deps);
  await ws.open("123", "1", { anon: true });
  await ws.save();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options?.anonymous, true, "анонимный проект — флаг anonymous у редактора");
});

test("guard: workspace проекта аккаунта не принимает чужой object_id редактора", async () => {
  const server = { saveId: "s1", model: fixtureModel() };
  const editor: EditorLike = {
    objectId: "1234567", planId: "765432",
    async normalize(model) {
      const walls = (model as { walls: Record<string, unknown> }).walls;
      return { model: structuredClone(model) as Record<string, unknown>, rooms: [], before: { walls: Object.keys(walls).length, holes: 0, items: 0 }, after: { walls: Object.keys(walls).length, holes: 0, items: 0 } };
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { global_version: "757", planner_version: "3", bundles: [], object_id: "1234567", plan_id: "765432", present: COMPAT_PRESENT } as never; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [], account: true },
    async loadModel(_s, _oid, _pid): Promise<LoadedModel> {
      return { object_id: "123", plan_id: "1", save_id: server.saveId, units: "cm", model: structuredClone(server.model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  await assert.rejects(ws.save(), (e: unknown) => (e as { code?: string }).code === "EDITOR_PROJECT_MISMATCH");
  assert.equal(ws.project!.objectId, "123", "object_id рабочей копии не подменён");
});
