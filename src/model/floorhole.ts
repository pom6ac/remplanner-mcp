import type { Model, LevelHole, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { pointInPolygon, polygonArea, overlapArea, type Polygon } from "./geometry.ts";
import type { RoomPolygon } from "./items.ts";
import { McpError } from "../errors.ts";

// Проём в полу (пункт меню «Проем в пола», model.level_holes, этап 64, 2026-11-16).
// Эталон tests/fixtures/ui-ref-floorhole-floor_hole.json: прямоугольник на плане —
// polygon (4 угла, см), matrix — кольцо 4×4 в обе стороны ({length:1}), vertexes —
// узлы "node", items, type "floor_hole", plan "a", length — число вершин,
// area — площадь в м², pc — центр. В UI инструмент перетаскивает прямоугольник
// внутри комнаты; контекстное меню — только «Удалить» (cm-level-hole).

export const FLOOR_HOLE_TYPE = "floor_hole";

function finite(name: string, v: number | undefined): void {
  if (v !== undefined && !Number.isFinite(v)) {
    throw new McpError("INVALID_ARGUMENT", `${name} должен быть конечным числом`);
  }
}

/** Полигон прямоугольника по двум углам (порядок углов — как в эталоне UI). */
function rectPolygon(a: Point, b: Point): Polygon {
  return [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ];
}

/** Матрица кольца N×N в обе стороны (как в эталоне). */
function ringMatrix(n: number): ({ length: number } | null)[][] {
  const m: ({ length: number } | null)[][] = [];
  for (let i = 0; i < n; i++) {
    const row: ({ length: number } | null)[] = new Array(n).fill(null);
    row[(i + 1) % n] = { length: 1 };
    row[(i - 1 + n) % n] = { length: 1 };
    m.push(row);
  }
  return m;
}

/** Кандидат-копия проёма по двум углам (мм) без записи в модель. */
function buildCandidate(id: string, c1Cm: Point, c2Cm: Point, roomId: string | null): LevelHole {
  const polygon = rectPolygon(c1Cm, c2Cm).map((p) => ({ x: r2(p.x), y: r2(p.y) }));
  const vertexes = polygon.map((p) => ({ id: newId(5), point: { x: p.x, y: p.y }, type: "node" }));
  const items: Record<string, string> = {};
  for (const v of vertexes) items[v.id] = "node";
  const w = Math.abs(c2Cm.x - c1Cm.x);
  const h = Math.abs(c2Cm.y - c1Cm.y);
  return {
    id,
    plan: "a",
    polygon,
    matrix: ringMatrix(4),
    vertexes,
    items,
    type: FLOOR_HOLE_TYPE,
    length: vertexes.length,
    id_room: roomId,
    area: Math.round(((w * h) / 10_000) * 100) / 100,
    pc: { x: r2((c1Cm.x + c2Cm.x) / 2), y: r2((c1Cm.y + c2Cm.y) / 2) },
  };
}

/** Общие проверки кандидата: конечность, размер > 0, внутри комнаты, без пересечения других проёмов. */
function assertHoleInvariants(candidate: LevelHole, model: Model, rooms: RoomPolygon[] | undefined): void {
  const xs = candidate.polygon.map((p) => p.x);
  const ys = candidate.polygon.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  if (w <= 0 || h <= 0) {
    throw new McpError("INVALID_ARGUMENT", "нулевой размер проёма — углы прямоугольника не должны совпадать");
  }
  if (rooms && rooms.length > 0) {
    const room = rooms.find((r) => pointInPolygon(r.polygon, candidate.pc));
    if (!room) {
      throw new McpError("OUTSIDE_ROOM", "точка вне помещений — проём в полу ставится внутри комнаты (как в UI)", {
        details: { kind: "outside_room", point: candidate.pc },
      });
    }
    // все углы в одной комнате (прямоугольник не пересекает стены комнаты)
    for (const p of candidate.polygon) {
      if (!pointInPolygon(room.polygon, p)) {
        throw new McpError("GEOMETRY_CONFLICT", "проём в полу пересекает стену — углы прямоугольника должны быть внутри одной комнаты", {
          details: { kind: "floor_hole_over_wall", point: p },
        });
      }
    }
  }
  for (const other of Object.values(model.level_holes ?? {})) {
    if (other.id === candidate.id) continue;
    const area = overlapArea(candidate.polygon, other.polygon as Polygon);
    if (area > 0.01) {
      throw new McpError("GEOMETRY_CONFLICT", `проём в полу пересекает другой проём (${other.id})`, {
        details: { kind: "floor_holes_overlap", other_id: other.id, overlap_cm2: Math.round(area * 100) / 100 },
      });
    }
  }
}

export type AddFloorHoleParams = {
  /** Первый угол прямоугольника, мм. */
  corner1: MmPoint;
  /** Противоположный угол прямоугольника, мм. */
  corner2: MmPoint;
};

/** floor_hole_add: прямоугольный проём в полу внутри комнаты (мм), атомарно. */
export function addFloorHole(model: Model, params: AddFloorHoleParams, rooms?: RoomPolygon[]): LevelHole {
  finite("corner1.x", params.corner1.x);
  finite("corner1.y", params.corner1.y);
  finite("corner2.x", params.corner2.x);
  finite("corner2.y", params.corner2.y);
  const c1 = { x: mmToCm(params.corner1.x), y: mmToCm(params.corner1.y) };
  const c2 = { x: mmToCm(params.corner2.x), y: mmToCm(params.corner2.y) };
  const candidate = buildCandidate(newId(5), c1, c2, null);
  assertHoleInvariants(candidate, model, rooms);
  model.level_holes ??= {};
  model.level_holes[candidate.id] = candidate;
  return candidate;
}

export type UpdateFloorHoleParams = Partial<AddFloorHoleParams> & { holeId: string };

/** floor_hole_update: перенос/изменение размеров (новые углы, мм); кандидат-копия, при ошибке модель не меняется. */
export function updateFloorHole(model: Model, params: UpdateFloorHoleParams, rooms?: RoomPolygon[]): LevelHole {
  const hole = model.level_holes?.[params.holeId];
  if (!hole) throw new McpError("NOT_FOUND", `проём в полу ${params.holeId} не найден`);
  finite("corner1.x", params.corner1?.x);
  finite("corner1.y", params.corner1?.y);
  finite("corner2.x", params.corner2?.x);
  finite("corner2.y", params.corner2?.y);
  const c1 = params.corner1 ? { x: mmToCm(params.corner1.x), y: mmToCm(params.corner1.y) } : hole.polygon[0]!;
  const c2 = params.corner2 ? { x: mmToCm(params.corner2.x), y: mmToCm(params.corner2.y) } : hole.polygon[2]!;
  const candidate = buildCandidate(hole.id, c1, c2, hole.id_room ?? null);
  assertHoleInvariants(candidate, model, rooms);
  model.level_holes![hole.id] = candidate;
  return candidate;
}

/** floor_hole_delete. */
export function deleteFloorHole(model: Model, holeId: string): void {
  if (!model.level_holes?.[holeId]) throw new McpError("NOT_FOUND", `проём в полу ${holeId} не найден`);
  delete model.level_holes[holeId];
}

/**
 * Расхождение проёмов в полу между двумя наборами — семантическая сверка (этап 64):
 * идентичности, тип, polygon (допуск 0,1 см), pc, area (0,01 м²); длина (число
 * вершин). matrix/vertexes/items редактор сохраняет байт в байт (проба 64-norm2),
 * сверка polygon покрывает геометрию. Возвращает человекочитаемые расхождения.
 */
export function levelHoleMismatches(expected: Record<string, LevelHole>, got: Record<string, unknown>): string[] {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined, tol: number): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
  for (const [id, h0] of Object.entries(expected)) {
    const h = got[id] as LevelHole | undefined;
    if (!h) {
      out.push(`${id}: проём в полу исчез после сохранения`);
      continue;
    }
    if ((h.type ?? "") !== (h0.type ?? "")) out.push(`${id}: тип изменился (на сервере «${h.type ?? ""}»; ожидалось «${h0.type ?? ""}»)`);
    const poly0 = h0.polygon ?? [];
    const poly = (h.polygon ?? []) as Point[];
    if (poly.length !== poly0.length) {
      out.push(`${id}: число углов изменилось (на сервере ${poly.length}; ожидалось ${poly0.length})`);
    } else {
      for (let i = 0; i < poly0.length; i++) {
        if (!near(poly[i]?.x, poly0[i]!.x, 0.1) || !near(poly[i]?.y, poly0[i]!.y, 0.1)) {
          out.push(`${id}: угол ${i} сместился (на сервере ${poly[i]?.x},${poly[i]?.y}; ожидалось ${poly0[i]!.x},${poly0[i]!.y})`);
        }
      }
    }
    if (!near(h.pc?.x, h0.pc?.x, 0.1) || !near(h.pc?.y, h0.pc?.y, 0.1)) {
      out.push(`${id}: центр сместился (на сервере ${h.pc?.x},${h.pc?.y}; ожидалось ${h0.pc?.x},${h0.pc?.y})`);
    }
    if (h0.area !== undefined && !near(h.area, h0.area, 0.011)) {
      out.push(`${id}: площадь изменилась (на сервере ${h.area}; ожидалось ${h0.area})`);
    }
  }
  return out;
}

/** Площадь полигона проёма в м² (для model_get/сверок). */
export function levelHoleAreaM2(polygon: Point[]): number {
  return Math.round((Math.abs(polygonArea(polygon)) / 10_000) * 100) / 100;
}
