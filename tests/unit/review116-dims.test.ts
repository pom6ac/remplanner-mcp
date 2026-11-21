// Этап 116: резолюция ревью 115 (R1–R4) — падающие на 698f081 репродукции.
// R1: канонизация текста комментария (" и ` меняются редактором при restore) —
//     warning в ответе + comments_list возвращает канонический текст;
// R2: dim_update пересчитывает цепочку размеров (p2_target → ruler) транзитивно;
// R3: comment_update(url:null) удаляет URL;
// R4: публичные enum (offset_side auto|left|right, sheet plan|furniture).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import type { Model, RulerEntity, CommentEntity } from "../../src/model/types.ts";
import {
  addRuler, updateRuler, addComment, updateComment, dimsMismatches, commentsList,
  escapeCommentText, unescapeCommentText,
} from "../../src/model/dims.ts";
import { sheetPublic, commentTextWarnings } from "../../src/dto/dims.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

async function start(): Promise<Client> {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "review116", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as ToolCallResult).content as { text: string }[])[0]!.text;

/** Модель для comment-тестов модельного слоя (PRO-гейт comments проверяется в pro-gate.test.ts). */
function baseCommentModel(): Model {
  const m = JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model };
  const model = m.model;
  model.comments = {};
  return model;
}

// ---------- R1: канонизация текста комментария ----------

test("116 R1: comment_add с двойными кавычками — канонический текст и warning (модельный слой; PRO-гейт comments — pro-gate.test.ts)", () => {
  const m = baseCommentModel();
  const comment = addComment(m, { point: { x: 100, y: 100 }, text: 'say "ok"' });
  const warnings = commentTextWarnings('say "ok"', comment.text);
  assert.equal(unescapeCommentText(comment.text), "say ''ok''", "в записи — итоговый (канонический) текст");
  assert.ok(warnings.length > 0 && warnings.some((w) => w.includes("''ok''")), `warning о канонизации: ${JSON.stringify(warnings)}`);
  const listed = commentsList(m);
  assert.equal(listed[0]!.text, "say ''ok''", "commentsList возвращает ровно сохраняемый (отображаемый) текст");
});

test("116 R1: comment_add с обратным апострофом — канонизируется в апостроф с warning", () => {
  const m = baseCommentModel();
  const comment = addComment(m, { point: { x: 100, y: 100 }, text: "a`b" });
  const warnings = commentTextWarnings("a`b", comment.text);
  assert.equal(unescapeCommentText(comment.text), "a'b");
  assert.ok(warnings.length > 0);
  assert.equal(commentsList(m)[0]!.text, "a'b");
});

test("116 R1: comment_update с кавычками — канонизация и warning; текст без спецсимволов — без warning", () => {
  const m = baseCommentModel();
  const added = addComment(m, { point: { x: 100, y: 100 }, text: "первый" });
  const upd = updateComment(m, { commentId: added.id, text: 'его "текст"' });
  assert.equal(unescapeCommentText(upd.text), "его ''текст''");
  assert.ok(commentTextWarnings('его "текст"', upd.text).length > 0);
  const upd2 = updateComment(m, { commentId: added.id, text: "обычный текст" });
  assert.equal(commentTextWarnings("обычный текст", upd2.text).length, 0, "канонизация не меняет текст — warning нет");
});

test("116 R1: mock save — комментарий канонизируется, сверка по отображаемому тексту не блокирует штатный save", async () => {
  const m = JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model };
  const model = m.model;
  model.rulers = {};
  model.comments = {};
  addComment(model, { point: { x: 100, y: 100 }, text: 'say "ok"' });
  const server: { saveId: string; model: Record<string, unknown> } = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMockWithRestore(server);
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

/** Mock save с документированным поведением редактора: restore показывает
 *  unescapeCommentText(текст) (проба 113-dims-escape), normalize возвращает
 *  отображаемую форму, сервер хранит copy("server") — байтово стабильную. */
function saveMockWithRestore(server: { saveId: string; model: Record<string, unknown> }): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm as object) as Record<string, unknown>;
      const comments = (normalized as Record<string, unknown>)["comments"] as Record<string, { text: string }> | undefined;
      if (comments) for (const c of Object.values(comments)) c.text = unescapeCommentText(c.text);
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      // сервер хранит copy("server") — байты совпадают с канонической записью
      const copy = structuredClone(normalized!);
      const comments = copy["comments"] as Record<string, { text: string }> | undefined;
      if (comments) for (const c of Object.values(comments)) c.text = escapeCommentText(c.text);
      server.model = copy;
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() {
      return { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };
    },
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

// ---------- R2: транзитивный пересчёт цепочки размеров при dim_update ----------

/** Цепочка «Разделить на участки»: r2.p2_target → r1, r3.p2_target → r2. */
function chainModel(): Model {
  const m = JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model };
  const model = m.model;
  const base = { offset: { val: 0, side: "a" as const }, plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, color: "#ed143d" };
  model.rulers = {
    r1: { id: "r1", p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, p1_target: null, p2_target: null, ...base },
    r2: { id: "r2", p1: { x: 0, y: 100 }, p2: { x: 0, y: 0 }, p1_target: null,
      p2_target: { target_id: "r1", target_name: "ruler", target_plan: {}, target_angle: 0, point_delta_x: 0, point_delta_y: 0 }, ...base },
    r3: { id: "r3", p1: { x: 0, y: 200 }, p2: { x: 0, y: 100 }, p1_target: null,
      p2_target: { target_id: "r2", target_name: "ruler", target_plan: {}, target_angle: 0, point_delta_x: 0, point_delta_y: 0 }, ...base },
  } as unknown as Record<string, RulerEntity>;
  model.comments = {};
  return model;
}

test("116 R2: dim_update переносит p1 источника — конец цепочки (r2.p2) следует за ним", () => {
  const m = chainModel();
  updateRuler(m, { rulerId: "r1", p1: { x: 500, y: 0 } });
  assert.deepEqual(m.rulers!["r1"]!.p1, { x: 50, y: 0 });
  assert.deepEqual(m.rulers!["r2"]!.p2, { x: 50, y: 0 }, "r2.p2 следует за r1.p1 (checkLinkedRulers)");
});

test("116 R2: dim_update среднего звена — конец следующего размера (r3.p2) следует транзитивно", () => {
  const m = chainModel();
  updateRuler(m, { rulerId: "r2", p1: { x: 700, y: 100 } });
  assert.deepEqual(m.rulers!["r2"]!.p1, { x: 70, y: 10 });
  assert.deepEqual(m.rulers!["r3"]!.p2, { x: 70, y: 10 }, "r3.p2 следует за r2.p1");
});

test("116 R2: mock save после dim_update цепочки — verified, без ложной блокировки (NORMALIZATION_DROPPED)", async () => {
  const m = chainModel();
  updateRuler(m, { rulerId: "r1", p1: { x: 500, y: 0 } });
  const server: { saveId: string; model: Record<string, unknown> } = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMockPlain(server);
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, "пересчитанная цепочка сохраняется без расхождений");
  assert.equal(res.rounds, 1);
});

test("116 R2: dim_update p2 звена с привязкой p2_target→ruler двигает p1 источника (checkLinkedRulers(2))", () => {
  const m = chainModel();
  updateRuler(m, { rulerId: "r2", p2: { x: 300, y: 0 } });
  assert.deepEqual(m.rulers!["r1"]!.p1, { x: 30, y: 0 }, "общий конец цепочки: r1.p1 = r2.p2");
  assert.deepEqual(m.rulers!["r2"]!.p2, { x: 30, y: 0 });
});

test("116 R2: подмена концов цепочки сервером по-прежнему обнаруживается (не ослабляем сверку)", () => {
  const m = chainModel();
  updateRuler(m, { rulerId: "r1", p1: { x: 500, y: 0 } });
  const got = structuredClone(m) as unknown as Record<string, unknown>;
  (got.rulers as Record<string, RulerEntity>)["r2"]!.p2 = { x: 0, y: 0 };
  const d = dimsMismatches(m, got);
  assert.ok(d.some((s) => s.includes("r2") && s.includes("концы")), `подмена конца находится: ${JSON.stringify(d)}`);
});

/** Mock save без трансформаций (как в dims-ui-refs.test.ts); нормализатор
 *  редактора пересчитывает цепочки размеров (checkLinkedRulers: конец
 *  прицепленного следует за p1 источника) — как живой редактор. */
function saveMockPlain(server: { saveId: string; model: Record<string, unknown> }): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm as object) as Record<string, unknown>;
      const rulers = (normalized as Record<string, unknown>)["rulers"] as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number }; p2_target: { target_id: string; target_name: string } | null }> | undefined;
      if (rulers) {
        for (const r of Object.values(rulers)) {
          if (r.p2_target && r.p2_target.target_name === "ruler" && rulers[r.p2_target.target_id]) {
            r.p2 = { ...rulers[r.p2_target.target_id]!.p1 };
          }
        }
      }
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() {
      return { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };
    },
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

// ---------- R3: comment_update(url:null) удаляет URL ----------

test("116 R3: comment_update с url:null снимает ссылку, commentsList — url null", () => {
  const m = baseCommentModel();
  const added = addComment(m, { point: { x: 100, y: 100 }, text: "со ссылкой", url: "https://example.com/" });
  updateComment(m, { commentId: added.id, url: null });
  const listed = commentsList(m);
  assert.equal(listed[0]!.url ?? null, null, "URL удалён, а не остался прежним");
});

// ---------- R4: публичные enum ----------

test("116 R4: dim_add принимает offset_side left/right/auto и sheet plan — в модели формат редактора", async () => {
  const client = await start();
  const add = await client.callTool({ name: "dim_add", arguments: { p1: { x: 0, y: 0 }, p2: { x: 3000, y: 0 }, offset_mm: 250, offset_side: "left", sheet: "plan" } });
  assert.ok(!add.isError, `публичные значения принимаются: ${text(add)}`);
  const bad = await client.callTool({ name: "dim_add", arguments: { p1: { x: 0, y: 0 }, p2: { x: 3000, y: 0 }, offset_side: "a" } });
  assert.equal(bad.isError, true, "внутреннее значение «a» больше не публичный enum");
  await client.close();
});

test("116 R4: dims_list возвращает offset_side auto|left|right и sheet plan|furniture", async () => {
  const client = await start();
  await client.callTool({ name: "dim_add", arguments: { p1: { x: 0, y: 0 }, p2: { x: 3000, y: 0 }, offset_mm: 250, offset_side: "left", sheet: "furniture" } });
  await client.callTool({ name: "dim_add", arguments: { p1: { x: 0, y: 500 }, p2: { x: 3000, y: 500 } } });
  const list = await client.callTool({ name: "dims_list", arguments: {} });
  const dims = JSON.parse(text(list)) as { offset_side: string; sheet: string }[];
  assert.deepEqual(dims.map((d) => d.offset_side).sort(), ["auto", "left"]);
  assert.deepEqual(dims.map((d) => d.sheet).sort(), ["furniture", "plan"]);
  await client.close();
});

test("116 R4: comment_add принимает sheet plan; commentsList возвращает sheet plan", () => {
  const m = baseCommentModel();
  // модельный слой хранит внутренний sheet ("a"); публичный "plan" — sheetPublic (dto/dims)
  addComment(m, { point: { x: 100, y: 100 }, text: "т", sheet: "a" });
  assert.equal(sheetPublic(commentsList(m)[0]!.plan), "plan");
});

test("116 R4: dim_update принимает публичный offset_side (right), модель хранит формат редактора", async () => {
  const client = await start();
  const add = await client.callTool({ name: "dim_add", arguments: { p1: { x: 0, y: 0 }, p2: { x: 3000, y: 0 } } });
  const id = (JSON.parse(text(add)) as { id: string }).id;
  const upd = await client.callTool({ name: "dim_update", arguments: { dim_id: id, offset_mm: 100, offset_side: "right" } });
  assert.ok(!upd.isError, text(upd));
  const list = await client.callTool({ name: "dims_list", arguments: {} });
  assert.equal((JSON.parse(text(list)) as { offset_side: string }[])[0]!.offset_side, "right");
  await client.close();
});

void updateComment;
void addRuler;
