import { lstatSync } from "node:fs";
import { basename, join } from "node:path";
import { BACKUPS_DIR } from "./config.ts";
import { ensurePrivateDir, writePrivateFile } from "./fs-safe.ts";
import { McpError, maskSecrets } from "./errors.ts";
import type { SessionState } from "./session.ts";
import type { LoadedModel } from "./api.ts";
import type { NormalizeResult, EditorSaveResult, RenderOptions, CompatInfo, EditorRoom } from "./editor/adapter.ts";
import type { Model, Point } from "./model/types.ts";
import { MODEL_ENTITY_COLLECTIONS, PUBLIC_COLLECTION_KEYS } from "./model/collections.ts";
import { modelCounts, modelIsContentEmpty, modelHash, toModel, type ModelCounts } from "./model/canonical.ts";
import { runSave, type SaveHost, type SaveOutcome } from "./save/orchestration.ts";

// Канонические помощники переехали в src/model/canonical.ts, тип SaveOutcome —
// в src/save/orchestration.ts (C2); реэкспорт — чтобы импорты из workspace.ts
// не менялись.
export { modelCounts, modelIsContentEmpty };
export type { ModelCounts, SaveOutcome };
import type { RoomPolygon } from "./model/items.ts";
import { roomPolygons } from "./model/items.ts";
import { prepareForRestore, findUnattachedEnds, expectedDanglingEndPoints, unmatchedDanglingEnds, wallAxisSegments, wallAxisSetsEqual, wallAxisCoverageCm, assertNoNewWarmFloorCrossing, type DanglingEnd } from "./model/walls.ts";
import { dist } from "./model/geometry.ts";
import { renderPlanToFile, type RenderedPlan, type RenderRevision } from "./render.ts";
import { finishCompare } from "./model/finish.ts";
import { zoneDelimiterCompare } from "./model/zone.ts";
import { demolitionMismatches } from "./model/demolition.ts";
import { roomsSaveCompare, roomsChangePolicy, type RoomsChangePolicy } from "./model/rooms-save.ts";
import { dimsMismatches } from "./model/dims.ts";
import {
  cableConnectionMismatches,
  elecCableConnectionMismatches,
  checkBordersAfterNormalize,
  checkLevelHolesAfterNormalize,
  climateGraphMismatches,
  gasLineGraphMismatches,
  missingIds,
  pipeConnectionMismatches,
  shieldMismatches,
  socketGroupSubsUserMismatches,
  stripVertexIdRoom,
  WATER_PIPE_TYPES,
  type CableLinkItem,
  type CableLinkLines,
  type ElecLinkItem,
  type ElecCableColl,
  type GasLineSig,
  type PipeLinkItem,
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

export type HistorySnapshot = { label: string; at: string };

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
/** Счётчики ошибок редактора (copy("server").errors) — рост → INVALID_GEOMETRY (§12.4). */
function errorGrowth(before: Record<string, number> | null | undefined, after: Record<string, number> | null | undefined): string[] {
  if (!before || !after) return [];
  const grown: string[] = [];
  for (const [k, v] of Object.entries(after)) {
    if ((before[k] ?? 0) < v) grown.push(`${k}: ${before[k] ?? 0}→${v}`);
  }
  return grown;
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
        { onlyTypes: WATER_PIPE_TYPES },
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
      // часть 2: кабели-проводка (cables_socket/warm_floor/conditioner) после нормализации
      // не теряются и не искажаются (граф + обе стороны обратных ссылок); длина —
      // производная (опуски редактора), вершины-предметы — точки по правилу 7 см
      const elecCollKeys = ["cables_socket", "cables_warm_floor", "cables_conditioner"] as const;
      for (const coll of elecCollKeys) {
        const wsElec = stripVertexIdRoom(structuredClone((this.modelInternal![coll] ?? {}) as Record<string, GasLineSig>)) as Record<string, GasLineSig>;
        const normElec = ((norm.model as Record<string, unknown>)[coll] ?? {}) as Record<string, unknown>;
        const lostElec = missingIds(new Set(Object.keys(wsElec)), new Set(Object.keys(normElec)));
        const elecGraphNorm = gasLineGraphMismatches(structuredClone(wsElec), normElec, "кабель-проводка", false, undefined, { skipLength: true });
        const elecAll = (src: Model): Partial<Record<ElecCableColl, Record<string, GasLineSig>>> => ({
          cables_socket: structuredClone((src.cables_socket ?? {}) as Record<string, GasLineSig>),
          cables_warm_floor: structuredClone((src.cables_warm_floor ?? {}) as Record<string, GasLineSig>),
          cables_conditioner: structuredClone((src.cables_conditioner ?? {}) as Record<string, GasLineSig>),
        });
        const elecConnNorm = elecCableConnectionMismatches(
          elecAll(this.modelInternal!),
          this.modelInternal!.items as Record<string, ElecLinkItem>,
          elecAll(norm.model as Model),
          ((norm.model as { items?: Record<string, ElecLinkItem> }).items ?? {}) as Record<string, ElecLinkItem>,
          coll, // ревью 241 №6: только текущая коллекция — без дублей под чужими ключами
        );
        if (lostElec.length > 0 || elecGraphNorm.length > 0 || elecConnNorm.length > 0) {
          throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил кабели-проводку (${coll}) — мутация отменена`, {
            details: { [`lost_${coll}`]: lostElec, [`${coll}_mismatches`]: elecGraphNorm, [`${coll}_connection_mismatches`]: elecConnNorm },
          });
        }
      }
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
      // этап 255: щитки после нормализации не теряются; редактор дополняет щиток-предмет
      // без записи записью по умолчанию (SHIELDS.restore) — авто-запись не потеря
      const shieldsNorm = shieldMismatches(
        structuredClone((this.modelInternal!["shields"] ?? {}) as Record<string, never>),
        ((norm.model as Record<string, unknown>)["shields"] ?? {}) as Record<string, never>,
        { allowAutoCreate: true },
      );
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
      // этап 260: разделители зон потолка после нормализации не теряются
      // (сопоставление комнат по контуру; split/merge — предупреждение, как у отделки)
      const zoneNorm = zoneDelimiterCompare(
        this.modelInternal! as unknown as Record<string, unknown>,
        norm.model as unknown as Record<string, unknown>,
        "normalize",
      );
      warnings.push(...zoneNorm.warnings);
      if (lostCablesNorm.length > 0 || cablesGraphNorm.length > 0 || cablesConnNorm.length > 0 || subsNorm.length > 0 || finishNorm.problems.length > 0 || demolitionNorm.length > 0 || dimsNorm.length > 0 || climateNorm.length > 0 || shieldsNorm.length > 0 || zoneNorm.problems.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил связи «выключатель → светильник», под-розетки, отделку, пометки демонтажа, размеры/комментарии, сущности климата, щитки или разделители зон потолка — мутация отменена`, {
          details: { lost_cables: lostCablesNorm, cables_mismatches: cablesGraphNorm, cables_connection_mismatches: cablesConnNorm, socket_group_mismatches: subsNorm, finish_mismatches: finishNorm.problems, demolition_mismatches: demolitionNorm, dims_mismatches: dimsNorm, climate_mismatches: climateNorm, shield_mismatches: shieldsNorm, zone_mismatches: zoneNorm.problems },
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

  /** Хост для save-оркестрации (src/save/orchestration.ts): доступ к состоянию
   *  workspace. Существующий seam WorkspaceDeps/EditorLike сохранён; writeBackup
   *  и история undo/redo (dirty/undo-взаимодействие) остаются в Workspace. */
  private saveHost(): SaveHost {
    return {
      deps: this.deps,
      project: this.project,
      openedEmpty: () => this.openedEmpty,
      model: () => this.modelInternal!,
      setRoomsCache: (rooms) => { this.roomsCache = rooms; },
      roomSaveBase: () => this.roomSaveBase,
      roomChangePolicy: (nowWalls) => this.roomChangePolicy(nowWalls),
      hasEditor: () => this.editorInternal !== null,
      ensureEditor: () => this.ensureEditor(),
      writeBackup: () => this.writeBackup(),
      onVerified: (model) => {
        this.modelInternal = model;
        // база сверки комнат — серверная истина после записи (этап 128)
        this.roomSaveBase = this.captureRoomBase();
      },
      onSaved: () => {
        this.snapshots = [];
        this.historyIndex = -1;
        this.pushSnapshot("saved");
      },
    };
  }

  /**
   * Сохранение: сверка save_id с сервером (SAVE_CONFLICT при расхождении, минуя force),
   * снимок в backups/, нормализация редактором, project.save, проверка по GET
   * (надёжнее save_id — отчёт 05, факт 6) с одним повтором при расхождении.
   * Принудительная запись поверх чужих правок — только при явном force: true.
   * Оркестрация — src/save/orchestration.ts (аудит 65 C2); порядок вызовов,
   * повторы и обработка конфликтов не изменены (журналы c2-save-journal).
   */
  async save(options: { force?: boolean } = {}): Promise<SaveOutcome> {
    return runSave(this.saveHost(), options);
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
