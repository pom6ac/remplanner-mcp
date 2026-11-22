import type { Model, Point, PrsFigureEntity } from "./types.ts";
export type { PrsFigureEntity };
import { newId } from "./types.ts";
import { McpError } from "../errors.ts";
import { resolveRoom, type RoomRec } from "./finish.ts";

/**
 * Развёртки (лист «Развёртки», режим «Стены») — этап 389.
 *
 * Настройки развёрток комнаты (бандл):
 *  - prs_hidden (0/1) — «Скрыть развёртки» в меню комнаты #cm-room2
 *    [container="prs_visibility"]: 1 → prs_disabled[oid]="" для ВСЕХ линий
 *    развёрток комнаты; 0 → prs_disabled={} (обработчик клика);
 *  - prs_disabled — карта {oid развёртки: ""} скрытых развёрток (знак на
 *    развёртке, #menu_projection_sign [container="visibility"]: скрыть —
 *    prs_disabled[poid]="" и prs_hidden=0; показать — delete prs_disabled[poid]);
 *  - prs_first — oid развёртки «Назначить первой» (#menu_projection_sign
 *    [container="set_first"]: prs_first=i.poid); 0/"" — «первая» вычисляется
 *    редактором (updateLines: 0==i.prs_first → prs_first=t[0].oid).
 * oid развёртки хранится в rooms2[rid].edges_prs[e].oid (createEdgesPrs:
 * {edge_index, p1, p2, oid, pillars}); при изменении нарезки рёбер редактор
 * перегенерирует oid и переносит prs_first/prs_disabled по геометрии
 * (restorePrsChangeEdges) — семантика ссылки «развёртка ребра комнаты», не oid.
 *
 * Молдинги/ниши развёрток — коллекции wall_moldings/wall_niches
 * (WallMolding/WallNiche extends WallFigure, serialize — см. PrsFigureEntity).
 * Создание (drag по развёртке): тип wall_molding; при высоте ≤ 10 см редактор
 * ставит type="wall_molding_slim" (линия толщиной width_line), при ширине
 * ≤ 10 см — "wall_molding_slim_h" (draw, бандл @1374528); запись с width<10
 * или height<10 (slim — только по одному измерению) удаляется (end_draw,
 * минимум 10 см). Ниша: пересечение с другой нишей той же развёртки запрещено
 * (checkIntersectionNiches/dragend), на стеклянных/реечных стенах и балконах
 * рисовать нельзя (start_draw: a_glass/c_glass/c_bar/balcony). Габариты
 * развёртки: длина линии ребра, высота params.total_height (Projections.
 * getPolygon); фигура целиком внутри развёртки (клик-создание: углы полигона
 * GetPolygonBySize должны лежать в развёртке, бандл @1060442).
 *
 * Рамка развёрток детерминирована (Projections.getPolygons): линии слева
 * направо в порядке edges_prs, первая линия каждого контура с зазором 20,
 * низ развёртки на y=30+total_height: polygon=[(x,30),(x+L,30),(x+L,30+H),
 * (x,30+H)]. pc фигуры = (x0 + along, 30 + H − fromBottom); prs.pc_xd/pc_yd —
 * смещение центра от xMin/yMin полигона развёртки (getParentProjection) —
 * семантические поля, редактор пересчитывает их при каждой перерисовке
 * развёрток, а pc (кэш рамки) может отставать — сверка save идёт по pc_xd/pc_yd.
 *
 * PRO: разметка анонимного проекта (эталон 328-pro-anon.json, класс is_pro):
 * wall_molding/wall_niche/wall_profile/anchor_decor НЕ помечены is_pro
 * (в PRO_EDITOR_KEYS отсутствуют; anchor_floor — PRO, точка укладки ПОЛА).
 * wall_profile — свободная линия freelines type="wall_profile" (класс FreeLine,
 * $FreeLining.tools), покрывается freeline_add.
 */

/** Зазор между контурами развёрток (needGap первой линии контура), см. */
export const PRS_GAP_CM = 20;
/** Смещение рамки развёрток от нуля по y (getPolygon: t=30). */
export const PRS_TOP_CM = 30;

export type PrsEdge = {
  edgeIndex: number;
  oid: string;
  p1: Point;
  p2: Point;
  /** Стена ребра (edges[edgeIndex].pid). */
  wallId?: string;
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Развёртки комнаты: rooms2[rid].edges_prs (fallback — рёбра комнаты). */
export function prsEdgesOf(room: RoomRec): PrsEdge[] {
  const edges = Array.isArray(room.edges) ? room.edges : [];
  const raw = Array.isArray(room["edges_prs"]) ? (room["edges_prs"] as Array<Record<string, unknown>>) : [];
  if (raw.length > 0) {
    const byIndex = new Map<number, Record<string, unknown>>();
    for (const e of raw) {
      const i = num(e["edge_index"]);
      if (i !== undefined) byIndex.set(i, e);
    }
    const out: PrsEdge[] = [];
    for (let i = 0; i < edges.length; i++) {
      const e = byIndex.get(i);
      const src = (e ?? edges[i]) as Record<string, unknown> | undefined;
      const p1e = src?.["p1"] as Point | undefined;
      const p2e = src?.["p2"] as Point | undefined;
      if (!p1e || !p2e) continue;
      out.push({
        edgeIndex: i,
        oid: typeof e?.["oid"] === "string" && e["oid"] !== "" ? e["oid"] : `derived_${i}`,
        p1: { x: p1e.x, y: p1e.y },
        p2: { x: p2e.x, y: p2e.y },
        wallId: edges[i]!.pid,
      });
    }
    return out;
  }
  return edges.map((e, i) => ({
    edgeIndex: i,
    oid: `derived_${i}`,
    p1: { x: e.p1?.x ?? 0, y: e.p1?.y ?? 0 },
    p2: { x: e.p2?.x ?? 0, y: e.p2?.y ?? 0 },
    wallId: e.pid,
  }));
}

/** Скрытые развёртки комнаты: набор edge_index (prs_disabled через oid). */
export function prsDisabledEdges(room: RoomRec): Set<number> {
  const disabled = room["prs_disabled"];
  if (!disabled || typeof disabled !== "object" || Array.isArray(disabled)) return new Set();
  const oids = new Set(Object.keys(disabled as Record<string, unknown>));
  const out = new Set<number>();
  for (const e of prsEdgesOf(room)) if (oids.has(e.oid)) out.add(e.edgeIndex);
  return out;
}

/** «Первая» развёртка комнаты: edge_index или null (prs_first 0/пусто — авто). */
export function prsFirstEdge(room: RoomRec): number | null {
  const first = room["prs_first"];
  if (typeof first !== "string" || first === "") return null;
  const e = prsEdgesOf(room).find((x) => x.oid === first);
  return e ? e.edgeIndex : null;
}

function edgeByWall(prsEdges: PrsEdge[], wallId: string): PrsEdge {
  const found = prsEdges.filter((e) => e.wallId === wallId);
  if (found.length === 0) {
    throw new McpError("INVALID_ARGUMENT", `у комнаты нет ребра со стеной ${wallId} (граничные стены — из model_get/finish_get)`);
  }
  if (found.length > 1) {
    throw new McpError("INVALID_ARGUMENT", `стена ${wallId} даёт несколько рёбер комнаты — укажите стену, у которой одна развёртка`);
  }
  return found[0]!;
}

export type PrsSettings = {
  /** Скрыть все развёртки комнаты (prs_hidden=1 + prs_disabled=все oid) / показать (0, {}). */
  hidden?: boolean;
  /** «Назначить первой» развёртку ребра стены; null — вернуть авто (prs_first=0). */
  firstWall?: string | null;
  /** Скрыть развёртку ребра стены (prs_disabled[oid]="", prs_hidden=0). */
  hideWalls?: string[];
  /** Показать развёртку ребра стены (delete prs_disabled[oid], prs_hidden=0). */
  showWalls?: string[];
};

export type PrsSettingsResult = {
  room: string;
  hidden: boolean;
  firstEdge: number | null;
  disabledEdges: number[];
};

/** Настройки развёрток комнаты (prs_hidden/prs_disabled/prs_first) — как в редакторе. */
export function setPrsSettings(model: Model, roomRef: string, params: PrsSettings): PrsSettingsResult {
  const { id, room } = resolveRoom(model, roomRef);
  const prsEdges = prsEdgesOf(room);
  if (prsEdges.length === 0) {
    throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomRef} нет рёбер — развёрток нет`);
  }
  const disabled = prsDisabledEdges(room);
  if (params.hidden !== undefined) {
    // #cm-room2 [container="prs_visibility"]: скрыть — prs_hidden=1 и ВСЕ oid
    // в prs_disabled; показать — prs_hidden=0 и prs_disabled={}
    room["prs_hidden"] = params.hidden ? 1 : 0;
    if (params.hidden) {
      const map: Record<string, string> = {};
      for (const e of prsEdges) map[e.oid] = "";
      room["prs_disabled"] = map;
      disabled.clear();
      for (const e of prsEdges) disabled.add(e.edgeIndex);
    } else {
      room["prs_disabled"] = {};
      disabled.clear();
    }
  }
  if (params.firstWall !== undefined) {
    if (params.firstWall === null) {
      // авто-режим: updateLines берёт первую линию (prs_first=0)
      room["prs_first"] = 0;
    } else {
      const e = edgeByWall(prsEdges, params.firstWall);
      // знак уже «первой»/скрытой не назначается первой (обработчик set_first)
      if (disabled.has(e.edgeIndex)) {
        throw new McpError("INVALID_ARGUMENT", `развёртка стены ${params.firstWall} скрыта — сначала покажите её (show_walls)`);
      }
      room["prs_first"] = e.oid;
    }
  }
  for (const [walls, hide] of [["hideWalls", true], ["showWalls", false]] as const) {
    const list = params[walls];
    if (!list) continue;
    for (const wallId of list) {
      const e = edgeByWall(prsEdges, wallId);
      const map = (room["prs_disabled"] ??= {}) as Record<string, unknown>;
      if (hide) {
        map[e.oid] = "";
        room["prs_hidden"] = 0;
        disabled.add(e.edgeIndex);
      } else {
        if (map && typeof map === "object" && !Array.isArray(map)) delete map[e.oid];
        room["prs_hidden"] = 0;
        disabled.delete(e.edgeIndex);
      }
    }
  }
  const first = prsFirstEdge(room);
  const hiddenNow = num(room["prs_hidden"]) === 1;
  return { room: id, hidden: hiddenNow, firstEdge: first, disabledEdges: [...disabled].sort((a, b) => a - b) };
}

/** Состояние развёрток комнаты для compact (prs_*). */
export function prsStateOf(room: RoomRec): { hidden: boolean; firstEdge: number | null; disabledEdges: number[] } {
  return {
    hidden: num(room["prs_hidden"]) === 1,
    firstEdge: prsFirstEdge(room),
    disabledEdges: [...prsDisabledEdges(room)].sort((a, b) => a - b),
  };
}

// ---------- молдинги и ниши развёрток ----------

const PROJECTION_PLAN = "projections";
/** Минимальный размер записи (end_draw бандла удаляет запись < 10 см). */
export const PRS_FIGURE_MIN_CM = 10;
/** Толщина линии молдинга по умолчанию (width_line, конструктор WallMolding). */
export const PRS_MOLDING_WIDTH_LINE_CM = 4;
/** Глубина ниши по умолчанию (конструктор WallNiche). */
export const PRS_NICHE_DEPTH_CM = 20;
/** Материалы стен, на которых нишу рисовать нельзя (start_draw). */
const NICHE_STOP_MATERIALS = new Set(["a_glass", "c_glass", "c_bar"]);

export type PrsFigureKind = "wall_molding" | "wall_niche";

export type PrsFigureParams = {
  room: string;
  /** Стена ребра развёртки (id сайта из model_get или W-форма). */
  wall: string;
  /** Центр фигуры от начала развёртки (линии ребра, от p1), мм. */
  alongMm: number;
  /** Центр фигуры от низа развёртки (от пола), мм. */
  bottomMm: number;
  /** Ширина фигуры, мм. */
  widthMm: number;
  /** Высота фигуры, мм. */
  heightMm: number;
  /** Глубина ниши (только wall_niche), мм; default 200. */
  depthMm?: number;
  /** Толщина линии молдинга, мм; default 40. */
  widthLineMm?: number;
};

export type PrsFigureResult = PrsFigureEntity & { kind: PrsFigureKind };

function collectionOf(model: Model, kind: PrsFigureKind): Record<string, PrsFigureEntity> {
  return (kind === "wall_molding" ? (model.wall_moldings ??= {}) : (model.wall_niches ??= {})) as Record<string, PrsFigureEntity>;
}

/** Развёртка ребра: рамка (x0, длина L), примыкающие материалы рёбер. */
function prsFrame(room: RoomRec, target: PrsEdge): { x0: number; lengthCm: number } {
  const prsEdges = prsEdgesOf(room);
  let x = 0;
  for (let i = 0; i < prsEdges.length; i++) {
    const e = prsEdges[i]!;
    const len = Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y);
    if (e.edgeIndex === target.edgeIndex) return { x0: x + (i === 0 ? PRS_GAP_CM : 0), lengthCm: r2(len) };
    x += len;
    // needGap первой линии контура (getLines: 0===e → d.needGap=1): зазор 20
    // перед первой развёрткой (Projections.getPolygons: needGap → x+=20)
    if (i === 0) x += PRS_GAP_CM;
  }
  throw new McpError("NOT_FOUND", `развёртка ребра ${target.edgeIndex} не найдена`);
}

function buildPrsFigure(model: Model, kind: PrsFigureKind, params: PrsFigureParams, id?: string): PrsFigureResult {
  if (kind === "wall_niche" && params.depthMm !== undefined && (!Number.isFinite(params.depthMm) || params.depthMm <= 0 || params.depthMm > 1000)) {
    throw new McpError("INVALID_ARGUMENT", "depth_mm — число от 0 до 1000");
  }
  if (params.widthLineMm !== undefined && (!Number.isFinite(params.widthLineMm) || params.widthLineMm <= 0 || params.widthLineMm > 1000)) {
    throw new McpError("INVALID_ARGUMENT", "width_line_mm — число от 0 до 1000");
  }
  for (const [key, v] of [["along_mm", params.alongMm], ["bottom_mm", params.bottomMm], ["width_mm", params.widthMm], ["height_mm", params.heightMm]] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 100000) {
      throw new McpError("INVALID_ARGUMENT", `${key} — число от 0 до 100000 мм`);
    }
  }
  const { id: roomId, room } = resolveRoom(model, params.room);
  const prsEdges = prsEdgesOf(room);
  if (prsEdges.length === 0) {
    throw new McpError("INVALID_ARGUMENT", `у комнаты ${params.room} нет рёбер — развёрток нет`);
  }
  const target = edgeByWall(prsEdges, params.wall);
  const frame = prsFrame(room, target);
  const widthCm = r2(params.widthMm / 10);
  const heightCm = r2(params.heightMm / 10);
  const alongCm = r2(params.alongMm / 10);
  const bottomCm = r2(params.bottomMm / 10);
  const H = num(model.total_height) ?? 270;
  // end_draw: запись < 10 см по значимому измерению удаляется (min 10)
  if (kind === "wall_niche") {
    if (widthCm < PRS_FIGURE_MIN_CM || heightCm < PRS_FIGURE_MIN_CM) {
      throw new McpError("INVALID_ARGUMENT", `ниша: width_mm и height_mm — не меньше ${PRS_FIGURE_MIN_CM * 10} мм (запись меньше редактор удаляет, end_draw)`);
    }
  } else if (heightCm <= PRS_FIGURE_MIN_CM) {
    // slim: вертикальная линия толщиной width_line, ширина ≥ 10
    if (widthCm < PRS_FIGURE_MIN_CM) {
      throw new McpError("INVALID_ARGUMENT", `молдинг: width_mm — не меньше ${PRS_FIGURE_MIN_CM * 10} мм (запись меньше редактор удаляет, end_draw)`);
    }
  } else if (widthCm <= PRS_FIGURE_MIN_CM) {
    // slim_h: горизонтальная линия толщиной width_line, высота ≥ 10
    if (heightCm < PRS_FIGURE_MIN_CM) {
      throw new McpError("INVALID_ARGUMENT", `молдинг: height_mm — не меньше ${PRS_FIGURE_MIN_CM * 10} мм (запись меньше редактор удаляет, end_draw)`);
    }
  } else if (widthCm < PRS_FIGURE_MIN_CM || heightCm < PRS_FIGURE_MIN_CM) {
    throw new McpError("INVALID_ARGUMENT", `молдинг: width_mm и height_mm — не меньше ${PRS_FIGURE_MIN_CM * 10} мм`);
  }
  // фигура целиком в развёртке (клик-создание бандла: все углы в развёртке) —
  // консервативно: центр с половинами внутри [0..L] × [0..H]
  if (alongCm - widthCm / 2 < -0.01 || alongCm + widthCm / 2 > frame.lengthCm + 0.01) {
    throw new McpError("INVALID_ARGUMENT", `фигура выходит за развёртку стены ${params.wall} по длине (развёртка ${frame.lengthCm.toFixed(1)} см)`);
  }
  if (bottomCm - heightCm / 2 < -0.01 || bottomCm + heightCm / 2 > H + 0.01) {
    throw new McpError("INVALID_ARGUMENT", `фигура выходит за развёртку по высоте (высота развёртки ${H} см)`);
  }
  // ниша: не на стеклянной/реечной стене и не на балконе (start_draw)
  if (kind === "wall_niche") {
    const wall = (model.walls ?? {})[target.wallId ?? ""];
    if (wall && (NICHE_STOP_MATERIALS.has(String(wall.material)) || wall.role === "balcony")) {
      throw new McpError("INVALID_ARGUMENT", `нишу на стене ${params.wall} (стекло/рейки/балкон) рисовать нельзя (start_draw бандла)`);
    }
    // пересечение с другой нишей той же развёртки (start_draw/dragend)
    for (const other of Object.values(model.wall_niches ?? {})) {
      if (other.prs?.["room"] !== roomId || other.prs?.["edge_index"] !== target.edgeIndex) continue;
      const dx = Math.abs((other.pc?.x ?? 0) - (frame.x0 + alongCm)) < (num(other.width) ?? 0) / 2 + widthCm / 2;
      const dy = Math.abs((other.pc?.y ?? 0) - (PRS_TOP_CM + H - bottomCm)) < (num(other.height) ?? 0) / 2 + heightCm / 2;
      if (dx && dy) {
        throw new McpError("INVALID_ARGUMENT", `ниша пересекается с другой нишей ${other.id} этой развёртки (start_draw бандла)`);
      }
    }
  }
  // тип slim — как в draw бандла (@1374528)
  let type: string = kind;
  if (kind === "wall_molding") {
    if (heightCm <= PRS_FIGURE_MIN_CM) type = "wall_molding_slim";
    else if (widthCm <= PRS_FIGURE_MIN_CM) type = "wall_molding_slim_h";
  }
  const pc: Point = { x: r2(frame.x0 + alongCm), y: r2(PRS_TOP_CM + H - bottomCm) };
  const prs: Record<string, unknown> = { room: roomId, edge_index: target.edgeIndex, pc_xd: r2(pc.x - frame.x0), pc_yd: r2(pc.y - PRS_TOP_CM) };
  const rec: PrsFigureEntity = {
    id: id ?? newId(),
    type,
    pc,
    width: widthCm,
    height: heightCm,
    plan: PROJECTION_PLAN,
    plan_: PROJECTION_PLAN,
    prs,
    on_size: 1,
  };
  if (kind === "wall_molding") rec.width_line = params.widthLineMm !== undefined ? r2(params.widthLineMm / 10) : PRS_MOLDING_WIDTH_LINE_CM;
  if (kind === "wall_niche") rec.depth = params.depthMm !== undefined ? r2(params.depthMm / 10) : PRS_NICHE_DEPTH_CM;
  collectionOf(model, kind)[rec.id] = rec;
  return { ...rec, kind };
}

/** Добавить молдинг/нишу развёртки (атомарность — ws.apply снаружи). */
export function addPrsFigure(model: Model, kind: PrsFigureKind, params: PrsFigureParams): PrsFigureResult {
  return buildPrsFigure(model, kind, params);
}

/** Обновить молдинг/нишу: позиция/размеры/глубина/толщина — как новая постановка. */
export function updatePrsFigure(model: Model, kind: PrsFigureKind, ref: string, params: Partial<PrsFigureParams>): PrsFigureResult {
  const rec = resolvePrsFigure(model, kind, ref);
  const roomId = String(rec.prs?.["room"] ?? "");
  const roomRec = ((model.rooms2 ?? model.rooms1 ?? {}) as Record<string, RoomRec>)[roomId];
  if (!roomRec) throw new McpError("NOT_FOUND", `комната развёртки ${roomId} не найдена`);
  const prsEdges = prsEdgesOf(roomRec);
  const target = prsEdges.find((e) => e.edgeIndex === rec.prs?.["edge_index"]);
  if (!target) throw new McpError("INVALID_ARGUMENT", `развёртка ребра ${String(rec.prs?.["edge_index"])} не найдена — фигура потеряла развёртку`);
  const widthMm = params.widthMm ?? rec.width * 10;
  const heightMm = params.heightMm ?? rec.height * 10;
  const oldX = rec.prs?.["pc_xd"];
  const oldYd = rec.prs?.["pc_yd"];
  const H = num(model.total_height) ?? 270;
  const alongMm = params.alongMm ?? (typeof oldX === "number" ? oldX * 10 : 0);
  const bottomMm = params.bottomMm ?? (typeof oldYd === "number" ? (H - oldYd) * 10 : 0);
  const depthMm = params.depthMm ?? (rec.depth !== undefined ? rec.depth * 10 : undefined);
  const widthLineMm = params.widthLineMm ?? (rec.width_line !== undefined ? rec.width_line * 10 : undefined);
  delete (collectionOf(model, kind) as Record<string, PrsFigureEntity>)[rec.id];
  try {
    return buildPrsFigure(model, kind, { room: roomId, wall: target.wallId ?? "", alongMm, bottomMm, widthMm, heightMm, depthMm, widthLineMm }, rec.id);
  } catch (e) {
    // атомарность: вернуть запись на место
    (collectionOf(model, kind) as Record<string, PrsFigureEntity>)[rec.id] = rec;
    throw e;
  }
}

export function deletePrsFigure(model: Model, kind: PrsFigureKind, ref: string): string {
  const rec = resolvePrsFigure(model, kind, ref);
  delete (collectionOf(model, kind) as Record<string, PrsFigureEntity>)[rec.id];
  return rec.id;
}

const LABELS: Record<PrsFigureKind, string> = { wall_molding: "WM", wall_niche: "WN" };

/** Метка WM<n>/WN<n> по ПОЛНОМУ списку коллекции (одинаковая во всех путях). */
export function prsFigureLabel(model: Model, kind: PrsFigureKind, id: string): string {
  const list = Object.keys(collectionOf(model, kind));
  const n = list.indexOf(id);
  return n >= 0 ? `${LABELS[kind]}${n + 1}` : id;
}

/** Резолв по id сайта или метке WM<n>/WN<n> (полный список, без фильтров). */
export function resolvePrsFigure(model: Model, kind: PrsFigureKind, ref: string): PrsFigureEntity {
  const map = collectionOf(model, kind);
  if (map[ref]) return map[ref]!;
  const m = new RegExp(`^${LABELS[kind]}(\\d+)$`).exec(ref);
  if (m) {
    const at = Object.values(map)[Number(m[1]) - 1];
    if (at) return at;
  }
  throw new McpError("NOT_FOUND", `${kind === "wall_molding" ? "молдинг" : "ниша"} ${ref} не найден${kind === "wall_molding" ? "" : "а"} (id сайта или метка ${LABELS[kind]}<n> из model_get)`);
}

/**
 * Семантическая форма молдинга/ниши для сверки save: без pc (кэш рамки
 * развёрток — редактор пересчитывает), без id/plan (id перегенерируется).
 * Мультимножество — редактор может переупорядочить коллекцию.
 */
export function prsFigureSemanticKey(rec: PrsFigureEntity): string {
  const prs = (rec.prs ?? {}) as Record<string, unknown>;
  return JSON.stringify({
    type: rec.type ?? null,
    room: typeof prs["room"] === "string" ? prs["room"] : null,
    edge: typeof prs["edge_index"] === "number" ? prs["edge_index"] : null,
    pc_xd: typeof prs["pc_xd"] === "number" ? Math.round(prs["pc_xd"] * 10) / 10 : null,
    pc_yd: typeof prs["pc_yd"] === "number" ? Math.round(prs["pc_yd"] * 10) / 10 : null,
    width: typeof rec.width === "number" ? Math.round(rec.width * 10) / 10 : null,
    height: typeof rec.height === "number" ? Math.round(rec.height * 10) / 10 : null,
    depth: typeof rec.depth === "number" ? Math.round(rec.depth * 10) / 10 : null,
    width_line: typeof rec.width_line === "number" ? Math.round(rec.width_line * 10) / 10 : null,
    on_size: rec.on_size ?? null,
  });
}

/** Сверка семантики развёрток комнаты после wall-операций: edge_index может
 *  перегенерироваться редактором вместе с oid — сверка prs_disabled/prs_first
 *  только при неизменной нарезке (число рёбер и развёрток совпадает). */
export function prsSettingsEqual(before: RoomRec, after: RoomRec): boolean {
  const edgesBefore = prsEdgesOf(before);
  const edgesAfter = prsEdgesOf(after);
  if (edgesBefore.length !== edgesAfter.length) return true; // нарезка изменилась — редактор переносит по геометрии
  const stB = prsStateOf(before);
  const stA = prsStateOf(after);
  return (
    stB.hidden === stA.hidden &&
    stB.firstEdge === stA.firstEdge &&
    stB.disabledEdges.length === stA.disabledEdges.length &&
    stB.disabledEdges.every((v, i) => v === stA.disabledEdges[i])
  );
}
