import { PIPE_TYPE_BY_KIND, PIPE_MULTI_SPOTS, pipeLinkKey, CLIMATE_PIPE_KINDS, PIPE_LINK_KEY_BY_TYPE, PIPE_LINK_BOXES, isMultiPipeItem } from "../model/pipes.ts";
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
/** Виды труб водоснабжения: только для них действуют scalar/multi правила воды. */
export const WATER_PIPE_KEYS = new Set(Object.values(PIPE_TYPE_BY_KIND).map(pipeLinkKey));

/**
 * Сверка подключений труба↔предмет в обе стороны (ревью 79 №5, ревью 81 5-R,
 * климат ч.2): у каждой вершины-предмета трубы props.<box>[ключ вида] должен
 * указывать на неё (box — pipes у водоснабжения, имя коллекции у климата,
 * ключ — PIPE_LINK_KEY_BY_TYPE: drainage_pipe_id у дренажа, pipe_warm_floor_id
 * у магистралей тёплого пола и т.д.), и каждая обратная ссылка предмета — на
 * существующую трубу того же вида, чьи вершины содержат этот предмет. Фактические
 * ссылки сервера (gotItems) сверяются с ожидаемыми (expectedItems) ПОЛНОСТЬЮ:
 * нет лишних, нет пропущенных, вид трубы совпадает с ключом, scalar у обычных
 * выводов / массив у multi (правило — все multi-предметы труб, вода и климат).
 * opts.onlyKeys ограничивает сверку подмножеством видов (например, только климат).
 */
export function pipeConnectionMismatches(
  expectedPipes: Record<string, GasLineSig>,
  expectedItems: Record<string, PipeLinkItem>,
  gotPipes: Record<string, GasLineSig>,
  gotItems: Record<string, PipeLinkItem>,
  opts: { onlyKeys?: Set<string> } = {},
): VerificationMismatches {
  const out: string[] = [];
  const pipeKeys = new Set(Object.values(PIPE_LINK_KEY_BY_TYPE));
  /** Активные виды ссылки: весь реестр или подмножество (климат). */
  const activeKeys = opts.onlyKeys ?? pipeKeys;
  /** Вид трубы по ключу ссылки (drainage_pipe_id → conditioner_drainage); null — не труба. */
  const pipeTypeOfKey = (key: string): string | null => {
    for (const [type, k] of Object.entries(PIPE_LINK_KEY_BY_TYPE)) {
      if (k === key) return type;
    }
    return null;
  };
  /** Ссылки предмета на трубы: ключ → множество id (только активные ключи труб, только строки). */
  const linksOf = (item: PipeLinkItem | undefined): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const box of PIPE_LINK_BOXES) {
      const held = item?.[box] as Record<string, unknown> | undefined;
      if (!held || typeof held !== "object") continue;
      for (const [key, ref] of Object.entries(held)) {
        if (!activeKeys.has(key)) continue;
        const ids = (Array.isArray(ref) ? ref : [ref]).filter((x): x is string => typeof x === "string" && x !== "");
        out.set(key, new Set(ids));
      }
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
      const cur = findLink(item, key);
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
  // (ревью 81 5-R; климат ч.2: то же правило для труб климата — multi у
  // коллекторных узлов и ventilation_system, скаляр у остальных)
  for (const [itemId, item] of Object.entries(gotItems)) {
    const name = (item as { name?: string }).name;
    for (const box of PIPE_LINK_BOXES) {
      const held = item[box] as Record<string, unknown> | undefined;
      if (!held || typeof held !== "object") continue;
      for (const [key, ref] of Object.entries(held)) {
        if (!activeKeys.has(key) || ref === undefined || ref === null || ref === "") continue;
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

/** Значение обратной ссылки предмета по ключу в любом боксе труб. */
function findLink(item: PipeLinkItem | undefined, key: string): unknown {
  for (const box of PIPE_LINK_BOXES) {
    const held = item?.[box] as Record<string, unknown> | undefined;
    if (held && typeof held === "object" && key in held) return held[key];
  }
  return undefined;
}
