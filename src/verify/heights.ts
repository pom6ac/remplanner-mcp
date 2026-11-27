// Сверка высот при save (этап 419, бэклог 418 §4 A): изменение высот проекта
// (project_set_height v2 — семантика $Project.setHeigth бандла) обязано видеться
// сверкой «ожидание (нормализованная модель) → сервер»: total_height,
// rooms2[*].height, walls[*].height у стен не-balcony (ограды сверяет
// balconyWallPropertyMismatches — height/depth/material по покрытию оси).
// Числа — см модели редактора; округление редактора до сотых не расхождение
// (допуск 0,1 см, как у balconyWallPropertyMismatches).

const TOL_CM = 0.1;

const near = (a: unknown, b: unknown): boolean =>
  typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= TOL_CM;

type WallLike = { height?: unknown; role?: unknown };
type RoomLike = Record<string, unknown>;

/**
 * Высоты стен не-balcony: расхождение — строка; пустой список — совпало.
 * Сверяются только пары, где в ожидании высота — число (запись без height
 * редактор достраивает из total_height — конструктор Wall).
 */
export function wallHeightMismatches(
  expected: Record<string, WallLike>,
  got: Record<string, WallLike>,
): string[] {
  const out: string[] = [];
  for (const [id, e] of Object.entries(expected)) {
    if (e.role === "balcony") continue; // ограждения — balconyWallPropertyMismatches
    if (typeof e.height !== "number") continue;
    const g = got[id];
    if (!g) continue; // исчезновение стены — не здесь (ось/роли сверяются отдельно)
    if (!near(e.height, g.height)) {
      out.push(`стена ${id}: height изменилась (на сервере ${String(g.height)}; ожидалось ${String(e.height)})`);
    }
  }
  return out;
}

/**
 * Высоты комнат rooms2: у каждой записи с числовой высотой в ожидании — та же
 * высота на сервере. Сохранённая высота комнаты побеждает общую при reopen
 * (конструктор Room2: height = e.height || params.total_height) — потеря
 * персональной высоты комнаты молча проходить не должна.
 */
export function roomHeightMismatches(
  expected: Record<string, RoomLike> | undefined,
  got: Record<string, RoomLike> | undefined,
): string[] {
  const out: string[] = [];
  for (const [rid, e] of Object.entries(expected ?? {})) {
    if (typeof e["height"] !== "number") continue;
    const g = (got ?? {})[rid];
    if (!g) continue; // исчезновение комнаты — roomsSaveCompare
    if (!near(e["height"], g["height"])) {
      out.push(`комната ${rid}: height изменилась (на сервере ${String(g["height"])}; ожидалось ${String(e["height"])})`);
    }
  }
  return out;
}

/** Общая высота проекта (params.total_height, см). */
export function totalHeightMismatch(expected: unknown, got: unknown): string[] {
  if (typeof expected !== "number" || typeof got !== "number") return [];
  return near(expected, got) ? [] : [`total_height изменилась (на сервере ${String(got)}; ожидалось ${String(expected)})`];
}

/**
 * Высоты колонн (PILLARS[*].total_height, см): у колонны с числовой высотой
 * в ожидании — та же высота на сервере (доработка 419: setHeigth патчит колонны,
 * ветки role:"gypsum" — с сохранением «своей» меньшей высоты).
 */
export function pillarHeightMismatches(
  expected: Record<string, { total_height?: unknown }>,
  got: Record<string, { total_height?: unknown }>,
): string[] {
  const out: string[] = [];
  for (const [pid, e] of Object.entries(expected)) {
    if (typeof e.total_height !== "number") continue;
    const g = got[pid];
    if (!g) continue; // исчезновение колонны — pillarVerificationMismatches
    if (!near(e.total_height, g.total_height)) {
      out.push(`колонна ${pid}: total_height изменилась (на сервере ${String(g.total_height)}; ожидалось ${String(e.total_height)})`);
    }
  }
  return out;
}

/**
 * Высоты дверей (holes группы "doors", см): у проёма с числовой высотой в
 * ожидании — та же высота на сервере (доработка 419: setHeigth поджимает
 * l.height > total → total; потери поджима после save молча проходить не должны).
 */
export function doorHeightMismatches(
  expected: Record<string, { holes?: Record<string, { group?: unknown; height?: unknown }> }>,
  got: Record<string, { holes?: Record<string, { group?: unknown; height?: unknown }> }>,
): string[] {
  const out: string[] = [];
  for (const [wid, w] of Object.entries(expected)) {
    const gotHoles = got[wid]?.holes ?? {};
    for (const [hid, h] of Object.entries(w.holes ?? {})) {
      if (h.group !== "doors" || typeof h.height !== "number") continue;
      const g = gotHoles[hid];
      if (!g) continue; // исчезновение проёма — holeMismatch
      if (!near(h.height, g.height)) {
        out.push(`стена ${wid}: дверь ${hid}: height изменилась (на сервере ${String(g.height)}; ожидалось ${String(h.height)})`);
      }
    }
  }
  return out;
}
