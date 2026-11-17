// Ревью 139 (minor m1/m2): пересчёт комнат в inject.js — try/finally возвращает лист
// редактора в исходный при любом исключении (m1), сбой не откатывается молча —
// в результат normalize попадает rooms_recalc_failed с кратким кодом (m2),
// Workspace пробрасывает его в warnings.
// Мок страницы: строковые функции inject.js исполняются new Function (compat.test.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE } from "../../src/editor/inject.js";

const here = dirname(fileURLToPath(import.meta.url));

type RecalcResult = {
  copy: Record<string, unknown>;
  roomsRebuild: string;
};

/** Мок страницы: window.__remplanner_arg задаётся до вызова, evaluate возвращает Promise. */
function mockPage(globals: Record<string, unknown>) {
  return {
    async evaluate<T>(fn: string): Promise<T> {
      const w = { ...globals };
      const document = { querySelector: () => null, querySelectorAll: () => [], body: { dataset: {} } };
      const fnObj = new Function("window", "document", `"use strict"; return (${fn});`);
      return await fnObj(w, document) as T;
    },
  };
}

type Calls = string[];

/** Глобалы страницы: пустые WALLS (want=0 → пересчёт на первом круге poll). */
function globals(calls: Calls, opts: { failCopyRooms1?: boolean } = {}) {
  const state = { planName: "x" };
  return {
    __remplanner_arg: { model: { v: 3, walls: {} }, waitMs: 10 },
    plan_: 0,
    state,
    WALLS: {},
    ROOMS2: {},
    ROOMS1: {},
    $Project: {
      backupPlan: () => calls.push("backupPlan"),
      setPlanName: (n: string) => { calls.push(`setPlanName:${n}`); state.planName = n; },
      draw: () => calls.push("draw"),
      copyRooms1: () => {
        calls.push("copyRooms1");
        if (opts.failCopyRooms1) throw new Error("copyRooms1 broken (probe 139)");
      },
      restorePlan: () => { calls.push("restorePlan"); state.planName = "x"; },
      restore: (m: unknown) => calls.push("restore"),
    },
    project: {
      copy: () => ({ walls: {}, rooms2: {} }),
      save: () => {},
      localSave: () => {},
    },
  };
}

test("139 m1/m2: исключение в copyRooms1 — restorePlan+restore в finally, rooms_recalc_failed в результате", async () => {
  const calls: Calls = [];
  const page = mockPage(globals(calls, { failCopyRooms1: true }));
  const res = await page.evaluate<RecalcResult>(PAGE.restoreDrawCopy);
  // m2: сбой не откатывается молча — краткий код в результате normalize
  assert.ok(res.roomsRebuild !== "ok" && res.roomsRebuild.includes("copyRooms1 broken"),
    `roomsRebuild=${res.roomsRebuild}`);
  // m1: лист редактора возвращается в исходный при любом исключении
  assert.equal(calls.filter((c) => c === "restorePlan").length, 1, `calls: ${calls.join(",")}`);
  assert.equal(calls[calls.length - 2], "restore", `хвост вызовов: ${calls.join(",")}`);
  assert.equal(calls[calls.length - 1], "draw", `хвост вызовов: ${calls.join(",")}`);
  const w = (page as unknown as { evaluate: never });
  void w;
});

test("139 m1: состояние страницы после сбоя — лист исходный (state.planName)", async () => {
  const calls: Calls = [];
  const g = globals(calls, { failCopyRooms1: true });
  const page = mockPage(g);
  await page.evaluate<RecalcResult>(PAGE.restoreDrawCopy);
  // mockPage копирует globals — проверяем через мок restorePlan: он вернул "x".
  // Дополнительно: setPlanName('c') был, restorePlan после него — последний setPlanName
  const lastSetPlan = [...calls].reverse().find((c) => c.startsWith("setPlanName"));
  assert.equal(lastSetPlan, "setPlanName:a");
  assert.ok(calls.indexOf("restorePlan") > calls.indexOf("setPlanName:c"),
    `restorePlan после setPlanName('c'): ${calls.join(",")}`);
});

test("139: штатный пересчёт — roomsRebuild 'ok', копия с перестроенными комнатами", async () => {
  const calls: Calls = [];
  const g = globals(calls);
  // второй copy (после плана "c") несёт перестроенные комнаты
  let copyN = 0;
  (g.project as { copy: () => unknown }).copy = () => {
    copyN++;
    return copyN >= 2 ? { walls: { w1: {} }, rooms2: { r1: { area: 3.78 } } } : { walls: {}, rooms2: {} };
  };
  const page = mockPage(g);
  const res = await page.evaluate<RecalcResult>(PAGE.restoreDrawCopy);
  assert.equal(res.roomsRebuild, "ok");
  assert.equal(Object.keys(res.copy.walls as Record<string, unknown>).length, 1);
  assert.equal(calls.filter((c) => c === "restorePlan").length, 1, `calls: ${calls.join(",")}`);
});

// ---------- m2 в Workspace: предупреждение пробрасывается в результат мутации ----------

import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { Model } from "../../src/model/types.ts";
import type { NormalizeResult } from "../../src/editor/adapter.ts";

test("139 m2: Workspace пробрасывает rooms_recalc_failed в warnings applyWalls", async () => {
  const model: Model = { v: 3, id: "0", plan_id: "1", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: false };
  const norm: NormalizeResult = {
    rooms: [], before: { walls: 0, holes: 0, items: 0, pillars: 0, rigels: 0 },
    after: { walls: 0, holes: 0, items: 0, pillars: 0, rigels: 0 },
    model: structuredClone(model) as unknown as Record<string, unknown>,
    walls: [], errors: null, roomsRebuild: "failed: probe139 (test)",
  };
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize() { return structuredClone(norm); },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() {
      return { global_version: null, planner_version: null, bundles: [], object_id: "0", plan_id: "1", present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };
    },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel() { return { object_id: "0", plan_id: "1", save_id: "s1", units: "cm", data_empty: false, model: structuredClone(model) as unknown as Record<string, unknown> }; },
    async openEditor() { return editor; },
  };
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  await ws.open("0", "1");
  const applied = await ws.applyWalls("op", () => {});
  assert.ok(applied.warnings.some((x) => x.startsWith("rooms_recalc_failed:") && x.includes("probe139")),
    JSON.stringify(applied.warnings));
});

// ---------- m3: эталон split с дверью и именем комнаты (живая проба 139) ----------

import { readFileSync } from "node:fs";

type SplitHoleRef = {
  _source: string;
  scenario: string;
  base_rooms2: Record<string, { area?: number; zones?: Array<{ name?: string }> }>;
  after_save: {
    walls: Record<string, { holes?: Record<string, unknown> }>;
    rooms2: Record<string, { area?: number; zones?: Array<{ name?: string }> }>;
  };
};

test("139 m3: эталон split с дверью — дверь пережила пересчёт, имя наследуют обе части", () => {
  const ref = JSON.parse(readFileSync(join(here, "..", "fixtures", "ui-ref-rooms-save-split-hole.json"), "utf8")) as SplitHoleRef;
  assert.match(ref.scenario, /split-hole-named/);
  // база: 4 комнаты, исходная 7,84 (base_rooms2 снят ДО присвоения имени — там "none")
  const src = Object.entries(ref.base_rooms2).find(([, r]) => Math.abs((r.area ?? 0) - 7.84) < 0.02);
  assert.ok(src, "база: комната 7,84 на месте");
  // имя было присвоено исходной комнате перед делением (проба 139, шаг 2)
  // и пережило пересчёт: после save имя «Гостиная» у исходной комнаты и наследовано второй частью
  const namedAfter = Object.entries(ref.after_save.rooms2).filter(([, r]) => r.zones?.[0]?.name === "Гостиная");
  assert.equal(namedAfter.length, 2, "имя «Гостиная» у обеих частей деления");
  assert.ok(namedAfter.some(([id]) => id === src![0]), "имя у исходной комнаты (тот же id)");
  // после save: 8 стен, 1 дверь, 5 комнат 5,8/5,04/2×3,78/2,24
  assert.equal(Object.keys(ref.after_save.walls).length, 8);
  const holes = Object.values(ref.after_save.walls).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0);
  assert.equal(holes, 1, "дверь на делящейся стене пережила пересчёт комнат");
  const areas = Object.values(ref.after_save.rooms2).map((r) => r.area ?? 0).sort((a, b) => b - a);
  assert.deepEqual(areas.map((x) => Math.round(x * 100) / 100), [5.8, 5.04, 3.78, 3.78, 2.24]);
  // эталон обезличен: нет id объекта/плана в _source
  assert.ok(!/789\d{4}/.test(ref._source), "_source без id проекта");
});
