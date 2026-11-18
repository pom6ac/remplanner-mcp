import { existsSync, readFileSync, readdirSync } from "node:fs";
import { z } from "zod";
import { STATE_PATH, STATE_ANON_PATH, CACHE_DIR } from "../config.ts";
import { TOOL_COORD_LIMIT_MM } from "../limits.ts";
import { McpError, errorToPayload } from "../errors.ts";
import { loadSession, hasLiveCookies, type SessionState } from "../session.ts";
import { createAnonProject, loadModel, renameProject, checkStatus, type LoadedModel } from "../api.ts";
import { openEditor, type EditorHandle } from "../editor/adapter.ts";
import { loadCachedTools, fetchTools, extractToolsBundleName, applyToolFixes, searchTools, toToolEntry, type ToolsBundle, type ToolEntry } from "../catalog.ts";
import { Workspace, type WorkspaceDeps, type EditorLike, type OpenProject } from "../workspace.ts";
import type { Model, FixtureEnvelope } from "../model/types.ts";
import type { CompactModel } from "../model/compact.ts";
import { compactModel } from "../model/compact.ts";

// Контекст MCP-сервера: сессия (аккаунт/аноним), рабочее пространство, каталог.
// Офлайн-режим (REMPLANNER_OFFLINE_FIXTURE=путь) — модель из фикстуры, сеть запрещена:
// для smoke-тестов SDK-клиентом без сайта.

export type ServerMode = "account" | "anon" | "offline";

export class ServerContext {
  mode: ServerMode;
  private sessionState: SessionState | null = null;
  private anonSessionInternal: SessionState | null = null;
  private workspaceInternal: Workspace | null = null;
  private toolsBundle: ToolsBundle | null = null;
  /** Последний открытый проект — target по умолчанию для чтения/рендера. */
  fixturePath: string | null;
  private depsOverride: Partial<WorkspaceDeps> | null = null;

  constructor(options: { offlineFixture?: string; deps?: Partial<WorkspaceDeps> } = {}) {
    this.depsOverride = options.deps ?? null;
    this.fixturePath = options.offlineFixture ?? null;
    this.mode = options.offlineFixture ? "offline" : "anon";
  }

  session(): SessionState {
    if (this.mode === "offline") {
      throw new McpError("AUTH_REQUIRED", "офлайн-режим: сеть недоступна", { hint: "уберите REMPLANNER_OFFLINE_FIXTURE" });
    }
    if (this.sessionState === null) {
      if (!process.env["REMPLANNER_ANON"] && existsSync(STATE_PATH) && hasLiveCookies(loadSession(STATE_PATH))) {
        this.mode = "account";
        // помечаем сессию как аккаунтную: анонимные потоки с ней запрещены
        // (инцидент 2026-11-15: запись в проект пользователя через редактор)
        this.sessionState = { ...loadSession(STATE_PATH), account: true };
      } else if (existsSync(STATE_ANON_PATH)) {
        this.sessionState = loadSession(STATE_ANON_PATH);
      } else {
        this.sessionState = { cookies: [] };
      }
    }
    return this.sessionState;
  }

  /**
   * Сессия для анонимных проектов: НИКОГДА не аккаунтная (state.json не читается).
   * Анонимный проект в контексте редактора с аккаунтными cookies открыл бы текущий
   * проект аккаунта (инцидент 2026-11-15: запись тестовой модели в проект пользователя).
   */
  anonSession(): SessionState {
    if (this.anonSessionInternal === null) {
      this.anonSessionInternal = { cookies: [] };
    }
    return this.anonSessionInternal;
  }

  workspace(): Workspace {
    if (this.mode === "offline" && this.workspaceInternal === null) {
      this.seedOfflineWorkspace();
    }
    if (this.workspaceInternal === null) {
      throw new McpError("INVALID_ARGUMENT", "проект не открыт — сначала project_open (или project_create)");
    }
    return this.workspaceInternal;
  }

  get workspaceOrNull(): Workspace | null {
    return this.workspaceInternal;
  }

  private offlineModel(): Model {
    if (this.fixturePath === null) throw new McpError("INTERNAL", "офлайн-модель без фикстуры");
    const env = JSON.parse(readFileSync(this.fixturePath, "utf8")) as FixtureEnvelope | Model;
    const model = "model" in env ? env.model : env;
    return structuredClone(model) as Model;
  }

  private seedOfflineWorkspace(): void {
    const model = this.offlineModel();
    const objectId = String(model.id ?? "offline");
    const planId = String(model.plan_id ?? "1");
    const stub: WorkspaceDeps = {
      session: { cookies: [] },
      async loadModel(): Promise<LoadedModel> {
        throw new McpError("AUTH_REQUIRED", "офлайн-режим: сетевые операции недоступны", {
          hint: "уберите REMPLANNER_OFFLINE_FIXTURE для работы с сайтом",
        });
      },
      async openEditor(): Promise<EditorLike> {
        throw new McpError("AUTH_REQUIRED", "офлайн-режим: редактор недоступен", {
          hint: "уберите REMPLANNER_OFFLINE_FIXTURE для работы с сайтом",
        });
      },
    };
    const deps = { ...stub, ...this.depsOverride };
    const ws = new Workspace(deps, { offline: true });
    ws.project = {
      objectId,
      planId,
      saveId: "offline",
      dirty: false,
      openedAt: new Date().toISOString(),
      anon: true,
    };
    (ws as unknown as { modelInternal: Model }).modelInternal = model;
    // единственный снимок истории в офлайне
    (ws as unknown as { pushSnapshot: (l: string) => void }).pushSnapshot("offline-open");
    this.workspaceInternal = ws;
  }

  private deps(options: { session?: SessionState; anon?: boolean } = {}): WorkspaceDeps {
    const session = options.session ?? this.session();
    const anon = options.anon ?? session.account !== true;
    return {
      session,
      loadModel: (s, objectId, planId) => loadModel(s, objectId, planId),
      openEditor: (s, objectId, planId, editorOpts) =>
        openEditor(s, objectId, planId, undefined, { ...editorOpts, anonymous: editorOpts?.anonymous ?? anon }) as Promise<EditorLike>,
    };
  }

  /** Открыть проект (загрузка по HTTP в каноническую модель). */
  async open(objectId: string, planId = "1", opts: { anon?: boolean; session?: SessionState } = {}): Promise<{ project: OpenProject; compact: CompactModel }> {
    if (this.workspaceInternal === null) {
      const base = this.deps({ session: opts.session, anon: opts.anon });
      const deps: WorkspaceDeps = { ...base, ...this.depsOverride };
      // сессия проекта — всегда та, с которой он открыт/создан (инцидент 2026-11-15):
      // depsOverride.session не подменяет её. anonymous вычисляется здесь и оборачивает
      // даже подменённый openEditor из depsOverride: анонимный проект не должен
      // открывать редактор с аккаунтными cookies ни при какой подмене deps
      deps.session = base.session;
      const anon = opts.anon ?? deps.session.account !== true;
      deps.openEditor = (s, objectId, planId, editorOpts) =>
        (this.depsOverride?.openEditor ?? base.openEditor)(s, objectId, planId, { ...editorOpts, anonymous: editorOpts?.anonymous ?? anon });
      this.workspaceInternal = new Workspace(deps);
    }
    const project = await this.workspaceInternal.open(objectId, planId, { anon: opts.anon });
    return { project, compact: compactModel(this.workspaceInternal.model) };
  }

  /**
   * Анонимный проект (создаётся без аккаунта) и сразу открыть.
   * Сессия — всегда свежая без аккаунтных cookies: аккаунтные cookies в этом
   * запросе привязали бы проект к аккаунту (инцидент 2026-11-15).
   */
  async createAnon(): Promise<{ object_id: string; plan_id: string }> {
    const session = this.anonSession();
    const created = await createAnonProject(session);
    // cookies проекта уже в session (captureCookiesInto) — сохранить в state.anon
    const { saveSession } = await import("../session.ts");
    saveSession(STATE_ANON_PATH, session);
    await this.open(created.object_id, created.plan_id || "1", { anon: true, session });
    return created;
  }

  async listProjects() {
    const info = await checkStatus(this.session());
    return info.projects.map((p) => ({
      object_id: p.object_id,
      title: p.title,
      updated_at: p.updated,
      floors: p.floors,
      plans: p.plans,
      area_m2: p.area_m2,
    }));
  }

  async authStatus() {
    if (this.mode === "offline") {
      return { logged_in: false, tariff: "unknown", mode: "offline", projects_limit: null, account_email_masked: null };
    }
    if (process.env["REMPLANNER_ANON"] || this.mode !== "account") {
      return { logged_in: false, tariff: "unknown", mode: "anon", projects_limit: null, account_email_masked: null };
    }
    try {
      const info = await checkStatus(this.session());
      return {
        logged_in: info.logged_in,
        tariff: info.tariff,
        mode: "account",
        projects_limit: info.tariff === "free" ? 1 : null,
        account_email_masked: null,
      };
    } catch (e) {
      if (e instanceof McpError && (e.code === "CAPTCHA_REQUIRED" || e.code === "SESSION_EXPIRED")) throw e;
      throw e;
    }
  }

  async rename(objectId: string, title: string): Promise<void> {
    await renameProject(this.session(), objectId, title);
  }

  /** Бандл каталога: офлайн — фикстура; онлайн — кэш по global_version, иначе редактор. */
  async tools(): Promise<ToolsBundle> {
    if (this.toolsBundle !== null) return this.toolsBundle;
    if (this.mode === "offline") {
      const path = this.fixturePath!.replace(/[^/]*$/, "catalog-sample.json");
      if (!existsSync(path)) {
        throw new McpError("NOT_FOUND", `офлайн-фикстура каталога не найдена: ${path}`);
      }
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const bundle: ToolsBundle =
        typeof parsed === "object" && parsed !== null && "tools" in parsed
          ? (parsed as { tools: ToolsBundle }).tools
          : (parsed as ToolsBundle);
      this.toolsBundle = bundle;
      return bundle;
    }
    // из кэша: последний catalog-*.json
    const cacheDir = CACHE_DIR;
    if (existsSync(cacheDir)) {
      const files = readdirSync(cacheDir).filter((f) => /^catalog-.+\.json$/.test(f)).sort();
      const last = files[files.length - 1];
      if (last) {
        try {
          this.toolsBundle = applyToolFixes(JSON.parse(readFileSync(`${cacheDir}/${last}`, "utf8")) as ToolsBundle);
          return this.toolsBundle;
        } catch { /* битый кэш — тянем из редактора */ }
      }
    }
    const ws = this.workspaceOrNull;
    if (ws === null) {
      throw new McpError("INVALID_ARGUMENT", "каталог ещё не скачан и проект не открыт — откройте проект (project_open)");
    }
    const editor = await ws.ensureEditor();
    const compat = await editor.compatInfo();
    const bundleName = extractToolsBundleNameFromBundles(compat.bundles);
    const globalVersion = compat.global_version ?? "unknown";
    this.toolsBundle = await fetchTools(bundleName, globalVersion);
    return this.toolsBundle;
  }

  /** Позиция каталога по точному имени (для item_add). */
  async toolEntry(name: string): Promise<ToolEntry> {
    const tools = await this.tools();
    const raw = tools[name];
    if (!raw) {
      const found = searchTools(tools, name, { limit: 5 }).map((t) => t.name);
      throw new McpError("NOT_FOUND", `позиция каталога «${name}» не найдена`, {
        hint: found.length > 0 ? `похожие: ${found.join(", ")}` : "найдите точное имя через catalog_search",
      });
    }
    return toToolEntry(name, raw);
  }
}

/** Имя бандла каталога из списка скриптов страницы (compatInfo.bundles). */
export function extractToolsBundleNameFromBundles(bundles: string[]): string {
  const name = bundles.find((b) => /planner\.tools___\d+___\d+\.js/.test(b));
  if (!name) {
    throw new McpError("EDITOR_INCOMPATIBLE", "среди скриптов страницы нет бандла каталога planner.tools");
  }
  return name;
}

// ---------- Помощники инструментов ----------

export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 1);
}

/** Единый формат ошибки: isError + JSON {code, message, hint?, details?} (design §8).
 * Сериализация — общая с toolkit (этап 145, B2): неожиданные исключения не отдают e.message. */
export function errorResult(e: unknown): { isError: true; content: { type: "text"; text: string }[] } {
  return { isError: true, content: [{ type: "text", text: jsonText(errorToPayload(e)) }] };
}

/** Общий сценарий работы с планом — вставляется в описания мутирующих инструментов. */
export const SCENARIO_HINT =
  "Сценарий: правки → model_validate (инварианты) → render_plan (визуальная проверка) → project_save (запись на сервер). Мутации НЕ сохраняют на сервер сами.";

// Zod-примитивы (мм) переехали в DTO-слой (аудит 65 C4): src/dto/units.ts.
// Реэкспорт сохраняет прежние импорты tools-*.ts и тестов.
import { mmInt, mmIntSigned, mm, mmPoint } from "../dto/units.ts";
export { mmInt, mmIntSigned, mm, mmPoint };

export function requireOpen(ctx: ServerContext): Workspace {
  try {
    return ctx.workspace();
  } catch (e) {
    if (e instanceof McpError && e.code === "INVALID_ARGUMENT") throw e;
    throw e;
  }
}

/** Ссылка на канонический тип для компактной модели (для аннотаций инструментов). */
export type { CompactModel };
export type { EditorHandle };
export type { OpenProject };
