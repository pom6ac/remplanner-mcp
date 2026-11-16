import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BACKUPS_DIR } from "./config.ts";
import { McpError } from "./errors.ts";
import type { SessionState } from "./session.ts";
import type { LoadedModel } from "./api.ts";
import type { NormalizeResult, EditorSaveResult, RenderOptions, CompatInfo, EditorRoom } from "./editor/adapter.ts";
import type { Model, Point } from "./model/types.ts";
import type { RoomPolygon } from "./model/items.ts";
import { roomPolygons } from "./model/items.ts";
import { prepareForRestore, findUnattachedEnds, wallAxisSegments, wallAxisSetsEqual, wallAxisCoverageCm, type WallAxisSegment } from "./model/walls.ts";
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
  will_delete: { walls: number; openings: number; items: number; pillars: number };
  /** Предупреждения (удаления объектов сервера). */
  warnings: string[];
};

export type HistorySnapshot = { label: string; at: string };

export const MAX_HISTORY = 50;

/** Результат мутации стен: полезное значение + предупреждения (офлайн-режим). */
export type WallMutation<T> = { result: T; warnings: string[] };

/** Счётчики объектов модели: стены, проёмы, предметы, колонны. */
export function modelCounts(model: Model | Record<string, unknown>): { walls: number; openings: number; items: number; pillars: number } {
  const m = model as Model;
  const walls = m.walls ?? {};
  return {
    walls: Object.keys(walls).length,
    openings: Object.values(walls).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0),
    items: Object.keys(m.items ?? {}).length,
    pillars: Object.keys(m.pillars ?? {}).length,
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

/** Есть ли в сыром JSON модели непустые объекты/массивы вне корня (ревью v0.1.1 №2):
 *  при пустой разобранной модели это признак необработанных сущностей. */
function rawJsonHasEntities(value: unknown, depth = 0): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") {
    if (depth > 0 && Object.keys(value).length > 0) return true;
    return Object.values(value as Record<string, unknown>).some((v) => rawJsonHasEntities(v, depth + 1));
  }
  return false;
}

/** id проёмов модели: id holes по всем стенам (ревью v0.1.1 №4/№5 — сравнение по id). */
function openingIds(model: Model): Set<string> {
  const out = new Set<string>();
  for (const [wid, w] of Object.entries(model.walls ?? {})) {
    for (const [hid, h] of Object.entries(w.holes ?? {})) {
      out.add((h as { id?: string }).id ?? `${wid}/${hid}`);
    }
  }
  return out;
}

/** Список id серверных объектов, которых нет в локальной модели (ревью v0.1.1 №5):
 *  разность идентичностей, а не разность общих счётчиков — удаление одного объекта
 *  с добавлением другого не маскируется. */
function missingIds(server: Set<string>, local: Set<string>): string[] {
  return [...server].filter((id) => !local.has(id)).sort();
}

/**
 * Ось стены покрыта локальными стенами (ревью v0.1.1 финал F-1): отрезок оси стены
 * лежит на той же прямой, что и какой-то локальный осевой отрезок, и целиком внутри
 * него (с допуском 1 мм). Смена идентификатора стены при нормализации редактора
 * геометрию не меняет — это не потеря.
 */
function wallAxisCoveredBy(wall: { p1: Point; p2: Point } | undefined, localSegments: WallAxisSegment[], tolCm = 0.1): boolean {
  if (!wall) return false;
  const segs = wallAxisSegments({ w: wall });
  if (segs.length === 0) return false;
  return segs.every((s) =>
    localSegments.some(
      (t) =>
        Math.abs(t.ux - s.ux) <= 1e-6 && Math.abs(t.uy - s.uy) <= 1e-6 &&
        Math.abs(t.offset - s.offset) <= tolCm &&
        t.a <= s.a + tolCm && t.b >= s.b - tolCm,
    ),
  );
}

/** Значимая геометрия колонны для сверки после сохранения (ревью 43 №2). */
type PillarSig = { pc?: { x: number; y: number }; width?: number; height?: number; angle?: number };

/**
 * Расхождение колонн между рабочей копией и сервером после save (ревью 43 №2):
 * идентичности и значимая геометрия (pc, width, height, angle; допуск 0,1 см / 0,1°).
 * Возвращает список человекочитаемых расхождений; пустой список — колонны сохранились.
 */
function pillarVerificationMismatches(expected: Record<string, PillarSig>, got: Record<string, unknown>): string[] {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined, tol: number): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
  for (const [id, p] of Object.entries(expected)) {
    const g = got[id] as PillarSig | undefined;
    if (!g) {
      out.push(`${id}: колонна исчезла после сохранения`);
      continue;
    }
    if (!near(g.pc?.x, p.pc?.x, 0.1) || !near(g.pc?.y, p.pc?.y, 0.1)) {
      out.push(`${id}: центр сместился (на сервере ${g.pc?.x},${g.pc?.y}; ожидалось ${p.pc?.x},${p.pc?.y})`);
    }
    if (!near(g.width, p.width, 0.1)) out.push(`${id}: ширина изменилась (на сервере ${g.width}; ожидалось ${p.width})`);
    if (!near(g.height, p.height, 0.1)) out.push(`${id}: глубина изменилась (на сервере ${g.height}; ожидалось ${p.height})`);
    if (!near(g.angle ?? 0, p.angle ?? 0, 0.1)) out.push(`${id}: угол изменился (на сервере ${g.angle ?? 0}; ожидалось ${p.angle ?? 0})`);
  }
  return out;
}

function toModel(raw: Record<string, unknown>): Model {  const model = raw as Model;
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

/** Короткий код листа в модели (item.plan) → код листа в навигации редактора (features §2). */
const SHEET_CODE_BY_PLAN: Record<string, string> = {
  a: "init",
  b: "break_walls",
  c: "create_walls",
  rooms: "rooms",
  furniture: "furniture",
  santeh: "santeh",
};

/** id предметов, которые должны быть видны на листе sheet (ревью v0.1.1 №3):
 *  слой предмета задаётся item.plan; предметы других листов на sheet скрыты. */
export function itemIdsForSheet(model: Model, sheet: string): string[] {
  return Object.entries(model.items ?? {})
    .filter(([, it]) => (SHEET_CODE_BY_PLAN[Object.keys(it.plan ?? {})[0] ?? ""] ?? null) === sheet)
    .map(([key, it]) => it.id ?? key);
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
    // Ревью v0.1.1 №2: валидная пустая модель — не потеря данных, новый или очищенный
    // проект должен открываться. MODEL_PARSE_EMPTY — только когда data непустой, разбор
    // дал пустую модель, а в сыром JSON есть объекты (схема не распознана адаптером).
    // Проверка по сырому JSON, не по save_id: save_id > 0 не доказывает наличие объектов.
    if (modelIsContentEmpty(this.modelInternal) && loaded.data_empty === false && rawJsonHasEntities(loaded.model)) {
      this.modelInternal = null;
      throw new McpError("MODEL_PARSE_EMPTY", `сервер вернул модель с данными, но разобранная модель пустая (save_id ${loaded.save_id}) — схема данных не распознана`, {
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
      // ревью 43 №1: колонны после нормализации не теряются (сверка идентичностей)
      const wsPillarIds = new Set(Object.keys(this.modelInternal!.pillars ?? {}));
      const normPillarIds = new Set(Object.keys((norm.model as { pillars?: Record<string, unknown> }).pillars ?? {}));
      const lostPillarsNorm = missingIds(wsPillarIds, normPillarIds);
      if (lostPillarsNorm.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял колонны (${lostPillarsNorm.join(", ")}) — мутация отменена`, {
          details: { lost_pillars: lostPillarsNorm },
        });
      }
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
    // ревью v0.1.1 №5: предупреждение об удалениях — разность идентичностей (id
    // объектов сервера, которых нет в рабочей копии), а не разность общих счётчиков.
    // Ревью v0.1.1 финал F-1: стена, чья ось покрыта локальными стенами, не потеряна —
    // нормализация редактора могла сменить её идентификатор; это отдельное замечание
    const serverModel = fresh.model as Model;
    const localWallSegments = wallAxisSegments(this.modelInternal!.walls);
    const serverWallsMissing = missingIds(new Set(Object.keys(serverModel.walls ?? {})), new Set(Object.keys(this.modelInternal!.walls)));
    const renamedWalls = serverWallsMissing.filter((id) => wallAxisCoveredBy(serverModel.walls?.[id] as { p1: Point; p2: Point } | undefined, localWallSegments));
    const deletedWalls = serverWallsMissing.filter((id) => !renamedWalls.includes(id));
    const deletedIds = {
      walls: deletedWalls,
      renamedWalls,
      openings: missingIds(openingIds(serverModel), openingIds(this.modelInternal!)),
      items: missingIds(new Set(Object.keys(serverModel.items ?? {})), new Set(Object.keys(this.modelInternal!.items ?? {}))),
      pillars: missingIds(new Set(Object.keys(serverModel.pillars ?? {})), new Set(Object.keys(this.modelInternal!.pillars ?? {}))),
    };
    const willDelete = {
      walls: deletedIds.walls.length,
      openings: deletedIds.openings.length,
      items: deletedIds.items.length,
      pillars: deletedIds.pillars.length,
    };
    const warnings: string[] = [];
    const idList = (ids: string[]): string => `${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ", …" : ""}`;
    if (willDelete.walls > 0) warnings.push(`будут удалены стены (${willDelete.walls}), которых нет в модели: ${idList(deletedIds.walls)}`);
    if (deletedIds.renamedWalls.length > 0) warnings.push(`идентификаторы стен изменились (${deletedIds.renamedWalls.length}) — геометрия сохранена, это нормализация, а не потеря: ${idList(deletedIds.renamedWalls)}`);
    if (willDelete.openings > 0) warnings.push(`будут удалены проёмы (${willDelete.openings}), которых нет в модели: ${idList(deletedIds.openings)}`);
    if (willDelete.items > 0) warnings.push(`будут удалены предметы (${willDelete.items}), которых нет в модели: ${idList(deletedIds.items)}`);
    if (willDelete.pillars > 0) warnings.push(`будут удалены колонны (${willDelete.pillars}), которых нет в модели: ${idList(deletedIds.pillars)}`);
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
      // стены — канонический набор осевых отрезков (ревью v0.1.1-r2 R2-3):
      // разрез/слияние коллинеарных стен эквивалентны, сдвиг и лишние стены — нет
      segments: wallAxisSegments(this.modelInternal!.walls),
      coverage: wallAxisCoverageCm(this.modelInternal!.walls),
    };
    const editor = await this.ensureEditor();
    const prepared = structuredClone(this.modelInternal!);
    prepareForRestore(prepared);
    const norm = await editor.normalize(prepared as unknown as Record<string, unknown>);
    if ((norm.rooms ?? []).length > 0) this.roomsCache = norm.rooms!;
    // потеря проёмов/предметов — по id в копии редактора (ревью v0.1.1 №4)
    const localOpeningIds = openingIds(this.modelInternal!);
    const localItemIds = new Set(Object.keys(this.modelInternal!.items ?? {}));
    const localPillarIds = new Set(Object.keys(this.modelInternal!.pillars ?? {}));
    // ревью 43 №2/№4: ожидаемые колонны и комнаты для верификации после save
    const expectedPillars = structuredClone(this.modelInternal!.pillars ?? {}) as Record<string, PillarSig>;
    const expectedRooms = Object.keys(this.modelInternal!.rooms2 ?? {}).length;
    const normWalls = (norm.model as { walls?: Record<string, { holes?: Record<string, { id?: string }> }> }).walls ?? {};
    const gotOpeningIds = new Set<string>();
    for (const [wid, w] of Object.entries(normWalls)) {
      for (const [hid, h] of Object.entries(w.holes ?? {})) gotOpeningIds.add(h.id ?? `${wid}/${hid}`);
    }
    const gotItemIds = new Set(Object.keys((norm.model as { items?: Record<string, unknown> }).items ?? {}));
    const gotPillarIds = new Set(Object.keys((norm.model as { pillars?: Record<string, unknown> }).pillars ?? {}));
    const lostOpenings = missingIds(localOpeningIds, gotOpeningIds);
    const lostItems = missingIds(localItemIds, gotItemIds);
    const lostPillars = missingIds(localPillarIds, gotPillarIds);
    const gotSegments = wallAxisSegments(normWalls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
    const gotCoverage = wallAxisCoverageCm(normWalls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
    // ревью 43 №4: комнаты с пользовательскими полями не исчезают при нормализации молча
    const normRooms = Object.keys((norm.model as { rooms2?: Record<string, unknown> }).rooms2 ?? {}).length;
    if (expectedRooms > 0 && normRooms === 0) {
      warnings.push(`редактор убрал комнаты при нормализации (${expectedRooms} → 0) — имя и отделка комнат могут быть потеряны; проверьте rooms_list после сохранения`);
    }
    if (
      !wallAxisSetsEqual(gotSegments, expected.segments) ||
      lostOpenings.length > 0 || lostItems.length > 0 || lostPillars.length > 0
    ) {
      throw new McpError("NORMALIZATION_DROPPED", "редактор потерял объекты при нормализации", {
        details: {
          expected_walls: expected.walls,
          after_walls: norm.after.walls,
          coverage_before_mm: Math.round(expected.coverage * 10),
          coverage_after_mm: Math.round(gotCoverage * 10),
          axis_segments_before: expected.segments.length,
          axis_segments_after: gotSegments.length,
          lost_openings: lostOpenings,
          lost_items: lostItems,
          lost_pillars: lostPillars,
        },
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
      // верификация по GET: контент, а не только save_id (save_id не монотонен).
      // Стены — по каноническому набору осевых отрезков (ревью v0.1.1-r2 R2-3):
      // слияние при сохранении легитимно, сдвиг/лишняя стена — нет.
      // Колонны — по id и значимой геометрии (ревью 43 №2), комнаты — по числу (№4).
      const after = await this.deps.loadModel(this.deps.session, p.objectId, p.planId);
      const wallsAfter = (after.model["walls"] as Record<string, unknown> | undefined) ?? {};
      const segmentsAfter = wallAxisSegments(wallsAfter as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
      const pillarsAfter = (after.model["pillars"] as Record<string, unknown> | undefined) ?? {};
      const roomsAfter = Object.keys((after.model["rooms2"] as Record<string, unknown> | undefined) ?? {}).length;
      const pillarMismatch = pillarVerificationMismatches(expectedPillars, pillarsAfter);
      const roomsLost = expectedRooms > 0 && roomsAfter === 0;
      if (wallAxisSetsEqual(segmentsAfter, expected.segments) && pillarMismatch.length === 0 && !roomsLost) {
        verified = true;
        finalSaveId = after.save_id || saveRes.saveId || finalSaveId;
        this.modelInternal = toModel(structuredClone(after.model));
      } else if (attempt === 1) {
        const coverageAfter = wallAxisCoverageCm(wallsAfter as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
        throw new McpError("SITE_ERROR", "после сохранения модель на сервере не совпала с рабочей копией", {
          details: {
            expected_walls: expected.walls, got_walls: Object.keys(wallsAfter).length,
            coverage_before_mm: Math.round(expected.coverage * 10), coverage_after_mm: Math.round(wallAxisCoverageCm(wallsAfter as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>) * 10),
            axis_segments_before: expected.segments.length, axis_segments_after: segmentsAfter.length,
            pillar_mismatches: pillarMismatch, rooms_expected: expectedRooms, rooms_on_server: roomsAfter,
          },
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
    const seen = { walls: norm.after.walls, openings: norm.after.holes, items: norm.after.items, pillars: norm.after.pillars ?? Object.keys((norm.model as { pillars?: Record<string, unknown> }).pillars ?? {}).length };
    // стены — по каноническому набору осевых отрезков (ревью v0.1.1-r2 R2-3):
    // слияние/разрез коллинеарных стен — допустимая нормализация, сдвиг и лишние
    // стены — расхождение; проёмы и предметы — по счётчикам
    const localSegments = wallAxisSegments(this.modelInternal!.walls);
    const editorSegments = wallAxisSegments((norm.model as { walls?: Record<string, unknown> }).walls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
    const mismatch: string[] = [];
    if (!wallAxisSetsEqual(editorSegments, localSegments)) {
      mismatch.push(`стены: осевые отрезки в модели ${localSegments.length} (покрытие ${Math.round(wallAxisCoverageCm(this.modelInternal!.walls) * 10)} мм), в редакторе ${editorSegments.length} (покрытие ${Math.round(wallAxisCoverageCm((norm.model as { walls?: Record<string, unknown> }).walls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>) * 10)} мм)`);
    }
    if (seen.openings !== expected.openings) mismatch.push(`openings: в модели ${expected.openings}, в редакторе ${seen.openings}`);
    if (seen.items !== expected.items) mismatch.push(`items: в модели ${expected.items}, в редакторе ${seen.items}`);
    if (seen.pillars !== expected.pillars) mismatch.push(`pillars: в модели ${expected.pillars}, в редакторе ${seen.pillars}`);
    if (mismatch.length > 0) {
      throw new McpError("RENDER_OUT_OF_SYNC", `редактор показывает не текущую модель (${mismatch.join(", ")}) — картинка не отдаётся`, {
        hint: "повторите render_plan; при повторении сверитесь с model_get и model_validate",
        details: { workspace: expected, editor: seen },
      });
    }
    const res = await renderPlanToFile(editor, {
      ...options,
      itemIds: itemIdsForSheet(this.modelInternal!, options.sheet ?? "init"),
    });
    const revision: RenderRevision = {
      model_hash: modelHash(this.modelInternal!),
      save_id: this.project?.saveId ?? null,
      walls: expected.walls,
      openings: expected.openings,
      items: expected.items,
      pillars: expected.pillars,
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
