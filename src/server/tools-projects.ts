import { constants as fsConstants, fstatSync, lstatSync, readSync, closeSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { SCENARIO_HINT, mmInt, mmPoint } from "./context.ts";
import type { ServerContext } from "./context.ts";
import { ok, tool, type ToolDefLike as ToolDef } from "./toolkit.ts";
import { McpError } from "../errors.ts";
import { ensurePrivateDir, fsWriteCalls, inspectPath, writePrivateFile } from "../fs-safe.ts";
import { PLANS_DIR } from "../config.ts";
import type { Model } from "../model/types.ts";
import { clearEntityCollections, replaceEntityCollections, MODEL_ENTITY_COLLECTIONS } from "../model/collections.ts";
import { MAX_PLAN_FILE_BYTES, MAX_SERVICE_COMMENT_CHARS } from "../limits.ts";
import { parseModelImport } from "../model/import-schema.ts";

// T18: инструменты сессии и проектов (design §7.1).

/**
 * B3 (аудит 65): id проекта/планировки — числовые строки (как отдаёт сайт);
 * нечисловое значение отклоняется схемой ещё до HTTP и workspace.
 */
const NUMERIC_ID = /^\d+$/;
const objectIdSchema = z.string().regex(NUMERIC_ID, "object_id — числовой id проекта (project_list/project_create)");
const planIdSchema = z.string().regex(NUMERIC_ID, "plan_id — числовой id планировки");

/**
 * B3 (аудит 65): лимит размера файла плана при импорте (проверка до чтения).
 * Значение — src/limits.ts (все лимиты входа в одном месте, B5).
 */
export { MAX_PLAN_FILE_BYTES };

/** Поля, по которым опознаётся модель в .plan (для проверки формата при импорте). */
const PLAN_MODEL_KEYS = new Set<string>([
  ...MODEL_ENTITY_COLLECTIONS,
  "v", "id", "plan_id", "total_height", "final", "rooms1", "rooms2", "floors", "plans",
]);

/**
 * Путь для сообщения об ошибке (M3 ревью 150): абсолютный путь пользователя
 * наружу не идёт — только basename; относительный показывается как задан.
 */
function shownPath(p: string): string {
  return /^([A-Za-z]:[\\/]|\/)/.test(p) ? basename(p) : p;
}

/**
 * Ожидаемые ошибки пользователя у файловых операций (M3 ревью 150): файл не
 * найден, нет доступа, это каталог, битый JSON, не тот формат — McpError с
 * понятным текстом, а не нейтральное «внутренняя ошибка: Error (ERR-…)».
 * Прочие ошибки пробрасываются как есть (неожиданные, сериализует errorToPayload).
 * Для export (m10 ревью 152) ENOENT/ENOTDIR — это отсутствующий каталог назначения,
 * а не файл: «путь не найден».
 */
function planFileError(e: unknown, p: string, kind: "import" | "export" = "import"): McpError {
  const shown = shownPath(p);
  const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return kind === "export"
      ? new McpError("NOT_FOUND", `путь не найден: ${shown}`)
      : new McpError("NOT_FOUND", `файл не найден: ${shown}`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new McpError("INVALID_ARGUMENT", `нет доступа к файлу: ${shown}`);
  }
  if (code === "EISDIR") {
    return new McpError("INVALID_ARGUMENT", `путь указывает на каталог, а не файл: ${shown}`);
  }
  // ревью 214 №4: ожидаемые ошибки пользователя — понятный отказ, а не INTERNAL
  if (code === "ENAMETOOLONG") {
    return new McpError("INVALID_ARGUMENT", `слишком длинное имя пути: ${shown}`);
  }
  if (code === "EEXIST") {
    return new McpError("INVALID_ARGUMENT", `файл или каталог с таким именем уже существует: ${shown}`);
  }
  if (code === "ELOOP") {
    return new McpError("INVALID_ARGUMENT", `путь содержит символическую ссылку, операция отклонена: ${shown}`);
  }
  if (code === "ERR_INVALID_ARG_VALUE") {
    return new McpError("INVALID_ARGUMENT", `недопустимое значение пути: ${shown}`);
  }
  if (e instanceof SyntaxError) {
    return new McpError("INVALID_ARGUMENT", `файл не является JSON модели: ${shown}`);
  }
  if (e instanceof RangeError) {
    return new McpError("INVALID_ARGUMENT", `JSON слишком глубоко вложен: ${shown}`);
  }
  return e as McpError;
}

/**
 * realpath существующего префикса пути: хвост (несуществующие компоненты)
 * дописывается к realpath ближайшего существующего предка. Нужно, чтобы
 * сравнивать кандидата с реальным корнем в одинаковой нормализации
 * (realpathSync падает на несуществующем хвосте, а macOS /var → /private/var
 * даёт расхождение уже на существующем префиксе).
 */
function realpathExisting(p: string): string {
  let tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      tail.push(basename(cur));
      const parent = dirname(cur);
      if (parent === cur) throw e;
      cur = parent;
    }
  }
}

/**
 * B3 (аудит 65, решение пользователя): политика корневого каталога import/export.
 * `path` инструментов — путь ОТНОСИТЕЛЬНО корня plans (PLANS_DIR, рядом с
 * backups/renders). Абсолютный путь принимается, только если после resolve он
 * внутри корня. Отказ (INVALID_ARGUMENT) при: выходе за корень (`..`, абсолютный
 * путь вне корня), symlink в любом существующем компоненте пути внутри корня,
 * на сам файл или на корень plans (отказ до любых mkdir/chmod — ревью 214 №1;
 * каталог состояния приложения symlink-ом быть может — ревью 216 №11),
 * расширении не `.plan`, пустом имени, нулевом
 * байте, пути вида `~/…` (подсказка «относительно каталога plans»). Корень
 * создаётся при первом использовании (0700, ensurePrivateDir). Каталог
 * состояния приложения может быть символической ссылкой — корень считается
 * от его реального пути (ревью 216 №11).
 */
export type ResolvedPlanPath = {
  /** абсолютный путь внутри корня plans (после resolve) */
  absolute: string;
  /** путь относительно корня plans, как его задал пользователь (нормализован) */
  relative: string;
  /** realpath корня plans — для повторных TOCTOU-проверок перед операцией (ревью 214 №3) */
  realRoot: string;
};

/**
 * Внутри ли p корня root (строго, сам корень — нет). Ревью 214 №5: `..` проверяется
 * с разделителем (`rel === ".."` или `rel.startsWith(".." + sep)`), иначе имя вида
 * `..kitchen.plan` внутри корня получает ложный отказ «выходит за корень».
 */
const containsInside = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
};

/**
 * Ревью 214 №1, уточнено ревью 216 №11 (решение координатора): корень plans
 * не может быть символической ссылкой — проверка lstat выполняется ДО
 * ensurePrivateDir: mkdir/chmod идут по ссылке и меняют внешний каталог ещё
 * до проверок пути (chmod 0700 на цели ссылки — побочный эффект даже при
 * отклонённом запросе). Каталог состояния приложения (REMPLANNER_HOME) быть
 * ссылкой МОЖЕТ — это доверенная настройка пользователя (как backups/renders
 * до корневой политики); корень plans считается от реального пути.
 */
function rejectSymlinkRoots(): void {
  try {
    if (lstatSync(PLANS_DIR).isSymbolicLink()) {
      throw new McpError("INVALID_ARGUMENT", "корень plans — символическая ссылка, операция отклонена");
    }
  } catch (e) {
    if (e instanceof McpError) throw e;
    // нет каталога — его создаст ensurePrivateDir; прочее (ENAMETOOLONG и т.п.) — как есть
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export function resolvePlanPath(input: string): ResolvedPlanPath {
  const shown = shownPath(input);
  if (input.trim() === "") {
    throw new McpError("INVALID_ARGUMENT", "путь к плану пустой");
  }
  if (input.includes("\0")) {
    // ревью 214 №4: нулевой байт отклоняем явно, а не через INTERNAL
    throw new McpError("INVALID_ARGUMENT", `путь содержит нулевой байт: ${shown}`);
  }
  if (/^~/.test(input)) {
    // ревью 214 №6, расширено 216 №12: `~/x.plan` и `~user/x.plan` молча
    // создавали каталог с именем `~`/`~user` в корне; отклоняем любой ведущий
    // `~` с подсказкой, что путь задаётся относительно каталога plans
    throw new McpError("INVALID_ARGUMENT", `путь должен быть относительно каталога plans (~ в начале пути не поддерживается): ${shown}`);
  }
  if (basename(input).toLowerCase() === ".plan") {
    // ревью 214 №6: имя файла сравнивается без учёта регистра, как и расширение
    throw new McpError("INVALID_ARGUMENT", "путь к плану без имени файла: " + shown);
  }
  if (!input.toLowerCase().endsWith(".plan")) {
    throw new McpError("INVALID_ARGUMENT", `расширение файла плана должно быть .plan: ${shown}`);
  }
  // ревью 216 №9: подготовка корня plans (проверка symlink, mkdir, realpath) —
  // те же ожидаемые ошибки пользователя (EACCES/EPERM/ENOTDIR/EEXIST), понятный
  // INVALID_ARGUMENT вместо INTERNAL, как в d714539
  let realRoot: string;
  try {
    rejectSymlinkRoots();
    ensurePrivateDir(PLANS_DIR);
    realRoot = realpathSync(PLANS_DIR);
  } catch (e) {
    if (e instanceof McpError) throw e;
    // ревью 218 №16: причина на стадии подготовки — в самом корне plans, а не в
    // запрошенном файле; единый текст без имени пути пользователя (и без
    // абсолютного пути корня)
    const code = (e as NodeJS.ErrnoException).code;
    throw new McpError("INVALID_ARGUMENT", `каталог plans недоступен (${code ?? "ошибка файловой системы"})`);
  }
  // resolve принимает и относительный (к корню), и абсолютный вход;
  // абсолютный вне корня сразу даёт rel с ".."
  const candidate = resolve(PLANS_DIR, input);
  // ревью 214 №5: containment через relative с разделителем (см. containsInside).
  // Ревью 218 №15: если каталог состояния — symlink, абсолютный путь, заданный
  // через реальную цель (realpath(HOME)/plans/…), указывает на тот же каталог —
  // принимаем и по реальному корню, иначе ложный отказ «выходит за корень».
  // Сравнение с realRoot — в одинаковой нормализации (realpath существующего
  // префикса кандидата).
  const insideLexical = containsInside(PLANS_DIR, candidate);
  let rel: string;
  if (insideLexical) {
    rel = relative(PLANS_DIR, candidate);
  } else {
    const realCandidate = realpathExisting(candidate);
    if (!containsInside(realRoot, realCandidate)) {
      throw new McpError("INVALID_ARGUMENT", `путь выходит за корень plans (.. и пути вне корня запрещены): ${shown}`);
    }
    rel = relative(realRoot, realCandidate);
  }
  // symlink в любом существующем компоненте пути (от корня до файла) — отказ;
  // несуществующий хвост пропускаем (его создаст export), ENOTDIR — как ENOENT
  let deepest = insideLexical ? PLANS_DIR : realRoot;
  for (const part of rel.split(sep)) {
    const cur = join(deepest, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") break;
      // ревью 214 №4: ENAMETOOLONG и подобные — понятный отказ
      throw planFileError(e, input);
    }
    if (st.isSymbolicLink()) {
      throw new McpError("INVALID_ARGUMENT", `путь содержит символическую ссылку, операция отклонена: ${shown}`);
    }
    deepest = cur;
  }
  // realpath каждого существующего компонента — внутри realpath корня
  // (страховка от mount/symlink-трюков на уровне ФС)
  let realDeepest: string;
  try {
    realDeepest = realpathSync(deepest);
  } catch (e) {
    throw planFileError(e, input);
  }
  if (realDeepest !== realRoot && !containsInside(realRoot, realDeepest)) {
    throw new McpError("INVALID_ARGUMENT", `реальный путь выходит за корень plans: ${shown}`);
  }
  return { absolute: candidate, relative: rel, realRoot };
}

/**
 * Точка инъекции для тестов TOCTOU-обработчиков (ревью 218 №13): ESM-namespace
 * node:fs не патчится, тесты подменяют realpathSync здесь — подмена каталога
 * выполняется ровно между resolvePlanPath и проверкой в обработчике. Продовый
 * код поле не трогает; по умолчанию — системная функция.
 */
export const fsCheckCalls: { realpathSync: typeof realpathSync } = { realpathSync };

/**
 * Ревью 214 №3 (TOCTOU): между resolvePlanPath и операцией локальный процесс того
 * же пользователя мог подменить подкаталог на ссылку. Повторная проверка —
 * realpath каталога назначения всё ещё внутри реального корня. Отсутствующий
 * каталог назначения не пропускается (ревью 218 №14): проверяется realpath
 * ближайшего существующего предка — иначе export успел бы создать подкаталог
 * снаружи по подменённой ссылке (ensurePrivateDir идёт до второй проверки),
 * и снаружи оставался бы пустой каталог. Исчезновение самого корня (ENOENT на
 * realRoot) — не отказ: ensurePrivateDir пересоздаст его по исходному пути.
 */
function assertDirStillInside(res: ResolvedPlanPath): void {
  let probe = dirname(res.absolute);
  for (;;) {
    let real: string;
    try {
      real = fsCheckCalls.realpathSync(probe);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && probe !== res.realRoot) {
        const parent = dirname(probe);
        if (parent === probe) throw planFileError(e, res.relative);
        probe = parent;
        continue;
      }
      throw planFileError(e, res.relative);
    }
    if (real !== res.realRoot && !containsInside(res.realRoot, real)) {
      throw new McpError("INVALID_ARGUMENT", `реальный путь выходит за корень plans: ${res.relative}`);
    }
    return;
  }
}
// ревью 216 №10: экспорт для тестов TOCTOU-слоя (подмена между resolve и операцией)
export { assertDirStillInside };

/** Флаг O_NOFOLLOW, если платформа его поддерживает (на Windows отсутствует — 0). */
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/**
 * Прочитать и разобрать файл .plan: JSON-объект с моделью ({model: …} или сама модель).
 * RAW EDITOR PAYLOAD (src/dto/model-payload.ts): формат сырого payload принадлежит
 * сайту remplanner.ru (см↔мм — см. шапку model-payload.ts); совместимость между
 * версиями сайта не гарантируется. Разбор — parseModelImport (B5).
 * `display` — как показать путь в ошибке (ревью 214 №8): относительный путь
 * согласованно сохраняет подкаталоги, абсолютный заменяется на basename.
 */
export function readPlanFile(p: string, options: { maxBytes?: number; display?: string } = {}): Model {
  const maxBytes = options.maxBytes ?? MAX_PLAN_FILE_BYTES;
  const shown = options.display ?? shownPath(p);
  // B3 (аудит 65): проверки до чтения — symlink, не-обычный файл, размер.
  let stat;
  try {
    stat = inspectPath(p);
  } catch (e) {
    throw planFileError(e, shown);
  }
  if (stat.symlink) {
    throw new McpError("INVALID_ARGUMENT", `файл является символической ссылкой, импорт отклонён: ${shown}`);
  }
  if (!stat.regular) {
    throw new McpError("INVALID_ARGUMENT", `путь не является обычным файлом: ${shown}`);
  }
  if (stat.size > maxBytes) {
    throw new McpError("INVALID_ARGUMENT", `файл слишком большой (${stat.size} байт, лимит ${maxBytes}): ${shown}`);
  }
  // Ревью 214 №3 (TOCTOU): чтение через дескриптор, открытый с O_NOFOLLOW —
  // подмена финального компонента пути на ссылку между lstat-проверкой и чтением
  // даёт ELOOP (понятный отказ), а не чтение чужого файла. Открытие — через
  // инъекционную точку fsWriteCalls (ревью 216 №10): тест подменяет файл на
  // ссылку ровно между inspectPath и открытием.
  let fd: number;
  try {
    fd = fsWriteCalls.openSync(p, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    throw planFileError(e, shown);
  }
  let raw: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new McpError("INVALID_ARGUMENT", `путь не является обычным файлом: ${shown}`);
    }
    // Ревью 214 №7 (hardlink): жёсткая ссылка внутри plans может указывать на
    // файл вне корня того же пользователя; такие файлы при импорте отклоняются.
    if (st.nlink > 1) {
      throw new McpError("INVALID_ARGUMENT", `файл имеет несколько жёстких ссылок (${st.nlink}), импорт отклонён: ${shown}`);
    }
    if (st.size > maxBytes) {
      throw new McpError("INVALID_ARGUMENT", `файл слишком большой (${st.size} байт, лимит ${maxBytes}): ${shown}`);
    }
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, buf, offset, st.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    raw = buf.toString("utf8", 0, offset);
  } catch (e) {
    if (e instanceof McpError) throw e;
    throw planFileError(e, shown);
  } finally {
    closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw planFileError(e, shown);
  }
  const root = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
  const model = (root !== null && (root["model"] ?? root)) as unknown;
  // минимальная проверка формата (M3 ревью 150): модель — объект, содержащий
  // хотя бы одно известное поле модели (коллекция сущностей, plan_id, total_height,
  // floors/plans); иначе JSON валиден, но это не план
  if (
    model === null || typeof model !== "object" || Array.isArray(model) ||
    !Object.keys(model as Record<string, unknown>).some((k) => PLAN_MODEL_KEYS.has(k))
  ) {
    throw new McpError("INVALID_ARGUMENT", `файл не является планом (JSON модели): ${shown}`);
  }
  // B5 (аудит 65): структурная валидация модели (Zod-схема, лимиты сущностей,
  // конечные числа/диапазоны, глубина) вместо TS-cast; неизвестные поля
  // редактора сохраняются (passthrough). Ошибка — INVALID_ARGUMENT с путём поля.
  return parseModelImport(model) as Model;
}

export function projectTools(ctx: ServerContext): Record<string, ToolDef> {
  return {
    auth_status: tool(
      "Статус сессии remplanner: вошли ли в аккаунт, тариф (free/pro), режим (account/anon/offline), лимит проектов. " +
        "Вызывайте первым, чтобы понять режим работы: в режиме anon проекты анонимные (живут в cookies, ~до месяца), " +
        "в режиме account — проекты вашего аккаунта (на бесплатном тарифе только 1 проект). " +
        "Офлайн-режим (переменная REMPLANNER_OFFLINE_FIXTURE) — только для проверки инструментов без сайта.",
      {},
      async () => ok(await ctx.authStatus()),
    ),

    project_list: tool(
      "Список проектов аккаунта (нужен вход, анонимные проекты не перечисляются). " +
        "Возвращает object_id, название, дату обновления, число этажей и планировок.",
      {},
      async () => ok(await ctx.listProjects()),
    ),

    project_create: tool(
      "Создать НОВЫЙ анонимный проект и сразу открыть его (project_open не нужен). " +
        "Название задаётся в ЛК сайта вручную — у анонимных проектов его нет. " +
        "Проект привязан к cookie-сессии сервера (~/.remplanner-mcp/state.anon.json) и не попадает в аккаунт пользователя. " +
        "Дальше: room_add_rect → opening_add → item_add → model_validate → render_plan → project_save.",
      {
        units: z.enum(["cm", "mm"]).optional().describe("единицы проекта на сайте (модель всегда в мм); по умолчанию cm"),
      },
      async (args) => {
        void args;
        const created = await ctx.createAnon();
        return ok({ ...created, hint: "проект создан и открыт; правки сохраняйте project_save" });
      },
    ),

    project_open: tool(
      "Открыть проект: каноническая модель читается с сервера (GET), возвращается компактная модель " +
        "(стены W1.., комнаты R1.. с площадями, предметы I1..). Все дальнейшие инструменты работают с открытым проектом. " +
        "Повторный project_open перечитывает сервер и СБРАСЫВАЕТ несохранённые правки (это способ отказаться от правок). " +
        "Если сервер отдал непустой проект (save_id > 0 или непустой data), а модель разобралась пустой — ошибка MODEL_PARSE_EMPTY.",
      {
        object_id: objectIdSchema.describe("id проекта (project_list или project_create)"),
        plan_id: planIdSchema.optional().describe("id планировки; по умолчанию основной"),
      },
      async (args) => {
        const objectId = args["object_id"] as string;
        const planId = (args["plan_id"] as string | undefined) ?? "1";
        const res = await ctx.open(objectId, planId);
        return ok(res);
      },
    ),

    project_save: tool(
      "Сохранить открытый проект на сервер. Порядок: model_validate → project_save. " +
        "Перед записью делается снимок модели в ~/.remplanner-mcp/backups/. " +
        "Ответ содержит will_delete — сколько объектов серверной версии будет удалено " +
        "(walls, openings и по коллекции на каждый публичный ключ model_get: items, pillars, rigels, gas_lines, pipes, " +
        "terrace_borders, territory_borders, level_holes, led_strips, stripes_light, line_strips, cables, rulers, comments, " +
        "warm_floors, pipes_warm_floor, pipes_conditioner, pipes_heat, pipes_ventilation) — " +
        "и warnings; проверьте их, если модель открыта не с нуля. " +
        "Если save_id на сервере новее (правки в другой вкладке сайта) — ошибка SAVE_CONFLICT: " +
        "не форсируйте вслепую — сначала перечитайте проект (project_open) или спросите пользователя; " +
        "принудительная запись поверх чужих правок — только явный force: true. " +
        "Сохранение проекта, открытого с пустой моделью при непустой серверной, блокируется без force. " +
        "Ограничение сайта: не чаще одного сохранения в 5 секунд. Свежая модель на сервере после сохранения проверяется автоматически.",
      {
        force: z.boolean().optional().describe("принудительная запись при SAVE_CONFLICT (по умолчанию false)"),
        comment: z.string().max(MAX_SERVICE_COMMENT_CHARS).optional().describe("служебный комментарий (в бэкап-снимок)"),
      },
      async (args) => {
        void args["comment"];
        const res = await ctx.workspace().save({ force: args["force"] === true });
        return ok(res);
      },
    ),

    project_rename: tool(
      "Переименовать проект аккаунта (нужен вход). Не работает с анонимными проектами. Название ≤ 40 символов.",
      {
        object_id: objectIdSchema,
        title: z.string().min(1).max(40),
      },
      async (args) => {
        await ctx.rename(args["object_id"] as string, args["title"] as string);
        return ok({ renamed: args["object_id"] });
      },
    ),

    project_export_plan: tool(
        "Экспортировать текущую планировку в файл .plan (JSON модели; scope full — со всеми полями модели). " +
        "path — путь ОТНОСИТЕЛЬНО корневого каталога plans (~/.remplanner-mcp/plans, рядом с backups/renders), " +
        "например kitchen.plan или 2026/kitchen.plan; подкаталоги создаются сами. " +
        "Абсолютный путь принимается, только если он внутри каталога plans. Выход за корень (..), " +
        "символические ссылки (в любом компоненте пути и на сам корень plans), пути вида ~/…, " +
        "расширение кроме .plan отклоняются. " +
        "Файл можно позже импортировать project_import_plan.",
      {
        path: z.string().min(1).describe(
          "путь к файлу (.plan) относительно каталога plans (~/.remplanner-mcp/plans), например kitchen.plan или 2026/kitchen.plan; " +
            "абсолютный — только внутри plans; .., ~/… и symlink запрещены",
        ),
        scope: z.enum(["current", "full"]).optional().describe("current — компактная модель, full — полная (по умолчанию full)"),
      },
      async (args) => {
        const ws = ctx.workspace();
        const scope = (args["scope"] as string | undefined) ?? "full";
        // resolvePlanPath сам переводит ошибки ФС в понятные McpError (ревью 214)
        const resolved = resolvePlanPath(args["path"] as string);
        // RAW EDITOR PAYLOAD (src/dto/model-payload.ts): обе ветки — сырая модель
        // сайта в см, формат принадлежит сайту; scope=current — модель без обёртки,
        // scope=full — {model, saved_at}
        const payload = scope === "current" ? ws.model : { model: ws.model, saved_at: new Date().toISOString() };
        try {
          // ревью 214 №3 (TOCTOU): повторная проверка корня до mkdir/chmod и записи
          assertDirStillInside(resolved);
          // подкаталоги внутри корня plans создаются (0700)
          ensurePrivateDir(dirname(resolved.absolute));
          assertDirStillInside(resolved);
          // B3/B4 (аудит 65): атомарная запись, 0600, отказ на symlink/не-обычную цель.
          writePrivateFile(resolved.absolute, JSON.stringify(payload, null, 1));
        } catch (e) {
          if (e instanceof McpError) throw e;
          throw planFileError(e, resolved.relative, "export");
        }
        return ok({ path: resolved.absolute, relative_path: resolved.relative, scope, bytes: JSON.stringify(payload).length });
      },
    ),

    project_import_plan: tool(
        "Импортировать планировку из файла .plan (JSON модели) вместо текущей. " +
        "path — путь ОТНОСИТЕЛЬНО корневого каталога plans (~/.remplanner-mcp/plans), как в project_export_plan; " +
        "абсолютный путь — только внутри plans; выход за корень (..), символические ссылки (в любом компоненте " +
        "пути, на файл и на сам корень plans), пути вида ~/…, файлы с несколькими жёсткими ссылками (nlink>1) " +
        "и расширение кроме .plan отклоняются. " +
        "Требует явного replace: true — операция затирает несохранённые правки. После импорта правки НЕ сохранены: project_save отдельно.",
      {
        path: z.string().min(1).describe(
          "путь к файлу (.plan) относительно каталога plans (~/.remplanner-mcp/plans), например kitchen.plan; " +
            "абсолютный — только внутри plans; .., ~/… и symlink запрещены",
        ),
        replace: z.literal(true).describe("подтверждение замены текущей планировки"),
      },
      async (args) => {
        // resolvePlanPath сам переводит ошибки ФС в понятные McpError (ревью 214)
        const resolved = resolvePlanPath(args["path"] as string);
        // ревью 214 №3 (TOCTOU): повторная проверка корня до чтения
        assertDirStillInside(resolved);
        // ревью 214 №8: в ошибках чтения показывается относительный путь целиком
        const model = readPlanFile(resolved.absolute, { display: resolved.relative });
        const ws = ctx.workspace();
        ws.apply("import_plan", (m) => {
          // ревью 66 №2: замена по общему реестру коллекций — новые сущности
          // (ригели, газ, границы, проёмы пола) не выпадают из импорта
          replaceEntityCollections(m, model);
          return true;
        });
        return ok({ imported: resolved.absolute, relative_path: resolved.relative, walls: Object.keys(ws.model.walls).length, hint: SCENARIO_HINT });
      },
    ),

    project_clear: tool(
      "Очистить текущую планировку (убрать все стены, проёмы и предметы) в рабочей копии. " +
        "Требует confirm: true. До project_save сервер не трогается; отменить можно undo.",
      {
        confirm: z.literal(true),
      },
      async (args) => {
        if (args["confirm"] !== true) throw new McpError("INVALID_ARGUMENT", "нужно confirm: true");
        const ws = ctx.workspace();
        ws.apply("clear", (m) => {
          // ревью 66 №2: очистка по общему реестру коллекций
          clearEntityCollections(m);
          return true;
        });
        return ok({ cleared: true, hint: SCENARIO_HINT });
      },
    ),

    floor_list: tool(
      "Этажи и планировки открытого проекта. На бесплатном тарифе этаж один; несколько этажей/планировок — PRO.",
      {},
      async () => {
        const ws = ctx.workspace();
        const floors = (ws.model["floors"] as unknown) ?? undefined;
        return ok({
          plan_id: ws.project!.planId,
          floors: Array.isArray(floors) ? floors : [{ floor_id: "1", plans: [ws.project!.planId] }],
          note: "несколько этажей — PRO (NOT_AVAILABLE_ON_TARIFF)",
        });
      },
    ),

    plan_list: tool(
      "Планировки (листы плана) открытого проекта: init (чертёж), create_walls, rooms, furniture, santeh — " +
        "это ЛИСТЫ ОТОБРАЖЕНИЯ (render_plan sheet=…), а не отдельные проекты.",
      {},
      async () => {
        const ws = ctx.workspace();
        const plans = (ws.model["plans"] as string[]) ?? ["init", "create_walls", "rooms", "furniture", "santeh"];
        return ok({ plans, note: "лист для render_plan: sheet=<имя>" });
      },
    ),

    undo: tool(
      "Отменить последние мутации рабочей копии (до 50 шагов). Работает до сохранения; после project_save история сбрасывается.",
      { steps: mmInt.optional().describe("сколько шагов (по умолчанию 1)") },
      async (args) => {
        const res = ctx.workspace().undo(typeof args["steps"] === "number" ? args["steps"] : 1);
        return ok({ ...res, ...ctx.workspace().historyInfo() });
      },
    ),

    redo: tool(
      "Повторить отменённые мутации рабочей копии.",
      { steps: mmInt.optional().describe("сколько шагов (по умолчанию 1)") },
      async (args) => {
        const res = ctx.workspace().redo(typeof args["steps"] === "number" ? args["steps"] : 1);
        return ok({ ...res, ...ctx.workspace().historyInfo() });
      },
    ),

    editor_status: tool(
      "Статус связки с редактором: версия сайта (global_version), совместимость адаптера, запущен ли headless-браузер, " +
        "dirty (есть несохранённые правки), save_id. При EDITOR_INCOMPATIBLE сайт обновился и адаптер надо сверить с новой версией.",
      {},
      async () => {
        const ws = ctx.workspaceOrNull;
        const editor = ws?.editorOrNull() ?? null;
        const compat = editor ? await editor.compatInfo() : null;
        return ok({
          mode: ctx.mode,
          editor_running: editor !== null,
          dirty: ws?.project?.dirty ?? null,
          save_id: ws?.project?.saveId ?? null,
          object_id: ws?.project?.objectId ?? null,
          global_version: compat?.global_version ?? null,
          bundles: compat?.bundles?.slice(0, 10) ?? [],
          compatible: compat ? Object.values(compat.present).every(Boolean) : null,
        });
      },
    ),
  };
}
