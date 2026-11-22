// 386 (ревью 385 №36): знаковое смещение стены для restore в finally живых
// проб 382/384. Прежний rawShiftMm давал БЕЗЗНАКОВОЕ смещение (hypot) по
// серверной RAW-модели, а применял его wall_move(-off) к рабочей копии MCP.
// Сценарий из ревью: wall_move −20 прошёл, project_save упал до записи
// (на сервере +20) → finally: off=20 → wall_move(-20) на копии с 0 → −20 —
// стена dev-объекта уходила на 20 мм в обратную сторону. Исправление:
// смещение считается ЗНАКОВЫМ — проекция (p1_raw − ось из журнала) на левую
// нормаль оси стены, та же формула направления, что в moveWall (src/model/
// walls.ts: v = leftNormal(u) * mmToCm(offsetMm)); RAW-модель сервера в см,
// журнал model_get в мм. Рабочая копия перед wall_move пересинхронизируется
// с сервером (project_open), после restore save модель сверяется sig с бэкапом.

/** Ось стены из журнала пробы (model_get, мм). */
export type JournalWall = { from: [number, number]; to: [number, number] };

/** Стена серверной RAW-модели (p1/p2 в см). */
export type RawAxis = Record<string, unknown>;

/**
 * Знаковое смещение оси стены от исходной (журнал) в мм: проекция сдвига
 * p1 на левую нормаль ТЕКУЩЕЙ оси (направление оси moveWall не меняет).
 * NaN — в RAW-модели нет числовых p1/p2 (состояние неизвестно, fail-closed).
 */
export function signedWallShiftMm(w0: JournalWall, raw: RawAxis): number {
  const p1 = raw["p1"] as { x?: unknown; y?: unknown } | undefined;
  const p2 = raw["p2"] as { x?: unknown; y?: unknown } | undefined;
  if (!p1 || typeof p1.x !== "number" || typeof p1.y !== "number") return NaN;
  if (!p2 || typeof p2.x !== "number" || typeof p2.y !== "number") return NaN;
  // левая нормаль оси (та же, что в moveWall): n = leftNormal(p2-p1) = (dy,-dx)/len
  const ax = p2.x - p1.x;
  const ay = p2.y - p1.y;
  const len = Math.hypot(ax, ay);
  if (len < 1e-9) return NaN;
  const dx = p1.x - w0.from[0] / 10; // RAW в см, журнал в мм
  const dy = p1.y - w0.from[1] / 10;
  return ((dx * ay - dy * ax) / len) * 10; // (d·n̂)*10 → мм
}

/** Допуск «стена на месте», мм. */
export const RESTORE_TOLERANCE_MM = 2;
/** Отказ от восстановления при слишком большом смещении (ревью 385 №36), мм. */
export const RESTORE_MAX_MM = 25;

export type RestoreDecision =
  | { action: "none" }
  | { action: "move"; offsetMm: number }
  | { action: "refuse" };

/** Решение restore по знаковому смещению: ничего / вернуть (-shift) / отказаться. */
export function restoreDecision(signedShiftMm: number): RestoreDecision {
  if (!Number.isFinite(signedShiftMm)) return { action: "refuse" };
  if (Math.abs(signedShiftMm) <= RESTORE_TOLERANCE_MM) return { action: "none" };
  if (Math.abs(signedShiftMm) > RESTORE_MAX_MM) return { action: "refuse" };
  return { action: "move", offsetMm: -signedShiftMm };
}
