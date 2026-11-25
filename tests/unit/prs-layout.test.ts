// Этап 406 — раскладка развёрток комнаты (room_prs_layout; находка 3 ревью 400):
// полный путь через Workspace с моком адаптера (офлайн-эталон — синтетическая
// фикстура synthetic-prs-layout.json поверх editor-corridor-3rooms.json),
// no-op, INVALID_ARGUMENT, атомарность (некорректный ответ страницы — модель
// не меняется), prs_set после раскладки пишет реальные oid, сверка save,
// гарды адаптера (assertModelSafeForEditor, id комнаты — только данные).
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import { buildHandle } from "../../src/editor/adapter.ts";
import { setPrsSettings, applyPrsLayout, hasRealPrsLayout, type PrsLayoutRaw } from "../../src/model/projections.ts";
import { prsSettingsMismatches } from "../../src/verify/projections.ts";
import { planTools } from "../../src/server/tools-plan.ts";
import { ServerContext } from "../../src/server/context.ts";
import type { LoadedModel } from "../../src/api.ts";
import type { Model } from "../../src/model/types.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
type AnyRec = Record<string, unknown>;

const BASE = JSON.parse(readFileSync(join(here, "../fixtures/editor-corridor-3rooms.json"), "utf8")) as { model: Model };
const REF = JSON.parse(readFileSync(join(here, "../fixtures/synthetic-prs-layout.json"), "utf8")) as {
  room: string;
  editor_layout: PrsLayoutRaw;
  expected_lines: Array<{ edge_index: number; wall: string; side: string; length_mm: number }>;
};
const R1 = "_uwwgk";

function baseModel(): Model {
  return structuredClone(BASE.model);
}

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: {} };

type Harness = { ws: Workspace; server: { saveId: string; model: AnyRec }; calls: { layout: number; args: Array<{ roomId: string }> } };

/** Workspace с моком адаптера: prsLayout отдаёт эталон фикстуры (или layout()). */
function harness(opts: { layout?: (model: AnyRec, roomId: string) => unknown; normalizeTransform?: (m: AnyRec) => void; offline?: boolean } = {}): Harness {
  const server = { saveId: "s1", model: baseModel() as unknown as AnyRec };
  const calls = { layout: 0, args: [] as Array<{ roomId: string }> };
  let normalized: AnyRec | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m) as AnyRec;
      opts.normalizeTransform?.(normalized);
      const walls = Object.keys((m as AnyRec)["walls"] as AnyRec).length;
      const c = { walls, holes: 0, items: 0 };
      return { model: structuredClone(normalized), rooms: [], before: c, after: c };
    },
    async prsLayout(model, roomId) {
      calls.layout++;
      calls.args.push({ roomId });
      if (opts.layout) return opts.layout(model, roomId) as PrsLayoutRaw;
      return structuredClone(REF.editor_layout);
    },
    async save() {
      server.model = structuredClone(normalized!);
      server.saveId = `s${Math.random()}`;
      return { ok: true, saveId: server.saveId, conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return COMPAT as never; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] } as never,
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: server.saveId, units: "cm", data_empty: false, model: structuredClone(server.model) } as LoadedModel;
    },
    async openEditor() { return editor; },
  };
  return { ws: new Workspace(deps, { offline: opts.offline ?? false }), server, calls };
}

function roomOf(m: Model | AnyRec, id = R1): AnyRec {
  return (((m as AnyRec)["rooms2"] as AnyRec)[id] ?? {}) as AnyRec;
}

const isCode = (code: string) => (e: unknown): boolean => e instanceof McpError && e.code === code;

// ---------- полный путь через Workspace + офлайн-эталон ----------

test("406: room_prs_layout — полный путь через Workspace: раскладка редактора записана, ответ — формат API (мм, W<n>, сторона)", async () => {
  const { ws, calls } = harness();
  await ws.open("0", "1");
  assert.equal(hasRealPrsLayout(roomOf(ws.model) as never), false, "до раскладки edges_prs пуст");
  const histBefore = ws.historyInfo().steps;
  const res = await ws.prsLayout(REF.room);
  assert.equal(res.created, true);
  assert.equal(res.room, "R1");
  assert.equal(res.site_id, R1);
  assert.deepEqual(res.lines, REF.expected_lines, "офлайн-эталон ответа");
  assert.equal(calls.layout, 1);
  assert.deepEqual(calls.args, [{ roomId: R1 }], "в страницу передан проверенный id комнаты из модели, а не строка входа");
  // формат редактора не протекает в ответ
  const json = JSON.stringify(res);
  for (const leak of ["oid", "_pl00", "\"p1\"", "\"pc\"", "\"prs\"", "id_of_edges", "edges_prs"]) {
    assert.ok(!json.includes(leak), `в ответе нет ${leak}: ${json}`);
  }
  // в модели — раскладка редактора
  const room = roomOf(ws.model);
  assert.deepEqual((room["edges_prs"] as AnyRec[]).map((e) => e["oid"]), ["_pl001", "_pl002", "_pl003", "_pl004"]);
  assert.deepEqual(room["id_of_edges"], ["_pl001", "_pl002", "_pl003", "_pl004"]);
  assert.equal(ws.historyInfo().steps, histBefore + 1, "снимок истории — undo откатывает раскладку");
  assert.equal(ws.project?.dirty, true, "рабочая копия изменена; на сайт — только project_save");
});

test("406: no-op — раскладка уже есть: created:false, редактор не вызывается, модель не меняется", async () => {
  const { ws, calls } = harness();
  await ws.open("0", "1");
  await ws.prsLayout("R1");
  const snap = JSON.stringify(ws.model);
  const steps = ws.historyInfo().steps;
  const again = await ws.prsLayout(R1);
  assert.equal(again.created, false);
  assert.match(again.message, /уже есть/);
  assert.deepEqual(again.lines, REF.expected_lines);
  assert.equal(calls.layout, 1, "второй вызов редактор не трогает");
  assert.equal(JSON.stringify(ws.model), snap);
  assert.equal(ws.historyInfo().steps, steps);
});

test("406: несуществующая комната / терраса — INVALID_ARGUMENT до запуска редактора", async () => {
  const { ws, calls } = harness();
  await ws.open("0", "1");
  for (const ref of ["R99", "_nope1", "R0", "<img src=x>"]) {
    await assert.rejects(() => ws.prsLayout(ref), isCode("INVALID_ARGUMENT"), ref);
  }
  ws.apply("test", (m) => { roomOf(m)["role"] = "terrace"; });
  await assert.rejects(() => ws.prsLayout("R1"), isCode("INVALID_ARGUMENT"), "терраса");
  assert.equal(calls.layout, 0, "редактор не вызывался");
});

test("406: офлайн-режим — INVALID_ARGUMENT (раскладку строит только редактор), модель не меняется", async () => {
  const { ws } = harness({ offline: true });
  await ws.open("0", "1");
  const snap = JSON.stringify(ws.model);
  await assert.rejects(() => ws.prsLayout("R1"), isCode("INVALID_ARGUMENT"));
  assert.equal(JSON.stringify(ws.model), snap);
});

// ---------- атомарность: некорректный ответ страницы ----------

test("406: некорректный ответ страницы — INTERNAL, рабочая модель и история не меняются", async () => {
  const ok = REF.editor_layout;
  const lines = (): AnyRec[] => structuredClone(ok.edges_prs) as AnyRec[];
  const cases: Array<[string, unknown]> = [
    ["edges_prs не массив", { edges_prs: {}, id_of_edges: [] }],
    ["пусто", { edges_prs: [], id_of_edges: [] }],
    ["id_of_edges не совпадает", { edges_prs: lines(), id_of_edges: ["_pl001", "_pl002", "_pl003", "_xxxxx"] }],
    ["oid повторяется", { edges_prs: lines().map((e) => ({ ...e, oid: "_pl001" })), id_of_edges: ["_pl001", "_pl001", "_pl001", "_pl001"] }],
    ["oid не формата", { edges_prs: lines().map((e, i) => (i === 0 ? { ...e, oid: "<b>" } : e)), id_of_edges: ["<b>", "_pl002", "_pl003", "_pl004"] }],
    ["edge_index вне рёбер", { edges_prs: lines().map((e, i) => (i === 0 ? { ...e, edge_index: 9 } : e)), id_of_edges: ok.id_of_edges }],
    ["линия не на своём ребре", { edges_prs: lines().map((e, i) => (i === 0 ? { ...e, edge_index: 1 } : e)), id_of_edges: ok.id_of_edges }],
    ["координата не конечна", { edges_prs: lines().map((e, i) => (i === 0 ? { ...e, p1: { x: null, y: 0 } } : e)), id_of_edges: ok.id_of_edges }],
  ];
  for (const [label, raw] of cases) {
    const { ws } = harness({ layout: () => raw });
    await ws.open("0", "1");
    const snap = JSON.stringify(ws.model);
    const steps = ws.historyInfo().steps;
    await assert.rejects(() => ws.prsLayout("R1"), isCode("INTERNAL"), label);
    assert.equal(JSON.stringify(ws.model), snap, `${label}: модель не изменена`);
    assert.equal(ws.historyInfo().steps, steps, `${label}: история не изменена`);
  }
});

test("406: ответ страницы — только edges_prs/id_of_edges комнаты; лишние поля и pillars не протекают", () => {
  const m = baseModel();
  const raw = structuredClone(REF.editor_layout) as { edges_prs: AnyRec[]; id_of_edges: string[] };
  raw.edges_prs[0]!["evil"] = "<script>";
  applyPrsLayout(m, R1, raw);
  const line0 = (roomOf(m)["edges_prs"] as AnyRec[])[0]!;
  assert.deepEqual(Object.keys(line0).sort(), ["edge_index", "oid", "p1", "p2", "pillars"]);
  // другие комнаты не тронуты
  for (const [rid, r] of Object.entries(m.rooms2 as AnyRec)) {
    if (rid === R1) continue;
    assert.deepEqual((r as AnyRec)["edges_prs"], [], `${rid} не тронута`);
  }
});

// ---------- prs_set после раскладки — реальные oid ----------

test("406: prs_set после раскладки пишет ключи = реальные oid edges_prs; без раскладки — отказ с указанием на room_prs_layout", async () => {
  const { ws } = harness();
  await ws.open("0", "1");
  await assert.rejects(
    async () => ws.apply("prs_set", (m) => setPrsSettings(m, "R1", { hideWalls: ["W5"] })),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && /room_prs_layout/.test(e.message),
  );
  await ws.prsLayout("R1");
  const res = ws.apply("prs_set", (m) => setPrsSettings(m, "R1", { hideWalls: ["W5"], firstWall: "W6" }));
  assert.deepEqual(res.disabled_edges, [1]);
  assert.equal(res.first_edge, 0);
  const room = roomOf(ws.model);
  assert.deepEqual(Object.keys(room["prs_disabled"] as AnyRec), ["_pl002"], "ключ скрытия — oid редактора ребра W5");
  assert.equal(room["prs_first"], "_pl001");
  assert.ok(!JSON.stringify(room).includes("derived_"), "синтетических ключей нет");
});

// ---------- сверка save ----------

test("406: save после раскладки и prs_set — verified, без NORMALIZATION_DROPPED; на сервере ключи = oid edges_prs", async () => {
  const { ws, server } = harness();
  await ws.open("0", "1");
  await ws.prsLayout("R1");
  ws.apply("prs_set", (m) => setPrsSettings(m, "R1", { hideWalls: ["W5"] }));
  const out = await ws.save();
  assert.equal(out.verified, true, `save verified: ${JSON.stringify(out.warnings)}`);
  const room = roomOf(server.model);
  const oids = (room["edges_prs"] as AnyRec[]).map((e) => e["oid"]);
  assert.deepEqual(room["id_of_edges"], oids);
  for (const k of Object.keys(room["prs_disabled"] as AnyRec)) assert.ok(oids.includes(k), `ключ ${k} — oid edges_prs`);
});

test("406: сверка save — раскладка потеряна (edges_prs обнулён у той же комнаты) — расхождение", () => {
  const m = baseModel();
  applyPrsLayout(m, R1, structuredClone(REF.editor_layout));
  const after = structuredClone(m);
  roomOf(after)["edges_prs"] = [];
  roomOf(after)["id_of_edges"] = [];
  const out = prsSettingsMismatches(m.rooms2 as never, after.rooms2 as never, m.walls as never);
  assert.equal(out.problems.length, 1, JSON.stringify(out));
  assert.match(out.problems[0]!, /раскладка развёрток потеряна/);
  // раскладка не было и нет — не расхождение
  assert.deepEqual(prsSettingsMismatches(baseModel().rooms2 as never, baseModel().rooms2 as never).problems, []);
});

test("406: save — редактор при нормализации потерял раскладку — save не verified", async () => {
  const { ws } = harness({ normalizeTransform: (m) => { roomOf(m)["edges_prs"] = []; roomOf(m)["id_of_edges"] = []; } });
  await ws.open("0", "1");
  await ws.prsLayout("R1");
  await assert.rejects(() => ws.save(), (e: unknown) => e instanceof McpError && /раскладка развёрток потеряна/.test(JSON.stringify(e.details ?? e.message)));
});

// ---------- адаптер: гарды ----------

test("406: адаптер prsLayout — опасная модель и id комнаты не формата редактора — отказ до page.evaluate", async () => {
  let evalCalls = 0;
  const page = { async evaluate(): Promise<unknown> { evalCalls++; return {}; } };
  const handle = buildHandle(page as never, { close: async () => {} }, "123", "1", COMPAT as never, { acquire: async () => {} });
  const evil = baseModel() as AnyRec;
  evil["custom_plans"] = { sh1: { id: "sh1", name: "<img src=x onerror=alert(1)>", plan: "a", date: "", order: 0 } };
  await assert.rejects(() => handle.prsLayout(evil, R1), isCode("INVALID_ARGUMENT"), "assertModelSafeForEditor");
  for (const bad of ["a'); alert(1); ('", "<b>", "", "x".repeat(65)]) {
    await assert.rejects(() => handle.prsLayout(baseModel() as AnyRec, bad), isCode("INVALID_ARGUMENT"), JSON.stringify(bad));
  }
  assert.equal(evalCalls, 0, "в страницу ничего не передавалось");
});

test("406: адаптер prsLayout — id комнаты уходит в страницу только аргументом (данные), ответы missing/layoutError — ошибки", async () => {
  const evaluated: unknown[] = [];
  let reply: unknown = { edges_prs: [], id_of_edges: [] };
  const page = {
    async evaluate(fn: unknown, arg?: unknown): Promise<unknown> {
      evaluated.push(arg === undefined ? fn : arg);
      if (typeof fn === "string" && fn.includes("createEdgesPrs")) return reply;
      return undefined;
    },
  };
  const handle = buildHandle(page as never, { close: async () => {} }, "123", "1", COMPAT as never, { acquire: async () => {} });
  await handle.prsLayout(baseModel() as AnyRec, R1);
  const scripts = evaluated.filter((x): x is string => typeof x === "string");
  assert.ok(scripts.every((s) => !s.includes(R1)), "id комнаты не попадает в код страницы");
  assert.ok(evaluated.some((x) => typeof x === "object" && x !== null && (x as AnyRec)["roomId"] === R1), "id — аргументом");
  reply = { missing: true };
  await assert.rejects(() => handle.prsLayout(baseModel() as AnyRec, R1), isCode("INVALID_ARGUMENT"));
  reply = { layoutError: "createEdgesPrs", name: "TypeError" };
  await assert.rejects(() => handle.prsLayout(baseModel() as AnyRec, R1), isCode("INTERNAL"));
});

// ---------- инструмент ----------

test("406: инструмент room_prs_layout — офлайн-фикстура без раскладки: INVALID_ARGUMENT; неизвестная комната", async () => {
  const ctx = new ServerContext({ offlineFixture: join(here, "../fixtures/editor-corridor-3rooms.json") });
  const tools = planTools(ctx);
  assert.ok(tools["room_prs_layout"], "инструмент в реестре");
  const res = await tools["room_prs_layout"]!.handler({ room: "R1" });
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(res), /INVALID_ARGUMENT/);
  const missing = await tools["room_prs_layout"]!.handler({ room: "R42" });
  assert.match(JSON.stringify(missing), /INVALID_ARGUMENT/);
});
