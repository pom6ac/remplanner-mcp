import type { Model, TerraceBorder, Wall, Pillar, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { addWall } from "./walls.ts";
import { lineIntersection, overlapArea, pointInPolygon, type Polygon, type Segment } from "./geometry.ts";
import { McpError } from "../errors.ts";

// Терраса и участок (пункты меню «Терраса и участок», этап 64, 2026-11-16).
// Терраса — замкнутое кольцо границ model.terrace_borders {id, p1, p2} (см),
// участок — то же в model.territory_borders. Эталоны tests/fixtures/ui-ref-terrace-border.json
// и ui-ref-terrace-territory.json. Ограждение террасы — стена role "terrace_fence"
// (ui-ref-terrace-fence.json, defs.terrace_fence.depth=5), опорный столб — колонна
// role "terrace_column" (ui-ref-terrace-column.json, defs.terrace_column 20×20).
// В UI ограждение и столб ставятся при существующей террасе (l10n.terrace_fence__terrace_required,
// магнит к baselines комнат role "terrace"); граница, лежащая на ограждении, редактором
// удаляется при restore (TERRACE_BORDERS.repair) — поэтому такие границы отклоняем.

export const FENCE_DEFS = { depthCm: 5, depthMinCm: 1, depthMaxCm: 100, minLengthCm: 20 };
export const COLUMN_DEFS = { widthCm: 20, heightCm: 20, widthMinCm: 10, widthMaxCm: 2000, heightMinCm: 10, heightMaxCm: 600, snapTolCm: 3 };

type BordersKey = "terrace_borders" | "territory_borders";

function bordersOf(model: Model, key: BordersKey): Record<string, TerraceBorder> {
  return (model[key] ?? {}) as Record<string, TerraceBorder>;
}

function finite(name: string, v: number | undefined): void {
  if (v !== undefined && !Number.isFinite(v)) {
    throw new McpError("INVALID_ARGUMENT", `${name} должен быть конечным числом`);
  }
}

function segIntersect(a: Segment, b: Segment): boolean {
  const p = lineIntersection(a, b);
  if (!p) return false;
  const onSeg = (s: Segment, q: Point): boolean => {
    const cross = (s.p2.x - s.p1.x) * (q.y - s.p1.y) - (s.p2.y - s.p1.y) * (q.x - s.p1.x);
    if (Math.abs(cross) > 1e-6) return false;
    const dot = (q.x - s.p1.x) * (s.p2.x - s.p1.x) + (q.y - s.p1.y) * (s.p2.y - s.p1.y);
    const len2 = (s.p2.x - s.p1.x) ** 2 + (s.p2.y - s.p1.y) ** 2;
    return dot >= -1e-6 && dot <= len2 + 1e-6;
  };
  return onSeg(a, p) && onSeg(b, p);
}

/** Проверки набора точек кольца: ≥3, без совпадающих соседних, без самопересечений. */
function assertRingPoints(pointsCm: Point[], kind: string): void {
  if (pointsCm.length < 3) {
    throw new McpError("INVALID_ARGUMENT", `${kind}: нужно минимум 3 точки`);
  }
  const n = pointsCm.length;
  for (let i = 0; i < n; i++) {
    const a = pointsCm[i]!;
    const b = pointsCm[(i + 1) % n]!;
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) {
      throw new McpError("INVALID_ARGUMENT", `${kind}: совпадающие соседние точки (вершина ${i + 1})`);
    }
  }
  for (let i = 0; i < n; i++) {
    const s1: Segment = { p1: pointsCm[i]!, p2: pointsCm[(i + 1) % n]! };
    for (let j = i + 1; j < n; j++) {
      // соседние стороны (и замыкающая пара) касаются в общей вершине — это не пересечение
      if (j === i || (i === 0 && j === n - 1) || j === (i + 1) % n) continue;
      const s2: Segment = { p1: pointsCm[j]!, p2: pointsCm[(j + 1) % n]! };
      if (segIntersect(s1, s2)) {
        throw new McpError("GEOMETRY_CONFLICT", `${kind}: самопересечение контура (стороны ${i + 1} и ${j + 1})`, {
          details: { kind: "border_self_intersection" },
        });
      }
    }
  }
}

/** Середина границы лежит на грани ограждения террасы (редактор такую границу удалит при restore). */
function borderOnFence(model: Model, p1: Point, p2: Point): string | null {
  const pc = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  for (const wall of Object.values(model.walls)) {
    if (wall.role !== "terrace_fence") continue;
    for (const [fa, fb] of [[wall.l1, wall.l2], [wall.r1, wall.r2]] as [Point | undefined, Point | undefined][]) {
      if (!fa || !fb) continue;
      const f: Polygon = [fa, fb, { x: fb.x + 0.1, y: fb.y + 0.1 }, { x: fa.x + 0.1, y: fa.y + 0.1 }];
      const line: Segment = { p1: fa, p2: fb };
      const flen = Math.hypot(fb.x - fa.x, fb.y - fa.y);
      if (flen < 1e-9) continue;
      // расстояние pc до прямой грани + проекция в пределах грани
      const t = ((pc.x - fa.x) * (fb.x - fa.x) + (pc.y - fa.y) * (fb.y - fa.y)) / (flen * flen);
      const proj = { x: fa.x + t * (fb.x - fa.x), y: fa.y + t * (fb.y - fa.y) };
      if (t >= -0.01 && t <= 1.01 && Math.hypot(pc.x - proj.x, pc.y - proj.y) <= 0.5) return wall.id;
      void f;
    }
  }
  return null;
}

export type AddRingParams = {
  /** Вершины замкнутого контура, мм (обход по часовой стрелке или против — редактор не различает). */
  points: MmPoint[];
};

/**
 * terrace_add / territory_add: замкнутое кольцо границ (мм). Возвращает созданные границы.
 * Граница, чья середина лежит на грани ограждения террасы, отклоняется (редактор удалит её при restore).
 */
export function addBorderRing(model: Model, key: BordersKey, kind: string, params: AddRingParams): TerraceBorder[] {
  for (const p of params.points) {
    finite("points[].x", p.x);
    finite("points[].y", p.y);
  }
  const pointsCm = params.points.map((p) => ({ x: mmToCm(p.x), y: mmToCm(p.y) }));
  assertRingPoints(pointsCm, kind);
  model[key] ??= {};
  const borders = (model[key] as Record<string, TerraceBorder>);
  const created: TerraceBorder[] = [];
  const n = pointsCm.length;
  for (let i = 0; i < n; i++) {
    const p1 = { x: r2(pointsCm[i]!.x), y: r2(pointsCm[i]!.y) };
    const p2 = { x: r2(pointsCm[(i + 1) % n]!.x), y: r2(pointsCm[(i + 1) % n]!.y) };
    if (key === "terrace_borders") {
      const fence = borderOnFence(model, p1, p2);
      if (fence) {
        // атомарность: созданные границы до ошибки не сохраняются
        for (const c of created) delete borders[c.id];
        throw new McpError("GEOMETRY_CONFLICT", `граница террасы лежит на ограждении ${fence} — редактор удаляет такие границы при восстановлении; вместо границы проведите ограждение (terrace_fence_add)`, {
          details: { kind: "border_on_fence", fence_id: fence },
        });
      }
    }
    const border: TerraceBorder = { id: newId(5), p1, p2 };
    borders[border.id] = border;
    created.push(border);
  }
  return created;
}

/** Граница по site-id. */
function resolveBorder(model: Model, key: BordersKey, ref: string): TerraceBorder {
  const borders = bordersOf(model, key);
  if (borders[ref]) return borders[ref]!;
  throw new McpError("NOT_FOUND", `граница ${ref} не найдена`);
}

export type UpdateBorderParams = {
  borderId: string;
  /** Новый конец p1, мм (общие узлы соседних границ двигаются вместе — как перенос узла в UI). */
  start?: MmPoint;
  /** Новый конец p2, мм. */
  end?: MmPoint;
};

/**
 * terrace_border_update / territory_border_update: перенос конца границы. Концы,
 * совпадающие с концами других границ (допуск 1 см, link редактора), двигаются вместе
 * транзитивно (узел контура едет целиком, как в UI).
 */
export function updateBorder(model: Model, key: BordersKey, kind: string, params: UpdateBorderParams): TerraceBorder {
  const border = resolveBorder(model, key, params.borderId);
  finite("start.x", params.start?.x);
  finite("start.y", params.start?.y);
  finite("end.x", params.end?.x);
  finite("end.y", params.end?.y);
  const borders = bordersOf(model, key);
  const backup = structuredClone(borders);
  const applyMove = (from: Point, toCm: Point): void => {
    const tol = 0.5;
    // транзитивный перенос узла: все границы, чей конец совпадает с точкой (включая новые позиции)
    let moved = true;
    const movedPoint: Point = { ...from };
    let iterations = 0;
    while (moved && iterations < 100) {
      moved = false;
      iterations++;
      for (const b of Object.values(borders)) {
        for (const end of ["p1", "p2"] as const) {
          const p = b[end];
          if (Math.abs(p.x - movedPoint.x) <= tol && Math.abs(p.y - movedPoint.y) <= tol) {
            if (Math.abs(p.x - toCm.x) > 1e-9 || Math.abs(p.y - toCm.y) > 1e-9) {
              p.x = r2(toCm.x);
              p.y = r2(toCm.y);
              moved = true;
            }
          }
        }
      }
      movedPoint.x = toCm.x;
      movedPoint.y = toCm.y;
    }
    if (iterations >= 100) {
      model[key] = backup as Record<string, TerraceBorder>;
      throw new McpError("INTERNAL", `${kind}: пересчёт узла не сошёлся — откат`, { details: { kind: "border_node_divergence" } });
    }
  };
  if (params.start) applyMove(border.p1, { x: mmToCm(params.start.x), y: mmToCm(params.start.y) });
  if (params.end) applyMove(border.p2, { x: mmToCm(params.end.x), y: mmToCm(params.end.y) });
  // нулевые и самопересекающиеся кольца не оставляем
  const n = Object.keys(borders).length;
  for (const b of Object.values(borders)) {
    if (Math.abs(b.p1.x - b.p2.x) < 1e-6 && Math.abs(b.p1.y - b.p2.y) < 1e-6) {
      model[key] = backup as Record<string, TerraceBorder>;
      throw new McpError("GEOMETRY_CONFLICT", `${kind}: перенос узла схлопнул границу ${b.id} в точку — откат`, {
        details: { kind: "border_zero_length", border_id: b.id },
      });
    }
  }
  if (n === 0) return border;
  // ревью 66 №4: кольца после переноса проверяются на самопересечения до commit
  // (INVALID_ARGUMENT по заданию 67), а для террасы повторяется проверка попадания
  // середины границы на грань ограждения (редактор такие границы удаляет при restore)
  for (const ring of borderRingPolygons(borders)) {
    const rn = ring.length;
    for (let i = 0; i < rn; i++) {
      const s1: Segment = { p1: ring[i]!, p2: ring[(i + 1) % rn]! };
      for (let j = i + 1; j < rn; j++) {
        if (j === i || (i === 0 && j === rn - 1) || j === (i + 1) % rn) continue;
        const s2: Segment = { p1: ring[j]!, p2: ring[(j + 1) % rn]! };
        if (segIntersect(s1, s2)) {
          model[key] = backup as Record<string, TerraceBorder>;
          throw new McpError("INVALID_ARGUMENT", `${kind}: самопересечение контура после переноса (стороны ${i + 1} и ${j + 1}) — откат`, {
            details: { kind: "border_self_intersection", border_id: params.borderId },
          });
        }
      }
    }
  }
  if (key === "terrace_borders") {
    for (const b of Object.values(borders)) {
      const fence = borderOnFence(model, b.p1, b.p2);
      if (fence) {
        model[key] = backup as Record<string, TerraceBorder>;
        throw new McpError("GEOMETRY_CONFLICT", `${kind}: граница ${b.id} легла на ограждение ${fence} — редактор удаляет такие границы при восстановлении — откат`, {
          details: { kind: "border_on_fence", border_id: b.id, fence_id: fence },
        });
      }
    }
  }
  return border;
}

/** terrace_border_delete / territory_border_delete. */
export function deleteBorder(model: Model, key: BordersKey, ref: string): void {
  const borders = bordersOf(model, key);
  if (!borders[ref]) throw new McpError("NOT_FOUND", `граница ${ref} не найдена`);
  delete borders[ref];
}

/** Замкнутое кольцо границ → полигон (см); незамкнутое — null. */
export function borderRingPolygon(borders: Record<string, TerraceBorder>): Polygon | null {
  return borderRingPolygons(borders)[0] ?? null;
}

/**
 * Все замкнутые кольца границ → полигоны (см) (ревью 66 №6): террас может быть
 * несколько, проверять попадание надо в любую; открытые цепочки не возвращаются.
 */
export function borderRingPolygons(borders: Record<string, TerraceBorder>): Polygon[] {
  if (Object.keys(borders).length < 3) return [];
  // собираем цепочки по совпадению концов (допуск 0,5 см)
  const remaining = new Set(Object.keys(borders));
  const chains: Point[][] = [];
  while (remaining.size > 0) {
    const startId = [...remaining][0]!;
    remaining.delete(startId);
    const first = borders[startId]!;
    const chain: Point[] = [first.p1, first.p2];
    let extended = true;
    while (extended) {
      extended = false;
      for (const id of [...remaining]) {
        const b = borders[id]!;
        const tail = chain[chain.length - 1]!;
        if (Math.abs(b.p1.x - tail.x) <= 0.5 && Math.abs(b.p1.y - tail.y) <= 0.5) {
          chain.push(b.p2);
          remaining.delete(id);
          extended = true;
        } else if (Math.abs(b.p2.x - tail.x) <= 0.5 && Math.abs(b.p2.y - tail.y) <= 0.5) {
          chain.push(b.p1);
          remaining.delete(id);
          extended = true;
        }
      }
    }
    chains.push(chain);
  }
  const rings: Polygon[] = [];
  for (const chain of chains) {
    const head = chain[0]!;
    const tail = chain[chain.length - 1]!;
    if (chain.length >= 4 && Math.abs(head.x - tail.x) <= 0.5 && Math.abs(head.y - tail.y) <= 0.5) {
      chain.pop();
      rings.push(chain);
    }
  }
  return rings;
}

export type AddFenceParams = {
  start: MmPoint;
  end: MmPoint;
  thicknessMm?: number;
};

/**
 * terrace_fence_add: ограждение террасы — стена role "terrace_fence" (мм).
 * Как в UI, ставится при существующей террасе (есть границы террасы);
 * толщина по умолчанию 50 мм (defs.terrace_fence.depth=5), лимиты 10..1000 мм.
 * Правила стен (примыкания, коллизии) — общие, модельные функции стен.
 */
export function addTerraceFence(model: Model, params: AddFenceParams): Wall {
  if (Object.keys(bordersOf(model, "terrace_borders")).length === 0) {
    throw new McpError("INVALID_ARGUMENT", "в редакторе ограждение террасы ставится при существующей террасе — сначала нарисуйте террасу (terrace_add)", {
      details: { kind: "terrace_required" },
    });
  }
  finite("thickness_mm", params.thicknessMm);
  if (params.thicknessMm !== undefined) {
    if (params.thicknessMm < FENCE_DEFS.depthMinCm * 10 || params.thicknessMm > FENCE_DEFS.depthMaxCm * 10) {
      throw new McpError("INVALID_ARGUMENT", `thickness_mm вне лимитов (${FENCE_DEFS.depthMinCm * 10}..${FENCE_DEFS.depthMaxCm * 10} мм по defs редактора)`);
    }
  }
  const lenMm = Math.hypot(params.end.x - params.start.x, params.end.y - params.start.y);
  if (!(lenMm >= FENCE_DEFS.minLengthCm * 10)) {
    throw new McpError("INVALID_ARGUMENT", `ограждение короче ${FENCE_DEFS.minLengthCm * 10} мм (min_length по defs редактора)`);
  }
  return addWall(model, { start: params.start, end: params.end, thicknessMm: params.thicknessMm ?? FENCE_DEFS.depthCm * 10, role: "terrace_fence", plan: "a" });
}

export type AddTerraceColumnParams = {
  center: MmPoint;
  widthMm?: number;
  heightMm?: number;
};

/**
 * terrace_column_add: опорный столб террасы — колонна role "terrace_column" (мм).
 * Как в UI, ставится на террасе: центр внутри замкнутого кольца границ террасы
 * или на его границе (допуск прижатия 3 см). Габариты по умолчанию 200×200 мм
 * (defs.terrace_column), лимиты как у колонн 100..20000 × 100..6000 мм.
 */
export function addTerraceColumn(model: Model, params: AddTerraceColumnParams): Pillar {
  finite("width_mm", params.widthMm);
  finite("height_mm", params.heightMm);
  const width = mmToCm(params.widthMm ?? COLUMN_DEFS.widthCm * 10);
  const height = mmToCm(params.heightMm ?? COLUMN_DEFS.heightCm * 10);
  assertColumnSize("width_mm", params.widthMm, COLUMN_DEFS.widthMinCm * 10, COLUMN_DEFS.widthMaxCm * 10);
  assertColumnSize("height_mm", params.heightMm, COLUMN_DEFS.heightMinCm * 10, COLUMN_DEFS.heightMaxCm * 10);
  const pc = { x: mmToCm(params.center.x), y: mmToCm(params.center.y) };
  assertColumnOnTerrace(model, pc);
  const id = newId(10);
  const pillar = buildTerraceColumn(id, pc, width, height, typeof model.total_height === "number" ? model.total_height : 270);
  assertColumnNoOverlap(model, pillar);
  model.pillars[pillar.id] = pillar;
  return pillar;
}

/** Лимиты габарита (передан и вне лимитов — INVALID_ARGUMENT). */
function assertColumnSize(name: string, valueMm: number | undefined, minMm: number, maxMm: number): void {
  if (valueMm !== undefined && (valueMm < minMm || valueMm > maxMm)) {
    throw new McpError("INVALID_ARGUMENT", `${name} вне лимитов (${minMm}..${maxMm} мм)`);
  }
}

/** Центр столба — внутри любого замкнутого кольца террасы или на его границе (3 см). */
function assertColumnOnTerrace(model: Model, pc: Point): void {
  const rings = borderRingPolygons(bordersOf(model, "terrace_borders"));
  if (rings.length === 0) {
    throw new McpError("INVALID_ARGUMENT", "в редакторе столб террасы ставится при существующей террасе — сначала нарисуйте замкнутую террасу (terrace_add)", {
      details: { kind: "terrace_required" },
    });
  }
  const inside = rings.some((ring) => pointInPolygon(ring, pc) || borderRingContact(ring, pc, COLUMN_DEFS.snapTolCm));
  if (!inside) {
    throw new McpError("GEOMETRY_CONFLICT", "столб террасы ставится на террасе — центр вне контура террасы", {
      details: { kind: "outside_terrace", pc },
    });
  }
}

/** Столб не пересекает другие колонны/столбы (касание — не пересечение). */
function assertColumnNoOverlap(model: Model, pillar: Pillar): void {
  for (const other of Object.values(model.pillars)) {
    const otherPoly: Polygon = other.p1 && other.p4 ? [other.p1, other.p2, other.p3, other.p4] : [];
    if (otherPoly.length === 4 && overlapArea([pillar.p1, pillar.p2, pillar.p3, pillar.p4], otherPoly) > 0.01) {
      throw new McpError("GEOMETRY_CONFLICT", `столб пересекает другую колонну (${other.id})`, {
        details: { kind: "pillar_over_pillar", other_id: other.id },
      });
    }
  }
}

/** Геометрия столба (углы, грани) — общая для add и update. */
function buildTerraceColumn(id: string, pc: Point, width: number, height: number, totalHeight: number): Pillar {
  const hw = width / 2;
  const hh = height / 2;
  const corners: [Point, Point, Point, Point] = [
    { x: r2(pc.x - hw), y: r2(pc.y - hh) },
    { x: r2(pc.x + hw), y: r2(pc.y - hh) },
    { x: r2(pc.x + hw), y: r2(pc.y + hh) },
    { x: r2(pc.x - hw), y: r2(pc.y + hh) },
  ];
  return {
    id,
    inRoom: 0,
    plan: "a",
    role: "terrace_column",
    width,
    height,
    total_height: totalHeight,
    angle: 0,
    f0offset: 0,
    pc: { x: r2(pc.x), y: r2(pc.y) },
    p1: corners[0],
    p2: corners[1],
    p3: corners[2],
    p4: corners[3],
    edges: [
      { p1: corners[0], p2: corners[1], side: "t", no_wall: 1 },
      { p1: corners[1], p2: corners[2], side: "r", no_wall: 1 },
      { p1: corners[2], p2: corners[3], side: "b", no_wall: 1 },
      { p1: corners[3], p2: corners[0], side: "l", no_wall: 1 },
    ],
    eds: {},
    show_dls: true,
  };
}

/** Контакт точки с контуром (расстояние до сторон ≤ tol). */
export function borderRingContact(ring: Polygon, pc: Point, tolCm: number): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((pc.x - a.x) * (b.x - a.x) + (pc.y - a.y) * (b.y - a.y)) / (len * len)));
    const proj = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    if (Math.hypot(pc.x - proj.x, pc.y - proj.y) <= tolCm) return true;
  }
  return false;
}

/**
 * terrace_column_update: центр/габариты (мм). Ревью 66 №1: кандидат строится на
 * основе исходного объекта — непереданные размеры и прочие свойства (поля UI)
 * сохраняются; identity (id) не меняется. Проверки размещения (терраса, пересечения)
 * — те же, что в add; при ошибке модель не меняется.
 */
export function updateTerraceColumn(model: Model, columnId: string, params: Partial<AddTerraceColumnParams>): Pillar {
  const column = model.pillars[columnId];
  if (!column || column.role !== "terrace_column") throw new McpError("NOT_FOUND", `столб террасы ${columnId} не найден`);
  finite("center.x", params.center?.x);
  finite("center.y", params.center?.y);
  finite("width_mm", params.widthMm);
  finite("height_mm", params.heightMm);
  assertColumnSize("width_mm", params.widthMm, COLUMN_DEFS.widthMinCm * 10, COLUMN_DEFS.widthMaxCm * 10);
  assertColumnSize("height_mm", params.heightMm, COLUMN_DEFS.heightMinCm * 10, COLUMN_DEFS.heightMaxCm * 10);
  const backup = structuredClone(model.pillars);
  try {
    delete model.pillars[columnId];
    const centerMm = params.center ?? { x: column.pc.x * 10, y: column.pc.y * 10 };
    const pc = { x: mmToCm(centerMm.x), y: mmToCm(centerMm.y) };
    assertColumnOnTerrace(model, pc);
    const widthCm = params.widthMm !== undefined ? mmToCm(params.widthMm) : column.width;
    const heightCm = params.heightMm !== undefined ? mmToCm(params.heightMm) : column.height;
    // кандидат — клон исходного объекта: непереданные свойства (поля UI) сохраняются;
    // заменяется только геометрия (углы/грани пересчитаны под новый центр и габариты)
    const updated = structuredClone(column);
    const geometry = buildTerraceColumn(columnId, pc, widthCm, heightCm, column.total_height ?? 270);
    updated.pc = geometry.pc;
    updated.p1 = geometry.p1;
    updated.p2 = geometry.p2;
    updated.p3 = geometry.p3;
    updated.p4 = geometry.p4;
    updated.width = geometry.width;
    updated.height = geometry.height;
    updated.edges = geometry.edges;
    updated.inRoom = 0;
    updated.f0offset = 0;
    updated.total_height = geometry.total_height;
    assertColumnNoOverlap(model, updated);
    model.pillars[columnId] = updated;
    return updated;
  } catch (e) {
    model.pillars = backup;
    throw e;
  }
}

/** terrace_column_delete. */
export function deleteTerraceColumn(model: Model, columnId: string): void {
  const column = model.pillars[columnId];
  if (!column || column.role !== "terrace_column") throw new McpError("NOT_FOUND", `столб террасы ${columnId} не найден`);
  delete model.pillars[columnId];
}

/**
 * Расхождение границ террас/участка между двумя наборами (этап 64): идентичности
 * и концы отрезков (допуск 0,1 см). Возвращает человекочитаемые расхождения.
 */
export function borderMismatches(expected: Record<string, TerraceBorder>, got: Record<string, unknown>, name: string): string[] {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined, tol: number): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
  for (const [id, b0] of Object.entries(expected)) {
    const b = got[id] as TerraceBorder | undefined;
    if (!b) {
      out.push(`${id}: ${name} исчезла после сохранения`);
      continue;
    }
    if (!near(b.p1?.x, b0.p1?.x, 0.1) || !near(b.p1?.y, b0.p1?.y, 0.1)) {
      out.push(`${id}: начало сместилось (на сервере ${b.p1?.x},${b.p1?.y}; ожидалось ${b0.p1?.x},${b0.p1?.y})`);
    }
    if (!near(b.p2?.x, b0.p2?.x, 0.1) || !near(b.p2?.y, b0.p2?.y, 0.1)) {
      out.push(`${id}: конец сместился (на сервере ${b.p2?.x},${b.p2?.y}; ожидалось ${b0.p2?.x},${b0.p2?.y})`);
    }
  }
  return out;
}
