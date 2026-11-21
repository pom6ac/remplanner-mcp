import type { Model, LevelHole, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { pointInPolygon, pointOnSegment, polygonArea, overlapArea, lineIntersection, polygonInsidePolygon, type Polygon, type Segment } from "./geometry.ts";
import type { RoomPolygon } from "./items.ts";
import { McpError } from "../errors.ts";

// Проём в полу и проём в потолке (пункты меню «Проем в пола»/«Проем в потолке»,
// model.level_holes; этап 64, 2026-11-16; потолок — этап 328, 2026-11-21).
// Эталоны tests/fixtures/ui-ref-floorhole-floor_hole.json (пол, план a) и
// .orca-reports/tmp/328-ceilinghole-etalon.json (потолок, UI drag на листе
// «Потолки», dev-объект, БЕЗ save): прямоугольник на плане — polygon (4 угла, см),
// matrix — кольцо 4×4 в обе стороны ({length:1}), vertexes — узлы "node", items,
// type "floor_hole"|"ceiling_hole", plan "a"|"ceiling", length — периметр в м,
// area — площадь в м², pc — центр, id_room — комната. Класс LevelHoling
// редактора хранит оба вида в одной коллекции level_holes (tools
// ["floor_hole","ceiling_hole"]); overlap-проверка UI — в пределах своего плана.
// В UI инструмент перетаскивает прямоугольник внутри комнаты; контекстное меню —
// только «Удалить» (cm-level-hole). Разметка: plannertool_ceiling_hole /
// plannertool_floor_hole — НЕ PRO (эталон 328-pro-anon.json).

export const FLOOR_HOLE_TYPE = "floor_hole";
export const CEILING_HOLE_TYPE = "ceiling_hole";
/** План записи по типу: пол — исходный план a, потолок — лист «Потолки». */
export function levelHolePlan(type: LevelHoleType): "a" | "ceiling" {
  return type === CEILING_HOLE_TYPE ? "ceiling" : "a";
}
export type LevelHoleType = typeof FLOOR_HOLE_TYPE | typeof CEILING_HOLE_TYPE;

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
function buildCandidate(id: string, c1Cm: Point, c2Cm: Point, roomId: string | null, type: LevelHoleType): LevelHole {
  const polygon = rectPolygon(c1Cm, c2Cm).map((p) => ({ x: r2(p.x), y: r2(p.y) }));
  const vertexes = polygon.map((p) => ({ id: newId(5), point: { x: p.x, y: p.y }, type: "node" }));
  const items: Record<string, string> = {};
  for (const v of vertexes) items[v.id] = "node";
  const w = Math.abs(c2Cm.x - c1Cm.x);
  const h = Math.abs(c2Cm.y - c1Cm.y);
  return {
    id,
    plan: levelHolePlan(type),
    polygon,
    matrix: ringMatrix(4),
    vertexes,
    items,
    type,
    // length — периметр в метрах (живая проверка 67: редактор пересчитывает,
    // для эталона 100×100 см это 4 м; эталон 328 потолка 30×30 см — 1.2 м);
    // число вершин задаёт polygon/vertexes
    length: Math.round((((w + h) * 2) / 100) * 100) / 100,
    id_room: roomId,
    area: Math.round(((w * h) / 10_000) * 100) / 100,
    pc: { x: r2((c1Cm.x + c2Cm.x) / 2), y: r2((c1Cm.y + c2Cm.y) / 2) },
  };
}

/**
 * Общие проверки кандидата: конечность, размер > 0, комната обязательна и проём
 * целиком внутри неё (ревью 66 №5: не только центр и углы — каждое ребро проёма
 * не пересекает границу комнаты, иначе вогнутая комната пропускает вырез),
 * без пересечения других проёмов. Возвращает комнату, в которую помещён проём
 * (ревью 66 №8: id_room по проверенному включению). Включение — общий предикат
 * polygonInsidePolygon (geometry.ts, ревью 124 R4).
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
    throw new McpError("INVALID_ARGUMENT", "комнаты не определены — проём нельзя проверить на принадлежность комнате; откройте проект с комнатами (project_open) или добавьте комнаты", {
      details: { kind: "no_rooms", hole_id: candidate.id },
    });
  }
  const room = rooms.find((r) => pointInPolygon(r.polygon, candidate.pc));
  if (!room) {
    throw new McpError("OUTSIDE_ROOM", "точка вне помещений — проём ставится внутри комнаты (как в UI)", {
      details: { kind: "outside_room", point: candidate.pc },
    });
  }
  // все углы в одной комнате (прямоугольник не пересекает стены комнаты)
  for (const p of candidate.polygon) {
    if (!pointInPolygon(room.polygon, p)) {
      throw new McpError("GEOMETRY_CONFLICT", "проём пересекает стену — углы прямоугольника должны быть внутри одной комнаты", {
        details: { kind: "level_hole_over_wall", point: p },
      });
    }
  }
  // полное включение прямоугольника в комнату (ревью 68 №2): рёбра разбиваются
  // точками пересечения с рёбрами комнаты (включая касания в вершинах и коллинеарные
  // наложения), середины интервалов — внутри комнаты; ловит проход через вершину
  // вогнутой комнаты наружу (Г-/П-образная комната)
  if (!polygonInsidePolygon(candidate.polygon, room.polygon)) {
    throw new McpError("GEOMETRY_CONFLICT", "проём пересекает стену — прямоугольник должен быть целиком внутри комнаты", {
      details: { kind: "level_hole_over_wall", room_id: room.roomId },
    });
  }
  for (const other of Object.values(model.level_holes ?? {})) {
    if (other.id === candidate.id) continue;
    // пересечение проверяем в пределах одного вида/плана (пол и потолок — разные
    // листы; UI-инструменты LevelHoling не сравнивают floor_hole с ceiling_hole)
    if (other.type !== candidate.type) continue;
    const area = overlapArea(candidate.polygon, other.polygon as Polygon);
    if (area > 0.01) {
      throw new McpError("GEOMETRY_CONFLICT", `проём пересекает другой проём того же вида (${other.id})`, {
        details: { kind: "level_holes_overlap", other_id: other.id, overlap_cm2: Math.round(area * 100) / 100 },
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

/** Общий слой add: прямоугольный проём (пол/потолок) внутри комнаты (мм), атомарно. */
function addLevelHole(model: Model, type: LevelHoleType, params: AddFloorHoleParams, rooms?: RoomPolygon[]): LevelHole {
  finite("corner1.x", params.corner1.x);
  finite("corner1.y", params.corner1.y);
  finite("corner2.x", params.corner2.x);
  finite("corner2.y", params.corner2.y);
  const c1 = { x: mmToCm(params.corner1.x), y: mmToCm(params.corner1.y) };
  const c2 = { x: mmToCm(params.corner2.x), y: mmToCm(params.corner2.y) };
  const candidate = buildCandidate(newId(5), c1, c2, null, type);
  const room = assertHoleInvariants(candidate, model, rooms);
  candidate.id_room = room.roomId;
  model.level_holes ??= {};
  model.level_holes[candidate.id] = candidate;
  return candidate;
}

/** floor_hole_add: прямоугольный проём в полу внутри комнаты (мм), атомарно. */
export function addFloorHole(model: Model, params: AddFloorHoleParams, rooms?: RoomPolygon[]): LevelHole {
  return addLevelHole(model, FLOOR_HOLE_TYPE, params, rooms);
}

/** ceiling_hole_add: прямоугольный проём в потолке (лист «Потолки»), атомарно. */
export function addCeilingHole(model: Model, params: AddFloorHoleParams, rooms?: RoomPolygon[]): LevelHole {
  return addLevelHole(model, CEILING_HOLE_TYPE, params, rooms);
}

export type UpdateFloorHoleParams = Partial<AddFloorHoleParams> & { holeId: string };

/** Общий слой update: перенос/изменение размеров (новые углы, мм); кандидат-копия,
 *  при ошибке модель не меняется. */
function updateLevelHole(model: Model, type: LevelHoleType, params: UpdateFloorHoleParams, rooms?: RoomPolygon[]): LevelHole {
  const hole = model.level_holes?.[params.holeId];
  if (!hole) throw new McpError("NOT_FOUND", `проём ${params.holeId} не найден`);
  if ((hole.type ?? FLOOR_HOLE_TYPE) !== type) {
    throw new McpError("INVALID_ARGUMENT", `проём ${params.holeId} другого вида (${hole.type}) — используйте инструмент соответствующего вида`);
  }
  finite("corner1.x", params.corner1?.x);
  finite("corner1.y", params.corner1?.y);
  finite("corner2.x", params.corner2?.x);
  finite("corner2.y", params.corner2?.y);
  const c1 = params.corner1 ? { x: mmToCm(params.corner1.x), y: mmToCm(params.corner1.y) } : hole.polygon[0]!;
  const c2 = params.corner2 ? { x: mmToCm(params.corner2.x), y: mmToCm(params.corner2.y) } : hole.polygon[2]!;
  const candidate = buildCandidate(hole.id, c1, c2, hole.id_room ?? null, type);
  const room = assertHoleInvariants(candidate, model, rooms);
  // ревью 66 №8: комната пересчитывается по проверенному включению (перенос в другую комнату)
  candidate.id_room = room.roomId;
  model.level_holes![hole.id] = candidate;
  return candidate;
}

/** floor_hole_update: перенос/изменение размеров проёма в полу (новые углы, мм). */
export function updateFloorHole(model: Model, params: UpdateFloorHoleParams, rooms?: RoomPolygon[]): LevelHole {
  return updateLevelHole(model, FLOOR_HOLE_TYPE, params, rooms);
}

/** ceiling_hole_update: перенос/изменение размеров проёма в потолке (новые углы, мм). */
export function updateCeilingHole(model: Model, params: UpdateFloorHoleParams, rooms?: RoomPolygon[]): LevelHole {
  return updateLevelHole(model, CEILING_HOLE_TYPE, params, rooms);
}

/** Общий слой delete. */
function deleteLevelHole(model: Model, holeId: string, type: LevelHoleType): void {
  const hole = model.level_holes?.[holeId];
  if (!hole) throw new McpError("NOT_FOUND", `проём ${holeId} не найден`);
  if ((hole.type ?? FLOOR_HOLE_TYPE) !== type) {
    throw new McpError("INVALID_ARGUMENT", `проём ${holeId} другого вида (${hole.type}) — используйте инструмент соответствующего вида`);
  }
  delete model.level_holes![holeId];
}

/** floor_hole_delete. */
export function deleteFloorHole(model: Model, holeId: string): void {
  deleteLevelHole(model, holeId, FLOOR_HOLE_TYPE);
}

/** ceiling_hole_delete. */
export function deleteCeilingHole(model: Model, holeId: string): void {
  deleteLevelHole(model, holeId, CEILING_HOLE_TYPE);
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
      out.push(`${id}: проём исчез после сохранения`);
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
    if (!(id in expected)) out.push(`${id}: лишний проём на сервере (в модели его нет)`);
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
