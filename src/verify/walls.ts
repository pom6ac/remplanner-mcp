import type { Point } from "../model/types.ts";
import { wallAxisSegments, type WallAxisSegment } from "../model/walls.ts";
import type { VerificationMismatches } from "./types.ts";

/**
 * Ось стены покрыта локальными стенами (ревью v0.1.1 финал F-1): отрезок оси стены
 * лежит на той же прямой, что и какой-то локальный осевой отрезок, и целиком внутри
 * него (с допуском 1 мм). Смена идентификатора стены при нормализации редактора
 * геометрию не меняет — это не потеря.
 */
export function wallAxisCoveredBy(wall: { p1: Point; p2: Point } | undefined, localSegments: WallAxisSegment[], tolCm = 0.1): boolean {
  if (!wall) return false;
  const segs = wallAxisSegments({ w: wall });
  if (segs.length === 0) return false;
  return segs.every((s) =>
    localSegments.some(
      (t) =>
        Math.abs(t.ux - s.ux) <= 1e-6 && Math.abs(t.uy - s.uy) <= 1e-6 &&
        Math.abs(t.offset - s.offset) <= tolCm &&
        t.a <= s.a + tolCm && t.b >= s.b - tolCm,
    ),
  );
}

/**
 * Роли стен после нормализации/save (ревью 66 №3): ограждение террасы, ставшее
 * обычной стеной, геометрию не меняет — сверяется role у стен с совпадающей
 * геометрией. Стена с тем же id — role обязана совпасть; у стены с новым id
 * (переименование нормализацией) role сравнивается с геометрически совпадающей
 * ожидаемой стеной.
 */
export function wallRoleMismatches(
  expected: Record<string, { role?: string; p1: Point; p2: Point }>,
  got: Record<string, { role?: string; p1: Point; p2: Point }>,
): VerificationMismatches {
  const out: string[] = [];
  const segOf = (w: { p1: Point; p2: Point }): WallAxisSegment[] => wallAxisSegments({ w });
  const covers = (a: { p1: Point; p2: Point }, b: { p1: Point; p2: Point }): boolean => {
    const segsA = segOf(a);
    const segsB = segOf(b);
    return segsA.length > 0 && segsA.every((s) =>
      segsB.some((t) =>
        Math.abs(t.ux - s.ux) <= 1e-6 && Math.abs(t.uy - s.uy) <= 1e-6 &&
        Math.abs(t.offset - s.offset) <= 0.1 && t.a <= s.a + 0.1 && t.b >= s.b - 0.1,
      ),
    );
  };
  for (const [id, g] of Object.entries(got)) {
    const e = expected[id];
    if (e) {
      if ((g.role ?? "") !== (e.role ?? "")) {
        out.push(`${id}: role изменилась (на сервере «${g.role ?? ""}»; ожидалось «${e.role ?? ""}»)`);
      }
      continue;
    }
    // переименование: ищем ожидаемую стену с той же геометрией оси
    const renamed = Object.entries(expected).find(([, e]) => (e.role ?? "") !== (g.role ?? "") && (covers(g, e) || covers(e, g)));
    if (renamed) {
      out.push(`${id}: role изменилась (на сервере «${g.role ?? ""}»; ожидалось «${renamed[1].role ?? ""}» у ${renamed[0]})`);
    }
  }
  return out;
}

/**
 * Значимые свойства балконного ограждения для сверки (ревью 73 №2, 75 №2): ось нужна
 * для геометрического сопоставления, остальные поля сверяются у каждой части.
 */
export type BalconyWallProps = { role?: string; p1: Point; p2: Point; height?: number; depth?: number; material?: string };

/**
 * Свойства балконных ограждений после нормализации/save (ревью 73 №2, переоткрыто
 * ревью 75 №2): сверка не по совпадению id, а по геометрическому покрытию оси —
 * каждая ожидаемая ограда сопоставляется с частями на другой стороне, коллинеарными
 * и перекрывающими её ось (rename, split, merge), и height/depth/material сверяются
 * у каждой части. Частично испорченная новая часть после split и переименованная
 * ограда с изменённым height не проходят молча. Округление редактора (до сотых см)
 * не расхождение (допуск 0,1 см). Ограда, не покрытая ни одной оградой другой
 * стороны, — расхождение. Возвращает человекочитаемые расхождения; пустой список —
 * совпало.
 */
export function balconyWallPropertyMismatches(
  expected: Record<string, BalconyWallProps>,
  got: Record<string, BalconyWallProps>,
): VerificationMismatches {
  const out: string[] = [];
  const near = (a: number | undefined, b: number | undefined): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= 0.1;
  const segsOf = (w: { p1: Point; p2: Point }): WallAxisSegment[] => wallAxisSegments({ w });
  /** Коллинеарное перекрытие осевых отрезков (направление может быть отражено). */
  const overlaps = (s: WallAxisSegment, t: WallAxisSegment): boolean => {
    const same = Math.abs(s.ux - t.ux) <= 1e-6 && Math.abs(s.uy - t.uy) <= 1e-6;
    const opp = Math.abs(s.ux + t.ux) <= 1e-6 && Math.abs(s.uy + t.uy) <= 1e-6;
    if (!same && !opp) return false;
    const ta = same ? t.a : -t.b;
    const tb = same ? t.b : -t.a;
    const toff = same ? t.offset : -t.offset;
    if (Math.abs(s.offset - toff) > 0.1) return false;
    return Math.min(s.b, tb) - Math.max(s.a, ta) > 0.1;
  };
  const gotSegs = new Map<string, WallAxisSegment[]>();
  for (const [gid, g] of Object.entries(got)) {
    if (g.role !== "balcony") continue;
    const segs = segsOf(g);
    if (segs.length > 0) gotSegs.set(gid, segs);
  }
  for (const [id, e] of Object.entries(expected)) {
    if (e.role !== "balcony") continue;
    const eSegs = segsOf(e);
    if (eSegs.length === 0) continue;
    const parts = [...gotSegs.keys()].filter((gid) =>
      gotSegs.get(gid)!.some((t) => eSegs.some((s) => overlaps(s, t))),
    );
    if (parts.length === 0) {
      out.push(`${id}: ограждение не найдено на сервере (ось не покрыта ни одной оградой)`);
      continue;
    }
    for (const gid of parts) {
      const g = got[gid]!;
      const where = gid === id ? id : `${id} → ${gid}`;
      if (!near(g.height, e.height)) {
        out.push(`${where}: height изменилась (на сервере ${g.height}; ожидалось ${e.height})`);
      }
      if (!near(g.depth, e.depth)) {
        out.push(`${where}: depth изменилась (на сервере ${g.depth}; ожидалось ${e.depth})`);
      }
      if ((g.material ?? "") !== (e.material ?? "")) {
        out.push(`${where}: material изменился (на сервере «${g.material ?? ""}»; ожидалось «${e.material ?? ""}»)`);
      }
    }
  }
  return out;
}
