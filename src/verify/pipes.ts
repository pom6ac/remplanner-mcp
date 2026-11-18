import { PIPE_TYPE_BY_KIND, PIPE_MULTI_SPOTS, pipeLinkKey, CLIMATE_PIPE_KINDS } from "../model/pipes.ts";
import type { GasLineSig } from "./graphs.ts";
import type { VerificationMismatches } from "./types.ts";

/** Предмет с обратными ссылками на трубы (props.pipes). */
export type PipeLinkItem = { name?: string; pipes?: Record<string, unknown> };

/**
 * Типы всех трубных линий модели: водоснабжение (model.pipes) и климат
 * (pipes_warm_floor/pipes_conditioner/pipes_heat/pipes_ventilation, ревью 124 R2).
 */
export const ALL_PIPE_TYPES = [...Object.values(PIPE_TYPE_BY_KIND), ...Object.values(CLIMATE_PIPE_KINDS).map((c) => c.type)];
/** Виды труб водоснабжения: только для них действуют scalar/multi правила воды. */
export const WATER_PIPE_KEYS = new Set(Object.values(PIPE_TYPE_BY_KIND).map(pipeLinkKey));

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
export function pipeConnectionMismatches(
  expectedPipes: Record<string, GasLineSig>,
  expectedItems: Record<string, PipeLinkItem>,
  gotPipes: Record<string, GasLineSig>,
  gotItems: Record<string, PipeLinkItem>,
  opts: { onlyKeys?: Set<string> } = {},
): VerificationMismatches {
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
