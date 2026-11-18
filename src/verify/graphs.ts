import type { Point } from "../model/types.ts";
import { dist, closestPoint, pointInPolygon, segmentsCross, type Polygon as GeoPolygon } from "../model/geometry.ts";
import type { VerificationMismatches } from "./types.ts";

/**
 * Убрать id_room вершин световых линий (этап 84): редактор сам пересчитывает
 * принадлежность узла комнате при draw/normalize (живая проба 84: узлы получили
 * id_room комнаты вместо "" из serialize LedStrip) — в сверке РАБОЧЕЙ копии с
 * нормализованной это производное поле; сверка после save идёт по нормализованному
 * ожиданию и остаётся строгой.
 */
export function stripVertexIdRoom<T>(lines: T): T {
  for (const line of Object.values(lines as Record<string, { vertexes?: Array<Record<string, unknown>> }>)) {
    if (Array.isArray(line?.vertexes)) {
      for (const v of line.vertexes) delete v["id_room"];
    }
  }
  return lines;
}

/**
 * Значимая семантика газовой линии для сверки (этап 57, ревью 59 №1, ревью 61 №1 —
 * ПОЛНАЯ сверка, а не по выбранным полям). Сравнивается семантическая проекция
 * всего объекта линии: plan и остальные скалярные поля (набор полей задаёт
 * ожидаемая сторона — лишние поля сервера не потеря данных), вершины — с
 * согласованным сопоставлением (по стабильному id; при переупорядочивании —
 * по типу и координатам, ревью 61 №6), matrix целиком в обе стороны (направленные
 * рёбра, т.е. и симметрия формата) и соответствие items узлам.
 */
export type GasVertexSig = { id?: string; point?: Point; type?: string } & Record<string, unknown>;

export type GasLineSig = {
  vertexes?: GasVertexSig[];
  length?: number;
  type?: string;
  plan?: unknown;
  matrix?: (null | { length?: number })[][];
  items?: Record<string, unknown>;
} & Record<string, unknown>;

/** Допуск сверки координат вершин, см (округление редактора до сотых см). */
const GAS_VERTEX_TOL_CM = 0.1;
/** Допуск сверки длин (рёбра matrix, длина линии) — метры, округление до 2 знаков. */
const GAS_LENGTH_TOL_M = 0.02;

/** Глубокое равенство с допуском на числа (набор полей задаёт ожидаемая сторона). */
function deepEqualTol(expected: unknown, got: unknown, tol: number): boolean {
  if (typeof expected === "number" && typeof got === "number") return Math.abs(expected - got) <= tol;
  if (expected === null || expected === undefined || got === null || got === undefined) return expected === got;
  if (Array.isArray(expected)) {
    if (!Array.isArray(got) || expected.length !== got.length) return false;
    return expected.every((v, i) => deepEqualTol(v, got[i], tol));
  }
  if (typeof expected === "object") {
    if (typeof got !== "object") return false;
    return Object.entries(expected as Record<string, unknown>).every(
      ([k, v]) => k in (got as object) && deepEqualTol(v, (got as Record<string, unknown>)[k], tol),
    );
  }
  return expected === got;
}

/**
 * Согласованное сопоставление вершин двух графов (ревью 61 №6; ревью 79 №4/№5):
 * сначала однозначные совпадения по стабильному id — они сохраняются даже при
 * переименовании других узлов (раньше один rename сбрасывал все id-совпадения);
 * вершины-предметы (type ≠ node) сопоставляются ТОЛЬКО по id — геометрическая
 * замена identity предмета запрещена (ревью 79 №5b); оставшиеся свободные узлы
 * (rename нормализацией) — жадно по типу и координатам с допуском
 * GAS_VERTEX_TOL_CM. Возвращает map[i] = индекс вершины в got или null, если
 * согласованного сопоставления нет.
 */
function gasVertexMatch(expected: GasVertexSig[], got: GasVertexSig[]): number[] | null {
  if (expected.length !== got.length) return null;
  const used = new Array<boolean>(got.length).fill(false);
  const map = new Array<number>(expected.length).fill(-1);
  const gotById = new Map<string, number>();
  got.forEach((v, i) => {
    if (typeof v.id === "string" && !gotById.has(v.id)) gotById.set(v.id, i);
  });
  const needGeom: number[] = [];
  for (let i = 0; i < expected.length; i++) {
    const v = expected[i]!;
    const j = typeof v.id === "string" ? gotById.get(v.id) : undefined;
    if (j !== undefined && !used[j]!) {
      map[i] = j!;
      used[j] = true;
      continue;
    }
    // вершина-предмет без id-совпадения — identity потеряна (ревью 79 №5b)
    if ((v.type ?? "node") !== "node") return null;
    needGeom.push(i);
  }
  // свободные узлы (id переименован нормализацией) — по геометрии (ревью 79 №4)
  for (const i of needGeom) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < got.length; j++) {
      if (used[j]) continue;
      if ((expected[i]!.type ?? "") !== (got[j]!.type ?? "")) continue;
      const ex = expected[i]!.point?.x;
      const ey = expected[i]!.point?.y;
      const gx = got[j]!.point?.x;
      const gy = got[j]!.point?.y;
      if (ex === undefined || ey === undefined || gx === undefined || gy === undefined) continue;
      const d = Math.max(Math.abs(ex - gx), Math.abs(ey - gy));
      if (d <= GAS_VERTEX_TOL_CM && d < bestD) {
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

/**
 * Расхождение линий-графов (газовые линии, трубы водоснабжения) между двумя наборами —
 * ПОЛНАЯ семантическая сверка (ревью 61 №1; ревью 79 №3–№5): идентичности с обеих
 * сторон (лишняя линия на другой стороне — расхождение, №5c), вершины с согласованным
 * сопоставлением (допуск 0,1 см; переименование только свободных узлов, identity
 * вершин-предметов — только по id), рёбра matrix целиком в обе стороны (длины с
 * допуском 0,02 м), пустота диагонали (петля не проходит, ревью 62 №7), items, plan
 * и все прочие поля ожидаемой стороны; длина линии (допуск 0,02 м).
 * entityLabel — имя сущности в сообщениях («газовая линия», «труба»).
 * lenientItemVertices — у сущностей с вершинами-предметами (трубы) точку вершины
 * сверяем мягко: редактор пересчитывает точку подключения к габариту предмета
 * (connector geometry, бандл app.3.0 Piping.get_point), поэтому локальная точка
 * (центр предмета) отличается от нормализованной. Длины рёбер и линии при этом не
 * отключаются (ревью 79 №3): при переданном itemGeom длины сверяются с ДОПУСТИМЫМ
 * диапазоном — расстоянием между габаритами предметов (любая точка подключения
 * внутри габарита) и узлами; без itemGeom — строго.
 * itemGeom — геометрия предметов-вершин (id → pc/width/height/angle, см) ожидаемой
 * стороны, для расчёта допустимых диапазонов длин.
 * Возвращает список человекочитаемых расхождений; пустой список — совпадают.
 */
export function gasLineGraphMismatches(
  expected: Record<string, GasLineSig>,
  got: Record<string, unknown>,
  entityLabel = "газовая линия",
  lenientItemVertices = false,
  itemGeom?: Record<string, { pc?: Point; width?: number; height?: number; angle?: number }>,
): VerificationMismatches {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined, tol: number): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
  /** Регион допустимых точек подключения вершины: габарит предмета (с углом) или сама точка узла. */
  const regionOf = (v: GasVertexSig): Point[] => {
    const pt = v.point;
    if (!itemGeom || (v.type ?? "node") === "node") return pt ? [{ x: pt.x, y: pt.y }] : [];
    const g = typeof v.id === "string" ? itemGeom[v.id] : undefined;
    if (!g || g.pc === undefined || g.width === undefined || g.height === undefined) return pt ? [{ x: pt.x, y: pt.y }] : [];
    const w2 = g.width / 2;
    const h2 = g.height / 2;
    const a = ((g.angle ?? 0) * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return ([[-w2, -h2], [w2, -h2], [w2, h2], [-w2, h2]] as [number, number][]).map(([dx, dy]) => ({
      x: g.pc!.x + dx * cos - dy * sin,
      y: g.pc!.y + dx * sin + dy * cos,
    }));
  };
  /** Допустимый диапазон длины ребра: min/max расстояния между регионами концов
   *  (ревью 81 3-R: минимум по всему габариту — точка подключения может лежать на
   *  середине грани или внутри перекрывающегося габарита, а не у угла). */
  const edgeLengthRange = (a: GasVertexSig, b: GasVertexSig): [number, number] | null => {
    const ra = regionOf(a);
    const rb = regionOf(b);
    if (ra.length === 0 || rb.length === 0) return null;
    return [regionMinDistance(ra, rb), regionMaxDistance(ra, rb)];
  };
  for (const [id, g0] of Object.entries(expected)) {
    const g = got[id] as GasLineSig | undefined;
    if (!g) {
      out.push(`${id}: ${entityLabel} исчезла после сохранения`);
      continue;
    }
    const expV = g0.vertexes ?? [];
    const gotV = g.vertexes ?? [];
    const map = expV.length === gotV.length ? gasVertexMatch(expV, gotV) : null;
    if (!map) {
      out.push(`${id}: узлы не сопоставлены (на сервере ${gotV.length}; ожидалось ${expV.length})`);
      continue;
    }
    for (let i = 0; i < expV.length; i++) {
      const e = expV[i]!;
      const s = gotV[map[i]!]!;
      if ((e.type ?? "") !== (s.type ?? "")) out.push(`${id}: тип узла ${i} изменился (на сервере «${s.type ?? ""}»; ожидалось «${e.type ?? ""}»)`);
      const loosePoint = lenientItemVertices && (e.type ?? "node") !== "node";
      if (!loosePoint && (!near(s.point?.x, e.point?.x, GAS_VERTEX_TOL_CM) || !near(s.point?.y, e.point?.y, GAS_VERTEX_TOL_CM))) {
        out.push(`${id}: узел ${i} сместился (на сервере ${s.point?.x},${s.point?.y}; ожидалось ${e.point?.x},${e.point?.y})`);
      }
      for (const [k, v] of Object.entries(e)) {
        if (k === "id" || k === "point" || k === "type") continue;
        const sVal = (s as Record<string, unknown>)[k];
        if (!deepEqualTol(v, sVal, GAS_VERTEX_TOL_CM)) {
          out.push(`${id}: узел ${i}, поле ${k} изменилось (на сервере ${JSON.stringify(sVal ?? null)}; ожидалось ${JSON.stringify(v)})`);
        }
      }
    }
    // matrix целиком: направленные рёбра под согласованным сопоставлением —
    // обе стороны формата (порча обратного ребра не проходит, ревью 61 №1);
    // диагональ обязана быть пустой (эталон и src/model/pipes.ts), петля
    // обнаруживается (ревью 62 №7)
    const n = expV.length;
    for (let i = 0; i < n; i++) {
      const d0 = g0.matrix?.[i]?.[i] ?? null;
      const d = g.matrix?.[map[i]!]?.[map[i]!] ?? null;
      if ((d0 !== null) !== (d !== null)) {
        out.push(`${id}: петля на узле ${i} ${d !== null ? "добавлена" : "потеряна"} на сервере (matrix[i][i] изменилась)`);
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const e0 = g0.matrix?.[i]?.[j] ?? null;
        const e = g.matrix?.[map[i]!]?.[map[j]!] ?? null;
        if ((e0 !== null) !== (e !== null)) {
          out.push(`${id}: ребро ${i}–${j} ${e0 !== null ? "потеряно" : "добавлено"} на сервере (matrix изменилась)`);
        } else if (e0 !== null && e !== null) {
          const l0 = (e0 as { length?: number }).length;
          const l = (e as { length?: number }).length;
          // matrix length — константа-заглушка {length:1} формата редактора (реальная
          // длина только в line.length), сверяется как раньше — строго
          if (!near(l, l0, GAS_LENGTH_TOL_M)) out.push(`${id}: длина ребра ${i}–${j} изменилась (на сервере ${l}; ожидалось ${l0})`);
        }
      }
    }
    // соответствие items узлам — под тем же согласованным сопоставлением
    const gotItems = g.items ?? {};
    const expItems = g0.items ?? {};
    const unclaimed = new Set(Object.keys(gotItems));
    for (let i = 0; i < expV.length; i++) {
      const expId = expV[i]!.id;
      const gotId = gotV[map[i]!]!.id;
      if (expId === undefined) continue;
      if (gotId === undefined || !(gotId in gotItems)) {
        out.push(`${id}: узел ${expId} пропал из items`);
        continue;
      }
      unclaimed.delete(gotId);
      if (!deepEqualTol(expItems[expId], gotItems[gotId], GAS_VERTEX_TOL_CM)) {
        out.push(`${id}: значение items узла ${expId} изменилось (на сервере ${JSON.stringify(gotItems[gotId] ?? null)}; ожидалось ${JSON.stringify(expItems[expId])})`);
      }
    }
    if (unclaimed.size > 0) out.push(`${id}: лишние узлы в items (${[...unclaimed].sort().join(", ")})`);
    // план, тип, длина и все прочие поля объекта линии (ревью 61 №1: включая plan)
    if ((g.type ?? "") !== (g0.type ?? "")) out.push(`${id}: тип изменился (на сервере «${g.type ?? ""}»; ожидалось «${g0.type ?? ""}»)`);
    // ревью 79 №3: длина линии при мягкой сверке — допустимый диапазон точек подключения
    const lenRange = lenientItemVertices
      ? (() => {
          let dminSum = 0;
          let dmaxSum = 0;
          let ranged = false;
          // ревью 79 №3: при мягкой сверке вершин-предметов допустимый диапазон
          // длин по габаритам предметов считается только для line.length —
          // сумма min/max расстояний между регионами точек подключения рёбер
          for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
              if ((g0.matrix?.[i]?.[j] ?? null) === null) continue;
              const r = edgeLengthRange(expV[i]!, expV[j]!);
              if (!r) return null;
              dminSum += r[0];
              dmaxSum += r[1];
              ranged = true;
            }
          }
          return ranged ? [dminSum, dmaxSum] as const : null;
        })()
      : null;
    if (lenRange) {
      // регион в см, длина линии — в метрах
      const dminM = lenRange[0] / 100;
      const dmaxM = lenRange[1] / 100;
      if (g.length === undefined || g.length < dminM - GAS_LENGTH_TOL_M || g.length > dmaxM + GAS_LENGTH_TOL_M) {
        out.push(`${id}: длина изменилась вне допустимого диапазона точек подключения (на сервере ${g.length}; допустимо ${dminM.toFixed(2)}–${dmaxM.toFixed(2)})`);
      }
    } else if (!near(g.length, g0.length, GAS_LENGTH_TOL_M)) out.push(`${id}: длина изменилась (на сервере ${g.length}; ожидалось ${g0.length})`);
    for (const [k, v] of Object.entries(g0)) {
      if (k === "vertexes" || k === "matrix" || k === "items" || k === "type" || k === "length") continue;
      const sVal = (g as Record<string, unknown>)[k];
      if (!deepEqualTol(v, sVal, GAS_LENGTH_TOL_M)) {
        out.push(`${id}: поле ${k} изменилось (на сервере ${JSON.stringify(sVal ?? null)}; ожидалось ${JSON.stringify(v)})`);
      }
    }
  }
  // ревью 79 №5c: сверка множества в обе стороны — лишняя линия на другой стороне
  // (не удалена/добавлена редактором) — расхождение
  const extra = Object.keys(got).filter((id) => !(id in expected)).sort();
  for (const id of extra) out.push(`${id}: лишняя ${entityLabel} на сервере (не заявлена рабочей копией)`);
  return out;
}

/**
 * Минимальное расстояние между замкнутыми выпуклыми регионами (ревью 81 3-R):
 * 0 при пересечении или вложении, иначе — минимум расстояний точка–отрезок по
 * всем рёбрам обеих сторон. Точка — вырожденный регион из одной вершины.
 */
function regionMinDistance(a: GeoPolygon, b: GeoPolygon): number {
  for (let i = 0; i < a.length; i++) {
    const e1 = { p1: a[i]!, p2: a[(i + 1) % a.length]! };
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(e1, { p1: b[j]!, p2: b[(j + 1) % b.length]! })) return 0;
    }
  }
  for (const p of a) if (pointInPolygon(b, p)) return 0;
  for (const p of b) if (pointInPolygon(a, p)) return 0;
  let best = Infinity;
  for (const p of a) {
    for (let j = 0; j < b.length; j++) best = Math.min(best, dist(p, closestPoint({ p1: b[j]!, p2: b[(j + 1) % b.length]! }, p).point));
  }
  for (const p of b) {
    for (let i = 0; i < a.length; i++) best = Math.min(best, dist(p, closestPoint({ p1: a[i]!, p2: a[(i + 1) % a.length]! }, p).point));
  }
  return best;
}

/** Максимальное расстояние между регионами (для выпуклых — достигается на вершинах). */
function regionMaxDistance(a: GeoPolygon, b: GeoPolygon): number {
  let best = 0;
  for (const p of a) for (const q of b) best = Math.max(best, dist(p, q));
  return best;
}
