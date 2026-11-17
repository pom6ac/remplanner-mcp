import type { Model, WarmFloor, GasLine, GasLineVertex, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { McpError } from "../errors.ts";
import { pointInPolygon } from "./geometry.ts";
import { roomPolygons } from "./items.ts";

/**
 * Тёплый пол (лист «Тёплые полы», этап 122, 2026-11-17): контуры model.warm_floors —
 * граф GraphLines с кольцевой матрицей (эталоны ui-ref-climate-wf-*: polygon 4 точки
 * от углов протяжки, matrix 4×4 в обе стороны, vertexes/items — узлы "node", length —
 * периметр в м с 2 знаками, id_room, props {id, name: type}, area — м² с 2 знаками;
 * у водяного — step 10, type_water "spiral", direction "right", length_pipes).
 * Один контур на комнату: повторная протяжка в той же комнате заменяет контур
 * (проба 122-climate-ui-click: IR-контур заменил кабельный). Магистрали и провода —
 * трубы/кабели (pipes_warm_floor, cables_warm_floor — отдельный PR).
 */

export type WarmFloorKind = "cable" | "infrared" | "water";

export const WARM_FLOOR_TYPE_BY_KIND: Record<WarmFloorKind, "warm_floor" | "warm_floor_ir" | "warm_floor_water"> = {
  cable: "warm_floor",
  infrared: "warm_floor_ir",
  water: "warm_floor_water",
};

/** Умолчания водяного контура (эталон 122-dev-wf-water-pipe: step 10, spiral, right). */
export const WARM_FLOOR_WATER_DEFAULTS = { step: 10, type_water: "spiral", direction: "right" } as const;

/** Допуск сверки длины/площади контура после save (м / м²). */
export const WARM_FLOOR_TOL = 0.02;

function finite(name: string, v: number | undefined): void {
  if (v !== undefined && !Number.isFinite(v)) {
    throw new McpError("INVALID_ARGUMENT", `${name} должен быть конечным числом`);
  }
}

function cmPoint(pt: MmPoint): Point {
  return { x: r2(mmToCm(pt.x)), y: r2(mmToCm(pt.y)) };
}

/** Проверка аргументов контура (до любых мутаций): конечные числа, ненулевые стороны. */
function validateRect(a: Point, b: Point): void {
  if (Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6) {
    throw new McpError("INVALID_ARGUMENT", "углы контура тёплого пола совпадают по одной из осей — задайте прямоугольник ненулевой площади");
  }
}

/** Периметр контура, м (2 знака, как в модели редактора). */
export function warmFloorLengthM(polygon: Point[]): number {
  let cm = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    cm += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return Math.round((cm / 100) * 100) / 100;
}

/** Площадь прямоугольного контура, м² (2 знака). */
export function warmFloorAreaM2(polygon: Point[]): number {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  return Math.round(((w * h) / 10_000) * 100) / 100;
}

/** Кольцевая матрица контура: соседи по кольцу в обе стороны. */
function ringMatrix(n: number): ({ length: number } | null)[][] {
  const matrix: ({ length: number } | null)[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
  for (let i = 0; i < n; i++) {
    matrix[i]![(i + 1) % n] = { length: 1 };
    matrix[(i + 1) % n]![i] = { length: 1 };
  }
  return matrix;
}

function rectPoints(a: Point, b: Point): Point[] {
  return [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ];
}

/** Комната, содержащая прямоугольник целиком (по центру и вершинам), или null. */
function containingRoom(model: Model, pts: Point[]): string | null {
  const rooms = roomPolygons(model);
  if (rooms.length === 0) {
    throw new McpError("GEOMETRY_CONFLICT", "в модели нет замкнутых помещений", { details: { kind: "no_rooms" } });
  }
  const cx = (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2;
  const cy = (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2;
  const center = { x: cx, y: cy };
  const found = rooms.find((room) => pointInPolygon(room.polygon, center) && pts.every((p) => pointInPolygon(room.polygon, p)));
  if (!found) {
    throw new McpError("OUTSIDE_ROOM", "контур тёплого пола выходит за границы помещения — он должен лежать внутри одной комнаты", {
      details: { kind: "outside_room" },
    });
  }
  return found.roomId;
}

function buildCandidate(id: string, kind: WarmFloorKind, a: Point, b: Point, roomId: string | null): WarmFloor {
  const polygon = rectPoints(a, b);
  const vertexes: GasLineVertex[] = polygon.map((p, i) => ({ id: `_${newId(5)}`, point: { ...p }, type: "node" }));
  const type = WARM_FLOOR_TYPE_BY_KIND[kind];
  const wf: WarmFloor = {
    id,
    polygon,
    matrix: ringMatrix(4),
    vertexes,
    items: Object.fromEntries(vertexes.map((v) => [v.id, "node"])),
    type,
    length: warmFloorLengthM(polygon),
    id_room: roomId,
    props: { id, name: type },
    area: warmFloorAreaM2(polygon),
  };
  if (kind === "water") {
    wf.step = WARM_FLOOR_WATER_DEFAULTS.step;
    wf.type_water = WARM_FLOOR_WATER_DEFAULTS.type_water;
    wf.direction = WARM_FLOOR_WATER_DEFAULTS.direction;
    wf.length_pipes = warmFloorPipesLengthM(polygon, WARM_FLOOR_WATER_DEFAULTS.step, WARM_FLOOR_WATER_DEFAULTS.direction);
  }
  return wf;
}

/**
 * Длина трубы водяного контура, м — оценка «змейкой» по площади и шагу:
 * число проходов n = floor(короткая сторона / шаг), длина ≈ n × длинная сторона
 * (+ подводка к коллектору не считается). Формула наша (как у инструмента рисования
 * редактора — оценка по эталону 122-dev-wf-water-pipe: контур 79.1×79.1, шаг 10 →
 * 6.18 м); редактор значение на restore не пересчитывает.
 */
export function warmFloorPipesLengthM(polygon: Point[], stepCm: number, _direction: string): number {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const passes = Math.max(1, Math.floor(Math.min(w, h) / stepCm));
  const run = Math.max(w, h);
  return Math.round(((passes * run) / 100) * 100) / 100;
}

/** Переносит проверенного кандидата в объект модели, сохраняя identity (паттерн assignGasLine). */
function assignWarmFloor(target: WarmFloor, candidate: WarmFloor): void {
  const keys = new Set([...Object.keys(target), ...Object.keys(candidate)]);
  for (const k of keys) {
    if (k in candidate) (target as Record<string, unknown>)[k] = (candidate as Record<string, unknown>)[k];
    else delete (target as Record<string, unknown>)[k];
  }
}

/**
 * warm_floor_add: прямоугольный контур тёплого пола по двум углам (мм; оси, любые
 * квадранты) внутри ОДНОЙ комнаты. kind: cable (Кабельный, free), infrared
 * (Инфракрасный, free), water (Водяной — PRO в UI). В комнате уже есть контур —
 * INVALID_ARGUMENT (в редакторе протяжка заменяет контур; здесь — сначала удалите).
 * Кандидат-копия до записи; при ошибке модель не меняется.
 */
export function addWarmFloor(
  model: Model,
  params: { kind: WarmFloorKind; corner1: MmPoint; corner2: MmPoint },
): WarmFloor {
  const kind = params.kind;
  if (!WARM_FLOOR_TYPE_BY_KIND[kind]) {
    throw new McpError("INVALID_ARGUMENT", `неизвестный вид тёплого пола «${String(kind)}» (cable | infrared | water)`);
  }
  finite("corner1.x", params.corner1.x);
  finite("corner1.y", params.corner1.y);
  finite("corner2.x", params.corner2.x);
  finite("corner2.y", params.corner2.y);
  const a = cmPoint(params.corner1);
  const b = cmPoint(params.corner2);
  validateRect(a, b);
  const pts = rectPoints(a, b);
  const roomId = containingRoom(model, pts);
  const existing = Object.values(model.warm_floors ?? {}).find((wf) => wf.id_room === roomId);
  if (existing) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `в комнате уже есть контур тёплого пола ${existing.id} (${existing.type}) — в редакторе протяжка заменяет контур; сначала удалите его (warm_floor_delete)`,
      { details: { kind: "warm_floor_exists", existing: existing.id, room: roomId } },
    );
  }
  const candidate = buildCandidate(newId(10), kind, a, b, roomId);
  const had = model.warm_floors !== undefined;
  const backup = had ? structuredClone(model.warm_floors) : undefined;
  model.warm_floors ??= {};
  try {
    model.warm_floors[candidate.id] = candidate;
  } catch (e) {
    if (backup) model.warm_floors = backup;
    else delete model.warm_floors;
    throw e;
  }
  return candidate;
}

/**
 * warm_floor_update: перенос/изменение контура новыми углами (corner1/corner2, мм —
 * только явно переданные; второй угол остаётся прежним). Контур должен остаться
 * внутри своей комнаты. Кандидат-копия; при ошибке модель не меняется.
 */
export function updateWarmFloor(
  model: Model,
  params: { warmFloorId: string; corner1?: MmPoint; corner2?: MmPoint },
): WarmFloor {
  const wf = model.warm_floors?.[params.warmFloorId];
  if (!wf) throw new McpError("NOT_FOUND", `контур тёплого пола ${params.warmFloorId} не найден`);
  if (params.corner1 === undefined && params.corner2 === undefined) return wf;
  finite("corner1.x", params.corner1?.x);
  finite("corner1.y", params.corner1?.y);
  finite("corner2.x", params.corner2?.x);
  finite("corner2.y", params.corner2?.y);
  const poly = wf.polygon;
  const oldA = { x: Math.min(...poly.map((p) => p.x)), y: Math.min(...poly.map((p) => p.y)) };
  const oldB = { x: Math.max(...poly.map((p) => p.x)), y: Math.max(...poly.map((p) => p.y)) };
  const na = params.corner1 !== undefined ? cmPoint(params.corner1) : oldA;
  const nb = params.corner2 !== undefined ? cmPoint(params.corner2) : oldB;
  validateRect(na, nb);
  const pts = rectPoints(na, nb);
  const roomId = containingRoom(model, pts);
  const candidate = buildCandidate(wf.id, kindOf(wf.type), na, nb, roomId);
  // пользовательские свойства водяного контура сохраняются
  if (wf.step !== undefined) candidate.step = wf.step;
  if (wf.type_water !== undefined) candidate.type_water = wf.type_water;
  if (wf.direction !== undefined) candidate.direction = wf.direction;
  if (wf.length_pipes !== undefined) {
    candidate.length_pipes = warmFloorPipesLengthM(pts, candidate.step ?? WARM_FLOOR_WATER_DEFAULTS.step, candidate.direction ?? "right");
  }
  assignWarmFloor(wf, candidate);
  return wf;
}

function kindOf(type: string): WarmFloorKind {
  if (type === "warm_floor_ir") return "infrared";
  if (type === "warm_floor_water") return "water";
  return "cable";
}

/** warm_floor_delete. */
export function deleteWarmFloor(model: Model, warmFloorId: string): void {
  if (!model.warm_floors?.[warmFloorId]) {
    throw new McpError("NOT_FOUND", `контур тёплого пола ${warmFloorId} не найден`);
  }
  delete model.warm_floors![warmFloorId];
}

/**
 * Двусторонняя сверка контуров тёплого пола: идентичности в обе стороны, polygon
 * (вершины с допуском), кольцевая матрица (наличие рёбер), узлы (тип/точка), items,
 * type, props, id_room; length/area/length_pipes — с допуском (производные).
 */
export function warmFloorMismatches(
  expected: Record<string, WarmFloor>,
  got: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined, tol: number): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
  for (const [id, w0] of Object.entries(expected)) {
    const g = got[id] as WarmFloor | undefined;
    if (!g) {
      out.push(`${id}: контур тёплого пола исчез после сохранения`);
      continue;
    }
    const p0 = w0.polygon ?? [];
    const p = g.polygon ?? [];
    if (p0.length !== p.length) {
      out.push(`${id}: число вершин polygon изменилось (на сервере ${p.length}; ожидалось ${p0.length})`);
    } else {
      for (let i = 0; i < p0.length; i++) {
        if (!near(p[i]?.x, p0[i]?.x, WARM_FLOOR_TOL * 5) || !near(p[i]?.y, p0[i]?.y, WARM_FLOOR_TOL * 5)) {
          out.push(`${id}: вершина polygon ${i} сместилась (на сервере ${p[i]?.x},${p[i]?.y}; ожидалось ${p0[i]?.x},${p0[i]?.y})`);
        }
      }
    }
    const n = p0.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const e0 = (w0.matrix?.[i]?.[j] ?? null) !== null;
        const e = (g.matrix?.[i]?.[j] ?? null) !== null;
        if (e0 !== e) out.push(`${id}: ребро кольца ${i}–${j} ${e0 ? "потеряно" : "добавлено"} на сервере`);
      }
    }
    if (p0.length === p.length) {
      for (let i = 0; i < n; i++) {
        const v0 = w0.vertexes?.[i];
        const v = g.vertexes?.[i];
        if (!v0 || !v) continue;
        if ((v0.type ?? "node") !== (v.type ?? "node")) out.push(`${id}: тип узла ${i} изменился`);
        if (!near(v.point?.x, v0.point?.x, WARM_FLOOR_TOL * 5) || !near(v.point?.y, v0.point?.y, WARM_FLOOR_TOL * 5)) {
          out.push(`${id}: узел ${i} сместился (на сервере ${v.point?.x},${v.point?.y}; ожидалось ${v0.point?.x},${v0.point?.y})`);
        }
      }
    }
    const items0 = w0.items ?? {};
    const items = g.items ?? {};
    if (JSON.stringify(Object.keys(items0).sort()) !== JSON.stringify(Object.keys(items).sort())) {
      out.push(`${id}: состав items изменился`);
    } else {
      for (const [k, val] of Object.entries(items0)) {
        if (items[k] !== val) out.push(`${id}: items[${k}] изменился (на сервере «${items[k]}»; ожидалось «${String(val)}»)`);
      }
    }
    if ((g.type ?? "") !== (w0.type ?? "")) out.push(`${id}: тип изменился (на сервере «${g.type ?? ""}»; ожидалось «${w0.type ?? ""}»)`);
    if ((g.id_room ?? null) !== (w0.id_room ?? null)) out.push(`${id}: id_room изменился (на сервере «${g.id_room ?? null}»; ожидалось «${w0.id_room ?? null}»)`);
    if (!near(g.length, w0.length, WARM_FLOOR_TOL)) out.push(`${id}: периметр изменился (на сервере ${g.length}; ожидалось ${w0.length})`);
    if (!near(g.area, w0.area, WARM_FLOOR_TOL)) out.push(`${id}: площадь изменилась (на сервере ${g.area}; ожидалось ${w0.area})`);
    if ((g.props?.name ?? "") !== (w0.props?.name ?? "")) out.push(`${id}: props.name изменился (на сервере «${g.props?.name ?? ""}»; ожидалось «${w0.props?.name ?? ""}»)`);
    if (w0.step !== undefined && !near(g.step, w0.step, 0.01)) out.push(`${id}: шаг изменился (на сервере ${g.step}; ожидалось ${w0.step})`);
    if (w0.type_water !== undefined && g.type_water !== w0.type_water) out.push(`${id}: type_water изменился (на сервере «${g.type_water ?? ""}»; ожидалось «${w0.type_water}»)`);
    if (w0.direction !== undefined && g.direction !== w0.direction) out.push(`${id}: direction изменился (на сервере «${g.direction ?? ""}»; ожидалось «${w0.direction}»)`);
    if (w0.length_pipes !== undefined && !near(g.length_pipes, w0.length_pipes, WARM_FLOOR_TOL)) out.push(`${id}: length_pipes изменился (на сервере ${g.length_pipes}; ожидалось ${w0.length_pipes})`);
  }
  const extra = Object.keys(got).filter((id) => !(id in expected)).sort();
  for (const id of extra) out.push(`${id}: лишний контур тёплого пола на сервере (не заявлен рабочей копией)`);
  return out;
}
