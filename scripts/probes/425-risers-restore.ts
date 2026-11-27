// 427: чистый выбор «что удалять» страховкой restore пробы 425 (фикс major M1
// ревью 426). Модуль без побочных эффектов и без сети — импортируется и пробой
// (425-risers-live.ts), и юнит-тестом (tests/unit/425-restore-decision.test.ts).
//
// Правила fail-closed (426, M1):
//  - бэкап не загружен (backupItems === null: bm не присвоен из-за падения до
//    строки `bm = backup.model`) — страховка НИЧЕГО не удаляет (проба печатает
//    «STOP: страховка пропущена — нет бэкапа», код выхода ≠ 0);
//  - удалять можно ТОЛЬКО предметы, созданные ЭТИМ прогоном (id из журнала,
//    провалидированные до записи) и только если их НЕТ в бэкапе 425;
//  - пользовательские предметы бэкапа (есть в бэкапе) не трогаются никогда;
//  - предмет вида KEYS, которого нет ни в бэкапе, ни в журнале (чужой предмет,
//    добавленный после снятия бэкапа; остаток ДРУГОГО прогона) — НЕ удалять,
//    перечислить в manual для ручного разбора.

/** Виды предметов пробы 425 (те же, что в пробе). */
export const RISER_KEYS = ["water", "water_column_hot", "water_column_cold", "drainage_column", "ceiling_water"] as const;

export type RestoreDecisionInput = {
  /** Предметы бэкапа 425 ({site_id: {name, …}}); null — бэкап не загружен. */
  backupItems: Record<string, { name?: unknown }> | null;
  /** Журнал прогона: провалидированные (непустые) id предметов ЭТОГО прогона. */
  journal: readonly { key: string; site_id: string }[];
  /** Предметы текущей модели ({site_id: {name, …}}). */
  currentItems: Record<string, { name?: unknown }>;
};

export type RestoreDecision =
  | { ok: false; reason: "no-backup" }
  | {
      ok: true;
      /** Что удалять: id предмета из журнала этого прогона, которого нет в бэкапе. */
      delete: { id: string; key: string }[];
      /** Предметы вида KEYS вне бэкапа и журнала — ручной разбор, НЕ удалять. */
      manual: { id: string; name: string }[];
    };

/**
 * Решение страховки restore: что удалять, что оставить на ручной разбор.
 * Чистая функция — никакого I/O, детерминированный результат.
 */
export function selectRestoreDeletes(input: RestoreDecisionInput): RestoreDecision {
  if (input.backupItems === null) return { ok: false, reason: "no-backup" };
  const backupIds = new Set(Object.keys(input.backupItems));
  const ws = input.currentItems ?? {};
  // удалять — только предметы ЭТОГО прогона (журнал), и только вне бэкапа
  const journalIds = new Set<string>();
  const del: { id: string; key: string }[] = [];
  for (const pi of input.journal) {
    if (pi.site_id === "") continue; // журнал валидируется до записи, но страховка не верит
    journalIds.add(pi.site_id);
    if (!(pi.site_id in ws)) continue; // уже удалён (штатный item_delete)
    if (backupIds.has(pi.site_id)) continue; // fail-closed: id совпал с бэкапом — не трогаем
    del.push({ id: pi.site_id, key: pi.key });
  }
  // остатки/чужие предметы вида KEYS: нет ни в бэкапе, ни в журнале — ручной разбор
  const manual: { id: string; name: string }[] = [];
  for (const [iid, it] of Object.entries(ws)) {
    if (backupIds.has(iid)) continue; // пользовательский предмет бэкапа — не трогается
    if (journalIds.has(iid)) continue; // свой — уже в delete
    const name = String(it?.["name"] ?? "");
    if ((RISER_KEYS as readonly string[]).includes(name)) manual.push({ id: iid, name });
  }
  return { ok: true, delete: del, manual };
}
