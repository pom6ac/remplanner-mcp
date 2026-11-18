// Журнал вызовов save-оркестрации (аудит 65 C2, задача 192-c2s п.1): фейковые
// WorkspaceDeps/EditorLike и подкласс Workspace записывают каждый вызов seam
// (порядок и аргументы без секретов). Снапшоты журналов лежат в
// tests/unit/snapshots/c2-save-journal-*.json и после рефакторинга
// (вынесение save-оркестрации в src/save/) обязаны остаться побайтно теми же.
// Переснятие — только осознанно: C2_SAVE_JOURNAL_REGEN=1 npm test
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BACKUPS_DIR } from "../../../src/config.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../../src/workspace.ts";
import type { LoadedModel } from "../../../src/api.ts";
import type { EditorRoom } from "../../../src/editor/adapter.ts";
import type { Model, FixtureEnvelope } from "../../../src/model/types.ts";
import { addWall } from "../../../src/model/walls.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

export type JournalEntry = { op: string; [key: string]: unknown };

export function fixtureModel(): Model {
  const env = JSON.parse(
    readFileSync(join(ROOT, "tests/fixtures/anon-rect-4000x3000.json"), "utf8"),
  ) as FixtureEnvelope;
  return structuredClone(env.model);
}

/** Модель «сервера» фейка: save_id + последняя записанная модель. */
export type SaveServer = { saveId: string; model: Model };

export type RecordingOptions = {
  /** editor.save отвечает ok:false (сетевой сбой / отказ сайта). */
  failSave?: boolean;
  /** afterSave вызывается после каждой записи сервера (порча для verify mismatch). */
  afterSave?: (server: SaveServer, saveCount: number) => void;
  /** editor.save отвечает ok, но без save_id (сайт не вернул id записи, ревью 199 №2в). */
  saveWithoutId?: boolean;
  /** Список комнат от редактора в результате normalize (norm.rooms, 194-fix-c2s). */
  normalizeRooms?: EditorRoom[];
};

const COMPAT_NULL = {
  global_version: null, planner_version: null, bundles: [],
  object_id: null, plan_id: null,
  present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true },
};

/** Счётчики сущностей подготовленной модели — аргумент editor.normalize без содержимого. */
function modelCounters(model: Record<string, unknown>): { walls: number; holes: number; items: number; pillars: number; rigels: number } {
  const walls = (model["walls"] ?? {}) as Record<string, { holes?: Record<string, unknown> }>;
  return {
    walls: Object.keys(walls).length,
    holes: Object.values(walls).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0),
    items: Object.keys((model["items"] ?? {}) as object).length,
    pillars: Object.keys((model["pillars"] ?? {}) as object).length,
    rigels: Object.keys((model["rigels"] ?? {}) as object).length,
  };
}

/** Путь бэкапа без каталога и метки времени: в снапшоте не должно быть
 *  локальных путей (HOME теста — временный и меняется между прогонами). */
export function sanitizeBackupPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\d{4}-\d{2}-\d{2}T[\d-]+Z?\.json$/, "<stamp>.json");
}

/**
 * Workspace с журналом: перезаписывает writeBackup (входит в последовательность
 * save) и ведёт фейковые часы — монотонный счётчик «at» вместо реального времени.
 */
export class JournalWorkspace extends Workspace {
  readonly journal: JournalEntry[] = [];
  private clock = 0;

  record(entry: JournalEntry): void {
    this.clock++;
    this.journal.push({ at: this.clock, ...entry });
  }

  /** Фейковый таймер: задержку оркестрация не делает — вызов попал бы в журнал. */
  fakeSleep(ms: number): void {
    this.record({ op: "sleep", ms });
  }

  override writeBackup(): string {
    // счётчик — только файлы этого проекта: сценарии работают в общем BACKUPS_DIR
    const prefix = `${this.project!.objectId}-`;
    const before = existsSync(BACKUPS_DIR) ? readdirSync(BACKUPS_DIR).filter((f) => f.startsWith(prefix)) : [];
    const path = super.writeBackup();
    this.record({ op: "backup.write", path: sanitizeBackupPath(path), backup_files_before: before.length });
    return path;
  }
}

/** Фейковые WorkspaceDeps/EditorLike, записывающие вызовы в журнал workspace. */
export function recordingDeps(
  server: SaveServer,
  opts: RecordingOptions = {},
  record: (entry: JournalEntry) => void = () => {},
): { deps: WorkspaceDeps; editor: EditorLike; saveCount: () => number } {
  let lastNormalized: Record<string, unknown> | null = null;
  let saveCount = 0;
  const editor: EditorLike = {
    objectId: "123", planId: "1",
    async normalize(model) {
      lastNormalized = structuredClone(model) as Record<string, unknown>;
      const counters = modelCounters(lastNormalized);
      record({ op: "editor.normalize", model: counters });
      return {
        model: structuredClone(lastNormalized) as Record<string, unknown>,
        rooms: opts.normalizeRooms ?? [],
        before: counters,
        after: counters,
      };
    },
    async save() {
      saveCount++;
      record({ op: "editor.save", attempt: saveCount });
      if (opts.failSave) {
        record({ op: "editor.save.result", ok: false, conflict: false, save_id: null });
        return { ok: false, saveId: null, conflict: false };
      }
      server.model = structuredClone(lastNormalized ?? fixtureModel()) as unknown as Model;
      server.saveId = "s2";
      opts.afterSave?.(server, saveCount);
      const saveId = opts.saveWithoutId ? null : server.saveId;
      record({ op: "editor.save.result", ok: true, conflict: false, save_id: saveId });
      return { ok: true, saveId, conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() {
      record({ op: "editor.compatInfo", object_id: null, plan_id: null });
      return COMPAT_NULL;
    },
    async close() { record({ op: "editor.close" }); },
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(_s, objectId, planId): Promise<LoadedModel> {
      record({ op: "loadModel", object_id: objectId, plan_id: planId, save_id: server.saveId });
      return {
        object_id: objectId, plan_id: planId, save_id: server.saveId, units: "cm", data_empty: false,
        model: structuredClone(server.model) as unknown as Record<string, unknown>,
      };
    },
    async openEditor(_s, objectId, planId, options) {
      record({ op: "openEditor", object_id: objectId, plan_id: planId, anonymous: options?.anonymous ?? false });
      return editor;
    },
  };
  return { deps, editor, saveCount: () => saveCount };
}

/** Штатная мутация стен для сценариев (вне seam: editor не запускает). */
export function addExtraWall(ws: JournalWorkspace): void {
  ws.apply("wall_add", (m) => addWall(m, { start: { x: 0, y: 6000 }, end: { x: 1000, y: 6000 } }));
}

/** Детерминированный id добавленной стены (addWall генерирует случайный id):
 *  журналы 194-fix-c2s печатают id стен после save — снапшот обязан быть
 *  детерминированным. Стена изолирована (без link-связей), перенос безопасен. */
export function pinExtraWallId(ws: JournalWorkspace, id: string): void {
  ws.apply("wall_pin_id", (m) => {
    const wid = Object.keys(m.walls).find((k) => m.walls[k]!.p1.y === 600)!;
    const w = m.walls[wid]!;
    delete m.walls[wid];
    w.id = id;
    m.walls[id] = w;
  });
}

/** Итог save в журнал: результат или код ошибки; содержимого модели нет. */
export function recordOutcome(ws: JournalWorkspace, outcome: { save_id: string; save_id_before: string; backup_path: string; verified: boolean; rounds: number; will_delete: Record<string, number>; warnings: string[] }): void {
  ws.record({
    op: "save.outcome",
    save_id: outcome.save_id,
    save_id_before: outcome.save_id_before,
    backup_path: sanitizeBackupPath(outcome.backup_path),
    verified: outcome.verified,
    rounds: outcome.rounds,
    will_delete: outcome.will_delete,
    warnings: outcome.warnings,
  });
}

export function recordError(ws: JournalWorkspace, error: unknown): void {
  const attempts = ws.journal.filter((e) => e.op === "editor.save").length;
  const sleeps = ws.journal.filter((e) => e.op === "sleep").length;
  const details = (error as { details?: unknown }).details;
  ws.record({
    op: "save.error",
    code: (error as { code?: string }).code ?? "UNKNOWN",
    save_attempts: attempts,
    retries: Math.max(0, attempts - 1),
    delays_ms: sleeps,
    details_keys: details && typeof details === "object" ? Object.keys(details as object).sort() : [],
  });
}

/** Фиксация итогового состояния workspace (модель не печатается — только счётчики). */
export function recordState(ws: JournalWorkspace): void {
  ws.record({
    op: "workspace.state",
    dirty: ws.project?.dirty ?? null,
    save_id: ws.project?.saveId ?? null,
    walls: Object.keys(ws.model.walls).length,
    history_steps: ws.historyInfo().steps,
  });
}

/**
 * Наблюдаемое состояние workspace после verified (194-fix-c2s): рабочая копия
 * заменена ответом сервера, база сверки комнат обновлена, кэш комнат (norm.rooms)
 * доступен через rooms(), dirty сброшен. Печатаются только идентификаторы,
 * не содержимое моделей. roomSaveBase/roomsCache — приватные поля Workspace,
 * читаются приведением типа (журнальный тест, не production-код).
 */
export function recordVerifiedState(ws: JournalWorkspace): void {
  const internals = ws as unknown as {
    roomSaveBase: { rooms: Record<string, unknown>; walls: Record<string, unknown> } | null;
  };
  ws.record({
    op: "workspace.after_verified",
    dirty: ws.project?.dirty ?? null,
    save_id: ws.project?.saveId ?? null,
    model_wall_ids: Object.keys(ws.model.walls).sort(),
    model_room_keys: Object.keys(ws.model.rooms2 ?? {}).sort(),
    rooms_list_ids: ws.rooms().map((r) => String(r.roomId)).sort(),
    room_save_base_room_keys: Object.keys(internals.roomSaveBase?.rooms ?? {}).sort(),
    room_save_base_wall_ids: Object.keys(internals.roomSaveBase?.walls ?? {}).sort(),
  });
}

/** Число файлов бэкапа этого проекта после save — «backup после» (порядок
 *  «до» — в backup.write; сценарии различаются object_id, поэтому счётчик
 *  не зависит от порядка сценариев и других тестов). */
export function recordBackupFiles(ws: JournalWorkspace): void {
  const prefix = `${ws.project!.objectId}-`;
  const files = existsSync(BACKUPS_DIR) ? readdirSync(BACKUPS_DIR).filter((f) => f.startsWith(prefix)) : [];
  ws.record({ op: "backup.files", count: files.length, all_match_prefix: files.every((f) => f.startsWith(prefix)) });
}

/** Сериализация журнала для снапшота: детерминированный JSON. */
export function journalSnapshot(journal: JournalEntry[]): string {
  return JSON.stringify(journal, null, 2) + "\n";
}
