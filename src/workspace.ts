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
import { dist, closestPoint, pointInPolygon, segmentsCross, type Polygon as GeoPolygon } from "./model/geometry.ts";
import { PIPE_TYPE_BY_KIND, PIPE_MULTI_SPOTS, pipeLinkKey, PIPE_COLLECTIONS, CLIMATE_PIPE_KINDS } from "./model/pipes.ts";
import { warmFloorMismatches } from "./model/climate.ts";
import { renderPlanToFile, type RenderedPlan, type RenderRevision } from "./render.ts";
import { borderMismatches } from "./model/terraces.ts";
import { levelHoleMismatches } from "./model/floorhole.ts";
import { finishCompare } from "./model/finish.ts";
import { dimsMismatches } from "./model/dims.ts";
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

/** Сверка проёмов в полу локальной модели с редактором (нормализация/save).
 *  levelHoleMismatches (этап 67) сверяет идентичности в обе стороны, включая
 *  лишние проёмы на стороне редактора/сервера. */
function checkLevelHolesAfterNormalize(local: Model, norm: Model): string[] {
  const wsIds = new Set(Object.keys(local.level_holes ?? {}));
  const normIds = new Set(Object.keys(norm.level_holes ?? {}));
  const lost = missingIds(wsIds, normIds);
  const mismatches = levelHoleMismatches(structuredClone(local.level_holes ?? {}), norm.level_holes ?? {});
  return [
    ...lost.map((id) => `${id}: проём в полу потерян`),
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
  will_delete: { walls: number; openings: number; items: number; pillars: number; rigels: number; gas_lines: number; pipes: number; terrace_borders: number; territory_borders: number; level_holes: number; led_strips: number; stripes_light: number; line_strips: number; warm_floors: number; pipes_warm_floor: number; pipes_conditioner: number; pipes_heat: number; pipes_ventilation: number };
  /** Предупреждения (удаления объектов сервера). */
  warnings: string[];
};

export type HistorySnapshot = { label: string; at: string };

export const MAX_HISTORY = 50;

/** Результат мутации стен: полезное значение + предупреждения (офлайн-режим). */
export type WallMutation<T> = { result: T; warnings: string[] };

/** Счётчики объектов модели: стены, проёмы, предметы, колонны, ригели, газовые линии, трубы воды, границы террас/участка, проёмы пола, световые линии, тёплый пол и трубы климата (этап 122). */
export function modelCounts(model: Model | Record<string, unknown>): { walls: number; openings: number; items: number; pillars: number; rigels: number; gas_lines: number; pipes: number; terrace_borders: number; territory_borders: number; level_holes: number; led_strips: number; stripes_light: number; line_strips: number; warm_floors: number; pipes_warm_floor: number; pipes_conditioner: number; pipes_heat: number; pipes_ventilation: number } {
  const m = model as Model;
  const walls = m.walls ?? {};
  return {
    walls: Object.keys(walls).length,
    openings: Object.values(walls).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0),
    items: Object.keys(m.items ?? {}).length,
    pillars: Object.keys(m.pillars ?? {}).length,
    rigels: Object.keys(m.rigels ?? {}).length,
    gas_lines: Object.keys(m.pipes_gas ?? {}).length,
    pipes: Object.keys(m.pipes ?? {}).length,
    terrace_borders: Object.keys(m.terrace_borders ?? {}).length,
    territory_borders: Object.keys(m.territory_borders ?? {}).length,
    level_holes: Object.keys(m.level_holes ?? {}).length,
    led_strips: Object.keys(m.led_strips ?? {}).length,
    stripes_light: Object.keys(m.stripes_light ?? {}).length,
    line_strips: Object.keys(m.line_strips ?? {}).length,
    warm_floors: Object.keys(m.warm_floors ?? {}).length,
    pipes_warm_floor: Object.keys(m.pipes_warm_floor ?? {}).length,
    pipes_conditioner: Object.keys(m.pipes_conditioner ?? {}).length,
    pipes_heat: Object.keys(m.pipes_heat ?? {}).length,
    pipes_ventilation: Object.keys(m.pipes_ventilation ?? {}).length,
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
  if (nonEmpty(model.pipes)) return false;
  if (nonEmpty(model.terrace_borders) || nonEmpty(model.territory_borders) || nonEmpty(model.level_holes)) return false;
  if (nonEmpty(model.led_strips) || nonEmpty(model.stripes_light) || nonEmpty(model.line_strips)) return false;
  if (nonEmpty(model.warm_floors) || nonEmpty(model.pipes_warm_floor) || nonEmpty(model.pipes_conditioner) || nonEmpty(model.pipes_heat) || nonEmpty(model.pipes_ventilation)) return false;
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

/**
 * Убрать id_room вершин световых линий (этап 84): редактор сам пересчитывает
 * принадлежность узла комнате при draw/normalize (живая проба 84: узлы получили
 * id_room комнаты вместо "" из serialize LedStrip) — в сверке РАБОЧЕЙ копии с
 * нормализованной это производное поле; сверка после save идёт по нормализованному
 * ожиданию и остаётся строгой.
 */
function stripVertexIdRoom<T>(lines: T): T {
  for (const line of Object.values(lines as Record<string, { vertexes?: Array<Record<string, unknown>> }>)) {
    if (Array.isArray(line?.vertexes)) {
      for (const v of line.vertexes) delete v["id_room"];
    }
  }
  return lines;
}

/** Предмет с обратными ссылками связи «выключатель → светильник» (этап 88). */
type CableLinkItem = {
  name?: string;
  cables?: { cable_id?: unknown };
  socket_group?: Array<{ name?: string; id?: string; cables?: { cable_id?: unknown } }>;
};

/**
 * Сверка подключений связь↔предметы в обе стороны (этап 88, по образцу
 * pipeConnectionMismatches): у каждой вершины-выключателя под-розетка хранит
 * cables.cable_id (МАССИВ — socket_group multi), содержащий id связи; у каждой
 * вершины-светильника cables.cable_id (СКАЛЯР) указывает на связь; каждая обратная
 * ссылка обеих сторон — на существующую связь, чьи вершины содержат этот предмет
 * (ревью 90 R3 — держатель ссылки обязан быть вершиной этого кабеля).
 * Полная сверка обеих сторон: нет лишних, нет пропущенных, нет висячих.
 * Ревью 90 R2: вершина-цель разрешается по типу вершины — "lamp" ищется в items,
 * "led_strip"/"strip_light"/"line_strip" — в коллекциях световых линий (led_strips/
 * stripes_light/line_strips). У линии обратная ссылка (props.cables) не требуется —
 * живой формат не утверждён; наличие связи на линию само по себе не блокирует save.
 */
type CableLinkLines = {
  led_strips?: Record<string, unknown>;
  stripes_light?: Record<string, unknown>;
  line_strips?: Record<string, unknown>;
};

/** Коллекция световой линии по типу вершины связи (ревью 90 R2) — зеркало electric.ts. */
const CABLE_LINE_BY_VERTEX: Record<string, keyof CableLinkLines> = {
  led_strip: "led_strips",
  strip_light: "stripes_light",
  line_strip: "line_strips",
};

function cableConnectionMismatches(
  expectedCables: Record<string, GasLineSig>,
  expectedItems: Record<string, CableLinkItem>,
  gotCables: Record<string, GasLineSig>,
  gotItems: Record<string, CableLinkItem>,
  expectedLines: CableLinkLines = {},
  gotLines: CableLinkLines = {},
): string[] {
  const out: string[] = [];
  /** Слоты выключателя связи: [itemId, subId] по вершинам type "switch". */
  const switchSlots = (cable: GasLineSig): [string, string][] => {
    const res: [string, string][] = [];
    for (const v of cable.vertexes ?? []) {
      if (v.type !== "switch" || typeof v.id !== "string") continue;
      const idx = v.id.indexOf("|s|");
      if (idx > 0) res.push([v.id.slice(0, idx), v.id.slice(idx + 3)]);
    }
    return res;
  };
  /** id связи из обратной ссылки (скаляр или массив). */
  const cableIdsOf = (link: { cable_id?: unknown } | undefined): string[] => {
    const v = link?.cable_id;
    if (typeof v === "string" && v !== "") return [v];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    return [];
  };
  /** Держатель ссылки — вершина этой связи? (ревью 90 R3: лишняя ссылка — расхождение). */
  const holderIsVertex = (cable: GasLineSig | undefined, kind: "sub" | "item", itemId: string, subId: string): boolean => {
    if (!cable) return false;
    for (const v of cable.vertexes ?? []) {
      if (kind === "sub") {
        if (v.type === "switch" && v.id === `${itemId}|s|${subId}`) return true;
      } else if (v.type !== "node" && v.type !== "switch" && v.id === itemId) {
        return true;
      }
    }
    return false;
  };
  /** Ссылки ожидаемой стороны: id связи → множество «предмет(под-розетка)». */
  const collectRefs = (cables: Record<string, GasLineSig>, items: Record<string, CableLinkItem>, side: string): Map<string, Set<string>> => {
    const refs = new Map<string, Set<string>>();
    const addRef = (cableId: string, holder: string, kind: "sub" | "item", itemId: string, subId: string): boolean => {
      if (!cables[cableId]) {
        out.push(`${side}: висячая ссылка на связь ${cableId} (у ${holder}) — связи нет`);
        return false;
      }
      if (!holderIsVertex(cables[cableId], kind, itemId, subId)) {
        out.push(`${side}: ${cableId} — держатель ссылки ${holder} не является вершиной связи (лишняя ссылка)`);
        return false;
      }
      if (!refs.has(cableId)) refs.set(cableId, new Set());
      refs.get(cableId)!.add(holder);
      return true;
    };
    for (const [itemId, item] of Object.entries(items)) {
      for (const sub of item.socket_group ?? []) {
        const ids = cableIdsOf(sub.cables);
        if (ids.length > 0 && !(SWITCH_KEYS.has(sub.name ?? ""))) {
          out.push(`${side}: под-розетка «${sub.name ?? "?"}» (${itemId}/${sub.id ?? "?"}) хранит ссылки cables (${ids.join(", ")}) — cables пишут только выключатели`);
        }
        for (const id of ids) addRef(id, `под-розетка ${itemId}/${sub.id ?? "?"}`, "sub", itemId, sub.id ?? "");
      }
      for (const id of cableIdsOf(item.cables)) addRef(id, `предмет ${itemId}`, "item", itemId, "");
    }
    return refs;
  };
  const expRefs = collectRefs(expectedCables, expectedItems, "ожидание");
  const gotRefs = collectRefs(gotCables, gotItems, "сервер");
  for (const [cableId, holders] of expRefs) {
    for (const holder of holders) {
      if (!gotRefs.get(cableId)?.has(holder)) {
        out.push(`${cableId}: обратная ссылка потеряна на сервере (${holder})`);
      }
    }
  }
  for (const [cableId, holders] of gotRefs) {
    for (const holder of holders) {
      if (!expRefs.get(cableId)?.has(holder)) {
        out.push(`${cableId}: лишняя обратная ссылка на сервере (${holder})`);
      }
    }
  }
  // прямая сторона: каждая вершина-предмет связи имеет обратную ссылку
  // (вершины-линии — только существование в своей коллекции: ревью 90 R2)
  for (const side of [
    ["ожидание", expectedCables, expectedItems, expectedLines],
    ["сервер", gotCables, gotItems, gotLines],
  ] as const) {
    const [label, cables, items, lines] = side;
    for (const [cableId, cable] of Object.entries(cables)) {
      for (const [slotGid, slotSid] of switchSlots(cable)) {
        const item = items[slotGid];
        const sub = item?.socket_group?.find((s) => s.id === slotSid);
        if (!sub) {
          out.push(`${label}: ${cableId} — под-розетка ${slotSid} группы ${slotGid} не найдена`);
          continue;
        }
        const ids = cableIdsOf(sub.cables);
        if (!ids.includes(cableId)) out.push(`${label}: ${cableId} — под-розетка ${slotGid}/${slotSid} не ссылается на связь`);
      }
      for (const v of cable.vertexes ?? []) {
        if (v.type === "node" || v.type === "switch") continue;
        const collKey = CABLE_LINE_BY_VERTEX[String(v.type)];
        if (collKey) {
          const line = (lines[collKey] ?? {})[String(v.id)];
          if (!line) out.push(`${label}: ${cableId} — линия ${String(v.id)} (type ${String(v.type)}) не найдена в ${collKey}`);
          continue;
        }
        const item = items[String(v.id)];
        if (!item) { out.push(`${label}: ${cableId} — предмет ${String(v.id)} не найден`); continue; }
        const ids = cableIdsOf(item.cables);
        if (!ids.includes(cableId)) out.push(`${label}: ${cableId} — светильник ${String(v.id)} не ссылается на связь`);
      }
    }
  }
  return out;
}

/**
 * Формы обратных ссылок после сохранения (ревью 90 R6): у под-розетки cable_id —
 * МАССИВ, у светильника — СКАЛЯР; сверяется форма ответа сервера с формой
 * нормализованного ожидания — подмена массива скаляром (и наоборот) не «verified».
 * Legacy-модели не блокируются: на чтении принимаются обе формы, сравнение — с
 * ожидаемой стороной.
 */
function cableLinkFormMismatches(
  expectedItems: Record<string, CableLinkItem>,
  gotItems: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const formOf = (v: unknown): "array" | "scalar" | "none" => {
    if (Array.isArray(v)) return "array";
    if (typeof v === "string" && v !== "") return "scalar";
    return "none";
  };
  for (const [itemId, item] of Object.entries(expectedItems)) {
    const got = gotItems[itemId] as CableLinkItem | undefined;
    if (!got) continue;
    for (const sub of item.socket_group ?? []) {
      const gSub = got.socket_group?.find((s) => s.id === sub.id);
      if (!gSub) continue;
      const ef = formOf(sub.cables?.cable_id);
      const gf = formOf(gSub.cables?.cable_id);
      if (ef !== "none" && gf !== "none" && ef !== gf) {
        out.push(`${itemId}/${sub.id ?? "?"}: форма ссылки изменилась (ожидание ${ef}, сервер ${gf})`);
      }
    }
    const ef = formOf(item.cables?.cable_id);
    const gf = formOf(got.cables?.cable_id);
    if (ef !== "none" && gf !== "none" && ef !== gf) {
      out.push(`${itemId}: форма ссылки изменилась (ожидание ${ef}, сервер ${gf})`);
    }
  }
  return out;
}

/**
 * Состав и пользовательские свойства под-розеток socket_group (ревью 90 R1,
 * 92 R1a/R1b): число под-розеток, id, тип (name) и высота установки группы
 * (over_floor.value, см). Производная геометрия (center, real_center, vd,
 * id_wall) до save НЕ сверяется: редактор легитимно пересчитывает её при
 * нормализации (магнит к стене, перенос/удаление стены). Если ожидается
 * числовой over_floor.value — его наличие и равенство обязательны (R1b);
 * совпадающее отсутствие необязательного поля на обеих сторонах — не расхождение.
 */
type SubsItemSig = {
  socket_group?: Array<{ name?: string; id?: string }>;
  over_floor?: unknown;
};

export function socketGroupSubsUserMismatches(
  expected: Record<string, SubsItemSig>,
  got: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const overFloorValueOf = (it: SubsItemSig | undefined): number | undefined => {
    const of = it?.over_floor;
    return of && typeof of === "object" && typeof (of as { value?: unknown }).value === "number"
      ? (of as { value: number }).value
      : undefined;
  };
  for (const [itemId, it] of Object.entries(expected)) {
    const subs = it.socket_group;
    if (!Array.isArray(subs)) continue;
    const g = got[itemId] as SubsItemSig | undefined;
    const gSubs = g?.socket_group;
    if (!Array.isArray(gSubs)) {
      out.push(`${itemId}: группа socket_group (${subs.length} под-розеток) потеряна после сохранения`);
      continue;
    }
    if (gSubs.length !== subs.length) {
      out.push(`${itemId}: число под-розеток изменилось (ожидалось ${subs.length}, на сервере ${gSubs.length})`);
      continue;
    }
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i]!;
      const gs = gSubs[i]!;
      const label = `${itemId}/${s.id ?? i}`;
      if ((s.id ?? "") !== (gs.id ?? "")) out.push(`${label}: id под-розетки изменился (на сервере «${gs.id ?? ""}»)`);
      if ((s.name ?? "") !== (gs.name ?? "")) out.push(`${label}: тип изменился (на сервере «${gs.name ?? ""}»; ожидалось «${s.name ?? ""}»)`);
    }
    const h = overFloorValueOf(it);
    if (h !== undefined) {
      const gh = overFloorValueOf(g);
      if (gh === undefined) out.push(`${itemId}: высота установки (over_floor.value) потеряна после сохранения`);
      else if (Math.abs(h - gh) > 0.1) out.push(`${itemId}: высота установки изменилась (на сервере ${gh}; ожидалось ${h})`);
    }
  }
  return out;
}

/**
 * Производная геометрия под-розеток после save (ревью 92 R1a/R1b): center,
 * real_center и over_floor.vd сверяются только против нормализованного ожидания
 * (того, что ушло на save) с допуском 0,1 см; совпадающее отсутствие
 * необязательного поля на обеих сторонах — не расхождение.
 */
export function socketGroupSubsDerivedMismatches(
  expected: Record<string, SubsItemSig>,
  got: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= 0.1;
  const ptEq = (e: { x?: number; y?: number } | undefined, g: { x?: number; y?: number } | undefined): boolean =>
    // совпадающее отсутствие необязательного поля — не расхождение (92 R1a)
    (e === undefined && g === undefined) || (near(e?.x, g?.x) && near(e?.y, g?.y));
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const overFloorOf = (it: SubsItemSig | undefined): { value?: unknown; vd?: unknown } | undefined =>
    it?.over_floor && typeof it.over_floor === "object" ? (it.over_floor as { value?: unknown; vd?: unknown }) : undefined;
  for (const [itemId, it] of Object.entries(expected)) {
    const subs = it.socket_group;
    if (!Array.isArray(subs)) continue;
    const g = got[itemId] as SubsItemSig | undefined;
    const gSubs = g?.socket_group;
    if (!Array.isArray(gSubs)) continue; // состав ловит user-проверка
    for (let i = 0; i < Math.min(subs.length, gSubs.length); i++) {
      const s = subs[i]! as { id?: string; center?: { x?: number; y?: number }; real_center?: { x?: number; y?: number } };
      const gs = gSubs[i]! as { center?: { x?: number; y?: number }; real_center?: { x?: number; y?: number } };
      const label = `${itemId}/${s.id ?? i}`;
      if (!ptEq(s.center, gs.center)) out.push(`${label}: center сместился (на сервере ${gs.center?.x},${gs.center?.y}; ожидалось ${s.center?.x},${s.center?.y})`);
      if (!ptEq(s.real_center, gs.real_center)) out.push(`${label}: real_center сместился (на сервере ${gs.real_center?.x},${gs.real_center?.y}; ожидалось ${s.real_center?.x},${s.real_center?.y})`);
    }
    const vdE = num(overFloorOf(it)?.vd);
    const vdG = num(overFloorOf(g)?.vd);
    if (vdE !== undefined && vdG !== undefined && Math.abs(vdE - vdG) > 0.1) {
      out.push(`${itemId}: производная высота (over_floor.vd) изменилась (на сервере ${vdG}; ожидалось ${vdE})`);
    }
  }
  return out;
}

/** Имена выключателей (под-розетки, хранящие cables) — для проверки формы ссылок. */
const SWITCH_KEYS = new Set([
  "light_switch", "light_switch_double", "light_switch_triple",
  "light_switch_through", "light_switch_through_double",
  "light_switch_cross", "light_switch_cross_double", "light_dimmer",
]);

/** id проёмов модели: id holes по всем стенам (ревью v0.1.1 №4/№5 — сравнение по id). */function openingIds(model: Model): Set<string> {
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

/** Значимая геометрия колонны для сверки после сохранения (ревью 43 №2);
 *  ревью 66 №3: role тоже значима — террасный столб, ставший обычной колонной,
 *  не проходит как «verified». */
type PillarSig = { pc?: { x: number; y: number }; width?: number; height?: number; angle?: number; role?: string };

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
    if ((g.role ?? "") !== (p.role ?? "")) out.push(`${id}: role изменилась (на сервере «${g.role ?? ""}»; ожидалось «${p.role ?? ""}»)`);
  }
  return out;
}

/**
 * Роли стен после нормализации/save (ревью 66 №3): ограждение террасы, ставшее
 * обычной стеной, геометрию не меняет — сверяется role у стен с совпадающей
 * геометрией. Стена с тем же id — role обязана совпасть; у стены с новым id
 * (переименование нормализацией) role сравнивается с геометрически совпадающей
 * ожидаемой стеной.
 */
function wallRoleMismatches(
  expected: Record<string, { role?: string; p1: Point; p2: Point }>,
  got: Record<string, { role?: string; p1: Point; p2: Point }>,
): string[] {
  const out: string[] = [];
  const segOf = (w: { p1: Point; p2: Point }): WallAxisSegment[] => wallAxisSegments({ w });
  const covers = (a: { p1: Point; p2: Point }, b: { p1: Point; p2: Point }): boolean => {
    const segsA = segOf(a);
    const segsB = segOf(b);
    return segsA.length > 0 && segsA.every((s) =>
      segsB.some((t) =>
        Math.abs(t.ux - s.ux) <= 1e-6 && Math.abs(t.uy - s.uy) <= 1e-6 &&
        Math.abs(t.offset - s.offset) <= 0.1 && t.a <= s.a + 0.1 && t.b >= s.b - 0.1,
      ),
    );
  };
  for (const [id, g] of Object.entries(got)) {
    const e = expected[id];
    if (e) {
      if ((g.role ?? "") !== (e.role ?? "")) {
        out.push(`${id}: role изменилась (на сервере «${g.role ?? ""}»; ожидалось «${e.role ?? ""}»)`);
      }
      continue;
    }
    // переименование: ищем ожидаемую стену с той же геометрией оси
    const renamed = Object.entries(expected).find(([, e]) => (e.role ?? "") !== (g.role ?? "") && (covers(g, e) || covers(e, g)));
    if (renamed) {
      out.push(`${id}: role изменилась (на сервере «${g.role ?? ""}»; ожидалось «${renamed[1].role ?? ""}» у ${renamed[0]})`);
    }
  }
  return out;
}

/**
 * Значимые свойства балконного ограждения для сверки (ревью 73 №2, 75 №2): ось нужна
 * для геометрического сопоставления, остальные поля сверяются у каждой части.
 */
type BalconyWallProps = { role?: string; p1: Point; p2: Point; height?: number; depth?: number; material?: string };

/**
 * Свойства балконных ограждений после нормализации/save (ревью 73 №2, переоткрыто
 * ревью 75 №2): сверка не по совпадению id, а по геометрическому покрытию оси —
 * каждая ожидаемая ограда сопоставляется с частями на другой стороне, коллинеарными
 * и перекрывающими её ось (rename, split, merge), и height/depth/material сверяются
 * у каждой части. Частично испорченная новая часть после split и переименованная
 * ограда с изменённым height не проходят молча. Округление редактора (до сотых см)
 * не расхождение (допуск 0,1 см). Ограда, не покрытая ни одной оградой другой
 * стороны, — расхождение. Возвращает человекочитаемые расхождения; пустой список —
 * совпало.
 */
function balconyWallPropertyMismatches(
  expected: Record<string, BalconyWallProps>,
  got: Record<string, BalconyWallProps>,
): string[] {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= 0.1;
  const segsOf = (w: { p1: Point; p2: Point }): WallAxisSegment[] => wallAxisSegments({ w });
  /** Коллинеарное перекрытие осевых отрезков (направление может быть отражено). */
  const overlaps = (s: WallAxisSegment, t: WallAxisSegment): boolean => {
    const same = Math.abs(s.ux - t.ux) <= 1e-6 && Math.abs(s.uy - t.uy) <= 1e-6;
    const opp = Math.abs(s.ux + t.ux) <= 1e-6 && Math.abs(s.uy + t.uy) <= 1e-6;
    if (!same && !opp) return false;
    const ta = same ? t.a : -t.b;
    const tb = same ? t.b : -t.a;
    const toff = same ? t.offset : -t.offset;
    if (Math.abs(s.offset - toff) > 0.1) return false;
    return Math.min(s.b, tb) - Math.max(s.a, ta) > 0.1;
  };
  const gotSegs = new Map<string, WallAxisSegment[]>();
  for (const [gid, g] of Object.entries(got)) {
    if (g.role !== "balcony") continue;
    const segs = segsOf(g);
    if (segs.length > 0) gotSegs.set(gid, segs);
  }
  for (const [id, e] of Object.entries(expected)) {
    if (e.role !== "balcony") continue;
    const eSegs = segsOf(e);
    if (eSegs.length === 0) continue;
    const parts = [...gotSegs.keys()].filter((gid) =>
      gotSegs.get(gid)!.some((t) => eSegs.some((s) => overlaps(s, t))),
    );
    if (parts.length === 0) {
      out.push(`${id}: ограждение не найдено на сервере (ось не покрыта ни одной оградой)`);
      continue;
    }
    for (const gid of parts) {
      const g = got[gid]!;
      const where = gid === id ? id : `${id} → ${gid}`;
      if (!near(g.height, e.height)) {
        out.push(`${where}: height изменилась (на сервере ${g.height}; ожидалось ${e.height})`);
      }
      if (!near(g.depth, e.depth)) {
        out.push(`${where}: depth изменилась (на сервере ${g.depth}; ожидалось ${e.depth})`);
      }
      if ((g.material ?? "") !== (e.material ?? "")) {
        out.push(`${where}: material изменился (на сервере «${g.material ?? ""}»; ожидалось «${e.material ?? ""}»)`);
      }
    }
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
function gasLineGraphMismatches(
  expected: Record<string, GasLineSig>,
  got: Record<string, unknown>,
  entityLabel = "газовая линия",
  lenientItemVertices = false,
  itemGeom?: Record<string, { pc?: Point; width?: number; height?: number; angle?: number }>,
): string[] {
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

/** Предмет с обратными ссылками на трубы (props.pipes). */
type PipeLinkItem = { name?: string; pipes?: Record<string, unknown> };

/**
 * Типы всех трубных линий модели: водоснабжение (model.pipes) и климат
 * (pipes_warm_floor/pipes_conditioner/pipes_heat/pipes_ventilation, ревью 124 R2).
 */
const ALL_PIPE_TYPES = [...Object.values(PIPE_TYPE_BY_KIND), ...Object.values(CLIMATE_PIPE_KINDS).map((c) => c.type)];
/** Виды труб водоснабжения: только для них действуют scalar/multi правила воды. */
const WATER_PIPE_KEYS = new Set(Object.values(PIPE_TYPE_BY_KIND).map(pipeLinkKey));

/**
 * Сверка подключений труба↔предмет в обе стороны (ревью 79 №5, ревью 81 5-R):
 * у каждой вершины-предмета трубы props.pipes[`${type}_id`] должен указывать на неё,
 * и каждая обратная ссылка предмета — на существующую трубу того же вида, чьи
 * вершины содержат этот предмет. Фактические ссылки сервера (gotItems) сверяются
 * с ожидаемыми (expectedItems) ПОЛНОСТЬЮ: нет лишних, нет пропущенных, вид трубы
 * совпадает с ключом, scalar у обычных выводов / массив у multi (ревью 81 5-R —
 * раньше второе направление смотрело expectedItems и пропускало лишние и висячие
 * ссылки). Ревью 124 R2: общий слой распространён на трубы климата (CLIMATE_PIPE_KINDS)
 * через реестр ALL_PIPE_TYPES — обе стороны, normalize и после save; scalar/multi
 * правила воды (PIPE_MULTI_SPOTS) на климатические связи НЕ переносятся. Общий слой
 * газовой/водяной сверки не трогает (у газа обратных ссылок нет). opts.onlyKeys
 * ограничивает сверку подмножеством видов (например, только климат).
 */
function pipeConnectionMismatches(
  expectedPipes: Record<string, GasLineSig>,
  expectedItems: Record<string, PipeLinkItem>,
  gotPipes: Record<string, GasLineSig>,
  gotItems: Record<string, PipeLinkItem>,
  opts: { onlyKeys?: Set<string> } = {},
): string[] {
  const out: string[] = [];
  const pipeKeys = new Set(ALL_PIPE_TYPES.map(pipeLinkKey));
  /** Активные виды ссылки: весь реестр или подмножество (климат). */
  const activeKeys = opts.onlyKeys ?? pipeKeys;
  /** Вид трубы по ключу ссылки (water_pipe_id → water_pipe); null — ключ не труба. */
  const pipeTypeOfKey = (key: string): string | null => {
    for (const type of ALL_PIPE_TYPES) {
      if (key === pipeLinkKey(type)) return type;
    }
    return null;
  };
  /** Ссылки предмета на трубы: ключ → множество id (только активные ключи труб, только строки). */
  const linksOf = (item: PipeLinkItem | undefined): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const [key, ref] of Object.entries(item?.pipes ?? {})) {
      if (!activeKeys.has(key)) continue;
      const ids = (Array.isArray(ref) ? ref : [ref]).filter((x): x is string => typeof x === "string" && x !== "");
      out.set(key, new Set(ids));
    }
    return out;
  };
  // направление 1: труба → props.pipes предмета (ревью 79 №5a)
  for (const [id, p] of Object.entries(expectedPipes)) {
    const key = pipeLinkKey(p.type ?? "");
    if (!activeKeys.has(key)) continue;
    for (const v of p.vertexes ?? []) {
      const vid = v.id;
      if ((v.type ?? "node") === "node" || typeof vid !== "string") continue;
      const item = gotItems[vid];
      if (!item) {
        out.push(`${id}: предмет ${vid} исчез после сохранения`);
        continue;
      }
      const cur = item.pipes?.[key];
      const ok = cur === id || (Array.isArray(cur) && cur.includes(id));
      if (!ok) {
        out.push(`${id}: предмет ${vid} потерял обратную ссылку ${key} (на сервере ${JSON.stringify(cur ?? null)}; ожидалось «${id}»)`);
      }
    }
  }
  // направление 2 (ревью 81 5-R): ВСЕ фактические ссылки gotItems — валидность
  // против gotPipes (существование, вид, членство) и полнота против expectedItems
  for (const [itemId, item] of Object.entries(gotItems)) {
    const gotLinks = linksOf(item);
    const expLinks = linksOf(expectedItems[itemId]);
    const keys = new Set([...gotLinks.keys(), ...expLinks.keys()]);
    for (const key of keys) {
      const gotIds = gotLinks.get(key) ?? new Set();
      const expIds = expLinks.get(key) ?? new Set();
      for (const pid of gotIds) {
        if (!expIds.has(pid)) {
          out.push(`${itemId}: лишняя обратная ссылка ${key} → ${pid} (в рабочей копии этой ссылки нет)`);
          continue;
        }
        const gp = gotPipes[pid];
        if (!gp) {
          out.push(`${itemId}: обратная ссылка ${key} указывает на отсутствующую трубу ${pid}`);
          continue;
        }
        const wantType = pipeTypeOfKey(key);
        if (wantType !== null && (gp.type ?? "") !== wantType) {
          out.push(`${itemId}: обратная ссылка ${key} указывает на трубу ${pid} другого вида (на сервере «${gp.type ?? ""}»; по ключу — «${wantType}»)`);
        }
        if (!(gp.vertexes ?? []).some((v) => v.id === itemId)) {
          out.push(`${itemId}: труба ${pid} на сервере не содержит предмет в вершинах (ссылка ${key})`);
        }
      }
      for (const pid of expIds) {
        if (!gotIds.has(pid)) out.push(`${itemId}: обратная ссылка ${key} → ${pid} потеряна на сервере`);
      }
    }
  }
  // направление 3: вид ссылки — scalar у обычного вывода, массив у multi
  // (ревью 81 5-R: допустимость scalar/array; ревью 124 R2: правила воды — только
  // для водных ключей, климатические ссылки scalar/multi-контрактом воды не сверяются)
  for (const [itemId, item] of Object.entries(gotItems)) {
    const name = (item as { name?: string }).name;
    for (const [key, ref] of Object.entries(item.pipes ?? {})) {
      if (!WATER_PIPE_KEYS.has(key) || ref === undefined || ref === null || ref === "") continue;
      const isMulti = typeof name === "string" && PIPE_MULTI_SPOTS.has(name);
      if (isMulti && !Array.isArray(ref)) {
        out.push(`${itemId}: у multi-предмета «${name}» ссылка ${key} должна быть массивом труб (на сервере скаляр)`);
      }
      if (!isMulti && Array.isArray(ref)) {
        out.push(`${itemId}: у обычного вывода «${name ?? "?"}» ссылка ${key} должна быть скаляром (на сервере массив)`);
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

/**
 * Сверка сущностей климата (этап 122): контуры тёплого пола (model.warm_floors —
 * семантика контура: polygon, кольцо, узлы, площадь) и трубы климата
 * (pipes_warm_floor/pipes_conditioner/pipes_heat/pipes_ventilation — общий слой
 * газовых графов). Возвращает список человекочитаемых расхождений. Аргументы —
 * модели или их фрагменты (ожидание после save — фрагмент нормализованной модели).
 * Ревью 124 R1: mode normalize — привязка контуров к комнатам по геометрии
 * (ID комнат штатно регенерируется); save — строго. Ревью 124 R2: обратные ссылки
 * предметов на трубы климата сверяются в обе стороны (общий слой
 * pipeConnectionMismatches, только ключи климата — правила воды не переносятся).
 */
function climateGraphMismatches(
  local: Model,
  norm: Record<string, unknown>,
  opts: {
    mode?: "normalize" | "save";
    roomsExpected?: Record<string, unknown>;
    roomsGot?: Record<string, unknown>;
    itemsExpected?: Record<string, PipeLinkItem>;
    itemsGot?: Record<string, PipeLinkItem>;
  } = {},
): string[] {
  const out: string[] = [];
  const wfLost = missingIds(new Set(Object.keys(local.warm_floors ?? {})), new Set(Object.keys((norm as { warm_floors?: Record<string, unknown> }).warm_floors ?? {})));
  const wfMism = warmFloorMismatches(
    structuredClone(local.warm_floors ?? {}) as Record<string, import("./model/types.ts").WarmFloor>,
    (norm as { warm_floors?: Record<string, unknown> }).warm_floors ?? {},
    { mode: opts.mode ?? "save", roomsExpected: opts.roomsExpected, roomsGot: opts.roomsGot },
  );
  if (wfLost.length > 0 || wfMism.length > 0) {
    out.push(`контуры тёплого пола: потеряны ${JSON.stringify(wfLost)}; расхождения ${JSON.stringify(wfMism)}`);
  }
  const climateColls = ["pipes_warm_floor", "pipes_conditioner", "pipes_heat", "pipes_ventilation"] as const;
  for (const coll of climateColls) {
    const ws = structuredClone((local as Record<string, unknown>)[coll] ?? {}) as Record<string, GasLineSig>;
    const normColl = ((norm as Record<string, unknown>)[coll] ?? {}) as Record<string, unknown>;
    const lost = missingIds(new Set(Object.keys(ws)), new Set(Object.keys(normColl)));
    const graphNorm = gasLineGraphMismatches(structuredClone(ws), normColl, "труба климата");
    if (lost.length > 0 || graphNorm.length > 0) {
      out.push(`${coll}: потеряны ${JSON.stringify(lost)}; расхождения ${JSON.stringify(graphNorm)}`);
    }
  }
  if (opts.itemsExpected && opts.itemsGot) {
    const mergeColls = (src: Record<string, unknown>): Record<string, GasLineSig> => {
      const merged: Record<string, GasLineSig> = {};
      for (const coll of climateColls) Object.assign(merged, (src[coll] ?? {}) as Record<string, GasLineSig>);
      return merged;
    };
    const onlyKeys = new Set(Object.values(CLIMATE_PIPE_KINDS).map((c) => pipeLinkKey(c.type)));
    const conn = pipeConnectionMismatches(
      mergeColls(local as unknown as Record<string, unknown>),
      opts.itemsExpected,
      mergeColls(norm),
      opts.itemsGot,
      { onlyKeys },
    );
    if (conn.length > 0) out.push(`подключения труб климата: ${JSON.stringify(conn)}`);
  }
  return out;
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
      // этап 78: трубы водоснабжения после нормализации не теряются (сверка семантики
      // графа; точки вершин-предметов — мягко: редактор пересчитывает подключение)
      const wsPipeIds = new Set(Object.keys(this.modelInternal!.pipes ?? {}));
      const normPipes = (norm.model as { pipes?: Record<string, unknown> }).pipes ?? {};
      const normPipeIds = new Set(Object.keys(normPipes));
      const lostPipesNorm = missingIds(wsPipeIds, normPipeIds);
      const pipesGraphNorm = gasLineGraphMismatches(
        structuredClone(this.modelInternal!.pipes ?? {}) as Record<string, GasLineSig>,
        normPipes,
        "труба",
        true,
        structuredClone(this.modelInternal!.items ?? {}) as Record<string, { pc?: Point; width?: number; height?: number; angle?: number }>,
      );
      // ревью 79 №5: подключения труба↔предмет сверяются в обе стороны и при нормализации
      // (только водные ключи — климат сверяет climateGraphMismatches, ревью 124 R2)
      const pipeConnNorm = pipeConnectionMismatches(
        structuredClone(this.modelInternal!.pipes ?? {}) as Record<string, GasLineSig>,
        this.modelInternal!.items as Record<string, PipeLinkItem>,
        normPipes as Record<string, GasLineSig>,
        (norm.model as { items?: Record<string, PipeLinkItem> }).items ?? {},
        { onlyKeys: WATER_PIPE_KEYS },
      );
      if (lostPipesNorm.length > 0 || pipesGraphNorm.length > 0 || pipeConnNorm.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил трубы водоснабжения — мутация отменена`, {
          details: { lost_pipes: lostPipesNorm, pipe_mismatches: pipesGraphNorm, pipe_connection_mismatches: pipeConnNorm },
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
      // этап 84: световые линии листа «Освещение» после нормализации не теряются и
      // не искажаются (семантическая сверка графа — общий слой газовых графов)
      const lightCollections: [keyof Model, string, string][] = [
        ["led_strips", "led_strips", "светодиодная лента"],
        ["stripes_light", "stripes_light", "трековая шина"],
        ["line_strips", "line_strips", "линейный свет"],
      ];
      for (const [key, _coll, label] of lightCollections) {
        const wsLines = stripVertexIdRoom(structuredClone((this.modelInternal![key] ?? {}) as Record<string, GasLineSig>)) as Record<string, GasLineSig>;
        const normLines = ((norm.model as Record<string, unknown>)[key as string] ?? {}) as Record<string, unknown>;
        const lostLines = missingIds(new Set(Object.keys(wsLines)), new Set(Object.keys(normLines)));
        const graphNorm = gasLineGraphMismatches(structuredClone(wsLines), normLines, label);
        if (lostLines.length > 0 || graphNorm.length > 0) {
          throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил световые линии (${label}) — мутация отменена`, {
            details: { [`lost_${key}`]: lostLines, [`${key}_mismatches`]: graphNorm },
          });
        }
      }
      // этап 88: связи «выключатель → светильник» после нормализации не теряются
      // и не искажаются (граф + обе стороны обратных ссылок)
      const wsCables = stripVertexIdRoom(structuredClone((this.modelInternal!.cables ?? {}) as Record<string, GasLineSig>)) as Record<string, GasLineSig>;
      const normCables = ((norm.model as Record<string, unknown>).cables ?? {}) as Record<string, unknown>;
      const lostCablesNorm = missingIds(new Set(Object.keys(wsCables)), new Set(Object.keys(normCables)));
      const cablesGraphNorm = gasLineGraphMismatches(structuredClone(wsCables), normCables, "связь выключатель → светильник");
      const wsLinesNorm: CableLinkLines = {
        led_strips: (this.modelInternal!.led_strips ?? {}) as Record<string, unknown>,
        stripes_light: (this.modelInternal!.stripes_light ?? {}) as Record<string, unknown>,
        line_strips: (this.modelInternal!.line_strips ?? {}) as Record<string, unknown>,
      };
      const normLinesNorm: CableLinkLines = {
        led_strips: ((norm.model as Record<string, unknown>).led_strips ?? {}) as Record<string, unknown>,
        stripes_light: ((norm.model as Record<string, unknown>).stripes_light ?? {}) as Record<string, unknown>,
        line_strips: ((norm.model as Record<string, unknown>).line_strips ?? {}) as Record<string, unknown>,
      };
      const cablesConnNorm = cableConnectionMismatches(
        (this.modelInternal!.cables ?? {}) as Record<string, GasLineSig>,
        (this.modelInternal!.items ?? {}) as Record<string, CableLinkItem>,
        normCables as Record<string, GasLineSig>,
        (norm.model as { items?: Record<string, CableLinkItem> }).items ?? {},
        wsLinesNorm,
        normLinesNorm,
      );
      // ревью 90 R1, 92 R1a: состав и пользовательские свойства под-розеток
      // сверяются при нормализации независимо от связей; производная геометрия
      // (center/real_center/vd) не сверяется — редактор легитимно пересчитывает её
      const subsNorm = socketGroupSubsUserMismatches(
        this.modelInternal!.items as Record<string, SubsItemSig>,
        (norm.model as { items?: Record<string, unknown> }).items ?? {},
      );
      // этап 94, ревью 95/98: отделка (пол/потолок/стены по комнатам) после нормализации
      // не теряется; сопоставление комнат по геометрии (id комнат редактор может
      // пересоздать), проёмы стен — для объяснимых разрывов отделки сторон.
      // Режим normalize: топологические правила — по эталонам редактора 98
      // (split — все части наследуют пол/потолок; merge — покрытие одного из источников);
      // отделка сторон при merge не сверяется — предупреждение finish_topology_changed.
      const finishNorm = finishCompare(
        (this.modelInternal!["rooms2"] ?? this.modelInternal!["rooms1"]) as Record<string, unknown> | undefined,
        ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
        this.modelInternal!["walls"] as Record<string, unknown> | undefined,
        (norm.model as Record<string, unknown>)["walls"] as Record<string, unknown> | undefined,
        "normalize",
      );
      // этап 122: контуры тёплого пола и трубы климата после нормализации не теряются
      // (общий слой графов — семантическая сверка; у контуров — polygon/кольцо/площадь;
      // ревью 124 R1/R2: привязка к комнатам по геометрии, обратные ссылки на трубы климата)
      const climateNorm = climateGraphMismatches(this.modelInternal!, norm.model as Record<string, unknown>, {
        mode: "normalize",
        roomsExpected: (this.modelInternal!["rooms2"] ?? this.modelInternal!["rooms1"]) as Record<string, unknown> | undefined,
        roomsGot: ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
        itemsExpected: this.modelInternal!.items as unknown as Record<string, PipeLinkItem>,
        itemsGot: (norm.model as { items?: Record<string, PipeLinkItem> }).items ?? {},
      });
      warnings.push(...finishNorm.warnings);
      // этап 113: размеры и комментарии после нормализации не теряются и не искажаются
      const dimsNorm = dimsMismatches(this.modelInternal!, norm.model as Record<string, unknown>);
      if (lostCablesNorm.length > 0 || cablesGraphNorm.length > 0 || cablesConnNorm.length > 0 || subsNorm.length > 0 || finishNorm.problems.length > 0 || dimsNorm.length > 0 || climateNorm.length > 0) {
        throw new McpError("INVALID_GEOMETRY", `после нормализации редактор потерял или изменил связи «выключатель → светильник», под-розетки, отделку, размеры/комментарии или сущности климата — мутация отменена`, {
          details: { lost_cables: lostCablesNorm, cables_mismatches: cablesGraphNorm, cables_connection_mismatches: cablesConnNorm, socket_group_mismatches: subsNorm, finish_mismatches: finishNorm.problems, dims_mismatches: dimsNorm, climate_mismatches: climateNorm },
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
      pipes: missingIds(new Set(Object.keys(serverModel.pipes ?? {})), new Set(Object.keys(this.modelInternal!.pipes ?? {}))),
      terrace_borders: missingIds(new Set(Object.keys(serverModel.terrace_borders ?? {})), new Set(Object.keys(this.modelInternal!.terrace_borders ?? {}))),
      territory_borders: missingIds(new Set(Object.keys(serverModel.territory_borders ?? {})), new Set(Object.keys(this.modelInternal!.territory_borders ?? {}))),
      level_holes: missingIds(new Set(Object.keys(serverModel.level_holes ?? {})), new Set(Object.keys(this.modelInternal!.level_holes ?? {}))),
      led_strips: missingIds(new Set(Object.keys(serverModel.led_strips ?? {})), new Set(Object.keys(this.modelInternal!.led_strips ?? {}))),
      stripes_light: missingIds(new Set(Object.keys(serverModel.stripes_light ?? {})), new Set(Object.keys(this.modelInternal!.stripes_light ?? {}))),
      line_strips: missingIds(new Set(Object.keys(serverModel.line_strips ?? {})), new Set(Object.keys(this.modelInternal!.line_strips ?? {}))),
      warm_floors: missingIds(new Set(Object.keys(serverModel.warm_floors ?? {})), new Set(Object.keys(this.modelInternal!.warm_floors ?? {}))),
      pipes_warm_floor: missingIds(new Set(Object.keys(serverModel.pipes_warm_floor ?? {})), new Set(Object.keys(this.modelInternal!.pipes_warm_floor ?? {}))),
      pipes_conditioner: missingIds(new Set(Object.keys(serverModel.pipes_conditioner ?? {})), new Set(Object.keys(this.modelInternal!.pipes_conditioner ?? {}))),
      pipes_heat: missingIds(new Set(Object.keys(serverModel.pipes_heat ?? {})), new Set(Object.keys(this.modelInternal!.pipes_heat ?? {}))),
      pipes_ventilation: missingIds(new Set(Object.keys(serverModel.pipes_ventilation ?? {})), new Set(Object.keys(this.modelInternal!.pipes_ventilation ?? {}))),
    };
    const willDelete = {
      walls: deletedIds.walls.length,
      openings: deletedIds.openings.length,
      items: deletedIds.items.length,
      pillars: deletedIds.pillars.length,
      rigels: deletedIds.rigels.length,
      gas_lines: deletedIds.gas_lines.length,
      pipes: deletedIds.pipes.length,
      terrace_borders: deletedIds.terrace_borders.length,
      territory_borders: deletedIds.territory_borders.length,
      level_holes: deletedIds.level_holes.length,
      led_strips: deletedIds.led_strips.length,
      stripes_light: deletedIds.stripes_light.length,
      line_strips: deletedIds.line_strips.length,
      warm_floors: deletedIds.warm_floors.length,
      pipes_warm_floor: deletedIds.pipes_warm_floor.length,
      pipes_conditioner: deletedIds.pipes_conditioner.length,
      pipes_heat: deletedIds.pipes_heat.length,
      pipes_ventilation: deletedIds.pipes_ventilation.length,
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
    if (willDelete.pipes > 0) warnings.push(`будут удалены трубы водоснабжения (${willDelete.pipes}), которых нет в модели: ${idList(deletedIds.pipes)}`);
    if (willDelete.terrace_borders > 0) warnings.push(`будут удалены границы террас (${willDelete.terrace_borders}), которых нет в модели: ${idList(deletedIds.terrace_borders)}`);
    if (willDelete.territory_borders > 0) warnings.push(`будут удалены границы участка (${willDelete.territory_borders}), которых нет в модели: ${idList(deletedIds.territory_borders)}`);
    if (willDelete.level_holes > 0) warnings.push(`будут удалены проёмы в полу (${willDelete.level_holes}), которых нет в модели: ${idList(deletedIds.level_holes)}`);
    if (willDelete.led_strips > 0) warnings.push(`будут удалены светодиодные ленты (${willDelete.led_strips}), которых нет в модели: ${idList(deletedIds.led_strips)}`);
    if (willDelete.stripes_light > 0) warnings.push(`будут удалены трековые шины (${willDelete.stripes_light}), которых нет в модели: ${idList(deletedIds.stripes_light)}`);
    if (willDelete.line_strips > 0) warnings.push(`будет удалено линейное освещение (${willDelete.line_strips}), которого нет в модели: ${idList(deletedIds.line_strips)}`);
    if (willDelete.warm_floors > 0) warnings.push(`будут удалены контуры тёплого пола (${willDelete.warm_floors}), которых нет в модели: ${idList(deletedIds.warm_floors)}`);
    if (willDelete.pipes_warm_floor > 0) warnings.push(`будут удалены магистрали тёплого пола (${willDelete.pipes_warm_floor}), которых нет в модели: ${idList(deletedIds.pipes_warm_floor)}`);
    if (willDelete.pipes_conditioner > 0) warnings.push(`будет удалён дренаж кондиционеров (${willDelete.pipes_conditioner}), которого нет в модели: ${idList(deletedIds.pipes_conditioner)}`);
    if (willDelete.pipes_heat > 0) warnings.push(`будут удалены магистрали отопления (${willDelete.pipes_heat}), которых нет в модели: ${idList(deletedIds.pipes_heat)}`);
    if (willDelete.pipes_ventilation > 0) warnings.push(`будут удалены воздуховоды (${willDelete.pipes_ventilation}), которых нет в модели: ${idList(deletedIds.pipes_ventilation)}`);
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
    // этап 78: трубы водоснабжения — ожидаемые из нормализованной модели (точки
    // вершин-предметов редактор пересчитывает — сверка локальной копии мягкая)
    const expectedPipes = structuredClone((norm.model as { pipes?: Record<string, GasLineSig> }).pipes ?? {});
    const localPipeIds = new Set(Object.keys(this.modelInternal!.pipes ?? {}));
    const gotPipeIds = new Set(Object.keys((norm.model as { pipes?: Record<string, unknown> }).pipes ?? {}));
    // этап 64: ожидаемые границы террас/участка и проёмы в полу — из нормализованной модели
    const expectedBorders = {
      terrace_borders: structuredClone((norm.model as { terrace_borders?: Record<string, unknown> }).terrace_borders ?? {}),
      territory_borders: structuredClone((norm.model as { territory_borders?: Record<string, unknown> }).territory_borders ?? {}),
    };
    const expectedLevelHoles = structuredClone((norm.model as { level_holes?: Record<string, unknown> }).level_holes ?? {});
    // этап 84: световые линии листа «Освещение» — ожидаемые из нормализованной модели
    const expectedLedStrips = structuredClone((norm.model as { led_strips?: Record<string, GasLineSig> }).led_strips ?? {});
    const expectedStripesLight = structuredClone((norm.model as { stripes_light?: Record<string, GasLineSig> }).stripes_light ?? {});
    const expectedLineStrips = structuredClone((norm.model as { line_strips?: Record<string, GasLineSig> }).line_strips ?? {});
    // этап 88: ожидаемые связи «выключатель → светильник» — из нормализованной модели
    const expectedCables = structuredClone((norm.model as { cables?: Record<string, GasLineSig> }).cables ?? {});
    const localLedIds = new Set(Object.keys(this.modelInternal!.led_strips ?? {}));
    const localStripeIds = new Set(Object.keys(this.modelInternal!.stripes_light ?? {}));
    const localLineIds = new Set(Object.keys(this.modelInternal!.line_strips ?? {}));
    const gotLedIds = new Set(Object.keys((norm.model as { led_strips?: Record<string, unknown> }).led_strips ?? {}));
    const gotStripeIds = new Set(Object.keys((norm.model as { stripes_light?: Record<string, unknown> }).stripes_light ?? {}));
    const gotLineIds = new Set(Object.keys((norm.model as { line_strips?: Record<string, unknown> }).line_strips ?? {}));
    const lostOpenings = missingIds(localOpeningIds, gotOpeningIds);
    const lostItems = missingIds(localItemIds, gotItemIds);
    const lostPillars = missingIds(localPillarIds, gotPillarIds);
    const lostRigels = missingIds(localRigelIds, gotRigelIds);
    const lostGasLines = missingIds(localGasIds, gotGasIds);
    const lostPipes = missingIds(localPipeIds, gotPipeIds);
    // этап 84: потери световых линий при нормализации
    const lostLedStrips = missingIds(localLedIds, gotLedIds);
    const lostStripesLight = missingIds(localStripeIds, gotStripeIds);
    const lostLineStrips = missingIds(localLineIds, gotLineIds);
    // этап 88: потери связей при нормализации
    const localCableIds = new Set(Object.keys(this.modelInternal!.cables ?? {}));
    const gotCableIds = new Set(Object.keys((norm.model as { cables?: Record<string, unknown> }).cables ?? {}));
    const lostCables = missingIds(localCableIds, gotCableIds);
    // ревью 59 №1: до save сверяется семантический граф локальной и нормализованной
    // моделей (узлы, тип, рёбра matrix, длина) — normalizer, обнуливший рёбра,
    // не проходит как «verified»
    const gasGraphNorm = gasLineGraphMismatches(
      structuredClone(this.modelInternal!.pipes_gas ?? {}) as Record<string, GasLineSig>,
      (norm.model as { pipes_gas?: Record<string, unknown> }).pipes_gas ?? {},
    );
    const pipesGraphNorm = gasLineGraphMismatches(
      structuredClone(this.modelInternal!.pipes ?? {}) as Record<string, GasLineSig>,
      (norm.model as { pipes?: Record<string, unknown> }).pipes ?? {},
      "труба",
      true,
      structuredClone(this.modelInternal!.items ?? {}) as Record<string, { pc?: Point; width?: number; height?: number; angle?: number }>,
    );
    // ревью 79 №5: подключения труба↔предмет сверяются в обе стороны до записи
    // (только водные ключи — климат сверяет climateGraphMismatches, ревью 124 R2)
    const pipesConnNorm = pipeConnectionMismatches(
      structuredClone(this.modelInternal!.pipes ?? {}) as Record<string, GasLineSig>,
      this.modelInternal!.items as Record<string, PipeLinkItem>,
      (norm.model as { pipes?: Record<string, GasLineSig> }).pipes ?? {},
      (norm.model as { items?: Record<string, PipeLinkItem> }).items ?? {},
      { onlyKeys: WATER_PIPE_KEYS },
    );
    // этап 64: потери границ и проёмов пола при нормализации
    const bordersNorm = checkBordersAfterNormalize(this.modelInternal!, norm.model as Model);
    const holesNorm = checkLevelHolesAfterNormalize(this.modelInternal!, norm.model as Model);
    // этап 84: семантическая сверка световых линий локальной и нормализованной моделей.
    // id_room вершин — производное (редактор пересчитывает принадлежность узла комнате
    // при draw/normalize), в предсохранительной сверке исключается — иначе штатный
    // допис-id_room объявлялся бы потерей (живая проба 84: узлы получили id_room комнаты).
    const ledGraphNorm = gasLineGraphMismatches(
      stripVertexIdRoom(structuredClone(this.modelInternal!.led_strips ?? {})) as Record<string, GasLineSig>,
      (norm.model as { led_strips?: Record<string, unknown> }).led_strips ?? {},
      "светодиодная лента",
    );
    const stripesGraphNorm = gasLineGraphMismatches(
      stripVertexIdRoom(structuredClone(this.modelInternal!.stripes_light ?? {})) as Record<string, GasLineSig>,
      (norm.model as { stripes_light?: Record<string, unknown> }).stripes_light ?? {},
      "трековая шина",
    );
    const lineStripsGraphNorm = gasLineGraphMismatches(
      stripVertexIdRoom(structuredClone(this.modelInternal!.line_strips ?? {})) as Record<string, GasLineSig>,
      (norm.model as { line_strips?: Record<string, unknown> }).line_strips ?? {},
      "линейный свет",
    );
    // этап 88: связи «выключатель → светильник» — семантическая сверка локальной и
    // нормализованной моделей (id_room вершин — производное, как у световых линий)
    const cablesGraphNorm = gasLineGraphMismatches(
      stripVertexIdRoom(structuredClone(this.modelInternal!.cables ?? {})) as Record<string, GasLineSig>,
      (norm.model as { cables?: Record<string, unknown> }).cables ?? {},
      "связь выключатель → светильник",
    );
    const cablesConnNorm = cableConnectionMismatches(
      (this.modelInternal!.cables ?? {}) as Record<string, GasLineSig>,
      (this.modelInternal!.items ?? {}) as Record<string, CableLinkItem>,
      (norm.model as { cables?: Record<string, GasLineSig> }).cables ?? {},
      (norm.model as { items?: Record<string, CableLinkItem> }).items ?? {},
      {
        led_strips: (this.modelInternal!.led_strips ?? {}) as Record<string, unknown>,
        stripes_light: (this.modelInternal!.stripes_light ?? {}) as Record<string, unknown>,
        line_strips: (this.modelInternal!.line_strips ?? {}) as Record<string, unknown>,
      },
      {
        led_strips: ((norm.model as Record<string, unknown>).led_strips ?? {}) as Record<string, unknown>,
        stripes_light: ((norm.model as Record<string, unknown>).stripes_light ?? {}) as Record<string, unknown>,
        line_strips: ((norm.model as Record<string, unknown>).line_strips ?? {}) as Record<string, unknown>,
      },
    );
    // ревью 90 R1, 92 R1a: состав и пользовательские свойства под-розеток сверяются
    // до записи; производная геометрия — только после save против нормализованного ожидания
    const subsNorm = socketGroupSubsUserMismatches(
      this.modelInternal!.items as Record<string, SubsItemSig>,
      (norm.model as { items?: Record<string, unknown> }).items ?? {},
    );
    // этап 94, ревью 95/98: отделка до записи сверяется с нормализованной моделью
    // (режим normalize — правила топологии по эталонам редактора 98)
    const finishNorm = finishCompare(
      (this.modelInternal!["rooms2"] ?? this.modelInternal!["rooms1"]) as Record<string, unknown> | undefined,
      ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
      this.modelInternal!["walls"] as Record<string, unknown> | undefined,
      (norm.model as Record<string, unknown>)["walls"] as Record<string, unknown> | undefined,
      "normalize",
    );
    // этап 113: размеры и комментарии до записи сверяются с нормализованной моделью
    const dimsNorm = dimsMismatches(this.modelInternal!, norm.model as Record<string, unknown>);
    // этап 122: сущности климата до записи сверяются с нормализованной моделью
    const climateNorm = climateGraphMismatches(this.modelInternal!, norm.model as Record<string, unknown>, {
      mode: "normalize",
      roomsExpected: (this.modelInternal!["rooms2"] ?? this.modelInternal!["rooms1"]) as Record<string, unknown> | undefined,
      roomsGot: ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
      itemsExpected: this.modelInternal!.items as unknown as Record<string, PipeLinkItem>,
      itemsGot: (norm.model as { items?: Record<string, PipeLinkItem> }).items ?? {},
    });
    // ревью 66 №3: роли стен (ограждение террасы) не должны меняться при нормализации
    const expectedWalls = structuredClone((norm.model as { walls?: Record<string, { role?: string; p1: Point; p2: Point }> }).walls ?? {});
    const rolesNorm = wallRoleMismatches(this.modelInternal!.walls as unknown as Record<string, { role?: string; p1: Point; p2: Point }>, expectedWalls);
    // ревью 73 №2: свойства ограждений (height/depth/material) не должны меняться при нормализации
    const propsNorm = balconyWallPropertyMismatches(
      this.modelInternal!.walls as unknown as Record<string, BalconyWallProps>,
      expectedWalls as unknown as Record<string, BalconyWallProps>,
    );
    const gotSegments = wallAxisSegments(normWalls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
    const gotCoverage = wallAxisCoverageCm(normWalls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
    // ревью 43 №4: комнаты с пользовательскими полями не исчезают при нормализации молча
    const normRooms = Object.keys((norm.model as { rooms2?: Record<string, unknown> }).rooms2 ?? {}).length;
    if (roomsBefore > 0 && normRooms === 0) {
      warnings.push(`редактор убрал комнаты при нормализации (${roomsBefore} → 0) — имя и отделка комнат могут быть потеряны; проверьте rooms_list после сохранения`);
    }
    if (
      !wallAxisSetsEqual(gotSegments, expected.segments) ||
      lostOpenings.length > 0 || lostItems.length > 0 || lostPillars.length > 0 || lostRigels.length > 0 || lostGasLines.length > 0 || lostPipes.length > 0 ||
      gasGraphNorm.length > 0 || pipesGraphNorm.length > 0 || pipesConnNorm.length > 0 || bordersNorm.length > 0 || holesNorm.length > 0 || rolesNorm.length > 0 || propsNorm.length > 0 ||
      lostLedStrips.length > 0 || lostStripesLight.length > 0 || lostLineStrips.length > 0 ||
      lostCables.length > 0 ||
      ledGraphNorm.length > 0 || stripesGraphNorm.length > 0 || lineStripsGraphNorm.length > 0 ||
      cablesGraphNorm.length > 0 || cablesConnNorm.length > 0 || subsNorm.length > 0 || finishNorm.problems.length > 0 ||
      dimsNorm.length > 0 || climateNorm.length > 0
    ) {
      throw new McpError("NORMALIZATION_DROPPED", "редактор потерял объекты при нормализации", {
        details: {
          expected_walls: expected.walls,
          after_walls: norm.after.walls,
          coverage_before_mm: Math.round(expected.coverage * 10),
          coverage_after_mm: Math.round(gotCoverage * 10),
          axis_segments_before: expected.segments.length,
          axis_segments_after: gotSegments.length,
          wall_property_mismatches: propsNorm,
          lost_openings: lostOpenings,
          lost_items: lostItems,
          lost_pillars: lostPillars,
          lost_rigels: lostRigels,
          lost_gas_lines: lostGasLines,
          gas_line_mismatches: gasGraphNorm,
          lost_pipes: lostPipes,
          pipe_mismatches: pipesGraphNorm,
          pipe_connection_mismatches: pipesConnNorm,
          border_mismatches: bordersNorm,
          level_hole_mismatches: holesNorm,
          wall_role_mismatches: rolesNorm,
          lost_led_strips: lostLedStrips,
          lost_stripes_light: lostStripesLight,
          lost_line_strips: lostLineStrips,
          lost_cables: lostCables,
          led_strip_mismatches: ledGraphNorm,
          stripes_light_mismatches: stripesGraphNorm,
          line_strips_mismatches: lineStripsGraphNorm,
          cables_mismatches: cablesGraphNorm,
          cables_connection_mismatches: cablesConnNorm,
          socket_group_mismatches: subsNorm,
          finish_mismatches: finishNorm.problems,
          dims_mismatches: dimsNorm,
          climate_mismatches: climateNorm,
        },
      });
    }
    warnings.push(...finishNorm.warnings);
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
      // этап 78: трубы водоснабжения после save — по нормализованной семантике графа;
      // ревью 79 №3/№5: точки вершин-предметов и длина — строго (ожидание уже
      // нормализованное), множество труб в обе стороны, identity вершин-предметов по id
      const pipesAfter = (after.model["pipes"] as Record<string, unknown> | undefined) ?? {};
      const pipeMismatch = gasLineGraphMismatches(expectedPipes, pipesAfter, "труба");
      // ревью 79 №5a: обратные ссылки props.pipes и прямые ссылки предметов — обе стороны
      // (только водные ключи — климат сверяет climateGraphMismatches, ревью 124 R2)
      const pipeConnAfter = pipeConnectionMismatches(
        expectedPipes,
        expectedItems as Record<string, PipeLinkItem>,
        pipesAfter as Record<string, GasLineSig>,
        (itemsAfter as Record<string, PipeLinkItem>) ?? {},
        { onlyKeys: WATER_PIPE_KEYS },
      );
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
      // этап 84: световые линии после save — по нормализованной семантике графа
      const ledAfter = (after.model["led_strips"] as Record<string, unknown> | undefined) ?? {};
      const stripesAfter = (after.model["stripes_light"] as Record<string, unknown> | undefined) ?? {};
      const lineStripsAfter = (after.model["line_strips"] as Record<string, unknown> | undefined) ?? {};
      const ledMismatch = gasLineGraphMismatches(expectedLedStrips, ledAfter, "светодиодная лента");
      const stripesMismatch = gasLineGraphMismatches(expectedStripesLight, stripesAfter, "трековая шина");
      const lineStripsMismatch = gasLineGraphMismatches(expectedLineStrips, lineStripsAfter, "линейный свет");
      // этап 88: связи «выключатель → светильник» после save — граф и обе стороны ссылок
      const cablesAfter = (after.model["cables"] as Record<string, unknown> | undefined) ?? {};
      const cablesMismatch = gasLineGraphMismatches(expectedCables, cablesAfter, "связь выключатель → светильник");
      const cablesConnAfter = cableConnectionMismatches(
        expectedCables,
        expectedItems as Record<string, CableLinkItem>,
        cablesAfter as Record<string, GasLineSig>,
        (itemsAfter as Record<string, CableLinkItem>) ?? {},
        {
          led_strips: ((norm.model as Record<string, unknown>).led_strips ?? {}) as Record<string, unknown>,
          stripes_light: ((norm.model as Record<string, unknown>).stripes_light ?? {}) as Record<string, unknown>,
          line_strips: ((norm.model as Record<string, unknown>).line_strips ?? {}) as Record<string, unknown>,
        },
        {
          led_strips: ((after.model["led_strips"] as Record<string, unknown> | undefined) ?? {}),
          stripes_light: ((after.model["stripes_light"] as Record<string, unknown> | undefined) ?? {}),
          line_strips: ((after.model["line_strips"] as Record<string, unknown> | undefined) ?? {}),
        },
      );
      // ревью 90 R6: форма обратных ссылок (массив у под-розетки, скаляр у светильника)
      // после save сверяется с нормализованным ожиданием
      const cableFormAfter = cableLinkFormMismatches(
        expectedItems as Record<string, CableLinkItem>,
        itemsAfter,
      );
      // ревью 90 R1, 92 R1a/R1b: состав и пользовательские свойства под-розеток
      // после save; производная геометрия (center/real_center/vd) — против
      // нормализованного ожидания с допуском
      const subsAfter = socketGroupSubsUserMismatches(
        expectedItems as Record<string, SubsItemSig>,
        itemsAfter,
      );
      const subsDerivedAfter = socketGroupSubsDerivedMismatches(
        expectedItems as Record<string, SubsItemSig>,
        itemsAfter,
      );
      // ревью 66 №3: роли стен после save — ограждение, ставшее обычной стеной, не «verified»
      const wallsAfterTyped = wallsAfter as Record<string, { role?: string; p1: Point; p2: Point }>;
      const wallRoleMismatch = wallRoleMismatches(expectedWalls, wallsAfterTyped);
      // ревью 73 №2: свойства ограждений после save — height/depth/material сверяются,
      // подмена любого из них на сервере не «verified»
      const wallPropMismatch = balconyWallPropertyMismatches(
        expectedWalls as unknown as Record<string, BalconyWallProps>,
        wallsAfterTyped as unknown as Record<string, BalconyWallProps>,
      );
      // этап 94, ревью 95/98: отделка после save сверяется по GET — нормализованное
      // ожидание против сервера; режим save — СТРОГО (ревью 98 N1/N2): комната и каждая
      // сторона стены (ориентированно) сохраняют отделку; никаких merge/split-освобождений
      const expectedFinish = ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined;
      const gotFinish = ((after.model["rooms2"] ?? after.model["rooms1"]) as Record<string, unknown> | undefined) ?? {};
      const finishAfter = finishCompare(
        expectedFinish,
        gotFinish,
        (norm.model as Record<string, unknown>)["walls"] as Record<string, unknown> | undefined,
        after.model["walls"] as Record<string, unknown> | undefined,
        "save",
      ).problems;
      // этап 113: размеры и комментарии после save сверяются по GET — нормализованное
      // ожидание против сервера (строго: текст, точки, привязки, отступ, цвет)
      const dimsAfter = dimsMismatches(norm.model as Model, after.model as Record<string, unknown>);
      // этап 122: сущности климата после save — нормализованное ожидание против сервера
      const climateExpected = {
        warm_floors: structuredClone((norm.model as Record<string, unknown>)["warm_floors"] ?? {}),
        pipes_warm_floor: structuredClone((norm.model as Record<string, unknown>)["pipes_warm_floor"] ?? {}),
        pipes_conditioner: structuredClone((norm.model as Record<string, unknown>)["pipes_conditioner"] ?? {}),
        pipes_heat: structuredClone((norm.model as Record<string, unknown>)["pipes_heat"] ?? {}),
        pipes_ventilation: structuredClone((norm.model as Record<string, unknown>)["pipes_ventilation"] ?? {}),
      };
      const climateAfter = climateGraphMismatches(
        climateExpected as unknown as Model,
        after.model as Record<string, unknown>,
        {
          mode: "save",
          itemsExpected: structuredClone((norm.model as { items?: Record<string, PipeLinkItem> }).items ?? {}),
          itemsGot: (itemsAfter as Record<string, PipeLinkItem>) ?? {},
        },
      );
      const roomsLost = normRooms > 0 && roomsAfter === 0;
      if (wallAxisSetsEqual(segmentsAfter, expected.segments) && pillarMismatch.length === 0 && rigelMismatch.length === 0 && itemMismatch.length === 0 && gasMismatch.length === 0 && pipeMismatch.length === 0 && pipeConnAfter.length === 0 && borderMismatch.length === 0 && holeMismatch.length === 0 && wallRoleMismatch.length === 0 && wallPropMismatch.length === 0 && ledMismatch.length === 0 && stripesMismatch.length === 0 && lineStripsMismatch.length === 0 && cablesMismatch.length === 0 && cablesConnAfter.length === 0 && cableFormAfter.length === 0 && subsAfter.length === 0 && subsDerivedAfter.length === 0 && finishAfter.length === 0 && dimsAfter.length === 0 && climateAfter.length === 0 && !roomsLost) {
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
            pipe_mismatches: pipeMismatch,
            pipe_connection_mismatches: pipeConnAfter,
            border_mismatches: borderMismatch,
            level_hole_mismatches: holeMismatch,
            wall_role_mismatches: wallRoleMismatch,
            wall_property_mismatches: wallPropMismatch,
            led_strip_mismatches: ledMismatch,
            stripes_light_mismatches: stripesMismatch,
            line_strips_mismatches: lineStripsMismatch,
            cables_mismatches: cablesMismatch,
            cables_connection_mismatches: cablesConnAfter,
            cables_link_form_mismatches: cableFormAfter,
            socket_group_mismatches: subsAfter,
            socket_group_derived_mismatches: subsDerivedAfter,
            rooms_expected: normRooms, rooms_on_server: roomsAfter,
            finish_mismatches: finishAfter,
            dims_mismatches: dimsAfter,
            climate_mismatches: climateAfter,
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
    const seen = { walls: norm.after.walls, openings: norm.after.holes, items: norm.after.items, pillars: norm.after.pillars ?? Object.keys((norm.model as { pillars?: Record<string, unknown> }).pillars ?? {}).length, rigels: norm.after.rigels ?? Object.keys((norm.model as { rigels?: Record<string, unknown> }).rigels ?? {}).length, pipes: Object.keys((norm.model as { pipes?: Record<string, unknown> }).pipes ?? {}).length, led_strips: Object.keys((norm.model as { led_strips?: Record<string, unknown> }).led_strips ?? {}).length, stripes_light: Object.keys((norm.model as { stripes_light?: Record<string, unknown> }).stripes_light ?? {}).length, line_strips: Object.keys((norm.model as { line_strips?: Record<string, unknown> }).line_strips ?? {}).length };
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
    if (seen.pipes !== expected.pipes) mismatch.push(`pipes: в модели ${expected.pipes}, в редакторе ${seen.pipes}`);
    if (seen.rigels !== expected.rigels) mismatch.push(`rigels: в модели ${expected.rigels}, в редакторе ${seen.rigels}`);
    if (seen.led_strips !== expected.led_strips) mismatch.push(`led_strips: в модели ${expected.led_strips}, в редакторе ${seen.led_strips}`);
    if (seen.stripes_light !== expected.stripes_light) mismatch.push(`stripes_light: в модели ${expected.stripes_light}, в редакторе ${seen.stripes_light}`);
    if (seen.line_strips !== expected.line_strips) mismatch.push(`line_strips: в модели ${expected.line_strips}, в редакторе ${seen.line_strips}`);
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
