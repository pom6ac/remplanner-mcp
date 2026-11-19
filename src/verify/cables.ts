import type { GasLineSig } from "./graphs.ts";
import type { VerificationMismatches } from "./types.ts";

/** Предмет с обратными ссылками связи «выключатель → светильник» (этап 88). */
export type CableLinkItem = {
  name?: string;
  cables?: { cable_id?: unknown };
  socket_group?: Array<{ name?: string; id?: string; cables?: { cable_id?: unknown } }>;
};

export type CableLinkLines = {
  led_strips?: Record<string, unknown>;
  stripes_light?: Record<string, unknown>;
  line_strips?: Record<string, unknown>;
};

/** Световая линия с обратной ссылкой связи (props.cables, часть 2). */
type CableLinkLine = { props?: { cables?: { cable_id?: unknown } } };

/** Коллекция световой линии по типу вершины связи (ревью 90 R2) — зеркало electric.ts. */
const CABLE_LINE_BY_VERTEX: Record<string, keyof CableLinkLines> = {
  led_strip: "led_strips",
  strip_light: "stripes_light",
  line_strip: "line_strips",
};

/** Имена выключателей (под-розетки, хранящие cables) — для проверки формы ссылок. */
const SWITCH_KEYS = new Set([
  "light_switch", "light_switch_double", "light_switch_triple",
  "light_switch_through", "light_switch_through_double",
  "light_switch_cross", "light_switch_cross_double", "light_dimmer",
]);

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
export function cableConnectionMismatches(
  expectedCables: Record<string, GasLineSig>,
  expectedItems: Record<string, CableLinkItem>,
  gotCables: Record<string, GasLineSig>,
  gotItems: Record<string, CableLinkItem>,
  expectedLines: CableLinkLines = {},
  gotLines: CableLinkLines = {},
): VerificationMismatches {
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
  const holderIsVertex = (cable: GasLineSig | undefined, kind: "sub" | "item" | "line", itemId: string, subId: string): boolean => {
    if (!cable) return false;
    for (const v of cable.vertexes ?? []) {
      if (kind === "sub") {
        if (v.type === "switch" && v.id === `${itemId}|s|${subId}`) return true;
      } else if (kind === "line") {
        if (v.type !== "node" && v.type !== "switch" && typeof v.id === "string" && v.id.startsWith(`${itemId}|t|`)) return true;
      } else if (v.type !== "node" && v.type !== "switch" && v.id === itemId) {
        return true;
      }
    }
    return false;
  };
  /** Ссылки ожидаемой стороны: id связи → множество «предмет(под-розетка)». */
  const collectRefs = (cables: Record<string, GasLineSig>, items: Record<string, CableLinkItem>, side: string, linesOf: Record<string, Record<string, unknown> | undefined> = {}): Map<string, Set<string>> => {
    const refs = new Map<string, Set<string>>();
    const addRef = (cableId: string, holder: string, kind: "sub" | "item" | "line", itemId: string, subId: string): boolean => {
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
    // световые линии: props.cables.cable_id — скаляр (часть 2, проба 239-elec2-link6)
    for (const [coll, lines] of Object.entries(linesOf)) {
      for (const [lineId, line] of Object.entries(lines ?? {})) {
        const link = (line as CableLinkLine).props?.cables;
        for (const id of cableIdsOf(link)) addRef(id, `линия ${lineId} (${coll})`, "line", lineId, "");
      }
    }
    return refs;
  };
  const expRefs = collectRefs(expectedCables, expectedItems, "ожидание", expectedLines as Record<string, Record<string, unknown> | undefined>);
  const gotRefs = collectRefs(gotCables, gotItems, "сервер", gotLines as Record<string, Record<string, unknown> | undefined>);
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
          const vid = String(v.id);
          const lineId = vid.includes("|t|") ? vid.slice(0, vid.indexOf("|t|")) : vid;
          const line = (lines[collKey] ?? {})[lineId] as CableLinkLine | undefined;
          if (!line) out.push(`${label}: ${cableId} — линия ${lineId} (type ${String(v.type)}) не найдена в ${collKey}`);
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
export function cableLinkFormMismatches(
  expectedItems: Record<string, CableLinkItem>,
  gotItems: Record<string, unknown>,
): VerificationMismatches {
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
