import type { Model, Point, ElecCable } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, cmToMm } from "./units.ts";
import { McpError } from "../errors.ts";
import { edgeInwardNormal } from "./rooms.ts";
import { collinearOverlapCm } from "./geometry.ts";
import { roomPolygonOf, roomsMapOf } from "./room-geo.ts";

/**
 * Тёплая стена (лист «Тёплые полы», инструмент warm_wall_cable; этап 273,
 * 2026-11-20). Хранится редактором per-room в rooms2[rid].warms_walls — массив
 * по рёбрам контура комнаты (индекс = индекс ребра в edges), запись ребра
 * {exist: boolean, parts?: {id: WarmLine}}. Часть (класс WarmLine extends
 * DecorLineBase, бандл app.3.0; живые пробы 273-recon2/273-recon3, эталоны
 * ui-ref-warmwall-line/wire):
 *   {id, type: "warm_wall_cable", layer: 1, line: {p1,p2}, line_wall: {p1,p2},
 *    distance (производная длина для размерной подписи), height (см, умолчание 135),
 *    height_from_floor (см, умолчание 15), props {id, name: "warm_wall_cable",
 *    cables_warm_floor?: {cable_warm_floor_id}}}
 * Линия лежит на демолинии ребра: ребро контура комнаты, смещённое на 5 см внутрь
 * комнаты (buildDemolines → pointNearLineEnd(…,5,…); сторона «внутрь» по room_side,
 * в MCP — по ориентации контура, общий предикат edgeInwardNormal). line_wall —
 * демолиния ребра (в UI — после подрезки на пересечениях соседних демолиний; MCP
 * пишет демолинию целиком, подрезка не воспроизводится — на restore редактор
 * хранит line_wall как записано). Кабель терморегулятора: вершина
 * {id: id части, point: центр линии (LIB.lineCenter), type: "warm_wall"},
 * обратная ссылка — props части cables_warm_floor.cable_warm_floor_id (СКАЛЯР —
 * у тёплой стены одно подключение, l10n cabling_warm_floor_not_connect_same_wall).
 * pp вершины {i, d} — производное протяжки, MCP не пишет (как у контуров, 268).
 * При пересчёте комнат редактор мигрирует части с id_old и переписывает id вершин
 * кабеля (restore_old_id_for_decors) — сверка частей по геометрии, не по id.
 */

export type WarmWallPart = {
  id: string;
  type: string;
  layer: number;
  line: { p1: Point; p2: Point };
  line_wall: { p1: Point; p2: Point };
  /** Производная длина для размерной подписи (длина линии + 5 за открытый конец). */
  distance?: number;
  /** Высота от пола до верха, см (умолчание 135). */
  height: number;
  /** Отступ нижней кромки от пола, см (умолчание 15). */
  height_from_floor: number;
  props: { id: string; name: string; cables_warm_floor?: { cable_warm_floor_id?: string }; [k: string]: unknown };
  [key: string]: unknown;
};

type RoomRec = Record<string, unknown>;

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Комнаты модели (rooms2 ?? rooms1). */
function roomsOf(model: Model): Record<string, RoomRec> {
  return roomsMapOf(model as unknown as Record<string, unknown>) as Record<string, RoomRec> ?? {};
}

function roomByRef(model: Model, ref: string): { id: string; room: RoomRec } {
  const rooms = roomsOf(model);
  if (rooms[ref]) return { id: ref, room: rooms[ref]! };
  const m = /^R(\d+)$/.exec(ref);
  if (m) {
    const found = Object.entries(rooms)[Number(m[1]) - 1];
    if (found) return { id: found[0], room: found[1] as RoomRec };
  }
  throw new McpError("NOT_FOUND", `комната ${ref} не найдена`);
}

export type WarmWallEntry = { roomId: string; edge: number; part: WarmWallPart };

/** Рёбра комнаты: edges записи (как в редакторе) или производные из полигона. */
function roomEdges(room: RoomRec): Array<{ p1: Point; p2: Point }> {
  const edges = room.edges as Array<{ p1?: Point; p2?: Point }> | undefined;
  if (Array.isArray(edges)) {
    const out = edges.filter((e) => e && e.p1 && e.p2) as Array<{ p1: Point; p2: Point }>;
    if (out.length > 0) return out;
  }
  const poly = roomPolygonOf(room) ?? [];
  const out: Array<{ p1: Point; p2: Point }> = [];
  for (let i = 0; i < poly.length; i++) out.push({ p1: poly[i]!, p2: poly[(i + 1) % poly.length]! });
  return out;
}

function warmsWallsOfRoom(room: RoomRec): Array<Record<string, unknown>> {
  const ww = room.warms_walls;
  return Array.isArray(ww) ? (ww as Array<Record<string, unknown>>) : [];
}

/** Все части тёплых стен модели (для list/сверок/каскадов). */
export function warmWallEntries(model: Model): WarmWallEntry[] {
  const out: WarmWallEntry[] = [];
  for (const [rid, room] of Object.entries(roomsOf(model))) {
    const ww = warmsWallsOfRoom(room);
    for (let e = 0; e < ww.length; e++) {
      const parts = ww[e]?.parts as Record<string, WarmWallPart> | undefined;
      if (!parts || typeof parts !== "object") continue;
      for (const part of Object.values(parts)) {
        if (part && typeof part === "object" && part.id) out.push({ roomId: rid, edge: e, part });
      }
    }
  }
  return out;
}

function partById(model: Model, ref: string): WarmWallEntry {
  const entries = warmWallEntries(model);
  const byId = entries.find((e) => e.part.id === ref);
  if (byId) return byId;
  const m = /^WW(\d+)$/.exec(ref);
  if (m) {
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < entries.length) return entries[idx]!;
  }
  throw new McpError("NOT_FOUND", `тёплая стена ${ref} не найдена (warm_wall_list)`);
}

/** Ссылка части на кабель (props.cables_warm_floor.cable_warm_floor_id, скаляр). */
export function warmWallCableOf(part: WarmWallPart): string | undefined {
  const v = part.props?.cables_warm_floor?.cable_warm_floor_id;
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function elecCablesReferencingWarmWall(model: Model, partId: string): ElecCable[] {
  const out: ElecCable[] = [];
  for (const cable of Object.values(model.cables_warm_floor ?? {})) {
    if (cable.vertexes?.some((v) => v.type === "warm_wall" && v.id === partId)) out.push(cable);
  }
  return out;
}

/** Демолиния ребра: ребро, смещённое на 5 см внутрь комнаты (buildDemolines). */
function demolineOf(edge: { p1: Point; p2: Point }, poly: Point[]): { p1: Point; p2: Point } | null {
  const nl = edgeInwardNormal(edge.p1, edge.p2, poly);
  if (!nl) return null;
  const off = (p: Point): Point => ({ x: r2(p.x + nl.x * 5), y: r2(p.y + nl.y * 5) });
  return { p1: off(edge.p1), p2: off(edge.p2) };
}

/** Конец линии на конце демолинии (для длины и бонуса размера, get_distance).
 *  Демолиния редактора подрезается на пересечениях с соседними демолиниями —
 *  подрезанный конец лежит в 5 см от конца ребра. Совпадение с концом ребра
 *  (0) или с подрезанным концом (5 см) — открытый конец демолинии. */
function openEnds(line: { p1: Point; p2: Point }, lineWall: { p1: Point; p2: Point }): number {
  const at = (p: Point): number => {
    const d1 = dist(p, lineWall.p1), d2 = dist(p, lineWall.p2);
    const near = (d: number) => d <= 0.05 || Math.abs(d - 5) <= 0.05;
    return (near(d1) ? 1 : 0) + (near(d2) ? 1 : 0);
  };
  return at(line.p1) + at(line.p2);
}

/** Производная размерная подпись: длина линии + 5 за каждый открытый конец демолинии. */
export function warmWallDistance(line: { p1: Point; p2: Point }, lineWall: { p1: Point; p2: Point }): number {
  return r1(dist(line.p1, line.p2) + 5 * openEnds(line, lineWall));
}

export type WarmWallAddParams = {
  roomRef: string;
  /** Индекс ребра комнаты (0-based, как в edges записи rooms2 / warms_walls). */
  edge: number;
  /** Начало участка по ребру от его первой вершины, мм. */
  startMm: number;
  /** Конец участка по ребру, мм. */
  endMm: number;
  /** Высота от пола до верха, мм (умолчание 1350). */
  heightMm?: number;
  /** Отступ нижней кромки от пола, мм (умолчание 150). */
  heightFromFloorMm?: number;
};

/**
 * warm_wall_add: участок тёплой стены на ребре комнаты (как редактор — per-edge;
 * сторона «внутрь» по ориентации контура, общий предикат). start/end задаются
 * вдоль ребра от его первой вершины (мм) и проецируются на демолинию (ребро +
 * 5 см внутрь). Правила редактора: длина участка ≥ 20 см (get_distance, с
 * бонусом +5 см за конец на конце ребра — как в редакторе); пересечение или
 * наложение на существующую часть того же ребра — отказ (в редакторе при
 * следующем рисовании части сливаются — MCP строже редактора, стык вплотную
 * допустим). Атомарно: при отказе rooms2 не меняется.
 */
export function warmWallAdd(model: Model, params: WarmWallAddParams): { id: string; edge: number; room_id: string; length_mm: number } {
  const { id: roomId, room } = roomByRef(model, params.roomRef);
  const poly = roomPolygonOf(room) ?? [];
  if (poly.length < 3) throw new McpError("INVALID_ARGUMENT", `у комнаты ${params.roomRef} нет контура`);
  const edges = roomEdges(room);
  if (!Number.isInteger(params.edge) || params.edge < 0 || params.edge >= edges.length) {
    throw new McpError("INVALID_ARGUMENT", `edge ${String(params.edge)}: индекс вне диапазона 0..${edges.length - 1} (у комнаты ${edges.length} рёбер)`);
  }
  if (!Number.isFinite(params.startMm) || !Number.isFinite(params.endMm)) {
    throw new McpError("INVALID_ARGUMENT", "start_mm/end_mm должны быть конечными числами");
  }
  const heightCm = params.heightMm === undefined ? 135 : mmToCm(params.heightMm);
  const hffCm = params.heightFromFloorMm === undefined ? 15 : mmToCm(params.heightFromFloorMm);
  for (const [v, label] of [[heightCm, "height_mm"], [hffCm, "height_from_floor_mm"]] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 500) {
      throw new McpError("INVALID_ARGUMENT", `${label}: допустимо 0..5000 мм (умолчания редактора: 1350 и 150)`);
    }
  }
  const edge = edges[params.edge]!;
  const edgeLen = dist(edge.p1, edge.p2);
  let s = mmToCm(params.startMm);
  let t = mmToCm(params.endMm);
  if (s > t) [s, t] = [t, s];
  if (s < -0.05 || t > edgeLen + 0.05) {
    throw new McpError("INVALID_ARGUMENT", `участок ${Math.round(s * 10)}..${Math.round(t * 10)} см выходит за ребро длиной ${r1(edgeLen * 10)} мм (start_mm/end_mm — от первой вершины ребра)`);
  }
  const dl = demolineOf(edge, poly);
  if (!dl) throw new McpError("INVALID_ARGUMENT", "не удалось определить сторону «внутрь» ребра (вырожденный контур)");
  const dir = { x: (edge.p2.x - edge.p1.x) / edgeLen, y: (edge.p2.y - edge.p1.y) / edgeLen };
  const clamp = (v: number) => Math.min(Math.max(v, 0), edgeLen);
  const line = { p1: { x: r2(dl.p1.x + dir.x * clamp(s)), y: r2(dl.p1.y + dir.y * clamp(s)) }, p2: { x: r2(dl.p1.x + dir.x * clamp(t)), y: r2(dl.p1.y + dir.y * clamp(t)) } };
  // длина как в редакторе: create_line требует get_distance >= 20 (длина + 5 за
  // конец на конце демолинии); сравнение на концах ребра — по демолинии
  const ends = openEnds(line, dl);
  const rawLen = dist(line.p1, line.p2);
  if (rawLen + 5 * ends < 20) {
    throw new McpError("INVALID_ARGUMENT", `длина участка ${Math.round(rawLen * 10)} мм короче минимальной редактора 200 мм`);
  }
  const ww = warmsWallsOfRoom(room);
  while (ww.length < edges.length) ww.push({ exist: false });
  const group = ww[params.edge]!;
  const parts = (group.parts ?? {}) as Record<string, WarmWallPart>;
  for (const other of Object.values(parts)) {
    const ov = collinearOverlapCm(line, other.line);
    if (ov > 0.5) {
      throw new McpError("INVALID_ARGUMENT", `участок пересекает существующую тёплую стену ${other.id} на этом ребре (перекрытие ${r1(ov * 10)} мм) — сначала удалите её (warm_wall_delete)`);
    }
  }
  const id = newId();
  const part: WarmWallPart = {
    id,
    type: "warm_wall_cable",
    layer: 1,
    line,
    line_wall: { p1: dl.p1, p2: dl.p2 },
    distance: warmWallDistance(line, { p1: dl.p1, p2: dl.p2 }),
    height: r2(heightCm),
    height_from_floor: r2(hffCm),
    props: { id, name: "warm_wall_cable" },
  };
  const backup = structuredClone(room.warms_walls);
  try {
    parts[id] = part;
    group.parts = parts;
    group.exist = true;
    room.warms_walls = ww;
  } catch (e) {
    if (backup !== undefined) room.warms_walls = backup;
    throw e;
  }
  return { id, edge: params.edge, room_id: roomId, length_mm: cmToMm(r1(rawLen)) };
}

export type WarmWallUpdateParams = {
  warmWallId: string;
  startMm?: number;
  endMm?: number;
  heightMm?: number;
  heightFromFloorMm?: number;
};

/**
 * warm_wall_update: границы участка по тому же ребру и/или высоты. Перенос на
 * другое ребро не поддерживается (как в редакторе — часть привязана к ребру);
 * участок не должен пересекать соседние части ребра. При изменении границ
 * вершина подключённого кабеля пересчитывается (центр линии), длина кабеля —
 * по рёбрам. Атомарно.
 */
export function warmWallUpdate(model: Model, params: WarmWallUpdateParams): { id: string; length_mm: number } {
  const entry = partById(model, params.warmWallId);
  const room = roomsOf(model)[entry.roomId]!;
  const poly = roomPolygonOf(room) ?? [];
  const edges = roomEdges(room);
  const edge = edges[entry.edge];
  const dl = edge ? demolineOf(edge, poly) : null;
  const heightCm = params.heightMm === undefined ? undefined : mmToCm(params.heightMm);
  const hffCm = params.heightFromFloorMm === undefined ? undefined : mmToCm(params.heightFromFloorMm);
  for (const [v, label] of [[heightCm, "height_mm"], [hffCm, "height_from_floor_mm"]] as const) {
    if (v !== undefined && (!Number.isFinite(v) || v < 0 || v > 500)) {
      throw new McpError("INVALID_ARGUMENT", `${label}: допустимо 0..5000 мм`);
    }
  }
  const backupWW = structuredClone(room.warms_walls);
  const backupCables = structuredClone(model.cables_warm_floor);
  try {
    if (params.startMm !== undefined || params.endMm !== undefined) {
      if (!edge || !dl) throw new McpError("INVALID_ARGUMENT", `у части ${entry.part.id} нет ребра привязки`);
      const edgeLen = dist(edge.p1, edge.p2);
      let s = params.startMm === undefined ? undefined : mmToCm(params.startMm);
      let t = params.endMm === undefined ? undefined : mmToCm(params.endMm);
      // текущие границы в координатах ребра
      const dir = { x: (edge.p2.x - edge.p1.x) / edgeLen, y: (edge.p2.y - edge.p1.y) / edgeLen };
      const along = (p: Point) => (p.x - edge.p1.x) * dir.x + (p.y - edge.p1.y) * dir.y;
      if (s === undefined) s = along(entry.part.line.p1);
      if (t === undefined) t = along(entry.part.line.p2);
      if (s > t) [s, t] = [t, s];
      if (s < -0.05 || t > edgeLen + 0.05) {
        throw new McpError("INVALID_ARGUMENT", `участок выходит за ребро длиной ${r1(edgeLen * 10)} мм`);
      }
      const line = { p1: { x: r2(dl.p1.x + dir.x * clamp01(s, edgeLen)), y: r2(dl.p1.y + dir.y * clamp01(s, edgeLen)) }, p2: { x: r2(dl.p1.x + dir.x * clamp01(t, edgeLen)), y: r2(dl.p1.y + dir.y * clamp01(t, edgeLen)) } };
      const ends = openEnds(line, dl);
      const rawLen = dist(line.p1, line.p2);
      if (rawLen + 5 * ends < 20) {
        throw new McpError("INVALID_ARGUMENT", `длина участка ${Math.round(rawLen * 10)} мм короче минимальной редактора 200 мм`);
      }
      for (const other of Object.values((warmsWallsOfRoom(room)[entry.edge]?.parts ?? {}) as Record<string, WarmWallPart>)) {
        if (other.id === entry.part.id) continue;
        const ov = collinearOverlapCm(line, other.line);
        if (ov > 0.5) {
          throw new McpError("INVALID_ARGUMENT", `участок пересекает тёплую стену ${other.id} на этом ребре (перекрытие ${r1(ov * 10)} мм)`);
        }
      }
      entry.part.line = line;
      entry.part.distance = warmWallDistance(line, { p1: dl.p1, p2: dl.p2 });
    }
    if (heightCm !== undefined) entry.part.height = r2(heightCm);
    if (hffCm !== undefined) entry.part.height_from_floor = r2(hffCm);
    // вершина подключённого кабеля следует за центром линии (get_point редактора)
    if (params.startMm !== undefined || params.endMm !== undefined) {
      const center = { x: r2((entry.part.line.p1.x + entry.part.line.p2.x) / 2), y: r2((entry.part.line.p1.y + entry.part.line.p2.y) / 2) };
      for (const cable of Object.values(model.cables_warm_floor ?? {})) {
        let changed = false;
        for (const v of cable.vertexes) {
          if (v.type === "warm_wall" && v.id === entry.part.id) {
            v.point = center;
            changed = true;
          }
        }
        if (changed) cable.length = elecLengthM(cable);
      }
    }
  } catch (e) {
    if (backupWW !== undefined) room.warms_walls = backupWW;
    if (backupCables !== undefined) model.cables_warm_floor = backupCables;
    else delete model.cables_warm_floor;
    throw e;
  }
  return { id: entry.part.id, length_mm: cmToMm(r1(dist(entry.part.line.p1, entry.part.line.p2))) };
}

function clamp01(v: number, edgeLen: number): number {
  return Math.min(Math.max(v, 0), edgeLen);
}

/** Длина кабеля по рёбрам, м (2 знака) — та же формула, что у проводки. */
function elecLengthM(cable: ElecCable): number {
  let sum = 0;
  for (let i = 0; i + 1 < cable.vertexes.length; i++) {
    if ((cable.matrix[i]?.[i + 1] ?? null) !== null) sum += dist(cable.vertexes[i]!.point, cable.vertexes[i + 1]!.point);
  }
  return Math.round((sum / 100) * 100) / 100;
}

/**
 * warm_wall_delete: удалить участок. Подключённый кабель — отказ (в редакторе
 * кабель каскадно удаляется вместе с линией; MCP строже редактора — сначала
 * wiring_delete, чтобы удаление было осознанным).
 */
export function warmWallDelete(model: Model, warmWallId: string): { room_id: string; edge: number } {
  const entry = partById(model, warmWallId);
  const linked = elecCablesReferencingWarmWall(model, entry.part.id);
  if (linked.length > 0) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `тёплая стена ${entry.part.id} подключена кабелем ${linked.map((c) => c.id).join(", ")} — сначала удалите кабель (wiring_delete)`,
      { details: { kind: "wiring_referenced", wiring: linked.map((c) => c.id) } },
    );
  }
  const room = roomsOf(model)[entry.roomId]!;
  const backup = structuredClone(room.warms_walls);
  try {
    const group = warmsWallsOfRoom(room)[entry.edge]!;
    const parts = (group.parts ?? {}) as Record<string, WarmWallPart>;
    delete parts[entry.part.id];
    if (Object.keys(parts).length === 0) {
      delete group.parts;
      group.exist = false;
    } else {
      group.parts = parts;
    }
  } catch (e) {
    if (backup !== undefined) room.warms_walls = backup;
    throw e;
  }
  return { room_id: entry.roomId, edge: entry.edge };
}

/** Список тёплых стен (для меток WW<n> и выбора ребра). */
export function warmWallList(model: Model, roomRef?: string): Array<Record<string, unknown>> {
  const rooms = roomsOf(model);
  const filterRid = roomRef ? roomByRef(model, roomRef).id : undefined;
  return warmWallEntries(model)
    .filter((e) => filterRid === undefined || e.roomId === filterRid)
    .map((e, i) => ({
      label: `WW${i + 1}`,
      id: e.part.id,
      room_id: e.roomId,
      edge: e.edge,
      length_mm: cmToMm(r1(dist(e.part.line.p1, e.part.line.p2))),
      height_mm: cmToMm(e.part.height),
      height_from_floor_mm: cmToMm(e.part.height_from_floor),
      cable: warmWallCableOf(e.part) ?? null,
    }));
}

/**
 * Держатели обратных ссылок кабелей warm_floor_wire среди тёплых стен:
 * props части (name = "warm_wall_cable" — форма ссылки сверяется, скаляр).
 * Вызывается из elecLinkHolders (electric2.ts).
 */
export function warmWallLinkHolders(model: Model): Record<string, { name?: string } & Record<string, unknown>> {
  const out: Record<string, { name?: string } & Record<string, unknown>> = {};
  for (const e of warmWallEntries(model)) {
    out[e.part.id] = { ...(e.part.props ?? {}), name: "warm_wall_cable" };
  }
  return out;
}

/** Снять ссылку части на кабель (wiring_delete; часть остаётся). */
export function clearWarmWallCableLink(model: Model, cableId: string): void {
  for (const e of warmWallEntries(model)) {
    const props = e.part.props as Record<string, unknown> | undefined;
    const box = props?.cables_warm_floor as Record<string, unknown> | undefined;
    if (box && box.cable_warm_floor_id === cableId) {
      delete box.cable_warm_floor_id;
      if (Object.keys(box).length === 0 && props) delete props.cables_warm_floor;
    }
  }
}
