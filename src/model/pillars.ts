import type { Model, Pillar, PillarEdge, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { wallFaces } from "./walls.ts";
import { McpError } from "../errors.ts";
import { assignCandidate } from "./assign.ts";
import { lineIntersection, overlapArea, pointInPolygon, type Polygon } from "./geometry.ts";
import type { RoomPolygon } from "./items.ts";
import { refreshRigelsAfterWallOrPillarChange } from "./rigels.ts";

/**
 * Колонны (пункт меню «Несущая колонна», model.pillars, этап 41, 2026-11-16).
 * Эталоны tests/fixtures/ui-ref-pillar-<вариант>.json: прямоугольник 20×20 см,
 * angle 0, f0offset 0, total_height = высота потолка проекта, show_dls true,
 * p1..p4 — углы, edges — четыре грани (t/r/b/l, no_wall:1), eds — примыкания к стенам.
 * Лимиты габаритов — defs редактора (проба 41-pillars-ui-scout.ts): 10..2000 × 10..600 см.
 * Restore редактора читает p1..p4 до пересчёта граней (Pillar.restore → getEds0) —
 * без углов колонна не восстанавливается, поэтому MCP считает их всегда.
 */
export const PILLAR_DEFS = {
  widthCm: 20,
  heightCm: 20,
  widthMinCm: 10,
  widthMaxCm: 2000,
  heightMinCm: 10,
  heightMaxCm: 600,
  /** Допуск прижатия грани колонны к грани стены, см (correctConnectedWalls редактора). */
  snapTolCm: 3,
  /** Порог площади пересечения, см²: касание — не пересечение. */
  overlapTolCm2: 0.01,
};

export type AddPillarParams = {
  /** Центр колонны, мм. */
  center: MmPoint;
  widthMm?: number;
  heightMm?: number;
  angleDeg?: number;
  /**
   * kind (этап 103): column — несущая колонна исходного плана (по умолчанию);
   * gypsum_box — ГКЛ-короб листа «Перегородки» (plan:"c", role_:"gypsum",
   * эталон ui-ref-replan-gypsum-box: ширина 70 см, глубина 20 см, inRoom, id_room).
   */
  kind?: "column" | "gypsum_box";
};

export type UpdatePillarParams = Partial<AddPillarParams> & { pillarId: string };

/** Пятна в мм, только явно переданные значения переводятся в см (правило единиц этапа 25). */
export function pillarSizeCm(
  widthMm: number | undefined,
  heightMm: number | undefined,
  current?: Pillar,
): { width: number; height: number } {
  return {
    width: widthMm !== undefined ? mmToCm(widthMm) : current?.width ?? PILLAR_DEFS.widthCm,
    height: heightMm !== undefined ? mmToCm(heightMm) : current?.height ?? PILLAR_DEFS.heightCm,
  };
}

function finite(name: string, v: number | undefined): void {
  if (v !== undefined && !Number.isFinite(v)) {
    throw new McpError("INVALID_ARGUMENT", `${name} должен быть конечным числом`);
  }
}

/**
 * Применимость параметров и лимиты defs (панель редактора) — до любых вычислений
 * и мутаций (правило ревью 28): при любой ошибке модель не меняется.
 */
export function validatePillarParams(p: Partial<AddPillarParams>, current?: Pillar): void {
  finite("width_mm", p.widthMm);
  finite("height_mm", p.heightMm);
  finite("angle_deg", p.angleDeg);
  if (p.widthMm !== undefined) {
    if (!(p.widthMm > 0)) throw new McpError("INVALID_ARGUMENT", "width_mm должен быть > 0");
    if (p.widthMm < PILLAR_DEFS.widthMinCm * 10) {
      throw new McpError("INVALID_ARGUMENT", `width_mm меньше минимума (${PILLAR_DEFS.widthMinCm * 10} мм по панели редактора)`);
    }
    if (p.widthMm > PILLAR_DEFS.widthMaxCm * 10) {
      throw new McpError("INVALID_ARGUMENT", `width_mm больше максимума (${PILLAR_DEFS.widthMaxCm * 10} мм по панели редактора)`);
    }
  }
  if (p.heightMm !== undefined) {
    if (!(p.heightMm > 0)) throw new McpError("INVALID_ARGUMENT", "height_mm должен быть > 0");
    if (p.heightMm < PILLAR_DEFS.heightMinCm * 10) {
      throw new McpError("INVALID_ARGUMENT", `height_mm меньше минимума (${PILLAR_DEFS.heightMinCm * 10} мм по панели редактора)`);
    }
    if (p.heightMm > PILLAR_DEFS.heightMaxCm * 10) {
      throw new McpError("INVALID_ARGUMENT", `height_mm больше максимума (${PILLAR_DEFS.heightMaxCm * 10} мм по панели редактора)`);
    }
  }
  if (p.angleDeg !== undefined && !(p.angleDeg >= -360 && p.angleDeg <= 360)) {
    throw new McpError("INVALID_ARGUMENT", "angle_deg должен быть в пределах −360..360");
  }
}

/** Углы колонны (p1..p4: верх-лево, верх-право, низ-право, низ-лево при Y вниз). */
export function pillarCorners(pc: Point, width: number, height: number, angleDeg: number): [Point, Point, Point, Point] {
  const a = ((angleDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const hw = width / 2;
  const hh = height / 2;
  const corner = (lx: number, ly: number): Point => ({
    x: r2(pc.x + lx * cos - ly * sin),
    y: r2(pc.y + lx * sin + ly * cos),
  });
  return [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)];
}

/** Четыре грани колонны в формате модели редактора (t: p1-p2, r: p2-p3, b: p3-p4, l: p4-p1). */
export function pillarEdges([p1, p2, p3, p4]: [Point, Point, Point, Point]): PillarEdge[] {
  return [
    { p1: { ...p1 }, p2: { ...p2 }, side: "t" as const, no_wall: 1 },
    { p1: { ...p2 }, p2: { ...p3 }, side: "r" as const, no_wall: 1 },
    { p1: { ...p3 }, p2: { ...p4 }, side: "b" as const, no_wall: 1 },
    { p1: { ...p4 }, p2: { ...p1 }, side: "l" as const, no_wall: 1 },
  ];
}

/** Полигон колонны в см (из p1..p4, при отсутствии — расчёт из pc/width/height/angle). */
export function pillarPolygon(pillar: Pillar): Polygon {
  if (pillar.p1 && pillar.p2 && pillar.p3 && pillar.p4) {
    return [pillar.p1, pillar.p2, pillar.p3, pillar.p4];
  }
  const [p1, p2, p3, p4] = pillarCorners(pillar.pc, pillar.width, pillar.height, pillar.angle ?? 0);
  return [p1, p2, p3, p4];
}

/** Полигон тела стены (грани из wallFaces; нулевая стена — null). */
function wallPolygon(wall: Model["walls"][string]): Polygon | null {
  try {
    const f = wallFaces(wall, {});
    return [f.l1, f.l2, f.r2, f.r1];
  } catch {
    return null;
  }
}

/**
 * Прижатие грани колонны к грани стены (как при клике в UI: у стены 7kmwa9hpxx грань b
 * легла точно на грань стены): если грань колонны параллельна грани стены и не дальше
 * snapTolCm — сдвигаем колонну перпендикулярно так, чтобы грань легла на грань стены.
 * Возвращает {shift, edge, wallId} или null. Колонна не двигается в тело стены: сдвиг
 * <= snapTolCm к ближайшей линии грани, итог проверяется assertPillarInvariants.
 */
function snapToWallFace(
  candidate: Pillar,
  model: Model,
): { dx: number; dy: number; side: "t" | "r" | "b" | "l"; wallId: string } | null {
  const corners = pillarCorners(candidate.pc, candidate.width, candidate.height, candidate.angle ?? 0);
  const edgePairs: [["t", 0, 1], ["r", 1, 2], ["b", 2, 3], ["l", 3, 0]] = [
    ["t", 0, 1], ["r", 1, 2], ["b", 2, 3], ["l", 3, 0],
  ];
  let best: { d: number; dx: number; dy: number; side: "t" | "r" | "b" | "l"; wallId: string } | null = null;
  for (const [side, i, j] of edgePairs) {
    const ea = corners[i]!;
    const eb = corners[j]!;
    const ex = eb.x - ea.x;
    const ey = eb.y - ea.y;
    const elen = Math.hypot(ex, ey);
    if (elen < 1e-9) continue;
    for (const wall of Object.values(model.walls)) {
      let faces: { l1: Point; l2: Point; r1: Point; r2: Point };
      try {
        faces = wallFaces(wall, {});
      } catch {
        continue;
      }
      const faceSegs: [Point, Point][] = [[faces.l1, faces.l2], [faces.r1, faces.r2]];
      for (const [fa, fb] of faceSegs) {
        const fx = fb.x - fa.x;
        const fy = fb.y - fa.y;
        const flen = Math.hypot(fx, fy);
        if (flen < 1e-9) continue;
        // параллельность граней
        if (Math.abs(ex * fy - ey * fx) / (elen * flen) > 1e-6) continue;
        // оба конца грани колонны не дальше snapTolCm от прямой грани стены
        const distToLine = (p: Point): number =>
          Math.abs((p.x - fa.x) * fy - (p.y - fa.y) * fx) / flen;
        const d1 = distToLine(ea);
        const d2 = distToLine(eb);
        const d = Math.max(d1, d2);
        if (d > PILLAR_DEFS.snapTolCm || d < 1e-9) continue;
        // грани перекрываются вдоль направления (проекции с запасом 5 см)
        const along = (p: Point): number => ((p.x - fa.x) * fx + (p.y - fa.y) * fy) / (flen * flen);
        const t1 = Math.min(along(ea), along(eb));
        const t2 = Math.max(along(ea), along(eb));
        if (t2 < -5 / flen || t1 > 1 + 5 / flen) continue;
        // сдвиг перпендикулярно к линии грани (знак — от ea к её проекции)
        const proj = {
          x: fa.x + ((ea.x - fa.x) * fx + (ea.y - fa.y) * fy) / (flen * flen) * fx,
          y: fa.y + ((ea.x - fa.x) * fx + (ea.y - fa.y) * fy) / (flen * flen) * fy,
        };
        const dx = r2(proj.x - ea.x);
        const dy = r2(proj.y - ea.y);
        if (!best || d < best.d) best = { d, dx, dy, side, wallId: wall.id };
      }
    }
  }
  return best;
}

/**
 * Общий предикат контакта конечных отрезков (ревью 43 №3): грань колонны [ea,eb]
 * касается грани стены [fa,fb], когда (1) отрезки параллельны, (2) оба конца грани
 * колонны не дальше tolCm от прямой грани стены, (3) проекции перекрываются вдоль
 * грани стены (запас tolCm). Бесконечные прямые не используются: колонна за концом
 * стены — не примыкание (ловится условием 3), повёрнутая грань с серединой на линии —
 * тоже (условия 1 и 2). Один предикат для eds/inRoom/инвариантов/model_validate.
 */
export function edgeOnWallFace(ea: Point, eb: Point, fa: Point, fb: Point, tolCm: number): boolean {
  const ex = eb.x - ea.x;
  const ey = eb.y - ea.y;
  const fx = fb.x - fa.x;
  const fy = fb.y - fa.y;
  const elen = Math.hypot(ex, ey);
  const flen = Math.hypot(fx, fy);
  if (elen < 1e-9 || flen < 1e-9) return false;
  // (1) параллельность
  if (Math.abs(ex * fy - ey * fx) / (elen * flen) > 1e-6) return false;
  // (2) оба конца грани колонны не дальше tolCm от прямой грани стены
  const distToLine = (p: Point): number => Math.abs((p.x - fa.x) * fy - (p.y - fa.y) * fx) / flen;
  if (Math.max(distToLine(ea), distToLine(eb)) > tolCm) return false;
  // (3) перекрытие проекций вдоль грани стены
  const along = (p: Point): number => ((p.x - fa.x) * fx + (p.y - fa.y) * fy) / (flen * flen);
  const t1 = Math.min(along(ea), along(eb));
  const t2 = Math.max(along(ea), along(eb));
  const slack = tolCm / flen;
  return t2 >= -slack && t1 <= 1 + slack;
}

/** Углы колонны из p1..p4, а при их отсутствии — расчёт из pc/width/height/angle. */
function storedCorners(pillar: Pillar): [Point, Point, Point, Point] {
  if (pillar.p1 && pillar.p2 && pillar.p3 && pillar.p4) {
    return [pillar.p1, pillar.p2, pillar.p3, pillar.p4];
  }
  return pillarCorners(pillar.pc, pillar.width, pillar.height, pillar.angle ?? 0);
}

/**
 * Примыкание грани к стене для eds (формат модели редактора): грань лежит на грани стены
 * (после прижатия — расстояние 0), предикат контакта конечных отрезков с допуском 0,05 см.
 * Пересчитывается редактором при restore; пишем каноничный вид как в эталоне UI
 * (wall.balc — признак балконной стены).
 */
function pillarEds(candidate: Pillar, model: Model): Record<string, unknown> {
  const corners = pillarCorners(candidate.pc, candidate.width, candidate.height, candidate.angle ?? 0);
  const edgePairs: [["t", 0, 1], ["r", 1, 2], ["b", 2, 3], ["l", 3, 0]] = [
    ["t", 0, 1], ["r", 1, 2], ["b", 2, 3], ["l", 3, 0],
  ];
  const eds: Record<string, unknown> = {};
  for (const [side, i, j] of edgePairs) {
    const ea = corners[i]!;
    const eb = corners[j]!;
    for (const wall of Object.values(model.walls)) {
      let faces: { l1: Point; l2: Point; r1: Point; r2: Point };
      try {
        faces = wallFaces(wall, {});
      } catch {
        continue;
      }
      for (const [fa, fb] of [[faces.l1, faces.l2], [faces.r1, faces.r2]] as [Point, Point][]) {
        if (edgeOnWallFace(ea, eb, fa, fb, 0.05)) {
          eds[side] = {
            p1: { x: r2(ea.x), y: r2(ea.y) },
            p2: { x: r2(eb.x), y: r2(eb.y) },
            wall: { id: wall.id, balc: wall.role === "balcony" },
          };
        }
      }
    }
  }
  return eds;
}

/** inRoom: 1 — ни одна грань не лежит на грани стены (предикат контакта, допуск 0,9 см), иначе 0. */
function pillarInRoom(candidate: Pillar, model: Model): number {
  const corners = pillarCorners(candidate.pc, candidate.width, candidate.height, candidate.angle ?? 0);
  const pairs: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 0]];
  for (const [i, j] of pairs) {
    const ea = corners[i]!;
    const eb = corners[j]!;
    for (const wall of Object.values(model.walls)) {
      let faces: { l1: Point; l2: Point; r1: Point; r2: Point };
      try {
        faces = wallFaces(wall, {});
      } catch {
        continue;
      }
      for (const [fa, fb] of [[faces.l1, faces.l2], [faces.r1, faces.r2]] as [Point, Point][]) {
        if (edgeOnWallFace(ea, eb, fa, fb, PILLAR_DEFS.snapTolCm - 0.1)) return 0;
      }
    }
  }
  return 1;
}

/**
 * Итоговые инварианты кандидат-копии (один раз, до записи в модель):
 * конечность геометрии, нет пересечения с телами стен и другими колоннами,
 * центр в помещении (если комнаты известны). Касание грани — не пересечение.
 */
export function assertPillarInvariants(
  candidate: Pillar,
  model: Model,
  rooms?: RoomPolygon[],
): void {
  const fields: [string, unknown][] = [
    ["width", candidate.width], ["height", candidate.height], ["angle", candidate.angle],
    ["pc.x", candidate.pc?.x], ["pc.y", candidate.pc?.y],
    ["total_height", candidate.total_height],
    ["p1.x", candidate.p1?.x], ["p1.y", candidate.p1?.y],
    ["p2.x", candidate.p2?.x], ["p2.y", candidate.p2?.y],
    ["p3.x", candidate.p3?.x], ["p3.y", candidate.p3?.y],
    ["p4.x", candidate.p4?.x], ["p4.y", candidate.p4?.y],
  ];
  for (const [name, v] of fields) {
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      throw new McpError("INTERNAL", `вычислена неконечная геометрия колонны: ${name}`, {
        details: { kind: "pillar_not_finite", pillar_id: candidate.id, field: name },
      });
    }
  }
  const poly = pillarPolygon(candidate);
  for (const wall of Object.values(model.walls)) {
    const wp = wallPolygon(wall);
    if (!wp) continue;
    const area = overlapArea(poly, wp);
    if (area > PILLAR_DEFS.overlapTolCm2) {
      throw new McpError("GEOMETRY_CONFLICT", `колонна пересекает стену ${wall.id} (${Math.round(area * 100) / 100} см²) — поставить колонну на стену нельзя, прижмите её к грани стены`, {
        details: { kind: "pillar_over_wall", pillar_id: candidate.id, wall_id: wall.id, overlap_cm2: Math.round(area * 100) / 100 },
      });
    }
  }
  for (const other of Object.values(model.pillars)) {
    if (other.id === candidate.id) continue;
    const area = overlapArea(poly, pillarPolygon(other));
    if (area > PILLAR_DEFS.overlapTolCm2) {
      throw new McpError("GEOMETRY_CONFLICT", `колонна пересекает другую колонну (${other.id})`, {
        details: { kind: "pillar_over_pillar", pillar_id: candidate.id, other_id: other.id },
      });
    }
  }
  // «вне помещений»: редактор ставит колонну в комнате ИЛИ вплотную к стене (эталон
  // ui-ref-pillar-wall: центр примыкающей колонны лежит вне полигонов rooms2, грань —
  // на грани стены). Полностью вне контура (далеко от комнат и стен) — нельзя.
  if (rooms && rooms.length > 0) {
    const inside = rooms.some((room) => pointInPolygon(room.polygon, candidate.pc));
    if (!inside && Object.keys(candidate.eds ?? {}).length === 0) {
      // примыкание к стене по граням — общий предикат контакта (ревью 43 №3)
      const corners = storedCorners(candidate);
      const pairs: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 0]];
      let touching = false;
      for (const [i, j] of pairs) {
        const ea = corners[i]!;
        const eb = corners[j]!;
        for (const wall of Object.values(model.walls)) {
          let faces: { l1: Point; l2: Point; r1: Point; r2: Point };
          try {
            faces = wallFaces(wall, {});
          } catch {
            continue;
          }
          for (const [fa, fb] of [[faces.l1, faces.l2], [faces.r1, faces.r2]] as [Point, Point][]) {
            if (edgeOnWallFace(ea, eb, fa, fb, PILLAR_DEFS.snapTolCm - 0.1)) touching = true;
          }
        }
      }
      if (!touching) {
        throw new McpError("GEOMETRY_CONFLICT", "колонна вне помещений — редактор ставит колонну внутри комнаты или вплотную к стене", {
          details: { kind: "pillar_outside_room", pillar_id: candidate.id, pc: candidate.pc },
        });
      }
    }
  }
}

/** Собирает кандидат-копию колонны (углы, грани, eds, inRoom) без записи в модель. */
function buildCandidate(
  model: Model,
  id: string,
  pcCm: Point,
  width: number,
  height: number,
  angleDeg: number,
): Pillar {
  const candidate: Pillar = {
    id,
    inRoom: 0,
    plan: "a",
    role: "pillar",
    width: r2(width),
    height: r2(height),
    total_height: typeof model.total_height === "number" ? model.total_height : 270,
    angle: r2(angleDeg),
    f0offset: 0,
    pc: { x: r2(pcCm.x), y: r2(pcCm.y) },
    p1: { x: 0, y: 0 },
    p2: { x: 0, y: 0 },
    p3: { x: 0, y: 0 },
    p4: { x: 0, y: 0 },
    edges: [],
    eds: {},
    show_dls: true,
  };
  const corners = pillarCorners(candidate.pc, candidate.width, candidate.height, candidate.angle);
  [candidate.p1, candidate.p2, candidate.p3, candidate.p4] = corners;
  candidate.edges = pillarEdges(corners);
  return candidate;
}


/**
 * Финализация кандидат-копии после прижатия: eds (примыкания), inRoom и edges —
 * как в эталоне UI: грань-примыкание уходит в eds и исключается из edges
 * (в эталоне ui-ref-pillar-wall в edges три свободные грани, грань b — в eds).
 */
function finalizeCandidate(candidate: Pillar, model: Model): void {
  candidate.eds = pillarEds(candidate, model);
  const glued = new Set(Object.keys(candidate.eds ?? {}));
  candidate.edges = (candidate.edges ?? []).filter((e) => !glued.has(e.side));
  candidate.inRoom = pillarInRoom(candidate, model);
}

/**
 * Атомарная финализация колонных операций с ригелями (ревью 48 №5): мутация и
 * пересчёт ригелей — одна операция; при ошибке колонны и ригели восстанавливаются
 * побайтно, а не только обещаны в документации.
 */
function atomicPillar<T>(model: Model, fn: () => T): T {
  const backupPillars = structuredClone(model.pillars ?? {});
  const backupRigels = structuredClone(model.rigels ?? {});
  try {
    const result = fn();
    refreshRigelsAfterWallOrPillarChange(model);
    return result;
  } catch (e) {
    model.pillars = backupPillars;
    model.rigels = backupRigels;
    throw e;
  }
}

/** pillar_add: ставит колонну (мм), прижимает к грани стены при расстоянии ≤ 3 см, проверяет коллизии. */
export function addPillar(model: Model, params: AddPillarParams, rooms?: RoomPolygon[]): Pillar {
  validatePillarParams(params);
  const box = params.kind === "gypsum_box";
  const pcCm = { x: mmToCm(params.center.x), y: mmToCm(params.center.y) };
  const defaults = box ? { widthMm: 700, heightMm: 200 } : {};
  const { width, height } = pillarSizeCm(params.widthMm ?? defaults.widthMm, params.heightMm ?? defaults.heightMm);
  const angleDeg = params.angleDeg ?? 0;
  const candidate = buildCandidate(model, newId(10), pcCm, width, height, angleDeg);
  if (box) {
    // ГКЛ-короб (эталон ui-ref-replan-gypsum-box): план «Перегородок», роль gypsum,
    // id_room комнаты, в которой стоит центр; угол поворота в эталоне 0
    candidate.plan = "c";
    candidate.role = "gypsum";
    candidate.role_ = "gypsum";
    const room = rooms?.find((r) => pointInPolygon(r.polygon, pcCm));
    if (!room) {
      throw new McpError("OUTSIDE_ROOM", "центр ГКЛ-короба вне помещения — короб ставится внутри комнаты листа «Перегородки»", {
        hint: "задайте center внутри контура комнаты или добавьте комнату (room_add_rect)",
        details: { kind: "box_outside_room", pc: pcCm },
      });
    }
    candidate.id_room = room.roomId;
  }
  const snap = snapToWallFace(candidate, model);
  if (snap) {
    candidate.pc = { x: r2(candidate.pc.x + snap.dx), y: r2(candidate.pc.y + snap.dy) };
    const corners = pillarCorners(candidate.pc, candidate.width, candidate.height, candidate.angle);
    [candidate.p1, candidate.p2, candidate.p3, candidate.p4] = corners;
    candidate.edges = pillarEdges(corners);
  }
  finalizeCandidate(candidate, model);
  assertPillarInvariants(candidate, model, rooms); // инварианты кандидата — до записи в модель
  return atomicPillar(model, () => {
    model.pillars[candidate.id] = candidate;
    return candidate;
  });
}

/**
 * pillar_update: меняет положение/габариты/поворот с повторной проверкой коллизий.
 * Мм→см только для явно переданных значений (правило единиц); candidate-копия,
 * при ошибке модель не меняется.
 */
export function updatePillar(model: Model, params: UpdatePillarParams, rooms?: RoomPolygon[]): Pillar {
  const pillar = model.pillars[params.pillarId];
  if (!pillar) throw new McpError("NOT_FOUND", `колонна ${params.pillarId} не найдена`);
  validatePillarParams(params);
  // кандидат-копия: все проверки — на копии, исходный объект не меняется до инвариантов
  const candidate = structuredClone(pillar);
  const { width, height } = pillarSizeCm(params.widthMm, params.heightMm, pillar);
  candidate.width = r2(width);
  candidate.height = r2(height);
  if (params.angleDeg !== undefined) candidate.angle = r2(params.angleDeg);
  if (params.center !== undefined) {
    candidate.pc = { x: r2(mmToCm(params.center.x)), y: r2(mmToCm(params.center.y)) };
  }
  const corners = pillarCorners(candidate.pc, candidate.width, candidate.height, candidate.angle);
  [candidate.p1, candidate.p2, candidate.p3, candidate.p4] = corners;
  candidate.edges = pillarEdges(corners);
  const snap = snapToWallFace(candidate, model);
  if (snap) {
    candidate.pc = { x: r2(candidate.pc.x + snap.dx), y: r2(candidate.pc.y + snap.dy) };
    const snapped = pillarCorners(candidate.pc, candidate.width, candidate.height, candidate.angle);
    [candidate.p1, candidate.p2, candidate.p3, candidate.p4] = snapped;
    candidate.edges = pillarEdges(snapped);
  }
  finalizeCandidate(candidate, model);
  assertPillarInvariants(candidate, model, rooms);
  return atomicPillar(model, () => {
    assignCandidate(pillar, candidate);
    return pillar;
  });
}

/** pillar_delete: удаляет колонну (связи ригелей с её гранями пересчитываются атомарно). */
export function deletePillar(model: Model, pillarId: string): void {
  if (!model.pillars[pillarId]) throw new McpError("NOT_FOUND", `колонна ${pillarId} не найдена`);
  atomicPillar(model, () => {
    delete model.pillars[pillarId];
  });
}

/**
 * Контакт колонны со стенами (для сравнения до/после стеновой операции):
 * inRoom плюс набор примыканий side→(wall.id, balc). Позиции eds.p1/p2 — углы
 * самой колонны, при стеновой операции они не меняются, в сигнатуру не входят.
 */
function pillarContactSig(pillar: Pillar): string {
  const sig = Object.entries(pillar.eds ?? {})
    .map(([side, e]) => {
      const w = (e as { wall?: { id?: string; balc?: unknown } }).wall;
      return `${side}:${w?.id ?? ""}:${w?.balc ? 1 : 0}`;
    })
    .sort()
    .join("|");
  return `${pillar.inRoom}:${sig}`;
}

/**
 * Финализация стеновых мутаций для колонн (ревью 43 №1): после moveWall/updateWall/
 * splitWall/deleteWall/add* пересчитать eds/edges/inRoom колонн, у которых контакт
 * со стенами изменился (примыкания к удалённой стене исчезают, свободные грани
 * возвращаются, привязка после split переходит к нужной части) и проверить коллизии
 * с телами стен — перенос стены в колонну даёт GEOMETRY_CONFLICT. У колонн с
 * неизменным контактом edges не переписываются: редакторские усечения граней
 * сохраняются байт в байт (ревью 44 №7). Вызывается внутри atomic() стен: ошибка
 * откатывает и стены, и колонны к исходному виду.
 */
export function refreshPillarsAfterWallChange(model: Model): void {
  const pillars = model.pillars;
  if (!pillars || Object.keys(pillars).length === 0) return;
  for (const pillar of Object.values(pillars)) {
    const candidate = structuredClone(pillar);
    candidate.edges = pillarEdges(storedCorners(candidate));
    finalizeCandidate(candidate, model);
    if (pillarContactSig(candidate) === pillarContactSig(pillar)) continue;
    assignCandidate(pillar, candidate);
  }
  for (const pillar of Object.values(pillars)) {
    const poly = pillarPolygon(pillar);
    for (const wall of Object.values(model.walls)) {
      const wp = wallPolygon(wall);
      if (!wp) continue;
      const area = overlapArea(poly, wp);
      if (area > PILLAR_DEFS.overlapTolCm2) {
        throw new McpError("GEOMETRY_CONFLICT", `колонна ${pillar.id} пересекает стену ${wall.id} (${Math.round(area * 100) / 100} см²) после изменения стены — отодвиньте стену или удалите колонну`, {
          details: { kind: "pillar_over_wall_after_wall_change", pillar_id: pillar.id, wall_id: wall.id, overlap_cm2: Math.round(area * 100) / 100 },
        });
      }
    }
  }
}
