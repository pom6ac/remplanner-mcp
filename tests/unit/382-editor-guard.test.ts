// Фикс по ревью 380 (PR #57): major 21 — модель, которую Chromium реально
// загружает со страницы (GET /setup/api/planner/), проверяется ДО исполнения
// её строк редактором, на всех путях (openEditor/render_plan/wall-мутации/
// каталог/undo-redo/import/save) — перехват ответа в браузере (page.route)
// с fail-closed abort; major 22 — детектор findUnsafeEditorStrings fail-closed
// по типу (массив/объект/число в полях бандла, запись-не-объект); minor 23 —
// тест гарда assertModelSafeForEditor в normalize адаптера; minor 24 —
// ложное срабатывание «&amp; как текст» снято (сущность в текстовом узле —
// не тег); nit 26 — toolsIfLoaded читает дисковый кэш каталога.
// Каждый блок краснеет без своего фикса (мутации описаны в отчёте 382).
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import {
  findUnsafeEditorStrings,
  isSafeSheetNameForOpen,
  assertModelSafeForEditor,
} from "../../src/model/strings.ts";
import {
  openEditorInContext,
  buildHandle,
  assertPlannerModelResponse,
  PLANNER_MODEL_URL_RE,
} from "../../src/editor/adapter.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";
import { ServerContext } from "../../src/server/context.ts";
import { CACHE_DIR } from "../../src/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const INVALID = (e: unknown): boolean => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT";

function baseModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  const m = { ...structuredClone(model), walls: {} } as Model;
  addRoomRect(m, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  m.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return m;
}

const SHEET = (over: Record<string, unknown>): Record<string, unknown> =>
  ({ id: "sh1", name: "Лист", after_plan: "create_walls", content: ["plan"], date: 1, ...over });

function modelWithSheets(mod: (m: Model) => void): Model {
  const m = baseModel();
  mod(m);
  return m;
}

/** Мок Workspace со счётчиком запусков редактора (deps.openEditor подменён). */
function wsMock(model: Model): { ws: Workspace; openEditorCalls: () => number } {
  let openEditorCalls = 0;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
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
      return { object_id: "0", plan_id: "1", save_id: "s1", units: "cm", data_empty: false, model: structuredClone(model) as unknown as Record<string, unknown> };
    },
    async openEditor() { openEditorCalls++; return editor; },
  };
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  return { ws, openEditorCalls: () => openEditorCalls };
}

// ---------- major 380 №22: fail-closed по типу ----------

test("382 major22: массив в id/name/after_plan — детектор находит (бандл вставляет String(массив) в HTML/селекторы)", () => {
  for (const field of ["id", "name", "after_plan"] as const) {
    const m = modelWithSheets((mm) => {
      (mm.custom_plans ??= {} as never)["sh1"] = SHEET({ [field]: ["<img src=x onerror=alert(1)>"] }) as never;
    });
    const hits = findUnsafeEditorStrings(m);
    assert.ok(
      hits.some((h) => h.collection === "custom_plans" && h.field === field),
      `массив в ${field} — попадание (получено: ${JSON.stringify(hits)})`,
    );
    assert.throws(() => assertModelSafeForEditor(m), INVALID, `assertModelSafeForEditor: массив в ${field} — отказ`);
  }
});

test("382 major22: объект с toString в поле — попадание (шаблон бандла даёт его строку)", () => {
  for (const field of ["id", "name", "after_plan"] as const) {
    const m = modelWithSheets((mm) => {
      (mm.custom_plans ??= {} as never)["sh1"] = SHEET({ [field]: { toString: () => "<img src=x onerror=alert(2)>" } }) as never;
    });
    assert.ok(
      findUnsafeEditorStrings(m).some((h) => h.collection === "custom_plans" && h.field === field),
      `объект с toString в ${field} — попадание`,
    );
  }
});

test("382 major22: число там, где бандл ждёт строку — попадание; число-строка по бандлу — по правилам поля", () => {
  const m = modelWithSheets((mm) => {
    (mm.custom_plans ??= {} as never)["sh1"] = SHEET({ name: 42, after_plan: 7 }) as never;
  });
  const hits = findUnsafeEditorStrings(m);
  assert.ok(hits.some((h) => h.field === "name"), "число в name — попадание");
  assert.ok(hits.some((h) => h.field === "after_plan"), "число в after_plan — попадание");
  // id ожидается строкой по бандлу: число — попадание; date ожидается числом: строка — попадание
  const m2 = modelWithSheets((mm) => {
    (mm.custom_plans ??= {} as never)["sh1"] = SHEET({ id: 42, date: "1" }) as never;
  });
  const hits2 = findUnsafeEditorStrings(m2);
  assert.ok(hits2.some((h) => h.field === "id"), "число в id — попадание");
  assert.ok(hits2.some((h) => h.field === "date"), "строка в date — попадание");
  // null/отсутствие поля не попадание (бандл подставляет умолчание/undefined)
  const m3 = modelWithSheets((mm) => {
    (mm.custom_plans ??= {} as never)["sh1"] = SHEET({ id: null, name: null, after_plan: null }) as never;
  });
  assert.equal(findUnsafeEditorStrings(m3).length, 0, "null-поля — не попадание");
});

test("382 major22: запись custom_plans[k] не объект (строка/число/null) — попадание, раньше молча пропускалась", () => {
  for (const rec of ["<img src=x onerror=alert(3)>", 42, null, ["x", "<b"]]) {
    const m = modelWithSheets((mm) => {
      (mm.custom_plans ??= {} as never)["sh1"] = rec as never;
    });
    const hits = findUnsafeEditorStrings(m);
    assert.ok(hits.some((h) => h.collection === "custom_plans" && h.field === "record"), `запись ${JSON.stringify(rec)} — попадание`);
  }
});

test("382 major22: полный путь Workspace.open → ensureEditor — отказ до запуска редактора для каждого типа", async () => {
  const cases: Record<string, unknown>[] = [
    { name: ["<img src=x onerror=alert(1)>"] },
    { id: ['x"><img src=x onerror=alert(1)>'] },
    { after_plan: ["x'] , <b"] },
    { id: { nested: 'x"><img src=x onerror=alert(1)>' } },
  ];
  for (const over of cases) {
    const m = modelWithSheets((mm) => {
      (mm.custom_plans ??= {} as never)["sh1"] = SHEET(over) as never;
    });
    const { ws, openEditorCalls } = wsMock(m);
    await ws.open("0", "1");
    await assert.rejects(() => ws.ensureEditor(), INVALID, `случай ${JSON.stringify(over)} — редактор не запускается`);
    assert.equal(openEditorCalls(), 0, "openEditor (Chromium) не запускался");
  }
});

// ---------- major 380 №21: перехват ответа модели в браузере ----------

const COMPAT_OK = {
  global_version: "757", planner_version: "3", bundles: [],
  object_id: "123", plan_id: "1",
  present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true },
};

type FakeRoute = {
  request(): { method(): string };
  fetch(): Promise<{ text(): Promise<string> }>;
  fulfill(o: unknown): Promise<void>;
  abort(): Promise<void>;
  continue(): Promise<void>;
};

/** Мок страницы: перехватчик context.route (383 №33) регистрируется, goto «делает» GET модели. */
function routePage(payload: string, opts: { method?: string; fetchFails?: boolean } = {}, onClose: () => void = () => {}) {
  const calls = { fulfill: 0, abort: 0, routeRegistered: 0, cont: 0 };
  let handler: ((route: FakeRoute) => Promise<void>) | null = null;
  // payload в коробке: ревью 383 №32а — страница может перезагрузиться и получить ВТОРОЙ ответ
  const payloadBox = { current: payload };
  const makeRoute = (method: string): FakeRoute => ({
    request: (): { method(): string } => ({ method: () => method }),
    fetch: async () => {
      if (opts.fetchFails) throw new Error("network down");
      return { text: async () => payloadBox.current };
    },
    fulfill: async () => { calls.fulfill++; },
    abort: async () => { calls.abort++; },
    continue: async () => { calls.cont++; },
  });
  const page = {
    async goto() {
      await handler?.(makeRoute(opts.method ?? "GET"));
      return {};
    },
    async waitForFunction() { return true; },
    async waitForTimeout() {},
    async evaluate(fn: string | ((a: unknown) => unknown), _a?: unknown): Promise<unknown> {
      if (typeof fn === "function") return {};
      const src = String(fn);
      if (src.includes("planner_ui_message_fog")) return true;
      if (src.includes("global_version")) return COMPAT_OK;
      if (src.includes("project.save")) return { started: true };
      if (src.includes("$Project.restore")) {
        return { copy: {}, rooms: [], before: { walls: 0, holes: 0, items: 0 }, after: { walls: 0, holes: 0, items: 0 } };
      }
      return { object_id: "123", plan_id: "1" };
    },
    on() {}, off() {},
  };
  const context = {
    async route(_re: unknown, h: (route: FakeRoute) => Promise<void>) {
      calls.routeRegistered++;
      handler = h;
    },
    newPage: async () => page,
    close: async () => { onClose(); },
  };
  return {
    page: page as never,
    context: context as never,
    calls,
    /** Имитация повторной загрузки модели страницей (reload, restore_project). */
    reloadModel: async (p: string): Promise<void> => {
      payloadBox.current = p;
      await handler?.(makeRoute(opts.method ?? "GET"));
    },
  };
}

const SAFE_PAYLOAD = JSON.stringify({ object_id: "123", plan_id: "1", save_id: "s1", units: "cm", data: JSON.stringify({ walls: {} }) });
const EVIL_NAME = "<img src=x onerror=alert(1)>";
const evilPayload = (): string =>
  JSON.stringify({
    object_id: "123", plan_id: "1", save_id: "s1", units: "cm",
    data: JSON.stringify({ custom_plans: { sh1: SHEET({ name: EVIL_NAME }) } }),
  });

test("382 major21: сервер вернул опасный лист — route.abort, страница модель НЕ получила, отказ INVALID_ARGUMENT", async () => {
  let closed = 0;
  const { context, calls } = routePage(evilPayload(), {}, () => { closed++; });
  await assert.rejects(
    openEditorInContext({ cookies: [] } as never, "123", "1", context as never, 2000),
    (e: unknown) => {
      const ok = INVALID(e);
      if (ok) assert.match((e as McpError).message, /fail-closed/);
      return ok;
    },
    "опасный ответ модели — отказ открытия",
  );
  assert.equal(calls.routeRegistered, 1, "перехватчик установлен ДО goto");
  assert.equal(calls.abort, 1, "route.abort — модель не отдана странице");
  assert.equal(calls.fulfill, 0, "route.fulfill не вызывался");
  assert.equal(closed, 1, "контекст закрыт");
});

test("382 major21: безопасный ответ модели — fulfill, редактор открывается", async () => {
  const { context, calls } = routePage(SAFE_PAYLOAD);
  const handle = await openEditorInContext({ cookies: [] } as never, "123", "1", context as never, 2000);
  assert.equal(calls.fulfill, 1, "проверенный ответ отдан странице");
  assert.equal(calls.abort, 0);
  assert.equal(handle.objectId, "123");
  await handle.close().catch(() => {});
});

test("382 major21: непроверяемый ответ (не JSON / нет data / сбой fetch) — fail-closed abort", async () => {
  for (const [label, payload, opts] of [
    ["не JSON", "<html>login</html>", {}],
    ["нет data", JSON.stringify({ object_id: "123" }), {}],
    ["сбой сети при fetch", SAFE_PAYLOAD, { fetchFails: true }],
  ] as const) {
    let closed = 0;
    const { context, calls } = routePage(payload, { ...opts }, () => { closed++; });
    await assert.rejects(
      openEditorInContext({ cookies: [] } as never, "123", "1", context as never, 2000),
      INVALID,
      `${label} — отказ (fail-closed)`,
    );
    assert.equal(calls.abort, 1, `${label}: модель не отдана странице`);
    assert.equal(closed, 1, `${label}: контекст закрыт`);
  }
});

test("382 major21: URL-шаблон — только GET модели /planner/?, save /planner/save/ не перехватывается", () => {
  assert.ok(PLANNER_MODEL_URL_RE.test("https://remplanner.ru/setup/api/planner/?object_id=1&plan_id=1"));
  assert.equal(PLANNER_MODEL_URL_RE.test("https://remplanner.ru/setup/api/planner/save/?object_id=1&is_forced=1"), false);
  assert.equal(PLANNER_MODEL_URL_RE.test("https://remplanner.ru/planner/"), false);
});

test("382 major21: assertPlannerModelResponse — таблица ответов (опасно/безопасно/пустой проект)", () => {
  assert.throws(() => assertPlannerModelResponse(evilPayload()), INVALID, "опасное имя листа в data — отказ");
  assert.throws(
    () => assertPlannerModelResponse(JSON.stringify({ data: JSON.stringify({ custom_plans: { sh1: SHEET({ id: ["x"] }) } }) })),
    INVALID,
    "не строковый id в data — отказ",
  );
  assert.doesNotThrow(() => assertPlannerModelResponse(SAFE_PAYLOAD), "безопасная модель — проход");
  assert.doesNotThrow(
    () => assertPlannerModelResponse(JSON.stringify({ object_id: "1", plan_id: "1", save_id: "s", units: "cm", data: "" })),
    "пустой проект (data='') — проход",
  );
  assert.doesNotThrow(
    () => assertPlannerModelResponse(JSON.stringify({
      object_id: "1", plan_id: "1", save_id: "s", units: "cm",
      data: JSON.stringify({ custom_plans: { sh1: SHEET({ name: "Mom's room & гостиная" }) } }),
    })),
    "сущность в имени — текст, не тег (№24) — проход",
  );
});

/** Workspace с deps.openEditor = настоящий openEditorInContext на мок-контексте. */
function wsWithRealOpenEditor(payload: string): { ws: Workspace; calls: { fulfill: number; abort: number } } {
  const { context, calls } = routePage(payload);
  const editor: EditorLike = {
    objectId: "123", planId: "1",
    async normalize(m) {
      const walls = Object.keys(m.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(m as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return COMPAT_OK as never; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", data_empty: false, model: baseModel() as unknown as Record<string, unknown> };
    },
    async openEditor(session, objectId, planId, editorOpts) {
      return openEditorInContext(session, objectId, planId, context as never, 2000, editorOpts) as unknown as EditorLike;
    },
  };
  void editor;
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  return { ws, calls };
}

test("382 major21: ВСЕ пути через ensureEditor (render_plan, wall-мутация, save) — страница с опасным ответом не запускается", async () => {
  // рабочая копия безопасна; СЕРВЕРНАЯ модель, которую скачает сама страница, — опасна
  for (const [label, run] of [
    ["render_plan", (ws: Workspace) => ws.renderPlan({})],
    ["wall-мутация", (ws: Workspace) => ws.applyWalls("wall_move", () => true)],
    ["save", (ws: Workspace) => ws.save()],
  ] as const) {
    const { ws, calls } = wsWithRealOpenEditor(evilPayload());
    await ws.open("123", "1");
    await assert.rejects(() => run(ws), INVALID, `${label}: запуск редактора с опасной серверной моделью отклонён`);
    assert.equal(calls.abort, 1, `${label}: route.abort — модель не исполнена страницей`);
    assert.equal(calls.fulfill, 0, `${label}: fulfill не вызывался`);
    await ws.close().catch(() => {});
  }
});

// ---------- minor 380 №23: гард в normalize адаптера ----------

test("382 minor23: normalize с опасным листом — INVALID_ARGUMENT, page.evaluate ни разу", async () => {
  let evalCalls = 0;
  const page = {
    async evaluate(): Promise<unknown> { evalCalls++; return {}; },
  };
  const handle = buildHandle(page as never, { close: async () => {} }, "123", "1", COMPAT_OK as never, { acquire: async () => {} });
  const m = modelWithSheets((mm) => {
    (mm.custom_plans ??= {} as never)["sh1"] = SHEET({ name: EVIL_NAME }) as never;
  });
  await assert.rejects(() => handle.normalize(m as unknown as Record<string, unknown>), INVALID, "гард normalize — отказ");
  assert.equal(evalCalls, 0, "модель с опасной строкой не передавалась в page.evaluate");
});

// ---------- minor 380 №24: «&amp; как текст» не блокирует редактор ----------

test("382 minor24: сущности и одиночный & в имени — безопасны на открытии (текстовый узел), < блокируется", () => {
  for (const ok of ["&amp; как текст", "Кухня &amp; гостиная", "&#39;тест", "a&#x3C;b", "&amp", "&#60", "&lt", "Кухня & гостиная", "Mom's room"]) {
    assert.equal(isSafeSheetNameForOpen(ok), true, `имя ${JSON.stringify(ok)} безопасно — сущность декодируется в текст, не в тег`);
  }
  for (const bad of [EVIL_NAME, "a<b", "<IMG"]) {
    assert.equal(isSafeSheetNameForOpen(bad), false, `имя ${JSON.stringify(bad)} блокируется`);
  }
  // полный путь: проект с именем «&amp; как текст» открывает редактор
  const m = modelWithSheets((mm) => {
    (mm.custom_plans ??= {} as never)["sh1"] = SHEET({ name: "&amp; как текст" }) as never;
  });
  assert.doesNotThrow(() => assertModelSafeForEditor(m), "открытие не блокируется");
});

// ---------- nit 380 №26: toolsIfLoaded читает дисковый кэш ----------

test("382 nit26: toolsIfLoaded онлайн возвращает дисковый кэш каталога без редактора", async () => {
  mkdirSync(CACHE_DIR, { recursive: true });
  const bundle = JSON.parse(readFileSync(join(here, "../fixtures/catalog-sample.json"), "utf8"));
  const raw = "tools" in (bundle as Record<string, unknown>) ? (bundle as { tools: unknown }).tools : bundle;
  writeFileSync(join(CACHE_DIR, "catalog-382.json"), JSON.stringify(raw));
  const ctx = new ServerContext({});
  const tools = await ctx.toolsIfLoaded();
  assert.ok(tools !== null, "каталог из дискового кэша — не null");
  assert.ok(typeof tools === "object" && Object.keys(tools as object).length > 0, "бандл из кэша не пуст");
});

// ---------- ревью 383 №32: reload:101, липкая ошибка, таймер ----------

test("383 minor32б: reload:101 в ответе модели — SESSION_EXPIRED и abort (не INVALID_ARGUMENT «нет data»)", async () => {
  const { context, calls } = routePage(JSON.stringify({ reload: 101 }), {}, () => {});
  await assert.rejects(
    openEditorInContext({ cookies: [] } as never, "123", "1", context as never, 2000),
    (e: unknown) => (e as { code?: string }).code === "SESSION_EXPIRED",
    "истекшая сессия при загрузке модели — SESSION_EXPIRED",
  );
  assert.equal(calls.abort, 1, "модель не отдана странице");
});

test("383 minor32а: второй опасный ответ после открытия — липкая ошибка читается в методах handle", async () => {
  const { context, calls, reloadModel } = routePage(SAFE_PAYLOAD);
  const handle = await openEditorInContext({ cookies: [] } as never, "123", "1", context as never, 2000);
  assert.equal(calls.fulfill, 1, "первый ответ безопасен — редактор открыт");
  await reloadModel(evilPayload());
  assert.equal(calls.abort, 1, "повторный опасный ответ — abort");
  const m = baseModel();
  await assert.rejects(() => handle.normalize(m as unknown as Record<string, unknown>), INVALID, "normalize: липкая ошибка — отказ");
  await assert.rejects(() => handle.save(2000), INVALID, "save: липкая ошибка — отказ");
  await assert.rejects(() => handle.renderPng({}), INVALID, "renderPng: липкая ошибка — отказ");
  await assert.rejects(() => handle.compatInfo(), INVALID, "compatInfo: липкая ошибка — отказ");
  await handle.close().catch(() => {});
});

test("383 minor32а: безопасная работа не нарушена (без reload ошибки методы работают)", async () => {
  const { context, calls } = routePage(SAFE_PAYLOAD);
  const handle = await openEditorInContext({ cookies: [] } as never, "123", "1", context as never, 2000);
  const m = { ...baseModel(), walls: {} };
  const res = await handle.normalize(m as unknown as Record<string, unknown>);
  assert.ok(res.model !== undefined, "normalize проходит без reload-ошибки");
  assert.equal(calls.abort, 0);
  await handle.close().catch(() => {});
});
