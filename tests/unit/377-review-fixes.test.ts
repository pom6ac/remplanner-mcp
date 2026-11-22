// Этап 377: фиксы ревью 376 (PR #57) — major 1..4 (модельная часть) и minor 5..10, 12, 13.
// Каждый тест красный на 7b04a69 без фикса (см. .orca-reports/tmp/376-repro.ts).
// Major 376 №3 (живые пробы): опасные строки на сайт НЕ отправляются — отказ
// проверяется только офлайн (здесь и в схеме импорта).
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addSheet, updateSheet } from "../../src/model/sheets.ts";
import { addFreeline, addThickLine, addFigure, validateDrawPlan, THICK_LINE_WIDTH_MM_MIN, THICK_LINE_WIDTH_MM_MAX } from "../../src/model/draw.ts";
import { addPicture, updatePicture, deletePicture, canonicalPictureText, pictureTextWarnings } from "../../src/model/pictures.ts";
import { parseModelImport } from "../../src/model/import-schema.ts";
import { validateModel } from "../../src/model/validate.ts";
import { addItem, updateItem } from "../../src/model/items.ts";
import { toToolEntry } from "../../src/catalog.ts";
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
  // как в electric3: rooms2-контур для проверки позиций against_wall
  m.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return m;
}

const INVALID = (e: unknown): boolean => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT";

// ---------- major 376 №1: image_add без text — формат, который restore бандла принимает ----------

test("377 major1: image_add без text — text \"\" и font_size 10, deepEqual с эталоном ui-ref-picture", () => {
  const m = baseModel();
  const p = addPicture(m, { url: "u1.png", center: PT, widthOriginalPx: 300, heightOriginalPx: 300, plan: "plan" });
  assert.equal(p.text, "", "подпись всегда пишется (Picture ctor: text||\"\")");
  assert.equal(p.font_size, 10);
  // эмуляция Pictures.restore бандла: e[i].text = e[i].text.replace(/`/g,"'") — не падает
  const restored = (structuredClone(p) as Record<string, unknown>) as { text: string };
  restored.text = restored.text.replace(/`/g, "'").replace(/``/g, '"');
  assert.equal(restored.text, "");
  // формат ≅ эталон раздела (ui-ref-picture.json)
  const fx = (JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-picture.json"), "utf8")) as { model_object: Record<string, unknown> }).model_object;
  for (const k of ["url", "width_original", "height_original", "text", "font_size", "type", "level_layer"]) {
    assert.deepEqual(p[k as keyof typeof p], fx[k], `поле ${k} как в эталоне`);
  }
  // image_update text:null — подпись в "", поле НЕ удаляется
  const u = updatePicture(m, p.id, { text: null });
  assert.equal(u.text, "", "text:null → \"\" (не удаление поля)");
  assert.equal(u.font_size, 10);
});

// ---------- major 376 №2: канонизация подписи с ' и " как copy('server') бандла ----------

test("377 major2: подпись с ' и \" — server-форма, unescape в ответе, warning канонизации", () => {
  const m = baseModel();
  const p = addPicture(m, { url: "u1.png", center: PT, widthOriginalPx: 100, heightOriginalPx: 100, plan: "a", text: "it's \"A\"" });
  // server-форма Comments.copy("server") бандла: ' → `, " → ``
  assert.equal(p.text, "it`s ``A``");
  // restore бандла (только ` → '; `` остаётся '' — двойные кавычки редактор
  // восстанавливает с потерей, факт раздела 116) даёт стабильный вид
  const editorWorking = structuredClone(p) as { text: string };
  editorWorking.text = editorWorking.text.replace(/`/g, "'");
  assert.equal(editorWorking.text, "it's ''A''");
  assert.deepEqual(pictureUserMismatches({ [p.id]: p } as never, { [p.id]: editorWorking } as never), []);
  // output — видимый текст (unescape); двойные кавычки теряются при restore —
  // расхождение с вводом честно отдаётся warning'ом (как у комментариев)
  assert.ok(pictureTextWarnings("it's \"A\"", p.text)[0]!.includes("канонизирован"));
  const p2 = addPicture(m, { url: "u2.png", center: PT, widthOriginalPx: 10, heightOriginalPx: 10, text: "привет`мир" });
  assert.equal(p2.text, "привет`мир", "server-форма: ' хранится как ` (restore бандла сводит его обратно)");
  assert.ok(pictureTextWarnings("привет`мир", p2.text)[0]!.includes("канонизирован"));
  // двойные кавычки восстанавливаются с потерей (факт раздела) — warning честный
  assert.ok(pictureTextWarnings("it's \"A\"", p.text)[0]!.includes("it's ''A''"));
  // < > & в подписи — отказ (major 376 №3, тот же класс входа)
  assert.throws(() => addPicture(m, { url: "u3.png", center: PT, widthOriginalPx: 10, heightOriginalPx: 10, text: "<img src=x>" }), INVALID);
  assert.throws(() => updatePicture(m, p2.id, { text: "a&b" }), INVALID);
  assert.throws(() => canonicalPictureText("x>y"), INVALID);
});

/** Мок Workspace (как в sheets-tools.test.ts): normalize эмулирует
 *  Pictures.restore+copy('server') и CustomPlan без изменений. */
function saveMock(model: Model, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
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
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { bundle: "x", version: "1", schema: 1 } as never; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: "s1", units: "cm", data_empty: false, model: structuredClone(model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  return ws;
}

test("377 major2: полный путь через Workspace — подпись с кавычками сохраняется verified", async () => {
  const m = baseModel();
  addPicture(m, { url: "u1.png", center: PT, widthOriginalPx: 100, heightOriginalPx: 100, plan: "a", text: "it's \"A\"" });
  // редактор: restore (`→') затем copy('server') — для server-формы это identity
  const ws = saveMock(m, (norm) => {
    const pics = (norm["pictures"] ?? {}) as Record<string, { text: string }>;
    for (const p of Object.values(pics)) {
      p.text = p.text.replace(/`/g, "'").replace(/'/g, "`").replace(/"/g, "``");
    }
  });
  await ws.open("0", "1");
  const out = await ws.save();
  assert.equal(out.verified, true, "server-форма проходит restore+copy без NORMALIZATION_DROPPED");
  // краснеет без фикса: сырая подпись хранится как "it's", а не server-форма "it`s" —
  // закреплено в major2-тесте выше (assert.equal(p.text, "it`s ``A``"))
});

// ---------- major 376 №3: белый список строк (имена листов; схема импорта) ----------

test("377 major3: sheet_add/sheet_update отклоняют строки, исполнимые как HTML (INVALID_ARGUMENT)", () => {
  const m = baseModel();
  const s = addSheet(m, { name: "Лист 377" });
  // ревью 378 №16: апостроф НЕ опасен — допускается на входе (см. 379)
  for (const bad of ["<img src=x onerror=alert(1)>", "a&b", 'кварт"ал', "бек`тик", "x>y"]) {
    assert.throws(() => addSheet(m, { name: bad }), INVALID, `sheet_add отклоняет ${JSON.stringify(bad)}`);
    assert.throws(() => updateSheet(m, s.id, { name: bad }), INVALID, `sheet_update отклоняет ${JSON.stringify(bad)}`);
  }
  // допустимые: кириллица, цифры, базовая пунктуация, апостроф (rev 378 №16)
  for (const ok of ["Лист 377", "Санузел, этаж 2 (черновик)", "Кухня №3 — 12 м²", "«Проект»", "50% готов", "Mom's room"]) {
    const rec = updateSheet(m, s.id, { name: ok });
    assert.equal(rec.name, ok, `допустимое имя ${JSON.stringify(ok)}`);
  }
});

test("377 major3: схема импорта — custom_plans name/id/after_plan и picture text/url под предикатами", () => {
  const name = (n: unknown): { id: string; name: string } => ({ id: "abc123", name: n as string });
  assert.throws(() => parseModelImport({ custom_plans: { s: name("<img>") } }), /name/i);
  assert.throws(() => parseModelImport({ custom_plans: { s: name('a"b') } }), /name|символ/i);
  assert.throws(() => parseModelImport({ custom_plans: { s: { id: 'x"y', name: "ok" } } }), /id/i, "id — только [A-Za-z0-9_-] (jQuery-селектор)");
  assert.throws(() => parseModelImport({ custom_plans: { s: { id: "abc", name: "ok", after_plan: 'cr"eate' } } }), /after_plan/i);
  parseModelImport({ custom_plans: { s: { id: "abc_123-1", name: "Лист 377", after_plan: "create_walls" } } });
  // picture url — тот же предикат, что image_add (minor 376 №9)
  assert.throws(() => parseModelImport({ pictures: { p: { id: "p1", url: "../../setup/api/x.png" } } }), /url/i);
  assert.throws(() => parseModelImport({ pictures: { p: { id: "p1", url: "javascript:alert(1)" } } }));
  parseModelImport({ pictures: { p: { id: "p1", url: "c8/a3/1fdc3784fe6b_111379.png" } } });
  parseModelImport({ pictures: { p: { id: "p2", url: "images/u1.png" } } });
  // picture text — без < > &
  assert.throws(() => parseModelImport({ pictures: { p: { id: "p3", text: "<img src=x>" } } }));
  parseModelImport({ pictures: { p: { id: "p4", text: "it`s ``A``" } } });
});

test("377 major3: открытие проекта с уже опасными строками — предупреждение, редактор не запускается (fail-closed)", async () => {
  const m = baseModel();
  (m.custom_plans ??= {} as never)["sh1"] = { id: "sh1", name: "<img src=x onerror=alert(1)>", after_plan: "create_walls", content: ["plan"], date: 1 };
  const ws = saveMock(m);
  await ws.open("0", "1");
  const unsafe = ws.unsafeStrings;
  assert.equal(unsafe.length, 1, `опасная строка найдена при открытии: ${JSON.stringify(unsafe)}`);
  assert.equal(unsafe[0]!.collection, "custom_plans");
  assert.equal(unsafe[0]!.field, "name");
  // ensureEditor (сохранение/рендер) отказывается открывать Chromium с таким проектом
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const ok = e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT";
    if (ok) assert.match((e as McpError).message, /HTML без экранирования/);
    return ok;
  });
  // безопасный проект — предупреждений нет
  const m2 = baseModel();
  (m2.custom_plans ??= {} as never)["sh2"] = { id: "sh2", name: "Лист 377", after_plan: "create_walls", content: ["plan"], date: 1 };
  const ws2 = saveMock(m2);
  await ws2.open("0", "1");
  assert.equal(ws2.unsafeStrings.length, 0);
});

// ---------- minor 376 №5: image_delete по метке возвращает id удалённого ----------

test("377 minor5: deletePicture возвращает id удалённого (метка PIC1 при двух изображениях)", () => {
  const m = baseModel();
  const a = addPicture(m, { url: "a.png", center: PT, widthOriginalPx: 10, heightOriginalPx: 10, plan: "a" });
  const b = addPicture(m, { url: "b.png", center: PT, widthOriginalPx: 10, heightOriginalPx: 10, plan: "a" });
  const deleted = deletePicture(m, "PIC1");
  assert.equal(deleted, a.id, "удалён именно PIC1 — id из ответа до пересчёта меток, не оставшийся b");
  assert.equal(deletePicture(m, "PIC1"), b.id);
});

// ---------- minor 376 №6: белый список plan ----------

test("377 minor6: plan — только plan/furniture/custom_<id> существующего листа", () => {
  const m = baseModel();
  const s = addSheet(m, { name: "Лист" });
  assert.equal(validateDrawPlan(m, "plan"), "plan");
  assert.equal(validateDrawPlan(m, "furniture"), "furniture");
  assert.equal(validateDrawPlan(m, `custom_${s.id}`), `custom_${s.id}`);
  for (const bad of ["no_such_sheet", "zzz", "custom_нет"]) {
    assert.throws(() => validateDrawPlan(m, bad), (e: unknown) =>
      e instanceof McpError && (["INVALID_ARGUMENT", "NOT_FOUND"] as string[]).includes((e as McpError).code), `план ${bad} отклонён`);
  }
});

// ---------- minor 376 №7: сверка fill/width_stroke/type_stroke ----------

test("377 minor7: потеря fill и смена стиля контура ловятся сверкой (фигуры и линии)", () => {
  const m = baseModel();
  const f = addFigure(m, { type: "rect", center: PT, plan: "a", fill: "#ff0000" }) as Record<string, unknown>;
  const lost = { ...structuredClone(f) }; delete lost["fill"]; lost["type_stroke"] = "dot"; lost["width_stroke"] = 5;
  const mm = figureUserMismatches({ [String(f["id"])]: f } as never, { [String(f["id"])]: lost } as never);
  assert.ok(mm.some((x) => x.includes("заливка потеряна")), `fill: ${mm.join(" | ")}`);
  assert.ok(mm.some((x) => x.includes("стиль контура изменилась")), `type_stroke: ${mm.join(" | ")}`);
  assert.ok(mm.some((x) => x.includes("толщина контура изменилась")), `width_stroke: ${mm.join(" | ")}`);
  // линия: потеря fill тоже ловится
  const fl = addFreeline(m, { points: [PT, { x: 200, y: 100 }], plan: "a", fill: "#00ff00" }) as Record<string, unknown>;
  const flLost = { ...structuredClone(fl) }; delete flLost["fill"];
  assert.ok(drawLineUserMismatches({ [String(fl["id"])]: fl } as never, { [String(fl["id"])]: flLost } as never, "линия")
    .some((x) => x.includes("заливка потеряна")));
  // без изменений — пусто (false positives нет)
  assert.deepEqual(figureUserMismatches({ [String(f["id"])]: f } as never, structuredClone({ [String(f["id"])]: f }) as never), []);
});

// ---------- minor 376 №8: width_mm толстой линии 2..1500 ----------

test("377 minor8: width_mm 0/1/1501 отклоняются, 2 и 1500 проходят", () => {
  const m = baseModel();
  assert.equal(THICK_LINE_WIDTH_MM_MIN, 2);
  assert.equal(THICK_LINE_WIDTH_MM_MAX, 1500);
  for (const bad of [0, 1, 1501]) {
    assert.throws(() => addThickLine(m, { points: [PT, { x: 200, y: 100 }], widthMm: bad, plan: "a" }), INVALID, `width_mm ${bad} отклонён`);
  }
  addThickLine(m, { points: [PT, { x: 200, y: 100 }], widthMm: 2, plan: "a" });
  addThickLine(m, { points: [PT, { x: 200, y: 100 }], widthMm: 1500, plan: "a" });
});

// ---------- minor 376 №10: вакуумная validate — висячие plan-ссылки ловятся ----------

test("377 minor10: validate ловит SHEET_PLAN_DANGLING после удаления листа, безопасная модель — пусто", () => {
  const m = baseModel();
  const s = addSheet(m, { name: "Лист" });
  addFreeline(m, { points: [PT, { x: 200, y: 100 }], plan: `custom_${s.id}` });
  (m.custom_plans as Record<string, unknown>)[s.id] = undefined;
  delete (m.custom_plans as Record<string, unknown>)[s.id];
  const problems = validateModel(m);
  const dangling = problems.filter((p) => p.code === "SHEET_PLAN_DANGLING");
  assert.equal(dangling.length, 1, `висячая ссылка поймана: ${JSON.stringify(problems.map((p) => p.code))}`);
  assert.match(dangling[0]!.message, /custom_/);
  // без листа/объекта — пусто
  const m2 = baseModel();
  addFreeline(m2, { points: [PT, { x: 200, y: 100 }], plan: "a" });
  assert.equal(validateModel(m2).some((p) => p.code === "SHEET_PLAN_DANGLING"), false);
  // существующий лист — не висячий
  const m3 = baseModel();
  const s3 = addSheet(m3, { name: "Лист" });
  addFigure(m3, { type: "rect", center: PT, plan: `custom_${s3.id}` });
  assert.equal(validateModel(m3).some((p) => p.code === "SHEET_PLAN_DANGLING"), false);
});

// ---------- minor 376 №12: флаг can_move_between_walls из каталога ----------

test("377 minor12: canMoveBetweenWalls=false из каталога сохраняет слой при against_wall (фолбэк-набор не применяется)", () => {
  const m = baseModel();
  // предмет-группа с типом socket (в фолбэк-наборе CAN_MOVE_BETWEEN_WALLS),
  // но запись каталога говорит can_move_between_walls: false → слой НЕ снимается
  const wallId = Object.values(m.walls).find((w) => w.p1.y === w.p2.y)!.id;
  const created = addItem(m, {
    name: "socket",
    position: { againstWall: { wallId, offsetMm: 1000 } },
    catalogEntry: toToolEntry("socket", { id: 1, group: "sockets", width: 14, height: 14, self_height: 0, plan: { sockets: 9 }, anchor: "wall", over_floor: { value: 30 }, title: "Розетка" }),
  } as never) as unknown as { id: string; layer: unknown; pc: { x: number; y: number } };
  (created as unknown as Record<string, unknown>).layer = 2;
  updateItem(m, {
    itemId: created.id,
    centerCm: created.pc,
    idWall: wallId,
    resnapToWall: true,
    canMoveBetweenWalls: false,
  });
  assert.equal((m.items as unknown as Record<string, { layer?: unknown }>)[created.id]!.layer, 2, "слой сохранён — флаг из каталога, не из фолбэк-набора");
});
