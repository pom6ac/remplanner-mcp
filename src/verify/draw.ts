import type { VerificationMismatches } from "./types.ts";

/**
 * Пользовательские поля нижней панели и листов (этап 375): пользовательские
 * листы (custom_plans), свободные линии (freelines), толстые линии
 * (thick_lines), фигуры (free_figures) и изображения (pictures). Сверка
 * двусторонняя: набор id в обе стороны + пользовательские поля; производная
 * геометрия (pc линий, area фигур) до save НЕ сверяется — редактор
 * досчитывает её при отрисовке. Позиции вершин и размеры — с допуском 0,1 см
 * (округление см модели). content листа сверяется как множество (редактор
 * собирает чекбоксы в порядке DOM).
 */

type SheetRec = {
  id?: string;
  name?: string;
  after_plan?: string;
  content?: string[];
  [key: string]: unknown;
};

export function sheetUserMismatches(
  expected: Record<string, SheetRec>,
  got: Record<string, unknown>,
): VerificationMismatches {
  const out: string[] = [];
  for (const [id, e] of Object.entries(expected)) {
    const g = got[id] as SheetRec | undefined;
    if (!g) {
      out.push(`${id}: пользовательский лист «${e.name ?? id}» потерян после сохранения`);
      continue;
    }
    if ((e.name ?? "") !== (g.name ?? "")) out.push(`${id}: имя листа изменилось (на сервере «${g.name ?? ""}»; ожидалось «${e.name ?? ""}»)`);
    if ((e.after_plan ?? "") !== (g.after_plan ?? "")) out.push(`${id}: after_plan изменился (на сервере «${g.after_plan ?? ""}»; ожидалось «${e.after_plan ?? ""}»)`);
    const ec = new Set(e.content ?? []);
    const gc = new Set((g.content ?? []) as string[]);
    for (const c of ec) if (!gc.has(c)) out.push(`${id}: content потерял «${c}» после сохранения`);
    for (const c of gc) if (!ec.has(c)) out.push(`${id}: в content появился «${c}» на сервере`);
  }
  for (const id of Object.keys(got)) {
    if (!(id in expected)) out.push(`${id}: на сервере появился пользовательский лист, в ожидании его нет`);
  }
  return out;
}

type DrawRec = {
  id?: string;
  type?: string;
  plan?: string;
  color_custom?: string;
  color?: string;
  width?: number;
  height?: number;
  angle?: number;
  url?: string;
  text?: string;
  font_size?: number;
  width_original?: number;
  height_original?: number;
  vertexes?: Array<{ point?: { x?: number; y?: number } }>;
  matrix?: Array<Array<{ length?: number; width?: number } | null>>;
  length?: number;
  [key: string]: unknown;
};

const near = (a: number | undefined, b: number | undefined, tol = 0.1): boolean =>
  a !== undefined && b !== undefined && Math.abs(a - b) <= tol;

/** Ломаная: последовательность вершин с допуском (редактор не переупорядочивает). */
function polylineMismatch(e: DrawRec, g: DrawRec, label: string): string[] {
  const out: string[] = [];
  const ev = e.vertexes ?? [];
  const gv = g.vertexes ?? [];
  if (ev.length !== gv.length) {
    out.push(`${label}: число вершин изменилось (ожидалось ${ev.length}, на сервере ${gv.length})`);
    return out;
  }
  for (let i = 0; i < ev.length; i++) {
    const p1 = ev[i]!.point;
    const p2 = gv[i]!.point;
    if (!near(p1?.x, p2?.x) || !near(p1?.y, p2?.y)) {
      out.push(`${label}: вершина ${i} сместилась (ожидалось ${p1?.x},${p1?.y}; на сервере ${p2?.x},${p2?.y})`);
    }
  }
  return out;
}

export function drawLineUserMismatches(
  expected: Record<string, DrawRec>,
  got: Record<string, unknown>,
  label: string,
): VerificationMismatches {
  const out: string[] = [];
  for (const [id, e] of Object.entries(expected)) {
    const g = got[id] as DrawRec | undefined;
    if (!g) {
      out.push(`${id}: ${label} потеряна после сохранения`);
      continue;
    }
    if ((e.type ?? "") !== (g.type ?? "")) out.push(`${id}: тип изменился (на сервере «${g.type ?? ""}»; ожидалось «${e.type ?? ""}»)`);
    if ((e.plan ?? "") !== (g.plan ?? "")) out.push(`${id}: лист изменился (на сервере «${g.plan ?? ""}»; ожидалось «${e.plan ?? ""}»)`);
    if ((e.color_custom ?? undefined) !== (g.color_custom ?? undefined)) out.push(`${id}: цвет изменился (ожидалось ${e.color_custom ?? "нет"}; на сервере ${g.color_custom ?? "нет"})`);
    out.push(...polylineMismatch(e, g, id));
    // индивидуальная ширина толстой линии — в ячейках matrix (ширины рёбер)
    const eW = lineEdgeWidth(e);
    const gW = lineEdgeWidth(g);
    if (eW !== undefined && (gW === undefined || Math.abs(eW - gW) > 0.1)) {
      out.push(`${id}: ширина линии изменилась (ожидалось ${eW} см; на сервере ${gW ?? "нет"})`);
    }
  }
  for (const id of Object.keys(got)) {
    if (!(id in expected)) out.push(`${id}: на сервере появилась лишняя ${label}`);
  }
  return out;
}

function lineEdgeWidth(r: DrawRec): number | undefined {
  for (const row of r.matrix ?? []) {
    for (const cell of row) {
      if (cell && typeof (cell as { width?: unknown }).width === "number") return (cell as { width: number }).width;
    }
  }
  return undefined;
}

export function figureUserMismatches(
  expected: Record<string, DrawRec>,
  got: Record<string, unknown>,
): VerificationMismatches {
  const out: string[] = [];
  for (const [id, e] of Object.entries(expected)) {
    const g = got[id] as DrawRec | undefined;
    if (!g) {
      out.push(`${id}: фигура «${e.type ?? id}» потеряна после сохранения`);
      continue;
    }
    if ((e.type ?? "") !== (g.type ?? "")) out.push(`${id}: тип изменился (на сервере «${g.type ?? ""}»; ожидалось «${e.type ?? ""}»)`);
    if ((e.plan ?? "") !== (g.plan ?? "")) out.push(`${id}: лист изменился (на сервере «${g.plan ?? ""}»; ожидалось «${e.plan ?? ""}»)`);
    const epc = (e as { pc?: { x?: number; y?: number } }).pc;
    const gpc = (g as { pc?: { x?: number; y?: number } }).pc;
    if (!near(epc?.x, gpc?.x) || !near(epc?.y, gpc?.y)) out.push(`${id}: центр сместился (ожидалось ${epc?.x},${epc?.y}; на сервере ${gpc?.x},${gpc?.y})`);
    if (!near(e.width, g.width) || !near(e.height, g.height)) out.push(`${id}: размеры изменились (ожидалось ${e.width}×${e.height}; на сервере ${g.width}×${g.height})`);
    if (e.angle !== undefined && !near(e.angle, g.angle, 0.5)) out.push(`${id}: угол изменился (ожидалось ${e.angle}; на сервере ${g.angle})`);
    if ((e.color ?? undefined) !== (g.color ?? undefined)) out.push(`${id}: цвет изменился (ожидалось ${e.color ?? "нет"}; на сервере ${g.color ?? "нет"})`);
  }
  for (const id of Object.keys(got)) {
    if (!(id in expected)) out.push(`${id}: на сервере появилась лишняя фигура`);
  }
  return out;
}

export function pictureUserMismatches(
  expected: Record<string, DrawRec>,
  got: Record<string, unknown>,
): VerificationMismatches {
  const out: string[] = [];
  for (const [id, e] of Object.entries(expected)) {
    const g = got[id] as DrawRec | undefined;
    if (!g) {
      out.push(`${id}: изображение «${e.url ?? id}» потеряно после сохранения`);
      continue;
    }
    if ((e.url ?? "") !== (g.url ?? "")) out.push(`${id}: url изменился (ожидалось «${e.url ?? ""}»; на сервере «${g.url ?? ""}»)`);
    if ((e.plan ?? "") !== (g.plan ?? "")) out.push(`${id}: лист изменился (на сервере «${g.plan ?? ""}»; ожидалось «${e.plan ?? ""}»)`);
    const epc = (e as { pc?: { x?: number; y?: number } }).pc;
    const gpc = (g as { pc?: { x?: number; y?: number } }).pc;
    if (!near(epc?.x, gpc?.x) || !near(epc?.y, gpc?.y)) out.push(`${id}: центр сместился (ожидалось ${epc?.x},${epc?.y}; на сервере ${gpc?.x},${gpc?.y})`);
    if (!near(e.width, g.width) || !near(e.height, g.height)) out.push(`${id}: размеры изменились (ожидалось ${e.width}×${e.height}; на сервере ${g.width}×${g.height})`);
    if ((e.text ?? undefined) !== (g.text ?? undefined)) out.push(`${id}: подпись изменилась (ожидалось «${e.text ?? ""}»; на сервере «${g.text ?? ""}»)`);
    if (e.width_original !== undefined && !near(e.width_original, g.width_original, 0.5)) out.push(`${id}: ширина исходника изменилась (ожидалось ${e.width_original}; на сервере ${g.width_original})`);
    if (e.height_original !== undefined && !near(e.height_original, g.height_original, 0.5)) out.push(`${id}: высота исходника изменилась (ожидалось ${e.height_original}; на сервере ${g.height_original})`);
  }
  for (const id of Object.keys(got)) {
    if (!(id in expected)) out.push(`${id}: на сервере появилось лишнее изображение`);
  }
  return out;
}
