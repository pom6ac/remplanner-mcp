import type { Point } from "../model/types.ts";
import { WS_ALL_SPOTS } from "../model/waterspots.ts";
import type { VerificationMismatches } from "./types.ts";

/** Значимая геометрия/тип предмета для сверки после сохранения (этап 55, ревью №1). */
export type ItemSig = {
  name?: string; pc?: { x: number; y: number }; width?: number; height?: number; angle?: number;
  /** Ревью 364 №4: высоты выводов воды сверяются после save (value/value_2). */
  over_floor?: { value?: unknown; value_2?: unknown; display?: unknown } | null;
  /** Электрика ч.3: слой вертикального блока пристенной электрики (2/3; null —
   *  слой у стены). Ожидание (нормализатор) с числом 2/3, которого нет на
   *  сервере, — потеря; серверное значение сверяется по равенству. */
  layer?: number | string | null;
};

/**
 * Расхождение предметов между нормализованной моделью и сервером после save (этап 55,
 * ревью №1): идентичности и тип/значимая геометрия (name, pc, width, height, angle;
 * допуск 0,1 см / 0,1°, угол — циклическая разность modulo 360). Ревью 364 №4: у
 * выводов воды (WS_ALL_SPOTS) сверяются over_floor.value и value_2 — наличие каждого
 * поля отдельно, значения с допуском; сравнение только если ОБЕ стороны выводят
 * over_floor объектом (null/отсутствие — редактор поле не пишет, не расхождение).
 * Возвращает список человекочитаемых расхождений; пустой список — предметы сохранились.
 */
export function itemVerificationMismatches(expected: Record<string, ItemSig>, got: Record<string, unknown>): VerificationMismatches {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined, tol: number): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
  const angleDiff = (a: number, b: number): number => {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
  };
  const numOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
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
    // электрика ч.3: слой вертикального блока — строго, если ожидание несёт слой 2/3
    // (наличие поля отдельно от значения: потеря слоя 2/3 после save — расхождение)
    if (typeof it.layer === "number" && it.layer >= 2) {
      if (g.layer === undefined || g.layer === null) out.push(`${id}: слой вертикального блока потерялся после сохранения (ожидался ${it.layer})`);
      else if (Number(g.layer) !== it.layer) out.push(`${id}: слой вертикального блока изменился (на сервере ${g.layer}; ожидался ${it.layer})`);
    }
    if (WS_ALL_SPOTS.has(it.name ?? "")) {
      const ofE = it.over_floor ?? undefined;
      const ofG = g.over_floor ?? undefined;
      // строго только если обе стороны выводят over_floor объектом (ревью 364 №4)
      if (ofE && typeof ofE === "object" && ofG && typeof ofG === "object") {
        const ve = numOf(ofE.value);
        const vg = numOf(ofG.value);
        if (ve !== undefined && vg !== undefined && !near(ve, vg, 0.1)) {
          out.push(`${id}: высота over_floor.value изменилась (на сервере ${vg}; ожидалось ${ve})`);
        }
        const v2e = numOf(ofE.value_2);
        const v2g = numOf(ofG.value_2);
        if (v2e !== undefined && v2g === undefined) out.push(`${id}: высота канализации over_floor.value_2 потерялась после сохранения`);
        else if (v2e !== undefined && v2g !== undefined && !near(v2e, v2g, 0.1)) out.push(`${id}: высота over_floor.value_2 изменилась (на сервере ${v2g}; ожидалось ${v2e})`);
      }
    }
  }
  return out;
}
