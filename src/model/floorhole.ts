import type { Model, LevelHole, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { pointInPolygon, polygonArea, overlapArea, lineIntersection, type Polygon, type Segment } from "./geometry.ts";
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
    // length — периметр в метрах (живая проверка 67: редактор пересчитывает,
    // для эталона 100×100 см это 4 м); число вершин задаёт polygon/vertexes
    length: Math.round((((w + h) * 2) / 100) * 100) / 100,
    id_room: roomId,
    area: Math.round(((w * h) / 10_000) * 100) / 100,
    pc: { x: r2((c1Cm.x + c2Cm.x) / 2), y: r2((c1Cm.y + c2Cm.y) / 2) },
  };
}

/**
 * Собственное пересечение двух отрезков — не по касанию и не в общих концах
 * (ревью 66 №5): пересечение рёбер проёма с границей комнаты значит выход за неё.
 */
function segmentsProperlyCross(a: Segment, b: Segment): boolean {
  const p = lineIntersection(a, b);
  if (!p) return false;
  const onSeg = (s: Segment, q: Point): boolean => {
    const cross = (s.p2.x - s.p1.x) * (q.y - s.p1.y) - (s.p2.y - s.p1.y) * (q.x - s.p1.x);
    if (Math.abs(cross) > 1e-6) return false;
    const dot = (q.x - s.p1.x) * (s.p2.x - s.p1.x) + (q.y - s.p1.y) * (s.p2.y - s.p1.y);
    const len2 = (s.p2.x - s.p1.x) ** 2 + (s.p2.y - s.p1.y) ** 2;
    return dot >= 1e-6 && dot <= len2 - 1e-6;
  };
  return onSeg(a, p) && onSeg(b, p);
}

/**
 * Общие проверки кандидата: конечность, размер > 0, комната обязательна и проём
 * целиком внутри неё (ревью 66 №5: не только центр и углы — каждое ребро проёма
 * не пересекает границу комнаты, иначе вогнутая комната пропускает вырез),
 * без пересечения других проёмов. Возвращает комнату, в которую помещён проём
 * (ревью 66 №8: id_room по проверенному включению).
 */
function assertHoleInvariants(candidate: LevelHole, model: Model, rooms: RoomPolygon[] | undefined): RoomPolygon {
  const xs = candidate.polygon.map((p) => p.x);
  const ys = candidate.polygon.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  if (w <= 0 || h <= 0) {
    throw new McpError("INVALID_ARGUMENT", "нулевой размер проёма — углы прямоугольника не должны совпадать");
  }
  if (!rooms || rooms.length === 0) {
    throw new McpError("INVALID_ARGUMENT", "комнаты не определены — проём в полу нельзя проверить на принадлежность комнате; откройте проект с комнатами (project_open) или добавьте комнаты", {
      details: { kind: "no_rooms", hole_id: candidate.id },
    });
  }
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
  // каждое ребро проёма не пересекает границу комнаты (ревью 66 №5: вогнутая комната)
  const rn = room.polygon.length;
  for (let i = 0; i < 4; i++) {
    const edge: Segment = { p1: candidate.polygon[i]!, p2: candidate.polygon[(i + 1) % 4]! };
    for (let j = 0; j < rn; j++) {
      const roomEdge: Segment = { p1: room.polygon[j]!, p2: room.polygon[(j + 1) % rn]! };
      if (segmentsProperlyCross(edge, roomEdge)) {
        throw new McpError("GEOMETRY_CONFLICT", "проём в полу пересекает стену — прямоугольник должен быть целиком внутри комнаты", {
          details: { kind: "floor_hole_over_wall", edge: i + 1, room_id: room.roomId },
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
  return room;
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
  const room = assertHoleInvariants(candidate, model, rooms);
  candidate.id_room = room.roomId;
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
  const room = assertHoleInvariants(candidate, model, rooms);
  // ревью 66 №8: комната пересчитывается по проверенному включению (перенос в другую комнату)
  candidate.id_room = room.roomId;
  model.level_holes![hole.id] = candidate;
  return candidate;
}

/** floor_hole_delete. */
export function deleteFloorHole(model: Model, holeId: string): void {
  if (!model.level_holes?.[holeId]) throw new McpError("NOT_FOUND", `проём в полу ${holeId} не найден`);
  delete model.level_holes[holeId];
}

/**
 * Расхождение проёмов в полу между двумя наборами — ПОЛНАЯ семантическая сверка
 * (ревью 66 №3, этап 67): идентичности в обе стороны (лишний проём на сервере —
 * удаление не состоялось), тип, plan, polygon (допуск 0,1 см), pc, area (0,01 м²),
 * id_room, число вершин, matrix/vertexes/items под согласованным сопоставлением
 * вершин (по стабильному id, иначе по координатам — как у газовых линий).
 * Возвращает человекочитаемые расхождения.
 */
export function levelHoleMismatches(expected: Record<string, LevelHole>, got: Record<string, unknown>): string[] {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined, tol: number): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
  const tolCm = 0.1;
  for (const [id, h0] of Object.entries(expected)) {
    const h = got[id] as LevelHole | undefined;
    if (!h) {
      out.push(`${id}: проём в полу исчез после сохранения`);
      continue;
    }
    if ((h.type ?? "") !== (h0.type ?? "")) out.push(`${id}: тип изменился (на сервере «${h.type ?? ""}»; ожидалось «${h0.type ?? ""}»)`);
    if (String(h.plan ?? "") !== String(h0.plan ?? "")) out.push(`${id}: план изменился (на сервере «${h.plan ?? ""}»; ожидалось «${h0.plan ?? ""}»)`);
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
    // привязка к комнате (ревью 66 №3): редактор её не пересчитывает — расхождение это порча
    if ((h.id_room ?? null) !== (h0.id_room ?? null)) {
      out.push(`${id}: id_room изменился (на сервере «${h.id_room ?? ""}»; ожидалось «${h0.id_room ?? ""}»)`);
    }
    // граф: vertexes (сопоставление по id/координатам), matrix в обе стороны, items, length
    const expV = h0.vertexes ?? [];
    const gotV = h.vertexes ?? [];
    const map = expV.length === gotV.length ? matchVertexes(expV, gotV) : null;
    if (!map) {
      out.push(`${id}: граф вершин не сопоставлен (на сервере ${gotV.length} вершин, matrix=${JSON.stringify(h.matrix ?? null)}, items=${Object.keys(h.items ?? {}).length}; ожидалось ${expV.length})`);
    } else {
      for (let i = 0; i < expV.length; i++) {
        const e = expV[i]!;
        const s = gotV[map[i]!]!;
        if ((e.type ?? "") !== (s.type ?? "")) out.push(`${id}: тип вершины ${i} изменился (на сервере «${s.type ?? ""}»; ожидалось «${e.type ?? ""}»)`);
        if (!near(s.point?.x, e.point?.x, tolCm) || !near(s.point?.y, e.point?.y, tolCm)) {
          out.push(`${id}: вершина ${i} сместилась (на сервере ${s.point?.x},${s.point?.y}; ожидалось ${e.point?.x},${e.point?.y})`);
        }
      }
      const n = expV.length;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const e0 = h0.matrix?.[i]?.[j] ?? null;
          const e = h.matrix?.[map[i]!]?.[map[j]!] ?? null;
          if ((e0 !== null) !== (e !== null)) {
            out.push(`${id}: matrix ребро ${i}–${j} ${e0 !== null ? "потеряно" : "добавлено"} на сервере`);
          }
        }
      }
      const gotItems = h.items ?? {};
      const expItems = h0.items ?? {};
      const unclaimed = new Set(Object.keys(gotItems));
      for (let i = 0; i < expV.length; i++) {
        const expId = expV[i]!.id;
        const gotId = gotV[map[i]!]!.id;
        if (expId === undefined) continue;
        if (gotId === undefined || !(gotId in gotItems)) {
          out.push(`${id}: вершина ${expId} пропала из items`);
          continue;
        }
        unclaimed.delete(gotId);
        if (String(expItems[expId]) !== String(gotItems[gotId])) {
          out.push(`${id}: значение items вершины ${expId} изменилось (на сервере «${String(gotItems[gotId])}»; ожидалось «${String(expItems[expId])}»)`);
        }
      }
      if (unclaimed.size > 0) out.push(`${id}: лишние вершины в items (${[...unclaimed].sort().join(", ")})`);
    }
    if (h0.length !== undefined && h.length !== h0.length) {
      out.push(`${id}: length изменился (на сервере ${h.length}; ожидалось ${h0.length})`);
    }
  }
  // лишние проёмы на сервере (ревью 66 №3): удаление могло фактически не состояться
  for (const id of Object.keys(got)) {
    if (!(id in expected)) out.push(`${id}: лишний проём в полу на сервере (в модели его нет)`);
  }
  return out;
}

/** Сопоставление вершин графа по стабильному id, иначе по координатам (допуск 0,1 см). */
function matchVertexes(expected: { id: string; point: Point; type: string }[], got: { id: string; point: Point; type: string }[]): number[] | null {
  const used = new Array<boolean>(got.length).fill(false);
  const map = new Array<number>(expected.length).fill(-1);
  const gotById = new Map<string, number>();
  got.forEach((v, i) => gotById.set(v.id, i));
  let allById = true;
  expected.forEach((v, i) => {
    const j = gotById.get(v.id);
    if (j === undefined || used[j]!) {
      allById = false;
      return;
    }
    map[i] = j!;
    used[j] = true;
  });
  if (allById) return map;
  used.fill(false);
  map.fill(-1);
  for (let i = 0; i < expected.length; i++) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < got.length; j++) {
      if (used[j]) continue;
      if ((expected[i]!.type ?? "") !== (got[j]!.type ?? "")) continue;
      const d = Math.max(Math.abs(expected[i]!.point.x - got[j]!.point.x), Math.abs(expected[i]!.point.y - got[j]!.point.y));
      if (d <= 0.1 && d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0) return null;
    map[i] = best;
    used[best] = true;
  }
  return map;
}

/** Площадь полигона проёма в м² (для model_get/сверок). */
export function levelHoleAreaM2(polygon: Point[]): number {
  return Math.round((Math.abs(polygonArea(polygon)) / 10_000) * 100) / 100;
}
