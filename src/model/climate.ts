import type { Model, WarmFloor, GasLine, GasLineVertex, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { McpError } from "../errors.ts";
import { assignCandidate } from "./assign.ts";
import { pointInPolygon, polygonInsidePolygon, segmentsCross } from "./geometry.ts";
import { roomPolygons } from "./rooms.ts";

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

/**
 * Комната, содержащая прямоугольник целиком (ревью 124 R4 — общий предикат
 * polygonInsidePolygon, как у проёмов в полу: все вершины, все рёбра и середины
 * рёбер внутри — вогнутая Г-/П-образная комната не пропускает контур через вырез),
 * или null.
 */
function containingRoom(model: Model, pts: Point[]): string | null {
  const rooms = roomPolygons(model);
  if (rooms.length === 0) {
    throw new McpError("GEOMETRY_CONFLICT", "в модели нет замкнутых помещений", { details: { kind: "no_rooms" } });
  }
  const cx = (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2;
  const cy = (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2;
  const center = { x: cx, y: cy };
  const found = rooms.find((room) => pointInPolygon(room.polygon, center) && polygonInsidePolygon(pts, room.polygon));
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
  assignCandidate(wf, candidate);
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
 * Ревью 133 N1 (живая проба p135-n1c, анонимный проект): перегородка, ось которой
 * проходит через контур тёплого пола, при сохранении удаляет контур молча
 * (rooms2 редактор пересчитывает только при save, поэтому до записи потеря не видна).
 * Отказ до записи с понятным hint; контур вне оси перегородки редактор сохраняет и
 * сам переназначает id_room (эталон ui-ref-replan-partition-warmfloor).
 */
export function assertNoWarmFloorCrossing(model: Model, p1: Point, p2: Point): void {
  for (const wf of Object.values(model.warm_floors ?? {})) {
    const poly = wf.polygon ?? [];
    if (poly.length < 3) continue;
    const endpointsInside = pointInPolygon(poly, p1) || pointInPolygon(poly, p2);
    const edgeCross = poly.some((a, i) => {
      const b = poly[(i + 1) % poly.length]!;
      return segmentsCross({ p1, p2 }, { p1: a, p2: b });
    });
    if (endpointsInside || edgeCross) {
      throw new McpError("INVALID_GEOMETRY", `перегородка пройдёт через контур тёплого пола ${wf.id} — редактор удалит контур при сохранении`, {
        hint: "сдвиньте перегородку за пределы контура или измените/удалите контур (warm_floor_update, warm_floor_delete)",
        details: { kind: "partition_crosses_warm_floor", warm_floor_id: wf.id, room: wf.id_room ?? null },
      });
    }
  }
}

/**
 * Двусторонняя сверка контуров тёплого пола: идентичности в обе стороны, polygon
 * (вершины с допуском), кольцевая матрица (наличие рёбер), узлы (тип/точка/ID —
 * ревью 124 R3: полный состав vertexes, сопоставление по геометрии, согласованность
 * с items и polygon/matrix, props.id), items, type, props; length/area/length_pipes —
 * с допуском (производные). Привязка к комнате (ревью 124 R1) — двухрежимно:
 * normalize — ID комнат редактор штатно регенерирует/делит/сливает, принадлежность
 * сверяется по геометрии (id_room указывает на комнату, чей полигон содержит контур);
 * save — строго (id_room нормализованного ожидания против сервера).
 */
export interface WarmFloorMismatchOptions {
  mode?: "normalize" | "save";
  /** Комнаты ожидания (rooms2/rooms1) — для геометрической сверки в режиме normalize. */
  roomsExpected?: Record<string, unknown>;
  /** Комнаты факта (rooms2/rooms1) — для геометрической сверки в режиме normalize. */
  roomsGot?: Record<string, unknown>;
}

export function warmFloorMismatches(
  expected: Record<string, WarmFloor>,
  got: Record<string, unknown>,
  opts: WarmFloorMismatchOptions = {},
): string[] {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined, tol: number): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
  const roomPolygonOf = (rooms: Record<string, unknown> | undefined, id: string | null | undefined): Point[] | null => {
    if (!rooms || !id) return null;
    const r = rooms[id] as { polygon?: Point[] } | undefined;
    return r && Array.isArray(r.polygon) ? r.polygon : null;
  };
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
    // ревью 124 R3: полный состав vertexes — число узлов, ID (сопоставление по
    // геометрии, устойчивое к перестановке), тип; согласованность с items и с
    // polygon/matrix. Пропуск отсутствующих узлов раньше маскировал удаление всех
    // вершин и подмену ID.
    const vs0 = w0.vertexes ?? [];
    const vs = g.vertexes ?? [];
    const it0 = w0.items ?? {};
    const it = g.items ?? {};
    if (vs0.length !== vs.length || vs0.length !== p0.length || vs.length !== p.length) {
      out.push(`${id}: состав узлов не согласован (ожидалось ${vs0.length} узлов / ${p0.length} polygon; на сервере ${vs.length} узлов / ${p.length} polygon)`);
    } else {
      const used = new Set<number>();
      for (let i = 0; i < vs0.length; i++) {
        const v0 = vs0[i]!;
        const j = vs.findIndex((v, k) => !used.has(k) && near(v.point?.x, v0.point?.x, WARM_FLOOR_TOL * 5) && near(v.point?.y, v0.point?.y, WARM_FLOOR_TOL * 5));
        if (j < 0) {
          out.push(`${id}: узел ${i} (${v0.point?.x},${v0.point?.y}) исчез или сместился на сервере`);
          continue;
        }
        used.add(j);
        if ((vs[j]!.id ?? "") !== (v0.id ?? "")) out.push(`${id}: ID узла ${i} подменён (на сервере «${vs[j]!.id ?? ""}»; ожидалось «${v0.id ?? ""}»)`);
        if ((vs[j]!.type ?? "node") !== (v0.type ?? "node")) out.push(`${id}: тип узла ${i} изменился`);
      }
    }
    // ревью 124 R3: согласованность items ↔ vertexes и polygon ↔ matrix на обеих сторонах
    if (JSON.stringify(Object.keys(it0).sort()) !== JSON.stringify(vs0.map((v) => v.id ?? "").sort())) {
      out.push(`${id}: items рабочей копии не согласованы с vertexes`);
    }
    if (JSON.stringify(Object.keys(it).sort()) !== JSON.stringify(vs.map((v) => v.id ?? "").sort())) {
      out.push(`${id}: items на сервере не согласованы с vertexes`);
    }
    const mg = g.matrix?.length ?? 0;
    if (p.length > 0 && mg !== p.length) {
      out.push(`${id}: матрица на сервере не согласована с polygon (${mg}×? против ${p.length} вершин)`);
    } else if (mg === p.length && p.length > 0) {
      for (let i = 0; i < p.length; i++) {
        const e = (g.matrix?.[i]?.[(i + 1) % p.length] ?? null) !== null || (g.matrix?.[(i + 1) % p.length]?.[i] ?? null) !== null;
        if (!e) out.push(`${id}: кольцо на сервере разорвано между вершинами ${i} и ${(i + 1) % p.length}`);
      }
    }
    const items0 = it0;
    const items = it;
    if (JSON.stringify(Object.keys(items0).sort()) !== JSON.stringify(Object.keys(items).sort())) {
      out.push(`${id}: состав items изменился`);
    } else {
      for (const [k, val] of Object.entries(items0)) {
        if (items[k] !== val) out.push(`${id}: items[${k}] изменился (на сервере «${items[k]}»; ожидалось «${String(val)}»)`);
      }
    }
    if ((g.type ?? "") !== (w0.type ?? "")) out.push(`${id}: тип изменился (на сервере «${g.type ?? ""}»; ожидалось «${w0.type ?? ""}»)`);
    // ревью 124 R1: привязка к комнате — двухрежимно. normalize — ID комнат штатно
    // регенерируется при пересчёте (split/merge/перенос стены), сверяем геометрию:
    // id_room указывает на комнату, чей полигон содержит контур. save — id_room
    // редактор вправе переназначить при штатной перестройке комнат (ревью 133 N1,
    // эталон ui-ref-replan-partition-warmfloor: перегородка plan:"c" делит комнату
    // при save, редактор сам указывает id_room на новую комнату, содержащую контур):
    // изменение допустимо, если контур лежит в комнате, на которую теперь указывает
    // id_room (контур сам сверяется строго — polygon/matrix/площадь выше).
    if (opts.mode === "normalize") {
      const expRoom = roomPolygonOf(opts.roomsExpected, w0.id_room);
      const gotRoom = roomPolygonOf(opts.roomsGot, g.id_room);
      if (w0.id_room === undefined && g.id_room === undefined) {
        // привязки не было и не появилось — штатно
      } else if (!g.id_room || !gotRoom) {
        out.push(`${id}: id_room указывает на несуществующую комнату (на сервере «${g.id_room ?? null}»)`);
      } else if (!polygonInsidePolygon(g.polygon ?? [], gotRoom)) {
        out.push(`${id}: контур на сервере вне комнаты ${g.id_room}, на которую указывает id_room`);
      } else if (!expRoom || !polygonInsidePolygon(w0.polygon ?? [], expRoom)) {
        out.push(`${id}: привязка рабочей копии не подтверждается геометрией (комната ${w0.id_room ?? "нет"})`);
      }
    } else if ((g.id_room ?? null) !== (w0.id_room ?? null)) {
      const gotRoom = roomPolygonOf(opts.roomsGot, g.id_room);
      if (!gotRoom || !polygonInsidePolygon(g.polygon ?? [], gotRoom)) {
        out.push(`${id}: id_room изменился (на сервере «${g.id_room ?? null}»; ожидалось «${w0.id_room ?? null}»)`);
      }
    }
    if (!near(g.length, w0.length, WARM_FLOOR_TOL)) out.push(`${id}: периметр изменился (на сервере ${g.length}; ожидалось ${w0.length})`);
    if (!near(g.area, w0.area, WARM_FLOOR_TOL)) out.push(`${id}: площадь изменилась (на сервере ${g.area}; ожидалось ${w0.area})`);
    // ревью 124 R3: props.id — часть идентичности контура, подмена не «verified»
    if ((g.props?.id ?? "") !== (w0.props?.id ?? "")) out.push(`${id}: props.id изменился (на сервере «${g.props?.id ?? ""}»; ожидалось «${w0.props?.id ?? ""}»)`);
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
