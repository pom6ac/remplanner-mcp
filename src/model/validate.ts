import type { Model } from "./types.ts";
import { cmToMm, round0 } from "./units.ts";
import { roomPolygons, type RoomPolygon } from "./items.ts";
import { pointInPolygon, segmentsCross, dist, type Segment } from "./geometry.ts";
import { holeRange } from "./openings.ts";
import { prepareForRestore } from "./walls.ts";

export type ValidationProblem = {
  code:
    | "WALL_TOO_SHORT"
    | "WALL_OVER_WALL"
    | "WALL_DANGLING"
    | "OPENING_OUTSIDE_WALL"
    | "OPENING_OFF_AXIS"
    | "OPENINGS_OVERLAP"
    | "ITEM_OUTSIDE_ROOM"
    | "MISSING_WALL_FACES"
    | "MISSING_HOLE_POINTS";
  message: string;
  details?: Record<string, unknown>;
};

const MIN_WALL_CM = 3;

/**
 * Инварианты модели перед сохранением (design §3) и перед $Project.restore.
 * rooms — комнаты из кеша workspace (нормализованная модель), если в model.rooms2 их ещё нет.
 */
export function validateModel(model: Model, rooms?: RoomPolygon[]): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  // проверки идут на подготовленном клоне: грани и точки p1/p2 проёмов вычисляются
  // перед restore в любом случае (prepareForRestore), поэтому их отсутствие в рабочей
  // копии — не проблема, а её вычислимость и проверяем
  const prepared = structuredClone(model);
  try {
    prepareForRestore(prepared);
  } catch {
    // деградация по отдельным стенам сообщится ниже как MISSING_WALL_FACES
  }
  const walls = Object.values(prepared.walls);

  // стены слишком короткие
  for (const wall of walls) {
    const len = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
    if (len < MIN_WALL_CM) {
      problems.push({
        code: "WALL_TOO_SHORT",
        message: `стена ${wall.id} короче ${MIN_WALL_CM} см (${round0(cmToMm(len))} мм) — редактор удалит её`,
        details: { wall_id: wall.id, length_mm: round0(cmToMm(len)) },
      });
    }
  }

  // стены поверх других стен (пересечение не в общих узлах; коллинеарные дубликаты — №19)
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i]!;
      const b = walls[j]!;
      const s1: Segment = { p1: a.p1, p2: a.p2 };
      const s2: Segment = { p1: b.p1, p2: b.p2 };
      const jointTolerance = 0.01;
      // коллинеарные стены: segmentsCross на коллинеарности даёт false — проверяем проекции
      const d1 = { x: s1.p2.x - s1.p1.x, y: s1.p2.y - s1.p1.y };
      const d2 = { x: s2.p2.x - s2.p1.x, y: s2.p2.y - s2.p1.y };
      const crossDir = d1.x * d2.y - d1.y * d2.x;
      const len1 = Math.hypot(d1.x, d1.y);
      // параллельные, но на разных прямых — не пересечение
      const perpDist = len1 > 0
        ? Math.abs((b.p1.x - a.p1.x) * d1.y - (b.p1.y - a.p1.y) * d1.x) / len1
        : Infinity;
      if (Math.abs(crossDir) / (len1 || 1) < 1e-6 && perpDist < 0.05) {
        // проекции b на ось a
        const len2sq = d1.x * d1.x + d1.y * d1.y || 1;
        const t1 = ((b.p1.x - a.p1.x) * d1.x + (b.p1.y - a.p1.y) * d1.y) / len2sq;
        const t2 = ((b.p2.x - a.p1.x) * d1.x + (b.p2.y - a.p1.y) * d1.y) / len2sq;
        const lo = Math.min(t1, t2);
        const hi = Math.max(t1, t2);
        const eps = jointTolerance / (len1 || 1);
        if (hi > eps && lo < 1 - eps) {
          const sameAxis =
            (dist(a.p1, b.p1) < jointTolerance && dist(a.p2, b.p2) < jointTolerance) ||
            (dist(a.p1, b.p2) < jointTolerance && dist(a.p2, b.p1) < jointTolerance);
          problems.push({
            code: "WALL_OVER_WALL",
            message: sameAxis
              ? `стены ${a.id} и ${b.id} дублируют друг друга (совпадающие оси) — общая стена двух комнат должна быть одним объектом`
              : `стены ${a.id} и ${b.id} лежат на одной оси с перекрытием — редактор удаляет одну из них`,
            details: { wall_a: a.id, wall_b: b.id, kind: sameAxis ? "duplicate_axis" : "collinear_overlap" },
          });
        }
        continue;
      }
      if (!segmentsCross(s1, s2)) continue;
      // допустимо: общая точка-стык (совпадение концов)
      const endpoints = [a.p1, a.p2, b.p1, b.p2];
      const isect = crossPoint(s1, s2);
      const isJoint = isect
        ? endpoints.some((p) => dist(p, isect) < jointTolerance) && endpoints.some((p) => dist(p, isect) < jointTolerance)
        : false;
      if (!isJoint) {
        problems.push({
          code: "WALL_OVER_WALL",
          message: `стены ${a.id} и ${b.id} пересекаются не в узле — редактор откажется рисовать`,
          details: { wall_a: a.id, wall_b: b.id },
        });
      }
    }
  }

  // висячие узлы — только для моделей со связями редактора (нормализованных):
  // в Node-моделях связей нет вовсе (design §12.3), там проверять нечего
  const hasLinks = walls.some((w) => w.p1.link || w.p2.link);
  if (hasLinks) {
    for (const wall of walls) {
      for (const node of ["p1", "p2"] as const) {
        if (!wall[node].link) {
          problems.push({
            code: "WALL_DANGLING",
            message: `узел ${node} стены ${wall.id} не соединён с другими стенами`,
            details: { wall_id: wall.id, node },
          });
        }
      }
    }
  }

  // проёмы: в пределах стены, без пересечений; точки p1/p2 обязательны перед restore;
  // pc/p1/p2 обязаны лежать на оси стены (находка №4 ревью)
  for (const wall of walls) {
    const holes = Object.values(wall.holes ?? {});
    const len = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
    const axisLen2 = (wall.p2.x - wall.p1.x) ** 2 + (wall.p2.y - wall.p1.y) ** 2;
    const distToAxis = (p: { x: number; y: number }): number => {
      if (axisLen2 === 0) return Infinity;
      return Math.abs((p.x - wall.p1.x) * (wall.p2.y - wall.p1.y) - (p.y - wall.p1.y) * (wall.p2.x - wall.p1.x)) / Math.sqrt(axisLen2);
    };
    for (const hole of holes) {
      const offAxisPoints = [hole.pc, hole.p1, hole.p2].filter(isPoint).filter((p) => distToAxis(p) > 0.05);
      if (offAxisPoints.length > 0) {
        problems.push({
          code: "OPENING_OFF_AXIS",
          message: `проём ${hole.id} (${hole.type}) сорван с оси стены ${wall.id} (${offAxisPoints.length} точек в стороне)`,
          details: { wall_id: wall.id, hole_id: hole.id, off_points: offAxisPoints },
        });
      }
      if (hole.group === "windows" || hole.group === "doors") {
        if (!isPoint(hole.p1) || !isPoint(hole.p2)) {
          problems.push({
            code: "MISSING_HOLE_POINTS",
            message: `проём ${hole.id} (${hole.type}) без точек p1/p2 — restore молча удалит его`,
            details: { wall_id: wall.id, hole_id: hole.id },
          });
        }
      }
      const [from, to] = holeRange(wall, hole);
      if (from < 0 - 1e-6 || to > len + 1e-6) {
        problems.push({
          code: "OPENING_OUTSIDE_WALL",
          message: `проём ${hole.id} выходит за пределы стены ${wall.id}`,
          details: { wall_id: wall.id, hole_id: hole.id, from_cm: round0(from), to_cm: round0(to), wall_len_cm: round0(len) },
        });
      }
    }
    for (let i = 0; i < holes.length; i++) {
      for (let j = i + 1; j < holes.length; j++) {
        const h1 = holes[i]!;
        const h2 = holes[j]!;
        const r1 = holeRange(wall, h1);
        const r2 = holeRange(wall, h2);
        if (r1[0] < r2[1] - 1e-6 && r2[0] < r1[1] - 1e-6) {
          problems.push({
            code: "OPENINGS_OVERLAP",
            message: `проёмы ${h1.id} и ${h2.id} пересекаются на стене ${wall.id}`,
            details: { wall_id: wall.id, holes: [h1.id, h2.id] },
          });
        }
      }
    }
  }

  // грани стен обязательны перед restore
  for (const wall of walls) {
    if (!wall.l1 || !wall.l2 || !wall.r1 || !wall.r2) {
      problems.push({
        code: "MISSING_WALL_FACES",
        message: `у стены ${wall.id} нет граней l1/l2/r1/r2 — restore упадёт`,
        details: { wall_id: wall.id },
      });
    }
  }

  // предметы вне помещений; при полном отсутствии комнат предметы проверить нечем (№19)
  const knownRooms: RoomPolygon[] = rooms && rooms.length > 0 ? rooms : roomPolygons(model);
  const items = Object.values(model.items);
  if (knownRooms.length === 0 && items.length > 0) {
    for (const item of items) {
      problems.push({
        code: "ITEM_OUTSIDE_ROOM",
        message: `в модели нет замкнутых комнат — принадлежность предмета ${item.id} (${item.name}) не определить`,
        details: { item_id: item.id, pc: item.pc, kind: "no_rooms" },
      });
    }
  } else {
    for (const item of items) {
      const inside = knownRooms.some((room) => pointInPolygon(room.polygon, item.pc));
      if (!inside) {
        problems.push({
          code: "ITEM_OUTSIDE_ROOM",
          message: `предмет ${item.id} (${item.name}) вне помещений`,
          details: { item_id: item.id, pc: item.pc },
        });
      }
    }
  }

  return problems;
}

function isPoint(p: { x: number; y: number } | undefined): p is { x: number; y: number } {
  return p !== undefined && typeof p.x === "number" && typeof p.y === "number";
}

function crossPoint(s1: Segment, s2: Segment): { x: number; y: number } | null {
  const d1 = { x: s1.p2.x - s1.p1.x, y: s1.p2.y - s1.p1.y };
  const d2 = { x: s2.p2.x - s2.p1.x, y: s2.p2.y - s2.p1.y };
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((s2.p1.x - s1.p1.x) * d2.y - (s2.p1.y - s1.p1.y) * d2.x) / denom;
  return { x: s1.p1.x + d1.x * t, y: s1.p1.y + d1.y * t };
}
