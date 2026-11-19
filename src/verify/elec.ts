import { ELEC_MULTI_ITEMS, ELEC_CABLE_COLLECTIONS, elecLinkKey, type ElecCableColl } from "../model/electric2.ts";
import type { GasLineSig } from "./graphs.ts";
import type { VerificationMismatches } from "./types.ts";

/** Предмет с обратными ссылками на кабели-проводку (props.cables_socket и т.п.). */
export type ElecLinkItem = {
  name?: string;
  socket_group?: Array<{ id?: string; name?: string } & Record<string, unknown>>;
} & Record<string, unknown>;

/** Коллекции проводки и их свойства для сверки. */
const COLLS: readonly ElecCableColl[] = ELEC_CABLE_COLLECTIONS;

/** Под-розетка/предмет-держатель: props.<coll>.cable_<тип>_id (scalar у electrospot, массив у multi). */
function linksOf(item: ElecLinkItem | undefined, coll: ElecCableColl, key: string): Set<string> {
  const box = item?.[coll] as { [k: string]: unknown } | undefined;
  const ref = box?.[key];
  const ids = Array.isArray(ref) ? ref : [ref];
  return new Set(ids.filter((x): x is string => typeof x === "string" && x !== ""));
}

/**
 * Сверка подключений кабель↔предмет в обе стороны (по образцу pipeConnectionMismatches):
 * у каждой вершины-предмета props.<coll>.cable_<тип>_id должен указывать на кабель,
 * каждая обратная ссылка — на существующий кабель той же коллекции того же типа,
 * чьи вершины содержат этот предмет (вершина под-розетки — "<gid>|s|<subId>").
 * Форма ссылки (скаляр/массив) сверяется с ролью предмета: multi — массив,
 * electrospot — скаляр (пробы 239-elec2-attach5/link6).
 * only (ревью 241 №6): сверять только одну коллекцию — вызывающий цикл по
 * коллекциям передаёт текущую, чтобы расхождение не дублировалось под ключами
 * остальных коллекций.
 */
export function elecCableConnectionMismatches(
  expected: Partial<Record<ElecCableColl, Record<string, GasLineSig>>>,
  expectedItems: Record<string, ElecLinkItem>,
  got: Partial<Record<ElecCableColl, Record<string, GasLineSig>>>,
  gotItems: Record<string, ElecLinkItem>,
  only?: ElecCableColl,
): VerificationMismatches {
  const out: string[] = [];
  /** Держатель вершины: [itemId, subId | undefined]. */
  const ownerOf = (vid: string): [string, string | undefined] => {
    const idx = vid.indexOf("|s|");
    return idx > 0 ? [vid.slice(0, idx), vid.slice(idx + 3)] : [vid, undefined];
  };
  for (const coll of COLLS) {
    if (only && coll !== only) continue;
    const expCables = expected[coll] ?? {};
    const gotCables = got[coll] ?? {};
    const keyOf = (cable: GasLineSig): string => elecLinkKey(coll, String(cable.type ?? ""));
    // направление 1: кабель → ссылки предметов
    for (const [id, cable] of Object.entries(expCables)) {
      const key = keyOf(cable);
      for (const v of cable.vertexes ?? []) {
        if ((v.type ?? "node") === "node" || typeof v.id !== "string") continue;
        const [itemId, subId] = ownerOf(v.id);
        const item = gotItems[itemId];
        if (!item) {
          out.push(`${id}: предмет ${itemId} исчез после сохранения`);
          continue;
        }
        const holder: Record<string, unknown> | undefined = subId !== undefined
          ? ((item.socket_group as Array<Record<string, unknown>> | undefined) ?? []).find((s) => s.id === subId)
          : item;
        if (!holder) {
          out.push(`${id}: под-розетка ${subId} группы ${itemId} не найдена`);
          continue;
        }
        const cur = (holder[coll] as { [k: string]: unknown } | undefined)?.[key];
        const ok = cur === id || (Array.isArray(cur) && cur.includes(id));
        if (!ok) {
          out.push(`${id}: предмет ${itemId}${subId ? `/${subId}` : ""} потерял обратную ссылку ${key} (на сервере ${JSON.stringify(cur ?? null)}; ожидалось «${id}»)`);
        }
      }
    }
    // направление 2: все фактические ссылки обеих сторон — полнота и валидность
    for (const side of [["ожидание", expCables, expectedItems], ["сервер", gotCables, gotItems]] as const) {
      const [label, cables, items] = side;
      for (const [itemId, item] of Object.entries(items as Record<string, ElecLinkItem>)) {
        const holders: Array<[Record<string, unknown> | undefined, string]> = [[item, ""]];
        for (const sub of ((item.socket_group as Array<Record<string, unknown>> | undefined) ?? [])) {
          holders.push([sub, `/${String(sub.id ?? "?")}`]);
        }
        for (const [holder, suffix] of holders) {
          const box = holder?.[coll] as { [k: string]: unknown } | undefined;
          if (!box) continue;
          for (const [key, ref] of Object.entries(box)) {
            if (!key.startsWith("cable_") || !key.endsWith("_id")) continue;
            const ids = (Array.isArray(ref) ? ref : [ref]).filter((x): x is string => typeof x === "string" && x !== "");
            for (const cid of ids) {
              const cable = (cables as Record<string, GasLineSig>)[cid];
              if (!cable) {
                                out.push(`${label}: ${itemId}${suffix} — ссылка ${key} указывает на отсутствующий кабель ${cid}`);
                continue;
              }
              if (keyOf(cable) !== key) {
                out.push(`${label}: ${itemId}${suffix} — ссылка ${key} указывает на кабель ${cid} другого вида (тип «${String(cable.type ?? "")}»)`);
              }
              const wantVertex = suffix !== "" ? `${itemId}|s|${suffix.slice(1)}` : itemId;
              if (!(cable.vertexes ?? []).some((v) => v.id === wantVertex)) {
                out.push(`${label}: кабель ${cid} не содержит ${itemId}${suffix} в вершинах (ссылка ${key})`);
              }
            }
          }
        }
      }
    }
    // направление 3: форма ссылки — массив у multi, скаляр у остальных
    for (const [itemId, item] of Object.entries(gotItems)) {
      const holders: Array<[Record<string, unknown> | undefined, string]> = [[item as Record<string, unknown>, ""]];
      for (const sub of ((item.socket_group as Array<Record<string, unknown>> | undefined) ?? [])) {
        holders.push([sub, `/${String(sub.id ?? "?")}`]);
      }
      for (const [holder, suffix] of holders) {
        const box = holder?.[coll] as { [k: string]: unknown } | undefined;
        if (!box) continue;
        for (const [k, ref] of Object.entries(box)) {
          if (!k.startsWith("cable_") || !k.endsWith("_id") || ref === undefined || ref === null || ref === "") continue;
          const isMulti = ELEC_MULTI_ITEMS.has(String((holder as { name?: string }).name ?? ""));
          if (isMulti && !Array.isArray(ref)) {
            out.push(`${itemId}${suffix}: у multi-предмета ссылка ${k} должна быть массивом (на сервере скаляр)`);
          }
          if (!isMulti && Array.isArray(ref)) {
            out.push(`${itemId}${suffix}: у вывода ссылка ${k} должна быть скаляром (на сервере массив)`);
          }
        }
      }
    }
  }
  return out;
}
