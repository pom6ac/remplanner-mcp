import { PIPE_TYPE_BY_KIND, pipeLinkKey, CLIMATE_PIPE_KINDS, PIPE_LINK_KEY_BY_TYPE, PIPE_LINK_BOXES, isMultiPipeItem } from "../model/pipes.ts";
import type { GasLineSig } from "./graphs.ts";
import type { VerificationMismatches } from "./types.ts";

/** Предмет с обратными ссылками на трубы: у водоснабжения props.pipes,
 *  у климата props.<коллекция> (pipes_heat/pipes_conditioner/pipes_warm_floor/
 *  pipes_ventilation, climate ч.2). */
export type PipeLinkItem = {
  name?: string;
  pipes?: Record<string, unknown>;
  pipes_heat?: Record<string, unknown>;
  pipes_conditioner?: Record<string, unknown>;
  pipes_warm_floor?: Record<string, unknown>;
  pipes_ventilation?: Record<string, unknown>;
  [box: string]: unknown;
};

/**
 * Типы всех трубных линий модели: водоснабжение (model.pipes) и климат
 * (pipes_warm_floor/pipes_conditioner/pipes_heat/pipes_ventilation, ревью 124 R2).
 */
export const ALL_PIPE_TYPES = [...Object.values(PIPE_TYPE_BY_KIND), ...Object.values(CLIMATE_PIPE_KINDS).map((c) => c.type)];
/** Виды труб водоснабжения: только для них действуют правила водных ссылок. */
export const WATER_PIPE_TYPES = new Set(Object.values(PIPE_TYPE_BY_KIND));
/** Ключи ссылок водоснабжения (props.pipes.<ключ>). */
export const WATER_PIPE_KEYS = new Set(Object.values(PIPE_TYPE_BY_KIND).map(pipeLinkKey));

/** Вид трубы по паре (бокс props, ключ): ключ drainage_pipe_id в props.pipes —
 *  канализация, в props.pipes_conditioner — дренаж кондиционера (climate ч.2). */
const TYPE_BY_BOX_KEY = new Map<string, string>();
function boxOfType(type: string): string {
  for (const c of Object.values(CLIMATE_PIPE_KINDS)) if (c.type === type) return c.coll;
  return "pipes";
}
for (const type of ALL_PIPE_TYPES) {
  TYPE_BY_BOX_KEY.set(`${boxOfType(type)}|${pipeLinkKey(type)}`, type);
}

/**
 * Сверка подключений труба↔предмет в обе стороны (ревью 79 №5, ревью 81 5-R,
 * климат ч.2): у каждой вершины-предмета трубы props.<box>[ключ вида] должен
 * указывать на неё (box — pipes у водоснабжения, имя коллекции у климата,
 * ключ — PIPE_LINK_KEY_BY_TYPE: drainage_pipe_id у дренажа, pipe_warm_floor_id
 * у магистралей тёплого пола и т.д.), и каждая обратная ссылка предмета — на
 * существующую трубу того же вида, чьи вершины содержат этот предмет. Фактические
 * ссылки сервера (gotItems) сверяются с ожидаемыми (expectedItems) ПОЛНОСТЬЮ:
 * нет лишних, нет пропущенных, вид трубы совпадает с парой (бокс, ключ), scalar
 * у обычных выводов / массив у multi (правило — все multi-предметы труб).
 * opts.onlyTypes ограничивает сверку подмножеством видов (вода / климат).
 */
export function pipeConnectionMismatches(
  expectedPipes: Record<string, GasLineSig>,
  expectedItems: Record<string, PipeLinkItem>,
  gotPipes: Record<string, GasLineSig>,
  gotItems: Record<string, PipeLinkItem>,
  opts: { onlyTypes?: Set<string> } = {},
): VerificationMismatches {
  const out: string[] = [];
  const activeTypes = opts.onlyTypes ?? new Set(ALL_PIPE_TYPES);
  /** Ссылки предмета на трубы: «бокс|ключ» → множество id (только трубы активных видов). */
  const linksOf = (item: PipeLinkItem | undefined): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const box of PIPE_LINK_BOXES) {
      const held = item?.[box] as Record<string, unknown> | undefined;
      if (!held || typeof held !== "object") continue;
      for (const [key, ref] of Object.entries(held)) {
        const type = TYPE_BY_BOX_KEY.get(`${box}|${key}`);
        if (!type || (opts.onlyTypes && !opts.onlyTypes.has(type))) continue;
        const ids = (Array.isArray(ref) ? ref : [ref]).filter((x): x is string => typeof x === "string" && x !== "");
        out.set(`${box}|${key}`, new Set(ids));
      }
    }
    return out;
  };
  // направление 1: труба → props.<box> предмета (ревью 79 №5a)
  for (const [id, p] of Object.entries(expectedPipes)) {
    const type = String(p.type ?? "");
    if (opts.onlyTypes && !opts.onlyTypes.has(type)) continue;
    const box = boxOfType(type);
    const key = pipeLinkKey(type);
    for (const v of p.vertexes ?? []) {
      const vid = v.id;
      if ((v.type ?? "node") === "node" || typeof vid !== "string") continue;
      const item = gotItems[vid];
      if (!item) {
        out.push(`${id}: предмет ${vid} исчез после сохранения`);
        continue;
      }
      const held = item[box] as Record<string, unknown> | undefined;
      const cur = held?.[key];
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
    const slots = new Set([...gotLinks.keys(), ...expLinks.keys()]);
    for (const slot of slots) {
      const [box, key] = slot.split("|") as [string, string];
      const wantType = TYPE_BY_BOX_KEY.get(slot)!;
      const gotIds = gotLinks.get(slot) ?? new Set();
      const expIds = expLinks.get(slot) ?? new Set();
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
        if ((gp.type ?? "") !== wantType) {
          out.push(`${itemId}: обратная ссылка ${key} указывает на трубу ${pid} другого вида (на сервере «${gp.type ?? ""}»; по боксу ${box} — «${wantType}»)`);
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
  // (ревью 81 5-R; климат ч.2: коллекторные узлы и ventilation_system — массив)
  for (const [itemId, item] of Object.entries(gotItems)) {
    const name = (item as { name?: string }).name;
    for (const box of PIPE_LINK_BOXES) {
      const held = item[box] as Record<string, unknown> | undefined;
      if (!held || typeof held !== "object") continue;
      for (const [key, ref] of Object.entries(held)) {
        const type = TYPE_BY_BOX_KEY.get(`${box}|${key}`);
        if (!type || (opts.onlyTypes && !opts.onlyTypes.has(type))) continue;
        if (ref === undefined || ref === null || ref === "") continue;
        const isMulti = typeof name === "string" && isMultiPipeItem(name);
        if (isMulti && !Array.isArray(ref)) {
          out.push(`${itemId}: у multi-предмета «${name}» ссылка ${key} должна быть массивом труб (на сервере скаляр)`);
        }
        if (!isMulti && Array.isArray(ref)) {
          out.push(`${itemId}: у обычного вывода «${name ?? "?"}» ссылка ${key} должна быть скаляром (на сервере массив)`);
        }
      }
    }
  }
  return out;
}
