import type { Point } from "../model/types.ts";
import type { VerificationMismatches } from "./types.ts";

/** Значимая геометрия колонны для сверки после сохранения (ревью 43 №2);
 *  ревью 66 №3: role тоже значима — террасный столб, ставший обычной колонной,
 *  не проходит как «verified». */
export type PillarSig = { pc?: { x: number; y: number }; width?: number; height?: number; angle?: number; role?: string };

/**
 * Расхождение колонн между рабочей копией и сервером после save (ревью 43 №2):
 * идентичности и значимая геометрия (pc, width, height, angle; допуск 0,1 см / 0,1°).
 * Угол — циклическая разность modulo 360 (ревью 44 №6): эквивалентная нормализация
 * 360°→0° не расхождение. Возвращает список человекочитаемых расхождений; пустой
 * список — колонны сохранились.
 */
export function pillarVerificationMismatches(expected: Record<string, PillarSig>, got: Record<string, unknown>): VerificationMismatches {
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
