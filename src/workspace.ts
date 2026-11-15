import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BACKUPS_DIR } from "./config.ts";
import { McpError } from "./errors.ts";
import type { SessionState } from "./session.ts";
import type { LoadedModel } from "./api.ts";
import type { NormalizeResult, EditorSaveResult, RenderOptions, CompatInfo, EditorRoom } from "./editor/adapter.ts";
import type { Model } from "./model/types.ts";
import type { RoomPolygon } from "./model/items.ts";
import { roomPolygons } from "./model/items.ts";
import { prepareForRestore, findUnattachedEnds } from "./model/walls.ts";
import { renderPlanToFile, type RenderedPlan, type RenderRevision } from "./render.ts";

// T17: рабочее пространство — открытые проекты, каноническая модель (GET), история
// undo/redo (до 50), dirty, save_id, снимок в backups/ перед сохранением, SAVE_CONFLICT.

/** Подмножество EditorHandle, нужное workspace (структурно совместимо с EditorHandle). */
export type EditorLike = {
  objectId: string;
  planId: string;
  normalize(model: Record<string, unknown>, waitMs?: number): Promise<NormalizeResult>;
  save(timeoutMs?: number): Promise<EditorSaveResult>;
  renderPng(options?: RenderOptions): Promise<Buffer>;
  compatInfo(): Promise<CompatInfo>;
  close(): Promise<void>;
};

/** Сетевые зависимости workspace — вводятся снаружи (юнит-тесты подставляют моки). */
export type WorkspaceDeps = {
  session: SessionState;
  loadModel(session: SessionState, objectId: string, planId: string): Promise<LoadedModel>;
  openEditor(session: SessionState, objectId: string, planId: string, options?: { anonymous?: boolean }): Promise<EditorLike>;
};

export type OpenProject = {
  objectId: string;
  planId: string;
  saveId: string;
  dirty: boolean;
  openedAt: string;
  /** Анонимный проект: редактору отдаётся сессия без аккаунтных cookies (инцидент 2026-11-15). */
  anon: boolean;
};

export type SaveOutcome = {
  save_id: string;
  save_id_before: string;
  backup_path: string;
  verified: boolean;
  rounds: number;
  /** Сверка с серверной версией перед записью: сколько объектов сервера будет удалено. */
  will_delete: { walls: number; openings: number; items: number };
  /** Предупреждения (удаления объектов сервера). */
  warnings: string[];
};

export type HistorySnapshot = { label: string; at: string };

export const MAX_HISTORY = 50;

/** Результат мутации стен: полезное значение + предупреждения (офлайн-режим). */
export type WallMutation<T> = { result: T; warnings: string[] };

/** Счётчики объектов модели: стены, проёмы, предметы. */
export function modelCounts(model: Model | Record<string, unknown>): { walls: number; openings: number; items: number } {
  const m = model as Model;
  const walls = m.walls ?? {};
  return {
    walls: Object.keys(walls).length,
    openings: Object.values(walls).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0),
    items: Object.keys(m.items ?? {}).length,
  };
}

/** Короткий хэш содержимого модели (для ревизии рендера и сверок). */
export function modelHash(model: Model): string {
  return createHash("sha256").update(JSON.stringify(model)).digest("hex").slice(0, 16);
}

/** Счётчики ошибок редактора (copy("server").errors) — рост → INVALID_GEOMETRY (§12.4). */
function errorGrowth(before: Record<string, number> | null | undefined, after: Record<string, number> | null | undefined): string[] {
  if (!before || !after) return [];
  const grown: string[] = [];
  for (const [k, v] of Object.entries(after)) {
    if ((before[k] ?? 0) < v) grown.push(`${k}: ${before[k] ?? 0}→${v}`);
  }
  return grown;
}

/** Разобранная модель без содержимого: ни стен, ни предметов, ни прочих сущностей. */
export function modelIsContentEmpty(model: Model): boolean {
  const c = modelCounts(model);
  if (c.walls > 0 || c.items > 0) return false;
  const nonEmpty = (v: unknown): boolean => v !== null && v !== undefined && typeof v === "object" && Object.keys(v as object).length > 0;
  if (nonEmpty(model.pillars) || nonEmpty(model.rulers) || nonEmpty(model.comments)) return false;
  if (nonEmpty(model.rooms2) || nonEmpty(model.rooms1)) return false;
  return true;
}

function toModel(raw: Record<string, unknown>): Model {
  const model = raw as Model;
  model.walls ??= {};
  model.items ??= {};
  model.pillars ??= {};
  model.rulers ??= {};
  model.comments ??= {};
  // сервер отдаёт holes: null у стен без проёмов — нормализуем в {}
  for (const w of Object.values(model.walls)) {
    w.holes ??= {};
  }
  return model;
}

export class Workspace {
  readonly deps: WorkspaceDeps;
  project: OpenProject | null = null;
  private modelInternal: Model | null = null;
  /** Снимки истории: JSON-строки модели; historyIndex указывает на текущее состояние. */
  private snapshots: { json: string; label: string; at: number }[] = [];
  private historyIndex = -1;
  private editorInternal: EditorLike | null = null;
  /** Комнаты последней нормализации (кеш workspace, design §12.5): выручает, когда в
   *  канонической копии rooms2 ещё пусто (редактор кладёт полигоны после save → reload). */
  private roomsCache: EditorRoom[] = [];
  /** Офлайн-режим: стены меняются без нормализации (REMPLANNER_OFFLINE_FIXTURE). */
  offline = false;
  /** Базовые счётчики ошибок редактора для проверки роста (§12.4). */
  private lastErrors: Record<string, number> | null = null;
  /** Проект открыт с пустой моделью (дефект 3, отчёт 11) — сохранение под защитой. */
  private openedEmpty = false;

  constructor(deps: WorkspaceDeps, options: { offline?: boolean } = {}) {
    this.deps = deps;
    this.offline = options.offline ?? false;
  }

  get model(): Model {
    if (!this.modelInternal) {
      throw new McpError("INVALID_ARGUMENT", "проект не открыт — сначала project_open");
    }
    return this.modelInternal;
  }

  get editor(): EditorLike {
    if (!this.editorInternal) {
      throw new McpError("INVALID_ARGUMENT", "редактор не запущен (запускается при сохранении/рендере)");
    }
    return this.editorInternal;
  }

  /** Запущен ли редактор (для инструментов, которым он нужен опционально). */
  editorOrNull(): EditorLike | null {
    return this.editorInternal;
  }

  /**
   * Каноническая модель читается по HTTP (GET /setup/api/planner/).
   * opts.anon — анонимный проект: редактор открывается без аккаунтных cookies
   * (инцидент 2026-11-15), его фактические object_id/plan_id принимаются как целевые.
   */
  async open(objectId: string, planId = "1", opts: { anon?: boolean } = {}): Promise<OpenProject> {
    const loaded = await this.deps.loadModel(this.deps.session, objectId, planId);
    this.modelInternal = toModel(structuredClone(loaded.model));
    // Дефект 3 (отчёт 11): пустая разобранная модель при непустом проекте на сервере —
    // ошибка, а не молчаливое открытие (сохранение затёрло бы проект пользователя).
    if (modelIsContentEmpty(this.modelInternal) && (loaded.data_empty === false || Number(loaded.save_id) > 0)) {
      this.modelInternal = null;
      throw new McpError("MODEL_PARSE_EMPTY", `сервер вернул непустой проект (save_id ${loaded.save_id}, data ${loaded.data_empty === false ? "непустой" : "пустой"}), но разобранная модель пустая`, {
        hint: "не сохраняйте этот проект: повторите project_open; если повторяется — модель проекта не разобрана адаптером",
        details: { object_id: objectId, plan_id: loaded.plan_id || planId, save_id: loaded.save_id, data_empty: loaded.data_empty ?? null },
      });
    }
    this.openedEmpty = modelIsContentEmpty(this.modelInternal);
    if (this.editorInternal && (this.editorInternal.objectId !== objectId || this.editorInternal.planId !== planId)) {
      await this.editorInternal.close().catch(() => {});
      this.editorInternal = null;
    }
    this.project = {
      objectId,
      planId: loaded.plan_id || planId,
      saveId: loaded.save_id,
      dirty: false,
      openedAt: new Date().toISOString(),
      anon: opts.anon ?? false,
    };
    this.snapshots = [];
    this.historyIndex = -1;
    this.pushSnapshot("open");
    return this.project;
  }

  /**
   * Комнаты: из rooms2 канонической модели, при пустом — из кеша последней
   * нормализации (T27). Полигон в см, площадь по внутренним граням.
   */
  rooms(): RoomPolygon[] {
    const fromModel = roomPolygons(this.model);
    if (fromModel.length > 0) return fromModel;
    return this.roomsCache
      .filter((r) => Array.isArray(r.polygon) && r.polygon.length >= 3)
      .map((r) => ({
        roomId: r.id,
        polygon: r.polygon!,
        areaCm2: (r.area_m2 ?? 0) * 10_000,
        axisAreaCm2: null,
      }));
  }

  private pushSnapshot(label: string): void {
    this.snapshots.splice(this.historyIndex + 1);
    this.snapshots.push({ json: JSON.stringify(this.model), label, at: Date.now() });
    if (this.snapshots.length > MAX_HISTORY) this.snapshots.shift();
    this.historyIndex = this.snapshots.length - 1;
  }

  /**
   * Мутация стен (design §12.5, T28): клон → правило Node → normalize → проверки §12.4
   * (isOverWall, потерянная связь, рост errors) → замена канонической копии.
   * Любая ошибка оставляет рабочую модель нетронутой. Пакет операций (полилиния,
   * комната) нормализуется ОДИН раз. В офлайн-режиме — без нормализации,
   * предупреждение EDITOR_REQUIRED_FOR_ROOMS.
   */
  async applyWalls<T>(label: string, fn: (model: Model) => T): Promise<WallMutation<T>> {
    if (!this.project) throw new McpError("INVALID_ARGUMENT", "проект не открыт — сначала project_open");
    const clone = structuredClone(this.modelInternal!);
    const result = fn(clone);
    const warnings: string[] = [];
    if (this.offline) {
      this.modelInternal = clone;
      warnings.push("EDITOR_REQUIRED_FOR_ROOMS");
    } else {
      const editor = await this.ensureEditor();
      const prepared = structuredClone(clone);
      prepareForRestore(prepared);
      const norm = await editor.normalize(prepared as unknown as Record<string, unknown>);
      // §12.4: наложение стен
      const over = (norm.walls ?? []).filter((w) => w.overWall).map((w) => w.id);
      if (over.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор насчитал наложение стен (${over.join(", ")}) — мутация отменена`, {
          details: { over_walls: over },
        });
      }
      // §12.4: конец, который Node ставил на грань или в узел, остался без связи
      const dangling = findUnattachedEnds(norm.walls ?? []);
      if (dangling.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации у стен остались несоединённые концы (${dangling.slice(0, 5).map((d) => `${d.wallId}.${d.node}`).join(", ")})`, {
          details: { unattached: dangling },
        });
      }
      // §12.4: выросли счётчики ошибок редактора
      const grown = errorGrowth(this.lastErrors ?? (this.modelInternal!["errors"] as Record<string, number> | undefined) ?? null, norm.errors ?? null);
      if (grown.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `выросли ошибки редактора: ${grown.join(", ")}`, {
          details: { errors: norm.errors },
        });
      }
      if (norm.errors) this.lastErrors = norm.errors;
      // нормализованная копия становится канонической
      this.modelInternal = toModel(structuredClone(norm.model as unknown as Record<string, unknown>));
      if ((norm.rooms ?? []).length > 0) this.roomsCache = norm.rooms!;
    }
    this.project.dirty = true;
    this.pushSnapshot(label);
    return { result, warnings };
  }

  /**
   * Мутация рабочей копии: fn меняет модель, после — снимок истории и dirty.
   * На сервер не сохраняет: сохранение — только project_save.
   */
  apply<T>(label: string, fn: (model: Model) => T): T {
    const result = fn(this.model);
    this.project!.dirty = true;
    this.pushSnapshot(label);
    return result;
  }

  historyInfo(): { steps: number; canUndo: number; canRedo: number; max: number } {
    return {
      steps: this.snapshots.length - 1,
      canUndo: this.historyIndex,
      canRedo: this.snapshots.length - 1 - this.historyIndex,
      max: MAX_HISTORY,
    };
  }

  undo(steps = 1): { applied: number } {
    let applied = 0;
    while (applied < steps && this.historyIndex > 0) {
      this.historyIndex--;
      applied++;
    }
    if (applied > 0) {
      this.modelInternal = toModel(JSON.parse(this.snapshots[this.historyIndex]!.json) as Record<string, unknown>);
      this.project!.dirty = true;
    }
    return { applied };
  }

  redo(steps = 1): { applied: number } {
    let applied = 0;
    while (applied < steps && this.historyIndex < this.snapshots.length - 1) {
      this.historyIndex++;
      applied++;
    }
    if (applied > 0) {
      this.modelInternal = toModel(JSON.parse(this.snapshots[this.historyIndex]!.json) as Record<string, unknown>);
      this.project!.dirty = true;
    }
    return { applied };
  }

  private backupPath(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return join(BACKUPS_DIR, `${this.project!.objectId}-${this.project!.planId}-${stamp}.json`);
  }

  /** Снимок модели в backups/ перед каждым сохранением. */
  writeBackup(): string {
    const path = this.backupPath();
    mkdirSync(BACKUPS_DIR, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ object_id: this.project!.objectId, plan_id: this.project!.planId, save_id: this.project!.saveId, saved_at: new Date().toISOString(), model: this.modelInternal }, null, 1),
      { mode: 0o600 },
    );
    return path;
  }

  /**
   * Сохранение: сверка save_id с сервером (SAVE_CONFLICT при расхождении, минуя force),
   * снимок в backups/, нормализация редактором, project.save, проверка по GET
   * (надёжнее save_id — отчёт 05, факт 6) с одним повтором при расхождении.
   * Принудительная запись поверх чужих правок — только при явном force: true.
   */
  async save(options: { force?: boolean } = {}): Promise<SaveOutcome> {
    const p = this.project;
    if (!p) throw new McpError("INVALID_ARGUMENT", "проект не открыт");
    const saveIdBefore = p.saveId;
    const fresh = await this.deps.loadModel(this.deps.session, p.objectId, p.planId);
    // Дефект 3 (отчёт 11): защита от затирания непустого сервера пустой моделью —
    // проект, открытый с пустой моделью, сохраняется только с явным force.
    if (
      !options.force && this.openedEmpty &&
      modelIsContentEmpty(this.modelInternal!) && !modelIsContentEmpty(fresh.model as Model)
    ) {
      throw new McpError("SAVE_CONFLICT", "проект был открыт с пустой моделью, а на сервере модель непустая — сохранение удалило бы её объекты", {
        hint: "перечитайте проект (project_open) или сохраните принудительно force: true",
        details: { server: modelCounts(fresh.model) },
      });
    }
    // сверка счётчиков с серверной версией: предупреждение об удалениях (дефект 3)
    const serverCounts = modelCounts(fresh.model);
    const localCounts = modelCounts(this.modelInternal!);
    const willDelete = {
      walls: Math.max(0, serverCounts.walls - localCounts.walls),
      openings: Math.max(0, serverCounts.openings - localCounts.openings),
      items: Math.max(0, serverCounts.items - localCounts.items),
    };
    const warnings: string[] = [];
    if (willDelete.walls > 0) warnings.push(`будет удалено ${willDelete.walls} стен, которых нет в модели`);
    if (willDelete.openings > 0) warnings.push(`будет удалено ${willDelete.openings} проёмов, которых нет в модели`);
    if (willDelete.items > 0) warnings.push(`будет удалено ${willDelete.items} предметов, которых нет в модели`);
    if (fresh.save_id !== saveIdBefore) {
      if (!this.editorInternal && !options.force) {
        throw new McpError(
          "SAVE_CONFLICT",
          `save_id на сервере (${fresh.save_id}) новее рабочей копии (${saveIdBefore}) — проект правился в другом месте`,
          { hint: "перезапишите рабочую копию project_open или сохраните принудительно force: true" },
        );
      }
      // наш собственный редактор легитимно продвигает save_id (автосейвы при
      // инициализации/нормализации, отчёт 05 факт 6): принимаем свежий как базу —
      // реальный чужой конфликт поймает диалог редактора «Сохранить все равно»
      // (adapter.save → conflict) и сверка контента после сохранения
      p.saveId = fresh.save_id;
    }
    const backupPath = this.writeBackup();
    if (!this.editorInternal) {
      await this.ensureEditor();
    }
    const expected = {
      walls: Object.keys(this.modelInternal!.walls).length,
      holes: Object.values(this.modelInternal!.walls).reduce((n, w) => n + Object.keys(w.holes).length, 0),
    };
    const editor = await this.ensureEditor();
    const prepared = structuredClone(this.modelInternal!);
    prepareForRestore(prepared);
    const norm = await editor.normalize(prepared as unknown as Record<string, unknown>);
    if ((norm.rooms ?? []).length > 0) this.roomsCache = norm.rooms!;
    const gotWalls = Object.keys((norm.model as { walls?: Record<string, unknown> }).walls ?? {}).length;
    if (gotWalls < expected.walls || norm.after.walls < expected.walls) {
      throw new McpError("NORMALIZATION_DROPPED", "редактор удалил стены при нормализации", {
        details: { expected_walls: expected.walls, after_walls: norm.after.walls, copy_walls: gotWalls },
      });
    }
    let rounds = 0;
    let verified = false;
    let finalSaveId = p.saveId;
    for (let attempt = 0; attempt < 2 && !verified; attempt++) {
      const saveRes = await editor.save();
      rounds++;
      if (saveRes.conflict && !options.force) {
        throw new McpError("SAVE_CONFLICT", "сервер ответил диалогом «Сохранить все равно»", {
          hint: "правки в другой вкладке; принудительная запись — только force: true",
        });
      }
      if (!saveRes.ok) {
        throw new McpError("SITE_ERROR", "сохранение не прошло", { details: { save_id: saveRes.saveId } });
      }
      // верификация по GET: контент, а не только save_id (save_id не монотонен)
      const after = await this.deps.loadModel(this.deps.session, p.objectId, p.planId);
      const wallsAfter = (after.model["walls"] as Record<string, unknown> | undefined) ?? {};
      if (Object.keys(wallsAfter).length === expected.walls) {
        verified = true;
        finalSaveId = after.save_id || saveRes.saveId || finalSaveId;
        this.modelInternal = toModel(structuredClone(after.model));
      } else if (attempt === 1) {
        throw new McpError("SITE_ERROR", "после сохранения модель на сервере не совпала с рабочей копией", {
          details: { expected_walls: expected.walls, got_walls: Object.keys(wallsAfter).length },
        });
      }
    }
    p.saveId = finalSaveId;
    p.dirty = false;
    this.snapshots = [];
    this.historyIndex = -1;
    this.pushSnapshot("saved");
    return { save_id: finalSaveId, save_id_before: saveIdBefore, backup_path: backupPath, verified, rounds, will_delete: willDelete, warnings };
  }

  /**
   * Рендер плана (дефект 1, отчёт 11): перед скриншотом в редактор синхронизируется
   * ВСЯ каноническая модель workspace (стены, проёмы, предметы) — тот же
   * restore→draw→copy, что перед сохранением. Если счётчики объектов, которые
   * видит редактор, расходятся с моделью — RENDER_OUT_OF_SYNC, картинка не отдаётся.
   * В ответе — ревизия: хэш модели и счётчики объектов.
   */
  async renderPlan(options: RenderOptions & { dir?: string } = {}): Promise<RenderedPlan> {
    const editor = await this.ensureEditor();
    const expected = modelCounts(this.modelInternal!);
    const prepared = structuredClone(this.modelInternal!);
    prepareForRestore(prepared);
    const norm = await editor.normalize(prepared as unknown as Record<string, unknown>);
    if ((norm.rooms ?? []).length > 0) this.roomsCache = norm.rooms!;
    const seen = { walls: norm.after.walls, openings: norm.after.holes, items: norm.after.items };
    const mismatch = (["walls", "openings", "items"] as const).filter((k) => seen[k] !== expected[k]);
    if (mismatch.length > 0) {
      throw new McpError("RENDER_OUT_OF_SYNC", `редактор показывает не текущую модель (${mismatch.map((k) => `${k}: в модели ${expected[k]}, в редакторе ${seen[k]}`).join(", ")}) — картинка не отдаётся`, {
        hint: "повторите render_plan; при повторении сверитесь с model_get и model_validate",
        details: { workspace: expected, editor: seen },
      });
    }
    const res = await renderPlanToFile(editor, {
      ...options,
      itemIds: Object.keys(this.modelInternal!.items ?? {}),
    });
    const revision: RenderRevision = {
      model_hash: modelHash(this.modelInternal!),
      save_id: this.project?.saveId ?? null,
      walls: expected.walls,
      openings: expected.openings,
      items: expected.items,
      editor: seen,
    };
    return { ...res, revision };
  }

  /** Ленивый запуск редактора (каталог, рендер, сохранение). */
  async ensureEditor(): Promise<EditorLike> {
    if (!this.editorInternal) {
      const p = this.project!;
      // инцидент 2026-11-15: анонимный проект — редактор без аккаунтных cookies;
      // аккаунтный проект — чужой object_id редактора запрещён
      this.editorInternal = await this.deps.openEditor(this.deps.session, p.objectId, p.planId, { anonymous: p.anon });
      const compat = (this.editorInternal as { compat?: { object_id?: string | null; plan_id?: string | null } }).compat;
      if (p.anon) {
        // редактор анонимного проекта создаёт СВОИ object_id/plan_id (body data-атрибуты):
        // сохранение и верификационный GET должны идти туда, куда реально пишет редактор
        if (compat?.object_id) p.objectId = compat.object_id;
        if (compat?.plan_id) p.planId = compat.plan_id;
      } else {
        // фактические id — из адаптера (страница); при недоступности сверки её ловит
        // предсохранительная проверка в adapter.save
        const compat = await this.editorInternal.compatInfo().catch(() => null);
        const mismatch: string[] = [];
        if (compat?.object_id && compat.object_id !== p.objectId) mismatch.push(`object_id ${compat.object_id} ≠ ${p.objectId}`);
        if (compat?.plan_id && p.planId && compat.plan_id !== p.planId) mismatch.push(`plan_id ${compat.plan_id} ≠ ${p.planId}`);
        if (mismatch.length > 0) {
          const editor = this.editorInternal;
          this.editorInternal = null;
          await editor.close().catch(() => {});
          throw new McpError("EDITOR_PROJECT_MISMATCH", `редактор открыл не запрошенный проект: ${mismatch.join(", ")} — запись в чужой проект запрещена`, {
            details: { requested_object_id: p.objectId, requested_plan_id: p.planId, editor_object_id: compat?.object_id, editor_plan_id: compat?.plan_id },
          });
        }
      }
    }
    return this.editorInternal;
  }

  async close(): Promise<void> {
    if (this.editorInternal) {
      await this.editorInternal.close().catch(() => {});
      this.editorInternal = null;
    }
  }
}
