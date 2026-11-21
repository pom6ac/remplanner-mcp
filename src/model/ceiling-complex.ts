import type { Model, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { polygonSignedArea, pointInPolygon, type Polygon } from "./geometry.ts";
import { resolveRoom, type RoomRec } from "./finish.ts";
import { roomPolygonOf, polygonEdgesOf } from "./room-geo.ts";
import { McpError } from "../errors.ts";

/**
 * Двухуровневый потолок (complex_ceiling, лист «Потолки», инструмент
 * «Двухуровневый потолок»; этап 328, 2026-11-21). НЕ PRO (разметка,
 * эталон .orca-reports/tmp/328-pro-anon.json). Запись — rooms2[rid].ceilings[i]
 * (та же запись отделки потолка): обработчик клика редактора (бандл 268) ставит
 * exist=true, complex=true, offset=defs.complex_ceiling.offset (40 см),
 * radius=defs.complex_ceiling.radius (10 см), а при отсутствии level2 —
 * level=15, level2=7.5, material="gypsum_ceiling", material2="stretch_ceiling",
 * type="closed"; anchor и type_laying удаляются. Производные поля (polygon2,
 * polygon_new, polygons_layout, edges_new, area_childs — эталон
 * 328-complex-etalon.json) редактор пересчитывает сам при draw/save — MCP их не
 * пишет. Второй клик по уже complex-потолку редактор игнорирует (нет-op) — MCP
 * возвращает текущее состояние без изменения.
 *
 * Проверки редактора (тот же обработчик): площадь записи потолка ≥ 4 м²
 * (l10n ceiling_not_inst_complex + reason_1) и внутренний контур
 * (get_inner_polygon с offset 40 см) без самопересечений (reason_3) — иначе
 * INVALID_ARGUMENT. Перед построением внутреннего контура редактор дважды
 * прогоняет LIB.mergeLines по рёбрам и сливает коллинеарные (T-узел на контуре —
 * примыкающая стена/wall_split — штатная ситуация; ревью 329 №3): порт —
 * mergeCollinearEdges перед innerPolygon.
 *
 * Отличия от обработчика бандла (268-app.js, complex_ceiling), ревью 329 №12:
 * - terrace: в редакторе клик по террасе молча игнорируется ("terrace" !==
 *   room.role) — MCP отказывает INVALID_ARGUMENT (явность вместо тишины);
 * - зона по клику выбирается по наименьшей площади среди содержащих точку
 *   (LIB.polygonArea + isPointOverPolygon, сравнение d<t) — как в редакторе;
 * - level2 проверяется на falsy (r.level2 || …): 0 — это «не задан»;
 * - armstrong_ceiling: редактор перед установкой complex делает
 *   r.deleteItems() для is_class-записи (удаляет предметы раскладки Армстронга);
 *   MCP не воспроизводит deleteItems (класс редактора недоступен) — предметы
 *   раскладки остаются в модели; расхождение допустимо: редактор пересчитает
 *   записи потолка при restore/save.
 * При/edit save сверка — по sig отделки (finish.ts ceilingSigsOf), дополненному
 * полями complex/material2/level2/offset/radius.
 */

export const COMPLEX_CEILING_DEFS = {
  /** Отступ внутреннего контура от стен, см (defs.complex_ceiling.offset). */
  offsetCm: 40,
  /** Радиус скругления углов внутреннего контура, см (defs.complex_ceiling.radius). */
  radiusCm: 10,
  /** Минимальная площадь потолка, м² (проверка редактора). */
  minAreaM2: 4,
  /** Умолчания редактора при отсутствии level2. */
  level: 15,
  level2: 7.5,
  material: "gypsum_ceiling",
  material2: "stretch_ceiling",
  type: "closed",
} as const;

type CeilingRec = Record<string, unknown>;

function ceilingsOf(room: RoomRec): CeilingRec[] {
  return Array.isArray(room.ceilings) ? (room.ceilings as CeilingRec[]).filter((c) => c && typeof c === "object") : [];
}

function polygonAreaM2(poly: Point[]): number {
  return Math.abs(polygonSignedArea(poly)) / 10_000;
}

/**
 * Порт LIB.mergeLines для контура потолка (ревью 329 №3): удаляет вершины,
 * у которых смежные рёбра коллинеарны и продолжают друг друга (угол между
 * линиями 180±0.1°, как angleBetweenTwoLines в бандле; допуск точек — 0.2 см,
 * но в кольце вершины общие). Редактор прогоняет mergeLines дважды по рёбрам
 * записи перед get_inner_polygon — без этого T-узел на контуре комнаты
 * (примыкающая стена, wall_split) даёт параллельные смежные рёбра после
 * отступа и ложный GEOMETRY_CONFLICT. Возвращает новый массив (вход не меняет).
 */
export function mergeCollinearEdges(poly: Point[], tolerance = 0.2): Point[] {
  let pts = poly.map((p) => ({ ...p }));
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length]!;
      const cur = pts[i]!;
      const next = pts[(i + 1) % pts.length]!;
      // вершина-дубликат предыдущей (ребро нулевой длины) — сливается всегда
      const dup = Math.hypot(cur.x - prev.x, cur.y - prev.y) <= tolerance;
      if (!dup) {
        const d1x = cur.x - prev.x, d1y = cur.y - prev.y;
        const d2x = next.x - cur.x, d2y = next.y - cur.y;
        const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
        if (l1 < 1e-9 || l2 < 1e-9) continue;
        // коллинеарность смежных рёбер (LIB.angleBetweenTwoLines, |h−180| < 0.1° —
        // угол между осями линий): синус угла между направлениями < sin(0.1°)
        const cos = (d1x * d2x + d1y * d2y) / (l1 * l2);
        const sin = Math.abs(d1x * d2y - d1y * d2x) / (l1 * l2);
        if (sin > 0.002 && Math.abs(cos) < 1 - 1e-9) continue;
      }
      pts = pts.filter((_, j) => j !== i);
      changed = true;
      break;
    }
  }
  return pts;
}

/**
 * Внутренний контур полигона со сдвигом offsetCm внутрь (порт get_inner_polygon):
 * перед отступом коллинеарные рёбра сливаются (mergeCollinearEdges — порт
 * LIB.mergeLines, ревью 329 №3), каждое ребро сдвигается внутрь, новые вершины —
 * пересечения соседних сдвинутых прямых. Ориентация берётся по знаковой площади.
 */
export function innerPolygon(poly: Point[], offsetCm: number): Point[] {
  const merged = mergeCollinearEdges(poly);
  const n = merged.length;
  if (n < 3) throw new McpError("INVALID_ARGUMENT", "контур потолка вырожден");
  const offsetEdge = (a: Point, b: Point): { A: number; B: number; C: number } => {
    // прямая a→b, сдвинутая внутрь на offsetCm: n·p = n·a + offset, n — нормаль внутрь
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) throw new McpError("INVALID_ARGUMENT", "контур потолка содержит нулевое ребро");
    let nx = dy / len, ny = -dx / len;
    const mid = { x: (a.x + b.x) / 2 + nx * offsetCm, y: (a.y + b.y) / 2 + ny * offsetCm };
    if (!pointInPolygon(merged as Polygon, mid)) {
      nx = -nx; ny = -ny;
    }
    return { A: nx, B: ny, C: nx * a.x + ny * a.y + offsetCm };
  };
  const lines: { A: number; B: number; C: number }[] = [];
  for (let i = 0; i < n; i++) lines.push(offsetEdge(merged[i]!, merged[(i + 1) % n]!));
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[i]!, l2 = lines[(i + 1) % n]!;
    const den = l1.A * l2.B - l2.A * l1.B;
    if (Math.abs(den) < 1e-9) throw new McpError("GEOMETRY_CONFLICT", "внутренний контур вырожден — параллельные смежные рёбра после отступа");
    const x = (l1.C * l2.B - l2.C * l1.B) / den;
    const y = (l1.A * l2.C - l2.A * l1.C) / den;
    out.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
  }
  // проверка редактора: число самопересечений не-соседних рёбер > 2 — отказ
  let crossings = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // соседние по кольцу
      const s1 = { p1: out[i]!, p2: out[(i + 1) % n]! };
      const s2 = { p1: out[j]!, p2: out[(j + 1) % n]! };
      const x = segIntersect(s1, s2);
      if (x) crossings += 1;
    }
  }
  if (crossings > 2) {
    throw new McpError("GEOMETRY_CONFLICT", "внутренний контур двухуровневого потолка (отступ 400 мм от стен) имеет самопересечения — редактор откажет в установке (ceiling_reason_3); выберите другую комнату/зону", {
      details: { kind: "complex_ceiling_inner_self_intersection", crossings },
    });
  }
  if (polygonAreaM2(out) <= 0.01) {
    throw new McpError("GEOMETRY_CONFLICT", "внутренний контур двухуровневого потолка вырожден — отступ 400 мм не помещается в контуре", {
      details: { kind: "complex_ceiling_inner_empty" },
    });
  }
  return out;
}

/** Пересечение отрезков (концы включены), null если нет. */
function segIntersect(s1: { p1: Point; p2: Point }, s2: { p1: Point; p2: Point }): Point | null {
  const d1x = s1.p2.x - s1.p1.x, d1y = s1.p2.y - s1.p1.y;
  const d2x = s2.p2.x - s2.p1.x, d2y = s2.p2.y - s2.p1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((s2.p1.x - s1.p1.x) * d2y - (s2.p1.y - s1.p1.y) * d2x) / den;
  const u = ((s2.p1.x - s1.p1.x) * d1y - (s2.p1.y - s1.p1.y) * d1x) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: s1.p1.x + d1x * t, y: s1.p1.y + d1y * t };
}

export type CeilingComplexResult = { index: number; id: string; siteId: string; already: boolean };

/**
 * finish_ceiling_complex_set: двухуровневый потолок в зоне комнаты, содержащей
 * точку at_mm (или в единственной записи), атомарно — кандидат-копия записи.
 */
export function setCeilingComplex(model: Model, roomRef: string, atMm?: MmPoint): CeilingComplexResult {
  const { id: roomId, room } = resolveRoom(model, roomRef);
  // ревью 329 №12: в террасе двухуровневый потолок не ставится (в редакторе клик
  // по террасе молча игнорируется: "terrace" !== this.room.role) — MCP отказывает явно
  if (room["role"] === "terrace") {
    throw new McpError("INVALID_ARGUMENT", `комната ${roomRef} — терраса: двухуровневый потолок не ставится (в редакторе клик по террасе игнорируется)`, {
      details: { kind: "terrace_ceiling", room_id: roomId },
    });
  }
  let records = ceilingsOf(room);
  if (records.length === 0) {
    // как у редактора: запись-контейнер от контура комнаты (Room2 restore)
    const poly = roomPolygonOf(room);
    if (!poly || poly.length < 3) {
      throw new McpError("INVALID_ARGUMENT", `комната ${roomRef} без контура — потолок нельзя определить`, {
        details: { kind: "no_room_polygon", room_id: roomId },
      });
    }
    room.ceilings = [{
      exist: false,
      polygon: poly.map((p) => ({ x: r2(p.x), y: r2(p.y) })),
      edges: polygonEdgesOf(poly),
    }];
    records = ceilingsOf(room);
  }
  // зона: запись, содержащая точку (клик редактора); ревью 329 №12 — как в
  // редакторе, по наименьшей площади среди содержащих (сравнение d<t); без
  // точки — единственная
  let index = -1;
  if (atMm) {
    const p = { x: mmToCm(atMm.x), y: mmToCm(atMm.y) };
    let bestArea = Infinity;
    records.forEach((c, i) => {
      const poly = c["polygon"] as Point[] | undefined;
      if (!Array.isArray(poly) || poly.length < 3 || !pointInPolygon(poly as Polygon, p)) return;
      const a2 = Math.abs(polygonSignedArea(poly));
      if (a2 < bestArea) {
        bestArea = a2;
        index = i;
      }
    });
    if (index < 0) {
      throw new McpError("OUTSIDE_ROOM", `точка вне зон потолка комнаты ${roomRef} — двухуровневый потолок ставится кликом по зоне (как в редакторе)`, {
        details: { kind: "outside_ceiling_zone", point: p, room_id: roomId },
      });
    }
  } else {
    if (records.length !== 1) {
      throw new McpError("INVALID_ARGUMENT", `в комнате ${roomRef} ${records.length} зон потолка — укажите at_mm (точка внутри зоны, как клик в редакторе)`, {
        details: { kind: "zone_required", zones: records.length },
      });
    }
    index = 0;
  }
  const rec = records[index]!;
  if (rec["complex"] === true) {
    // второй клик редактора — нет-op: возвращаем текущее состояние
    return { index, id: typeof rec["id"] === "string" ? rec["id"] : "", siteId: roomId, already: true };
  }
  const poly = rec["polygon"] as Point[] | undefined;
  if (!Array.isArray(poly) || poly.length < 3) {
    throw new McpError("INVALID_ARGUMENT", `зона потолка без полигона — запись повреждена`, {
      details: { kind: "no_zone_polygon", room_id: roomId },
    });
  }
  // проверка редактора 1: площадь ≥ 4 м²
  const area = polygonAreaM2(poly);
  if (area < COMPLEX_CEILING_DEFS.minAreaM2) {
    throw new McpError("INVALID_ARGUMENT", `площадь потолка ${Math.round(area * 100) / 100} м² меньше 4 м² — редактор не ставит двухуровневый потолок (ceiling_reason_1)`, {
      details: { kind: "ceiling_too_small", area_m2: Math.round(area * 100) / 100, min_area_m2: COMPLEX_CEILING_DEFS.minAreaM2 },
    });
  }
  // проверка редактора 2: внутренний контур без самопересечений
  innerPolygon(poly, COMPLEX_CEILING_DEFS.offsetCm);
  // кандидат-копия записи (атомарность на слое ws.apply)
  const candidate = structuredClone(rec) as CeilingRec;
  delete candidate["anchor"];
  delete candidate["type_laying"];
  candidate["exist"] = true;
  candidate["complex"] = true;
  candidate["offset"] = COMPLEX_CEILING_DEFS.offsetCm;
  candidate["radius"] = COMPLEX_CEILING_DEFS.radiusCm;
  // profile standard — умолчание редактора (эталон 328-complex-etalon.json)
  if (candidate["profile"] === undefined || candidate["profile"] === null || candidate["profile"] === "") {
    candidate["profile"] = "standard";
  }
  // ревью 329 №12: level2 проверяется на falsy, как в редакторе (r.level2 || …):
  // 0 считается «не задан», умолчания применяются
  if (!candidate["level2"]) {
    candidate["level"] = COMPLEX_CEILING_DEFS.level;
    candidate["level2"] = COMPLEX_CEILING_DEFS.level2;
    candidate["material"] = COMPLEX_CEILING_DEFS.material;
    candidate["material2"] = COMPLEX_CEILING_DEFS.material2;
    candidate["type"] = COMPLEX_CEILING_DEFS.type;
  }
  if (typeof candidate["id"] !== "string") candidate["id"] = `_c${newId(8)}`;
  (room.ceilings as CeilingRec[])[index] = candidate;
  return { index, id: candidate["id"] as string, siteId: roomId, already: false };
}
