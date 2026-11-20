import type { Model, Point } from "./types.ts";

// Общий слой разделителей зон (этап 260; вынесен из zone.ts ревью 311 №6, чтобы
// пересчёт зон потолка ceiling-zones.ts видел legacy-делители без runtime-цикла
// импортов — сторож 181-c3b): типы/планы записей, legacy-миграция, общий реестр
// (верхнеуровневое zone_delimiters + per-room delimiters) и рёбра графов
// zone_ceiling-делителей. Формат записи — эталон scripts/probes/260-zone-serialize.ts
// + tests/fixtures/ui-ref-ceilzone-delimiter.json.

/**
 * Типы разделителей зон одного класса ZoneDelimitering (бандл app.3.0: tools
 * zone_c/zone_ceiling/zone_floor/zone_hydroisolation/zone_floor_cap) и план
 * записи = лист, на котором линия нарисована (эталоны 296, проба 296-zone-ui:
 * кнопка на листах отделки одна — plannertool_zone_floor, тип записи задаёт
 * активный лист): zone_ceiling → plan "ceiling" («Потолки»), zone_floor →
 * "floor" («Напольные покрытия»), zone_hydroisolation → "hydroisolation"
 * («Гидроизоляция»), zone_floor_cap → "floor_cap" («Стяжка»). zone_c (лист
 * «Перегородки», getNameZone "c" → zones) имеет собственную семантику
 * зонирования перегородками — вынесен в следующий PR (этап 296, отчёт).
 */
export const ZONE_DELIMITER_PLANS = {
  zone_ceiling: "ceiling",
  zone_floor: "floor",
  zone_hydroisolation: "hydroisolation",
  zone_floor_cap: "floor_cap",
} as const satisfies Record<string, string>;

export type ZoneDelimiterType = keyof typeof ZONE_DELIMITER_PLANS;

/** План записи по типу (ревью 298 №1): редактор восстанавливает legacy-делитель
 *  по типу (restoreTotal: updateZones("ceiling","zone_ceiling")), то есть plan
 *  выводится из type; zone_c (лист «Перегородки») — план "c". */
export function planOfDelimiterType(type: string): string {
  if (type in ZONE_DELIMITER_PLANS) return ZONE_DELIMITER_PLANS[type as ZoneDelimiterType];
  return type === "zone_c" ? "c" : "";
}

/**
 * Legacy-миграция (convertOld ZoneDelimiter, бандл): типы «d_zone»→«zone_c»,
 * «d_*»→«zone_*»; старая форма points:[p1,p2] без vertexes разворачивается в
 * граф из двух узлов (restore 260). Возвращает каноническую запись или исходную.
 * Поля on_size/length дописываются только legacy-записям (points-форма, per-room
 * storage, старый тип d_*) — ревью 263 N3: дописывание верхнеуровневой записи
 * сервера маскирует потерю полей (сверка перестаёт видеть, что сервер потерял
 * on_size или обнулил/удалил length).
 */
export function migrateLegacyDelimiter(
  rec: Record<string, unknown>,
  opts: { legacy?: boolean } = {},
): Record<string, unknown> {
  const out = structuredClone(rec);
  const t = String(out["type"] ?? "");
  const legacyType = t === "d_zone" || t.startsWith("d_");
  if (t === "d_zone") out["type"] = "zone_c";
  else if (t.startsWith("d_")) out["type"] = `zone_${t.slice(2)}`;
  let builtFromPoints = false;
  if (!Array.isArray(out["vertexes"]) || (out["vertexes"] as unknown[]).length === 0) {
    const points = out["points"] as Array<Point> | undefined;
    if (Array.isArray(points) && points.length >= 2) {
      out["vertexes"] = points.slice(0, 2).map((p, i) => ({ id: `p${i}`, point: p, type: "node" }));
      out["items"] = { ...((out["items"] ?? {}) as Record<string, string>), v0: "node", v1: "node" };
      out["matrix"] = [[null, { length: 1 }], [{ length: 1 }, null]];
      builtFromPoints = true;
    }
  }
  // ревью 261 №6: restore редактора дополняет записи полей on_size 1 и length
  // (м, по геометрии линии) — дописываем их миграции, чтобы старая модель (points-
  // форма, per-room без length/on_size) сверялась с нормализованной в обе стороны
  // и не блокировала save. ревью 263 N3: только legacy-записям.
  if (builtFromPoints || legacyType || opts.legacy) {
    const v = (out["vertexes"] ?? []) as Array<{ point?: Point }>;
    if (v.length >= 2 && v[0]?.point && v[v.length - 1]?.point) {
      if (out["on_size"] === undefined) out["on_size"] = 1;
      const len = Number(out["length"] ?? 0);
      if (!(len > 0)) {
        const p1 = v[0]!.point!, p2 = v[v.length - 1]!.point!;
        out["length"] = Math.round((Math.hypot(p2.x - p1.x, p2.y - p1.y) / 100) * 100) / 100;
      }
    }
  }
  return out;
}

/** Все разделители модели: верхнеуровневое zone_delimiters (серверный формат) +
 *  legacy per-room delimiters (старые модели; редактор мигрирует их при restore).
 *  Ключ — id записи; при коллизии top-level приоритетен. legacy — запись пришла
 *  из per-room хранилища (ревью 263 N3: ей можно дописывать on_size/length). */
export function delimiterMapOf(model: Model): Record<string, { rec: Record<string, unknown>; roomKey: string | null; legacy: boolean }> {
  const out: Record<string, { rec: Record<string, unknown>; roomKey: string | null; legacy: boolean }> = {};
  const rooms = (model.rooms2 ?? model.rooms1 ?? {}) as Record<string, { delimiters?: Record<string, Record<string, unknown>> }>;
  for (const [rid, room] of Object.entries(rooms)) {
    for (const [key, raw] of Object.entries(room.delimiters ?? {})) {
      out[key] = { rec: raw, roomKey: rid, legacy: true };
    }
  }
  for (const [key, raw] of Object.entries((model.zone_delimiters ?? {}) as Record<string, Record<string, unknown>>)) {
    out[key] = { rec: raw, roomKey: String(raw["id_room"] ?? "") || null, legacy: false };
  }
  return out;
}

/** Все zone_ceiling разделители модели (верхнеуровневые + legacy per-room):
 *  для проверки пересечения при создании потолочной закладной и пересчёта зон
 *  потолка. Ревью 304 M2: mouseup редактора перебирает ВСЕ отрезки M.lines
 *  каждого zone_ceiling, поэтому возвращаются все рёбра графа по matrix (не
 *  хорда «первая → последняя вершина», которая у Г-/П-образного разделителя
 *  лежит на стене и прячет пересечения со средними отрезками). roomId
 *  фильтрует по комнате (roomKey хранилища ?? id_room записи). */
export function zoneCeilingDelimiterLines(model: Model, roomId?: string): Array<{ id: string; p1: Point; p2: Point }> {
  const out: Array<{ id: string; p1: Point; p2: Point }> = [];
  for (const [id, entry] of Object.entries(delimiterMapOf(model))) {
    if (roomId !== undefined && entry.roomKey !== roomId && String(entry.rec["id_room"] ?? "") !== roomId) continue;
    const rec = migrateLegacyDelimiter(entry.rec, { legacy: entry.legacy });
    if (String(rec["type"] ?? "") !== "zone_ceiling") continue;
    const v = (rec["vertexes"] ?? []) as Array<{ point?: Point }>;
    const n = v.length;
    if (n < 2) continue;
    // рёбра графа по матрице (i<j, длина > 0) — как перебор M.lines в mouseup
    const matrix = (rec["matrix"] ?? []) as Array<Array<{ length?: number } | null>>;
    let edges = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const cell = matrix[i]?.[j] ?? matrix[j]?.[i];
        if (cell && Number(cell.length) > 0 && v[i]?.point && v[j]?.point) {
          out.push({ id, p1: v[i]!.point!, p2: v[j]!.point! });
          edges += 1;
        }
      }
    }
    // legacy/деградировавшая запись без матрицы — хорда «первая → последняя»
    if (edges === 0) {
      const q1 = v[0]?.point, q2 = v[n - 1]?.point;
      if (q1 && q2) out.push({ id, p1: q1, p2: q2 });
    }
  }
  return out;
}
