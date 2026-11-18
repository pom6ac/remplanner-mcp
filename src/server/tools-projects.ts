import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { SCENARIO_HINT, mmInt, mmPoint } from "./context.ts";
import type { ServerContext } from "./context.ts";
import { ok, tool, type ToolDefLike as ToolDef } from "./toolkit.ts";
import { McpError } from "../errors.ts";
import { inspectPath, writePrivateFile } from "../fs-safe.ts";
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
  if (e instanceof SyntaxError) {
    return new McpError("INVALID_ARGUMENT", `файл не является JSON модели: ${shown}`);
  }
  if (e instanceof RangeError) {
    return new McpError("INVALID_ARGUMENT", `JSON слишком глубоко вложен: ${shown}`);
  }
  return e as McpError;
}

/**
 * Прочитать и разобрать файл .plan: JSON-объект с моделью ({model: …} или сама модель).
 * RAW EDITOR PAYLOAD (src/dto/model-payload.ts): формат сырого payload принадлежит
 * сайту remplanner.ru (см↔мм — см. шапку model-payload.ts); совместимость между
 * версиями сайта не гарантируется. Разбор — parseModelImport (B5).
 */
export function readPlanFile(p: string, options: { maxBytes?: number } = {}): Model {
  const maxBytes = options.maxBytes ?? MAX_PLAN_FILE_BYTES;
  // B3 (аудит 65): проверки до чтения — symlink, не-обычный файл, размер.
  let stat;
  try {
    stat = inspectPath(p);
  } catch (e) {
    throw planFileError(e, p);
  }
  if (stat.symlink) {
    throw new McpError("INVALID_ARGUMENT", `файл является символической ссылкой, импорт отклонён: ${shownPath(p)}`);
  }
  if (!stat.regular) {
    throw new McpError("INVALID_ARGUMENT", `путь не является обычным файлом: ${shownPath(p)}`);
  }
  if (stat.size > maxBytes) {
    throw new McpError("INVALID_ARGUMENT", `файл слишком большой (${stat.size} байт, лимит ${maxBytes}): ${shownPath(p)}`);
  }
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    throw planFileError(e, p);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw planFileError(e, p);
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
    throw new McpError("INVALID_ARGUMENT", `файл не является планом (JSON модели): ${shownPath(p)}`);
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
        "Файл можно позже импортировать project_import_plan.",
      {
        path: z.string().min(1).describe("путь к файлу (.plan)"),
        scope: z.enum(["current", "full"]).optional().describe("current — компактная модель, full — полная (по умолчанию full)"),
      },
      async (args) => {
        const ws = ctx.workspace();
        const scope = (args["scope"] as string | undefined) ?? "full";
        // RAW EDITOR PAYLOAD (src/dto/model-payload.ts): обе ветки — сырая модель
        // сайта в см, формат принадлежит сайту; scope=current — модель без обёртки,
        // scope=full — {model, saved_at}
        const payload = scope === "current" ? ws.model : { model: ws.model, saved_at: new Date().toISOString() };
        try {
          // B3/B4 (аудит 65): атомарная запись, 0600, отказ на symlink/не-обычную цель.
          writePrivateFile(args["path"] as string, JSON.stringify(payload, null, 1));
        } catch (e) {
          if (e instanceof McpError) throw e;
          throw planFileError(e, args["path"] as string, "export");
        }
        return ok({ path: args["path"], scope, bytes: JSON.stringify(payload).length });
      },
    ),

    project_import_plan: tool(
      "Импортировать планировку из файла .plan (JSON модели) вместо текущей. " +
        "Требует явного replace: true — операция затирает несохранённые правки. После импорта правки НЕ сохранены: project_save отдельно.",
      {
        path: z.string().min(1),
        replace: z.literal(true).describe("подтверждение замены текущей планировки"),
      },
      async (args) => {
        const model = readPlanFile(args["path"] as string);
        const ws = ctx.workspace();
        ws.apply("import_plan", (m) => {
          // ревью 66 №2: замена по общему реестру коллекций — новые сущности
          // (ригели, газ, границы, проёмы пола) не выпадают из импорта
          replaceEntityCollections(m, model);
          return true;
        });
        return ok({ imported: args["path"], walls: Object.keys(ws.model.walls).length, hint: SCENARIO_HINT });
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
