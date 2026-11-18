import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { BACKUPS_DIR } from "./config.ts";
import { ensurePrivateDir, writePrivateFile } from "./fs-safe.ts";
import { McpError, maskSecrets } from "./errors.ts";
import type { SessionState } from "./session.ts";
import type { LoadedModel } from "./api.ts";
import type { NormalizeResult, EditorSaveResult, RenderOptions, CompatInfo, EditorRoom } from "./editor/adapter.ts";
import type { Model, Point } from "./model/types.ts";
import { MODEL_ENTITY_COLLECTIONS, PUBLIC_COLLECTION_KEYS, entityCounts, hasEntities, publicCollectionCounts, type ModelEntityCollection } from "./model/collections.ts";
import type { RoomPolygon } from "./model/items.ts";
import { roomPolygons } from "./model/items.ts";
import { prepareForRestore, findUnattachedEnds, expectedDanglingEndPoints, unmatchedDanglingEnds, wallAxisSegments, wallAxisSetsEqual, wallAxisCoverageCm, assertNoNewWarmFloorCrossing, type DanglingEnd } from "./model/walls.ts";
import { dist } from "./model/geometry.ts";
import { renderPlanToFile, type RenderedPlan, type RenderRevision } from "./render.ts";
import { levelHoleMismatches } from "./model/floorhole.ts";
import { finishCompare } from "./model/finish.ts";
import { demolitionMismatches } from "./model/demolition.ts";
import { roomsSaveCompare, roomsChangePolicy, type RoomsChangePolicy } from "./model/rooms-save.ts";
import { dimsMismatches } from "./model/dims.ts";
import {
  balconyWallPropertyMismatches,
  cableConnectionMismatches,
  cableLinkFormMismatches,
  checkBordersAfterNormalize,
  checkLevelHolesAfterNormalize,
  climateGraphMismatches,
  gasLineGraphMismatches,
  itemVerificationMismatches,
  missingIds,
  openingIds,
  pipeConnectionMismatches,
  pillarVerificationMismatches,
  rigelVerificationMismatches,
  socketGroupSubsDerivedMismatches,
  socketGroupSubsUserMismatches,
  stripVertexIdRoom,
  wallAxisCoveredBy,
  wallRoleMismatches,
  WATER_PIPE_KEYS,
  type BalconyWallProps,
  type CableLinkItem,
  type CableLinkLines,
  type GasLineSig,
  type ItemSig,
  type PipeLinkItem,
  type PillarSig,
  type RigelSig,
  type SubsItemSig,
} from "./verify/index.ts";

// T17: рабочее пространство — открытые проекты, каноническая модель (GET), история
// undo/redo (до 50), dirty, save_id, снимок в backups/ перед сохранением, SAVE_CONFLICT.

/**
 * Публичная метка висячего конца: стена как в model_get (W<n>) и конец start/end,
 * не внутренние p1/p2 (ревью 144 M2). wallIndex — порядок стен, по которому model_get
 * нумерует метки: для намеренных концов — norm.walls (каноническая модель после
 * применения), для оторванных — рабочая модель до мутации (мутация откатывается).
 */
function danglingEndLabel(wallIndex: Map<string, number>, d: DanglingEnd): string {
  const n = wallIndex.get(d.wallId);
  const wall = n !== undefined ? `W${n + 1}` : d.wallId;
  return `${wall}.${d.node === "p1" ? "start" : "end"} (${Math.round(d.point.x * 10)}; ${Math.round(d.point.y * 10)})`;
}

/** Первые 5 концов, дальше «и ещё N» (ревью 144 M2). */
function endsPreview(labels: string[]): string {
  const shown = labels.slice(0, 5).join(", ");
  return labels.length > 5 ? `${shown}, и ещё ${labels.length - 5}` : shown;
}

/**
 * Метка стены кандидата для оторванного нормализатором конца (ревью 144 M1/M2):
 * конец смещён от соединённого положения в clone — берём ближайший конец стены
 * кандидата; мутация откатывается, поэтому model_get покажет стены рабочей
 * модели (кандидата), а идентификаторы norm стен редактор мог перенумеровать.
 */
function cloneWallLabel(cloneWalls: ReadonlyArray<{ id: string; p1: Point; p2: Point }>, d: DanglingEnd): string {
  let best = "";
  let bestDist = Infinity;
  cloneWalls.forEach((w, i) => {
    for (const p of [w.p1, w.p2] as const) {
      const dd = dist(p, d.point);
      if (dd < bestDist) {
        bestDist = dd;
        best = `W${i + 1}`;
      }
    }
  });
  return best;
}


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
  /** Сверка с серверной версией перед записью: сколько объектов сервера будет удалено.
   *  Специальные ключи walls/openings; остальные — публичные ключи реестра
   *  MODEL_ENTITY_COLLECTIONS (PUBLIC_COLLECTION_KEYS, газовые линии — gas_lines). */
  will_delete: { walls: number; openings: number } & {
    [K in Exclude<ModelEntityCollection, "walls"> as (typeof PUBLIC_COLLECTION_KEYS)[K]]: number;
  };
  /** Предупреждения (удаления объектов сервера). */
  warnings: string[];
};

export type HistorySnapshot = { label: string; at: string };

/**
 * Подписи коллекций в предупреждении об удалении объектов сервера
 * (кроме стен и проёмов, у которых свои тексты). Ключи — реестр
 * MODEL_ENTITY_COLLECTIONS без walls (C1, аудит 65).
 */
const ENTITY_DELETE_LABELS: Record<Exclude<ModelEntityCollection, "walls">, string> = {
  items: "предметы",
  pillars: "колонны",
  rigels: "ригели",
  pipes_gas: "газовые линии",
  pipes: "трубы водоснабжения",
  terrace_borders: "границы террас",
  territory_borders: "границы участка",
  level_holes: "проёмы в полу",
  led_strips: "светодиодные ленты",
  stripes_light: "трековые шины",
  line_strips: "линии линейного освещения",
  cables: "соединительные провода",
  rulers: "размеры",
  comments: "текстовые комментарии",
  warm_floors: "контуры тёплого пола",
  pipes_warm_floor: "магистрали тёплого пола",
  pipes_conditioner: "дренажи кондиционеров",
  pipes_heat: "магистрали отопления",
  pipes_ventilation: "воздуховоды",
};

export const MAX_HISTORY = 50;

/** Результат мутации стен: полезное значение + предупреждения (офлайн-режим). */
export type WallMutation<T> = { result: T; warnings: string[] };

/**
 * Счётчики объектов модели. Специальные ключи: walls (число стен) и openings
 * (число проёмов в стенах); остальные — по общему реестру коллекций
 * MODEL_ENTITY_COLLECTIONS (C1, аудит 65) под публичными ключами
 * PUBLIC_COLLECTION_KEYS (как в compact model_get; газовые линии — gas_lines),
 * чтобы новая сущность не выпадала из счётчиков (раньше вручную отставали
 * cables/rulers/comments).
 */
export type ModelCounts = { walls: number; openings: number } & {
  [K in Exclude<ModelEntityCollection, "walls"> as (typeof PUBLIC_COLLECTION_KEYS)[K]]: number;
};

export function modelCounts(model: Model | Record<string, unknown>): ModelCounts {
  const m = model as Model;
  const walls = m.walls ?? {};
  return {
    ...publicCollectionCounts(entityCounts(m)),
    walls: Object.keys(walls).length,
    openings: Object.values(walls).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0),
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

/** Разобранная модель без содержимого: ни одной сущности планировки (по общему
 *  реестру коллекций, C1) и без комнат. */
export function modelIsContentEmpty(model: Model): boolean {
  if (hasEntities(model)) return false;
  const nonEmpty = (v: unknown): boolean => v !== null && v !== undefined && typeof v === "object" && Object.keys(v as object).length > 0;
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

function toModel(raw: Record<string, unknown>): Model {  const model = raw as Model;
  model.walls ??= {};
  model.items ??= {};
  model.pillars ??= {};
  model.rigels ??= {};
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
   *  канонической копии rooms2 ещё нет (офлайн-режим, пустой проект до нормализации). */
  private roomsCache: EditorRoom[] = [];
  /** Офлайн-режим: стены меняются без нормализации (REMPLANNER_OFFLINE_FIXTURE). */
  offline = false;
  /** Базовые счётчики ошибок редактора для проверки роста (§12.4). */
  private lastErrors: Record<string, number> | null = null;
  /** Проект открыт с пустой моделью (дефект 3, отчёт 11) — сохранение под защитой. */
  private openedEmpty = false;
  /** База сверки комнат (этап 128, ревью 127 R1/R2/R4): модель с сервера / после
   *  последнего успешного save. Комнаты в normalize сравниваются с ней, а не с
   *  локальной моделью после операции; изменённые пользователем стены = разница
   *  «база → рабочая копия». */
  private roomSaveBase: { rooms: Record<string, unknown>; walls: Record<string, { p1: Point; p2: Point; depth?: number }> } | null = null;

  constructor(deps: WorkspaceDeps, options: { offline?: boolean } = {}) {
    this.deps = deps;
    this.offline = options.offline ?? false;
  }

  /** Комнаты и стены базы сверки комнат (модель с сервера / после последнего save). */
  private captureRoomBase(): { rooms: Record<string, unknown>; walls: Record<string, { p1: Point; p2: Point; depth?: number }> } {
    const m = this.modelInternal! as unknown as Record<string, unknown>;
    return {
      rooms: structuredClone(((m["rooms2"] ?? m["rooms1"]) ?? {}) as Record<string, unknown>),
      walls: structuredClone((m["walls"] ?? {}) as Record<string, { p1: Point; p2: Point; depth?: number }>),
    };
  }

  /** Политика локальных изменений стен (ревью 127 R1/R2): база → стены рабочей
   *  копии (или clone после операции пользователя, если передан). */
  private roomChangePolicy(nowWalls?: Record<string, unknown>): RoomsChangePolicy {
    const base = this.roomSaveBase;
    if (!base) return {};
    return roomsChangePolicy(base.rooms, base.walls, (nowWalls ?? (this.modelInternal!.walls ?? {})) as Record<string, { p1?: Point; p2?: Point; depth?: number }>);
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
    // B3 (аудит 65): id проекта/планировки — только числовые (как отдаёт сайт);
    // нечисловая строка не доходит до HTTP и не попадает в имена бэкап-файлов.
    if (!/^\d+$/.test(objectId)) {
      throw new McpError("INVALID_ARGUMENT", `object_id должен быть числовым id проекта (project_list/project_create), получено: «${objectId.slice(0, 30)}»`);
    }
    if (!/^\d+$/.test(planId)) {
      throw new McpError("INVALID_ARGUMENT", `plan_id должен быть числовым id планировки, получено: «${planId.slice(0, 30)}»`);
    }
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
    this.roomSaveBase = this.captureRoomBase();
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
    // ревью 108 R10: диагностика несоединённых концов ДО мутации — по рабочей модели
    // (каноническая копия после последней нормализации/загрузки с сервера); отклоняются
    // только НОВЫЕ дефекты соединений, унаследованные штатные операции не блокируют
    const beforeDangling = findUnattachedEnds(Object.values(clone.walls));
    const beforeDanglingKeys = new Set(beforeDangling.map((d) => `${d.wallId}.${d.node}`));
    const result = fn(clone);
    // m1 ревью 136: перегородка (plan:"c"), чья ось проходит через контур тёплого пола,
    // удаляет контур при сохранении (проба p135-n1c, анонимный проект) — осознанный отказ
    // до записи во ВСЕХ путях мутаций (wall_add, walls_add_polyline, room_add_rect/
    // room_add_polygon с plan:"c", wall_move, wall_update): по разнице осей plan:"c"
    // «до → после»; неизменённые перегородки моделей из UI не блокируются
    assertNoNewWarmFloorCrossing(clone, this.modelInternal!.walls);
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
      // §12.4: свободные концы стен — правило одно: намеренно свободный конец —
      // предупреждение, оторванный нормализатором — отказ.
      // 142: свободные концы — штатная механика редактора (стандарт remplanner,
      // FAQ 2.1: свободностоящие перегородки plan:"c" и стены plan:"a" со свободными
      // концами save сохраняет без потерь и предупреждений). Конец, свободный уже
      // в кандидате (clone до normalize) — пользователь сам нарисовал свободную
      // стену или операция осознанно оставила конец свободным: предупреждение
      // wall_free_ends; помещение из свободной стены не образуется (ограничение
      // редактора, не ошибка). Конец, соединённый в кандидате и оторванный
      // нормализатором (§12.4: «конец, который Node ставил на грань или в узел,
      // остался без связи», баг 111), — дефект: INVALID_GEOMETRY.
      // ревью 110/111 R10: унаследованные концы сопоставляются геометрически
      // (точка конца с допуском, с учётом ожидаемого переноса/разреза/слияния
      // стены операцией — expectedDanglingEndPoints), а не по `wallId.node`:
      // нормализатор редактора может перенумеровывать стены и менять направление
      // оси, ключ наследования — физическое положение конца; сопоставление
      // один-к-одному (ревью 111 R10) — и здесь, и при классификации концов.
      const candidateDangling = findUnattachedEnds(Object.values(clone.walls));
      const danglingAll = findUnattachedEnds(norm.walls ?? []);
      const expectedEnds = expectedDanglingEndPoints(beforeDangling, Object.values(clone.walls));
      const notInherited = unmatchedDanglingEnds(danglingAll, expectedEnds);
      // намеренные свободные концы: после исключения унаследованных совпадают
      // с концами, свободными уже в кандидате (один-к-одному, допуск дрейфа);
      // остальные — оторванные нормализатором соединённые концы
      const broken = unmatchedDanglingEnds(notInherited, candidateDangling.map((d) => d.point));
      const intended = notInherited.filter((d) => !broken.includes(d));
      if (broken.length > 0) {
        const cloneWalls = Object.values(clone.walls);
        const brokenLabels = broken.map((d) => `${cloneWallLabel(cloneWalls, d)}.${d.node === "p1" ? "start" : "end"} (${Math.round(d.point.x * 10)}; ${Math.round(d.point.y * 10)})`);
        throw new McpError(
          "INVALID_GEOMETRY",
          `нормализатор оторвал соединённый конец стены: ${endsPreview(brokenLabels)} — в кандидате конец был соединён, ` +
            `после normalize остался без связи (дефект §12.4) — мутация отменена`,
          { details: { broken_ends: brokenLabels } },
        );
      }
      if (intended.length > 0) {
        const normIndex = new Map((norm.walls ?? []).map((w, i) => [w.id, i]));
        const intendedLabels = intended.map((d) => danglingEndLabel(normIndex, d));
        warnings.push(
          `wall_free_ends: намеренно свободные концы стен, мм: ${endsPreview(intendedLabels)} — ` +
            `редактор допускает свободные концы (штатно), помещение из свободной стены не образуется; ` +
            `унаследованные до операции: ${beforeDanglingKeys.size}`,
        );
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
      // этап 47: ригели после нормализации не теряются (сверка идентичностей)
      const wsRigelIds = new Set(Object.keys(this.modelInternal!.rigels ?? {}));
      const normRigelIds = new Set(Object.keys((norm.model as { rigels?: Record<string, unknown> }).rigels ?? {}));
      const lostRigelsNorm = missingIds(wsRigelIds, normRigelIds);
      if (lostRigelsNorm.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял ригели (${lostRigelsNorm.join(", ")}) — мутация отменена`, {
          details: { lost_rigels: lostRigelsNorm },
        });
      }
      // этап 57: газовые линии после нормализации не теряются (сверка идентичностей);
      // ревью 59 №1: кроме идентичностей сверяется семантический граф (узлы, тип,
      // рёбра matrix, длина) — normalizer, обнуливший рёбра, не проходит молча
      const wsGasIds = new Set(Object.keys(this.modelInternal!.pipes_gas ?? {}));
      const normGas = (norm.model as { pipes_gas?: Record<string, unknown> }).pipes_gas ?? {};
      const normGasIds = new Set(Object.keys(normGas));
      const lostGasNorm = missingIds(wsGasIds, normGasIds);
      const gasGraphNorm = gasLineGraphMismatches(
        structuredClone(this.modelInternal!.pipes_gas ?? {}) as Record<string, GasLineSig>,
        normGas,
      );
      if (lostGasNorm.length > 0 || gasGraphNorm.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил газовые линии — мутация отменена`, {
          details: { lost_gas_lines: lostGasNorm, gas_line_mismatches: gasGraphNorm },
        });
      }
      // этап 78: трубы водоснабжения после нормализации не теряются (сверка семантики
      // графа; точки вершин-предметов — мягко: редактор пересчитывает подключение)
      const wsPipeIds = new Set(Object.keys(this.modelInternal!.pipes ?? {}));
      const normPipes = (norm.model as { pipes?: Record<string, unknown> }).pipes ?? {};
      const normPipeIds = new Set(Object.keys(normPipes));
      const lostPipesNorm = missingIds(wsPipeIds, normPipeIds);
      const pipesGraphNorm = gasLineGraphMismatches(
        structuredClone(this.modelInternal!.pipes ?? {}) as Record<string, GasLineSig>,
        normPipes,
        "труба",
        true,
        structuredClone(this.modelInternal!.items ?? {}) as Record<string, { pc?: Point; width?: number; height?: number; angle?: number }>,
      );
      // ревью 79 №5: подключения труба↔предмет сверяются в обе стороны и при нормализации
      // (только водные ключи — климат сверяет climateGraphMismatches, ревью 124 R2)
      const pipeConnNorm = pipeConnectionMismatches(
        structuredClone(this.modelInternal!.pipes ?? {}) as Record<string, GasLineSig>,
        this.modelInternal!.items as Record<string, PipeLinkItem>,
        normPipes as Record<string, GasLineSig>,
        (norm.model as { items?: Record<string, PipeLinkItem> }).items ?? {},
        { onlyKeys: WATER_PIPE_KEYS },
      );
      if (lostPipesNorm.length > 0 || pipesGraphNorm.length > 0 || pipeConnNorm.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил трубы водоснабжения — мутация отменена`, {
          details: { lost_pipes: lostPipesNorm, pipe_mismatches: pipesGraphNorm, pipe_connection_mismatches: pipeConnNorm },
        });
      }
      // этап 64: границы террас/участка и проёмы в полу после нормализации не теряются
      const lostBorders = checkBordersAfterNormalize(this.modelInternal!, norm.model as Model);
      if (lostBorders.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил границы террас/участка — мутация отменена`, {
          details: { border_mismatches: lostBorders },
        });
      }
      const lostHoles = checkLevelHolesAfterNormalize(this.modelInternal!, norm.model as Model);
      if (lostHoles.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил проёмы в полу — мутация отменена`, {
          details: { level_hole_mismatches: lostHoles },
        });
      }
      // этап 84: световые линии листа «Освещение» после нормализации не теряются и
      // не искажаются (семантическая сверка графа — общий слой газовых графов)
      const lightCollections: [keyof Model, string, string][] = [
        ["led_strips", "led_strips", "светодиодная лента"],
        ["stripes_light", "stripes_light", "трековая шина"],
        ["line_strips", "line_strips", "линейный свет"],
      ];
      for (const [key, _coll, label] of lightCollections) {
        const wsLines = stripVertexIdRoom(structuredClone((this.modelInternal![key] ?? {}) as Record<string, GasLineSig>)) as Record<string, GasLineSig>;
        const normLines = ((norm.model as Record<string, unknown>)[key as string] ?? {}) as Record<string, unknown>;
        const lostLines = missingIds(new Set(Object.keys(wsLines)), new Set(Object.keys(normLines)));
        const graphNorm = gasLineGraphMismatches(structuredClone(wsLines), normLines, label);
        if (lostLines.length > 0 || graphNorm.length > 0) {
          throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил световые линии (${label}) — мутация отменена`, {
            details: { [`lost_${key}`]: lostLines, [`${key}_mismatches`]: graphNorm },
          });
        }
      }
      // этап 88: связи «выключатель → светильник» после нормализации не теряются
      // и не искажаются (граф + обе стороны обратных ссылок)
      const wsCables = stripVertexIdRoom(structuredClone((this.modelInternal!.cables ?? {}) as Record<string, GasLineSig>)) as Record<string, GasLineSig>;
      const normCables = ((norm.model as Record<string, unknown>).cables ?? {}) as Record<string, unknown>;
      const lostCablesNorm = missingIds(new Set(Object.keys(wsCables)), new Set(Object.keys(normCables)));
      const cablesGraphNorm = gasLineGraphMismatches(structuredClone(wsCables), normCables, "связь выключатель → светильник");
      const wsLinesNorm: CableLinkLines = {
        led_strips: (this.modelInternal!.led_strips ?? {}) as Record<string, unknown>,
        stripes_light: (this.modelInternal!.stripes_light ?? {}) as Record<string, unknown>,
        line_strips: (this.modelInternal!.line_strips ?? {}) as Record<string, unknown>,
      };
      const normLinesNorm: CableLinkLines = {
        led_strips: ((norm.model as Record<string, unknown>).led_strips ?? {}) as Record<string, unknown>,
        stripes_light: ((norm.model as Record<string, unknown>).stripes_light ?? {}) as Record<string, unknown>,
        line_strips: ((norm.model as Record<string, unknown>).line_strips ?? {}) as Record<string, unknown>,
      };
      const cablesConnNorm = cableConnectionMismatches(
        (this.modelInternal!.cables ?? {}) as Record<string, GasLineSig>,
        (this.modelInternal!.items ?? {}) as Record<string, CableLinkItem>,
        normCables as Record<string, GasLineSig>,
        (norm.model as { items?: Record<string, CableLinkItem> }).items ?? {},
        wsLinesNorm,
        normLinesNorm,
      );
      // ревью 90 R1, 92 R1a: состав и пользовательские свойства под-розеток
      // сверяются при нормализации независимо от связей; производная геометрия
      // (center/real_center/vd) не сверяется — редактор легитимно пересчитывает её
      const subsNorm = socketGroupSubsUserMismatches(
        this.modelInternal!.items as Record<string, SubsItemSig>,
        (norm.model as { items?: Record<string, unknown> }).items ?? {},
      );
      // этап 94, ревью 95/98: отделка (пол/потолок/стены по комнатам) после нормализации
      // не теряется; сопоставление комнат по геометрии (id комнат редактор может
      // пересоздать), проёмы стен — для объяснимых разрывов отделки сторон.
      // Режим normalize: топологические правила — по эталонам редактора 98
      // (split — все части наследуют пол/потолок; merge — покрытие одного из источников);
      // отделка сторон при merge не сверяется — предупреждение finish_topology_changed.
      const finishNorm = finishCompare(
        (this.modelInternal!["rooms2"] ?? this.modelInternal!["rooms1"]) as Record<string, unknown> | undefined,
        ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
        this.modelInternal!["walls"] as Record<string, unknown> | undefined,
        (norm.model as Record<string, unknown>)["walls"] as Record<string, unknown> | undefined,
        "normalize",
      );
      // этап 122: контуры тёплого пола и трубы климата после нормализации не теряются
      // (общий слой графов — семантическая сверка; у контуров — polygon/кольцо/площадь;
      // ревью 124 R1/R2: привязка к комнатам по геометрии, обратные ссылки на трубы климата)
      const climateNorm = climateGraphMismatches(this.modelInternal!, norm.model as Record<string, unknown>, {
        mode: "normalize",
        roomsExpected: (this.modelInternal!["rooms2"] ?? this.modelInternal!["rooms1"]) as Record<string, unknown> | undefined,
        roomsGot: ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
        itemsExpected: this.modelInternal!.items as unknown as Record<string, PipeLinkItem>,
        itemsGot: (norm.model as { items?: Record<string, PipeLinkItem> }).items ?? {},
      });
      warnings.push(...finishNorm.warnings);
      // ревью 139 m2: сбой пересчёта комнат в normalize не откатывается молча —
      // диагностическое предупреждение в результате мутации (код без данных пользователя)
      if (norm.roomsRebuild && norm.roomsRebuild !== "ok") {
        warnings.push(maskSecrets(`rooms_recalc_failed: ${norm.roomsRebuild}`));
      }
      // этап 103: флаги демонтажа (demount, p1/p2.demount, sectors, holes[].demount)
      // после нормализации не теряются; id секторов редактор может пересоздать —
      // участки сверяются по геометрии (демонтажу, а не id).
      // Ревью 105 R1: сверка идёт с кандидатом (клоном ПОСЛЕ операции), а не с исходной
      // моделью — намеренное добавление/снятие демонтажа не «потеря данных».
      const demolitionNorm = demolitionMismatches(
        clone.walls as Record<string, never>,
        (norm.model as Record<string, unknown>)["walls"] as Record<string, never>,
      );
      // этап 113: размеры и комментарии после нормализации не теряются и не искажаются
      const dimsNorm = dimsMismatches(this.modelInternal!, norm.model as Record<string, unknown>);
      // этап 128 (ревью 127 R1/R2/R4): комнаты до записи сверяются с базой (сервер /
      // последний успешный save) с политикой локальных изменений стен: исчезновение
      // затронутой комнаты и новая комната из изменённых стен — предупреждение,
      // потеря незатронутой комнаты — атомарный отказ операции.
      // T24: комнаты редактор пересчитывает при штатном сохранении (план "c" → draw).
      // Этап 137: normalize повторяет этот пересчёт, поэтому в копии уже перестроенные
      // комнаты. Страховка: если rooms2 в копии пусто, а редактор отчитался списком
      // комнат (norm.rooms), контурную сверку откладываем до верификации после записи.
      const normRoomsMap = ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined;
      const roomsPendingInCopy = (normRoomsMap === undefined || Object.keys(normRoomsMap).length === 0) && (norm.rooms?.length ?? 0) > 0;
      const roomsNormCheck = roomsPendingInCopy
        ? { problems: [], warnings: [] }
        : roomsSaveCompare(
            (this.roomSaveBase?.rooms ?? ((this.modelInternal!["rooms2"] ?? this.modelInternal!["rooms1"]) as Record<string, unknown> | undefined)) as Record<string, unknown> | undefined,
            normRoomsMap,
            "normalize",
            this.roomChangePolicy(clone.walls as unknown as Record<string, unknown>),
          );
      warnings.push(...roomsNormCheck.warnings);
      if (roomsNormCheck.problems.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил комнаты, не затронутые изменёнными стенами — мутация отменена`, {
          details: { room_mismatches: roomsNormCheck.problems },
        });
      }
      if (lostCablesNorm.length > 0 || cablesGraphNorm.length > 0 || cablesConnNorm.length > 0 || subsNorm.length > 0 || finishNorm.problems.length > 0 || demolitionNorm.length > 0 || dimsNorm.length > 0 || climateNorm.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил связи «выключатель → светильник», под-розетки, отделку, пометки демонтажа, размеры/комментарии или сущности климата — мутация отменена`, {
          details: { lost_cables: lostCablesNorm, cables_mismatches: cablesGraphNorm, cables_connection_mismatches: cablesConnNorm, socket_group_mismatches: subsNorm, finish_mismatches: finishNorm.problems, demolition_mismatches: demolitionNorm, dims_mismatches: dimsNorm, climate_mismatches: climateNorm },
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
   * Этап 55, ревью №6: атомарность общим механизмом — fn получает клон модели и при
   * исключении каноническая копия не меняется (замена только при успехе). Инструменты,
   * которые сами проверяют аргументы до записи, от этого не зависят, но частично
   * изменившую модель при ошибке внутри fn apply откатывает всегда.
   */
  apply<T>(label: string, fn: (model: Model) => T): T {
    const clone = structuredClone(this.modelInternal!);
    const result = fn(clone);
    this.modelInternal = clone;
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
    // B3 (аудит 65): objectId/planId в имя файла — только безопасный basename
    // (всё, кроме [0-9A-Za-z_-], заменяется на "_"), traversal исключён.
    const safe = (v: string) => v.replace(/[^0-9A-Za-z_-]/g, "_").slice(0, 40) || "0";
    return join(BACKUPS_DIR, `${safe(this.project!.objectId)}-${safe(this.project!.planId)}-${stamp}.json`);
  }

  /** Снимок модели в backups/ перед каждым сохранением. */
  writeBackup(): string {
    const path = this.backupPath();
    // B3 (аудит 65, ревью 164 m3; ревью 166 n1): BACKUPS_DIR не должен быть
    // symlink наружу. lstat-проверка ДО ensurePrivateDir: chmodSync следует
    // по symlink, и при прежнем порядке цель ссылки успевала получить chmod 700
    // до отказа. Несуществующий каталог — не symlink, создаётся обычным путём.
    const rootStat = lstatSync(BACKUPS_DIR, { throwIfNoEntry: false });
    if (rootStat?.isSymbolicLink()) {
      throw new McpError("INTERNAL", "каталог резервных копий — символическая ссылка — запись отменена");
    }
    ensurePrivateDir(BACKUPS_DIR);
    writePrivateFile(
      path,
      JSON.stringify({ object_id: this.project!.objectId, plan_id: this.project!.planId, save_id: this.project!.saveId, saved_at: new Date().toISOString(), model: this.modelInternal }, null, 1),
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
    // Разность идентичностей по всем коллекциям реестра (C1, аудит 65): стены —
    // специальные ключи (renamedWalls, openings), остальные — из
    // MODEL_ENTITY_COLLECTIONS, чтобы новая сущность не выпадала из will_delete
    // (раньше вручную отставали cables/rulers/comments).
    type DeletedIds = Record<"walls" | "renamedWalls" | "openings" | Exclude<ModelEntityCollection, "walls">, string[]>;
    const deletedIds = {} as DeletedIds;
    deletedIds.walls = deletedWalls;
    deletedIds.renamedWalls = renamedWalls;
    deletedIds.openings = missingIds(openingIds(serverModel), openingIds(this.modelInternal!));
    for (const key of MODEL_ENTITY_COLLECTIONS) {
      if (key === "walls") continue;
      deletedIds[key] = missingIds(
        new Set(Object.keys(serverModel[key] ?? {})),
        new Set(Object.keys(this.modelInternal![key] ?? {})),
      );
    }
    const willDelete = {} as SaveOutcome["will_delete"];
    willDelete.walls = deletedIds.walls.length;
    willDelete.openings = deletedIds.openings.length;
    for (const key of MODEL_ENTITY_COLLECTIONS) {
      if (key === "walls") continue;
      willDelete[PUBLIC_COLLECTION_KEYS[key]] = deletedIds[key].length;
    }
    const warnings: string[] = [];
    const idList = (ids: string[]): string => `${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ", …" : ""}`;
    if (willDelete.walls > 0) warnings.push(`будут удалены стены (${willDelete.walls}), которых нет в модели: ${idList(deletedIds.walls)}`);
    if (deletedIds.renamedWalls.length > 0) warnings.push(`идентификаторы стен изменились (${deletedIds.renamedWalls.length}) — геометрия сохранена, это нормализация, а не потеря: ${idList(deletedIds.renamedWalls)}`);
    if (willDelete.openings > 0) warnings.push(`будут удалены проёмы (${willDelete.openings}), которых нет в модели: ${idList(deletedIds.openings)}`);
    for (const key of MODEL_ENTITY_COLLECTIONS) {
      if (key === "walls") continue;
      const pub = PUBLIC_COLLECTION_KEYS[key];
      if (willDelete[pub] > 0) {
        warnings.push(`будут удалены ${ENTITY_DELETE_LABELS[key]} (${willDelete[pub]}), которых нет в модели: ${idList(deletedIds[key])}`);
      }
    }
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
    // ревью 139 m2: сбой пересчёта комнат в normalize перед save — диагностическое
    // предупреждение в результате save (код без данных пользователя)
    if (norm.roomsRebuild && norm.roomsRebuild !== "ok") {
      warnings.push(maskSecrets(`rooms_recalc_failed: ${norm.roomsRebuild}`));
    }
    // потеря проёмов/предметов — по id в копии редактора (ревью v0.1.1 №4)
    const localOpeningIds = openingIds(this.modelInternal!);
    const localItemIds = new Set(Object.keys(this.modelInternal!.items ?? {}));
    const localPillarIds = new Set(Object.keys(this.modelInternal!.pillars ?? {}));
    // ревью 43 №2/№4: ожидаемые колонны и комнаты для верификации после save.
    // ревью 45 №5: потеря комнат меряется относительно результата нормализации
    // (того, что ушло на save), а не устаревших rooms2 рабочей копии: пользователь
    // мог сам разомкнуть контур — тогда исчезновение комнаты при нормализации
    // штатно. roomsBefore нужны только для предупреждения о нормализации.
    const expectedPillars = structuredClone(this.modelInternal!.pillars ?? {}) as Record<string, PillarSig>;
    const roomsBefore = Object.keys(this.modelInternal!.rooms2 ?? {}).length;
    const normWalls = (norm.model as { walls?: Record<string, { holes?: Record<string, { id?: string }> }> }).walls ?? {};
    const gotOpeningIds = new Set<string>();
    for (const [wid, w] of Object.entries(normWalls)) {
      for (const [hid, h] of Object.entries(w.holes ?? {})) gotOpeningIds.add(h.id ?? `${wid}/${hid}`);
    }
    const gotItemIds = new Set(Object.keys((norm.model as { items?: Record<string, unknown> }).items ?? {}));
    const gotPillarIds = new Set(Object.keys((norm.model as { pillars?: Record<string, unknown> }).pillars ?? {}));
    // этап 47: ожидаемые ригели — из нормализованной модели (того, что ушло на save):
    // редактор при нормализации пересчитывает polygon/l/r, сверять надо то, что реально
    // записано, а не устаревшую рабочую копию
    const expectedRigels = structuredClone((norm.model as { rigels?: Record<string, RigelSig> }).rigels ?? {});
    // этап 55, ревью №1: ожидаемые предметы для верификации после save — из
    // нормализованной модели (того, что ушло на save)
    const expectedItems = structuredClone((norm.model as { items?: Record<string, ItemSig> }).items ?? {});
    const localRigelIds = new Set(Object.keys(this.modelInternal!.rigels ?? {}));
    const gotRigelIds = new Set(Object.keys((norm.model as { rigels?: Record<string, unknown> }).rigels ?? {}));
    // этап 57: газовые линии — ожидаемые (из нормализованной модели, того, что ушло
    // на save: редактор пересчитывает length) и потерянные при нормализации
    const expectedGasLines = structuredClone((norm.model as { pipes_gas?: Record<string, GasLineSig> }).pipes_gas ?? {});
    const localGasIds = new Set(Object.keys(this.modelInternal!.pipes_gas ?? {}));
    const gotGasIds = new Set(Object.keys((norm.model as { pipes_gas?: Record<string, unknown> }).pipes_gas ?? {}));
    // этап 78: трубы водоснабжения — ожидаемые из нормализованной модели (точки
    // вершин-предметов редактор пересчитывает — сверка локальной копии мягкая)
    const expectedPipes = structuredClone((norm.model as { pipes?: Record<string, GasLineSig> }).pipes ?? {});
    const localPipeIds = new Set(Object.keys(this.modelInternal!.pipes ?? {}));
    const gotPipeIds = new Set(Object.keys((norm.model as { pipes?: Record<string, unknown> }).pipes ?? {}));
    // этап 64: ожидаемые границы террас/участка и проёмы в полу — из нормализованной модели
    const expectedBorders = {
      terrace_borders: structuredClone((norm.model as { terrace_borders?: Record<string, unknown> }).terrace_borders ?? {}),
      territory_borders: structuredClone((norm.model as { territory_borders?: Record<string, unknown> }).territory_borders ?? {}),
    };
    const expectedLevelHoles = structuredClone((norm.model as { level_holes?: Record<string, unknown> }).level_holes ?? {});
    // этап 84: световые линии листа «Освещение» — ожидаемые из нормализованной модели
    const expectedLedStrips = structuredClone((norm.model as { led_strips?: Record<string, GasLineSig> }).led_strips ?? {});
    const expectedStripesLight = structuredClone((norm.model as { stripes_light?: Record<string, GasLineSig> }).stripes_light ?? {});
    const expectedLineStrips = structuredClone((norm.model as { line_strips?: Record<string, GasLineSig> }).line_strips ?? {});
    // этап 88: ожидаемые связи «выключатель → светильник» — из нормализованной модели
    const expectedCables = structuredClone((norm.model as { cables?: Record<string, GasLineSig> }).cables ?? {});
    const localLedIds = new Set(Object.keys(this.modelInternal!.led_strips ?? {}));
    const localStripeIds = new Set(Object.keys(this.modelInternal!.stripes_light ?? {}));
    const localLineIds = new Set(Object.keys(this.modelInternal!.line_strips ?? {}));
    const gotLedIds = new Set(Object.keys((norm.model as { led_strips?: Record<string, unknown> }).led_strips ?? {}));
    const gotStripeIds = new Set(Object.keys((norm.model as { stripes_light?: Record<string, unknown> }).stripes_light ?? {}));
    const gotLineIds = new Set(Object.keys((norm.model as { line_strips?: Record<string, unknown> }).line_strips ?? {}));
    const lostOpenings = missingIds(localOpeningIds, gotOpeningIds);
    const lostItems = missingIds(localItemIds, gotItemIds);
    const lostPillars = missingIds(localPillarIds, gotPillarIds);
    const lostRigels = missingIds(localRigelIds, gotRigelIds);
    const lostGasLines = missingIds(localGasIds, gotGasIds);
    const lostPipes = missingIds(localPipeIds, gotPipeIds);
    // этап 84: потери световых линий при нормализации
    const lostLedStrips = missingIds(localLedIds, gotLedIds);
    const lostStripesLight = missingIds(localStripeIds, gotStripeIds);
    const lostLineStrips = missingIds(localLineIds, gotLineIds);
    // этап 88: потери связей при нормализации
    const localCableIds = new Set(Object.keys(this.modelInternal!.cables ?? {}));
    const gotCableIds = new Set(Object.keys((norm.model as { cables?: Record<string, unknown> }).cables ?? {}));
    const lostCables = missingIds(localCableIds, gotCableIds);
    // ревью 59 №1: до save сверяется семантический граф локальной и нормализованной
    // моделей (узлы, тип, рёбра matrix, длина) — normalizer, обнуливший рёбра,
    // не проходит как «verified»
    const gasGraphNorm = gasLineGraphMismatches(
      structuredClone(this.modelInternal!.pipes_gas ?? {}) as Record<string, GasLineSig>,
      (norm.model as { pipes_gas?: Record<string, unknown> }).pipes_gas ?? {},
    );
    const pipesGraphNorm = gasLineGraphMismatches(
      structuredClone(this.modelInternal!.pipes ?? {}) as Record<string, GasLineSig>,
      (norm.model as { pipes?: Record<string, unknown> }).pipes ?? {},
      "труба",
      true,
      structuredClone(this.modelInternal!.items ?? {}) as Record<string, { pc?: Point; width?: number; height?: number; angle?: number }>,
    );
    // ревью 79 №5: подключения труба↔предмет сверяются в обе стороны до записи
    // (только водные ключи — климат сверяет climateGraphMismatches, ревью 124 R2)
    const pipesConnNorm = pipeConnectionMismatches(
      structuredClone(this.modelInternal!.pipes ?? {}) as Record<string, GasLineSig>,
      this.modelInternal!.items as Record<string, PipeLinkItem>,
      (norm.model as { pipes?: Record<string, GasLineSig> }).pipes ?? {},
      (norm.model as { items?: Record<string, PipeLinkItem> }).items ?? {},
      { onlyKeys: WATER_PIPE_KEYS },
    );
    // этап 64: потери границ и проёмов пола при нормализации
    const bordersNorm = checkBordersAfterNormalize(this.modelInternal!, norm.model as Model);
    const holesNorm = checkLevelHolesAfterNormalize(this.modelInternal!, norm.model as Model);
    // этап 84: семантическая сверка световых линий локальной и нормализованной моделей.
    // id_room вершин — производное (редактор пересчитывает принадлежность узла комнате
    // при draw/normalize), в предсохранительной сверке исключается — иначе штатный
    // допис-id_room объявлялся бы потерей (живая проба 84: узлы получили id_room комнаты).
    const ledGraphNorm = gasLineGraphMismatches(
      stripVertexIdRoom(structuredClone(this.modelInternal!.led_strips ?? {})) as Record<string, GasLineSig>,
      (norm.model as { led_strips?: Record<string, unknown> }).led_strips ?? {},
      "светодиодная лента",
    );
    const stripesGraphNorm = gasLineGraphMismatches(
      stripVertexIdRoom(structuredClone(this.modelInternal!.stripes_light ?? {})) as Record<string, GasLineSig>,
      (norm.model as { stripes_light?: Record<string, unknown> }).stripes_light ?? {},
      "трековая шина",
    );
    const lineStripsGraphNorm = gasLineGraphMismatches(
      stripVertexIdRoom(structuredClone(this.modelInternal!.line_strips ?? {})) as Record<string, GasLineSig>,
      (norm.model as { line_strips?: Record<string, unknown> }).line_strips ?? {},
      "линейный свет",
    );
    // этап 88: связи «выключатель → светильник» — семантическая сверка локальной и
    // нормализованной моделей (id_room вершин — производное, как у световых линий)
    const cablesGraphNorm = gasLineGraphMismatches(
      stripVertexIdRoom(structuredClone(this.modelInternal!.cables ?? {})) as Record<string, GasLineSig>,
      (norm.model as { cables?: Record<string, unknown> }).cables ?? {},
      "связь выключатель → светильник",
    );
    const cablesConnNorm = cableConnectionMismatches(
      (this.modelInternal!.cables ?? {}) as Record<string, GasLineSig>,
      (this.modelInternal!.items ?? {}) as Record<string, CableLinkItem>,
      (norm.model as { cables?: Record<string, GasLineSig> }).cables ?? {},
      (norm.model as { items?: Record<string, CableLinkItem> }).items ?? {},
      {
        led_strips: (this.modelInternal!.led_strips ?? {}) as Record<string, unknown>,
        stripes_light: (this.modelInternal!.stripes_light ?? {}) as Record<string, unknown>,
        line_strips: (this.modelInternal!.line_strips ?? {}) as Record<string, unknown>,
      },
      {
        led_strips: ((norm.model as Record<string, unknown>).led_strips ?? {}) as Record<string, unknown>,
        stripes_light: ((norm.model as Record<string, unknown>).stripes_light ?? {}) as Record<string, unknown>,
        line_strips: ((norm.model as Record<string, unknown>).line_strips ?? {}) as Record<string, unknown>,
      },
    );
    // ревью 90 R1, 92 R1a: состав и пользовательские свойства под-розеток сверяются
    // до записи; производная геометрия — только после save против нормализованного ожидания
    const subsNorm = socketGroupSubsUserMismatches(
      this.modelInternal!.items as Record<string, SubsItemSig>,
      (norm.model as { items?: Record<string, unknown> }).items ?? {},
    );
    // этап 94, ревью 95/98: отделка до записи сверяется с нормализованной моделью
    // (режим normalize — правила топологии по эталонам редактора 98)
    const finishNorm = finishCompare(
      (this.modelInternal!["rooms2"] ?? this.modelInternal!["rooms1"]) as Record<string, unknown> | undefined,
      ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
      this.modelInternal!["walls"] as Record<string, unknown> | undefined,
      (norm.model as Record<string, unknown>)["walls"] as Record<string, unknown> | undefined,
      "normalize",
    );
    // этап 113: размеры и комментарии до записи сверяются с нормализованной моделью
    const dimsNorm = dimsMismatches(this.modelInternal!, norm.model as Record<string, unknown>);
    // этап 122: сущности климата до записи сверяются с нормализованной моделью
    const climateNorm = climateGraphMismatches(this.modelInternal!, norm.model as Record<string, unknown>, {
      mode: "normalize",
      roomsExpected: (this.modelInternal!["rooms2"] ?? this.modelInternal!["rooms1"]) as Record<string, unknown> | undefined,
      roomsGot: ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
      itemsExpected: this.modelInternal!.items as unknown as Record<string, PipeLinkItem>,
      itemsGot: (norm.model as { items?: Record<string, PipeLinkItem> }).items ?? {},
    });
    // ревью 66 №3: роли стен (ограждение террасы) не должны меняться при нормализации
    const expectedWalls = structuredClone((norm.model as { walls?: Record<string, { role?: string; p1: Point; p2: Point }> }).walls ?? {});
    const rolesNorm = wallRoleMismatches(this.modelInternal!.walls as unknown as Record<string, { role?: string; p1: Point; p2: Point }>, expectedWalls);
    // этап 103: пометки демонтажа до записи сверяются с нормализованной моделью
    const demolitionNorm = demolitionMismatches(
      this.modelInternal!.walls as Record<string, never>,
      (norm.model as Record<string, unknown>)["walls"] as Record<string, never>,
    );
    // ревью 73 №2: свойства ограждений (height/depth/material) не должны меняться при нормализации
    const propsNorm = balconyWallPropertyMismatches(
      this.modelInternal!.walls as unknown as Record<string, BalconyWallProps>,
      expectedWalls as unknown as Record<string, BalconyWallProps>,
    );
    const gotSegments = wallAxisSegments(normWalls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
    const gotCoverage = wallAxisCoverageCm(normWalls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
    // ревью 43 №4: комнаты с пользовательскими полями не исчезают при нормализации молча
    const normRooms = Object.keys((norm.model as { rooms2?: Record<string, unknown> }).rooms2 ?? {}).length;
    // этап 126: комнаты до записи сверяются с нормализованной моделью — присутствие
    // каждой комнаты по каноническому контуру и пользовательские поля (имя, зоны);
    // допустимы только штатные топологии редактора (split/merge — предупреждение,
    // перенос стены — строгая сверка имени). При штатном изменении стен пользователем
    // (размыкание контура, перекомпоновка) потеря комнаты объяснима — предупреждение.
    // этап 126/128: комнаты до записи сверяются с базой (модель с сервера / после
    // последнего успешного save — ревью 127 R1/R2/R4), а не с локальной моделью после
    // операции. Изменённые пользователем стены = разница «база → рабочая копия»;
    // затронутые ими комнаты базы и новые замкнутые контуры из изменённых стен —
    // предупреждения, потеря незатронутой комнаты — NORMALIZATION_DROPPED.
    // T24: если в нормализованной копии rooms2 ещё пуст, а редактор отчитался
    // списком комнат (norm.rooms), контурная сверка откладывается до записи.
    const saveNormRoomsMap = ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined;
    const saveRoomsPending = (saveNormRoomsMap === undefined || Object.keys(saveNormRoomsMap).length === 0) && (norm.rooms?.length ?? 0) > 0;
    const roomsNormCheck = saveRoomsPending
      ? { problems: [], warnings: [] }
      : roomsSaveCompare(
          (this.roomSaveBase?.rooms ?? ((this.modelInternal!["rooms2"] ?? this.modelInternal!["rooms1"]) as Record<string, unknown> | undefined)) as Record<string, unknown> | undefined,
          saveNormRoomsMap,
          "normalize",
          this.roomChangePolicy(),
        );
    const roomsNormProblems = roomsNormCheck.problems;
    if (roomsBefore > 0 && normRooms === 0) {
      warnings.push(`редактор убрал комнаты при нормализации (${roomsBefore} → 0) — имя и отделка комнат могут быть потеряны; проверьте rooms_list после сохранения`);
    }
    if (
      !wallAxisSetsEqual(gotSegments, expected.segments) ||
      lostOpenings.length > 0 || lostItems.length > 0 || lostPillars.length > 0 || lostRigels.length > 0 || lostGasLines.length > 0 || lostPipes.length > 0 ||
      gasGraphNorm.length > 0 || pipesGraphNorm.length > 0 || pipesConnNorm.length > 0 || bordersNorm.length > 0 || holesNorm.length > 0 || rolesNorm.length > 0 || propsNorm.length > 0 ||
      lostLedStrips.length > 0 || lostStripesLight.length > 0 || lostLineStrips.length > 0 ||
      lostCables.length > 0 ||
      ledGraphNorm.length > 0 || stripesGraphNorm.length > 0 || lineStripsGraphNorm.length > 0 ||
      cablesGraphNorm.length > 0 || cablesConnNorm.length > 0 || subsNorm.length > 0 || finishNorm.problems.length > 0 || demolitionNorm.length > 0 ||
      dimsNorm.length > 0 || climateNorm.length > 0 || roomsNormProblems.length > 0
    ) {
      throw new McpError("NORMALIZATION_DROPPED", "редактор потерял объекты при нормализации", {
        details: {
          expected_walls: expected.walls,
          after_walls: norm.after.walls,
          coverage_before_mm: Math.round(expected.coverage * 10),
          coverage_after_mm: Math.round(gotCoverage * 10),
          axis_segments_before: expected.segments.length,
          axis_segments_after: gotSegments.length,
          wall_property_mismatches: propsNorm,
          lost_openings: lostOpenings,
          lost_items: lostItems,
          lost_pillars: lostPillars,
          lost_rigels: lostRigels,
          lost_gas_lines: lostGasLines,
          gas_line_mismatches: gasGraphNorm,
          lost_pipes: lostPipes,
          pipe_mismatches: pipesGraphNorm,
          pipe_connection_mismatches: pipesConnNorm,
          border_mismatches: bordersNorm,
          level_hole_mismatches: holesNorm,
          wall_role_mismatches: rolesNorm,
          lost_led_strips: lostLedStrips,
          lost_stripes_light: lostStripesLight,
          lost_line_strips: lostLineStrips,
          lost_cables: lostCables,
          led_strip_mismatches: ledGraphNorm,
          stripes_light_mismatches: stripesGraphNorm,
          line_strips_mismatches: lineStripsGraphNorm,
          cables_mismatches: cablesGraphNorm,
          cables_connection_mismatches: cablesConnNorm,
          socket_group_mismatches: subsNorm,
          finish_mismatches: finishNorm.problems,
          demolition_mismatches: demolitionNorm,
          dims_mismatches: dimsNorm,
          climate_mismatches: climateNorm,
          room_mismatches: roomsNormProblems,
        },
      });
    }
    warnings.push(...finishNorm.warnings);
    warnings.push(...roomsNormCheck.warnings);
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
      const rigelsAfter = (after.model["rigels"] as Record<string, unknown> | undefined) ?? {};
      const rigelMismatch = rigelVerificationMismatches(expectedRigels, rigelsAfter);
      // этап 55, ревью №1: предметы после save сверяются по id и типу/геометрии,
      // а не только счётчиком при нормализации
      const itemsAfter = (after.model["items"] as Record<string, unknown> | undefined) ?? {};
      const itemMismatch = itemVerificationMismatches(expectedItems, itemsAfter);
      // этап 57: газовые линии после save сверяются по id, типу, узлам, рёбрам matrix
      // и длине (ревью 59 №1 — топология входит в сверку)
      const gasAfter = (after.model["pipes_gas"] as Record<string, unknown> | undefined) ?? {};
      const gasMismatch = gasLineGraphMismatches(expectedGasLines, gasAfter);
      // этап 78: трубы водоснабжения после save — по нормализованной семантике графа;
      // ревью 79 №3/№5: точки вершин-предметов и длина — строго (ожидание уже
      // нормализованное), множество труб в обе стороны, identity вершин-предметов по id
      const pipesAfter = (after.model["pipes"] as Record<string, unknown> | undefined) ?? {};
      const pipeMismatch = gasLineGraphMismatches(expectedPipes, pipesAfter, "труба");
      // ревью 79 №5a: обратные ссылки props.pipes и прямые ссылки предметов — обе стороны
      // (только водные ключи — климат сверяет climateGraphMismatches, ревью 124 R2)
      const pipeConnAfter = pipeConnectionMismatches(
        expectedPipes,
        expectedItems as Record<string, PipeLinkItem>,
        pipesAfter as Record<string, GasLineSig>,
        (itemsAfter as Record<string, PipeLinkItem>) ?? {},
        { onlyKeys: WATER_PIPE_KEYS },
      );
      // этап 64: границы террас/участка и проёмы в полу после save — по нормализованной семантике
      const bordersAfter = {
        terrace_borders: (after.model["terrace_borders"] as Record<string, unknown> | undefined) ?? {},
        territory_borders: (after.model["territory_borders"] as Record<string, unknown> | undefined) ?? {},
      };
      const borderMismatch = checkBordersAfterNormalize(
        { terrace_borders: expectedBorders.terrace_borders, territory_borders: expectedBorders.territory_borders } as Model,
        bordersAfter,
      );
      const holesAfter = (after.model["level_holes"] as Record<string, unknown> | undefined) ?? {};
      const holeMismatch = levelHoleMismatches(expectedLevelHoles as Record<string, import("./model/types.ts").LevelHole>, holesAfter);
      // этап 84: световые линии после save — по нормализованной семантике графа
      const ledAfter = (after.model["led_strips"] as Record<string, unknown> | undefined) ?? {};
      const stripesAfter = (after.model["stripes_light"] as Record<string, unknown> | undefined) ?? {};
      const lineStripsAfter = (after.model["line_strips"] as Record<string, unknown> | undefined) ?? {};
      const ledMismatch = gasLineGraphMismatches(expectedLedStrips, ledAfter, "светодиодная лента");
      const stripesMismatch = gasLineGraphMismatches(expectedStripesLight, stripesAfter, "трековая шина");
      const lineStripsMismatch = gasLineGraphMismatches(expectedLineStrips, lineStripsAfter, "линейный свет");
      // этап 88: связи «выключатель → светильник» после save — граф и обе стороны ссылок
      const cablesAfter = (after.model["cables"] as Record<string, unknown> | undefined) ?? {};
      const cablesMismatch = gasLineGraphMismatches(expectedCables, cablesAfter, "связь выключатель → светильник");
      const cablesConnAfter = cableConnectionMismatches(
        expectedCables,
        expectedItems as Record<string, CableLinkItem>,
        cablesAfter as Record<string, GasLineSig>,
        (itemsAfter as Record<string, CableLinkItem>) ?? {},
        {
          led_strips: ((norm.model as Record<string, unknown>).led_strips ?? {}) as Record<string, unknown>,
          stripes_light: ((norm.model as Record<string, unknown>).stripes_light ?? {}) as Record<string, unknown>,
          line_strips: ((norm.model as Record<string, unknown>).line_strips ?? {}) as Record<string, unknown>,
        },
        {
          led_strips: ((after.model["led_strips"] as Record<string, unknown> | undefined) ?? {}),
          stripes_light: ((after.model["stripes_light"] as Record<string, unknown> | undefined) ?? {}),
          line_strips: ((after.model["line_strips"] as Record<string, unknown> | undefined) ?? {}),
        },
      );
      // ревью 90 R6: форма обратных ссылок (массив у под-розетки, скаляр у светильника)
      // после save сверяется с нормализованным ожиданием
      const cableFormAfter = cableLinkFormMismatches(
        expectedItems as Record<string, CableLinkItem>,
        itemsAfter,
      );
      // ревью 90 R1, 92 R1a/R1b: состав и пользовательские свойства под-розеток
      // после save; производная геометрия (center/real_center/vd) — против
      // нормализованного ожидания с допуском
      const subsAfter = socketGroupSubsUserMismatches(
        expectedItems as Record<string, SubsItemSig>,
        itemsAfter,
      );
      const subsDerivedAfter = socketGroupSubsDerivedMismatches(
        expectedItems as Record<string, SubsItemSig>,
        itemsAfter,
      );
      // ревью 66 №3: роли стен после save — ограждение, ставшее обычной стеной, не «verified»
      const wallsAfterTyped = wallsAfter as Record<string, { role?: string; p1: Point; p2: Point }>;
      const wallRoleMismatch = wallRoleMismatches(expectedWalls, wallsAfterTyped);
      // ревью 73 №2: свойства ограждений после save — height/depth/material сверяются,
      // подмена любого из них на сервере не «verified»
      const wallPropMismatch = balconyWallPropertyMismatches(
        expectedWalls as unknown as Record<string, BalconyWallProps>,
        wallsAfterTyped as unknown as Record<string, BalconyWallProps>,
      );
      // этап 94, ревью 95/98: отделка после save сверяется по GET — нормализованное
      // ожидание против сервера; режим save — СТРОГО (ревью 98 N1/N2): комната и каждая
      // сторона стены (ориентированно) сохраняют отделку; никаких merge/split-освобождений
      const expectedFinish = ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined;
      const gotFinish = ((after.model["rooms2"] ?? after.model["rooms1"]) as Record<string, unknown> | undefined) ?? {};
      const finishAfter = finishCompare(
        expectedFinish,
        gotFinish,
        (norm.model as Record<string, unknown>)["walls"] as Record<string, unknown> | undefined,
        after.model["walls"] as Record<string, unknown> | undefined,
        "save",
      ).problems;
      // этап 103: пометки демонтажа после save — нормализованное ожидание против сервера,
      // строго (участки по геометрии, флаги demount по каждой стене и проёму)
      const demolitionAfter = demolitionMismatches(
        (norm.model as Record<string, unknown>)["walls"] as Record<string, never>,
        after.model["walls"] as Record<string, never>,
      );
      // этап 113: размеры и комментарии после save сверяются по GET — нормализованное
      // ожидание против сервера (строго: текст, точки, привязки, отступ, цвет)
      const dimsAfter = dimsMismatches(norm.model as Model, after.model as Record<string, unknown>);
      // этап 122: сущности климата после save — нормализованное ожидание против сервера
      const climateExpected = {
        warm_floors: structuredClone((norm.model as Record<string, unknown>)["warm_floors"] ?? {}),
        pipes_warm_floor: structuredClone((norm.model as Record<string, unknown>)["pipes_warm_floor"] ?? {}),
        pipes_conditioner: structuredClone((norm.model as Record<string, unknown>)["pipes_conditioner"] ?? {}),
        pipes_heat: structuredClone((norm.model as Record<string, unknown>)["pipes_heat"] ?? {}),
        pipes_ventilation: structuredClone((norm.model as Record<string, unknown>)["pipes_ventilation"] ?? {}),
      };
      const climateAfter = climateGraphMismatches(
        climateExpected as unknown as Model,
        after.model as Record<string, unknown>,
        {
          mode: "save",
          itemsExpected: structuredClone((norm.model as { items?: Record<string, PipeLinkItem> }).items ?? {}),
          itemsGot: (itemsAfter as Record<string, PipeLinkItem>) ?? {},
          // ревью 133 N1: при перегородке редактор перестраивает комнаты при save
          // и сам переназначает id_room контуров — сверка привязки по геометрии
          roomsExpected: ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
          roomsGot: ((after.model["rooms2"] ?? after.model["rooms1"]) as Record<string, unknown> | undefined) ?? {},
        },
      );
      const roomsLost = normRooms > 0 && roomsAfter === 0;
      // этап 126: комнаты после save — строго (по каноническому контуру и
      // пользовательским полям): частичная потеря N→M>0 и потеря имени/зон — не verified
      const roomsAfterCheck = roomsSaveCompare(
        ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
        ((after.model["rooms2"] ?? after.model["rooms1"]) as Record<string, unknown> | undefined) ?? {},
        "save",
      ).problems;
      if (wallAxisSetsEqual(segmentsAfter, expected.segments) && pillarMismatch.length === 0 && rigelMismatch.length === 0 && itemMismatch.length === 0 && gasMismatch.length === 0 && pipeMismatch.length === 0 && pipeConnAfter.length === 0 && borderMismatch.length === 0 && holeMismatch.length === 0 && wallRoleMismatch.length === 0 && wallPropMismatch.length === 0 && ledMismatch.length === 0 && stripesMismatch.length === 0 && lineStripsMismatch.length === 0 && cablesMismatch.length === 0 && cablesConnAfter.length === 0 && cableFormAfter.length === 0 && subsAfter.length === 0 && subsDerivedAfter.length === 0 && finishAfter.length === 0 && demolitionAfter.length === 0 && dimsAfter.length === 0 && climateAfter.length === 0 && roomsAfterCheck.length === 0 && !roomsLost) {
        verified = true;
        finalSaveId = after.save_id || saveRes.saveId || finalSaveId;
        this.modelInternal = toModel(structuredClone(after.model));
        // база сверки комнат — серверная истина после записи (этап 128)
        this.roomSaveBase = this.captureRoomBase();
      } else if (attempt === 1) {
        const coverageAfter = wallAxisCoverageCm(wallsAfter as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
        throw new McpError("SITE_ERROR", "после сохранения модель на сервере не совпала с рабочей копией", {
          details: {
            expected_walls: expected.walls, got_walls: Object.keys(wallsAfter).length,
            coverage_before_mm: Math.round(expected.coverage * 10), coverage_after_mm: Math.round(wallAxisCoverageCm(wallsAfter as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>) * 10),
            axis_segments_before: expected.segments.length, axis_segments_after: segmentsAfter.length,
            pillar_mismatches: pillarMismatch, rigel_mismatches: rigelMismatch, item_mismatches: itemMismatch,
            gas_line_mismatches: gasMismatch,
            pipe_mismatches: pipeMismatch,
            pipe_connection_mismatches: pipeConnAfter,
            border_mismatches: borderMismatch,
            level_hole_mismatches: holeMismatch,
            wall_role_mismatches: wallRoleMismatch,
            wall_property_mismatches: wallPropMismatch,
            led_strip_mismatches: ledMismatch,
            stripes_light_mismatches: stripesMismatch,
            line_strips_mismatches: lineStripsMismatch,
            cables_mismatches: cablesMismatch,
            cables_connection_mismatches: cablesConnAfter,
            cables_link_form_mismatches: cableFormAfter,
            socket_group_mismatches: subsAfter,
            socket_group_derived_mismatches: subsDerivedAfter,
            rooms_expected: normRooms, rooms_on_server: roomsAfter,
            room_mismatches: roomsAfterCheck,
            finish_mismatches: finishAfter,
            demolition_mismatches: demolitionAfter,
            dims_mismatches: dimsAfter,
            climate_mismatches: climateAfter,
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
    // Счётчики «что видит редактор»: walls/openings/items/pillars/rigels — из
    // отчёта адаптера (after), остальные коллекции — из нормализованной модели,
    // ключи — публичные ключи реестра MODEL_ENTITY_COLLECTIONS
    // (PUBLIC_COLLECTION_KEYS, газовые линии — gas_lines), чтобы новая сущность
    // не выпадала из сверки рендера (раньше вручную отставали cables/rulers/comments
    // и трубы климата). Публичные ключи — те же, что в will_delete и counts.
    const normModel = norm.model as Record<string, unknown>;
    const normModelCount = (key: string): number =>
      Object.keys((normModel[key] as Record<string, unknown> | null | undefined) ?? {}).length;
    const seen: Record<string, number> = {
      walls: norm.after.walls,
      openings: norm.after.holes,
      items: norm.after.items,
      pillars: norm.after.pillars ?? normModelCount("pillars"),
      rigels: norm.after.rigels ?? normModelCount("rigels"),
    };
    for (const key of MODEL_ENTITY_COLLECTIONS) {
      if (key === "walls" || key === "items" || key === "pillars" || key === "rigels") continue;
      seen[PUBLIC_COLLECTION_KEYS[key]] = normModelCount(key);
    }
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
    for (const key of MODEL_ENTITY_COLLECTIONS) {
      if (key === "walls") continue;
      const pub = PUBLIC_COLLECTION_KEYS[key];
      if (seen[pub] !== expected[pub]) mismatch.push(`${pub}: в модели ${expected[pub]}, в редакторе ${seen[pub]}`);
    }
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
      rigels: expected.rigels,
      editor: seen as RenderRevision["editor"],
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
