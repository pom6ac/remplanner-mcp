import type { Point } from "../model/types.ts";
import type { VerificationMismatches } from "./types.ts";

/** Значимая геометрия ригеля для сверки после сохранения (этап 47). */
export type RigelSig = { p1?: Point; p2?: Point; depth?: number; height?: number; ceiling_type?: string };

/**
 * Расхождение ригелей между нормализованной моделью и сервером после save (этап 47):
 * идентичности и значимая геометрия (концы оси, толщина, высота, тип отделки;
 * допуск 0,1 см). Возвращает список человекочитаемых расхождений.
 */
export function rigelVerificationMismatches(expected: Record<string, RigelSig>, got: Record<string, unknown>): VerificationMismatches {
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
