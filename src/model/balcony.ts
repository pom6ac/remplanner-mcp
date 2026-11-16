import type { Model, Wall, Point } from "./types.ts";
import { mmToCm } from "./units.ts";
import { addWall, updateWall, deleteWall, atomic, type MmPoint, type UpdateWallParams } from "./walls.ts";
import { lineIntersection, type Segment } from "./geometry.ts";
import { McpError } from "../errors.ts";

// Балкон (пункт меню «Нарисовать балкон», этап 71, 2026-11-17).
// Балкон в модели — НЕ отдельная коллекция: это стены role "balcony" на листе
// «Исходный план» (plan:"a"), рисуются инструментом plannertool_balcony протяжкой
// (эталон tests/fixtures/ui-ref-balcony.json, анонимный проект, global_version 757):
//   depth 10 см (defs.wall.depth), height 100 см (ограждение, не total_height),
//   material a_block, color 0, angle проставляет редактор.
// Концы пристают к наружной стене гранью (edge z0:"l", pos:"in"), между собой — узлом.
// Замкнутый контур «ограждение + наружная стена» даёт комнату в rooms1/rooms2
// (балкон — обычное помещение с площадью).
// Ограничения редактора (l10n):
//   hole__dont_install_over_balcony — на балконные ограждения нельзя ставить проёмы;
//   wall_balcony_not_break — балконная стена не демонтируется;
//   wall_niche_set_stop_comment — ниши/молдинги на балконах рисовать нельзя.
// Роль стены важна для restore/save — сверяется в workspace (ревью 66 №3).

export const BALCONY_DEFS = {
  /** Толщина по умолчанию, см (defs.wall.depth в редакторе). */
  depthCm: 10,
  /** Лимиты толщины, см (defs.wall.depthMin/depthMax). */
  depthMinCm: 4,
  depthMaxCm: 100,
  /** Минимальная длина стены, см (defs.wall.min_length). */
  minLengthCm: 20,
  /** Высота ограждения, см — проставляет инструмент «Нарисовать балкон» (эталон UI). */
  heightCm: 100,
};

export type AddBalconyParams = {
  /** Осевые точки ломаной ограждения, мм. Концы должны пристать к стенам (узел или грань). */
  points: MmPoint[];
  /** Замкнуть контур (балкон без примыкания к стене — редкий случай, редактор позволяет). */
  closed?: boolean;
  /** Толщина, мм (по умолчанию 100 = defs.wall.depth; лимиты 40..1000). */
  thicknessMm?: number;
  /** Высота ограждения, мм (по умолчанию 1000, как у инструмента редактора). */
  heightMm?: number;
  /** Материал (по умолчанию a_block, как у инструмента редактора). */
  material?: string;
};

export type UpdateBalconyParams = {
  wallId: string;
  /** Новая длина, мм; anchor — конец, который переносится (другой остаётся на месте, как в wall_update). */
  lengthMm?: number;
  anchor?: "start" | "end";
  /** Новая толщина, мм (лимиты defs.wall 40..1000 действуют и при update). */
  thicknessMm?: number;
  /** Перенос конца, мм. */
  start?: MmPoint;
  end?: MmPoint;
};

function finite(name: string, v: number | undefined): void {
  if (v !== undefined && !Number.isFinite(v)) {
    throw new McpError("INVALID_ARGUMENT", `${name} должен быть конечным числом`);
  }
}

/** Пересечение отрезков посреди обоих (касание в общей вершине — не пересечение). */
function segmentsCrossMid(a: Segment, b: Segment): boolean {
  const p = lineIntersection(a, b);
  if (!p) return false;
  const onSeg = (s: Segment, q: Point): boolean => {
    const cross = (s.p2.x - s.p1.x) * (q.y - s.p1.y) - (s.p2.y - s.p1.y) * (q.x - s.p1.x);
    if (Math.abs(cross) > 1e-6) return false;
    const dot = (q.x - s.p1.x) * (s.p2.x - s.p1.x) + (q.y - s.p1.y) * (s.p2.y - s.p1.y);
    const len2 = (s.p2.x - s.p1.x) ** 2 + (s.p2.y - s.p1.y) ** 2;
    return dot >= -1e-6 && dot <= len2 + 1e-6;
  };
  if (!onSeg(a, p) || !onSeg(b, p)) return false;
  // касание в общей вершине соседних сторон — не пересечение
  const ends = [a.p1, a.p2, b.p1, b.p2];
  return !ends.some((e) => Math.hypot(e.x - p.x, e.y - p.y) < 1e-6);
}

/**
 * balcony_add: ломаная балконных ограждений (мм), роль "balcony", план "a".
 * Сегменты строятся правилами стен (§12.3): концы прижимаются к узлам и граням
 * существующих стен, X-пересечения и коллинеарные наложения отклоняются.
 * Атомарность: при отказе любого сегмента стены не создаются (общий механизм
 * atomic — откатываются walls, pillars и rigels, ревью 73 №3).
 */
export function addBalcony(model: Model, params: AddBalconyParams): Wall[] {
  const pts = params.points;
  if (!Array.isArray(pts) || pts.length < 2) {
    throw new McpError("INVALID_ARGUMENT", "балкон требует минимум 2 точки оси");
  }
  for (const [i, p] of pts.entries()) {
    finite(`points[${i}].x`, p.x);
    finite(`points[${i}].y`, p.y);
  }
  const thicknessMm = params.thicknessMm ?? BALCONY_DEFS.depthCm * 10;
  finite("thickness_mm", thicknessMm);
  if (thicknessMm < BALCONY_DEFS.depthMinCm * 10 || thicknessMm > BALCONY_DEFS.depthMaxCm * 10) {
    throw new McpError("INVALID_ARGUMENT", `thickness_mm вне лимитов (${BALCONY_DEFS.depthMinCm * 10}..${BALCONY_DEFS.depthMaxCm * 10} мм по defs.wall редактора)`);
  }
  const heightMm = params.heightMm ?? BALCONY_DEFS.heightCm * 10;
  finite("height_mm", heightMm);
  if (heightMm <= 0) throw new McpError("INVALID_ARGUMENT", "height_mm должен быть > 0");
  const closed = params.closed ?? false;
  const segCount = closed ? pts.length : pts.length - 1;
  if (segCount < 1) throw new McpError("INVALID_ARGUMENT", "замкнутый контур требует минимум 3 точки");
  // длины сегментов — лимит defs.wall.min_length
  const cm = (p: MmPoint): Point => ({ x: mmToCm(p.x), y: mmToCm(p.y) });
  for (let i = 0; i < segCount; i++) {
    const a = cm(pts[i]!);
    const b = cm(pts[(i + 1) % pts.length]!);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) {
      throw new McpError("INVALID_ARGUMENT", `точки ${i + 1} и ${((i + 1) % pts.length) + 1} совпадают`);
    }
    if (len < BALCONY_DEFS.minLengthCm) {
      throw new McpError("INVALID_ARGUMENT", `сегмент ${i + 1} короче ${BALCONY_DEFS.minLengthCm * 10} мм (min_length по defs.wall редактора)`);
    }
  }
  // самопересечения контура (new-entity-section): несоседние сегменты не пересекаются
  const segs: Segment[] = [];
  for (let i = 0; i < segCount; i++) {
    segs.push({ p1: cm(pts[i]!), p2: cm(pts[(i + 1) % pts.length]!) });
  }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (j === i + 1 || (closed && i === 0 && j === segs.length - 1)) continue;
      if (segmentsCrossMid(segs[i]!, segs[j]!)) {
        throw new McpError("GEOMETRY_CONFLICT", `балкон: самопересечение контура (сегменты ${i + 1} и ${j + 1})`, {
          details: { kind: "balcony_self_intersection", segments: [i + 1, j + 1] },
        });
      }
    }
  }
  // атомарность пакета — общий механизм walls.atomic: откат всех затрагиваемых
  // коллекций (walls, pillars, rigels) побайтно, включая отсутствие ключей
  return atomic(model, () => {
    const created: Wall[] = [];
    for (let i = 0; i < segCount; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      created.push(addWall(model, {
        start: { x: a.x, y: a.y },
        end: { x: b.x, y: b.y },
        thicknessMm,
        heightMm,
        material: params.material ?? "a_block",
        plan: "a",
        role: "balcony",
      }));
    }
    return created;
  });
}

/** Балконная стена по id; иначе NOT_FOUND (в ответе — что стена не ограждение). */
export function balconyWall(model: Model, wallId: string): Wall {
  const wall = model.walls[wallId];
  if (!wall || wall.role !== "balcony") {
    throw new McpError("NOT_FOUND", `балконная стена ${wallId} не найдена (id ограждения из model_get, поле role: "balcony")`);
  }
  return wall;
}

/**
 * balcony_update: правка ограждения (длина с якорем, толщина, перенос конца) — правила
 * стен §12.3. Лимиты defs.wall (толщина 40..1000 мм, длина ≥ 200 мм) действуют и при
 * update — итоговое значение проверяется до принятия мутации (ревью 73 №4).
 */
export function updateBalcony(model: Model, params: UpdateBalconyParams): Wall {
  const wall = balconyWall(model, params.wallId);
  const p: UpdateWallParams = { wallId: wall.id };
  if (params.lengthMm !== undefined) { p.lengthMm = params.lengthMm; p.anchor = params.anchor ?? "end"; }
  if (params.thicknessMm !== undefined) p.thicknessMm = params.thicknessMm;
  if (params.start !== undefined) p.start = params.start;
  if (params.end !== undefined) p.end = params.end;
  return atomic(model, () => {
    const res = updateWall(model, p);
    // итоговые значения — как при add (ревью 73 №4); нарушение откатывает мутацию
    if (res.depth < BALCONY_DEFS.depthMinCm || res.depth > BALCONY_DEFS.depthMaxCm) {
      throw new McpError("INVALID_ARGUMENT", `итоговая толщина ${Math.round(res.depth * 10)} мм вне лимитов (${BALCONY_DEFS.depthMinCm * 10}..${BALCONY_DEFS.depthMaxCm * 10} мм по defs.wall редактора)`);
    }
    const len = Math.hypot(res.p2.x - res.p1.x, res.p2.y - res.p1.y);
    if (len < BALCONY_DEFS.minLengthCm) {
      throw new McpError("INVALID_ARGUMENT", `итоговая длина ограждения ${Math.round(len * 10)} мм короче ${BALCONY_DEFS.minLengthCm * 10} мм (min_length по defs.wall редактора)`);
    }
    return res;
  });
}

/** balcony_delete: удаляет ограждение (проёмов на нём быть не может). */
export function deleteBalcony(model: Model, wallId: string): { removedHoles: number } {
  const wall = balconyWall(model, wallId);
  return deleteWall(model, wall.id);
}
