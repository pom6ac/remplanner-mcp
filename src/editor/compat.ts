import { createHash } from "node:crypto";
import { McpError } from "../errors.ts";
import type { Page } from "playwright-core";
import { PAGE } from "./inject.js";

export type CompatPresent = {
  WALLS: boolean;
  ROOMS2: boolean;
  restore: boolean;
  draw: boolean;
  copy: boolean;
  save: boolean;
  canvas: boolean;
  /** T25: draw строит связи из геометрии через Wall.prototype.link1/link2/calc. */
  wall_link1: boolean;
  wall_link2: boolean;
  wall_calc: boolean;
};

export type CompatInfo = {
  global_version: string | null;
  planner_version: string | null;
  bundles: string[];
  /** Фактические id проекта со страницы редактора (body data-атрибуты). */
  object_id: string | null;
  plan_id: string | null;
  present: CompatPresent;
};

export type CompatPageLike = {
  evaluate<T>(fn: string): Promise<T>;
};

/** Чтение информации о версии и наличии точек входа (со страницы или мока). */
export async function readCompat(page: Page | CompatPageLike): Promise<CompatInfo> {
  const info = (await (page.evaluate as (fn: string) => Promise<unknown>)(PAGE.compatInfo)) as CompatInfo;
  return info;
}

/** Имена функций контракта, отсутствие которых ломает адаптер. */
export function missingFunctions(present: CompatPresent): string[] {
  const missing: string[] = [];
  if (!present.WALLS) missing.push("window.WALLS");
  if (!present.ROOMS2) missing.push("window.ROOMS2");
  if (!present.restore) missing.push("$Project.restore");
  if (!present.draw) missing.push("$Project.draw");
  if (!present.copy) missing.push("project.copy");
  if (!present.save) missing.push("project.save");
  if (!present.canvas) missing.push("#canvas_v2_wrapper");
  if (!present.wall_link1) missing.push("Wall.prototype.link1");
  if (!present.wall_link2) missing.push("Wall.prototype.link2");
  if (!present.wall_calc) missing.push("Wall.prototype.calc");
  return missing;
}

/** Контрактный чек: любая отсутствующая точка входа → EDITOR_INCOMPATIBLE. */
export function assertCompatible(info: CompatInfo): void {
  const missing = missingFunctions(info.present);
  if (missing.length > 0) {
    throw new McpError("EDITOR_INCOMPATIBLE", `редактор несовместим: нет ${missing.join(", ")}`, {
      hint: "сайт обновился — сверьте contract-тест и inject.js с новой версией редактора",
      details: { global_version: info.global_version, bundles: info.bundles, missing },
    });
  }
}

/**
 * Отпечатки бандлов: короткий sha256 имени каждого скрипта /files/js/.
 * Смена имени бандла (версии) меняет отпечаток — этого достаточно, чтобы заметить
 * обновление сайта и предупредить о возможной несовместимости (хеш содержимого
 * требует лишних скачиваний и нужен только при разборе инцидента).
 */
export function bundleFingerprints(bundles: string[]): string[] {
  return bundles.map((name) => createHash("sha256").update(name).digest("hex").slice(0, 12));
}

let lastSeenVersion: string | null = null;

/** Сброс запомненной версии (для тестов и нового процесса наблюдения). */
export function resetVersionTracking(version: string | null = null): void {
  lastSeenVersion = version;
}

/**
 * Лог смены версии редактора: при первом контакте — фиксируем, при смене
 * global_version в процессе работы — предупреждение в stderr (версия сайта
 * может сломать контракт адаптера — EDITOR_INCOMPATIBLE).
 */
export function trackVersion(info: CompatInfo, log: (line: string) => void = (l) => console.error(l)): void {
  const v = info.global_version;
  if (v === null) return;
  if (lastSeenVersion === null) {
    lastSeenVersion = v;
    return;
  }
  if (v !== lastSeenVersion) {
    log(`remplanner-mcp: версия редактора сменилась ${lastSeenVersion} → ${v} (бандлов: ${info.bundles.length})`);
    lastSeenVersion = v;
  }
}
