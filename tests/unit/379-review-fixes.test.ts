// Фикс-2 по ревью 378 (PR #57): major 14/15 — единая точка проверки модели
// перед каждой передачей в Chromium (assertModelSafeForEditor); minor 16 —
// на пути открытия блокируется только реально исполнимое в стоке; minor 19 —
// item_update без against_wall не запускает каталог/редактор; minor 20 —
// описание width_mm thick_line_update.
// Каждый тест красный на 9c748de без фикса (см. .orca-reports/379-fix2-sheets.md,
// репро .orca-reports/tmp/378-repro.ts / 378-repro-n1.ts).
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Model } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addSheet } from "../../src/model/sheets.ts";
import { parseModelImport } from "../../src/model/import-schema.ts";
import { findUnsafeEditorStrings, isSafeSheetNameForOpen, isSafeSheetAfterPlanForOpen, isSafeSheetDateForOpen, isSafeSheetIdForOpen } from "../../src/model/strings.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PT = { x: 100, y: 100 };
const INVALID = (e: unknown): boolean => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT";

function baseModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  const m = { ...structuredClone(model), walls: {} } as Model;
  addRoomRect(m, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  m.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return m;
}

function modelWithSheets(mod: (m: Model) => void): Model {
  const m = baseModel();
  mod(m);
  return m;
}

/** Мок Workspace со счётчиками запуска редактора и вызовов normalize. */
function wsMock(model: Model, opts: { editorRunningAtStart?: boolean } = {}): { ws: Workspace; normalizeCalls: () => number; openEditorCalls: () => number; setCurrent: (m: Model) => void } {
  let current: Model = structuredClone(model);
  let normalizeCalls = 0;
  let openEditorCalls = 0;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalizeCalls++;
      const walls = Object.keys(m.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(m as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { bundle: "x", version: "1", schema: 1 } as never; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: "s1", units: "cm", data_empty: false, model: structuredClone(current) as unknown as Record<string, unknown> };
    },
    async openEditor() { openEditorCalls++; return editor; },
  };
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  return { ws, normalizeCalls: () => normalizeCalls, openEditorCalls: () => openEditorCalls, setCurrent: (m) => { current = m; } };
}

const SHEET = (over: Record<string, unknown>): Record<string, unknown> =>
  ({ id: "sh1", name: "Лист", after_plan: "create_walls", content: ["plan"], date: 1, ...over });

// ---------- major 378 №14: детектор проверяет ПОЛЕ id и date (не только ключ) ----------

test("379 major14: безопасный ключ, опасное поле id записи — детектор находит, редактор не запускается", async () => {
  const m = modelWithSheets((mm) => {
    (mm.custom_plans ??= {} as never)["abc"] = SHEET({ id: 'x"><img src=x onerror=alert(1)>' }) as never;
  });
  const hits = findUnsafeEditorStrings(m);
  assert.ok(hits.some((h) => h.collection === "custom_plans" && h.field === "id" && h.id === 'x"><img src=x onerror=alert(1)>'),
    `поле id найдено: ${JSON.stringify(hits)}`);
  // полный путь (репро 378-repro-n1): Workspace.open → ensureEditor — отказ ДО openEditor
  const { ws, openEditorCalls } = wsMock(m);
  await ws.open("0", "1");
  await assert.rejects(() => ws.ensureEditor(), (e: unknown) => {
    const ok = INVALID(e);
    if (ok) assert.match((e as McpError).message, /HTML без экранирования/);
    return ok;
  });
  assert.equal(openEditorCalls(), 0, "openEditor (Chromium) не запускался");
});

test("379 major14: date строкой/NaN/Infinity — детектор находит (data-date атрибут и арифметика порядка)", async () => {
  for (const bad of ['"><img src=x onerror=alert(2)>', "123", NaN, Infinity]) {
    const m = modelWithSheets((mm) => {
      (mm.custom_plans ??= {} as never)["def"] = SHEET({ date: bad as unknown as number }) as never;
    });
    const hits = findUnsafeEditorStrings(m);
    assert.ok(hits.some((h) => h.collection === "custom_plans" && h.field === "date"), `date ${String(bad)} найден`);
    assert.equal(isSafeSheetDateForOpen(bad), false, `isSafeSheetDateForOpen(${String(bad)}) — false`);
  }
  assert.equal(isSafeSheetDateForOpen(1), true);
  // ключ словаря тоже проверяется (консервативно), но поле id — обязательная проверка
  assert.equal(isSafeSheetIdForOpen('x"><img src=x onerror=alert(1)>'), false);
  assert.equal(isSafeSheetIdForOpen("abc_123-1"), true);
});

// ---------- major 378 №15: повторный open / любой путь при опасной модели ----------

test("379 major15: повторный project_open при запущенном редакторе — отказ, normalize НЕ вызывается (save и render)", async () => {
  const safe = modelWithSheets((mm) => {
    (mm.custom_plans ??= {} as never)["sh1"] = SHEET({}) as never;
  });
  const evil = structuredClone(safe);
  ((evil.custom_plans as Record<string, Record<string, unknown>>)["sh1"] as Record<string, unknown>)["name"] = "<img src=x onerror=alert(1)>";
  const mock = wsMock(safe);
  await mock.ws.open("0", "1");
  await mock.ws.ensureEditor(); // редактор запущен (безопасная модель)
  mock.setCurrent(evil); // на сервере появилось опасное имя листа
  await mock.ws.open("0", "1"); // повторный project_open того же проекта — редактор не закрывается
  assert.equal(mock.ws.editorOrNull() !== null, true, "редактор ещё запущен");
  await assert.rejects(() => mock.ws.ensureEditor(), INVALID, "ensureEditor отказывает при запущенном редакторе");
  await assert.rejects(() => mock.ws.save(), INVALID);
  assert.equal(mock.normalizeCalls(), 0, "normalize (передача модели в Chromium) не вызван");
  await assert.rejects(() => mock.ws.renderPlan({}), INVALID);
  assert.equal(mock.normalizeCalls(), 0, "renderPlan тоже не дошёл до normalize");
  await assert.rejects(() => mock.ws.applyWalls("wall_move", () => true), INVALID);
  assert.equal(mock.normalizeCalls(), 0, "applyWalls тоже не дошёл до normalize");
});

test("379 major15: save при незапущенном редакторе и опасной СЕРВЕРНОЙ модели — отказ до запуска Chromium", async () => {
  // рабочая копия безопасна (открыли раньше), сервер уже правлен в UI: редактор
  // откроет страницу, которая сама загрузит серверную модель — запуск отменяется
  const safe = modelWithSheets((mm) => {
    (mm.custom_plans ??= {} as never)["sh1"] = SHEET({}) as never;
  });
  const evil = structuredClone(safe);
  ((evil.custom_plans as Record<string, Record<string, unknown>>)["sh1"] as Record<string, unknown>)["name"] = "<img src=x onerror=alert(1)>";
  const mock = wsMock(safe);
  await mock.ws.open("0", "1");
  mock.setCurrent(evil); // свежий GET в save вернёт опасную серверную модель
  await assert.rejects(() => mock.ws.save(), INVALID);
  assert.equal(mock.openEditorCalls(), 0, "Chromium не запускался");
  assert.equal(mock.normalizeCalls(), 0);
});

test("379 major15: undo/redo к снимку с опасной строкой — отказ при следующем обращении к редактору", async () => {
  const safe = modelWithSheets((mm) => {
    (mm.custom_plans ??= {} as never)["sh1"] = SHEET({}) as never;
  });
  const mock = wsMock(safe);
  await mock.ws.open("0", "1");
  await mock.ws.ensureEditor();
  // модельный импорт мимо инструментов (как любой путь, кладущий опасную запись в рабочую копию)
  mock.ws.apply("import", (m) => {
    (m.custom_plans ??= {} as never)["ev"] = SHEET({ id: "ev", name: "ok" }) as never;
    ((m.custom_plans as Record<string, Record<string, unknown>>)["ev"] as Record<string, unknown>)["name"] = "<img src=x onerror=alert(1)>";
    return true;
  });
  mock.ws.undo(); // снимок «open» — безопасный: редактор работает
  await mock.ws.ensureEditor();
  assert.equal(mock.normalizeCalls(), 0, "ensureEditor без normalize");
  mock.ws.redo(); // вернулся опасный снимок
  await assert.rejects(() => mock.ws.ensureEditor(), INVALID);
  await assert.rejects(() => mock.ws.save(), INVALID);
  assert.equal(mock.normalizeCalls(), 0, "после redo normalize не вызван");
});

// ---------- minor 378 №16: открытие блокирует только исполнимое ----------

test("379 minor16: имена листов из UI сайта не блокируют редактор при открытии (таблица ревью)", async () => {
  const names = [
    "Ёлка — «гостиная»", "Кухня №2, 12 м²", "План 1/2", "Mom's room", 'Кухня "лофт"',
    "Кухня & гостиная", "Вариант [2]", "Café", "Дитяча кімната", "Лист ~ 3", "Романтика ’25",
  ];
  for (const n of names) {
    assert.equal(isSafeSheetNameForOpen(n), true, `имя ${JSON.stringify(n)} безопасно на пути открытия`);
    const m = modelWithSheets((mm) => {
      (mm.custom_plans ??= {} as never)["sh1"] = SHEET({ name: n }) as never;
    });
    assert.deepEqual(findUnsafeEditorStrings(m), [], `модель с именем ${JSON.stringify(n)} — без опасных строк`);
  }
  // полный путь: редактор запускается и normalize вызывается
  const m = modelWithSheets((mm) => {
    (mm.custom_plans ??= {} as never)["sh1"] = SHEET({ name: "Mom's room" }) as never;
  });
  const mock = wsMock(m);
  await mock.ws.open("0", "1");
  assert.equal(mock.ws.unsafeStrings.length, 0);
  await mock.ws.save();
  assert.equal(mock.normalizeCalls(), 1, "save прошёл — редактор работал");
});

test("379 minor16: открытие блокирует исполнимое — <, кавычки/\\/] в after_plan, id/date строго; сущности в name — текст (380 №24)", async () => {
  // name: innerHTML текстовый узел — тег создаёт только буквальный <;
  // сущности (&amp;, &#60;) декодируются в текст и НЕ блокируют (380 №24)
  for (const bad of ["<img src=x onerror=alert(1)>", "a<b"]) {
    assert.equal(isSafeSheetNameForOpen(bad), false, `name ${JSON.stringify(bad)} блокируется`);
  }
  for (const ok of ["Кухня &amp; гостиная", "&#39;тест", "a&#x3C;b", "Кухня & гостиная"]) {
    assert.equal(isSafeSheetNameForOpen(ok), true, `name ${JSON.stringify(ok)} — сущность/одиночный & безопасны`);
  }
  assert.equal(isSafeSheetNameForOpen("Кухня & гостиная"), true, "одиночный & без сущности не блокирует");
  // after_plan: селекторы .plan_…, [data-plan='…'], option[value="…"]
  for (const bad of ['cr"eate', "cre]ate", "cr\\eate", "<first"]) {
    assert.equal(isSafeSheetAfterPlanForOpen(bad), false, `after_plan ${JSON.stringify(bad)} блокируется`);
  }
  assert.equal(isSafeSheetAfterPlanForOpen("create_walls"), true);
  assert.equal(isSafeSheetAfterPlanForOpen("first"), true);
  // полный путь: каждый случай — отказ ensureEditor до запуска Chromium
  const cases: Record<string, unknown>[] = [
    { name: "<img src=x onerror=alert(1)>" },
    { after_plan: 'cr"eate' },
    { after_plan: "cre]ate" },
    { id: 'x"><img src=x onerror=alert(1)>' },
    { date: "123" },
  ];
  for (const over of cases) {
    const m = modelWithSheets((mm) => {
      (mm.custom_plans ??= {} as never)["sh1"] = SHEET(over) as never;
    });
    const mock = wsMock(m);
    await mock.ws.open("0", "1");
    await assert.rejects(() => mock.ws.ensureEditor(), INVALID, `случай ${JSON.stringify(over)} — редактор не запускается`);
    assert.equal(mock.openEditorCalls(), 0);
  }
});

// ---------- minor 378 №16: входной белый список (sheet_add/update/import) ----------

test("379 minor16: вход — кириллица/ё/диакритика/украинские/белорусские, апостроф, тире, «ёлочки» проходят; <>&\"'` отклоняются", () => {
  const m = baseModel();
  for (const ok of ["Ёлка — «гостиная»", "Дитяча кімната", "Гасцёлак ў палацы", "Café crème", "Mom's room", "Кухня №2, 12 м²", "План 1/2"]) {
    const rec = addSheet(m, { name: ok });
    assert.equal(rec.name, ok, `вход принимает ${JSON.stringify(ok)}`);
  }
  for (const bad of ["<img>", "a&b", 'кварт"ал', "бек`тик", "x>y"]) {
    assert.throws(() => addSheet(m, { name: bad }), INVALID, `вход отклоняет ${JSON.stringify(bad)}`);
  }
  // импорт: те же предикаты
  const name = (n: string): { id: string; name: string } => ({ id: "abc123", name: n });
  parseModelImport({ custom_plans: { s: name("Mom's room") } });
  parseModelImport({ custom_plans: { s: name("Ёлка — «гостиная»") } });
  assert.throws(() => parseModelImport({ custom_plans: { s: name("<img>") } }), /name/i);
});

// ---------- minor 378 №19: item_update без against_wall не запускает каталог ----------

test("379 minor19: item_update (center) не обращается к каталогу — редактор не запускается; с against_wall — обращается", async () => {
  const ROOT = join(here, "..", "..");
  const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "379-minor19", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const text = (r: unknown): string => ((r as { content?: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 300)}`);
    return JSON.parse(text(res)) as Record<string, unknown>;
  };
  try {
    // офлайн-режим: workspace засеивается из фикстуры при первом обращении (project_open в офлайне недоступен)
    await call("item_add", { name: "socket", position: { against_wall: { wall_id: "W2", offset_mm: 1000 } } });
    // каталог уже загружен item_add — шпион считает ОБРАЩЕНИЯ к каталогу
    let toolsCalls = 0;
    const ctxAny = ctx as unknown as { tools: () => Promise<unknown> };
    const real = ctxAny.tools.bind(ctx);
    ctxAny.tools = () => { toolsCalls++; return real(); };
    // перенос по центру: флаг can_move_between_walls не нужен — каталог не трогаем
    await call("item_update", { item_id: "I1", position: { center: { x: 2000, y: 1500 } } });
    assert.equal(toolsCalls, 0, `item_update center: каталог не запрашивался (было ${toolsCalls})`);
    // перенос к стене: флаг нужен — обращение к каталогу (офлайн — фикстура, без редактора)
    await call("item_update", { item_id: "I1", position: { against_wall: { wall_id: "W2", offset_mm: 1200 } } });
    assert.ok(toolsCalls >= 1, "item_update against_wall запрашивает флаг каталога");
  } finally {
    await client.close().catch(() => {});
  }
});

// ---------- minor 378 №20: описание width_mm thick_line_update ----------

test("379 minor20: thick_line_update.width_mm имеет описание диапазона в публичной схеме", async () => {
  const ROOT = join(here, "..", "..");
  const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "379-minor20", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const { tools } = await client.listTools();
    const tl = tools.find((t) => t.name === "thick_line_update");
    assert.ok(tl, "thick_line_update в списке инструментов");
    const desc = (tl!.inputSchema as { properties?: { width_mm?: { description?: string } } }).properties?.width_mm?.description;
    assert.ok(typeof desc === "string" && desc.includes("2..1500"), `описание width_mm: ${JSON.stringify(desc)}`);
  } finally {
    await client.close().catch(() => {});
  }
});
