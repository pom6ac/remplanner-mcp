import { createHash } from "node:crypto";
import type { BrowserContext, Page } from "playwright-core";
import { getSharedBrowser } from "../browser.ts";
import { BASE_URL, BROWSER_TIMEOUT_MS } from "../config.ts";
import { McpError } from "../errors.ts";
import { parseSaveResponse, isReloadResponse, parseLoadResponse, type RawLoadResponse } from "../api.ts";
import { saveLimiter } from "../http.ts";
import { PAGE } from "./inject.js";
import { wallAxisSegments, wallAxisSetsEqual, wallAxisCoverageCm } from "../model/walls.ts";
import { assertModelSafeForEditor } from "../model/strings.ts";
import type { Model } from "../model/types.ts";
import { readCompat, assertCompatible, trackVersion, type CompatInfo, type CompatPresent } from "./compat.ts";
import type { SessionState } from "../session.ts";

export { type CompatInfo, type CompatPresent } from "./compat.ts";

export type EditorRoom = {
  id: string;
  name: string | null;
  /** Площадь по внутренним граням, м² (поле ROOMS2.area — в м²·100? нет: см²/10000 уже даёт м²; берём как есть). */
  area: number | null;
  area_m2: number | null;
  height: number | null;
  /** Полигон комнаты в см (живой ROOMS2/ROOMS1). */
  polygon?: { x: number; y: number }[];
};

/** Стена после draw (design §12.4): связи концов и признак наложения. */
export type NormalizedWall = {
  id: string;
  p1: { x: number; y: number };
  p2: { x: number; y: number };
  depth: number;
  link1: { ct: string; id: string; z0?: string; z1?: string; pos?: string } | null;
  link2: { ct: string; id: string; z0?: string; z1?: string; pos?: string } | null;
  overWall: boolean | null;
};

export type NormalizeResult = {
  /** project.copy("server") после restore → draw({rooms:1}). */
  model: Record<string, unknown>;
  rooms: EditorRoom[];
  before: { walls: number; holes: number; items: number; pillars?: number; rigels?: number };
  after: { walls: number; holes: number; items: number; pillars?: number; rigels?: number };
  /** Стены живого редактора после draw: связи концов и isOverWall (§12.4). */
  walls?: NormalizedWall[];
  /** Счётчики ошибок редактора из copy("server"). */
  errors?: Record<string, number> | null;
  /**
   * Статус повторного пересчёта комнат сохранения (ревью 139 m2):
   * "ok" — пересчёт прошёл, иначе — краткий код ошибки редактора
   * (без пользовательских данных). Пусто у старых моков/страниц.
   */
  roomsRebuild?: string;
};

export type EditorSaveResult = {
  ok: boolean;
  saveId: string | null;
  conflict: boolean;
};

export type RenderOptions = {
  /** Лист плана: init, create_walls, rooms, furniture, santeh, … */
  sheet?: string;
  widthPx?: number;
  dimensions?: boolean;
  /**
   * id предметов, которые должны быть ВИДНЫ на листе options.sheet (ревью v0.1.1 №3).
   * Вычисляет вызывающий: предметы не с этого листа (например, мебель на init) в
   * список не включаются — их слой на листе заведомо скрыт. draw и загрузка иконок
   * асинхронны — без ожидания скриншот фиксирует холст без предметов (дефект 1,
   * живая проба 17). Проверяются реальные DOM-элементы с видимостью, не подстрока
   * в innerHTML; при таймауте — RENDER_OUT_OF_SYNC без PNG.
   */
  itemIds?: string[];
};

export type EditorHandle = {
  objectId: string;
  planId: string;
  compat: CompatInfo;
  page: Page;
  normalize(model: Record<string, unknown>, waitMs?: number): Promise<NormalizeResult>;
  save(timeoutMs?: number): Promise<EditorSaveResult>;
  renderPng(options?: RenderOptions): Promise<Buffer>;
  compatInfo(): Promise<CompatInfo>;
  close(): Promise<void>;
};

/** Опции открытия редактора. */
export type OpenEditorOptions = {
  /**
   * Анонимный проект: контекст редактора не должен содержать cookies аккаунта
   * (инцидент 2026-11-15). object_id/plan_id редактора для свежего анонимного
   * проекта могут отличаться от запрошенных — они принимаются как фактические.
   */
  anonymous?: boolean;
};

/**
 * URL загрузки модели СТРАНИЦЕЙ редактора: GET /setup/api/planner/?… (сохранение —
 * /planner/save/, в шаблон не попадает). Экспортирован для офлайн-тестов гарда.
 */
export const PLANNER_MODEL_URL_RE = /\/setup\/api\/planner\/\?/;

/**
 * Проверка СЫРОГО ответа сервера с моделью проекта — того, что страница редактора
 * сама получает по GET /setup/api/planner/ и исполняет ($Project.restore →
 * CustomPlans.restore → addIconToPage, innerHTML). Fail-closed (ревью 380 №21):
 * опасные строки в модели, непроверяемый или нестандартный ответ запрещают
 * передачу модели в Chromium. Экспортирована для офлайн-тестов.
 */
export function assertPlannerModelResponse(rawBody: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    throw new McpError(
      "INVALID_ARGUMENT",
      "ответ сервера с моделью проекта не разобран как JSON — передача модели в Chromium отменена (fail-closed, ревью 380 №21)",
    );
  }
  if (typeof raw !== "object" || raw === null || typeof (raw as { data?: unknown }).data !== "string") {
    throw new McpError(
      "INVALID_ARGUMENT",
      "в ответе сервера нет строки data с моделью проекта — передача модели в Chromium отменена (fail-closed, ревью 380 №21)",
    );
  }
  const loaded = parseLoadResponse(raw as RawLoadResponse);
  assertModelSafeForEditor(loaded.model as unknown as Model);
}

/**
 * Защита от записи в чужой проект (инцидент 2026-11-15): анонимный поток не может
 * идти с cookies аккаунта, аккаунтный проект — открываться под другим object_id.
 */
export function assertProjectSession(
  session: SessionState,
  opts: OpenEditorOptions | undefined,
): void {
  if (opts?.anonymous && session.account) {
    throw new McpError("EDITOR_PROJECT_MISMATCH", "анонимный проект нельзя открывать с cookies аккаунта (state.json) — редактор открыл бы текущий проект аккаунта", {
      hint: "анонимные потоки используют отдельную сессию без аккаунтных cookies",
    });
  }
}

function cookieArgs(session: SessionState): { name: string; value: string; domain: string; path: string }[] {
  return session.cookies
    .filter((c) => c.domain.endsWith("remplanner.ru"))
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/" }));
}

/**
 * Опции Browser.newContext (ревью 385 №38: вынесено для офлайн-теста).
 * serviceWorkers: "block" — page.route на контексте не видит запросы service
 * worker, поэтому они блокируются целиком (в бандле navigator.serviceWorker
 * нет, но защита не должна зависеть от бандла).
 */
export function newContextOptions() {
  return {
    viewport: { width: 1600, height: 1000 },
    locale: "ru-RU",
    serviceWorkers: "block" as const,
  };
}

/**
 * Открывает редактор /planner/ для проекта (проект должен быть «текущим» по cookies:
 * object_id / object_plan_id / authkey / visitor_id из анонимной или аккаунтной сессии).
 * opts.anonymous — анонимный поток: cookies аккаунта запрещены; несовпадение id для
 * анонимного проекта допустимо (редактор создаёт свои), для аккаунтного — ошибка.
 */
export async function openEditor(
  session: SessionState,
  objectId: string,
  planId = "1",
  timeoutMs: number = BROWSER_TIMEOUT_MS,
  opts: OpenEditorOptions = {},
): Promise<EditorHandle> {
  assertProjectSession(session, opts);
  const browser = await getSharedBrowser();
  const context: BrowserContext = await browser.newContext(newContextOptions());
  try {
    if (session.cookies.length > 0) {
      await context.addCookies(cookieArgs(session)).catch(() => {});
    }
    return await openEditorInContext(session, objectId, planId, context, timeoutMs, opts);
  } catch (e) {
    await context.close().catch(() => {});
    throw e;
  }
}

/**
 * Открытие редактора в уже созданном контексте. try начинается СРАЗУ после выделения
 * контекста: отказ newPage/goto тоже должен закрывать контекст (R2-11).
 * @internal экспортирована для офлайн-тестов (мок контекста, без браузера).
 */
export async function openEditorInContext(
  session: SessionState,
  objectId: string,
  planId: string,
  context: Pick<BrowserContext, "newPage" | "route"> & { close(): Promise<void>; addCookies?: unknown },
  timeoutMs: number = BROWSER_TIMEOUT_MS,
  opts: OpenEditorOptions = {},
): Promise<EditorHandle> {
  // до всякой навигации: анонимный поток с аккаунтной сессией запрещён (инцидент 2026-11-15)
  assertProjectSession(session, opts);
  try {
    const page = await context.newPage();
    // ревью 380 №21/№27: ДО goto перехватываем ответ GET /setup/api/planner/? —
    // страницу грузит САМА страница и исполняет серверную модель ($Project.restore →
    // addIconToPage, innerHTML). Ответ проверяется до отдачи браузеру: опасная или
    // непроверяемая модель — route.abort() и отказ INVALID_ARGUMENT (fail-closed).
    // Это единая точка для всех запусков/перезагрузок страницы и для окна гонки
    // между свежим GET в runSave и GET самой страницы (№27). Каким бы путём ни
    // пришёл вызов (render_plan, wall-мутации, каталог, undo/redo, import,
    // повторный open, save), страницу не получает ничто, кроме проверенной модели.
    // Ревью 383 №33: route на КОНТЕКСТЕ (page.route не видит service worker).
    let unsafeModelError: unknown = null;
    let modelResponseDone: () => void = () => {};
    const modelResponseSeen = new Promise<void>((resolve) => {
      modelResponseDone = resolve;
    });
    await context.route(PLANNER_MODEL_URL_RE, async (route) => {
      try {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        const rawBody = await response.text();
        // ревью 383 №32б: reload:101 (истекшая сессия) — SESSION_EXPIRED до
        // разбора модели, а не INVALID_ARGUMENT «нет строки data»
        let parsed: unknown;
        try { parsed = JSON.parse(rawBody); } catch { parsed = null; }
        if (isReloadResponse(parsed)) {
          throw new McpError("SESSION_EXPIRED", "сессия истекла (reload:101) при загрузке модели редактором", {
            hint: "выполните npm run login",
          });
        }
        assertPlannerModelResponse(rawBody);
        await route.fulfill({ response });
      } catch (e) {
        // fail-closed: любая ошибка проверки (опасные строки, нестандартный
        // ответ, сбой сети) — abort и отказ, страница модель не получает;
        // текст ошибки без тела ответа сервера
        unsafeModelError = e instanceof McpError
          ? e
          : new McpError(
              "INVALID_ARGUMENT",
              `не удалось проверить ответ сервера с моделью проекта (${e instanceof Error ? e.message : String(e)}) — передача модели в Chromium отменена (fail-closed, ревью 380 №21)`,
            );
        await route.abort().catch(() => {});
      } finally {
        modelResponseDone();
      }
    });
    await page.goto(`${BASE_URL}/planner/`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    // Дождаться проверенного ответа модели (route.fulfill) или таймаута — как раньше
    // waitForResponse с catch: без ответа restore/draw гоняются с асинхронной
    // инициализацией редактора (copy('server') пуст).
    // Ревью 383 №32в: таймер очищается.
    let raceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        modelResponseSeen,
        new Promise((resolve) => { raceTimer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      clearTimeout(raceTimer);
    }
    // ревью 383 №32а: ошибка проверки ответа модели «липкая» — страница может
    // перезагрузиться (i.reload, restore_project) и получить второй, опасный
    // ответ уже после открытия; ошибка остаётся читаемой во всех методах handle
    const unsafeError = (): unknown => unsafeModelError;
    if (unsafeModelError !== null) throw unsafeModelError;
    await page
      .waitForFunction(PAGE.readyCheck, undefined, { timeout: timeoutMs, polling: 250 })
      .catch(async () => {
        const snippet = await page
          .evaluate(() => `${document.title} | ${location.pathname}`)
          .catch(() => "страница недоступна");
        throw new McpError("EDITOR_INCOMPATIBLE", `редактор не готов после открытия /planner/ (${snippet})`, {
          hint: "проверьте доступ к remplanner.ru и наличие Chrome (npm run check)",
        });
      });
    await page.evaluate(PAGE.clearFog);
    // осадка после инициализации: walls/rooms глобалы дорисовываются асинхронно
    await page.waitForTimeout(1500);
    const compat = await readCompat(page);
    assertCompatible(compat);
    trackVersion(compat);
    // защита от чужого проекта (инцидент 2026-11-15): редактор открыл не тот object_id/plan_id.
    // Для анонимных проектов расхождение допустимо: редактор создаёт свои id, их принимаем.
    if (!opts.anonymous) {
      const mismatch: string[] = [];
      if (compat.object_id && objectId && compat.object_id !== String(objectId)) {
        mismatch.push(`object_id ${compat.object_id} ≠ запрошенного ${objectId}`);
      }
      if (compat.plan_id && planId && compat.plan_id !== String(planId)) {
        mismatch.push(`plan_id ${compat.plan_id} ≠ запрошенного ${planId}`);
      }
      if (mismatch.length > 0) {
        throw new McpError("EDITOR_PROJECT_MISMATCH", `редактор открыл не запрошенный проект: ${mismatch.join(", ")}`, {
          hint: "cookies сессии указывают на другой проект; сохранение в чужой проект запрещено",
          details: { requested_object_id: objectId, requested_plan_id: planId, editor_object_id: compat.object_id, editor_plan_id: compat.plan_id },
        });
      }
    }
    return buildHandle(page, context, objectId, planId, compat, saveLimiter, opts, unsafeError);
  } catch (e) {
    await context.close().catch(() => {});
    throw e;
  }
}

/** @internal экспортирован для офлайн-тестов адаптера (мок Page, без браузера). */
export function buildHandle(
  page: Page,
  context: { close(): Promise<void> },
  objectId: string,
  planId: string,
  compat: CompatInfo,
  /** Квота сохранений; подменяется в офлайн-тестах, по умолчанию общая (R2-10). */
  limiter: { acquire(): Promise<void> } = saveLimiter,
  opts: OpenEditorOptions = {},
  /**
   * Липкая ошибка проверки ответа модели (ревью 383 №32а): страница может
   * перезагрузиться и получить опасный ответ уже после открытия — ошибка
   * проверяется в каждом методе handle, редактор не продолжает работу молча.
   */
  unsafeError: () => unknown = () => null,
): EditorHandle {
  // Целевой проект (инцидент 2026-11-15): фактические id страницы на момент открытия.
  // Для анонимных проектов редактор создаёт свои id — целевой тот, что сообщил редактор.
  const expectedObjectId = opts.anonymous ? (compat.object_id ?? objectId) : (compat.object_id || objectId);
  const expectedPlanId = opts.anonymous ? (compat.plan_id ?? planId) : (compat.plan_id || planId);
  // ревью 383 №32а: липкая ошибка — проверяется в каждом методе handle
  const failIfUnsafe = (): void => {
    const stuck = unsafeError();
    if (stuck !== null && stuck !== undefined) throw stuck;
  };
  const handle: EditorHandle = {
    objectId: expectedObjectId,
    planId: expectedPlanId,
    compat,
    page,
    async normalize(model, waitMs = 1200): Promise<NormalizeResult> {
      failIfUnsafe();
      // ревью 378 №14/№15: граница передачи модели в Chromium — restore ниже
      // исполняет CustomPlans.restore → addIconToPage (innerHTML имени листа,
      // data-id/data-date) прямо в page.evaluate. Проверка перед КАЖДОЙ
      // передачей, независимо от состояния редактора и пути модели
      // (единая точка assertModelSafeForEditor).
      assertModelSafeForEditor(model as unknown as Model);
      await page.evaluate(PAGE.clearFog);
      // R2-16 + ревью v0.1.1 №4: сравниваем ВХОДНУЮ модель с результатом — молчаливое
      // удаление элементов редактором не должно проходить как успех. Стены сравниваются
      // по покрытию осей (wallAxisCoverageCm): разрез и слияние коллинеарных стен —
      // допустимая нормализация (design §12), реальная потеря стены покрытие уменьшает;
      // проёмы и предметы потеряны быть не могут.
      const input = {
        walls: Object.keys((model as { walls?: Record<string, unknown> }).walls ?? {}).length,
        holes: Object.values((model as { walls?: Record<string, { holes?: Record<string, unknown> }> }).walls ?? {})
          .reduce((n: number, w: { holes?: Record<string, unknown> }) => n + Object.keys(w.holes ?? {}).length, 0),
        items: Object.keys((model as { items?: Record<string, unknown> }).items ?? {}).length,
        pillars: Object.keys((model as { pillars?: Record<string, unknown> }).pillars ?? {}).length,
        rigels: Object.keys((model as { rigels?: Record<string, unknown> }).rigels ?? {}).length,
      };
      // Playwright не вызывает строковые функции с аргументами — аргумент через window.
      // Повтор попытки: сразу после открытия редактора copy('server') может отставать
      // от живых WALLS (внутри inject.js есть опрос, здесь — подстраховка).
      let last: { restoreError: string } | NormalizeResult | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await page.waitForTimeout(1200);
        await page.evaluate((arg) => {
          (window as unknown as { __remplanner_arg?: unknown }).__remplanner_arg = arg;
        }, { model, waitMs });
        const res = (await page.evaluate(PAGE.restoreDrawCopy)) as
          | { restoreError: string; copy?: Record<string, unknown> }
          | (Omit<NormalizeResult, "model"> & { copy: Record<string, unknown> });
        if ("restoreError" in res) {
          throw new McpError("NORMALIZATION_DROPPED", `редактор отверг модель при restore: ${res.restoreError}`);
        }
        const result: NormalizeResult = {
          rooms: res.rooms,
          before: res.before,
          after: res.after,
          model: res.copy,
          // старые моки/страницы без этих полей — пустые значения по умолчанию
          walls: (res as { walls?: NormalizedWall[] }).walls ?? [],
          errors: (res as { errors?: Record<string, number> | null }).errors ?? null,
          roomsRebuild: (res as { roomsRebuild?: string }).roomsRebuild ?? "ok",
        };
        last = result;
        const copyWalls = Object.keys((result.model as { walls?: Record<string, unknown> })?.walls ?? {}).length;
        if (copyWalls === 0 && result.after.walls > 0) continue; // copy отстаёт — повтор
        // сверка «вход → редактор»: явная политика допустимых изменений (R2-16, №4,
        // R2-3): стены — эквивалентность канонических наборов осевых отрезков,
        // разрез/слияние коллинеарных стен допустимы, сдвиг/лишняя стена — нет
        const dropped: string[] = [];
        const inputWalls = (model as { walls?: Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }> }).walls;
        const afterWalls = (result.model as { walls?: Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }> }).walls;
        if (!wallAxisSetsEqual(wallAxisSegments(afterWalls), wallAxisSegments(inputWalls))) {
          dropped.push(`walls axis segments ${wallAxisSegments(inputWalls).length}→${wallAxisSegments(afterWalls).length} (покрытие ${Math.round(wallAxisCoverageCm(inputWalls) * 10)}→${Math.round(wallAxisCoverageCm(afterWalls) * 10)} мм)`);
        }
        if (result.after.holes < input.holes) dropped.push(`openings ${input.holes}→${result.after.holes}`);
        if (result.after.items < input.items) dropped.push(`items ${input.items}→${result.after.items}`);
        if (result.after.pillars !== undefined && result.after.pillars < (input.pillars ?? 0)) dropped.push(`pillars ${input.pillars}→${result.after.pillars}`);
        if (result.after.rigels !== undefined && result.after.rigels < (input.rigels ?? 0)) dropped.push(`rigels ${input.rigels}→${result.after.rigels}`);
        if (dropped.length > 0) {
          throw new McpError("NORMALIZATION_DROPPED", `редактор молча удалил элементы: ${dropped.join(", ")}`, {
            details: { dropped },
          });
        }
        return result;
      }
      return last as NormalizeResult;
    },
    async save(timeoutMs = BROWSER_TIMEOUT_MS): Promise<EditorSaveResult> {
      failIfUnsafe();
      // квота сохранений сайта (≤ 1 в 5 с, R2-10): браузерный save не минует лимитер
      await limiter.acquire();
      await page.evaluate(PAGE.clearFog);
      // предсохранительная сверка целевого проекта (инцидент 2026-11-15): если object_id
      // на странице сменился после открытия — project.save не запускается вовсе
      const current = await page.evaluate(PAGE.currentIds).catch(() => null) as { object_id?: string | null; plan_id?: string | null } | null;
      if (current && typeof current.object_id === "string" && current.object_id !== "" && current.object_id !== expectedObjectId) {
        throw new McpError("EDITOR_PROJECT_MISMATCH", `страница редактора сменила проект: object_id ${current.object_id} ≠ целевого ${expectedObjectId} — сохранение отменено`, {
          details: { expected_object_id: expectedObjectId, current_object_id: current.object_id },
        });
      }
      // R2-8: ОДИН постоянный listener регистрируется ДО триггера сохранения и
      // остаётся до конца сбора — ни чужой рано летящий автосейв, ни наш поздний
      // ответ не пропускаются; никаких повторных подписок waitForResponse.
      type SaveResponse = { url(): string; status(): number; text(): Promise<string>; request(): { postData(): string | null } | null };
      const responses: SaveResponse[] = [];
      const handler = (r: SaveResponse): void => {
        if (!r.url().includes("/setup/api/planner/save/")) return;
        responses.push(r);
      };
      (page as unknown as { on(ev: string, fn: (r: SaveResponse) => void): void }).on("response", handler);
      try {
        const started = (await page.evaluate(PAGE.savePlan)) as { started: boolean; error?: string };
        if (!started.started) {
          throw new McpError("SITE_ERROR", `project.save не сработал: ${started.error ?? "?"}`);
        }
        // ждём первый ответ, затем — окно тишины: отложенные автосейвы редактора
        const t0 = Date.now();
        while (responses.length === 0 && Date.now() - t0 < timeoutMs) {
          await new Promise((r) => setTimeout(r, 150));
        }
        // корреляция: наш project.save(false,true) отвечает is_forced=1 в query,
        // чужие автосейвы — без него (R2-8)
        const isForced = (r: SaveResponse): boolean => /[?&]is_forced=1(?:&|$)/.test(r.url());
        let lastCount = 0;
        let quietSince = Date.now();
        const QUIET_MS = 1500;
        // ждём окно тишины И наш принудительный ответ: чужой ранний автосейв не
        // завершает ожидание — наш save может прийти позже (R2-8)
        while (Date.now() - t0 < timeoutMs) {
          const hasForced = responses.some(isForced);
          if (hasForced && Date.now() - quietSince >= QUIET_MS) break;
          await new Promise((r) => setTimeout(r, 150));
          if (responses.length !== lastCount) {
            lastCount = responses.length;
            quietSince = Date.now();
          }
        }
        if (responses.length === 0) {
          throw new McpError("TIMEOUT", "редактор не ответил на сохранение за отведённое время");
        }
        // статусы всех относящихся ответов (R2-8): 5xx/429 не превращаем в «не-JSON»
        for (const r of responses) {
          if (r.status() >= 400) {
            throw new McpError("SITE_ERROR", `сайт ответил ${r.status()} на сохранение`);
          }
        }
        const bodies: unknown[] = [];
        for (const r of responses) {
          const text = await r.text();
          try {
            bodies.push(JSON.parse(text));
          } catch {
            // сырое тело НЕ включаем: может содержать секреты (R2-1); только размер
            bodies.push({ __nonjson: true, bytes: text.length });
          }
        }
        // reload:101 в ЛЮБОМ ответе — истекшая сессия (R2-9), а не «не удалось»
        for (const body of bodies) {
          if (isReloadResponse(body)) {
            throw new McpError("SESSION_EXPIRED", "сессия истекла (reload:101) при сохранении через редактор", {
              hint: "выполните npm run login",
            });
          }
        }
        const json = bodies.filter((b) => !(b as { __nonjson?: boolean }).__nonjson) as {
          result?: "success" | "fail"; save_id?: string; html_code?: string;
        }[];
        if (json.length === 0) {
          throw new McpError("SITE_ERROR", "ни один ответ на сохранение не разобран");
        }
        // корреляция (R2-8): разбираем ПОСЛЕДНИЙ ответ с is_forced=1 (наш save),
        // при отсутствии — последний ответ вообще
        const forcedIdx = responses.map((r, i) => (isForced(r) ? i : -1)).filter((i) => i >= 0);
        const pickIdx = forcedIdx.length > 0 ? forcedIdx[forcedIdx.length - 1]! : responses.length - 1;
        const parsed = parseSaveResponse(json[pickIdx] as { result: "success" | "fail"; save_id?: string; html_code?: string });
        return { ok: parsed.ok, saveId: parsed.save_id, conflict: parsed.conflict };
      } finally {
        (page as unknown as { off(ev: string, fn: (r: SaveResponse) => void): void }).off("response", handler);
      }
    },
    async renderPng(options?: RenderOptions): Promise<Buffer> {
      failIfUnsafe();
      return renderPlan(page, options ?? {});
    },
    async compatInfo(): Promise<CompatInfo> {
      failIfUnsafe();
      const info = await readCompat(page);
      handle.compat = info;
      return info;
    },
    async close(): Promise<void> {
      await context.close().catch(() => {});
    },
  };
  return handle;
}

/**
 * Предикат видимости предметов в SVG листа (ревью v0.1.1 №3, R2-2) — единственная
 * реализация: исполняется через page.waitForFunction и в тестах на DOM-фрагменте.
 * Идентификатор сопоставляется ТОЧНО — атрибут id или data-id, равный id предмета,
 * либо точный токен класса (этап 53: у текущего редактора предмет — класс вида
 * `item_x_<id>`; этап 55, ревью №5: сопоставляется ровно токен `item_x_<id>`, а не
 * произвольный префикс «item_» с суффиксом — видимый `item_x_notsofa1` не должен
 * закрывать ожидание отсутствующего sofa1); подстрока давала ложное совпадение
 * sofa1 ↔ sofa10, когда отсутствующий sofa1 «закрывался» видимым sofa10.
 */
export function itemsRenderedInSvg(ids: string[]): boolean {
  const svg = document.querySelector("#canvas_v2_wrapper svg");
  if (!svg) return false;
  return ids.every((id) => {
    const el = [...svg.querySelectorAll("*")].find((e) => {
      if (e.getAttribute("id") === id) return true;
      if (e.getAttribute("data-id") === id) return true;
      // текущая разметка редактора (глобал 757): предмет — класс ровно `item_x_<id>`
      // (id сайта уже начинается с «_», поэтому в классе он выглядит как «__<id>»);
      // точное равенство токена исключает ложные совпадения sofa1 ↔ sofa10/sofa10x
      // и notsofa1 ↔ sofa1 (этап 55, ревью №5)
      return (e.getAttribute("class") ?? "").split(/\s+/).some((tok) => tok === id || tok === `item_x_${id}`);
    });
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  });
}

/**
 * Рендер плана в PNG: переключение листа, скриншот элемента #canvas_v2_wrapper.
 * Публичные точки редактора ($Project.setPlanName / $Project.focus) опциональны:
 * при отсутствии — клик по навигации листов (.groups_navi_item.plan_*).
 */
export async function renderPlan(page: Page, options: RenderOptions): Promise<Buffer> {
  const sheet = options.sheet ?? "init";
  const width = options.widthPx ?? 1600;
  await page.evaluate(PAGE.clearFog);
  await switchSheet(page, sheet);
  // предметы: draw и загрузка иконок асинхронны — ждём видимые DOM-элементы каждого
  // предмета на листе (ревью v0.1.1 №3); при таймауте PNG не отдаётся
  const itemIds = options.itemIds ?? [];
  if (itemIds.length > 0) {
    await page.waitForFunction(itemsRenderedInSvg, itemIds, { timeout: BROWSER_TIMEOUT_MS, polling: 250 }).catch(() => {
      throw new McpError("RENDER_OUT_OF_SYNC", `предметы не отрисованы на листе «${sheet}» (${itemIds.join(", ")}) — картинка не отдаётся`, {
        hint: "повторите render_plan; при повторении сверитесь с model_get и model_validate",
        details: { items: itemIds, sheet },
      });
    });
  }
  if (options.dimensions === false) {
    await page.evaluate(() => {
      const t = document.querySelector("#plannertool_ruler, .toolid16");
      if (t && t.classList.contains("active")) (t as HTMLElement).click();
    }).catch(() => {});
  }
  // Ширина скриншота — через viewport (без image-зависимостей).
  if (width !== 1600) {
    const vp = page.viewportSize();
    if (vp && vp.width !== width) {
      await page.setViewportSize({ width, height: Math.round((width * vp.height) / vp.width) });
      await page.waitForTimeout(400);
    }
  }
  // центрирование плана (T16): $Project.focus при наличии
  await page.evaluate(() => {
    const p = (window as unknown as { $Project?: { focus?: () => void } }).$Project;
    try { p?.focus?.(); } catch { /* не критично */ }
  }).catch(() => {});
  await page.waitForTimeout(600);
  // план редактора — SVG внутри #canvas_v2_wrapper; сам wrapper может иметь нулевую
  // высоту (SVG inline переполняет его) — берём первый ВИДИМЫЙ элемент (живая проба)
  const target = await page.evaluate(() => {
    const box = (el: Element | null): { w: number; h: number } => {
      if (!el) return { w: 0, h: 0 };
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    };
    const wrapper = document.querySelector("#canvas_v2_wrapper");
    if (box(wrapper).h > 50) return { selector: "#canvas_v2_wrapper", index: 0 };
    const svgs = [...(wrapper?.querySelectorAll("svg") ?? [])];
    let best = -1;
    let bestArea = 0;
    svgs.forEach((svg, i) => {
      const b = box(svg);
      if (b.w > 100 && b.h > 100 && b.w * b.h > bestArea) {
        best = i;
        bestArea = b.w * b.h;
      }
    });
    if (best >= 0) return { selector: "#canvas_v2_wrapper svg", index: best };
    const canvases = [...document.querySelectorAll("canvas")];
    const visIdx = canvases.findIndex((c) => { const b = box(c); return b.w > 100 && b.h > 100; });
    if (visIdx >= 0) return { selector: "canvas", index: visIdx };
    return null;
  }).catch(() => null);
  if (!target) {
    throw new McpError("EDITOR_INCOMPATIBLE", "не найден видимый элемент плана (#canvas_v2_wrapper/svg/canvas)");
  }
  const el = page.locator(target.selector).nth(target.index);
  const buf = await el.screenshot({ timeout: BROWSER_TIMEOUT_MS }).catch(async (e: unknown) => {
    throw new McpError("SITE_ERROR", `скриншот плана (${target.selector}[${target.index}]) не удался (${e instanceof Error ? e.name : "ошибка"})`);
  });
  if (width !== 1600) {
    await page.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
  }
  return buf;
}

/**
 * Тело переключения листа — единственная реализация (ревью v0.1.1 №6), исполняется
 * через page.evaluate. Клик по навигации (.groups_navi_item.plan_<имя>) — путь
 * пользователя: он включает видимость слоёв листа (живая проба 17: после
 * $Project.setPlanName("furniture") предметы остаются display:none, после клика
 * по навигации — рисуются). setPlanName — запасной путь, когда навигации нет.
 */
export function switchSheetInPage(name: string): "click" | "setPlanName" | null {
  // B6 (аудит 65): имя листа не конкатенируется в CSS-селектор — перебираем
  // элементы навигации и сравниваем ТОКЕН classList точно (classList.contains
  // сопоставляет целый токен). Значение вида "x, #unrelated" не может добавить
  // ветку селектора или выбрать чужой элемент; схема листа (SHEET_NAME_PATTERN)
  // дополнительно отсекает такие значения на границе инструментов.
  const wanted = `plan_${name}`;
  const items = document.querySelectorAll(".groups_navi_item");
  for (const el of items) {
    if (el.classList.contains(wanted)) {
      (el as HTMLElement).click();
      return "click";
    }
  }
  const w = window as unknown as { $Project?: { setPlanName?: (n: string) => void } };
  if (w.$Project && typeof w.$Project.setPlanName === "function") {
    try {
      w.$Project.setPlanName(name);
      return "setPlanName";
    } catch {
      /* не критично */
    }
  }
  return null;
}

async function switchSheet(page: Page, sheet: string): Promise<void> {
  const done = await page.evaluate(switchSheetInPage, sheet).catch(() => null);
  if (done === null && sheet !== "init") {
    throw new McpError("INVALID_ARGUMENT", `лист плана «${sheet}» не найден в навигации редактора`);
  }
}

/** Хеш содержимого бандла (для compat-лога). */
export function bundleHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
