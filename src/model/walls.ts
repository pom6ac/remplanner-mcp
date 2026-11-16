import type { Model, Wall, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import {
  leftNormal, sub, add, scale, dist, lineIntersection, polygonSignedArea,
  type Segment,
} from "./geometry.ts";
import { McpError } from "../errors.ts";
import { prepareHolePoints, refreshWallHoles, holeRange, normalizeWallOpeningFormats } from "./openings.ts";
import { refreshPillarsAfterWallChange } from "./pillars.ts";
import { refreshRigelsAfterWallOrPillarChange } from "./rigels.ts";

// Топология стен (design §12.3): Node задаёт ТОЛЬКО геометрию — оси, толщину, T-концы на
// гранях. Связи (node/edge), грани на стыках и комнаты редактор строит сам из геометрии
// при каждом draw (T24: restore голой геометрии даёт 7 стен, 4 комнаты, 6 edge + 8 node).
// Правила:
//   1. Узлы — точно в точку; зазор 0,01…1,5 см → INVALID_GEOMETRY (редактор молча склеит).
//   2. T-примыкание: конец в теле стены → на ближнюю грань (не на ось).
//   3. Общая стена: сторона на оси существующей стены урезается вычитанием покрытых
//      интервалов; другая толщина → INVALID_GEOMETRY.
//   4. X-пересечение посреди отрезков → UNSUPPORTED_JUNCTION, отказ атомарный.
//   5. move/update переносят узлы и T-концы соседей, проёмы затронутых стен пересчитываются.
//   6. split — геометрический разрез с раздачей проёмов по pc.
//   7. Атомарность: ошибка оставляет модель побайтно равной исходной.

// Входы инструментов — в мм, модель сайта — в см.

export type MmPoint = { x: number; y: number };

export type AddWallParams = {
  start: MmPoint;
  end: MmPoint;
  thicknessMm?: number;
  material?: string;
  plan?: "a" | "c";
  role?: "wall" | "balcony";
};

export type AddPolylineParams = {
  points: MmPoint[];
  closed?: boolean;
  thicknessMm?: number;
  material?: string;
  plan?: "a" | "c";
};

export type ThicknessSides = { top: number; right: number; bottom: number; left: number };

export type AddRoomRectParams = {
  origin: MmPoint;
  widthMm: number;
  depthMm: number;
  /** мм; одно значение или по сторонам. */
  thicknessMm?: number | Partial<ThicknessSides>;
  /** inner (по умолчанию) — размеры чистого помещения; axis — по осевым линиям. */
  dimensions?: "inner" | "axis";
  plan?: "a" | "c";
  material?: string;
};

export type AddRoomPolygonParams = {
  /** Обход по часовой стрелке (Y вниз), мм. */
  points: MmPoint[];
  thicknessMm?: number;
  dimensions?: "inner" | "axis";
  plan?: "a" | "c";
  material?: string;
};

export type UpdateWallParams = {
  wallId: string;
  lengthMm?: number;
  anchor?: "start" | "end";
  thicknessMm?: number;
  side?: "both" | "left" | "right";
  material?: string;
  start?: MmPoint;
  end?: MmPoint;
};

export type MoveWallParams = { wallId: string; offsetMm: number };

const NODE_TOL_CM = 0.01; // точное совпадение узлов (правило 1)
const NODE_GAP_MAX_CM = 1.5; // допуск node у редактора: зазор (0,01…1,5] — ошибка
const EDGE_TOL_CM = 1.0; // допуск edge у редактора
const AXIS_TOL_CM = 0.05; // «та же ось»
const MIN_WALL_CM = 3; // редактор удаляет стены короче 3 см

function cm(pt: MmPoint): Point {
  return { x: mmToCm(pt.x), y: mmToCm(pt.y) };
}

function ensureModel(model: Model): void {
  model.walls ??= {};
  model.items ??= {};
  model.pillars ??= {};
}

function uniqueId(model: Model): string {
  for (let i = 0; i < 100; i++) {
    const id = newId(10);
    if (!(id in model.walls)) return id;
  }
  throw new Error("не удалось сгенерировать id стены");
}

function totalHeight(model: Model): number {
  const h = model["total_height"];
  return typeof h === "number" && h > 0 ? h : 270;
}

function geomError(code: "INVALID_GEOMETRY" | "UNSUPPORTED_JUNCTION", message: string, details: Record<string, unknown>, hint?: string): McpError {
  return new McpError(code, message, { hint, details });
}

/**
 * Атомарность (правило 7, R2-3): мутация выполняется на клоне стен; при ошибке
 * model.walls и model.pillars восстанавливаются побайтно. После успешной мутации —
 * финализация колонн (ревью 43 №1): пересчёт eds/edges/inRoom и проверка коллизий
 * в той же атомарной операции; конфликт откатывает и стены, и колонны.
 */
function atomic<T>(model: Model, fn: () => T): T {
  const backupWalls = structuredClone(model.walls);
  const backupPillars = structuredClone(model.pillars ?? {});
  const backupRigels = structuredClone(model.rigels ?? {});
  try {
    const result = fn();
    refreshPillarsAfterWallChange(model);
    refreshRigelsAfterWallOrPillarChange(model);
    return result;
  } catch (e) {
    model.walls = backupWalls;
    model.pillars = backupPillars;
    model.rigels = backupRigels;
    throw e;
  }
}

// ---------- геометрические примитивы ----------

/** Проекция точки на прямую (a→b): t — в см от a, perp — расстояние до прямой. */
function projectPt(a: Point, b: Point, pt: Point): { t: number; perp: number; signed: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const len = Math.sqrt(len2);
  if (len < 1e-9) return { t: 0, perp: dist(pt, a), signed: 0 };
  const wx = pt.x - a.x;
  const wy = pt.y - a.y;
  const t = (wx * dx + wy * dy) / len;
  const cross = (wx * dy - wy * dx) / len;
  return { t, perp: Math.abs(cross), signed: cross };
}

function wallLen(w: Wall): number {
  return Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
}

function unit(w: Wall): Point {
  const len = wallLen(w);
  return { x: (w.p2.x - w.p1.x) / len, y: (w.p2.y - w.p1.y) / len };
}

function collinearDirs(w: Wall, p1: Point, p2: Point): boolean {
  const u = unit(w);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs(u.x * dy - u.y * dx) / len <= AXIS_TOL_CM / 10;
}

/**
 * Правило 1+2: прижать конец новой стены к существующей геометрии.
 * Совпадение с узлом (≤ 0,01 см) — точка узла; зазор (0,01…1,5] — INVALID_GEOMETRY;
 * конец в теле перпендикулярной стены — на ближнюю грань (не на ось, T24 сценарий C).
 */
function snapEnd(model: Model, pt: Point, otherEnd: Point | null, skipIds: ReadonlySet<string>): Point {
  for (const w of Object.values(model.walls)) {
    if (skipIds.has(w.id) || wallLen(w) < 1e-9) continue;
    const d1 = dist(pt, w.p1);
    const d2 = dist(pt, w.p2);
    if (d1 <= NODE_TOL_CM) return { x: w.p1.x, y: w.p1.y };
    if (d2 <= NODE_TOL_CM) return { x: w.p2.x, y: w.p2.y };
    if ((d1 > NODE_TOL_CM && d1 <= NODE_GAP_MAX_CM) || (d2 > NODE_TOL_CM && d2 <= NODE_GAP_MAX_CM)) {
      throw geomError("INVALID_GEOMETRY", `конец стены в ${NODE_GAP_MAX_CM} см от узла стены ${w.id} — редактор склеит узлы молча; задайте точный узел или разнесите концы`, {
        kind: "node_gap", wall_id: w.id, point: pt,
      });
    }
    const { t, perp, signed } = projectPt(w.p1, w.p2, pt);
    const len = wallLen(w);
    if (perp < w.depth / 2 && t >= -1e-6 && t <= len + 1e-6) {
      const isCollinear = collinearDirs(w, pt, otherEnd ?? { x: pt.x + 1, y: pt.y });
      if (isCollinear) {
        if (perp <= AXIS_TOL_CM) continue; // точка на общей оси — общая стена, правило 3
        // параллельная стена телом на теле — наложение, а не T-примыкание
        throw geomError("INVALID_GEOMETRY", `новая стена наложится на стену ${w.id} (коллинеарна, тела пересекаются)`, {
          kind: "wall_over_wall", wall_id: w.id,
        });
      }
      // сторона грани: где сама точка, а при нуле — где второй конец новой стены
      const side = Math.abs(signed) > 1e-9 ? Math.sign(signed) : (otherEnd ? Math.sign(projectPt(w.p1, w.p2, otherEnd).signed) || 1 : 1);
      const n = leftNormal(unit(w).x, unit(w).y);
      const half = w.depth / 2;
      const faceA = add(w.p1, scale(n, side * half));
      const faceB = add(w.p2, scale(n, side * half));
      const isect = otherEnd ? lineIntersection({ p1: faceA, p2: faceB }, { p1: pt, p2: otherEnd }) : null;
      if (isect) return { x: r2(isect.x), y: r2(isect.y) };
      // запасной путь: перпендикулярная проекция на грань
      const foot = add(w.p1, scale(unit(w), Math.min(Math.max(t, 0), len)));
      return { x: r2(foot.x + n.x * side * half), y: r2(foot.y + n.y * side * half) };
    }
  }
  return { x: r2(pt.x), y: r2(pt.y) };
}

/** Правило 4: X-пересечение посреди обоих отрезков запрещено (узел/T — разрешены). */
function assertNoCrossing(model: Model, p1: Point, p2: Point, skipIds: ReadonlySet<string>): void {
  const len = dist(p1, p2);
  for (const w of Object.values(model.walls)) {
    if (skipIds.has(w.id) || wallLen(w) < 1e-9) continue;
    const isect = lineIntersection({ p1, p2 }, { p1: w.p1, p2: w.p2 });
    if (!isect) continue;
    const a = projectPt(p1, p2, isect);
    const b = projectPt(w.p1, w.p2, isect);
    if (a.t > 0.01 && a.t < len - 0.01 && b.t > 0.01 && b.t < wallLen(w) - 0.01) {
      throw geomError("UNSUPPORTED_JUNCTION", `стена пересекает стену ${w.id} посреди отрезков (X-пересечение не поддерживается)`, {
        wall_id: w.id, point: isect,
      });
    }
  }
}

function makeWall(model: Model, p1: Point, p2: Point, params: { thicknessMm?: number; material?: string; plan?: "a" | "c"; role?: "wall" | "balcony" }): Wall {
  const depth = mmToCm(params.thicknessMm ?? 200);
  const id = uniqueId(model);
  const wall: Wall = {
    id,
    plan: params.plan ?? "a",
    role: params.role ?? "wall",
    child: 0,
    archive: 0,
    demount: 0,
    depth,
    height: totalHeight(model),
    p1: { x: r2(p1.x), y: r2(p1.y) },
    p2: { x: r2(p2.x), y: r2(p2.y) },
    p1st: 0,
    p2st: 0,
    material: params.material ?? "a_block",
    color: 0,
    level: "1",
    show_dls: true,
    holes: {},
  };
  model.walls[id] = wall;
  return wall;
}

/**
 * Правило 2 (симметрично): концы СУЩЕСТВУЮЩИХ стен, попавшие в тело новой стены
 * (или в EDITOR_EDGE_TOL от её грани), продлеваются до грани новой стены вдоль
 * своей оси — так рисует rebuildEdgeConnectedWalls редактора (T24 сценарий D:
 * порядок вставки не влияет на итог).
 */
function extendExistingEnds(model: Model, p1: Point, p2: Point, depth: number, skipIds: ReadonlySet<string>): Wall[] {
  const touched: Wall[] = [];
  const len = dist(p1, p2);
  if (len < 1e-9) return touched;
  const u = { x: (p2.x - p1.x) / len, y: (p2.y - p1.y) / len };
  const n = leftNormal(u.x, u.y);
  for (const w of Object.values(model.walls)) {
    if (skipIds.has(w.id) || wallLen(w) < 1e-9) continue;
    if (collinearDirs(w, p1, p2)) continue; // коллинеарные обрабатывает вычитание интервалов
    for (const node of ["p1", "p2"] as const) {
      const e = w[node];
      if (dist(e, p1) <= NODE_TOL_CM || dist(e, p2) <= NODE_TOL_CM) continue; // узел — не трогаем
      const pr = projectPt(p1, p2, e);
      if (pr.t < -0.01 || pr.t > len + 0.01) continue;
      if (pr.perp > depth / 2 + EDGE_TOL_CM) continue;
      // сторона грани — где САМ конец, а если он на оси, то где второй конец стены w
      const other = w[node === "p1" ? "p2" : "p1"];
      const side = Math.abs(pr.signed) > 1e-9
        ? Math.sign(pr.signed)
        : (Math.sign(projectPt(p1, p2, other).signed) || 1);
      const faceA = add(p1, scale(n, side * depth / 2));
      const faceB = add(p2, scale(n, side * depth / 2));
      const isect = lineIntersection({ p1: w.p1, p2: w.p2 }, { p1: faceA, p2: faceB });
      if (!isect) continue;
      if (dist(isect, e) <= 0.005) continue;
      w[node] = { x: r2(isect.x), y: r2(isect.y) };
      if (!touched.includes(w)) touched.push(w);
    }
  }
  for (const w of touched) refreshWallHolesSafe(w);
  return touched;
}

function refreshWallHolesSafe(wall: Wall): void {
  try {
    refreshWallHoles(wall);
    // формат opening тоже приводится к виду для проёмов изменённой стены (ревью 38):
    // legacy door_coupe без opening после moveWall не должен уходить редактору
    normalizeWallOpeningFormats(wall);
  } catch {
    /* проёмы без корректных точек остаются как есть — их поймает validate */
  }
}

/**
 * Правило 2 для всей модели: конец любой стены, попавший в тело другой (не на узел
 * и не на грань), ставится на ближнюю грань. Гарантирует одинаковый итог при любом
 * порядке вставки (T24) и чинит осевые T-концы.
 */
function snapAllEndsToFaces(model: Model): void {
  for (const w of Object.values(model.walls)) {
    if (wallLen(w) < 1e-9) continue;
    extendExistingEnds(model, w.p1, w.p2, w.depth, new Set([w.id]));
  }
}

/**
 * Слияние коллинеарных стен одной толщины/материала, стыкующихся концами — как
 * Wall.merge() редактора (WallCursor.up): иначе «любой порядок вставки» даёт ось
 * из нескольких кусков (например, низы трёх комнат до постройки коридора).
 */
function mergeCollinear(model: Model): void {
  for (;;) {
    const walls = Object.values(model.walls);
    let merged = false;
    for (const a of walls) {
      if (!(a.id in model.walls) || wallLen(a) < 1e-9) continue;
      for (const b of walls) {
        if (b.id === a.id || !(b.id in model.walls) || wallLen(b) < 1e-9) continue;
        if (Math.abs(a.depth - b.depth) > 0.01 || a.material !== b.material || a.plan !== b.plan) continue;
        if (!collinearDirs(a, b.p1, b.p2)) continue;
        if (projectPt(a.p1, a.p2, b.p1).perp > AXIS_TOL_CM) continue;
        let p1: Point | null = null;
        let p2: Point | null = null;
        if (dist(a.p2, b.p1) <= NODE_TOL_CM) { p1 = a.p1; p2 = b.p2; }
        else if (dist(a.p2, b.p2) <= NODE_TOL_CM) { p1 = a.p1; p2 = b.p1; }
        else if (dist(a.p1, b.p1) <= NODE_TOL_CM) { p1 = b.p2; p2 = a.p2; }
        else if (dist(a.p1, b.p2) <= NODE_TOL_CM) { p1 = b.p1; p2 = a.p2; }
        if (!p1 || !p2 || dist(p1, p2) < wallLen(a)) continue; // только удлинение
        a.p1 = { x: r2(p1.x), y: r2(p1.y) };
        a.p2 = { x: r2(p2.x), y: r2(p2.y) };
        for (const hole of Object.values(b.holes)) {
          a.holes[hole.id] = hole;
        }
        delete model.walls[b.id];
        // ссылки соседей на поглощённую стену → на оставшуюся; связи будут
        // пересчитаны редактором при ближайшей нормализации
        for (const w of Object.values(model.walls)) {
          for (const nd of ["p1", "p2"] as const) {
            const link = w[nd].link;
            if (link && link.id === b.id) link.id = a.id;
          }
        }
        delete a.p1.link;
        delete a.p2.link;
        refreshWallHolesSafe(a);
        merged = true;
        break;
      }
      if (merged) break;
    }
    if (!merged) return;
  }
}

/** addWall: добавить стену по осевой линии (мм); узлы и T-концы прижимаются правилами 1–2. */
export function addWall(model: Model, params: AddWallParams): Wall {
  ensureModel(model);
  return atomic(model, () => {
    let p1 = cm(params.start);
    let p2 = cm(params.end);
    if (dist(p1, p2) < 1e-9) throw new Error("стена нулевой длины");
    p1 = snapEnd(model, p1, p2, new Set());
    p2 = snapEnd(model, p2, p1, new Set());
    assertNoCrossing(model, p1, p2, new Set());
    // коллинеарное перекрытие с существующей стеной — наложение (валидатор ловит как
    // WALL_OVER_WALL, здесь отказываем сразу, атомарно)
    for (const w of Object.values(model.walls)) {
      if (!collinearDirs(w, p1, p2)) continue;
      const pr = projectPt(p1, p2, w.p1);
      const pr2 = projectPt(p1, p2, w.p2);
      const len = dist(p1, p2);
      const lo = Math.min(pr.t, pr2.t);
      const hi = Math.max(pr.t, pr2.t);
      if (pr.perp <= AXIS_TOL_CM && hi > 0.01 && lo < len - 0.01) {
        throw geomError("INVALID_GEOMETRY", `новая стена лежит на оси стены ${w.id} с перекрытием — общая стена должна быть одним объектом`, {
          kind: "collinear_overlap", wall_id: w.id,
        });
      }
    }
    const wall = makeWall(model, p1, p2, params);
    extendExistingEnds(model, wall.p1, wall.p2, wall.depth, new Set([wall.id]));
    mergeCollinear(model);
    snapAllEndsToFaces(model);
    return wall;
  });
}

/**
 * Сторона комнаты (правило 3): покрытые интервалы общей оси вычитаются (по ИСХОДНОЙ
 * оси стороны, до прижатия концов), концы кусков прижимаются правилами 1–2;
 * остатки короче 3 см — INVALID_GEOMETRY (редактор их удалит).
 */
function buildSide(model: Model, sideP1: Point, sideP2: Point, thicknessCm: number, params: { material?: string; plan?: "a" | "c" }): Wall[] {
  const len = dist(sideP1, sideP2);
  if (len < MIN_WALL_CM) return []; // сторона целиком покрыта или вырождена
  const u = { x: (sideP2.x - sideP1.x) / len, y: (sideP2.y - sideP1.y) / len };
  // покрытые интервалы на этой оси (правило 3)
  const covered: Array<[number, number]> = [];
  for (const w of Object.values(model.walls)) {
    if (wallLen(w) < 1e-9) continue;
    if (!collinearDirs(w, sideP1, sideP2)) continue;
    const a = projectPt(sideP1, sideP2, w.p1);
    const b = projectPt(sideP1, sideP2, w.p2);
    if (a.perp > AXIS_TOL_CM) continue;
    const lo = Math.max(Math.min(a.t, b.t), 0);
    const hi = Math.min(Math.max(a.t, b.t), len);
    if (hi <= 0.01 || lo >= len - 0.01) continue; // касается только концом — не покрытие
    if (Math.abs(w.depth - thicknessCm) > 0.01) {
      throw geomError("INVALID_GEOMETRY", `сторона лежит на оси стены ${w.id} другой толщины (${w.depth} см ≠ ${thicknessCm} см) — смена толщины по стене не поддерживается`, {
        kind: "thickness_mismatch", wall_id: w.id,
      });
    }
    covered.push([lo, hi]);
  }
  covered.sort((x, y) => x[0]! - y[0]!);
  // правило 2 в любую сторону: концы ЧУЖИХ стен в теле этой стороны (например,
  // перегородки, встающие на ось будущей стены) продлеваются до её грани и тогда,
  // когда сама сторона целиком покрыта
  extendExistingEnds(model, sideP1, sideP2, thicknessCm, new Set());
  const pieces: Array<[number, number]> = [];
  let reach = 0;
  for (const [lo, hi] of covered) {
    if (lo > reach) pieces.push([reach, Math.min(lo, len)]);
    reach = Math.max(reach, Math.min(hi, len));
  }
  if (reach < len) pieces.push([reach, len]);
  const walls: Wall[] = [];
  for (const [lo, hi] of pieces) {
    if (hi - lo < 0.01) continue;
    if (hi - lo < MIN_WALL_CM) {
      throw geomError("INVALID_GEOMETRY", `остаток стороны ${Math.round((hi - lo) * 10)} мм короче ${MIN_WALL_CM} см — редактор удалит его; сдвиньте комнату или стену`, {
        kind: "piece_too_short", from_cm: r2(lo), to_cm: r2(hi),
      });
    }
    const q1 = snapEnd(model, add(sideP1, scale(u, lo)), sideP2, new Set());
    const q2 = snapEnd(model, add(sideP1, scale(u, hi)), q1, new Set());
    assertNoCrossing(model, q1, q2, new Set());
    if (dist(q1, q2) < MIN_WALL_CM) continue;
    const wall = makeWall(model, q1, q2, { thicknessMm: thicknessCm * 10, material: params.material, plan: params.plan });
    extendExistingEnds(model, wall.p1, wall.p2, wall.depth, new Set([wall.id]));
    walls.push(wall);
  }
  return walls;
}

function sideThicknesses(t: number | Partial<ThicknessSides>): ThicknessSides {
  if (typeof t === "number") return { top: t, right: t, bottom: t, left: t };
  const base = t.top ?? t.right ?? t.bottom ?? t.left ?? 200;
  return { top: t.top ?? base, right: t.right ?? base, bottom: t.bottom ?? base, left: t.left ?? base };
}

/** room_add_rect: прямоугольное помещение. Общие стены вычитаются (правило 3),
 *  перегородки примыкают к граням (правило 2) — порядок вставки не важен (T24). */
export function addRoomRect(model: Model, params: AddRoomRectParams): Wall[] {
  ensureModel(model);
  return atomic(model, () => {
    const t = sideThicknesses(params.thicknessMm ?? 200);
    const inner = (params.dimensions ?? "inner") === "inner";
    const ox = mmToCm(params.origin.x);
    const oy = mmToCm(params.origin.y);
    const w = mmToCm(params.widthMm);
    const d = mmToCm(params.depthMm);
    const x1 = inner ? ox - mmToCm(t.left) / 2 : ox;
    const y1 = inner ? oy - mmToCm(t.top) / 2 : oy;
    const x2 = inner ? ox + w + mmToCm(t.right) / 2 : ox + w;
    const y2 = inner ? oy + d + mmToCm(t.bottom) / 2 : oy + d;
    // обход по часовой стрелке (Y вниз): верх → право → низ → лево
    const corners: Array<[Point, Point, number]> = [
      [{ x: x1, y: y1 }, { x: x2, y: y1 }, t.top],
      [{ x: x2, y: y1 }, { x: x2, y: y2 }, t.right],
      [{ x: x2, y: y2 }, { x: x1, y: y2 }, t.bottom],
      [{ x: x1, y: y2 }, { x: x1, y: y1 }, t.left],
    ];
    const result: Wall[] = [];
    for (const [p1, p2, th] of corners) {
      result.push(...buildSide(model, p1, p2, mmToCm(th), { material: params.material, plan: params.plan }));
    }
    mergeCollinear(model);
    snapAllEndsToFaces(model);
    return result;
  });
}

/** addPolyline: ломаная (и замкнутый контур) из стен, мм; стороны строятся по правилам 1–4. */
export function addPolyline(model: Model, params: AddPolylineParams): Wall[] {
  ensureModel(model);
  const pts = params.points;
  if (pts.length < 2) throw new Error("ломаная требует минимум 2 точки");
  return atomic(model, () => {
    const walls: Wall[] = [];
    const segs = params.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = cm(pts[i]!);
      const b = cm(pts[(i + 1) % pts.length]!);
      walls.push(...buildSide(model, a, b, mmToCm(params.thicknessMm ?? 200), { material: params.material, plan: params.plan }));
    }
    mergeCollinear(model);
    snapAllEndsToFaces(model);
    return walls;
  });
}

/** room_add_polygon: помещение по полигону (обход по часовой стрелке), мм.
 *  dimensions="inner" (по умолчанию): заданный полигон — внутренняя граница помещения,
 *  стены смещаются наружу на полутолщину с прямым (miter) углом (находка №14 ревью). */
export function addRoomPolygon(model: Model, params: AddRoomPolygonParams): Wall[] {
  if (params.points.length < 3) throw new Error("полигон помещения требует минимум 3 точки");
  if ((params.dimensions ?? "inner") === "inner") {
    const pts = params.points.map(cm);
    const n = pts.length;
    const half = mmToCm(params.thicknessMm ?? 200) / 2;
    const sign = polygonSignedArea(pts) >= 0 ? 1 : -1; // CW при Y вниз → внешняя сторона = leftNormal
    const offsetSegs = pts.map((a, i) => {
      const b = pts[(i + 1) % n]!;
      const nl = leftNormal(b.x - a.x, b.y - a.y);
      const off = scale(nl, sign * half);
      return { p1: add(a, off), p2: add(b, off) };
    });
    const corners: Point[] = offsetSegs.map((s, i) => {
      const prev = offsetSegs[(i - 1 + n) % n]!;
      return lineIntersection(prev, s) ?? s.p1;
    });
    return addPolyline(model, {
      points: corners.map((p) => ({ x: r2(p.x) * 10, y: r2(p.y) * 10 })),
      closed: true,
      thicknessMm: params.thicknessMm,
      material: params.material,
      plan: params.plan,
    });
  }
  return addPolyline(model, { ...params, closed: true });
}

// ---------- перемещение и изменение (правило 5) ----------

type EndAttach = {
  wall: Wall;
  node: "p1" | "p2";
  kind: "node" | "edge";
  /** Для edge: сторона грани (±1 вдоль нормали оси). */
  faceSign: 1 | -1;
};

/** Соседи, чьи концы стоят в узле с endPt (node) или на грани стены (edge). */
function attachedEnds(model: Model, wall: Wall, endPt: Point, skipId?: string): EndAttach[] {
  const out: EndAttach[] = [];
  const seen = new Set<string>();
  const len = wallLen(wall);
  if (len < 1e-9) return out;
  for (const w of Object.values(model.walls)) {
    if (w.id === wall.id || w.id === skipId || wallLen(w) < 1e-9) continue;
    for (const node of ["p1", "p2"] as const) {
      const key = `${w.id}:${node}`;
      if (seen.has(key)) continue;
      const e = w[node];
      if (dist(e, endPt) <= 0.02) {
        seen.add(key);
        out.push({ wall: w, node, kind: "node", faceSign: 1 });
        continue;
      }
      // конец, совпадающий с нашим собственным концом, — узел, не edge на грани
      if (dist(e, wall.p1) <= 0.02 || dist(e, wall.p2) <= 0.02) continue;
      if (collinearDirs(w, wall.p1, wall.p2)) continue;
      const pr = projectPt(wall.p1, wall.p2, e);
      if (pr.t < -0.01 || pr.t > len + 0.01) continue;
      if (pr.perp > wall.depth / 2 + EDGE_TOL_CM) continue;
      const side = Math.sign(pr.signed) || 1;
      seen.add(key);
      out.push({ wall: w, node, kind: "edge", faceSign: side as 1 | -1 });
    }
  }
  return out;
}

/** Соседи, на чью грань/узел опирается КОНЕЦ endPt этой стены (обратная связь). */
function hostsOfEnd(model: Model, wall: Wall, endPt: Point): EndAttach[] {
  const out: EndAttach[] = [];
  for (const w of Object.values(model.walls)) {
    if (w.id === wall.id || wallLen(w) < 1e-9) continue;
    const wlen = wallLen(w);
    const d = dist(endPt, w.p1) <= dist(endPt, w.p2) ? dist(endPt, w.p1) : dist(endPt, w.p2);
    if (d <= 0.02) {
      out.push({ wall: w, node: dist(endPt, w.p1) <= dist(endPt, w.p2) ? "p1" : "p2", kind: "node", faceSign: 1 });
      continue;
    }
    const pr = projectPt(w.p1, w.p2, endPt);
    if (pr.t < -0.01 || pr.t > wlen + 0.01) continue;
    if (pr.perp > w.depth / 2 + EDGE_TOL_CM || pr.perp < w.depth / 2 - EDGE_TOL_CM) continue;
    const side = Math.abs(pr.signed) > 1e-9 ? Math.sign(pr.signed) : 1;
    out.push({ wall: w, node: "p1", kind: "edge", faceSign: side as 1 | -1 });
  }
  return out;
}

function faceLine(axis: Segment, u: Point, depth: number, side: number): Segment {
  const n = leftNormal(u.x, u.y);
  return {
    p1: add(axis.p1, scale(n, (side * depth) / 2)),
    p2: add(axis.p2, scale(n, (side * depth) / 2)),
  };
}

/** wall_move: смещение стены перпендикулярно (мм, + = влево по ходу); узлы и T-концы
 *  соседей переезжают (правило 5, R2-5), проёмы всех затронутых стен пересчитываются (R2-6). */
export function moveWall(model: Model, params: MoveWallParams): Wall {
  const wall = model.walls[params.wallId];
  if (!wall) throw new Error(`стена ${params.wallId} не найдена`);
  return atomic(model, () => {
    const dir = sub(wall.p2, wall.p1);
    const len = Math.hypot(dir.x, dir.y);
    if (len < 1e-6) throw new Error("стена нулевой длины");
    const u = scale(dir, 1 / len);
    const n = leftNormal(u.x, u.y);
    const off = mmToCm(params.offsetMm);
    const v = scale(n, off);
    const axis: Segment = { p1: add(wall.p1, v), p2: add(wall.p2, v) };
    const oldPts = [{ ...wall.p1 }, { ...wall.p2 }];
    const touches: Wall[] = [];
    // соседи собираются ДО переноса своих концов: классификация node/edge идёт по СТАРОЙ оси
    const attachments = [
      ...attachedEnds(model, wall, oldPts[0]!),
      ...attachedEnds(model, wall, oldPts[1]!),
    ];
    // свои концы: node-опора скользит по оси соседа, T-конец остаётся на грани соседа
    for (const own of ["p1", "p2"] as const) {
      const oldPt = own === "p1" ? oldPts[0]! : oldPts[1]!;
      let target = axis[own];
      for (const h of hostsOfEnd(model, wall, oldPt)) {
        if (h.kind === "node") {
          const isect = lineIntersection(axis, { p1: h.wall.p1, p2: h.wall.p2 });
          if (isect) target = isect;
        } else {
          const isect = lineIntersection(axis, faceLine({ p1: h.wall.p1, p2: h.wall.p2 }, unit(h.wall), h.wall.depth, h.faceSign));
          if (isect) target = isect;
        }
      }
      wall[own] = { x: r2(target.x), y: r2(target.y) };
    }
    // соседи: node — в новую точку узла, edge — до новой грани этой стены
    for (const a of attachments) {
      const nbAxis = { p1: a.wall.p1, p2: a.wall.p2 };
      const isect = a.kind === "node"
        ? lineIntersection(nbAxis, axis)
        : lineIntersection(nbAxis, faceLine(axis, u, wall.depth, a.faceSign));
      const np = isect ?? add(a.wall[a.node], v);
      a.wall[a.node] = { x: r2(np.x), y: r2(np.y) };
      if (!touches.includes(a.wall)) touches.push(a.wall);
    }
    refreshWallHolesSafe(wall);
    for (const w of touches) refreshWallHolesSafe(w);
    return wall;
  });
}

/** wall_update: длина с якорем, толщина по сторонам, перенос узла, материал.
 *  Узлы и T-концы соседей переезжают вместе со стеной (правило 5). */
export function updateWall(model: Model, params: UpdateWallParams): Wall {
  const wall = model.walls[params.wallId];
  if (!wall) throw new Error(`стена ${params.wallId} не найдена`);
  return atomic(model, () => {
    if (params.start || params.end) {
      if (params.start) moveEnd(model, wall, "p1", cm(params.start));
      if (params.end) moveEnd(model, wall, "p2", cm(params.end));
      refreshWallHolesSafe(wall);
    }

    if (params.thicknessMm !== undefined && params.thicknessMm > 0) {
      const oldT = wall.depth;
      const newT = mmToCm(params.thicknessMm);
      const side = params.side ?? "both";
      if (side !== "both") {
        // сдвигаем ось, чтобы противоположная грань осталась на месте; узлы соседей едут вместе
        const dir = sub(wall.p2, wall.p1);
        const n = leftNormal(dir.x, dir.y);
        const shift = (side === "left" ? -1 : 1) * ((newT - oldT) / 2);
        shiftWall(model, wall, scale(n, shift));
      }
      wall.depth = newT;
      refreshWallHolesSafe(wall);
    }

    if (params.lengthMm !== undefined && params.lengthMm > 0) {
      const newLen = mmToCm(params.lengthMm);
      const dir = sub(wall.p2, wall.p1);
      const len = Math.hypot(dir.x, dir.y);
      if (len < 1e-6) throw new Error("стена нулевой длины");
      const u = scale(dir, 1 / len);
      const anchor = params.anchor ?? "end";
      if (anchor === "end") {
        moveEnd(model, wall, "p2", add(wall.p1, scale(u, newLen)));
      } else {
        moveEnd(model, wall, "p1", add(wall.p2, scale(u, -newLen)));
      }
      refreshWallHolesSafe(wall);
    }

    if (params.material) wall.material = params.material;
    return wall;
  });
}

/**
 * Перенос конца стены (правило 5): соседи в узле переезжают в новую точку (оставаясь
 * на своих осях), T-концы на гранях этой стены продлеваются до новой грани.
 */
function moveEnd(model: Model, wall: Wall, own: "p1" | "p2", to: Point): void {
  const oldPt = { ...wall[own] };
  const oldEnds = attachedEnds(model, wall, oldPt);
  wall[own] = { x: r2(to.x), y: r2(to.y) };
  const u = unit(wall);
  for (const a of oldEnds) {
    const axis = { p1: a.wall.p1, p2: a.wall.p2 };
    // node — сосед следует за узлом (rebuildNodeConnectedWalls); edge — до новой грани
    const np = a.kind === "node"
      ? wall[own]
      : (lineIntersection(axis, faceLine({ p1: wall.p1, p2: wall.p2 }, u, wall.depth, a.faceSign)) ?? a.wall[a.node]);
    a.wall[a.node] = { x: r2(np.x), y: r2(np.y) };
    refreshWallHolesSafe(a.wall);
  }
}

/** Параллельный сдвиг всей стены на вектор; узлы соседей едут вместе. */
function shiftWall(model: Model, wall: Wall, v: Point): void {
  const oldPts = [{ ...wall.p1 }, { ...wall.p2 }];
  wall.p1 = { x: r2(wall.p1.x + v.x), y: r2(wall.p1.y + v.y) };
  wall.p2 = { x: r2(wall.p2.x + v.x), y: r2(wall.p2.y + v.y) };
  for (const oldPt of oldPts) {
    for (const a of attachedEnds(model, wall, oldPt)) {
      if (a.kind !== "node") continue;
      a.wall[a.node] = { x: r2(a.wall[a.node].x + v.x), y: r2(a.wall[a.node].y + v.y) };
      refreshWallHolesSafe(a.wall);
    }
  }
  refreshWallHolesSafe(wall);
}

/** wall_split: геометрический разрез стены на расстоянии atMm от p1; проёмы раздаются
 *  по pc. Входящие T-связи редактор переназначит сам при draw (правило 6). */
export function splitWall(model: Model, wallId: string, atMm: number): { first: Wall; second: Wall } {
  const wall = model.walls[wallId];
  if (!wall) throw new Error(`стена ${wallId} не найдена`);
  return atomic(model, () => {
    const dir = sub(wall.p2, wall.p1);
    const len = Math.hypot(dir.x, dir.y);
    const at = mmToCm(atMm);
    if (at <= 1 || at >= len - 1) throw new Error("точка разреза слишком близко к краю стены");
    const u = scale(dir, 1 / len);
    const mid = add(wall.p1, scale(u, at));

    // разрез через проём запрещён (находка №5 ревью)
    for (const hole of Object.values(wall.holes)) {
      const [from, to] = holeRange(wall, hole);
      if (at > from + 1e-6 && at < to - 1e-6) {
        throw new McpError("GEOMETRY_CONFLICT", `разрез ${atMm} мм проходит через проём ${hole.id}`, {
          hint: "выберите точку разреза вне проёмов стены",
          details: { kind: "split_through_opening", wall_id: wall.id, hole_id: hole.id },
        });
      }
    }

    const second: Wall = {
      ...structuredClone(wall),
      id: uniqueId(model),
      p1: { x: r2(mid.x), y: r2(mid.y) },
      p2: { ...wall.p2 },
      holes: {},
    };
    delete second.p1.link;
    delete second.p2.link;
    // проёмы: по положению центра; для второй части at уменьшается на длину разреза (№5 ревью)
    for (const hole of Object.values(wall.holes)) {
      const holeDist = ((hole.pc.x - wall.p1.x) * u.x + (hole.pc.y - wall.p1.y) * u.y);
      if (holeDist > at) {
        delete wall.holes[hole.id];
        hole.at = r2((hole.at ?? holeDist - hole.width / 2) - at);
        second.holes[hole.id] = hole;
      }
    }
    wall.p2 = { x: r2(mid.x), y: r2(mid.y) };
    delete wall.p2.link;
    model.walls[second.id] = second;
    refreshWallHolesSafe(wall);
    refreshWallHolesSafe(second);
    return { first: wall, second };
  });
}

/** wall_delete: удаляет стену и её проёмы, снимает ссылки соседей на неё. */
export function deleteWall(model: Model, wallId: string): { removedHoles: number } {
  const wall = model.walls[wallId];
  if (!wall) throw new Error(`стена ${wallId} не найдена`);
  return atomic(model, () => {
    let removedHoles = Object.keys(wall.holes).length;
    for (const other of Object.values(model.walls)) {
      if (other.id === wallId) continue;
      for (const p of ["p1", "p2"] as const) {
        const link = other[p].link;
        if (link && link.id === wallId) {
          delete other[p].link;
        }
      }
    }
    delete model.walls[wallId];
    return { removedHoles };
  });
}

/**
 * Концы стен без ожидаемой связи (проверка §12.4): конец должен либо совпадать с концом
 * другой стены (node), либо лежать на её грани (edge). Вызывается ПОСЛЕ normalize —
 * по стенам живого редактора; потерянная связь → откат мутации (INVALID_GEOMETRY).
 */
export function findUnattachedEnds(walls: ReadonlyArray<{ id: string; p1: Point; p2: Point; depth: number }>): Array<{ wallId: string; node: "p1" | "p2" }> {
  const list = walls.filter((w) => dist(w.p1, w.p2) > 1e-9);
  const out: Array<{ wallId: string; node: "p1" | "p2" }> = [];
  for (const w of list) {
    for (const node of ["p1", "p2"] as const) {
      const e = w[node];
      let attached = false;
      for (const o of list) {
        if (o.id === w.id) continue;
        if (dist(e, o.p1) <= NODE_TOL_CM || dist(e, o.p2) <= NODE_TOL_CM) {
          attached = true;
          break;
        }
        const pr = projectPt(o.p1, o.p2, e);
        const olen = dist(o.p1, o.p2);
        if (pr.t >= -0.01 && pr.t <= olen + 0.01 && Math.abs(pr.perp - o.depth / 2) <= 0.05) {
          attached = true; // T-конец на грани
          break;
        }
      }
      if (!attached) out.push({ wallId: w.id, node });
    }
  }
  return out;
}

// ---------- грани l1/l2/r1/r2 (обязательны перед $Project.restore) ----------

/**
 * Грани стены: сторона l — слева по ходу p1→p2 при Y вниз, смещение depth/2.
 * Вариант G (design §12.2): Node отдаёт простые грани (ось ± depth/2) — draw всё равно
 * пересчитает их с учётом соседей. Если в модели есть связи редактора (нормализованная
 * модель), грань на node-стыке пересекается с гранью соседа по правилу внутренних/внешних
 * углов (находка №7 ревью); на коллинеарном стыке грань завершается на общем срезе.
 */
export function wallFaces(wall: Wall, walls: Record<string, Wall>): { l1: Point; l2: Point; r1: Point; r2: Point } {
  const dir = sub(wall.p2, wall.p1);
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-9) throw new Error(`стена ${wall.id} нулевой длины`);
  const u = scale(dir, 1 / len);
  const n = leftNormal(u.x, u.y); // единичная нормаль к стороне l
  const halfOwn = wall.depth / 2;

  const faceLine = (a: Point, b: Point): Segment => ({ p1: a, p2: b });
  const ourL = faceLine(add(wall.p1, scale(n, halfOwn)), add(wall.p2, scale(n, halfOwn)));
  const ourR = faceLine(sub(wall.p1, scale(n, halfOwn)), sub(wall.p2, scale(n, halfOwn)));

  function endpoint(node: Point, own: "p1" | "p2", forward: 1 | -1, side: "l" | "r"): Point {
    const sideSign = side === "l" ? 1 : -1;
    const sideN = scale(n, sideSign * halfOwn);
    const link = wall[own].link;
    if (!link || link.ct !== "node") {
      // свободный узел или T-конец — грань заканчивается на срезе стены
      return add(node, sideN);
    }
    const neighbor = walls[link.id];
    if (!neighbor || Math.hypot(neighbor.p2.x - neighbor.p1.x, neighbor.p2.y - neighbor.p1.y) < 1e-9) {
      return add(node, sideN);
    }
    const nbrLen = Math.hypot(neighbor.p2.x - neighbor.p1.x, neighbor.p2.y - neighbor.p1.y);
    const dN = scale(sub(neighbor.p2, neighbor.p1), 1 / nbrLen);
    // лучи из узла внутрь каждой стены
    const nodeIsOurP1 = own === "p1";
    const rOwn = nodeIsOurP1 ? u : scale(u, -1);
    const nodeIsNbrP1 = dist(neighbor.p1, node) <= dist(neighbor.p2, node);
    const rNbr = nodeIsNbrP1 ? dN : scale(dN, -1);
    // коллинеарный стык: прямое продолжение — грань до общего среза, без удлинения (№7)
    if (Math.abs(rOwn.x * rNbr.y - rOwn.y * rNbr.x) < 1e-6) {
      return add(node, sideN);
    }
    // направление «угла помещения»: биссектриса квадранта между лучами наших тел (№7);
    const D = { x: rOwn.x + rNbr.x, y: rOwn.y + rNbr.y };
    const ourRoomSideIsL = n.x * D.x + n.y * D.y > 0;
    const nn = leftNormal(dN.x, dN.y); // нормаль к стороне l соседа
    const nbrRoomSideSign = nn.x * D.x + nn.y * D.y > 0 ? 1 : -1; // +1 — l, −1 — r
    const nbrHalf = neighbor.depth / 2;
    const nbrFaceLine = (sign: number): Segment =>
      faceLine(add(neighbor.p1, scale(nn, sign * nbrHalf)), add(neighbor.p2, scale(nn, sign * nbrHalf)));
    const ourLine = side === "l" ? ourL : ourR;
    const isRoomSide = side === "l" ? ourRoomSideIsL : !ourRoomSideIsL;
    const nbrSign = isRoomSide ? nbrRoomSideSign : -nbrRoomSideSign;
    const isect = lineIntersection(ourLine, nbrFaceLine(nbrSign));
    if (isect) return isect;
    // прямые не пересекаются (численный край) — удлинение на свою полутолщину
    return add(add(node, sideN), scale(u, (forward * wall.depth) / 2));
  }

  return {
    l1: endpoint(wall.p1, "p1", -1, "l"),
    l2: endpoint(wall.p2, "p2", 1, "l"),
    r1: endpoint(wall.p1, "p1", -1, "r"),
    r2: endpoint(wall.p2, "p2", 1, "r"),
  };
}

/** Проставляет l1/l2/r1/r2 всем стенам модели. */
export function prepareWallFaces(model: Model): void {
  for (const wall of Object.values(model.walls)) {
    try {
      const f = wallFaces(wall, model.walls);
      wall.l1 = f.l1;
      wall.l2 = f.l2;
      wall.r1 = f.r1;
      wall.r2 = f.r2;
    } catch {
      // вырожденная стена (нулевой длины): граней нет — валидатор сообщит MISSING_WALL_FACES
    }
  }
}

/**
 * Полная предобработка модели перед $Project.restore: грани стен и точки p1/p2 проёмов.
 * Без них restore падает или молча удаляет проёмы (02-feasibility).
 * Дополнительно снимаем `bak` узлов: это бэкап позиции узла у редактора, и restore
 * возвращает узлы по bak на старые места — правки (moveWall/updateWall) не доходят
 * до сохранения (найдено живым кругом 2).
 */
export function prepareForRestore(model: Model): void {
  for (const wall of Object.values(model.walls)) {
    delete wall.p1.bak;
    delete wall.p2.bak;
  }
  prepareWallFaces(model);
  prepareHolePoints(model);
}

/**
 * Канонический набор осевых отрезков стен (ревью v0.1.1-r2 R2-3): стены группируются
 * по прямым (каноническое направление в [0, π), квантование угла 1e-6 рад и смещения
 * 0.05 см), на каждой прямой коллинеарные перекрывающиеся отрезки объединяются,
 * координаты вдоль прямой округляются до 1 мм. Эквивалентность геометрии — это
 * равенство таких множеств (wallAxisSetsEqual), а не сумма длин: сдвиг, замена
 * стены равной длины и лишняя стена дают ту же сумму, но другой набор.
 */
export type WallAxisSegment = {
  /** Каноническое направление прямой (единичный вектор, угол в [0, π)). */
  ux: number;
  uy: number;
  /** Смещение прямой от начала координат, см. */
  offset: number;
  /** Концы отрезка вдоль прямой от начала координат, см (округлены до 1 мм). */
  a: number;
  b: number;
};

export function wallAxisSegments(
  walls: Record<string, Pick<Wall, "p1" | "p2">> | Record<string, { p1: Point; p2: Point }> | undefined,
): WallAxisSegment[] {
  type Line = { ux: number; uy: number; offset: number; spans: Array<[number, number]> };
  const lines = new Map<string, Line>();
  for (const w of Object.values(walls ?? {})) {
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
    // группировка по прямой: квантованный ключ — стены на одной прямой после
    // разреза/слияния попадают в одну группу, соседние параллельные — нет
    const key = `${Math.round(Math.atan2(uy, ux) * 1e6)}:${Math.round(offset * 20)}`;
    let line = lines.get(key);
    if (!line) {
      line = { ux, uy, offset, spans: [] };
      lines.set(key, line);
    }
    const t1 = (w.p1.x * ux + w.p1.y * uy);
    const t2 = (w.p2.x * ux + w.p2.y * uy);
    line.spans.push([Math.min(t1, t2), Math.max(t1, t2)]);
  }
  const out: WallAxisSegment[] = [];
  for (const line of lines.values()) {
    line.spans.sort((a, b) => a[0] - b[0]);
    let cur = line.spans[0]!;
    const merged: Array<[number, number]> = [];
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
    for (const [a, b] of merged) {
      // округление до 1 мм (ревью v0.1.1-r2 R2-3)
      out.push({ ux: line.ux, uy: line.uy, offset: line.offset, a: Math.round(a * 10) / 10, b: Math.round(b * 10) / 10 });
    }
  }
  out.sort((x, y) => (x.ux - y.ux) || (x.uy - y.uy) || (x.offset - y.offset) || (x.a - y.a));
  return out;
}

/**
 * Эквивалентность канонических наборов осевых отрезков (ревью v0.1.1-r2 R2-3):
 * каждый отрезок одной модели должен иметь парный отрезок другой на той же прямой
 * (направление совпадает, смещение в допуске) с совпадающими концами в допуске —
 * в обе стороны (лишнее покрытие тоже отвергается). Допуск по умолчанию 1 мм.
 */
export function wallAxisSetsEqual(a: WallAxisSegment[], b: WallAxisSegment[], tolCm = 0.1): boolean {
  if (a.length !== b.length) return false;
  const used = new Array<boolean>(b.length).fill(false);
  for (const s of a) {
    let matched = false;
    for (let i = 0; i < b.length; i++) {
      if (used[i]) continue;
      const t = b[i]!;
      const sameLine =
        Math.abs(t.ux - s.ux) <= 1e-6 && Math.abs(t.uy - s.uy) <= 1e-6 &&
        Math.abs(t.offset - s.offset) <= tolCm;
      if (sameLine && Math.abs(t.a - s.a) <= tolCm && Math.abs(t.b - s.b) <= tolCm) {
        used[i] = true;
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

/** Суммарная длина канонических осевых отрезков — только для сообщений и деталей ошибок. */
export function wallAxisCoverageCm(walls: Record<string, Pick<Wall, "p1" | "p2">> | Record<string, { p1: Point; p2: Point }> | undefined): number {
  return wallAxisSegments(walls).reduce((sum, s) => sum + (s.b - s.a), 0);
}
