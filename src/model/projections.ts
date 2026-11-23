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
 * ставит type="wall_molding_slim" — тонкая ГОРИЗОНТАЛЬНАЯ полоса (draw бандла
 * @1374528: "wall_molding_slim"===this.type?this.height=this.width_line:…),
 * при ширине ≤ 10 см — "wall_molding_slim_h" — тонкая ВЕРТИКАЛЬНАЯ полоса
 * (width=width_line); запись с width<10 или height<10 (slim — только по одному
 * измерению) удаляется (end_draw, минимум 10 см). Ниша: пересечение с другой
 * нишей той же развёртки запрещено (checkIntersectionNiches/dragend), на
 * стеклянных/реечных стенах и балконах рисовать нельзя (start_draw:
 * a_glass/c_glass/c_bar/balcony). Глубина ниши: конструктор 20, draw
 * обрезает — depth=min(depth, getWallDepth(), 80) (get_wall_depth: сторона
 * e/s ребра → длина стены, иначе толщина стены;pillar → min(height,width)),
 * меню — correctValue(t,5,min(80,getWallDepth())) с предупреждением
 * wall_depth_niche; при смене нарезки рёбер depth снова обрезается
 * (restorePrsChangeEdges: N<_.depth&&(_.depth=N)). Габариты
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

/** Развёртки комнаты: rooms2[rid].edges_prs (fallback — рёбра комнаты с
 *  синтетическими ключами derived_<i>). */
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

/**
 * Есть ли у комнаты РЕАЛЬНАЯ раскладка развёрток (находка A ревью 397): у
 * комнаты без edges_prs (так бывает у каждой комнаты, созданной из стен, до
 * первого открытия листа «Развёртки») редактор назначает oid при построении
 * линий случайно — Projections.getLines (268-app.js): `t[e].oid =
 * i.id_of_edges[e] ? i.id_of_edges[e] : LIB.id()`, а LIB.id —
 * `"_"+Math.random().toString(36).substr(2,5)` (@20601). Точный порт
 * невозможен: MCP не может знать oid, которые редактор ещё не назначил
 * (id_of_edges в модели пуст вместе с edges_prs — фикстуры редактора:
 * editor-corridor-3rooms, ui-ref-sofa). Ключи derived_<i> в prs_disabled/
 * prs_first редактор не знает и не переносит (restoreElementPrs @2863309
 * переносит только по реальному oid старой развёртки), поэтому записи prs на
 * такой комнате консервативно отвергаются.
 *
 * Находка 3 ревью 400: oid НЕ нестабильны — по бандлу раскладка, созданная
 * редактором, сериализуется (createEdgesPrs → serialize пишет edges_prs и
 * id_of_edges, @1018941), и назначенные oid стабильны до пересчёта линий.
 * Причина отказа не в нестабильности oid, а в том, что их ЕЩЁ НЕТ в модели:
 * MCP сам раскладку не создаёт — её создаёт открытие развёрток комнаты
 * пользователем в редакторе (лист «Развёртки») и save проекта.
 */
export function hasRealPrsLayout(room: RoomRec): boolean {
  const raw = Array.isArray(room["edges_prs"]) ? (room["edges_prs"] as Array<Record<string, unknown>>) : [];
  if (raw.length === 0) return false;
  return raw.every((e) => typeof e["oid"] === "string" && e["oid"] !== "");
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

/**
 * Резолв ссылки на стену: id сайта или метка W<n> из model_get (порядок
 * Object.values(model.walls), как в model_get) — minor 7 ревью 390. Неизвестная
 * ссылка возвращается как есть — edgeByWall даст понятную ошибку.
 */
function wallRefToId(model: Model, ref: string): string {
  if ((model.walls ?? {})[ref]) return ref;
  const m = /^W(\d+)$/.exec(ref);
  if (m) {
    const w = Object.values(model.walls ?? {})[Number(m[1]) - 1];
    if (w) return w.id;
  }
  return ref;
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
  /** «Первая» развёртка — edge_index; null — авто (prs_first=0/пусто). */
  first_edge: number | null;
  /** Скрытые развёртки — набором edge_index. */
  disabled_edges: number[];
};

/**
 * Настройки развёрток комнаты (prs_hidden/prs_disabled/prs_first) — как в редакторе.
 * Требует реальной раскладки развёрток (edges_prs с oid редактора — hasRealPrsLayout):
 * на комнате без раскладки — INVALID_ARGUMENT (находка A ревью 397).
 */
export function setPrsSettings(model: Model, roomRef: string, params: PrsSettings): PrsSettingsResult {
  const { id, room } = resolveRoom(model, roomRef);
  const prsEdges = prsEdgesOf(room);
  if (prsEdges.length === 0) {
    throw new McpError("INVALID_ARGUMENT", `у комнаты ${roomRef} нет рёбер — развёрток нет`);
  }
  // находка A ревью 397: без реальной раскладки (edges_prs пуст) oid развёрток
  // редактор ещё не назначил (Projections.getLines: oid=LIB.id() — случайно),
  // записи prs_disabled/prs_first ушли бы под ключами derived_<i>, которых
  // редактор не знает и не переносит — консервативный отказ. Находка 5 ревью
  // 400: операции, которым oid НЕ нужен (скрытие: false — prs_disabled={},
  // first_wall: null — prs_first=0, show_walls — удаление ключей, в том числе
  // унаследованных derived_*), не блокируются — иначе висячие ключи прежних
  // версий MCP через MCP не очистить
  const needsOid =
    params.hidden === true ||
    (params.firstWall !== undefined && params.firstWall !== null) ||
    (params.hideWalls !== undefined && params.hideWalls.length > 0);
  if (!hasRealPrsLayout(room) && needsOid) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `у комнаты ${roomRef} нет раскладки развёрток (edges_prs пуст — раскладку создаёт редактор при первом ` +
        `открытии листа «Развёртки»; MCP сам раскладку не создаёт, а oid, назначенные при её создании, ` +
        `в модели ещё не известны): попросите пользователя открыть развёртки комнаты в редакторе ` +
        `(лист «Развёртки») и сохранить проект, затем повторите`,
    );
  }
  const disabled = prsDisabledEdges(room);
  // isShortLine бандла: длина ≤ 10 см (defs.projection_line.length_min) и на
  // линии нет items/sockets/waterspots/decors_finish — в модели развёртки эти
  // счётчики не хранятся, короткость — по длине ребра (мажорный случай).
  const nonShort = prsEdges.filter((e) => Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y) > 10).length;
  const hiddenAllIfAllHidden = (): void => {
    // #menu_projection_sign [container="visibility"]: скрытие по одной —
    // prs_hidden=1, когда не-коротких линий столько же, сколько ключей prs_disabled
    const map = room["prs_disabled"];
    const keys = map !== null && typeof map === "object" && !Array.isArray(map) ? Object.keys(map as Record<string, unknown>).length : 0;
    if (keys > 0 && nonShort === keys) room["prs_hidden"] = 1;
  };
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
      const e = edgeByWall(prsEdges, wallRefToId(model, params.firstWall));
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
      const e = edgeByWall(prsEdges, wallRefToId(model, wallId));
      const map = (room["prs_disabled"] ??= {}) as Record<string, unknown>;
      if (hide) {
        map[e.oid] = "";
        room["prs_hidden"] = 0;
        disabled.add(e.edgeIndex);
        hiddenAllIfAllHidden();
      } else {
        if (map && typeof map === "object" && !Array.isArray(map)) delete map[e.oid];
        room["prs_hidden"] = 0;
        disabled.delete(e.edgeIndex);
      }
    }
  }
  const first = prsFirstEdge(room);
  const hiddenNow = num(room["prs_hidden"]) === 1;
  return { room: id, hidden: hiddenNow, first_edge: first, disabled_edges: [...disabled].sort((a, b) => a - b) };
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

const PRS_FIGURE_KINDS: readonly PrsFigureKind[] = ["wall_molding", "wall_niche"];

/**
 * Затронутость молдингов/ниш развёрток при операциях со стенами (этап 391,
 * major 1 ревью 390) — сверка фигур «до → после normalize» по id (id редактор
 * сохраняет: $Restorer восстанавливает WALL_MOLDINGS[D.id]).
 *  - потеря (id нет после) — редактор удалил фигуру (Room.delete удаляет
 *    фигуры комнаты: "for(A in WALL_MOLDINGS)…A.prs.room===this.id&&A.delete()")
 *    или потерял при перестройке — видимое предупреждение с id;
 *  - перенос на другое ребро — edge_index изменился: редактор переносит
 *    фигуры по геометрии (restorePrsChangeEdges), а при edge_index вне
 *    диапазона — на последнюю линию (signal 43) — предупреждение с id;
 *  - висячая ссылка (prs.room не разрешается в комнаты после операции) —
 *    каскадное удаление как в Room.delete (caller удаляет по списку).
 */
export type PrsFiguresAffected = {
  warnings: string[];
  /** Фигуры с висячим prs.room — удалить из нормализованной копии (каскад Room.delete). */
  dangling: Array<{ kind: PrsFigureKind; id: string; room: string }>;
};

export function prsFiguresAffectedByWalls(before: Model, after: Model): PrsFiguresAffected {
  const warnings: string[] = [];
  const dangling: PrsFiguresAffected["dangling"] = [];
  const roomsAfter = (after["rooms2"] ?? after["rooms1"] ?? {}) as Record<string, unknown>;
  const labelOf = (kind: PrsFigureKind): string => (kind === "wall_molding" ? "молдинг развёртки" : "ниша развёртки");
  const collAfter = (kind: PrsFigureKind): Record<string, unknown> =>
    ((after as Record<string, unknown>)[kind === "wall_molding" ? "wall_moldings" : "wall_niches"] ?? {}) as Record<string, unknown>;
  for (const kind of PRS_FIGURE_KINDS) {
    const beforeColl = ((before as Record<string, unknown>)[kind === "wall_molding" ? "wall_moldings" : "wall_niches"] ?? {}) as Record<string, Record<string, unknown>>;
    const afterColl = collAfter(kind);
    for (const [id, rec] of Object.entries(beforeColl)) {
      const next = afterColl[id] as Record<string, unknown> | undefined;
      if (!next) {
        warnings.push(`${labelOf(kind)} ${id} удалён(а) редактором при изменении стен (перестройка комнаты — Room.delete бандла)`);
        continue;
      }
      const prs = (next["prs"] ?? {}) as Record<string, unknown>;
      const roomId = typeof prs["room"] === "string" ? prs["room"] : "";
      if (roomId !== "" && roomsAfter[roomId] === undefined) {
        dangling.push({ kind, id, room: roomId });
        continue;
      }
      const prevPrs = (rec["prs"] ?? {}) as Record<string, unknown>;
      const prevEdge = typeof prevPrs["edge_index"] === "number" ? prevPrs["edge_index"] : null;
      const nextEdge = typeof prs["edge_index"] === "number" ? prs["edge_index"] : null;
      if (prevEdge !== null && nextEdge !== null && prevEdge !== nextEdge) {
        warnings.push(`${labelOf(kind)} ${id} перенесён(а) редактором на другую развёртку (ребро ${String(prevEdge)} → ${String(nextEdge)}; сигнал 43 бандла «Изменение индекса элемента на развертках»)`);
      }
    }
    for (const id of Object.keys(afterColl)) {
      if (beforeColl[id] === undefined) {
        warnings.push(`${labelOf(kind)} ${id} появился(ась) после нормализации, хотя не был(а) добавлен(а) — проверьте model_get`);
      }
    }
  }
  return { warnings, dangling };
}

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

/**
 * get_wall_depth бандла (wall_figure_helper): для ребра со стороной e/s
 * (развертка смотрит на торец стены) — длина стены (округлённо, см); иначе —
 * толщина стены. Рёбра с колонной (pillar) консервативно дают undefined.
 */
function wallDepthOfEdge(model: Model, room: RoomRec, target: PrsEdge): number | undefined {
  const edges = Array.isArray(room.edges) ? (room.edges as Array<Record<string, unknown>>) : [];
  const e = edges[target.edgeIndex];
  if (!e) return undefined;
  const sideBy = (pid: string): string | undefined => {
    const pids = e["pids"] as Record<string, string> | undefined;
    if (pids && typeof pids[pid] === "string") return pids[pid];
    return typeof e["side"] === "string" ? (e["side"] as string) : undefined;
  };
  const pid = typeof e["pid"] === "string" ? (e["pid"] as string) : target.wallId ?? "";
  const side = pid ? sideBy(pid) : undefined;
  const wall = (model.walls ?? {})[target.wallId ?? ""];
  if (!wall) return undefined;
  if (side === "e" || side === "s") {
    const p1 = wall.p1, p2 = wall.p2;
    if (!p1 || !p2) return undefined;
    return Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y));
  }
  return typeof wall.depth === "number" && Number.isFinite(wall.depth) ? wall.depth : undefined;
}

function buildPrsFigure(model: Model, kind: PrsFigureKind, params: PrsFigureParams, id?: string, opts: { depthInherited?: boolean } = {}): PrsFigureResult {
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
  const target = edgeByWall(prsEdges, wallRefToId(model, params.wall));
  const frame = prsFrame(room, target);
  const widthCm = r2(params.widthMm / 10);
  const heightCm = r2(params.heightMm / 10);
  const alongCm = r2(params.alongMm / 10);
  const bottomCm = r2(params.bottomMm / 10);
  const H = num(model.total_height) ?? 270;
  // глубина ниши (major 4 ревью 390): конструктор 20 см, draw обрезает —
  // depth=min(depth, getWallDepth(), 80); меню — correctValue(t,5,min(80,getWallDepth()))
  // с предупреждением wall_depth_niche. Диапазон входа — [50, min(800, getWallDepth()*10)] мм.
  let depthCm: number | undefined;
  if (kind === "wall_niche") {
    const wallDepthCm = wallDepthOfEdge(model, room, target);
    const maxDepthCm = wallDepthCm !== undefined ? Math.min(80, wallDepthCm) : 80;
    // №19 follow-up 392: унаследованная глубина (update без depth_mm) уже
    // обрезана до предела вызывающим кодом — как в бандле
    // (restorePrsChangeEdges: N<_.depth&&(_.depth=N)) — не отвергается и не
    // поднимается до 50 мм; явно переданная глубина валидируется как раньше
    if (!opts.depthInherited && params.depthMm !== undefined && (!Number.isFinite(params.depthMm) || params.depthMm < 50 || params.depthMm > maxDepthCm * 10)) {
      const hint = wallDepthCm !== undefined
        ? `толщина/длина стены по развёртке — ${wallDepthCm} см`
        : "стену ребра не удалось определить — глубина ограничена 800 мм";
      throw new McpError("INVALID_ARGUMENT", `depth_mm — число от 50 до ${Math.round(maxDepthCm * 10)} мм (${hint}; редактор: меню ниши correctValue(t,5,min(80,getWallDepth())) с предупреждением wall_depth_niche, draw обрезает depth=min(depth,getWallDepth(),80))`);
    }
    if (params.depthMm !== undefined) {
      depthCm = r2(params.depthMm / 10);
    } else {
      // №19: умолчание на стене тоньше 5 см меньше 50 мм — нишу создать нельзя
      // (correctValue(t,5,min(80,getWallDepth())): верхняя граница меню ниже
      // нижней, значение < 50 мм не создаём)
      if (wallDepthCm !== undefined && wallDepthCm < 5) {
        throw new McpError("INVALID_ARGUMENT", `на стене ${params.wall} тоньше 5 см нишу создать нельзя (умолчание min(200, толщина ${wallDepthCm * 10} мм) < 50 мм; редактор: correctValue(t,5,min(80,getWallDepth())))`);
      }
      depthCm = wallDepthCm !== undefined ? Math.min(PRS_NICHE_DEPTH_CM, wallDepthCm) : PRS_NICHE_DEPTH_CM;
    }
  }
  // end_draw: запись < 10 см по значимому измерению удаляется (min 10)
  if (kind === "wall_niche") {
    if (widthCm < PRS_FIGURE_MIN_CM || heightCm < PRS_FIGURE_MIN_CM) {
      throw new McpError("INVALID_ARGUMENT", `ниша: width_mm и height_mm — не меньше ${PRS_FIGURE_MIN_CM * 10} мм (запись меньше редактор удаляет, end_draw)`);
    }
  } else if (heightCm <= PRS_FIGURE_MIN_CM) {
    // slim: тонкая ГОРИЗОНТАЛЬНАЯ полоса — толщина (height) = width_line (draw бандла),
    // ширина ≥ 10
    if (widthCm < PRS_FIGURE_MIN_CM) {
      throw new McpError("INVALID_ARGUMENT", `молдинг: width_mm — не меньше ${PRS_FIGURE_MIN_CM * 10} мм (запись меньше редактор удаляет, end_draw)`);
    }
  } else if (widthCm <= PRS_FIGURE_MIN_CM) {
    // slim_h: тонкая ВЕРТИКАЛЬНАЯ полоса — толщина (width) = width_line (draw бандла),
    // высота ≥ 10
    if (heightCm < PRS_FIGURE_MIN_CM) {
      throw new McpError("INVALID_ARGUMENT", `молдинг: height_mm — не меньше ${PRS_FIGURE_MIN_CM * 10} мм (запись меньше редактор удаляет, end_draw)`);
    }
  } else if (widthCm < PRS_FIGURE_MIN_CM || heightCm < PRS_FIGURE_MIN_CM) {
    throw new McpError("INVALID_ARGUMENT", `молдинг: width_mm и height_mm — не меньше ${PRS_FIGURE_MIN_CM * 10} мм`);
  }
  // тип slim — как в draw бандла (@1374528)
  let type: string = kind;
  if (kind === "wall_molding") {
    if (heightCm <= PRS_FIGURE_MIN_CM) type = "wall_molding_slim";
    else if (widthCm <= PRS_FIGURE_MIN_CM) type = "wall_molding_slim_h";
  }
  const widthLineCm = kind === "wall_molding" ? (params.widthLineMm !== undefined ? r2(params.widthLineMm / 10) : PRS_MOLDING_WIDTH_LINE_CM) : undefined;
  // форма slim — по формуле draw бандла: height=width_line (slim), width=width_line (slim_h)
  const effWidthCm = type === "wall_molding_slim_h" ? (widthLineCm ?? widthCm) : widthCm;
  const effHeightCm = type === "wall_molding_slim" ? (widthLineCm ?? heightCm) : heightCm;
  // фигура целиком в развёртке (клик-создание бандла: все углы в развёртке) —
  // консервативно: центр с половинами внутри [0..L] × [0..H]
  if (alongCm - effWidthCm / 2 < -0.01 || alongCm + effWidthCm / 2 > frame.lengthCm + 0.01) {
    throw new McpError("INVALID_ARGUMENT", `фигура выходит за развёртку стены ${params.wall} по длине (развёртка ${frame.lengthCm.toFixed(1)} см)`);
  }
  if (bottomCm - effHeightCm / 2 < -0.01 || bottomCm + effHeightCm / 2 > H + 0.01) {
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
  const pc: Point = { x: r2(frame.x0 + alongCm), y: r2(PRS_TOP_CM + H - bottomCm) };
  const prs: Record<string, unknown> = { room: roomId, edge_index: target.edgeIndex, pc_xd: r2(pc.x - frame.x0), pc_yd: r2(pc.y - PRS_TOP_CM) };
  const rec: PrsFigureEntity = {
    id: id ?? newId(),
    type,
    pc,
    width: effWidthCm,
    height: effHeightCm,
    plan: PROJECTION_PLAN,
    plan_: PROJECTION_PLAN,
    prs,
    on_size: 1,
  };
  if (kind === "wall_molding") rec.width_line = widthLineCm;
  if (kind === "wall_niche") rec.depth = depthCm;
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
  const depthMmRaw = params.depthMm ?? (rec.depth !== undefined ? rec.depth * 10 : undefined);
  // №19 follow-up 392: унаследованная глубина обрезается до ТЕКУЩЕГО предела
  // (бандл: restorePrsChangeEdges — N<_.depth&&(_.depth=N); редактор обрезает,
  // если толщина стены уменьшилась), а не отвергает; явно переданная вне
  // предела — INVALID_ARGUMENT (валидация buildPrsFigure)
  let depthMm = depthMmRaw;
  if (kind === "wall_niche" && params.depthMm === undefined && depthMm !== undefined) {
    const wallDepthCm = wallDepthOfEdge(model, roomRec, target);
    const maxDepthMm = Math.round((wallDepthCm !== undefined ? Math.min(80, wallDepthCm) : 80) * 10);
    depthMm = Math.min(depthMm, maxDepthMm);
  }
  const widthLineMm = params.widthLineMm ?? (rec.width_line !== undefined ? rec.width_line * 10 : undefined);
  delete (collectionOf(model, kind) as Record<string, PrsFigureEntity>)[rec.id];
  try {
    return buildPrsFigure(model, kind, { room: roomId, wall: target.wallId ?? "", alongMm, bottomMm, widthMm, heightMm, depthMm, widthLineMm }, rec.id, { depthInherited: params.depthMm === undefined });
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
 * Публичный ответ инструментов wall_molding_* / wall_niche_* — в мм и форме
 * model_get (major 5 ревью 390): формат редактора (pc/pc_xd/pc_yd в см,
 * prs-структуры) не протекает. Форма — как compactPrsFigures в model_get:
 * along_mm от начала развёртки (prs.pc_xd), from_floor_mm от низа (prs.pc_yd
 * и total_height), метка комнаты R<n> — по порядку комнат model_get.
 */
export function prsFigurePublic(model: Model, kind: PrsFigureKind, rec: PrsFigureEntity, label: string): Record<string, unknown> {
  const prs = (rec.prs ?? {}) as Record<string, unknown>;
  const xd = num(prs["pc_xd"]) ?? 0;
  const yd = num(prs["pc_yd"]) ?? 0;
  const H = num(model.total_height) ?? 270;
  const roomId = typeof prs["room"] === "string" ? prs["room"] : null;
  const rooms = Object.keys(((model as Record<string, unknown>)["rooms2"] ?? (model as Record<string, unknown>)["rooms1"] ?? {}) as Record<string, unknown>);
  const ri = roomId !== null ? rooms.indexOf(roomId) : -1;
  return {
    [kind === "wall_molding" ? "molding_id" : "niche_id"]: label,
    site_id: rec.id,
    type: rec.type ?? null,
    room: ri >= 0 ? `R${ri + 1}` : roomId,
    edge_index: num(prs["edge_index"]) ?? -1,
    along_mm: Math.round(xd * 10),
    from_floor_mm: Math.round((H - yd) * 10),
    width_mm: Math.round((num(rec.width) ?? 0) * 10),
    height_mm: Math.round((num(rec.height) ?? 0) * 10),
    ...(rec.depth !== undefined ? { depth_mm: Math.round(rec.depth * 10) } : {}),
    ...(rec.width_line !== undefined ? { width_line_mm: Math.round(rec.width_line * 10) } : {}),
  };
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

export type WallAnchorParams = {
  room: string;
  /** Стена ребра с отделкой (id сайта из model_get или метка W<n>). */
  wall: string;
  /** Точка от начала развёртки ребра, мм. */
  alongMm: number;
  /** Точка от низа развёртки (от пола), мм. */
  heightMm: number;
  /** Какая часть стороны (layer из finish_get); по умолчанию — часть, содержащая точку. */
  layer?: number;
};

/**
 * Полигон части отделки на развёртке (№16 follow-up 392): x — из part.line,
 * как в getPolygon бандла (`[LIB.point(LIB.distance(e.p1,n.p1),d), …]`, n —
 * линия части, упорядоченная по удалённости концов от начала ребра): xMin =
 * проекция ближнего конца part.line на ось ребра, xMax — дальнего. Части,
 * нарезанные по длине (split_points), имеют xMin > рамки развёртки. Без
 * part.line (части, не нарезанные по длине) — вся развёртка ребра. y — как
 * раньше: от height_from_floor до верха части.
 */
function decorPartFrame(
  room: RoomRec,
  target: PrsEdge,
  part: Record<string, unknown>,
  totalHeightCm: number,
): { xMin: number; xMax: number; yMin: number; topCm: number; bottomCm: number } {
  const frame = prsFrame(room, target);
  const hffCm = num(part["height_from_floor"]) ?? 0;
  const hCm = num(part["height"]) ?? 0;
  const topCm = hCm === 0 ? totalHeightCm : hffCm + hCm;
  const H = totalHeightCm;
  let xMin = frame.x0;
  let xMax = frame.x0 + frame.lengthCm;
  const line = part["line"] as { p1?: Point; p2?: Point } | undefined;
  if (line?.p1 && line?.p2 && target.p1 && target.p2) {
    const dx = target.p2.x - target.p1.x;
    const dy = target.p2.y - target.p1.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-9) {
      const proj = (p: Point): number => ((p.x - target.p1.x) * dx + (p.y - target.p1.y) * dy) / len;
      const d1 = r2(proj(line.p1));
      const d2 = r2(proj(line.p2));
      xMin = frame.x0 + Math.min(d1, d2);
      xMax = frame.x0 + Math.max(d1, d2);
    }
  }
  return { xMin, xMax, yMin: Math.round((PRS_TOP_CM + H - topCm) * 100) / 100, topCm, bottomCm: hffCm };
}

/**
 * Часть стороны, в которую редактор ставит точку: обработчик anchor_decor
 * адресует ОДНУ линию декора ($DecorLining.get_decor_line(decor_id)) — часть,
 * на которой пользователь кликнул. Выбор (№16 follow-up 392): части,
 * содержащие точку по высоте (height_from_floor ≤ h ≤ top; height=0 — часть
 * до верха развёртки), при нескольких кандидатах — по along внутри рамки
 * части (xMin/xMax из part.line — части, нарезанные по длине, различаются
 * без layer), затем явный layer. 0 или >1 кандидатов — отказ с перечнем
 * слоёв (conservative: не угадываем).
 */
function pickDecorPart(
  room: RoomRec,
  target: PrsEdge,
  parts: Record<string, Record<string, unknown>>,
  params: { alongMm: number; heightMm: number; layer?: number },
  totalHeightCm: number,
): Record<string, Record<string, unknown>> {
  const hCm = params.heightMm / 10;
  const alongCm = params.alongMm / 10;
  const entries = Object.entries(parts);
  const layers = [...new Set(entries.map(([, p]) => num(p["layer"]) ?? 1))].sort((a, b) => a - b);
  // рамка по along — абсолютная координата точки в рамке развёрток
  const frameX = prsFrame(room, target).x0 + alongCm;
  const containsAlong = (p: Record<string, unknown>): boolean => {
    const f = decorPartFrame(room, target, p, totalHeightCm);
    return frameX >= f.xMin - 0.01 && frameX <= f.xMax + 0.01;
  };
  // 1) части, содержащие точку (height_from_floor ≤ h ≤ top; height=0 — часть до верха)
  let containing = entries.filter(([, p]) => {
    const hff = num(p["height_from_floor"]) ?? 0;
    const h = num(p["height"]) ?? 0;
    const top = h === 0 ? totalHeightCm : hff + h;
    return hCm >= hff - 0.01 && hCm <= top + 0.01;
  });
  // 2) явный layer сужает выбор (несколько частей могут делить один слой)
  if (params.layer !== undefined) containing = containing.filter(([, p]) => (num(p["layer"]) ?? 1) === params.layer);
  // 3) несколько кандидатов — нарезка по длине: часть, содержащая along
  if (containing.length > 1) {
    const byAlong = containing.filter(([, p]) => containsAlong(p));
    if (byAlong.length === 1) containing = byAlong;
    else if (byAlong.length === 0) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `точка (${Math.round(params.alongMm)} мм от начала развёртки) между частями отделки ребра по длине — укажите layer (слои: ${layers.join(", ") || "нет"})`,
      );
    } else {
      throw new McpError("INVALID_ARGUMENT", `точка (${Math.round(params.alongMm)} мм от начала развёртки, высота ${Math.round(params.heightMm)} мм от пола) попадает в несколько частей отделки ребра — укажите layer (слои: ${layers.join(", ")})`);
    }
  }
  if (containing.length === 1) return { [containing[0]![0]]: containing[0]![1] };
  if (containing.length === 0) {
    if (params.layer !== undefined && entries.some(([, p]) => (num(p["layer"]) ?? 1) === params.layer)) {
      throw new McpError("INVALID_ARGUMENT", `на ребре нет части отделки со слоем ${params.layer}, содержащей точку (высота ${Math.round(params.heightMm)} мм от пола); слои ребра: ${layers.join(", ")}`);
    }
    throw new McpError("INVALID_ARGUMENT", `точка (высота ${Math.round(params.heightMm)} мм от пола) не попадает ни в одну часть отделки ребра — укажите layer (слои: ${layers.join(", ") || "нет"})`);
  }
  throw new McpError("INVALID_ARGUMENT", `точка (высота ${Math.round(params.heightMm)} мм от пола) попадает в несколько частей отделки ребра — укажите layer (слои: ${layers.join(", ")})`);
}

export type WallAnchorResult = {
  edge: number;
  /** Точка в рамке развёрток (кэш, в модель пишется anchor) — для диагностики. */
  anchor: Record<string, unknown>;
  angle: number;
  /** id части стороны, в которую поставлена точка. */
  part?: string;
  /** Слой части (layer из finish_get). */
  layer: number;
};

export function setWallDecorAnchor(model: Model, params: WallAnchorParams): WallAnchorResult {
  for (const [key, v] of [["along_mm", params.alongMm], ["height_mm", params.heightMm]] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 100000) {
      throw new McpError("INVALID_ARGUMENT", `${key} — число от 0 до 100000 мм`);
    }
  }
  if (params.layer !== undefined && (!Number.isFinite(params.layer) || params.layer < 1 || !Number.isInteger(params.layer))) {
    throw new McpError("INVALID_ARGUMENT", "layer — целое число ≥ 1 (слой части отделки из finish_get)");
  }
  const { id: roomId, room } = resolveRoom(model, params.room);
  void roomId;
  const prsEdges = prsEdgesOf(room);
  if (prsEdges.length === 0) {
    throw new McpError("INVALID_ARGUMENT", `у комнаты ${params.room} нет рёбер — развёрток нет`);
  }
  const target = edgeByWall(prsEdges, wallRefToId(model, params.wall));
  const frame = prsFrame(room, target);
  const alongCm = r2(params.alongMm / 10);
  const heightCm = r2(params.heightMm / 10);
  const H = typeof model["total_height"] === "number" ? (model["total_height"] as number) : 270;
  if (alongCm < -0.01 || alongCm > frame.lengthCm + 0.01 || heightCm < -0.01 || heightCm > H + 0.01) {
    throw new McpError("INVALID_ARGUMENT", `точка вне развёртки стены ${params.wall} (развёртка ${frame.lengthCm.toFixed(1)}×${H} см)`);
  }
  const decors = Array.isArray(room.decors) ? (room.decors as Array<Record<string, unknown>>) : [];
  const rec = decors[target.edgeIndex] as { exist?: unknown; parts?: Record<string, Record<string, unknown>> } | undefined;
  if (!rec || rec["exist"] !== true || !rec["parts"] || Object.keys(rec["parts"]).length === 0) {
    throw new McpError("INVALID_ARGUMENT", `у ребра стены ${params.wall} комнаты ${params.room} нет отделки — точка укладки не ставится (сначала finish_wall_set)`);
  }
  // точка ставится в ОДНУ часть стороны (anchor_decor: a=$DecorLining.get_decor_line(decor_id))
  const picked = pickDecorPart(room, target, rec["parts"]!, params, H);
  const [partKey, part] = Object.entries(picked)[0]!;
  const pc = { x: Math.round((frame.x0 + alongCm) * 100) / 100, y: Math.round((30 + H - heightCm) * 100) / 100 };
  const partFrame = decorPartFrame(room, target, part, H);
  // точка обязана лежать в части и по along (клик бандла всегда в части)
  if (pc.x < partFrame.xMin - 0.01 || pc.x > partFrame.xMax + 0.01) {
    throw new McpError("INVALID_ARGUMENT", `точка (${params.alongMm} мм от начала развёртки) вне части отделки по длине (часть ${Math.round((partFrame.xMin - frame.x0) * 10)}…${Math.round((partFrame.xMax - frame.x0) * 10)} мм от начала развёртки ребра ${params.wall})`);
  }
  // pc_* — от прямоугольника САМОЙ части (бандл: new Polygon(WALL_DECORS[a.id].polygon))
  const anchor: Record<string, unknown> = { p: pc, pc_xd: Math.round((pc.x - partFrame.xMin) * 100) / 100, pc_yd: Math.round((pc.y - partFrame.yMin) * 100) / 100 };
  part["anchor"] = structuredClone(anchor);
  part["angle"] = part["type"] === "wall_woodbatten" ? 90 : 0;
  delete part["custom_angle"];
  return { edge: target.edgeIndex, anchor, angle: num(part["angle"]) ?? 0, part: part["id"] !== undefined ? String(part["id"]) : undefined, layer: num(part["layer"]) ?? 1 };

}
