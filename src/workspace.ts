import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BACKUPS_DIR } from "./config.ts";
import { McpError } from "./errors.ts";
import type { SessionState } from "./session.ts";
import type { LoadedModel } from "./api.ts";
import type { NormalizeResult, EditorSaveResult, RenderOptions, CompatInfo, EditorRoom } from "./editor/adapter.ts";
import type { Model, Point } from "./model/types.ts";
import type { RoomPolygon } from "./model/items.ts";
import { roomPolygons } from "./model/items.ts";
import { prepareForRestore, findUnattachedEnds, wallAxisSegments, wallAxisSetsEqual, wallAxisCoverageCm, type WallAxisSegment } from "./model/walls.ts";
import { renderPlanToFile, type RenderedPlan, type RenderRevision } from "./render.ts";
import { borderMismatches } from "./model/terraces.ts";
import { levelHoleMismatches } from "./model/floorhole.ts";
import type { Model as TerracesModel } from "./model/types.ts";

/** Потеря/изменение границ террас и участка (сверка семантики, этап 64). */
function borderMismatchesOf(model: TerracesModel, got: { terrace_borders?: Record<string, unknown>; territory_borders?: Record<string, unknown> }): string[] {
  return [
    ...borderMismatches(structuredClone(model.terrace_borders ?? {}), got.terrace_borders ?? {}, "граница террасы"),
    ...borderMismatches(structuredClone(model.territory_borders ?? {}), got.territory_borders ?? {}, "граница участка"),
  ];
}

/** Сверка границ террас/участка локальной модели с редактором (нормализация/save). */
function checkBordersAfterNormalize(local: Model, norm: { terrace_borders?: Record<string, unknown>; territory_borders?: Record<string, unknown> }): string[] {
  const mismatches = borderMismatchesOf(local as unknown as TerracesModel, norm);
  const wsTerraceIds = new Set(Object.keys(local.terrace_borders ?? {}));
  const wsTerritoryIds = new Set(Object.keys(local.territory_borders ?? {}));
  const normTerraceIds = new Set(Object.keys(norm.terrace_borders ?? {}));
  const normTerritoryIds = new Set(Object.keys(norm.territory_borders ?? {}));
  const missing = [
    ...missingIds(wsTerraceIds, normTerraceIds).map((id) => `${id}: граница террасы потеряна`),
    ...missingIds(wsTerritoryIds, normTerritoryIds).map((id) => `${id}: граница участка потеряна`),
  ];
  const extra = [
    ...missingIds(normTerraceIds, wsTerraceIds).map((id) => `${id}: граница террасы добавлена редактором`),
    ...missingIds(normTerritoryIds, wsTerritoryIds).map((id) => `${id}: граница участка добавлена редактором`),
  ];
  return [...missing, ...extra, ...mismatches.filter((m) => !missing.some((k) => m.startsWith(`${k.split(":")[0]!}:`)))];
}

/** Сверка проёмов в полу локальной модели с редактором (нормализация/save). */
function checkLevelHolesAfterNormalize(local: Model, norm: Model): string[] {
  const wsIds = new Set(Object.keys(local.level_holes ?? {}));
  const normIds = new Set(Object.keys(norm.level_holes ?? {}));
  const lost = missingIds(wsIds, normIds);
  const mismatches = levelHoleMismatches(structuredClone(local.level_holes ?? {}), norm.level_holes ?? {});
  return [
    ...lost.map((id) => `${id}: проём в полу потерян`),
    ...missingIds(normIds, wsIds).map((id) => `${id}: проём в полу добавлен редактором`),
    ...mismatches.filter((m) => !lost.some((id) => m.startsWith(`${id}:`))),
  ];
}

// T17: рабочее пространство — открытые проекты, каноническая модель (GET), история
// undo/redo (до 50), dirty, save_id, снимок в backups/ перед сохранением, SAVE_CONFLICT.

/** Подмножество EditorHandle, нужное workspace (структурно совместимо с EditorHandle). */
export type EditorLike = {
  objectId: string;
  planId: string;
  normalize(model: Record<string, unknown>, waitMs?: number): Promise<NormalizeResult>;
  save(timeoutMs?: number): Promise<EditorSaveResult>;
  renderPng(options?: RenderOptions): Promise<Buffer>;
  compatInfo(): Promise<CompatInfo>;
  close(): Promise<void>;
};

/** Сетевые зависимости workspace — вводятся снаружи (юнит-тесты подставляют моки). */
export type WorkspaceDeps = {
  session: SessionState;
  loadModel(session: SessionState, objectId: string, planId: string): Promise<LoadedModel>;
  openEditor(session: SessionState, objectId: string, planId: string, options?: { anonymous?: boolean }): Promise<EditorLike>;
};

export type OpenProject = {
  objectId: string;
  planId: string;
  saveId: string;
  dirty: boolean;
  openedAt: string;
  /** Анонимный проект: редактору отдаётся сессия без аккаунтных cookies (инцидент 2026-11-15). */
  anon: boolean;
};

export type SaveOutcome = {
  save_id: string;
  save_id_before: string;
  backup_path: string;
  verified: boolean;
  rounds: number;
  /** Сверка с серверной версией перед записью: сколько объектов сервера будет удалено. */
  will_delete: { walls: number; openings: number; items: number; pillars: number; rigels: number; gas_lines: number; terrace_borders: number; territory_borders: number; level_holes: number };
  /** Предупреждения (удаления объектов сервера). */
  warnings: string[];
};

export type HistorySnapshot = { label: string; at: string };

export const MAX_HISTORY = 50;

/** Результат мутации стен: полезное значение + предупреждения (офлайн-режим). */
export type WallMutation<T> = { result: T; warnings: string[] };

/** Счётчики объектов модели: стены, проёмы, предметы, колонны, ригели, газовые линии, границы террас/участка, проёмы пола. */
export function modelCounts(model: Model | Record<string, unknown>): { walls: number; openings: number; items: number; pillars: number; rigels: number; gas_lines: number; terrace_borders: number; territory_borders: number; level_holes: number } {
  const m = model as Model;
  const walls = m.walls ?? {};
  return {
    walls: Object.keys(walls).length,
    openings: Object.values(walls).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0),
    items: Object.keys(m.items ?? {}).length,
    pillars: Object.keys(m.pillars ?? {}).length,
    rigels: Object.keys(m.rigels ?? {}).length,
    gas_lines: Object.keys(m.pipes_gas ?? {}).length,
    terrace_borders: Object.keys(m.terrace_borders ?? {}).length,
    territory_borders: Object.keys(m.territory_borders ?? {}).length,
    level_holes: Object.keys(m.level_holes ?? {}).length,
  };
}

/** Короткий хэш содержимого модели (для ревизии рендера и сверок). */
export function modelHash(model: Model): string {
  return createHash("sha256").update(JSON.stringify(model)).digest("hex").slice(0, 16);
}

/** Счётчики ошибок редактора (copy("server").errors) — рост → INVALID_GEOMETRY (§12.4). */
function errorGrowth(before: Record<string, number> | null | undefined, after: Record<string, number> | null | undefined): string[] {
  if (!before || !after) return [];
  const grown: string[] = [];
  for (const [k, v] of Object.entries(after)) {
    if ((before[k] ?? 0) < v) grown.push(`${k}: ${before[k] ?? 0}→${v}`);
  }
  return grown;
}

/** Разобранная модель без содержимого: ни стен, ни предметов, ни прочих сущностей. */
export function modelIsContentEmpty(model: Model): boolean {
  const c = modelCounts(model);
  if (c.walls > 0 || c.items > 0) return false;
  const nonEmpty = (v: unknown): boolean => v !== null && v !== undefined && typeof v === "object" && Object.keys(v as object).length > 0;
  if (nonEmpty(model.pillars) || nonEmpty(model.rigels) || nonEmpty(model.rulers) || nonEmpty(model.comments)) return false;
  if (nonEmpty(model.pipes_gas)) return false;
  if (nonEmpty(model.terrace_borders) || nonEmpty(model.territory_borders) || nonEmpty(model.level_holes)) return false;
  if (nonEmpty(model.rooms2) || nonEmpty(model.rooms1)) return false;
  return true;
}

/** Есть ли в сыром JSON модели непустые объекты/массивы вне корня (ревью v0.1.1 №2):
 *  при пустой разобранной модели это признак необработанных сущностей. */
function rawJsonHasEntities(value: unknown, depth = 0): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") {
    if (depth > 0 && Object.keys(value).length > 0) return true;
    return Object.values(value as Record<string, unknown>).some((v) => rawJsonHasEntities(v, depth + 1));
  }
  return false;
}

/** id проёмов модели: id holes по всем стенам (ревью v0.1.1 №4/№5 — сравнение по id). */
function openingIds(model: Model): Set<string> {
  const out = new Set<string>();
  for (const [wid, w] of Object.entries(model.walls ?? {})) {
    for (const [hid, h] of Object.entries(w.holes ?? {})) {
      out.add((h as { id?: string }).id ?? `${wid}/${hid}`);
    }
  }
  return out;
}

/** Список id серверных объектов, которых нет в локальной модели (ревью v0.1.1 №5):
 *  разность идентичностей, а не разность общих счётчиков — удаление одного объекта
 *  с добавлением другого не маскируется. */
function missingIds(server: Set<string>, local: Set<string>): string[] {
  return [...server].filter((id) => !local.has(id)).sort();
}

/**
 * Ось стены покрыта локальными стенами (ревью v0.1.1 финал F-1): отрезок оси стены
 * лежит на той же прямой, что и какой-то локальный осевой отрезок, и целиком внутри
 * него (с допуском 1 мм). Смена идентификатора стены при нормализации редактора
 * геометрию не меняет — это не потеря.
 */
function wallAxisCoveredBy(wall: { p1: Point; p2: Point } | undefined, localSegments: WallAxisSegment[], tolCm = 0.1): boolean {
  if (!wall) return false;
  const segs = wallAxisSegments({ w: wall });
  if (segs.length === 0) return false;
  return segs.every((s) =>
    localSegments.some(
      (t) =>
        Math.abs(t.ux - s.ux) <= 1e-6 && Math.abs(t.uy - s.uy) <= 1e-6 &&
        Math.abs(t.offset - s.offset) <= tolCm &&
        t.a <= s.a + tolCm && t.b >= s.b - tolCm,
    ),
  );
}

/** Значимая геометрия колонны для сверки после сохранения (ревью 43 №2). */
type PillarSig = { pc?: { x: number; y: number }; width?: number; height?: number; angle?: number };

/**
 * Расхождение колонн между рабочей копией и сервером после save (ревью 43 №2):
 * идентичности и значимая геометрия (pc, width, height, angle; допуск 0,1 см / 0,1°).
 * Угол — циклическая разность modulo 360 (ревью 44 №6): эквивалентная нормализация
 * 360°→0° не расхождение. Возвращает список человекочитаемых расхождений; пустой
 * список — колонны сохранились.
 */
function pillarVerificationMismatches(expected: Record<string, PillarSig>, got: Record<string, unknown>): string[] {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined, tol: number): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
  const angleDiff = (a: number, b: number): number => {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
  };
  for (const [id, p] of Object.entries(expected)) {
    const g = got[id] as PillarSig | undefined;
    if (!g) {
      out.push(`${id}: колонна исчезла после сохранения`);
      continue;
    }
    if (!near(g.pc?.x, p.pc?.x, 0.1) || !near(g.pc?.y, p.pc?.y, 0.1)) {
      out.push(`${id}: центр сместился (на сервере ${g.pc?.x},${g.pc?.y}; ожидалось ${p.pc?.x},${p.pc?.y})`);
    }
    if (!near(g.width, p.width, 0.1)) out.push(`${id}: ширина изменилась (на сервере ${g.width}; ожидалось ${p.width})`);
    if (!near(g.height, p.height, 0.1)) out.push(`${id}: глубина изменилась (на сервере ${g.height}; ожидалось ${p.height})`);
    if (angleDiff(g.angle ?? 0, p.angle ?? 0) > 0.1) out.push(`${id}: угол изменился (на сервере ${g.angle ?? 0}; ожидалось ${p.angle ?? 0})`);
  }
  return out;
}

/** Значимая геометрия ригеля для сверки после сохранения (этап 47). */
type RigelSig = { p1?: Point; p2?: Point; depth?: number; height?: number; ceiling_type?: string };

/** Значимая геометрия/тип предмета для сверки после сохранения (этап 55, ревью №1). */
type ItemSig = { name?: string; pc?: { x: number; y: number }; width?: number; height?: number; angle?: number };

/**
 * Значимая семантика газовой линии для сверки (этап 57, ревью 59 №1, ревью 61 №1 —
 * ПОЛНАЯ сверка, а не по выбранным полям). Сравнивается семантическая проекция
 * всего объекта линии: plan и остальные скалярные поля (набор полей задаёт
 * ожидаемая сторона — лишние поля сервера не потеря данных), вершины — с
 * согласованным сопоставлением (по стабильному id; при переупорядочивании —
 * по типу и координатам, ревью 61 №6), matrix целиком в обе стороны (направленные
 * рёбра, т.е. и симметрия формата) и соответствие items узлам.
 */
type GasVertexSig = { id?: string; point?: Point; type?: string } & Record<string, unknown>;

type GasLineSig = {
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

/** Есть ли направленное ребро i→j в матрице смежности (некорректные индексы — нет). */
function gasEdge(line: GasLineSig, i: number, j: number): boolean {
  return Boolean((line.matrix?.[i]?.[j] ?? null) !== null);
}

/**
 * Согласованное сопоставление вершин двух графов (ревью 61 №6): сначала по
 * стабильному id (id — identity, редактор может переупорядочивать vertexes),
 * иначе жадно по типу и координатам с допуском GAS_VERTEX_TOL_CM. Возвращает
 * map[i] = индекс вершины в got или null, если согласованного сопоставления нет.
 */
function gasVertexMatch(expected: GasVertexSig[], got: GasVertexSig[]): number[] | null {
  if (expected.length !== got.length) return null;
  const used = new Array<boolean>(got.length).fill(false);
  const map = new Array<number>(expected.length).fill(-1);
  const gotById = new Map<string, number>();
  got.forEach((v, i) => {
    if (typeof v.id === "string" && !gotById.has(v.id)) gotById.set(v.id, i);
  });
  let allById = true;
  expected.forEach((v, i) => {
    const j = typeof v.id === "string" ? gotById.get(v.id) : undefined;
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
 * Расхождение газовых линий между двумя наборами — ПОЛНАЯ семантическая сверка
 * (ревью 61 №1): идентичности, вершины с согласованным сопоставлением (допуск
 * 0,1 см), рёбра matrix целиком в обе стороны (длины с допуском 0,02 м),
 * пустота диагонали (петля не проходит, ревью 62 №7), items,
 * plan и все прочие поля ожидаемой стороны; длина линии (допуск 0,02 м).
 * Возвращает список человекочитаемых расхождений; пустой список — совпадают.
 */
function gasLineGraphMismatches(expected: Record<string, GasLineSig>, got: Record<string, unknown>): string[] {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined, tol: number): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
  for (const [id, g0] of Object.entries(expected)) {
    const g = got[id] as GasLineSig | undefined;
    if (!g) {
      out.push(`${id}: газовая линия исчезла после сохранения`);
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
      if (!near(s.point?.x, e.point?.x, GAS_VERTEX_TOL_CM) || !near(s.point?.y, e.point?.y, GAS_VERTEX_TOL_CM)) {
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
    if (!near(g.length, g0.length, GAS_LENGTH_TOL_M)) out.push(`${id}: длина изменилась (на сервере ${g.length}; ожидалось ${g0.length})`);
    for (const [k, v] of Object.entries(g0)) {
      if (k === "vertexes" || k === "matrix" || k === "items" || k === "type" || k === "length") continue;
      const sVal = (g as Record<string, unknown>)[k];
      if (!deepEqualTol(v, sVal, GAS_LENGTH_TOL_M)) {
        out.push(`${id}: поле ${k} изменилось (на сервере ${JSON.stringify(sVal ?? null)}; ожидалось ${JSON.stringify(v)})`);
      }
    }
  }
  return out;
}

/**
 * Расхождение предметов между нормализованной моделью и сервером после save (этап 55,
 * ревью №1): идентичности и тип/значимая геометрия (name, pc, width, height, angle;
 * допуск 0,1 см / 0,1°, угол — циклическая разность modulo 360). Возвращает список
 * человекочитаемых расхождений; пустой список — предметы сохранились.
 */
function itemVerificationMismatches(expected: Record<string, ItemSig>, got: Record<string, unknown>): string[] {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined, tol: number): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
  const angleDiff = (a: number, b: number): number => {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
  };
  for (const [id, it] of Object.entries(expected)) {
    const g = got[id] as ItemSig | undefined;
    if (!g) {
      out.push(`${id}: предмет исчез после сохранения`);
      continue;
    }
    if ((g.name ?? "") !== (it.name ?? "")) out.push(`${id}: тип изменился (на сервере «${g.name ?? ""}»; ожидалось «${it.name ?? ""}»)`);
    if (!near(g.pc?.x, it.pc?.x, 0.1) || !near(g.pc?.y, it.pc?.y, 0.1)) {
      out.push(`${id}: центр сместился (на сервере ${g.pc?.x},${g.pc?.y}; ожидалось ${it.pc?.x},${it.pc?.y})`);
    }
    if (!near(g.width, it.width, 0.1)) out.push(`${id}: ширина изменилась (на сервере ${g.width}; ожидалось ${it.width})`);
    if (!near(g.height, it.height, 0.1)) out.push(`${id}: глубина изменилась (на сервере ${g.height}; ожидалось ${it.height})`);
    if (angleDiff(g.angle ?? 0, it.angle ?? 0) > 0.1) out.push(`${id}: угол изменился (на сервере ${g.angle ?? 0}; ожидалось ${it.angle ?? 0})`);
  }
  return out;
}

/**
 * Расхождение ригелей между нормализованной моделью и сервером после save (этап 47):
 * идентичности и значимая геометрия (концы оси, толщина, высота, тип отделки;
 * допуск 0,1 см). Возвращает список человекочитаемых расхождений.
 */
function rigelVerificationMismatches(expected: Record<string, RigelSig>, got: Record<string, unknown>): string[] {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined, tol: number): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
  for (const [id, r] of Object.entries(expected)) {
    const g = got[id] as RigelSig | undefined;
    if (!g) {
      out.push(`${id}: ригель исчез после сохранения`);
      continue;
    }
    if (!near(g.p1?.x, r.p1?.x, 0.1) || !near(g.p1?.y, r.p1?.y, 0.1)) {
      out.push(`${id}: начало оси сместилось (на сервере ${g.p1?.x},${g.p1?.y}; ожидалось ${r.p1?.x},${r.p1?.y})`);
    }
    if (!near(g.p2?.x, r.p2?.x, 0.1) || !near(g.p2?.y, r.p2?.y, 0.1)) {
      out.push(`${id}: конец оси сместился (на сервере ${g.p2?.x},${g.p2?.y}; ожидалось ${r.p2?.x},${r.p2?.y})`);
    }
    if (!near(g.depth, r.depth, 0.1)) out.push(`${id}: толщина изменилась (на сервере ${g.depth}; ожидалось ${r.depth})`);
    if (!near(g.height, r.height, 0.1)) out.push(`${id}: высота изменилась (на сервере ${g.height}; ожидалось ${r.height})`);
    if ((g.ceiling_type ?? "") !== (r.ceiling_type ?? "")) out.push(`${id}: тип отделки изменился (на сервере «${g.ceiling_type ?? ""}»; ожидалось «${r.ceiling_type ?? ""}»)`);
  }
  return out;
}

function toModel(raw: Record<string, unknown>): Model {  const model = raw as Model;
  model.walls ??= {};
  model.items ??= {};
  model.pillars ??= {};
  model.rigels ??= {};
  model.rulers ??= {};
  model.comments ??= {};
  // сервер отдаёт holes: null у стен без проёмов — нормализуем в {}
  for (const w of Object.values(model.walls)) {
    w.holes ??= {};
  }
  return model;
}

/** Короткий код листа в модели (item.plan) → код листа в навигации редактора (features §2). */
const SHEET_CODE_BY_PLAN: Record<string, string> = {
  a: "init",
  b: "break_walls",
  c: "create_walls",
  rooms: "rooms",
  furniture: "furniture",
  santeh: "santeh",
};

/** id предметов, которые должны быть видны на листе sheet (ревью v0.1.1 №3):
 *  слой предмета задаётся item.plan; предметы других листов на sheet скрыты. */
export function itemIdsForSheet(model: Model, sheet: string): string[] {
  return Object.entries(model.items ?? {})
    .filter(([, it]) => (SHEET_CODE_BY_PLAN[Object.keys(it.plan ?? {})[0] ?? ""] ?? null) === sheet)
    .map(([key, it]) => it.id ?? key);
}

export class Workspace {
  readonly deps: WorkspaceDeps;
  project: OpenProject | null = null;
  private modelInternal: Model | null = null;
  /** Снимки истории: JSON-строки модели; historyIndex указывает на текущее состояние. */
  private snapshots: { json: string; label: string; at: number }[] = [];
  private historyIndex = -1;
  private editorInternal: EditorLike | null = null;
  /** Комнаты последней нормализации (кеш workspace, design §12.5): выручает, когда в
   *  канонической копии rooms2 ещё пусто (редактор кладёт полигоны после save → reload). */
  private roomsCache: EditorRoom[] = [];
  /** Офлайн-режим: стены меняются без нормализации (REMPLANNER_OFFLINE_FIXTURE). */
  offline = false;
  /** Базовые счётчики ошибок редактора для проверки роста (§12.4). */
  private lastErrors: Record<string, number> | null = null;
  /** Проект открыт с пустой моделью (дефект 3, отчёт 11) — сохранение под защитой. */
  private openedEmpty = false;

  constructor(deps: WorkspaceDeps, options: { offline?: boolean } = {}) {
    this.deps = deps;
    this.offline = options.offline ?? false;
  }

  get model(): Model {
    if (!this.modelInternal) {
      throw new McpError("INVALID_ARGUMENT", "проект не открыт — сначала project_open");
    }
    return this.modelInternal;
  }

  get editor(): EditorLike {
    if (!this.editorInternal) {
      throw new McpError("INVALID_ARGUMENT", "редактор не запущен (запускается при сохранении/рендере)");
    }
    return this.editorInternal;
  }

  /** Запущен ли редактор (для инструментов, которым он нужен опционально). */
  editorOrNull(): EditorLike | null {
    return this.editorInternal;
  }

  /**
   * Каноническая модель читается по HTTP (GET /setup/api/planner/).
   * opts.anon — анонимный проект: редактор открывается без аккаунтных cookies
   * (инцидент 2026-11-15), его фактические object_id/plan_id принимаются как целевые.
   */
  async open(objectId: string, planId = "1", opts: { anon?: boolean } = {}): Promise<OpenProject> {
    const loaded = await this.deps.loadModel(this.deps.session, objectId, planId);
    this.modelInternal = toModel(structuredClone(loaded.model));
    // Ревью v0.1.1 №2: валидная пустая модель — не потеря данных, новый или очищенный
    // проект должен открываться. MODEL_PARSE_EMPTY — только когда data непустой, разбор
    // дал пустую модель, а в сыром JSON есть объекты (схема не распознана адаптером).
    // Проверка по сырому JSON, не по save_id: save_id > 0 не доказывает наличие объектов.
    if (modelIsContentEmpty(this.modelInternal) && loaded.data_empty === false && rawJsonHasEntities(loaded.model)) {
      this.modelInternal = null;
      throw new McpError("MODEL_PARSE_EMPTY", `сервер вернул модель с данными, но разобранная модель пустая (save_id ${loaded.save_id}) — схема данных не распознана`, {
        hint: "не сохраняйте этот проект: повторите project_open; если повторяется — модель проекта не разобрана адаптером",
        details: { object_id: objectId, plan_id: loaded.plan_id || planId, save_id: loaded.save_id, data_empty: loaded.data_empty ?? null },
      });
    }
    this.openedEmpty = modelIsContentEmpty(this.modelInternal);
    if (this.editorInternal && (this.editorInternal.objectId !== objectId || this.editorInternal.planId !== planId)) {
      await this.editorInternal.close().catch(() => {});
      this.editorInternal = null;
    }
    this.project = {
      objectId,
      planId: loaded.plan_id || planId,
      saveId: loaded.save_id,
      dirty: false,
      openedAt: new Date().toISOString(),
      anon: opts.anon ?? false,
    };
    this.snapshots = [];
    this.historyIndex = -1;
    this.pushSnapshot("open");
    return this.project;
  }

  /**
   * Комнаты: из rooms2 канонической модели, при пустом — из кеша последней
   * нормализации (T27). Полигон в см, площадь по внутренним граням.
   */
  rooms(): RoomPolygon[] {
    const fromModel = roomPolygons(this.model);
    if (fromModel.length > 0) return fromModel;
    return this.roomsCache
      .filter((r) => Array.isArray(r.polygon) && r.polygon.length >= 3)
      .map((r) => ({
        roomId: r.id,
        polygon: r.polygon!,
        areaCm2: (r.area_m2 ?? 0) * 10_000,
        axisAreaCm2: null,
      }));
  }

  private pushSnapshot(label: string): void {
    this.snapshots.splice(this.historyIndex + 1);
    this.snapshots.push({ json: JSON.stringify(this.model), label, at: Date.now() });
    if (this.snapshots.length > MAX_HISTORY) this.snapshots.shift();
    this.historyIndex = this.snapshots.length - 1;
  }

  /**
   * Мутация стен (design §12.5, T28): клон → правило Node → normalize → проверки §12.4
   * (isOverWall, потерянная связь, рост errors) → замена канонической копии.
   * Любая ошибка оставляет рабочую модель нетронутой. Пакет операций (полилиния,
   * комната) нормализуется ОДИН раз. В офлайн-режиме — без нормализации,
   * предупреждение EDITOR_REQUIRED_FOR_ROOMS.
   */
  async applyWalls<T>(label: string, fn: (model: Model) => T): Promise<WallMutation<T>> {
    if (!this.project) throw new McpError("INVALID_ARGUMENT", "проект не открыт — сначала project_open");
    const clone = structuredClone(this.modelInternal!);
    const result = fn(clone);
    const warnings: string[] = [];
    if (this.offline) {
      this.modelInternal = clone;
      warnings.push("EDITOR_REQUIRED_FOR_ROOMS");
    } else {
      const editor = await this.ensureEditor();
      const prepared = structuredClone(clone);
      prepareForRestore(prepared);
      const norm = await editor.normalize(prepared as unknown as Record<string, unknown>);
      // §12.4: наложение стен
      const over = (norm.walls ?? []).filter((w) => w.overWall).map((w) => w.id);
      if (over.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор насчитал наложение стен (${over.join(", ")}) — мутация отменена`, {
          details: { over_walls: over },
        });
      }
      // §12.4: конец, который Node ставил на грань или в узел, остался без связи
      const dangling = findUnattachedEnds(norm.walls ?? []);
      if (dangling.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации у стен остались несоединённые концы (${dangling.slice(0, 5).map((d) => `${d.wallId}.${d.node}`).join(", ")})`, {
          details: { unattached: dangling },
        });
      }
      // §12.4: выросли счётчики ошибок редактора
      const grown = errorGrowth(this.lastErrors ?? (this.modelInternal!["errors"] as Record<string, number> | undefined) ?? null, norm.errors ?? null);
      if (grown.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `выросли ошибки редактора: ${grown.join(", ")}`, {
          details: { errors: norm.errors },
        });
      }
      if (norm.errors) this.lastErrors = norm.errors;
      // ревью 43 №1: колонны после нормализации не теряются (сверка идентичностей)
      const wsPillarIds = new Set(Object.keys(this.modelInternal!.pillars ?? {}));
      const normPillarIds = new Set(Object.keys((norm.model as { pillars?: Record<string, unknown> }).pillars ?? {}));
      const lostPillarsNorm = missingIds(wsPillarIds, normPillarIds);
      if (lostPillarsNorm.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял колонны (${lostPillarsNorm.join(", ")}) — мутация отменена`, {
          details: { lost_pillars: lostPillarsNorm },
        });
      }
      // этап 47: ригели после нормализации не теряются (сверка идентичностей)
      const wsRigelIds = new Set(Object.keys(this.modelInternal!.rigels ?? {}));
      const normRigelIds = new Set(Object.keys((norm.model as { rigels?: Record<string, unknown> }).rigels ?? {}));
      const lostRigelsNorm = missingIds(wsRigelIds, normRigelIds);
      if (lostRigelsNorm.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял ригели (${lostRigelsNorm.join(", ")}) — мутация отменена`, {
          details: { lost_rigels: lostRigelsNorm },
        });
      }
      // этап 57: газовые линии после нормализации не теряются (сверка идентичностей);
      // ревью 59 №1: кроме идентичностей сверяется семантический граф (узлы, тип,
      // рёбра matrix, длина) — normalizer, обнуливший рёбра, не проходит молча
      const wsGasIds = new Set(Object.keys(this.modelInternal!.pipes_gas ?? {}));
      const normGas = (norm.model as { pipes_gas?: Record<string, unknown> }).pipes_gas ?? {};
      const normGasIds = new Set(Object.keys(normGas));
      const lostGasNorm = missingIds(wsGasIds, normGasIds);
      const gasGraphNorm = gasLineGraphMismatches(
        structuredClone(this.modelInternal!.pipes_gas ?? {}) as Record<string, GasLineSig>,
        normGas,
      );
      if (lostGasNorm.length > 0 || gasGraphNorm.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил газовые линии — мутация отменена`, {
          details: { lost_gas_lines: lostGasNorm, gas_line_mismatches: gasGraphNorm },
        });
      }
      // этап 64: границы террас/участка и проёмы в полу после нормализации не теряются
      const lostBorders = checkBordersAfterNormalize(this.modelInternal!, norm.model as Model);
      if (lostBorders.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил границы террас/участка — мутация отменена`, {
          details: { border_mismatches: lostBorders },
        });
      }
      const lostHoles = checkLevelHolesAfterNormalize(this.modelInternal!, norm.model as Model);
      if (lostHoles.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил проёмы в полу — мутация отменена`, {
          details: { level_hole_mismatches: lostHoles },
        });
      }
      // нормализованная копия становится канонической
      this.modelInternal = toModel(structuredClone(norm.model as unknown as Record<string, unknown>));
      if ((norm.rooms ?? []).length > 0) this.roomsCache = norm.rooms!;
    }
    this.project.dirty = true;
    this.pushSnapshot(label);
    return { result, warnings };
  }

  /**
   * Мутация рабочей копии: fn меняет модель, после — снимок истории и dirty.
   * На сервер не сохраняет: сохранение — только project_save.
   * Этап 55, ревью №6: атомарность общим механизмом — fn получает клон модели и при
   * исключении каноническая копия не меняется (замена только при успехе). Инструменты,
   * которые сами проверяют аргументы до записи, от этого не зависят, но частично
   * изменившую модель при ошибке внутри fn apply откатывает всегда.
   */
  apply<T>(label: string, fn: (model: Model) => T): T {
    const clone = structuredClone(this.modelInternal!);
    const result = fn(clone);
    this.modelInternal = clone;
    this.project!.dirty = true;
    this.pushSnapshot(label);
    return result;
  }

  historyInfo(): { steps: number; canUndo: number; canRedo: number; max: number } {
    return {
      steps: this.snapshots.length - 1,
      canUndo: this.historyIndex,
      canRedo: this.snapshots.length - 1 - this.historyIndex,
      max: MAX_HISTORY,
    };
  }

  undo(steps = 1): { applied: number } {
    let applied = 0;
    while (applied < steps && this.historyIndex > 0) {
      this.historyIndex--;
      applied++;
    }
    if (applied > 0) {
      this.modelInternal = toModel(JSON.parse(this.snapshots[this.historyIndex]!.json) as Record<string, unknown>);
      this.project!.dirty = true;
    }
    return { applied };
  }

  redo(steps = 1): { applied: number } {
    let applied = 0;
    while (applied < steps && this.historyIndex < this.snapshots.length - 1) {
      this.historyIndex++;
      applied++;
    }
    if (applied > 0) {
      this.modelInternal = toModel(JSON.parse(this.snapshots[this.historyIndex]!.json) as Record<string, unknown>);
      this.project!.dirty = true;
    }
    return { applied };
  }

  private backupPath(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return join(BACKUPS_DIR, `${this.project!.objectId}-${this.project!.planId}-${stamp}.json`);
  }

  /** Снимок модели в backups/ перед каждым сохранением. */
  writeBackup(): string {
    const path = this.backupPath();
    mkdirSync(BACKUPS_DIR, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ object_id: this.project!.objectId, plan_id: this.project!.planId, save_id: this.project!.saveId, saved_at: new Date().toISOString(), model: this.modelInternal }, null, 1),
      { mode: 0o600 },
    );
    return path;
  }

  /**
   * Сохранение: сверка save_id с сервером (SAVE_CONFLICT при расхождении, минуя force),
   * снимок в backups/, нормализация редактором, project.save, проверка по GET
   * (надёжнее save_id — отчёт 05, факт 6) с одним повтором при расхождении.
   * Принудительная запись поверх чужих правок — только при явном force: true.
   */
  async save(options: { force?: boolean } = {}): Promise<SaveOutcome> {
    const p = this.project;
    if (!p) throw new McpError("INVALID_ARGUMENT", "проект не открыт");
    const saveIdBefore = p.saveId;
    const fresh = await this.deps.loadModel(this.deps.session, p.objectId, p.planId);
    // Дефект 3 (отчёт 11): защита от затирания непустого сервера пустой моделью —
    // проект, открытый с пустой моделью, сохраняется только с явным force.
    if (
      !options.force && this.openedEmpty &&
      modelIsContentEmpty(this.modelInternal!) && !modelIsContentEmpty(fresh.model as Model)
    ) {
      throw new McpError("SAVE_CONFLICT", "проект был открыт с пустой моделью, а на сервере модель непустая — сохранение удалило бы её объекты", {
        hint: "перечитайте проект (project_open) или сохраните принудительно force: true",
        details: { server: modelCounts(fresh.model) },
      });
    }
    // ревью v0.1.1 №5: предупреждение об удалениях — разность идентичностей (id
    // объектов сервера, которых нет в рабочей копии), а не разность общих счётчиков.
    // Ревью v0.1.1 финал F-1: стена, чья ось покрыта локальными стенами, не потеряна —
    // нормализация редактора могла сменить её идентификатор; это отдельное замечание
    const serverModel = fresh.model as Model;
    const localWallSegments = wallAxisSegments(this.modelInternal!.walls);
    const serverWallsMissing = missingIds(new Set(Object.keys(serverModel.walls ?? {})), new Set(Object.keys(this.modelInternal!.walls)));
    const renamedWalls = serverWallsMissing.filter((id) => wallAxisCoveredBy(serverModel.walls?.[id] as { p1: Point; p2: Point } | undefined, localWallSegments));
    const deletedWalls = serverWallsMissing.filter((id) => !renamedWalls.includes(id));
    const deletedIds = {
      walls: deletedWalls,
      renamedWalls,
      openings: missingIds(openingIds(serverModel), openingIds(this.modelInternal!)),
      items: missingIds(new Set(Object.keys(serverModel.items ?? {})), new Set(Object.keys(this.modelInternal!.items ?? {}))),
      pillars: missingIds(new Set(Object.keys(serverModel.pillars ?? {})), new Set(Object.keys(this.modelInternal!.pillars ?? {}))),
      rigels: missingIds(new Set(Object.keys(serverModel.rigels ?? {})), new Set(Object.keys(this.modelInternal!.rigels ?? {}))),
      gas_lines: missingIds(new Set(Object.keys(serverModel.pipes_gas ?? {})), new Set(Object.keys(this.modelInternal!.pipes_gas ?? {}))),
      terrace_borders: missingIds(new Set(Object.keys(serverModel.terrace_borders ?? {})), new Set(Object.keys(this.modelInternal!.terrace_borders ?? {}))),
      territory_borders: missingIds(new Set(Object.keys(serverModel.territory_borders ?? {})), new Set(Object.keys(this.modelInternal!.territory_borders ?? {}))),
      level_holes: missingIds(new Set(Object.keys(serverModel.level_holes ?? {})), new Set(Object.keys(this.modelInternal!.level_holes ?? {}))),
    };
    const willDelete = {
      walls: deletedIds.walls.length,
      openings: deletedIds.openings.length,
      items: deletedIds.items.length,
      pillars: deletedIds.pillars.length,
      rigels: deletedIds.rigels.length,
      gas_lines: deletedIds.gas_lines.length,
      terrace_borders: deletedIds.terrace_borders.length,
      territory_borders: deletedIds.territory_borders.length,
      level_holes: deletedIds.level_holes.length,
    };
    const warnings: string[] = [];
    const idList = (ids: string[]): string => `${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ", …" : ""}`;
    if (willDelete.walls > 0) warnings.push(`будут удалены стены (${willDelete.walls}), которых нет в модели: ${idList(deletedIds.walls)}`);
    if (deletedIds.renamedWalls.length > 0) warnings.push(`идентификаторы стен изменились (${deletedIds.renamedWalls.length}) — геометрия сохранена, это нормализация, а не потеря: ${idList(deletedIds.renamedWalls)}`);
    if (willDelete.openings > 0) warnings.push(`будут удалены проёмы (${willDelete.openings}), которых нет в модели: ${idList(deletedIds.openings)}`);
    if (willDelete.items > 0) warnings.push(`будут удалены предметы (${willDelete.items}), которых нет в модели: ${idList(deletedIds.items)}`);
    if (willDelete.pillars > 0) warnings.push(`будут удалены колонны (${willDelete.pillars}), которых нет в модели: ${idList(deletedIds.pillars)}`);
    if (willDelete.rigels > 0) warnings.push(`будут удалены ригели (${willDelete.rigels}), которых нет в модели: ${idList(deletedIds.rigels)}`);
    if (willDelete.gas_lines > 0) warnings.push(`будут удалены газовые линии (${willDelete.gas_lines}), которых нет в модели: ${idList(deletedIds.gas_lines)}`);
    if (willDelete.terrace_borders > 0) warnings.push(`будут удалены границы террас (${willDelete.terrace_borders}), которых нет в модели: ${idList(deletedIds.terrace_borders)}`);
    if (willDelete.territory_borders > 0) warnings.push(`будут удалены границы участка (${willDelete.territory_borders}), которых нет в модели: ${idList(deletedIds.territory_borders)}`);
    if (willDelete.level_holes > 0) warnings.push(`будут удалены проёмы в полу (${willDelete.level_holes}), которых нет в модели: ${idList(deletedIds.level_holes)}`);
    if (fresh.save_id !== saveIdBefore) {
      if (!this.editorInternal && !options.force) {
        throw new McpError(
          "SAVE_CONFLICT",
          `save_id на сервере (${fresh.save_id}) новее рабочей копии (${saveIdBefore}) — проект правился в другом месте`,
          { hint: "перезапишите рабочую копию project_open или сохраните принудительно force: true" },
        );
      }
      // наш собственный редактор легитимно продвигает save_id (автосейвы при
      // инициализации/нормализации, отчёт 05 факт 6): принимаем свежий как базу —
      // реальный чужой конфликт поймает диалог редактора «Сохранить все равно»
      // (adapter.save → conflict) и сверка контента после сохранения
      p.saveId = fresh.save_id;
    }
    const backupPath = this.writeBackup();
    if (!this.editorInternal) {
      await this.ensureEditor();
    }
    const expected = {
      walls: Object.keys(this.modelInternal!.walls).length,
      holes: Object.values(this.modelInternal!.walls).reduce((n, w) => n + Object.keys(w.holes).length, 0),
      // стены — канонический набор осевых отрезков (ревью v0.1.1-r2 R2-3):
      // разрез/слияние коллинеарных стен эквивалентны, сдвиг и лишние стены — нет
      segments: wallAxisSegments(this.modelInternal!.walls),
      coverage: wallAxisCoverageCm(this.modelInternal!.walls),
    };
    const editor = await this.ensureEditor();
    const prepared = structuredClone(this.modelInternal!);
    prepareForRestore(prepared);
    const norm = await editor.normalize(prepared as unknown as Record<string, unknown>);
    if ((norm.rooms ?? []).length > 0) this.roomsCache = norm.rooms!;
    // потеря проёмов/предметов — по id в копии редактора (ревью v0.1.1 №4)
    const localOpeningIds = openingIds(this.modelInternal!);
    const localItemIds = new Set(Object.keys(this.modelInternal!.items ?? {}));
    const localPillarIds = new Set(Object.keys(this.modelInternal!.pillars ?? {}));
    // ревью 43 №2/№4: ожидаемые колонны и комнаты для верификации после save.
    // ревью 45 №5: потеря комнат меряется относительно результата нормализации
    // (того, что ушло на save), а не устаревших rooms2 рабочей копии: пользователь
    // мог сам разомкнуть контур — тогда исчезновение комнаты при нормализации
    // штатно. roomsBefore нужны только для предупреждения о нормализации.
    const expectedPillars = structuredClone(this.modelInternal!.pillars ?? {}) as Record<string, PillarSig>;
    const roomsBefore = Object.keys(this.modelInternal!.rooms2 ?? {}).length;
    const normWalls = (norm.model as { walls?: Record<string, { holes?: Record<string, { id?: string }> }> }).walls ?? {};
    const gotOpeningIds = new Set<string>();
    for (const [wid, w] of Object.entries(normWalls)) {
      for (const [hid, h] of Object.entries(w.holes ?? {})) gotOpeningIds.add(h.id ?? `${wid}/${hid}`);
    }
    const gotItemIds = new Set(Object.keys((norm.model as { items?: Record<string, unknown> }).items ?? {}));
    const gotPillarIds = new Set(Object.keys((norm.model as { pillars?: Record<string, unknown> }).pillars ?? {}));
    // этап 47: ожидаемые ригели — из нормализованной модели (того, что ушло на save):
    // редактор при нормализации пересчитывает polygon/l/r, сверять надо то, что реально
    // записано, а не устаревшую рабочую копию
    const expectedRigels = structuredClone((norm.model as { rigels?: Record<string, RigelSig> }).rigels ?? {});
    // этап 55, ревью №1: ожидаемые предметы для верификации после save — из
    // нормализованной модели (того, что ушло на save)
    const expectedItems = structuredClone((norm.model as { items?: Record<string, ItemSig> }).items ?? {});
    const localRigelIds = new Set(Object.keys(this.modelInternal!.rigels ?? {}));
    const gotRigelIds = new Set(Object.keys((norm.model as { rigels?: Record<string, unknown> }).rigels ?? {}));
    // этап 57: газовые линии — ожидаемые (из нормализованной модели, того, что ушло
    // на save: редактор пересчитывает length) и потерянные при нормализации
    const expectedGasLines = structuredClone((norm.model as { pipes_gas?: Record<string, GasLineSig> }).pipes_gas ?? {});
    const localGasIds = new Set(Object.keys(this.modelInternal!.pipes_gas ?? {}));
    const gotGasIds = new Set(Object.keys((norm.model as { pipes_gas?: Record<string, unknown> }).pipes_gas ?? {}));
    // этап 64: ожидаемые границы террас/участка и проёмы в полу — из нормализованной модели
    const expectedBorders = {
      terrace_borders: structuredClone((norm.model as { terrace_borders?: Record<string, unknown> }).terrace_borders ?? {}),
      territory_borders: structuredClone((norm.model as { territory_borders?: Record<string, unknown> }).territory_borders ?? {}),
    };
    const expectedLevelHoles = structuredClone((norm.model as { level_holes?: Record<string, unknown> }).level_holes ?? {});
    const lostOpenings = missingIds(localOpeningIds, gotOpeningIds);
    const lostItems = missingIds(localItemIds, gotItemIds);
    const lostPillars = missingIds(localPillarIds, gotPillarIds);
    const lostRigels = missingIds(localRigelIds, gotRigelIds);
    const lostGasLines = missingIds(localGasIds, gotGasIds);
    // ревью 59 №1: до save сверяется семантический граф локальной и нормализованной
    // моделей (узлы, тип, рёбра matrix, длина) — normalizer, обнуливший рёбра,
    // не проходит как «verified»
    const gasGraphNorm = gasLineGraphMismatches(
      structuredClone(this.modelInternal!.pipes_gas ?? {}) as Record<string, GasLineSig>,
      (norm.model as { pipes_gas?: Record<string, unknown> }).pipes_gas ?? {},
    );
    // этап 64: потери границ и проёмов пола при нормализации
    const bordersNorm = checkBordersAfterNormalize(this.modelInternal!, norm.model as Model);
    const holesNorm = checkLevelHolesAfterNormalize(this.modelInternal!, norm.model as Model);
    const gotSegments = wallAxisSegments(normWalls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
    const gotCoverage = wallAxisCoverageCm(normWalls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
    // ревью 43 №4: комнаты с пользовательскими полями не исчезают при нормализации молча
    const normRooms = Object.keys((norm.model as { rooms2?: Record<string, unknown> }).rooms2 ?? {}).length;
    if (roomsBefore > 0 && normRooms === 0) {
      warnings.push(`редактор убрал комнаты при нормализации (${roomsBefore} → 0) — имя и отделка комнат могут быть потеряны; проверьте rooms_list после сохранения`);
    }
    if (
      !wallAxisSetsEqual(gotSegments, expected.segments) ||
      lostOpenings.length > 0 || lostItems.length > 0 || lostPillars.length > 0 || lostRigels.length > 0 || lostGasLines.length > 0 ||
      gasGraphNorm.length > 0 || bordersNorm.length > 0 || holesNorm.length > 0
    ) {
      throw new McpError("NORMALIZATION_DROPPED", "редактор потерял объекты при нормализации", {
        details: {
          expected_walls: expected.walls,
          after_walls: norm.after.walls,
          coverage_before_mm: Math.round(expected.coverage * 10),
          coverage_after_mm: Math.round(gotCoverage * 10),
          axis_segments_before: expected.segments.length,
          axis_segments_after: gotSegments.length,
          lost_openings: lostOpenings,
          lost_items: lostItems,
          lost_pillars: lostPillars,
          lost_rigels: lostRigels,
          lost_gas_lines: lostGasLines,
          gas_line_mismatches: gasGraphNorm,
          border_mismatches: bordersNorm,
          level_hole_mismatches: holesNorm,
        },
      });
    }
    let rounds = 0;
    let verified = false;
    let finalSaveId = p.saveId;
    for (let attempt = 0; attempt < 2 && !verified; attempt++) {
      const saveRes = await editor.save();
      rounds++;
      if (saveRes.conflict && !options.force) {
        throw new McpError("SAVE_CONFLICT", "сервер ответил диалогом «Сохранить все равно»", {
          hint: "правки в другой вкладке; принудительная запись — только force: true",
        });
      }
      if (!saveRes.ok) {
        throw new McpError("SITE_ERROR", "сохранение не прошло", { details: { save_id: saveRes.saveId } });
      }
      // верификация по GET: контент, а не только save_id (save_id не монотонен).
      // Стены — по каноническому набору осевых отрезков (ревью v0.1.1-r2 R2-3):
      // слияние при сохранении легитимно, сдвиг/лишняя стена — нет.
      // Колонны — по id и значимой геометрии (ревью 43 №2), комнаты — по числу (№4).
      const after = await this.deps.loadModel(this.deps.session, p.objectId, p.planId);
      const wallsAfter = (after.model["walls"] as Record<string, unknown> | undefined) ?? {};
      const segmentsAfter = wallAxisSegments(wallsAfter as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
      const pillarsAfter = (after.model["pillars"] as Record<string, unknown> | undefined) ?? {};
      const roomsAfter = Object.keys((after.model["rooms2"] as Record<string, unknown> | undefined) ?? {}).length;
      const pillarMismatch = pillarVerificationMismatches(expectedPillars, pillarsAfter);
      const rigelsAfter = (after.model["rigels"] as Record<string, unknown> | undefined) ?? {};
      const rigelMismatch = rigelVerificationMismatches(expectedRigels, rigelsAfter);
      // этап 55, ревью №1: предметы после save сверяются по id и типу/геометрии,
      // а не только счётчиком при нормализации
      const itemsAfter = (after.model["items"] as Record<string, unknown> | undefined) ?? {};
      const itemMismatch = itemVerificationMismatches(expectedItems, itemsAfter);
      // этап 57: газовые линии после save сверяются по id, типу, узлам, рёбрам matrix
      // и длине (ревью 59 №1 — топология входит в сверку)
      const gasAfter = (after.model["pipes_gas"] as Record<string, unknown> | undefined) ?? {};
      const gasMismatch = gasLineGraphMismatches(expectedGasLines, gasAfter);
      // этап 64: границы террас/участка и проёмы в полу после save — по нормализованной семантике
      const bordersAfter = {
        terrace_borders: (after.model["terrace_borders"] as Record<string, unknown> | undefined) ?? {},
        territory_borders: (after.model["territory_borders"] as Record<string, unknown> | undefined) ?? {},
      };
      const borderMismatch = checkBordersAfterNormalize(
        { terrace_borders: expectedBorders.terrace_borders, territory_borders: expectedBorders.territory_borders } as Model,
        bordersAfter,
      );
      const holesAfter = (after.model["level_holes"] as Record<string, unknown> | undefined) ?? {};
      const holeMismatch = levelHoleMismatches(expectedLevelHoles as Record<string, import("./model/types.ts").LevelHole>, holesAfter);
      const roomsLost = normRooms > 0 && roomsAfter === 0;
      if (wallAxisSetsEqual(segmentsAfter, expected.segments) && pillarMismatch.length === 0 && rigelMismatch.length === 0 && itemMismatch.length === 0 && gasMismatch.length === 0 && borderMismatch.length === 0 && holeMismatch.length === 0 && !roomsLost) {
        verified = true;
        finalSaveId = after.save_id || saveRes.saveId || finalSaveId;
        this.modelInternal = toModel(structuredClone(after.model));
      } else if (attempt === 1) {
        const coverageAfter = wallAxisCoverageCm(wallsAfter as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
        throw new McpError("SITE_ERROR", "после сохранения модель на сервере не совпала с рабочей копией", {
          details: {
            expected_walls: expected.walls, got_walls: Object.keys(wallsAfter).length,
            coverage_before_mm: Math.round(expected.coverage * 10), coverage_after_mm: Math.round(wallAxisCoverageCm(wallsAfter as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>) * 10),
            axis_segments_before: expected.segments.length, axis_segments_after: segmentsAfter.length,
            pillar_mismatches: pillarMismatch, rigel_mismatches: rigelMismatch, item_mismatches: itemMismatch,
            gas_line_mismatches: gasMismatch,
            border_mismatches: borderMismatch,
            level_hole_mismatches: holeMismatch,
            rooms_expected: normRooms, rooms_on_server: roomsAfter,
          },
        });
      }
    }
    p.saveId = finalSaveId;
    p.dirty = false;
    this.snapshots = [];
    this.historyIndex = -1;
    this.pushSnapshot("saved");
    return { save_id: finalSaveId, save_id_before: saveIdBefore, backup_path: backupPath, verified, rounds, will_delete: willDelete, warnings };
  }

  /**
   * Рендер плана (дефект 1, отчёт 11): перед скриншотом в редактор синхронизируется
   * ВСЯ каноническая модель workspace (стены, проёмы, предметы) — тот же
   * restore→draw→copy, что перед сохранением. Если счётчики объектов, которые
   * видит редактор, расходятся с моделью — RENDER_OUT_OF_SYNC, картинка не отдаётся.
   * В ответе — ревизия: хэш модели и счётчики объектов.
   */
  async renderPlan(options: RenderOptions & { dir?: string } = {}): Promise<RenderedPlan> {
    const editor = await this.ensureEditor();
    const expected = modelCounts(this.modelInternal!);
    const prepared = structuredClone(this.modelInternal!);
    prepareForRestore(prepared);
    const norm = await editor.normalize(prepared as unknown as Record<string, unknown>);
    if ((norm.rooms ?? []).length > 0) this.roomsCache = norm.rooms!;
    const seen = { walls: norm.after.walls, openings: norm.after.holes, items: norm.after.items, pillars: norm.after.pillars ?? Object.keys((norm.model as { pillars?: Record<string, unknown> }).pillars ?? {}).length, rigels: norm.after.rigels ?? Object.keys((norm.model as { rigels?: Record<string, unknown> }).rigels ?? {}).length };
    // стены — по каноническому набору осевых отрезков (ревью v0.1.1-r2 R2-3):
    // слияние/разрез коллинеарных стен — допустимая нормализация, сдвиг и лишние
    // стены — расхождение; проёмы и предметы — по счётчикам
    const localSegments = wallAxisSegments(this.modelInternal!.walls);
    const editorSegments = wallAxisSegments((norm.model as { walls?: Record<string, unknown> }).walls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
    const mismatch: string[] = [];
    if (!wallAxisSetsEqual(editorSegments, localSegments)) {
      mismatch.push(`стены: осевые отрезки в модели ${localSegments.length} (покрытие ${Math.round(wallAxisCoverageCm(this.modelInternal!.walls) * 10)} мм), в редакторе ${editorSegments.length} (покрытие ${Math.round(wallAxisCoverageCm((norm.model as { walls?: Record<string, unknown> }).walls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>) * 10)} мм)`);
    }
    if (seen.openings !== expected.openings) mismatch.push(`openings: в модели ${expected.openings}, в редакторе ${seen.openings}`);
    if (seen.items !== expected.items) mismatch.push(`items: в модели ${expected.items}, в редакторе ${seen.items}`);
    if (seen.pillars !== expected.pillars) mismatch.push(`pillars: в модели ${expected.pillars}, в редакторе ${seen.pillars}`);
    if (seen.rigels !== expected.rigels) mismatch.push(`rigels: в модели ${expected.rigels}, в редакторе ${seen.rigels}`);
    if (mismatch.length > 0) {
      throw new McpError("RENDER_OUT_OF_SYNC", `редактор показывает не текущую модель (${mismatch.join(", ")}) — картинка не отдаётся`, {
        hint: "повторите render_plan; при повторении сверитесь с model_get и model_validate",
        details: { workspace: expected, editor: seen },
      });
    }
    const res = await renderPlanToFile(editor, {
      ...options,
      itemIds: itemIdsForSheet(this.modelInternal!, options.sheet ?? "init"),
    });
    const revision: RenderRevision = {
      model_hash: modelHash(this.modelInternal!),
      save_id: this.project?.saveId ?? null,
      walls: expected.walls,
      openings: expected.openings,
      items: expected.items,
      pillars: expected.pillars,
      rigels: expected.rigels,
      editor: seen,
    };
    return { ...res, revision };
  }

  /** Ленивый запуск редактора (каталог, рендер, сохранение). */
  async ensureEditor(): Promise<EditorLike> {
    if (!this.editorInternal) {
      const p = this.project!;
      // инцидент 2026-11-15: анонимный проект — редактор без аккаунтных cookies;
      // аккаунтный проект — чужой object_id редактора запрещён
      this.editorInternal = await this.deps.openEditor(this.deps.session, p.objectId, p.planId, { anonymous: p.anon });
      const compat = (this.editorInternal as { compat?: { object_id?: string | null; plan_id?: string | null } }).compat;
      if (p.anon) {
        // редактор анонимного проекта создаёт СВОИ object_id/plan_id (body data-атрибуты):
        // сохранение и верификационный GET должны идти туда, куда реально пишет редактор
        if (compat?.object_id) p.objectId = compat.object_id;
        if (compat?.plan_id) p.planId = compat.plan_id;
      } else {
        // фактические id — из адаптера (страница); при недоступности сверки её ловит
        // предсохранительная проверка в adapter.save
        const compat = await this.editorInternal.compatInfo().catch(() => null);
        const mismatch: string[] = [];
        if (compat?.object_id && compat.object_id !== p.objectId) mismatch.push(`object_id ${compat.object_id} ≠ ${p.objectId}`);
        if (compat?.plan_id && p.planId && compat.plan_id !== p.planId) mismatch.push(`plan_id ${compat.plan_id} ≠ ${p.planId}`);
        if (mismatch.length > 0) {
          const editor = this.editorInternal;
          this.editorInternal = null;
          await editor.close().catch(() => {});
          throw new McpError("EDITOR_PROJECT_MISMATCH", `редактор открыл не запрошенный проект: ${mismatch.join(", ")} — запись в чужой проект запрещена`, {
            details: { requested_object_id: p.objectId, requested_plan_id: p.planId, editor_object_id: compat?.object_id, editor_plan_id: compat?.plan_id },
          });
        }
      }
    }
    return this.editorInternal;
  }

  async close(): Promise<void> {
    if (this.editorInternal) {
      await this.editorInternal.close().catch(() => {});
      this.editorInternal = null;
    }
  }
}
