import type { Point } from "../model/types.ts";
import { dist } from "../model/geometry.ts";
import {
  roomsMapOf,
  roomPolygonOf,
  matchRoomsByContour,
  roomHeirs,
  pointInPolygon,
  overlapShare,
} from "../model/room-geo.ts";
import type { VerificationMismatches } from "./types.ts";

/**
 * Сверка тёплых стен (этап 273) по образцу zoneDelimiterCompare: части хранятся
 * в rooms2[rid].warms_walls[edge].parts, id частей и рёбра редактор пересоздаёт
 * при пересчёте комнат (миграция id_old) — сопоставление по каноническому
 * контуру комнаты и геометрии линии, не по id. Сторона «внутрь» и привязка к
 * ребру не сверяются отдельно: line однозначно задаёт положение на демолинии
 * ребра. cable (ссылка на кабель) — значимое поле: пропажа/смена — потеря.
 */
export type WarmWallSig = {
  key: string;
  idRoom: string;
  edge: number;
  p1: Point;
  p2: Point;
  height: number;
  hff: number;
  type: string;
  /** Слой части (ревью 274 №5). */
  layer: number;
  /** props.name (форма ссылки части). */
  propsName: string;
  /** Наличие props.id (редактор пишет всегда). */
  hasPropsId: boolean;
  /** Флаг группы ребра exist (группа с частью обязана быть exist:true). */
  exist: boolean;
  cableId: string | null;
};

export function warmWallSigsOf(model: Record<string, unknown> | undefined): WarmWallSig[] {
  const out: WarmWallSig[] = [];
  const rooms = (roomsMapOf(model) ?? {}) as Record<string, Record<string, unknown>>;
  for (const [rid, room] of Object.entries(rooms)) {
    const ww = room.warms_walls;
    if (!Array.isArray(ww)) continue;
    for (let e = 0; e < ww.length; e++) {
      const parts = (ww[e] as { parts?: Record<string, Record<string, unknown>> } | null)?.parts;
      if (!parts || typeof parts !== "object") continue;
      for (const part of Object.values(parts)) {
        if (!part || typeof part !== "object" || typeof part.id !== "string") continue;
        const line = part.line as { p1?: Point; p2?: Point } | undefined;
        if (!line?.p1 || !line?.p2) continue;
        const cableId = (part.props as { cables_warm_floor?: { cable_warm_floor_id?: unknown } } | undefined)
          ?.cables_warm_floor?.cable_warm_floor_id;
        const props = part.props as Record<string, unknown> | undefined;
        out.push({
          key: String(part.id),
          idRoom: rid,
          edge: e,
          p1: line.p1,
          p2: line.p2,
          height: Number(part.height ?? 0),
          hff: Number(part.height_from_floor ?? 0),
          type: String(part.type ?? ""),
          layer: Number(part.layer ?? 1),
          propsName: typeof props?.name === "string" ? props.name : "",
          hasPropsId: typeof props?.id === "string" && props.id !== "",
          exist: (ww[e] as { exist?: unknown } | null)?.exist === true,
          cableId: typeof cableId === "string" && cableId !== "" ? cableId : "",
        });
      }
    }
  }
  return out;
}

export type WarmWallCompareMode = "normalize" | "save";

export type WarmWallCompareOpts = {
  /** Комнаты ожидания, затронутые изменёнными стенами (zoneAffectedRoomIds —
   *  по грани стены, не по оси). В normalize их части редактор вправе
   *  переопределить при пересчёте комнат — нестрогая сверка (предупреждение);
   *  в save строго (ревью 263 N2 по аналогии). */
  affectedRooms?: Set<string>;
};

const TOL = 0.5; // см — допуск вершин линии

/**
 * Сверка тёплых стен. Совпадающая комната — строгая сверка (геометрия линии,
 * высоты, ссылка на кабель). Смена топологии (split/merge) в normalize: часть,
 * пережившая пересчёт по геометрии, — норма; пропажа — проблема. Комната,
 * затронутая изменёнными стенами: в normalize пропажа/переопределение —
 * предупреждение с подсказкой; в save — строго. Сервер не имеет права терять
 * часть незатронутой комнаты.
 */
export function warmWallsCompare(
  expectedModel: Record<string, unknown> | undefined,
  gotModel: Record<string, unknown> | undefined,
  mode: WarmWallCompareMode = "normalize",
  opts: { affectedRooms?: Set<string> } = {},
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const exp = warmWallSigsOf(expectedModel);
  const got = warmWallSigsOf(gotModel);
  const expectedRooms = roomsMapOf(expectedModel);
  const gotRooms = roomsMapOf(gotModel);
  const { pairs: exact } = matchRoomsByContour(expectedRooms, gotRooms);
  const heirOf = roomHeirs(expectedRooms, gotRooms, exact, mode);
  const gotByRoom = new Map<string, WarmWallSig[]>();
  for (const g of got) {
    const list = gotByRoom.get(g.idRoom) ?? [];
    list.push(g);
    gotByRoom.set(g.idRoom, list);
  }
  const polygonOf = (key: string): Point[] | undefined => roomPolygonOf((gotRooms ?? {})[key]);
  const sameOf = (rid: string): string | undefined => {
    const h = heirOf.get(rid);
    return h && h.kind === "same" ? h.key : undefined;
  };
  const midpoint = (e: WarmWallSig): Point => ({ x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 });
  const used = new Set<string>();
  for (const e of exp) {
    const gid = exact.get(e.idRoom) ?? sameOf(e.idRoom);
    const strictList = (gid ? gotByRoom.get(gid) : undefined) ?? [];
    const found = strictList.filter((g) => !used.has(g.key)).find((g) => sameSigStrict(e, g));
    if (found) {
      used.add(found.key);
      // комната совпадает контуром (exact или heir «same»): сверяем и проекцию
      // привязки — ребро и флаг exist группы (ревью 274 №5)
      if (gid !== undefined && (exact.get(e.idRoom) === gid || sameOf(e.idRoom) === gid)) {
        if (e.edge !== found.edge) {
          problems.push(`room ${e.idRoom}: тёплая стена ${e.key} перенесена на другое ребро (${e.edge} → ${found.edge})`);
        }
        if (e.exist !== found.exist) {
          problems.push(`room ${e.idRoom}: у группы ребра ${found.edge} тёплой стены ${e.key} флаг exist ${e.exist} → ${found.exist}`);
        }
      }
      continue;
    }
    const affected = opts.affectedRooms?.has(e.idRoom) ?? false;
    if (affected && mode === "normalize") {
      // комната изменена стенами: редактор вправе переопределить/потерять часть
      // при пересчёте комнат (миграция id_old) — предупреждение с подсказкой
      const pool = intersectingPool(e, got, expectedRooms, gotRooms, gotByRoom).filter((g) => !used.has(g.key));
      const same = pool.find((g) => sameSigStrict(e, g));
      if (same) {
        used.add(same.key);
        continue;
      }
      const geom = pool.find((g) => e.type === g.type && sameLine(e, g));
      if (geom) {
        used.add(geom.key);
        warnings.push(`warmwall_topology_changed: room ${e.idRoom}: редактор изменил тёплую стену ${e.key} при изменении стен (высоты ${e.height}/${e.hff} → ${geom.height}/${geom.hff}${e.cableId !== geom.cableId ? `, ссылка на кабель ${e.cableId || "—"} → ${geom.cableId || "—"}` : ""}) — проверьте тёплые стены комнаты`);
        continue;
      }
      warnings.push(`warmwall_topology_changed: room ${e.idRoom}: комната изменена стенами, редактор не сохранил тёплую стену ${e.key} (${e.type}, ${Math.round(segLenCm(e) * 10)} см) — при переносе или удалении стен сначала удалите тёплые стены (warm_wall_delete)`);
      continue;
    }
    const near = strictList.filter((g) => !used.has(g.key)).find((g) => sameLine(e, g));
    if (near) {
      problems.push(`room ${e.idRoom}: тёплая стена ${e.key} изменилась на сервере (${JSON.stringify({ type: e.type, height: e.height, hff: e.hff, cable: e.cableId })} → ${JSON.stringify({ type: near.type, height: near.height, hff: near.hff, cable: near.cableId })})`);
      used.add(near.key);
      continue;
    }
    const heir = heirOf.get(e.idRoom) ?? null;
    if (!heir) {
      problems.push(`room ${e.idRoom}: потеряна тёплая стена ${e.key} (${e.type}, ${Math.round(segLenCm(e) * 10)} см)`);
      continue;
    }
    const mid = midpoint(e);
    const targetKeys = heir.kind === "split" ? heir.partKeys : [heir.key];
    const inTargets = targetKeys.filter((k) => pointInPolygon(mid, polygonOf(k) ?? [], 5.5));
    const heirFound = inTargets
      .flatMap((k) => gotByRoom.get(k) ?? [])
      .filter((g) => !used.has(g.key))
      .find((g) => sameSigStrict(e, g));
    if (heirFound) {
      used.add(heirFound.key);
      continue;
    }
    problems.push(`room ${e.idRoom}: потеряна тёплая стена ${e.key} (${e.type}, ${Math.round(segLenCm(e) * 10)} см) при ${heir.kind === "split" ? "split" : "merge"}`);
  }
  if (mode === "save") {
    for (const g of got) {
      if (!used.has(g.key)) problems.push(`room ${g.idRoom}: неожиданная тёплая стена ${g.key} на сервере (${g.type}, ${Math.round(segLenCm(g) * 10)} см)`);
    }
  }
  return { problems, warnings };
}

function segLenCm(e: WarmWallSig): number {
  return dist(e.p1, e.p2);
}

function sameLine(e: WarmWallSig, g: WarmWallSig): boolean {
  return (
    (dist(e.p1, g.p1) <= TOL && dist(e.p2, g.p2) <= TOL) ||
    (dist(e.p1, g.p2) <= TOL && dist(e.p2, g.p1) <= TOL)
  );
}

function sameSigStrict(e: WarmWallSig, g: WarmWallSig): boolean {
  return (
    e.type === g.type
    && sameLine(e, g)
    && e.height === g.height
    && e.hff === g.hff
    && e.cableId === g.cableId
    // полная проекция части (ревью 274 №5): layer, props.name, props.id
    && e.layer === g.layer
    && e.propsName === g.propsName
    && e.hasPropsId === g.hasPropsId
  );
}

function intersectingPool(
  e: WarmWallSig,
  got: WarmWallSig[],
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
  gotByRoom: Map<string, WarmWallSig[]>,
): WarmWallSig[] {
  const expPoly = roomPolygonOf((expectedRooms ?? {})[e.idRoom]);
  if (!expPoly) return [...gotByRoom.values()].flat();
  const intersectingRooms = new Set(
    Object.entries(gotRooms ?? {})
      .filter(([, r]) => {
        const gp = roomPolygonOf(r);
        return !gp || overlapShare(expPoly, gp) > 0 || overlapShare(gp, expPoly) > 0;
      })
      .map(([k]) => k),
  );
  return got.filter((g) => intersectingRooms.has(g.idRoom));
}
