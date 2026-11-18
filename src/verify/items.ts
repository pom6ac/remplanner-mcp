import type { Point } from "../model/types.ts";
import type { VerificationMismatches } from "./types.ts";

/** Значимая геометрия/тип предмета для сверки после сохранения (этап 55, ревью №1). */
export type ItemSig = { name?: string; pc?: { x: number; y: number }; width?: number; height?: number; angle?: number };

/**
 * Расхождение предметов между нормализованной моделью и сервером после save (этап 55,
 * ревью №1): идентичности и тип/значимая геометрия (name, pc, width, height, angle;
 * допуск 0,1 см / 0,1°, угол — циклическая разность modulo 360). Возвращает список
 * человекочитаемых расхождений; пустой список — предметы сохранились.
 */
export function itemVerificationMismatches(expected: Record<string, ItemSig>, got: Record<string, unknown>): VerificationMismatches {
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
