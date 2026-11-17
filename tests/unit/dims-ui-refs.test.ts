// 113: тесты раздела «Размеры и комментарии» — эталоны UI в обе стороны, атомарность,
// привязки при операциях с предметами, удаление, цепочки, mock save (подмена
// writeBackup/loadModel/openEditor), реестр clear, экранирование текста.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model, RulerEntity, CommentEntity } from "../../src/model/types.ts";
import {
  addRuler, updateRuler, deleteRuler, addComment, updateComment, deleteComment,
  dimsList, commentsList, rulerMismatches, commentMismatches, dimsMismatches,
  detachRulerItemTargets, rulersReferencingItem, itemComments,
  escapeCommentText, unescapeCommentText,
  RULER_LENGTH_MIN_CM, RULER_LENGTH_MAX_CM, COMMENT_TEXT_MAX,
} from "../../src/model/dims.ts";
import { addItem, updateItem, deleteItem } from "../../src/model/items.ts";
import { clearEntityCollections } from "../../src/model/collections.ts";
import { Workspace, type WorkspaceDeps } from "../../src/workspace.ts";
import type { EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;
const RULER_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-dims-ruler.json", "utf8")) as Record<string, unknown>;
const RULER_ATTACHED_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-dims-ruler-attached.json", "utf8")) as Record<string, unknown>;
const COMMENT_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-dims-comment.json", "utf8")) as Record<string, unknown>;

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

const P = (x: number, y: number) => ({ x, y });

/** Фикстура «коридор + 3 комнаты» предметов не содержит — синтетический диван как в эталоне UI. */
function ensureItem(m: Model, pc = { x: 150, y: -150 }): string {
  const id = "i_test";
  m.items[id] = {
    id, name: "sofa", pc: { ...pc }, angle: 0, width: 90, height: 80, self_height: 85,
    plan: { furniture: 6 }, id_room: null, id_wall: null, layer: null, comment: { id: "" },
  } as unknown as import("../../src/model/types.ts").ItemProps;
  return id;
}

function firstItemId(m: Model): string {
  const id = Object.keys(m.items)[0];
  assert.ok(id, "в фикстуре есть предмет");
  return id!;
}

// ---------- эталоны UI ----------

test("113: эталон UI — свободный размер совпадает с канонической записью dim_add (в обе стороны)", () => {
  const m = baseModel();
  m.rulers = {};
  const made = addRuler(m, {
    p1: { x: 0, y: -3000 }, p2: { x: 3000, y: -3000 },
    sheet: "a",
  });
  const expected = { ...structuredClone(RULER_REF) } as Record<string, unknown>;
  delete expected._source;
  const got = { ...structuredClone(made) } as Record<string, unknown>;
  got.id = expected.id;
  assert.deepEqual(got, expected, `каноническая запись = эталон UI:\n${JSON.stringify(got)}\nvs\n${JSON.stringify(expected)}`);
  // обратная сторона: эталон против канонической записи — сверка без расхождений
  const m2 = baseModel();
  m2.rulers = { [RULER_REF.id as string]: structuredClone(RULER_REF) as unknown as RulerEntity };
  assert.deepEqual(rulerMismatches(m2.rulers as Record<string, RulerEntity>, { [RULER_REF.id as string]: RULER_REF }), []);
});

test("113: эталон UI — размер с привязкой к предмету (p2_target) воспроизводится dim_add attach", () => {
  const m = baseModel();
  m.rulers = {};
  const itemId = ensureItem(m);
  const item = m.items[itemId]!;
  // центр предмета и план — подгоняем под эталон (эталон снят на диване 90×80 в (150,-150))
  item.pc = { x: 150, y: -150 };
  item.name = "sofa";
  item.plan = { furniture: 6 };
  item.angle = 0;
  const made = addRuler(m, {
    p1: { x: 1500, y: -3200 }, p2: { x: 1500, y: -1900 },
    attach2: itemId, sheet: "furniture",
  });
  const got = structuredClone(made) as unknown as Record<string, unknown>;
  const expected = structuredClone(RULER_ATTACHED_REF) as Record<string, unknown>;
  delete expected._source;
  got.id = expected.id;
  const tGot = { ...(got.p2_target as Record<string, unknown>) };
  const tExp = { ...(expected.p2_target as Record<string, unknown>) };
  tGot.target_id = tExp.target_id;
  (got as Record<string, unknown>)["p2_target"] = tGot;
  assert.deepEqual(got, expected);
});

test("113: эталон UI — комментарий (label free, font_size 10, framed true) воспроизводится comment_add", () => {
  const m = baseModel();
  m.comments = {};
  const made = addComment(m, {
    point: { x: 2500, y: -1000 },
    text: "Проба 113",
    pc: { x: 3041.7, y: -1445 },
  });
  const got = structuredClone(made) as unknown as Record<string, unknown>;
  const expected = structuredClone(COMMENT_REF) as Record<string, unknown>;
  delete expected._source;
  got.id = expected.id;
  assert.deepEqual(got, expected);
});

// ---------- состав, атомарность, лимиты ----------

test("113: атомарность — неизвестный предмет привязки и длина вне 5..5000 см отклоняются, модель не меняется", () => {
  const m = baseModel();
  const before = structuredClone(m);
  assert.throws(() => addRuler(m, { p1: P(0, -3000), p2: P(3000, -3000), attach1: "нет_такого" }), /NOT_FOUND|не найден/);
  assert.throws(() => addRuler(m, { p1: P(0, 0), p2: P(10, 0) }), /длину|диапазон/);
  assert.throws(() => addRuler(m, { p1: P(0, 0), p2: P(60000, 0) }), /диапазон/);
  assert.throws(() => addComment(m, { point: P(0, 0), text: "" }), /текст/);
  assert.throws(() => addComment(m, { point: P(0, 0), text: "x".repeat(COMMENT_TEXT_MAX + 1) }), /600/);
  assert.throws(() => addComment(m, { point: P(0, 0), text: "т", fontSize: 7 }), /шрифта/);
  assert.throws(() => addComment(m, { point: P(0, 0), text: "т", url: "javascript:alert(1)" }), /http/);
  assert.deepEqual(m, before, "модель не изменилась");
});

test("113: длина размера — границы 5..5000 см (меню «Задать длину») принимаются, вырожденная — нет", () => {
  const m = baseModel();
  m.rulers = {};
  const lo = addRuler(m, { p1: P(0, 0), p2: { x: 0, y: RULER_LENGTH_MIN_CM * 10 } });
  assert.ok(lo.id);
  const hi = addRuler(m, { p1: P(0, 0), p2: { x: RULER_LENGTH_MAX_CM * 10, y: 0 } });
  assert.ok(hi.id);
  assert.throws(() => addRuler(m, { p1: P(0, 0), p2: P(0, 49) }));
  assert.throws(() => updateRuler(m, { rulerId: lo.id, p2: P(0, 30) }), /диапазон/);
});

// ---------- update / delete / цепочки / привязки ----------

test("113: dim_update — перенос конца обновляет смещение привязки; attach2 null отвязывает; длина проверяется", () => {
  const m = baseModel();
  m.rulers = {};
  const itemId = ensureItem(m);
  const item = m.items[itemId]!;
  const r = addRuler(m, { p1: P(1000, -2000), p2: P(1500, -1900), attach2: itemId });
  assert.ok(r.p2_target);
  updateRuler(m, { rulerId: r.id, p2: P(1600, -1900) });
  assert.equal(r.p2!.x, 160);
  assert.equal(r.p2_target!.point_delta_x, Math.round((item.pc.x - 160) * 100) / 100);
  updateRuler(m, { rulerId: r.id, attach2: null });
  assert.equal(r.p2_target, null);
  assert.throws(() => updateRuler(m, { rulerId: r.id, p2: P(1001, -2000) }), /диапазон/);
});

test("113: dim_delete — цепочка: привязка «ruler» у другого размера снимается", () => {
  const m = baseModel();
  m.rulers = {
    r1: { id: "r1", p1: P(0, 0), p2: P(100, 0), offset: { val: 0, side: "a" }, plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, p2_target: null, color: "#ed143d" },
    r2: { id: "r2", p1: P(100, 0), p2: P(200, 0), offset: { val: 0, side: "a" }, plan: "a", plan_: 0, prs: { room: 0, mode: 1 },
      p2_target: { target_id: "r1", target_name: "ruler", target_plan: {}, target_angle: 0, point_delta_x: 0, point_delta_y: 0 }, color: "#ed143d" },
  } as unknown as Record<string, RulerEntity>;
  deleteRuler(m, "r1");
  assert.equal(m.rulers!["r1"], undefined);
  assert.equal(m.rulers!["r2"]!.p2_target, null, "висячей привязки к удалённому размеру нет");
  assert.throws(() => deleteRuler(m, "r1"), /NOT_FOUND|не найден/);
});

test("113: перенос предмета (item_update) — привязанный размер следует за ним по формуле редактора", () => {
  const m = baseModel();
  m.rulers = {};
  const itemId = ensureItem(m);
  const item = m.items[itemId]!;
  item.pc = { x: 150, y: -150 };
  item.angle = 0;
  item.name = "sofa";
  item.plan = { furniture: 6 };
  const r = addRuler(m, { p1: P(1500, -3200), p2: P(1500, -1900), attach2: itemId, sheet: "furniture" });
  // перенос +100x, +30y и поворот на 90°: delta (0,40) поворачивается на -90° и смещается
  updateItem(m, { itemId, center: { x: 2500, y: -1200 }, angleDeg: 90 });
  // формула Ruler.update: dAngle = target_angle − angle = 0 − 90 = −90°
  const d = (-90 * Math.PI) / 180;
  const dx = 0 * Math.cos(d) + 40 * Math.sin(d);
  const dy = -0 * Math.sin(d) + 40 * Math.cos(d);
  assert.deepEqual(r.p2, { x: Math.round((item.pc.x - dx) * 100) / 100, y: Math.round((item.pc.y - dy) * 100) / 100 });
  assert.equal(r.p2_target!.target_angle, 90);
  assert.equal(r.p2_target!.point_delta_x, Math.round((item.pc.x - r.p2!.x) * 100) / 100);
  assert.equal(r.p2_target!.point_delta_y, Math.round((item.pc.y - r.p2!.y) * 100) / 100);
});

test("113: удаление предмета (item_delete) — привязки размеров снимаются (геометрия сохраняется), комментарий предмета удаляется каскадно", () => {
  const m = baseModel();
  m.rulers = {};
  m.comments = {};
  const itemId = ensureItem(m);
  const item = m.items[itemId]!;
  item.pc = { x: 150, y: -150 };
  const r = addRuler(m, { p1: P(1000, -2000), p2: P(1500, -1900), attach2: itemId });
  const c = addComment(m, { point: P(1500, -1500), text: "к предмету", attachItem: itemId });
  assert.equal(c.label, "item");
  assert.equal(c.id_item, itemId);
  const out = deleteItem(m, itemId);
  assert.deepEqual(out.detached_rulers, [r.id]);
  assert.deepEqual(out.deleted_comments, [c.id]);
  assert.equal(r.p2_target, null);
  assert.equal(m.comments![c.id], undefined, "комментарий предмета удалён");
  assert.equal(m.items[itemId], undefined);
});

test("113: комментарий предмета следует за предметом при item_update", () => {
  const m = baseModel();
  m.comments = {};
  const itemId = ensureItem(m);
  const c = addComment(m, { point: P(1500, -1500), text: "тут", attachItem: itemId });
  updateItem(m, { itemId, center: { x: 2000, y: -1200 } });
  assert.deepEqual(c.points, [{ x: 200, y: -120 }]);
});

test("113: у предмета один комментарий (как в редакторе — comment_already_exist)", () => {
  const m = baseModel();
  m.comments = {};
  const itemId = ensureItem(m);
  addComment(m, { point: P(1500, -1500), text: "первый", attachItem: itemId });
  assert.throws(() => addComment(m, { point: P(1600, -1500), text: "второй", attachItem: itemId }), /уже|comment/);
});

test("113: comment_delete снимает обратную ссылку предмета (props.comment.id)", () => {
  const m = baseModel();
  m.comments = {};
  const itemId = ensureItem(m);
  m.items[itemId]!.comment = { id: "" };
  const c = addComment(m, { point: P(1500, -1500), text: "т", attachItem: itemId });
  assert.equal((m.items[itemId]!.comment as { id: string }).id, c.id);
  deleteComment(m, c.id);
  assert.equal((m.items[itemId]!.comment as { id: string }).id, "");
});

test("113: экранирование текста (' → `, \" → ``) — как Comments.copy(\"server\")/restore редактора", () => {
  assert.equal(escapeCommentText("it's \"ok\""), "it`s ``ok``");
  assert.equal(unescapeCommentText("it`s ``ok``"), "it's ''ok''");
  const m = baseModel();
  m.comments = {};
  const c = addComment(m, { point: P(0, 0), text: "it's \"ok\"" });
  assert.equal(c.text, "it`s ``ok``");
  assert.deepEqual(commentsList(m)[0]!.text, "it's ''ok''");
});

test("113: detachRulerItemTargets/rulersReferencingItem — поиск и снятие привязок к предмету", () => {
  const m = baseModel();
  m.rulers = {};
  const itemId = ensureItem(m);
  const r1 = addRuler(m, { p1: P(1000, -2000), p2: P(1500, -1900), attach2: itemId });
  const r2 = addRuler(m, { p1: P(0, -3000), p2: P(3000, -3000) });
  assert.deepEqual(rulersReferencingItem(m, itemId).map((x) => x.id), [r1.id]);
  assert.deepEqual(detachRulerItemTargets(m, itemId), [r1.id]);
  assert.equal(r1.p2_target, null);
  assert.ok(r2.p2_target === null);
  assert.deepEqual(detachRulerItemTargets(m, itemId), []);
});

// ---------- списки ----------

test("113: dims_list/comments_list — мм, длины, метки привязок", () => {
  const m = baseModel();
  m.rulers = {};
  m.comments = {};
  const itemId = ensureItem(m);
  addRuler(m, { p1: P(0, -3000), p2: P(3000, -3000), attach1: itemId, offsetMm: 250, offsetSide: "l" });
  addComment(m, { point: P(2500, -1000), text: "текст", fontSize: 14, framed: false, url: "https://example.com/" });
  const dl = dimsList(m);
  assert.equal(dl.length, 1);
  assert.equal(dl[0]!.length_mm, 3000);
  assert.equal(dl[0]!.offset_mm, 250);
  assert.equal(dl[0]!.p1_target?.target_id, itemId);
  const cl = commentsList(m);
  assert.equal(cl.length, 1);
  assert.equal(cl[0]!.font_size, 14);
  assert.equal(cl[0]!.framed, false);
  assert.equal(cl[0]!.url, "https://example.com/");
  const p0 = cl[0]!.points[0]!;
  assert.deepEqual([p0.x * 10, p0.y * 10], [2500, -1000]);
});

// ---------- реестр коллекций ----------

test("113: реестр — project_clear оставляет rulers/comments пустыми (обязательные коллекции)", () => {
  const m = baseModel();
  m.rulers = {};
  m.comments = {};
  addRuler(m, { p1: P(0, -3000), p2: P(3000, -3000) });
  addComment(m, { point: P(0, 0), text: "x" });
  clearEntityCollections(m);
  assert.deepEqual(m.rulers, {});
  assert.deepEqual(m.comments, {});
});

// ---------- сверка ----------

test("113: сверка — потеря/подмена размера и комментария обнаруживается в обе стороны", () => {
  const m = baseModel();
  m.rulers = {};
  m.comments = {};
  addRuler(m, { p1: P(0, -3000), p2: P(3000, -3000) });
  addComment(m, { point: P(2500, -1000), text: "т" });
  // нормализация потеряла размер
  let d = dimsMismatches(m, { rulers: {}, comments: structuredClone(m.comments) });
  assert.ok(d.some((s) => s.includes("потерян")));
  // сервер подменил концы
  const got = structuredClone(m) as unknown as Record<string, unknown>;
  const ruler = Object.values(m.rulers!)[0]!;
  (got.rulers as Record<string, RulerEntity>)[ruler.id]!.p2 = { x: 350, y: -300 };
  d = dimsMismatches(m, got);
  assert.ok(d.some((s) => s.includes("концы")));
  // подмена текста комментария
  const got2 = structuredClone(m) as unknown as Record<string, unknown>;
  const comment = Object.values(m.comments!)[0]!;
  (got2.comments as Record<string, CommentEntity>)[comment.id]!.text = "другой";
  d = dimsMismatches(m, got2);
  assert.ok(d.some((s) => s.includes("текст")));
  // пустые модели — без расхождений
  const m2 = baseModel();
  assert.deepEqual(dimsMismatches(m2, { rulers: {}, comments: {} }), []);
});

test("113: сверка — допустимая нормализация (округление fixPoint до 0,1 мм) не блокирует", () => {
  const m = baseModel();
  m.rulers = {};
  const r = addRuler(m, { p1: P(0, -3000), p2: P(2999.96, -3000) });
  const got = structuredClone(m) as unknown as Record<string, unknown>;
  (got.rulers as Record<string, RulerEntity>)[r.id]!.p2 = { x: r.p2.x + 0.05, y: r.p2.y };
  assert.deepEqual(dimsMismatches(m, got), []);
});

// ---------- mock save ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
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

function modelWithDims(): Model {
  const m = baseModel();
  m.rulers = {};
  m.comments = {};
  const itemId = ensureItem(m);
  addRuler(m, { p1: P(0, -3000), p2: P(3000, -3000), attach1: itemId, offsetMm: 100 });
  addComment(m, { point: P(2500, -1000), text: "Проба 113", attachItem: itemId, fontSize: 12 });
  return m;
}

test("113: mock save — размеры и комментарии доходят до серверной модели, verified", async () => {
  const m = modelWithDims();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

test("113: mock save — нормализация потеряла размер → NORMALIZATION_DROPPED", async () => {
  const m = modelWithDims();
  const rulerId = Object.keys(m.rulers!)[0]!;
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    (norm["rulers"] as Record<string, unknown>) && delete (norm["rulers"] as Record<string, unknown>)[rulerId];
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), /NORMALIZATION_DROPPED|потерял объекты/);
});

test("113: mock save — сервер потерял комментарий после save → SITE_ERROR (dims_mismatches)", async () => {
  const m = modelWithDims();
  const commentId = Object.keys(m.comments!)[0]!;
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    (s.model["comments"] as Record<string, unknown>) && delete (s.model["comments"] as Record<string, unknown>)[commentId];
  });
  await ws.open("0", "1");
  await assert.rejects(async () => ws.save(), (e: Error) => {
    assert.match(e.message, /не совпала с рабочей копией/);
    const details = (e as Error & { details?: Record<string, unknown> }).details ?? {};
    const dm = details["dims_mismatches"] as string[] | undefined;
    assert.ok(Array.isArray(dm) && dm.some((p) => p.includes("комментарий")), JSON.stringify(details).slice(0, 400));
    return true;
  });
});
