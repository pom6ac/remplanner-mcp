import type { Model, ItemProps, Point } from "./types.ts";
import { cmToMm, round0 } from "./units.ts";
import { roomPolygons, type RoomPolygon } from "./rooms.ts";
import {
  pointInPolygon, segmentsCross, dist, closestPoint, projectionLength, lineIntersection,
  polygonArea, polygonSignedArea, overlapArea, type Segment, type Polygon,
} from "./geometry.ts";
import { holeRange, replacementPairOf } from "./openings.ts";
import { edgeOnWallFace, pillarPolygon, PILLAR_DEFS } from "./pillars.ts";
import { borderRingPolygons, borderRingContact } from "./terraces.ts";
import { prepareForRestore } from "./walls.ts";

export type ValidationProblem = {
  code:
    | "WALL_TOO_SHORT"
    | "WALL_OVER_WALL"
    | "WALL_DANGLING"
    | "OPENING_OUTSIDE_WALL"
    | "OPENING_ON_BALCONY"
    | "OPENING_OFF_AXIS"
    | "OPENINGS_OVERLAP"
    | "ITEM_OUTSIDE_ROOM"
    | "ITEM_INTERSECTS_WALL"
    | "PILLAR_INTERSECTS_WALL"
    | "PILLARS_OVERLAP"
    | "PILLAR_OUTSIDE_ROOM"
    | "RIGEL_BAD_GEOMETRY"
    | "BORDER_BAD_GEOMETRY"
    | "LEVEL_HOLE_BAD_GEOMETRY"
    | "LEVEL_HOLES_OVERLAP"
    | "MISSING_WALL_FACES"
    | "MISSING_HOLE_POINTS"
    | "SHEET_PLAN_DANGLING";
  message: string;
  details?: Record<string, unknown>;
};

const MIN_WALL_CM = 3;
/** Геометрический допуск «в пользу внутри»: касание грани (зазор 0 и погрешность
 *  sin/cos до 1 мм) не ошибка (ревью v0.1.1 №1). Отрицательный допуск исключал
 *  проверку угла на границе — касание получало ITEM_OUTSIDE_ROOM с вылетом 0 мм. */
const ITEM_TOUCH_TOLERANCE_CM = 0.1;

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
      // на балконных ограждениях проёмы недопустимы (hole__dont_install_over_balcony)
      if (wall.role === "balcony") {
        problems.push({
          code: "OPENING_ON_BALCONY",
          message: `проём ${hole.id} стоит на балконном ограждении ${wall.id} — редактор такие проёмы не ставит`,
          details: { wall_id: wall.id, hole_id: hole.id },
        });
      }
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
        // пара замены (этап 354): замена plan:c стоит ровно в габарите исходного
        // (replacement=1 / hasReplacement) — совпадение интервалов штатно, не дефект.
        // №10 ревью 355: пропуск только для СОБСТВЕННОЙ пары (replacementPairOf) —
        // пересечение исходного/замены с посторонним проёмом ловится как прежде
        if (replacementPairOf(wall, h1) === h2) continue;
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

  // предметы: bbox с учётом поворота (дефект 2, отчёт 11) — выход за внутренние грани
  // комнат и пересечение с телом стены, с величиной вылета в мм. При полном отсутствии
  // комнат предметы проверить нечем (№19).
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
      const rect = itemRectCm(item);
      const centerRoom = knownRooms.find((room) => pointInPolygon(room.polygon, item.pc));
      if (!centerRoom) {
        problems.push({
          code: "ITEM_OUTSIDE_ROOM",
          message: `предмет ${item.id} (${item.name}) вне помещений`,
          details: { item_id: item.id, pc: item.pc },
        });
        continue;
      }
      // выход углов bbox за комнаты: угол должен попадать хотя бы в одну комнату
      // (многокомнатный предмет — диван в проёме — не проблема)
      const outside = rect.filter((c) => !knownRooms.some((room) => pointInPolygon(room.polygon, c, ITEM_TOUCH_TOLERANCE_CM)));
      if (outside.length > 0) {
        const protrusionCm = Math.max(...outside.map((c) => distToPolygon(centerRoom.polygon, c)));
        problems.push({
          code: "ITEM_OUTSIDE_ROOM",
          message: `предмет ${item.id} (${item.name}) вылезает за внутренние грани комнаты на ${round0(protrusionCm * 10)} мм`,
          details: { item_id: item.id, pc: item.pc, protrusion_mm: round0(protrusionCm * 10), corners_outside: outside.length },
        });
      }
    }
    // пересечение bbox с телом стены (грани вычислены prepareForRestore на клоне)
    for (const item of items) {
      const rect = itemRectCm(item);
      for (const wall of walls) {
        if (!wall.l1 || !wall.l2 || !wall.r1 || !wall.r2) continue; // MISSING_WALL_FACES выше
        const wallPoly: Polygon = [wall.l1, wall.l2, wall.r2, wall.r1];
        if (overlapArea(rect, wallPoly) < 0.01) continue; // < 0.01 см² — касание, не пересечение
        const face: Segment = { p1: wall.l1, p2: wall.l2 };
        const faceR: Segment = { p1: wall.r1, p2: wall.r2 };
        const rectCenter = polyCenter(rect);
        const picked = dist(closestPoint(face, rectCenter).point, rectCenter) <= dist(closestPoint(faceR, rectCenter).point, rectCenter) ? face : faceR;
        // нормаль грани в сторону предмета
        const d = { x: picked.p2.x - picked.p1.x, y: picked.p2.y - picked.p1.y };
        const len = Math.hypot(d.x, d.y) || 1;
        let n = { x: d.y / len, y: -d.x / len };
        const faceMid = { x: (picked.p1.x + picked.p2.x) / 2, y: (picked.p1.y + picked.p2.y) / 2 };
        if (n.x * (rectCenter.x - faceMid.x) + n.y * (rectCenter.y - faceMid.y) > 0) n = { x: -n.x, y: -n.y };
        // вылет — насколько углы прошли за грань в тело стены (см)
        const axis: Segment = { p1: wall.p1, p2: wall.p2 };
        const beyond = rect
          .map((c) => ({ corner: c, proj: (c.x - picked.p1.x) * n.x + (c.y - picked.p1.y) * n.y }))
          .filter((e) => e.proj > 0.05);
        if (beyond.length === 0) continue;
        // часть вылета в пределах проёма (дверь/окно на всю толщину) стеной не считается:
        // проекция вылетевших углов вдоль оси стены должна покрываться проёмом
        const lo = Math.min(...beyond.map((e) => projectionLength(axis, e.corner)));
        const hi = Math.max(...beyond.map((e) => projectionLength(axis, e.corner)));
        const inHole = Object.values(wall.holes ?? {}).some((h) => {
          const [f, t] = holeRange(wall, h);
          return lo >= f - 1 && hi <= t + 1;
        });
        if (inHole) continue;
        const protrusionMm = round0(Math.max(...beyond.map((e) => e.proj)) * 10);
        problems.push({
          code: "ITEM_INTERSECTS_WALL",
          message: `предмет ${item.id} (${item.name}) пересекает стену ${wall.id} (вылет ${protrusionMm} мм)`,
          details: { item_id: item.id, wall_id: wall.id, protrusion_mm: protrusionMm },
        });
      }
    }
  }

  // колонны (этап 41): пересечение с телами стен и между собой, центр вне помещений —
  // по правилам редактора (поставить на стену/на колонну/вне комнаты нельзя, касание можно)
  const pillars = Object.values(model.pillars ?? {});
  for (const pillar of pillars) {
    const poly = pillarPolygon(pillar);
    for (const wall of walls) {
      if (!wall.l1 || !wall.l2 || !wall.r1 || !wall.r2) continue; // MISSING_WALL_FACES выше
      const area = overlapArea(poly, [wall.l1, wall.l2, wall.r2, wall.r1]);
      if (area > 0.01) {
        problems.push({
          code: "PILLAR_INTERSECTS_WALL",
          message: `колонна ${pillar.id} пересекает стену ${wall.id} (${Math.round(area * 100) / 100} см²) — колонну нельзя ставить на стену`,
          details: { pillar_id: pillar.id, wall_id: wall.id, overlap_cm2: Math.round(area * 100) / 100 },
        });
      }
    }
  }
  for (let i = 0; i < pillars.length; i++) {
    for (let j = i + 1; j < pillars.length; j++) {
      const a = pillars[i]!;
      const b = pillars[j]!;
      const area = overlapArea(pillarPolygon(a), pillarPolygon(b));
      if (area > 0.01) {
        problems.push({
          code: "PILLARS_OVERLAP",
          message: `колонны ${a.id} и ${b.id} пересекаются`,
          details: { pillar_a: a.id, pillar_b: b.id, overlap_cm2: Math.round(area * 100) / 100 },
        });
      }
    }
  }
  if (knownRooms.length > 0) {
    for (const pillar of pillars) {
      // ревью 66 №7: столб террасы валидируется по геометрии террас, а не по комнатам дома
      if (pillar.role === "terrace_column") continue;
      if (knownRooms.some((room) => pointInPolygon(room.polygon, pillar.pc))) continue;
      // колонна вплотную к стене (грань на линии грани) — валидна вне полигонов комнат
      // (эталон ui-ref-pillar-wall: центр примыкающей колонны вне rooms2). Контакт —
      // тот же конечный предикат edgeOnWallFace, что в eds/inRoom/инвариантах
      // (ревью 44 №3): колонна за концом стены — не примыкание
      const corners = pillarPolygon(pillar);
      let touching = false;
      for (let k = 0; k < 4 && !touching; k++) {
        const ea = corners[k]!;
        const eb = corners[(k + 1) % 4]!;
        for (const wall of walls) {
          if (!wall.l1 || !wall.l2 || !wall.r1 || !wall.r2) continue;
          for (const [fa, fb] of [[wall.l1, wall.l2], [wall.r1, wall.r2]] as [Point, Point][]) {
            if (edgeOnWallFace(ea, eb, fa, fb, PILLAR_DEFS.snapTolCm - 0.1)) touching = true;
          }
        }
      }
      if (!touching) {
        problems.push({
          code: "PILLAR_OUTSIDE_ROOM",
          message: `колонна ${pillar.id} вне помещений — редактор ставит колонну внутри комнаты или вплотную к стене`,
          details: { pillar_id: pillar.id, pc: pillar.pc },
        });
      }
    }
  }

  // столбы террас (ревью 66 №7): центр — внутри замкнутого кольца террасы или на его
  // границе (допуск прижатия 3 см, как в terrace_column_add); правил комнат дома — нет
  const terraceRings = borderRingPolygons(model.terrace_borders ?? {});
  for (const pillar of pillars) {
    if (pillar.role !== "terrace_column") continue;
    const inside = terraceRings.some((ring) => pointInPolygon(ring, pillar.pc) || borderRingContact(ring, pillar.pc, 3));
    if (!inside) {
      problems.push({
        code: "PILLAR_OUTSIDE_ROOM",
        message: terraceRings.length === 0
          ? `столб террасы ${pillar.id} вне контура террасы — замкнутого кольца границ террасы нет`
          : `столб террасы ${pillar.id} вне контура террасы — центр должен быть в кольце границ террасы`,
        details: { pillar_id: pillar.id, pc: pillar.pc, kind: "terrace_column_outside_terrace" },
      });
    }
  }

  // ригели (этап 47): редактор геометрию ригеля не проверяет, но restore падает на
  // неконечной оси и нулевой длине (Rigel.calc) — проверяем только это
  for (const rigel of Object.values(model.rigels ?? {})) {
    const bad: string[] = [];
    for (const [name, pt] of [["p1", rigel.p1], ["p2", rigel.p2]] as const) {
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) bad.push(`${name}`);
    }
    if (!Number.isFinite(rigel.depth) || !(rigel.depth > 0)) bad.push("depth");
    if (!Number.isFinite(rigel.height) || !(rigel.height > 0)) bad.push("height");
    if (bad.length === 0 && rigel.p1 && rigel.p2 && Math.hypot(rigel.p2.x - rigel.p1.x, rigel.p2.y - rigel.p1.y) < 1e-6) {
      bad.push("axis");
    }
    if (bad.length > 0) {
      problems.push({
        code: "RIGEL_BAD_GEOMETRY",
        message: `ригель ${rigel.id}: некорректная геометрия (${bad.join(", ")}) — редактор не восстановит такой ригель`,
        details: { rigel_id: rigel.id, fields: bad },
      });
    }
  }

  // границы террас/участка (этап 64): restore удаляет нулевые границы и границы
  // с неконечными точками (TerraceBorders/TerritoryBorders.restore) — предупреждаем
  for (const [key, name] of [["terrace_borders", "граница террасы"], ["territory_borders", "граница участка"]] as const) {
    for (const border of Object.values(model[key] ?? {})) {
      const bad: string[] = [];
      for (const [endName, pt] of [["p1", border.p1], ["p2", border.p2]] as const) {
        if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) bad.push(`${endName}`);
      }
      if (bad.length === 0 && Math.hypot(border.p2.x - border.p1.x, border.p2.y - border.p1.y) < 0.05) {
        bad.push("zero_length");
      }
      if (bad.length > 0) {
        problems.push({
          code: "BORDER_BAD_GEOMETRY",
          message: `${name} ${border.id}: некорректная геометрия (${bad.join(", ")}) — редактор удалит её при восстановлении`,
          details: { border_id: border.id, collection: key, fields: bad },
        });
      }
    }
  }

  // проёмы в полу/потолке (этапы 64/328): restore ожидает конечный полигон без
  // самопересечений; пересечение проёмов редактор не проверяет, но такие проёмы
  // некорректны семантически. Пересечение — в пределах вида (пол и потолок —
  // разные листы, UI их не сравнивает).
  const holes = Object.values(model.level_holes ?? {});
  for (const hole of holes) {
    const bad: string[] = [];
    const type = hole.type ?? "";
    if (type !== "floor_hole" && type !== "ceiling_hole") bad.push(`type:${type}`);
    if (!Array.isArray(hole.polygon) || hole.polygon.length < 3) bad.push("polygon");
    else for (const p of hole.polygon) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) bad.push("polygon");
    if (bad.length > 0) {
      problems.push({
        code: "LEVEL_HOLE_BAD_GEOMETRY",
        message: `проём ${hole.id}: некорректная геометрия (${bad.join(", ")})`,
        details: { hole_id: hole.id, fields: bad },
      });
    }
  }
  for (let i = 0; i < holes.length; i++) {
    for (let j = i + 1; j < holes.length; j++) {
      if ((holes[i]!.type ?? "floor_hole") !== (holes[j]!.type ?? "floor_hole")) continue;
      const area = overlapArea(holes[i]!.polygon as Polygon, holes[j]!.polygon as Polygon);
      if (area > 0.01) {
        problems.push({
          code: "LEVEL_HOLES_OVERLAP",
          message: `проёмы ${holes[i]!.id} и ${holes[j]!.id} пересекаются (${Math.round(area * 100) / 100} см²)`,
          details: { holes: [holes[i]!.id, holes[j]!.id], overlap_cm2: Math.round(area * 100) / 100 },
        });
      }
    }
  }

  // minor 376 №10: висячие plan-ссылки нижней панели — объекты с plan
  // custom_<id>, чей лист удалён (restore редактора их не покажет, а пользователь
  // не увидит причину). Валидатор раньше не проверял ни одну из коллекций
  // раздела — «проблем 0» было вакуумным утверждением.
  const sheetIds = new Set(Object.keys(model.custom_plans ?? {}));
  const SHEET_PLAN_COLLECTIONS = [
    ["comments", "комментарий"], ["free_figures", "фигура"], ["pictures", "изображение"],
    ["freelines", "свободная линия"], ["thick_lines", "толстая линия"], ["rulers", "размер"],
  ] as const;
  for (const [coll, title] of SHEET_PLAN_COLLECTIONS) {
    const map = model[coll] as Record<string, { plan?: string }> | undefined;
    if (!map) continue;
    for (const [id, rec] of Object.entries(map)) {
      const plan = rec?.plan ?? "";
      if (plan.startsWith("custom_") && !sheetIds.has(plan.slice("custom_".length))) {
        problems.push({
          code: "SHEET_PLAN_DANGLING",
          message: `${title} ${id} привязан к несуществующему листу ${plan} — редактор его не показывает`,
          details: { collection: coll, entity_id: id, plan },
        });
      }
    }
  }

  return problems;
}

/** Прямоугольник предмета в см с учётом поворота (pc, width вдоль оси, height — глубина). */
function itemRectCm(item: ItemProps): Polygon {
  const a = ((item.angle ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const hw = (item.width ?? 0) / 2;
  const hd = (item.height ?? 0) / 2;
  return ([
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ] as const).map(([lx, ly]) => ({
    x: item.pc.x + lx * cos - ly * sin,
    y: item.pc.y + lx * sin + ly * cos,
  }));
}

/** Расстояние от точки до полигона (минимум по рёбрам), см. */
function distToPolygon(poly: Polygon, p: Point): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const seg: Segment = { p1: poly[i]!, p2: poly[(i + 1) % poly.length]! };
    best = Math.min(best, dist(closestPoint(seg, p).point, p));
  }
  return best;
}

function polyCenter(poly: Polygon): Point {
  let sx = 0;
  let sy = 0;
  for (const p of poly) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / poly.length, y: sy / poly.length };
}

/**
 * Площадь пересечения двух полигонов — в geometry.ts (overlapArea), общая с pillars.ts.
 */

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
