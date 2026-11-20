import type { Point } from "./types.ts";
import { closestPoint, dist, parallelOverlapCm, pointInPolygon, polygonArea, segmentCrossesInterior, segmentsCross, type Segment } from "./geometry.ts";
import { matchRoomsByContour, roomHeirs, roomPolygonOf, type FinishMode } from "./finish.ts";
import { roomsMapOf } from "./room-geo.ts";

// Надёжность save по комнатам (этап 126, урок ревью 46): прежняя сверка ловила только
// полное исчезновение комнат (N→0). Частичная потеря N→M>0 и потеря пользовательских
// полей комнат проходили с verified=true (fixture editor-corridor-3rooms, mock server
// удаляет одну комнату → verified=true, warnings=[]).
//
// Пользовательские поля комнаты (по эталонам UI и модели редактора):
// - имя/тип помещения — rooms2[rid].zones[0].name (поле name самой комнаты остаётся
//   "none", docs/remplanner-features.md; проба 43-rooms-name-finish: UI пишет и name,
//   и zone_name зоны);
// - состав зон (имя + is_micro_zone у каждой) — микрозоны пользовательские;
// - отделка (floors[0], ceilings[0], decors) — сверяется своим слоем finishCompare
//   (этап 94), здесь не дублируется.
// Производные (не сверяются): id комнаты и зон, area, pc, number_by_area, height
// (следует за высотами стен — покрыто сверкой осей и свойств стен), plan, edges/eds,
// polygon-дубли в floors/ceilings.
//
// Двухрежимная сверка (new-entity-section.md):
// - «normalize» (до записи, локальная модель против normalize): каждая комната
//   нормализованной модели объяснима — точное совпадение контура с теми же
//   пользовательскими полями, либо доказанная топологическая операция редактора
//   (split/merge по классификации площадей, эталоны ui-ref-finish-topo-*; имя при
//   split/merge — предупреждение, эталона наследования нет), всё остальное — потеря;
//   ревью 127 R1/R2: ожидание — база ДО пользовательской операции (модель с сервера /
//   после последнего успешного save); изменённые пользователем стены = разница стен
//   «база → после операции», затронутые ими комнаты базы и новые замкнутые контуры
//   из изменённых стен — предупреждения (RoomsChangePolicy);
// - «save» (после записи, GET против нормализованной модели): строго — каждая комната
//   нормализованной модели (по каноническому контуру) есть на сервере с теми же
//   пользовательскими полями; лишние/пропавшие — расхождение.

type RoomRec = {
  polygon?: Point[];
  points?: Point[];
  name?: unknown;
  zones?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type RoomsMap = Record<string, RoomRec>;

function roomsOf(rooms: Record<string, unknown> | undefined): RoomsMap {
  return (rooms ?? {}) as RoomsMap;
}

/**
 * Пользовательские поля комнаты: имя помещения (zones[0].name) и состав зон
 * (имя + is_micro_zone, как мультимножество — порядок редактор вправе менять).
 */
export function roomUserSig(room: unknown): { name: string | null; zones: string[] } {
  const rec = (room ?? {}) as RoomRec;
  const zoneList = Array.isArray(rec.zones) ? rec.zones : [];
  const zones = zoneList
    .map((z) => JSON.stringify([String(z?.["name"] ?? ""), Boolean(z?.["is_micro_zone"])]))
    .sort();
  const name = typeof rec["name"] === "string" ? rec["name"] : null;
  return { name, zones };
}

function sigMismatch(exp: { name: string | null; zones: string[] }, got: { name: string | null; zones: string[] }): string | null {
  // имя: отсутствие поля/зон на ожидаемой стороне не блокирует (редактор вправе
  // достроить зону-классификатор), явное имя/состав обязаны сохраниться
  if (exp.name !== null && got.name !== exp.name) {
    return `имя помещения «${exp.name}» → «${got.name}»`;
  }
  if (exp.zones.length > 0 && JSON.stringify(exp.zones) !== JSON.stringify(got.zones)) {
    return `зоны (имя/микро) ${JSON.stringify(exp.zones)} → ${JSON.stringify(got.zones)}`;
  }
  return null;
}

export type RoomsSaveCompareResult = { problems: string[]; warnings: string[] };

// ---------- политика локальных изменений стен (этап 128, ревью 127 R1/R2/R4) ----------
//
// Сравнивать комнаты в normalize нужно с базой ДО пользовательской операции (модель,
// загруженная с сервера / после последнего успешного save), а не с локальной моделью
// после операции. Изменённые пользователем стены = разница стен «база → после
// операции». Затронутые комнаты = комнаты базы, контур которых пересекает/касается
// изменённых стен (с допуском), плюс новые замкнутые контуры из изменённых стен.

/** Изменённая пользователем стена: осевой отрезок (см) + толщина для допуска касания. */
export type ChangedWall = Segment & { depthCm: number };

type WallRef = { p1?: Point; p2?: Point; depth?: number };

const DEFAULT_DEPTH_CM = 20;

function pointSegmentDistance(p: Point, s: Segment): number {
  return dist(p, closestPoint(s, p).point);
}

/** Расстояние между отрезками (пересечение → 0). */
function segmentDistance(a: Segment, b: Segment): number {
  if (segmentsCross(a, b)) return 0;
  return Math.min(
    pointSegmentDistance(a.p1, b),
    pointSegmentDistance(a.p2, b),
    pointSegmentDistance(b.p1, a),
    pointSegmentDistance(b.p2, a),
  );
}

/** Расстояние от отрезка до контура комнаты (минимум по рёбрам). */
function segmentPolygonDistance(s: Segment, poly: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const edge: Segment = { p1: poly[i]!, p2: poly[(i + 1) % poly.length]! };
    const d = segmentDistance(s, edge);
    if (d < best) best = d;
    if (best <= 0) break;
  }
  return best;
}

/**
 * Полигон комнаты в см. Единицы контура восстанавливаются по полю area (м²):
 * у части серверных дампов polygon в мм (fixture anon-rect-4000x3000), у моделей
 * редактора — в см; сверять с осями стен (см) можно только в одних единицах.
 */
export function roomPolygonCm(room: unknown): Point[] | undefined {
  const poly = roomPolygonOf(room);
  if (!poly || poly.length < 3) return undefined;
  const area = (room as { area?: unknown })["area"];
  if (typeof area === "number" && area > 0.01) {
    const polyArea = polygonArea(poly);
    const scale = Math.sqrt(polyArea / (area * 10_000)); // единиц полигона на см
    if (Number.isFinite(scale) && scale >= 0.05 && scale <= 20 && Math.abs(scale - 1) > 0.05) {
      return poly.map((p) => ({ x: p.x / scale, y: p.y / scale }));
    }
  }
  return poly;
}

/**
 * Разница стен «база → после операции» (этап 128): канонические осевые отрезки
 * (группировка по прямой, слияние перекрывающихся пролётов), которых не было в базе
 * или которых нет после операции. Перенос стены даёт пару «старый + новый» отрезок;
 * растяжение соседней стены на 1 см — только узкий хвост у её конца, поэтому
 * затронутой считается лишь комната у самого хвоста, а не у всей стены.
 */
export function changedWallSegments(
  baseWalls: Record<string, WallRef> | undefined,
  nowWalls: Record<string, WallRef> | undefined,
): ChangedWall[] {
  type Line = { ux: number; uy: number; offset: number; depth: number; spans: Array<[number, number]> };
  const group = (walls: Record<string, WallRef> | undefined): Map<string, Line> => {
    const lines = new Map<string, Line>();
    for (const w of Object.values(walls ?? {})) {
      if (!w?.p1 || !w?.p2) continue;
      const dx = w.p2.x - w.p1.x;
      const dy = w.p2.y - w.p1.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      let ux = dx / len;
      let uy = dy / len;
      // каноническое направление прямой: угол в [0, π)
      if (uy < 0 || (uy === 0 && ux < 0)) {
        ux = -ux;
        uy = -uy;
      }
      const offset = -uy * w.p1.x + ux * w.p1.y;
      const key = `${Math.round(Math.atan2(uy, ux) * 1e6)}:${Math.round(offset * 20)}`;
      let line = lines.get(key);
      if (!line) {
        line = { ux, uy, offset, depth: typeof w.depth === "number" && w.depth > 0 ? w.depth : DEFAULT_DEPTH_CM, spans: [] };
        lines.set(key, line);
      }
      const t1 = w.p1.x * ux + w.p1.y * uy;
      const t2 = w.p2.x * ux + w.p2.y * uy;
      line.spans.push([Math.min(t1, t2), Math.max(t1, t2)]);
    }
    for (const line of lines.values()) {
      line.spans.sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      let cur = line.spans[0]!;
      for (let i = 1; i < line.spans.length; i++) {
        const s = line.spans[i]!;
        if (s[0] <= cur[1] + 0.05) {
          cur[1] = Math.max(cur[1], s[1]);
        } else {
          merged.push(cur);
          cur = s;
        }
      }
      merged.push(cur);
      line.spans = merged;
    }
    return lines;
  };
  /** Интервалы a минус интервалы b (расширенные на tol — шум float/квантования). */
  const subtract = (a: Array<[number, number]>, b: Array<[number, number]>, tol: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    const bs = [...b].sort((x, y) => x[0] - y[0]);
    for (const [s, e] of a) {
      let cur = s;
      for (const [xs, xe] of bs) {
        const lo = xs - tol;
        const hi = xe + tol;
        if (hi <= cur) continue;
        if (lo >= e) break;
        if (lo > cur) out.push([cur, Math.min(lo, e)]);
        cur = Math.max(cur, hi);
        if (cur >= e) break;
      }
      if (cur < e) out.push([cur, e]);
    }
    // хвосты короче 2 мм — шум квантования, не изменение
    return out.filter(([s, e]) => e - s > 0.2);
  };
  const pointOn = (l: Line, t: number): Point => ({ x: l.ux * t - l.uy * l.offset, y: l.uy * t + l.ux * l.offset });
  const base = group(baseWalls);
  const now = group(nowWalls);
  const changed: ChangedWall[] = [];
  for (const [key, line] of now) {
    const bl = base.get(key);
    for (const [a, b] of subtract(line.spans, bl?.spans ?? [], 0.2)) {
      changed.push({ p1: pointOn(line, a), p2: pointOn(line, b), depthCm: line.depth });
    }
  }
  for (const [key, line] of base) {
    const nl = now.get(key);
    for (const [a, b] of subtract(line.spans, nl?.spans ?? [], 0.2)) {
      changed.push({ p1: pointOn(line, a), p2: pointOn(line, b), depthCm: line.depth });
    }
  }
  return changed;
}

/** Допуск касания: грань комнаты лежит на грани стены — ось дальше на depth/2 (± 1 см). */
export function roomTouchesChangedWall(room: unknown, changed: ChangedWall[]): boolean {
  const poly = roomPolygonCm(room);
  if (!poly) return false;
  for (const w of changed) {
    const tol = w.depthCm / 2 + 1;
    if (segmentPolygonDistance(w, poly) <= tol) return true;
    // стена, оказавшаяся внутри контура (нестандартная геометрия), тоже затрагивает
    if (pointInPolygon(poly, w.p1, 1e-6) || pointInPolygon(poly, w.p2, 1e-6)) return true;
  }
  return false;
}

/**
 * id комнат базы, чей контур пересекает/касается изменённых стен (с допуском) —
 * их исчезновение при нормализации объясняется действием пользователя (ревью 127 R1).
 */
export function affectedRoomIds(
  baseRooms: Record<string, unknown> | undefined,
  changed: ChangedWall[],
): Set<string> {
  const out = new Set<string>();
  if (changed.length === 0) return out;
  for (const [rid, room] of Object.entries(baseRooms ?? {})) {
    if (roomTouchesChangedWall(room, changed)) out.add(rid);
  }
  return out;
}

/** Политика локальных изменений для сверки комнат в режиме normalize. */
export type RoomsChangePolicy = {
  /** Комнаты базы, затронутые изменёнными стенами: исчезновение — предупреждение. */
  affectedRoomIds?: Set<string>;
  /** Изменённые пользователем стены: новая комната, чей контур их касается, допустима. */
  changedWalls?: ChangedWall[];
};

/** Политика по базе комнат/стен и стенам после операции. */
export function roomsChangePolicy(
  baseRooms: Record<string, unknown> | undefined,
  baseWalls: Record<string, WallRef> | undefined,
  nowWalls: Record<string, WallRef> | undefined,
): RoomsChangePolicy {
  const changed = changedWallSegments(baseWalls, nowWalls);
  if (changed.length === 0) return {};
  return { changedWalls: changed, affectedRoomIds: affectedRoomIds(baseRooms, changed) };
}

/** Комнаты модели (rooms2 ?? rooms1) — общий слой сверов; сама функция в room-geo
 *  (листовом модуле, чтобы zone→rooms-save→finish→zone не замыкалась). */
/**
 * Затронутость комнат для сверки разделителей зон (ревью 263 N1, 265 R1) —
 * строже, чем affectedRoomIds (та рассчитана на исчезновение комнат при
 * нормализации и с допуском захвата соседа через общую стену). Изменённая
 * стена задана осью, контур комнаты редактора идёт по грани стены
 * (ось ± depth/2). Комната затронута, если:
 *  - её ребро параллельно изменённой стене, перекрывается с ней на ненулевой
 *    длине и лежит не дальше depth/2+1 см от оси (грань комнаты на грани
 *    стены: удаление/перенос стены контура, в т. ч. общей и наружной), или
 *  - отрезок оси проходит через внутренность контура (честное пересечение
 *    отрезка с полигоном, без выборки точек).
 * Т-примыкание конца новой стены к оси общей стены соседнюю комнату не
 * затрагивает: ребро соседа перпендикулярно новой стене (обычный wall_add при
 * split). undefined — стены не менялись.
 */
export function zoneAffectedRoomIds(
  model: Record<string, unknown> | undefined,
  policy: RoomsChangePolicy,
): Set<string> | undefined {
  const changed = policy.changedWalls;
  if (!changed || changed.length === 0) return undefined;
  const rooms = roomsMapOf(model) ?? {};
  const out = new Set<string>();
  for (const [rid, room] of Object.entries(rooms)) {
    const poly = roomPolygonCm(room);
    if (!poly) continue;
    const touches = changed.some((w) => {
      const maxDist = w.depthCm / 2 + 1;
      for (let i = 0; i < poly.length; i++) {
        if (parallelOverlapCm({ p1: poly[i]!, p2: poly[(i + 1) % poly.length]! }, w, maxDist) > 0.5) return true;
      }
      return segmentCrossesInterior(w, poly, 0.5);
    });
    if (touches) out.add(rid);
  }
  return out;
}

/**
 * Семантическая сверка комнат по каноническому контуру с пользовательскими полями.
 * mode="normalize" — до записи (допустимы только штатные топологии редактора),
 * mode="save" — после записи по GET (строго, без освобождений).
 * policy — локальные изменения пользователя (этап 128): в режиме normalize
 * исчезновение затронутой комнаты и появление новой комнаты из изменённых стен —
 * предупреждения, всё остальное — потеря. В режиме save политика не применяется.
 */
export function roomsSaveCompare(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
  mode: FinishMode,
  policy: RoomsChangePolicy = {},
): RoomsSaveCompareResult {
  const exp = roomsOf(expectedRooms);
  const got = roomsOf(gotRooms);
  const problems: string[] = [];
  const warnings: string[] = [];
  const { pairs: exact } = matchRoomsByContour(expectedRooms, gotRooms);
  const heirOf = roomHeirs(expectedRooms, gotRooms, exact, mode);
  const sameMatch = (rid: string): string | undefined => {
    const h = heirOf.get(rid);
    return h && h.kind === "same" ? h.key : undefined;
  };

  // каждая ожидаемая комната: найдена по контуру и хранит пользовательские поля
  for (const [rid, room] of Object.entries(exp)) {
    const gid = exact.get(rid) ?? sameMatch(rid);
    if (!gid) {
      const heir = heirOf.get(rid) ?? null;
      if (heir && (heir.kind === "split" || heir.kind === "merge")) {
        // штатная топология редактора (эталоны 98); наследование имени зон эталоном
        // не закреплено — предупреждение, а не блокировка
        warnings.push(`room_topology_changed: room ${rid}: ${heir.kind} при нормализации — имя помещения (${roomUserSig(room).name ?? "нет"}) не сверяется, проверьте rooms_list после сохранения`);
        continue;
      }
      // ревью 127 R1: комната, затронутая изменёнными пользователем стенами,
      // штатно исчезает при нормализации (размыкание контура) — предупреждение
      if (mode === "normalize" && policy.affectedRoomIds?.has(rid)) {
        warnings.push(`room_topology_changed: room ${rid}: комната исчезла после изменения стен пользователем — проверьте rooms_list после сохранения`);
        continue;
      }
      problems.push(`room ${rid}: комната исчезла или изменилась при ${mode === "save" ? "сохранении (сервер)" : "нормализации"}`);
      continue;
    }
    const mismatch = sigMismatch(roomUserSig(room), roomUserSig(got[gid]));
    if (mismatch) problems.push(`room ${rid}: ${mismatch}`);
  }

  // лишние комнаты: в режиме save — строго (сервер добавил/вернул лишнюю);
  // в режиме normalize новые комнаты объяснимы только доказанными топологиями
  const claimed = new Set<string>();
  for (const [rid] of Object.entries(exp)) {
    const gid = exact.get(rid) ?? sameMatch(rid);
    if (gid) { claimed.add(gid); continue; }
    const heir = heirOf.get(rid) ?? null;
    if (heir?.kind === "split") for (const k of heir.partKeys) claimed.add(k);
    if (heir?.kind === "merge") claimed.add(heir.key);
  }
  for (const [gk, gRoom] of Object.entries(got)) {
    if (claimed.has(gk)) continue;
    if (mode === "save") {
      problems.push(`room ${gk}: лишняя комната на сервере`);
      continue;
    }
    // ревью 127 R2: новая комната, образованная изменёнными пользователем стенами
    // (первая комната, новая отдельная, замыкание контура), — допустима
    if (policy.changedWalls && roomTouchesChangedWall(gRoom, policy.changedWalls)) {
      warnings.push(`room_new_from_walls: room ${gk}: новая комната из изменённых пользователем стен — проверьте rooms_list после сохранения`);
      continue;
    }
    problems.push(`room ${gk}: лишняя комната при нормализации`);
  }
  return { problems, warnings };
}

/** Список расхождений комнат (режим normalize, до записи): пусто — совпало. */
export function roomsNormalizeMismatches(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
): string[] {
  return roomsSaveCompare(expectedRooms, gotRooms, "normalize").problems;
}

/** Список расхождений комнат после save (GET против нормализованной модели). */
export function roomsSaveMismatches(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
): string[] {
  return roomsSaveCompare(expectedRooms, gotRooms, "save").problems;
}

// re-export для workspace/тестов: полигон комнаты записи
export { roomPolygonOf };
