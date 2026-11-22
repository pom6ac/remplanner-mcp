import type { VerificationMismatches } from "./types.ts";
import { socketLayerNum } from "../model/electric.ts";

/**
 * Состав и пользовательские свойства под-розеток socket_group (ревью 90 R1,
 * 92 R1a/R1b): число под-розеток, id, тип (name), высота установки группы
 * (over_floor.value, см) и слой вертикального блока (props.layer, 2/3 —
 * электрика ч.3; ревью 371 №3). Производная геометрия (center, real_center,
 * vd, id_wall) до save НЕ сверяется: редактор легитимно пересчитывает её при
 * нормализации (магнит к стене, перенос/удаление стены). Если ожидается
 * числовой over_floor.value — его наличие и равенство обязательны (R1b);
 * совпадающее отсутствие необязательного поля на обеих сторонах — не расхождение.
 */
export type SubsItemSig = {
  socket_group?: Array<{ name?: string; id?: string }>;
  over_floor?: unknown;
  /** Электрика ч.3: слой вертикального блока (2/3; null/отсутствие — у стены). */
  layer?: number | string | null;
};

export function socketGroupSubsUserMismatches(
  expected: Record<string, SubsItemSig>,
  got: Record<string, unknown>,
): VerificationMismatches {
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
    // ревью 371 №3: слой — пользовательское поле, сверяется двусторонне (появился
    // или пропал — расхождение), и до save тоже (локальная модель против normalize:
    // если нормализатор уронил слой, потеря не проходит с verified=true)
    const el = socketLayerNum(it.layer);
    const gl = socketLayerNum((g as { layer?: unknown } | undefined)?.layer);
    if (el !== null && el >= 2) {
      if (gl === null || gl < 2) out.push(`${itemId}: слой вертикального блока потерялся после сохранения (ожидался ${el})`);
      else if (gl !== el) out.push(`${itemId}: слой вертикального блока изменился (на сервере ${gl}; ожидался ${el})`);
    } else if (el === null && gl !== null && gl >= 2) {
      out.push(`${itemId}: на сервере появился слой вертикального блока ${gl}, в ожидании слоя нет`);
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
): VerificationMismatches {
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
