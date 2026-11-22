// Этап 375: нижняя панель и листы — пользовательские листы (custom_plans),
// «Нарисовать элемент» (freelines/thick_lines/free_figures, PRO) и изображения
// (pictures): модельный слой, эталоны в обе стороны, полный путь через
// Workspace (mock save) и мутационная чувствительность сверок.
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addSheet, updateSheet, deleteSheet, sheetPlanKey, sheetByName, SHEET_AFTER_PLANS, SHEET_CONTENT_KEYS } from "../../src/model/sheets.ts";
import { addFreeline, addThickLine, addFigure, updateLine, updateFigure, deleteLine, deleteFigure, FREE_FIGURE_TYPES, DEF_THICK_LINE_WIDTH_CM } from "../../src/model/draw.ts";
import { addPicture, updatePicture, deletePicture, parseImageSize, PICTURE_FIT_CM } from "../../src/model/pictures.ts";
import { entityCounts } from "../../src/model/collections.ts";
import { parseModelImport } from "../../src/model/import-schema.ts";
import { sheetUserMismatches, drawLineUserMismatches, figureUserMismatches, pictureUserMismatches } from "../../src/verify/draw.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PT = { x: 100, y: 100 };

function baseModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  const m = { ...structuredClone(model), walls: {} } as Model;
  addRoomRect(m, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  return m;
}

// ---------- листы: модельный слой ----------

test("375: sheet_add/update — поля CustomPlan, умолчания редактора, валидация", () => {
  const m = baseModel();
  const s = addSheet(m, { name: "  Мой лист  " });
  assert.equal(s.name, "Мой лист");
  assert.equal(s.after_plan, "create_walls", "умолчание редактора");
  assert.deepEqual(s.content, ["plan"], "умолчание редактора — content [plan]");
  assert.equal(s.date, Math.floor(Date.now() / 1000), "date — секунды (порядок вкладок)");
  assert.equal(sheetPlanKey(s.id), `custom_${s.id}`);
  assert.equal(sheetByName(m, "мой лист"), s, "лист ищется по имени без регистра");
  // обновление
  const u = updateSheet(m, s.id, { name: "Другой", afterPlan: "first", content: ["plan", "light"] });
  assert.equal(u.after_plan, "first");
  assert.deepEqual(u.content, ["plan", "light"]);
  // валидация: имя, after_plan, content
  assert.throws(() => addSheet(m, { name: " " }), (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT");
  assert.throws(() => addSheet(m, { name: "x".repeat(61) }), /до 60/);
  assert.throws(() => addSheet(m, { name: "ok", afterPlan: "нет_такого" }), /after_plan/);
  assert.throws(() => addSheet(m, { name: "ok", content: ["plan", "мусор"] }), /content/);
  assert.throws(() => updateSheet(m, "нет", { name: "x" }), (e: unknown) => (e as McpError).code === "NOT_FOUND");
  assert.ok(SHEET_AFTER_PLANS.includes("create_walls"));
  assert.deepEqual([...SHEET_CONTENT_KEYS].sort(), ["electro_points", "furniture_santeh", "light", "plan"].sort());
});

test("375: sheet_delete — каскад как CustomPlan.delete: объекты листа удаляются, чужие остаются", () => {
  const m = baseModel();
  const s = addSheet(m, { name: "Лист" });
  const planKey = sheetPlanKey(s.id);
  // объекты на листе и на исходном плане
  const fl = addFreeline(m, { points: [PT, { x: 200, y: 100 }], plan: planKey });
  const fig = addFigure(m, { type: "rect", center: PT, plan: planKey });
  const pic = addPicture(m, { url: "u1.png", center: PT, widthOriginalPx: 100, heightOriginalPx: 100, plan: planKey });
  const flOther = addFreeline(m, { points: [PT, { x: 300, y: 100 }], plan: "a" });
  m.comments = { c1: { id: "c1", pc: PT, points: [PT], text: "т", label: "free", plan: planKey, plan_: 0, prs: {} } } as never;
  m.rulers = { r1: { id: "r1", p1: PT, p2: { x: 110, y: 100 }, offset: { val: 5, side: "a" }, plan: planKey, plan_: 0, prs: {} } } as never;
  m.thick_lines = { tl1: { ...addFreeline(m, { points: [PT, { x: 400, y: 100 }], plan: planKey }), type: "thick_line" } } as never;
  const res = deleteSheet(m, s.id);
  assert.deepEqual(res.deleted, { comments: 1, free_figures: 1, pictures: 1, freelines: 2, thick_lines: 1, rulers: 1 });
  assert.equal((m.custom_plans as Record<string, unknown>)[s.id], undefined, "лист удалён");
  assert.equal((m.freelines as Record<string, unknown>)[fl.id], undefined);
  assert.equal((m.free_figures as Record<string, unknown>)[String(fig.id)], undefined);
  assert.equal((m.pictures as Record<string, unknown>)[pic.id], undefined);
  assert.equal((m.freelines as Record<string, unknown>)[flOther.id], flOther, "чужая линия на исходном плане осталась");
  assert.equal(Object.keys(m.comments as Record<string, unknown>).length, 0);
  assert.equal(Object.keys(m.rulers as Record<string, unknown>).length, 0);
  assert.throws(() => deleteSheet(m, s.id), (e: unknown) => (e as McpError).code === "NOT_FOUND");
});

// ---------- «Нарисовать элемент»: модельный слой ----------

test("375: freeline/thick_line — граф GraphLines, мм→см, ширина в matrix, валидация", () => {
  const m = baseModel();
  const fl = addFreeline(m, { points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 500 }], plan: "a", color: "#ff0000", typeStroke: "dash" });
  assert.equal(fl.type, "freeline");
  assert.equal(fl.length, 15, "длина в см модели: 1000+500 мм = 15 см");
  assert.equal(fl.plan, "a");
  assert.equal(fl.color_custom, "#ff0000");
  assert.equal(fl.type_stroke, "dash");
  assert.equal(fl.width_stroke, undefined, "умолчание редактора 1 — поле не пишется");
  assert.equal(fl.vertexes.length, 3);
  assert.equal(fl.matrix.length, 3);
  assert.deepEqual(fl.matrix[0]![1], { length: 1 });
  // thick line: ширина 300 мм = 30 см в ячейках matrix
  const tl = addThickLine(m, { points: [{ x: 0, y: 0 }, { x: 2000, y: 0 }], widthMm: 300, plan: "a" });
  assert.equal(tl.type, "thick_line");
  assert.deepEqual(tl.matrix[0]![1], { length: 1, width: 30 });
  assert.equal(tl.on_width, 1);
  // умолчание бандла: ширина 20 см (widthDef), on_width 0 — ячейки без width
  const tlDefault = addThickLine(m, { points: [{ x: 0, y: 0 }, { x: 2000, y: 0 }], plan: "a" });
  assert.deepEqual(tlDefault.matrix[0]![1], { length: 1 });
  assert.equal(tlDefault.on_width, 0);
  assert.equal(DEF_THICK_LINE_WIDTH_CM, 20);
  // обновление: ширина перекидывает ВСЕ ячейки, цвет null снимает
  const u = updateLine(m, "thick_lines", tl.id, { widthMm: 100, color: null, plan: "furniture" });
  assert.deepEqual(u.matrix[0]![1], { length: 1, width: 10 });
  assert.equal(u.color_custom, undefined);
  assert.equal(u.plan, "furniture");
  // валидация
  assert.throws(() => addFreeline(m, { points: [{ x: 0, y: 0 }], plan: "a" }), /минимум 2 точки/);
  assert.throws(() => addFreeline(m, { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], plan: "a", color: "red" }), /hex/);
  assert.throws(() => addFreeline(m, { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], plan: "a", typeStroke: "wavy" as never }), /type_stroke/);
  assert.throws(() => deleteLine(m, "freelines", "нет"), (e: unknown) => (e as McpError).code === "NOT_FOUND");
});

test("375: figure — типы бандла, умолчания 500×500 мм, radius/rotated, валидация", () => {
  const m = baseModel();
  const f = addFigure(m, { type: "rect_round", center: PT, plan: "a" });
  assert.equal(f.width, 50, "умолчание бандла 50 см = 500 мм");
  assert.equal(f.height, 50);
  assert.equal(f.radius, 5, "rect_round — radius 5");
  assert.equal(f.rotated, 0);
  assert.equal(f.color, "#148515");
  const f2 = addFigure(m, { type: "hexagon", center: PT, widthMm: 600, heightMm: 400, angleDeg: 45, plan: "a" });
  assert.equal(f2.width, 60);
  assert.equal(f2.height, 40);
  assert.equal(f2.angle, 45);
  assert.equal(f2.rotated, 1, "angle ≠ 0 → rotated 1 (конструктор бандла)");
  void (f2.id as string);
  assert.equal(f2.radius, 0);
  const u = updateFigure(m, String(f.id), { widthMm: 700, heightMm: 700, color: "#000000", fill: "#ffffff" });
  assert.equal(u.width, 70);
  assert.equal(u.fill, "#ffffff");
  void (u as { id: string });
  // все типы бандла проходят
  for (const t of FREE_FIGURE_TYPES) {
    const x = addFigure(m, { type: t, center: PT, plan: "a" });
    assert.equal(x.type, t);
  }
  assert.throws(() => addFigure(m, { type: "star", center: PT, plan: "a" }), /тип фигуры/);
  assert.throws(() => addFigure(m, { type: "rect", center: PT, widthMm: 0, plan: "a" }), /положительные/);
  assert.throws(() => deleteFigure(m, "нет"), (e: unknown) => (e as McpError).code === "NOT_FOUND");
});

// ---------- изображения: модельный слой ----------

/** Минимальный PNG (1×1, IHDR с размерами 300×200). */
function pngBytes(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(17);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13, 0);
  return Buffer.concat([sig, len, Buffer.from("IHDR"), ihdr]);
}

/** Минимальный JPEG с SOF0 300×200. */
function jpegBytes(w: number, h: number): Buffer {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  const soi = Buffer.from([0xff, 0xd8]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, sof, eoi]);
}

test("375: parseImageSize — MIME по сигнатуре (png/jpeg), мусор → null", () => {
  assert.deepEqual(parseImageSize(new Uint8Array(pngBytes(300, 200))), { mime: "image/png", width: 300, height: 200 });
  assert.deepEqual(parseImageSize(new Uint8Array(jpegBytes(640, 480))), { mime: "image/jpeg", width: 640, height: 480 });
  assert.equal(parseImageSize(new Uint8Array(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))), null, "svg не принимается");
  assert.equal(parseImageSize(new Uint8Array(Buffer.from("hello"))), null);
});

test("375: picture — вписывание в 200×200 по бандлу, валидация url, подпись", () => {
  const m = baseModel();
  const p = addPicture(m, { url: "images/u1.png", center: PT, widthOriginalPx: 300, heightOriginalPx: 200, plan: "a" });
  assert.equal(p.url, "u1.png", "префикс images/ снимается (конструктор бандла)");
  assert.equal(p.width, PICTURE_FIT_CM, "большая сторона 200 см");
  assert.equal(p.height, 133.33, "133.33 см (округление до сотых)");
  assert.equal(p.type, "user");
  assert.equal(p.font_size, undefined, "подписи нет — font_size не пишется");
  // маленькая картинка ставится в натуральную величину
  const p2 = addPicture(m, { url: "u2.png", center: PT, widthOriginalPx: 100, heightOriginalPx: 100, plan: "a" });
  assert.equal(p2.width, 100);
  const u = updatePicture(m, p2.id, { text: "План", widthMm: 500, heightMm: 250 });
  assert.equal(u.width, 50);
  assert.equal(u.height, 25);
  assert.equal(u.font_size, 10, "подпись — font_size 10");
  assert.throws(() => addPicture(m, { url: "javascript:alert(1)", center: PT, widthOriginalPx: 10, heightOriginalPx: 10 }), /url/);
  assert.throws(() => addPicture(m, { url: "a/b/c/d/u1.png", center: PT, widthOriginalPx: 10, heightOriginalPx: 10 }), /url/, "глубокий путь отсечён");
  // живой формат url хранилища: шардовые подкаталоги (проба 375-2)
  const p3 = addPicture(m, { url: "c8/a3/1fdc3784fe6b_111379.png", center: PT, widthOriginalPx: 10, heightOriginalPx: 10 });
  assert.equal(p3.url, "c8/a3/1fdc3784fe6b_111379.png");
  assert.throws(() => addPicture(m, { url: "c8/../1fdc.png", center: PT, widthOriginalPx: 10, heightOriginalPx: 10 }), /url/, "traversal отсечён");
  assert.throws(() => addPicture(m, { url: "../../etc/passwd.png", center: PT, widthOriginalPx: 10, heightOriginalPx: 10 }), /url/);
  assert.throws(() => addPicture(m, { url: "u1.svg", center: PT, widthOriginalPx: 10, heightOriginalPx: 10 }), /url/);
  assert.throws(() => addPicture(m, { url: "u1.png", center: PT }), /width_original|width_mm/);
  assert.throws(() => updatePicture(m, "нет", {}), (e: unknown) => (e as McpError).code === "NOT_FOUND");
  deletePicture(m, p.id);
  assert.equal(Object.keys(m.pictures as Record<string, unknown>).length, 2, "удалена одна из трёх");
});

// ---------- эталоны в обе стороны (фикстуры через схему импорта) ----------

test("375: эталоны ui-ref-sheet/ui-ref-draw/ui-ref-picture проходят импорт и воспроизводятся моделью", () => {
  // лист
  const sheetFx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-sheet-custom.json"), "utf8")) as { model_object: Record<string, unknown> };
  parseModelImport({ custom_plans: { s: sheetFx.model_object } });
  const m = baseModel();
  const s = addSheet(m, { name: String(sheetFx.model_object.name), afterPlan: String(sheetFx.model_object.after_plan), content: sheetFx.model_object.content as string[] });
  assert.deepEqual(
    { name: s.name, after_plan: s.after_plan, content: s.content },
    { name: sheetFx.model_object.name, after_plan: sheetFx.model_object.after_plan, content: sheetFx.model_object.content },
  );
  // свободная линия
  const flFx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-draw-freeline.json"), "utf8")) as { model_object: Record<string, unknown> };
  parseModelImport({ freelines: { e: flFx.model_object } });
  const fl = addFreeline(m, {
    points: (flFx.model_object.vertexes as Array<{ point: { x: number; y: number } }>).map((v) => ({ x: v.point.x, y: v.point.y })),
    plan: String(flFx.model_object.plan),
    color: String(flFx.model_object.color_custom),
    widthStroke: Number(flFx.model_object.width_stroke),
    typeStroke: String(flFx.model_object.type_stroke),
  });
  assert.deepEqual(
    { type: fl.type, color_custom: fl.color_custom, width_stroke: fl.width_stroke, type_stroke: fl.type_stroke, vertexes: fl.vertexes.length },
    { type: flFx.model_object.type, color_custom: flFx.model_object.color_custom, width_stroke: flFx.model_object.width_stroke, type_stroke: flFx.model_object.type_stroke, vertexes: (flFx.model_object.vertexes as unknown[]).length },
  );
  // толстая линия: ширина 20 см в ячейках matrix
  const tlFx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-draw-thick-line.json"), "utf8")) as { model_object: Record<string, unknown> };
  parseModelImport({ thick_lines: { e: tlFx.model_object } });
  assert.deepEqual(tlFx.model_object.matrix, [[null, { length: 1, width: 20 }], [{ length: 1, width: 20 }, null]]);
  // фигура
  const figFx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-draw-figure.json"), "utf8")) as { model_object: Record<string, unknown> };
  parseModelImport({ free_figures: { e: figFx.model_object } });
  const fig = addFigure(m, { type: String(figFx.model_object.type), center: { x: 100, y: 100 }, widthMm: 500, heightMm: 500, plan: "plan" });
  assert.deepEqual(
    { type: fig.type, width: fig.width, height: fig.height, color: fig.color, width_stroke: fig.width_stroke, type_stroke: fig.type_stroke },
    { type: figFx.model_object.type, width: figFx.model_object.width, height: figFx.model_object.height, color: figFx.model_object.color, width_stroke: figFx.model_object.width_stroke, type_stroke: figFx.model_object.type_stroke },
  );
  // изображение
  const picFx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-picture.json"), "utf8")) as { model_object: Record<string, unknown> };
  parseModelImport({ pictures: { e: picFx.model_object } });
  const pic = addPicture(m, {
    url: String(picFx.model_object.url), center: { x: 100, y: 100 },
    widthOriginalPx: Number(picFx.model_object.width_original), heightOriginalPx: Number(picFx.model_object.height_original),
    text: String(picFx.model_object.text ?? ""), plan: "plan",
  });
  assert.deepEqual(
    { url: pic.url, width_original: pic.width_original, height_original: pic.height_original, type: pic.type, text: pic.text, font_size: pic.font_size },
    { url: picFx.model_object.url, width_original: picFx.model_object.width_original, height_original: picFx.model_object.height_original, type: picFx.model_object.type, text: picFx.model_object.text, font_size: picFx.model_object.font_size },
  );
});

// ---------- сверка: пользовательские поля ловятся в обе стороны ----------

test("375: сверки draw — потеря/добавление/сдвиг ловятся, false positives нет", () => {
  const m = baseModel();
  const s = addSheet(m, { name: "Лист", content: ["plan", "light"] });
  const fl = addFreeline(m, { points: [PT, { x: 200, y: 100 }], plan: "a", color: "#ff0000" });
  const fig = addFigure(m, { type: "rect", center: PT, plan: "a" });
  const pic = addPicture(m, { url: "u1.png", center: PT, widthOriginalPx: 100, heightOriginalPx: 100, plan: "a" });
  // без изменений — пусто
  assert.deepEqual(sheetUserMismatches(m.custom_plans as never, structuredClone(m.custom_plans ?? {}) as never), []);
  assert.deepEqual(drawLineUserMismatches(m.freelines as never, structuredClone(m.freelines ?? {}) as never, "свободная линия"), []);
  assert.deepEqual(figureUserMismatches(m.free_figures as never, structuredClone(m.free_figures ?? {}) as never), []);
  assert.deepEqual(pictureUserMismatches(m.pictures as never, structuredClone(m.pictures ?? {}) as never), []);
  // потеря записи
  const got1 = structuredClone(m.freelines ?? {}) as Record<string, unknown>;
  delete got1[fl.id];
  assert.ok(drawLineUserMismatches(m.freelines as never, got1, "свободная линия").some((x) => x.includes(fl.id) && x.includes("потеряна")));
  const got2 = structuredClone(m.custom_plans ?? {}) as Record<string, unknown>;
  delete got2[s.id];
  assert.ok(sheetUserMismatches(m.custom_plans as never, got2).some((x) => x.includes("потерян")));
  // мутации: сдвиг вершины, смена типа фигуры, другой url и content
  const got3 = structuredClone(m.freelines ?? {}) as Record<string, { vertexes: Array<{ point: { x: number; y: number } }> }>;
  got3[fl.id]!.vertexes[0]!.point.x += 5;
  assert.ok(drawLineUserMismatches(m.freelines as never, got3 as never, "линия").some((x) => x.includes("сместилась")));
  const got4 = structuredClone(m.free_figures ?? {}) as Record<string, { type: string }>;
  got4[String(fig.id)]!.type = "circle";
  assert.ok(figureUserMismatches(m.free_figures as never, got4 as never).some((x) => x.includes("тип изменился")));
  const got5 = structuredClone(m.pictures ?? {}) as Record<string, { url: string }>;
  got5[pic.id]!.url = "other.png";
  assert.ok(pictureUserMismatches(m.pictures as never, got5 as never).some((x) => x.includes("url изменился")));
  const got6 = structuredClone(m.custom_plans ?? {}) as Record<string, { content: string[] }>;
  got6[s.id]!.content = ["plan"];
  assert.ok(sheetUserMismatches(m.custom_plans as never, got6 as never).some((x) => x.includes("content потерял")));
  // лишний объект на сервере — расхождение
  const got7 = structuredClone(m.freelines ?? {}) as Record<string, unknown>;
  got7["extra"] = { ...fl, id: "extra" };
  assert.ok(drawLineUserMismatches(m.freelines as never, got7, "линия").some((x) => x.includes("extra")));
});

// ---------- полный путь через Workspace (mock save) ----------

const COMPAT = { bundle: "x", version: "1", schema: 1 } as never;
type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave?: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(m.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      afterSave?.(server);
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

test("375: полный путь через Workspace — лист + линия + фигура + картинка, save verified", async () => {
  const build = (): { m: Model; server: SaveServer } => {
    const m = baseModel();
    const s = addSheet(m, { name: "Лист 375" });
    addFreeline(m, { points: [PT, { x: 200, y: 100 }], plan: sheetPlanKey(s.id), color: "#ff0000" });
    addFigure(m, { type: "rect", center: PT, plan: "a" });
    addPicture(m, { url: "u1.png", center: PT, widthOriginalPx: 100, heightOriginalPx: 100, plan: "a", text: "Примечание" });
    return { m, server: { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> } };
  };
  // save verified
  {
    const { m, server } = build();
    const ws = saveMock(server);
    await ws.open("0", "1");
    const out = await ws.save();
    assert.equal(out.verified, true, "листы/линии/фигуры/картинки дошли до сервера без расхождений");
    assert.equal(entityCounts(ws.model as Model).custom_plans, 1);
  }
  // нормализатор уронил пользовательский лист → NORMALIZATION_DROPPED
  {
    const { m, server } = build();
    const ws = saveMock(server, () => {}, (norm) => {
      const sheets = (norm["custom_plans"] ??= {}) as Record<string, unknown>;
      for (const k of Object.keys(sheets)) delete sheets[k];
    });
    await ws.open("0", "1");
    await assert.rejects(() => ws.save(), (e: unknown) => {
      const ok = e instanceof McpError && (e as McpError).code === "NORMALIZATION_DROPPED";
      if (ok) {
        const det = (e as McpError).details as Record<string, unknown>;
        assert.ok((det["sheet_mismatches"] as string[]).some((x) => x.includes("потерян")), "подробность про лист");
      }
      return ok;
    });
  }
  // сервер потерял линию → SITE_ERROR
  {
    const { m, server } = build();
    const ws = saveMock(server, (srv) => {
      delete (srv.model["freelines"] as Record<string, unknown>)[Object.keys((srv.model["freelines"] as Record<string, unknown>))[0]!];
    });
    await ws.open("0", "1");
    await assert.rejects(() => ws.save(), (e: unknown) => {
      const ok = e instanceof McpError && (e as McpError).code === "SITE_ERROR";
      if (ok) {
        const det = (e as McpError).details as Record<string, unknown>;
        assert.ok((det["freelines_mismatches"] as string[]).some((x) => x.includes("потеряна")), "подробность про линию");
      }
      return ok;
    });
  }
  // сервер сменил url картинки → SITE_ERROR
  {
    const { m, server } = build();
    const ws = saveMock(server, (srv) => {
      const pics = srv.model["pictures"] as Record<string, { url: string }>;
      for (const p of Object.values(pics)) p.url = "other.png";
    });
    await ws.open("0", "1");
    await assert.rejects(() => ws.save(), (e: unknown) => {
      const ok = e instanceof McpError && (e as McpError).code === "SITE_ERROR";
      if (ok) {
        const det = (e as McpError).details as Record<string, unknown>;
        assert.ok((det["picture_mismatches"] as string[]).some((x) => x.includes("url")), "подробность про url");
      }
      return ok;
    });
  }
});

// ---------- image_upload: HTTP-путь с моком fetch, офлайн-гейт ----------

test("375: image_upload — POST /setup/api/load_picture/ с FormData (мок fetch), ответ {status,url}", async () => {
  const { uploadPicture } = await import("../../src/api.ts");
  const calls: Array<{ url: string; ct: string | null; body: FormData | string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
    const url = String(input);
    calls.push({ url, ct: (init?.headers?.["content-type"] as string) ?? null, body: init?.body as FormData });
    return {
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ status: "success", url: "f1a2b3.png" }),
    } as Response;
  }) as typeof fetch;
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(pngBytes(300, 200))], { type: "image/png" }), "image.png");
    form.append("type", "png");
    const up = await uploadPicture({ cookies: [] }, form);
    assert.deepEqual(up, { url: "f1a2b3.png" });
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.includes("/setup/api/load_picture/"), "тот же эндпоинт, что у редактора");
  } finally {
    globalThis.fetch = realFetch;
  }
  // мусорный ответ — SITE_ERROR
  globalThis.fetch = (async () => ({ status: 200, headers: new Headers(), text: async () => "<html>captcha</html>" }) as unknown as Response) as typeof fetch;
  try {
    await assert.rejects(() => uploadPicture({ cookies: [] }, new FormData()), (e: unknown) => (e as McpError).code === "SITE_ERROR");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("375: image_upload в офлайн-режиме — сеть закрыта (AUTH_REQUIRED, без fetch)", async () => {
  const { ServerContext } = await import("../../src/server/context.ts");
  const { buildServer } = await import("../../src/server.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const ctx = new ServerContext({ offlineFixture: join(here, "../fixtures/anon-rect-4000x3000.json") });
  const server = buildServer(ctx);
  const client = new Client({ name: "375-offline", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("NETWORK-MUST-NOT-BE-CALLED"); }) as unknown as typeof fetch;
  try {
    const res = await client.callTool({ name: "image_upload", arguments: { data_base64: Buffer.from(pngBytes(10, 10)).toString("base64") } });
    assert.ok(res.isError, "офлайн: image_upload отклонён");
    const payload = JSON.parse((res.content as { text: string }[])[0]!.text) as { code?: string };
    assert.equal(payload.code, "AUTH_REQUIRED", "офлайн-гейт в точке входа в сеть");
  } finally {
    globalThis.fetch = realFetch;
    await client.close();
  }
});
