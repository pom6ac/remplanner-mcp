import type { Model, Wall, Hole, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import { holeRange, holeOffsetCm, replacementPairOf } from "./openings.ts";
import { McpError } from "../errors.ts";

// Раздел «Перепланировка» (этап 103): демонтаж — лист break_walls редактора.
// Демонтаж — это пометки для строителей на стене/проёме (план «до/после»), а не удаление:
// стена остаётся в модели с флагами; rooms2 редактор перестраивает при save, а не при
// normalize (живая проба p135-n1, анонимный проект, ревью 133 N1).
// Эталоны tests/fixtures/ui-ref-replan-demolition.json (клики UI, анонимный проект):
//   - стена целиком: `demount:1` + `p1.demount:1` + `p2.demount:1` (setDemount очищает sectors);
//   - участок: `sectors[sid] = {id, pc (центр на оси, см), width (см)}`;
//   - проём: `holes[hid].demount = 1`;
//   - отмена демонтажа: те же поля обнуляются/удаляются.
// UI не демонтирует перегородки (plan:"c"), балконные ограждения и проёмы с заменой
// (hasReplacement) — пробы 103-replan-fixtures2/extra.

/** Материалы перегородок листа create_walls: пункты UI → коды модели (эталон ui-ref-replan-partitions). */
export const PARTITION_MATERIALS = {
  pgb: "c_pgb",
  foam_block: "c_block",
  brick: "c_brick",
  gypsum: "c_gypsum",
  // PRO-пункты (is_pro в разметке редактора, проба 103-replan-scout): на бесплатном
  // тарифе и анонимных проектах запись запрещена (NOT_AVAILABLE_ON_TARIFF)
  glass: "c_glass",
  bar: "c_bar",
} as const;

export type PartitionMaterial = keyof typeof PARTITION_MATERIALS;

export const PARTITION_PRO_MATERIALS: ReadonlySet<string> = new Set(["glass", "bar"]);

/** Обратная карта: канонический код c_* → публичный ключ (ревью 105 R6). */
const CODE_TO_KEY: Record<string, PartitionMaterial> = Object.fromEntries(
  Object.entries(PARTITION_MATERIALS).map(([key, code]) => [code, key as PartitionMaterial]),
);

/**
 * Нормализация материала перегородки к публичному ключу (ревью 105 R6): строгий
 * whitelist СВОИХ ключей (pgb, foam_block, …) и канонических кодов (c_pgb, …) —
 * только собственные свойства (Object.hasOwn, «constructor» не проходит), без
 * приёма произвольных c_*-строк. PRO-гейт в инструментах проверяется по
 * нормализованному ключу: c_glass проходит тот же гейт, что и glass.
 */
export function partitionMaterialKey(material: string | undefined): PartitionMaterial {
  if (material === undefined) return "pgb";
  if (Object.hasOwn(PARTITION_MATERIALS, material)) return material as PartitionMaterial;
  if (Object.hasOwn(CODE_TO_KEY, material)) return CODE_TO_KEY[material]!;
  if (/^a_/.test(material)) {
    throw new McpError("INVALID_ARGUMENT", `материал «${material}» — материал исходных стен, у перегородок листа «Перегородки» свои материалы`, {
      hint: `для kind=partition используйте: ${Object.keys(PARTITION_MATERIALS).join(", ")} (или код c_*)`,
      details: { kind: "partition_material_invalid", material },
    });
  }
  throw new McpError("INVALID_ARGUMENT", `неизвестный материал перегородки: ${material}`, {
    hint: `доступны: ${Object.keys(PARTITION_MATERIALS).join(", ")}`,
    details: { kind: "partition_material_invalid", material },
  });
}

/** Код материала для kind=partition; material — публичный ключ или канонический код c_* (строгий enum). */
export function partitionMaterialCode(material: string | undefined): string {
  return PARTITION_MATERIALS[partitionMaterialKey(material)];
}

export type DemolishParams = {
  target: "wall" | "opening";
  id: string;
  /** Участок стены: отступ от края и длина, мм (без — демонтаж целиком). */
  range?: { from: "start" | "end"; offset_mm: number; length_mm: number };
};

export type DemolishCancelParams = {
  target: "wall" | "opening";
  id: string;
  /** Отмена демонтажа одного участка (sectors[sid]); без — отмена всей стены. */
  sector_id?: string;
};

function wallOf(model: Model, id: string): Wall {
  const wall = model.walls[id];
  if (!wall) {
    throw new McpError("NOT_FOUND", `стена ${id} не найдена`, {
      hint: "id стены — site_id из model_get",
      details: { kind: "wall_not_found", wall_id: id },
    });
  }
  return wall;
}

function assertDemolishable(wall: Wall): void {
  if (wall.plan === "c") {
    throw new McpError("INVALID_ARGUMENT", `стена ${wall.id} — перегородка (plan:c), демонтаж в UI не применяется к перегородкам`, {
      hint: "перегородку можно удалить целиком (wall_delete) или заменить (нужна новая перегородка поверх)",
      details: { kind: "demolish_partition", wall_id: wall.id },
    });
  }
  if (wall.role === "balcony" || wall.role === "terrace_fence") {
    throw new McpError("INVALID_ARGUMENT", `стена ${wall.id} — ограждение (${wall.role}), демонтаж не применяется`, {
      hint: "ограждение удаляется целиком (wall_delete)",
      details: { kind: "demolish_fence", wall_id: wall.id },
    });
  }
}

function holeOf(wall: Wall, holeId: string): Hole {
  const hole = (wall.holes ?? {})[holeId];
  if (!hole) {
    throw new McpError("NOT_FOUND", `проём ${holeId} не найден на стене ${wall.id}`, {
      details: { kind: "hole_not_found", wall_id: wall.id, hole_id: holeId },
    });
  }
  return hole;
}

function axisLength(wall: Wall): number {
  return Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
}

/**
 * Развёрнута ли ось стены относительно канонического направления (ревью 129 C1):
 * нормализатор редактора может поменять p1/p2 местами, физическая стена та же.
 * Каноническое направление — лексикографически большее (p1 → p2 «вправо-вниз»).
 */
function axisIsReversed(wall: Wall): boolean {
  return wall.p2.x < wall.p1.x || (wall.p2.x === wall.p1.x && wall.p2.y < wall.p1.y);
}

/**
 * Канонический осевой отрезок стены (ревью 129 C2): направление приведено к
 * каноническому, координаты вдоль оси — в мировых величинах (см). Стена,
 * переименованная нормализатором, узнаётся по геометрии оси в любом направлении.
 */
function axisSegmentOf(wall: Wall): { ux: number; uy: number; offset: number; a: number; b: number } | null {
  const dx = wall.p2.x - wall.p1.x;
  const dy = wall.p2.y - wall.p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  let ux = dx / len;
  let uy = dy / len;
  if (uy < 0 || (uy === 0 && ux < 0)) {
    ux = -ux;
    uy = -uy;
  }
  const offset = -uy * wall.p1.x + ux * wall.p1.y;
  const t1 = wall.p1.x * ux + wall.p1.y * uy;
  const t2 = wall.p2.x * ux + wall.p2.y * uy;
  return { ux, uy, offset, a: Math.min(t1, t2), b: Math.max(t1, t2) };
}

const SEG_TOL_CM = 0.5;

function axisSegmentsMatch(s1: { ux: number; uy: number; offset: number; a: number; b: number }, s2: { ux: number; uy: number; offset: number; a: number; b: number }): boolean {
  return Math.abs(s1.ux - s2.ux) <= 1e-6 && Math.abs(s1.uy - s2.uy) <= 1e-6 &&
    Math.abs(s1.offset - s2.offset) <= SEG_TOL_CM &&
    Math.abs(s1.a - s2.a) <= SEG_TOL_CM && Math.abs(s1.b - s2.b) <= SEG_TOL_CM;
}

/** Есть ли на стене хоть одна пометка демонтажа (стена/узлы/участки/проёмы/замена). */
function hasDemolitionMarks(wall: Wall): boolean {
  if (wall.demount === 1 || wall.p1.demount === 1 || wall.p2.demount === 1) return true;
  if (Object.keys(sectorsOf(wall)).length > 0) return true;
  for (const h of Object.values(wall.holes ?? {})) {
    if (h.demount === 1 || h.hasReplacement) return true;
  }
  return false;
}

function sectorsOf(wall: Wall): Record<string, { id: string; pc: Point; width: number }> {
  const s = wall.sectors as Record<string, { id: string; pc: Point; width: number }> | undefined;
  return s ?? {};
}

/** Интервалы оси стены (см), занятые секторами и проёмами. */
function busyIntervals(wall: Wall): Array<[number, number]> {
  const len = axisLength(wall);
  const out: Array<[number, number]> = [];
  for (const s of Object.values(sectorsOf(wall))) {
    const t = (s.pc.x - wall.p1.x) * (len > 0 ? (wall.p2.x - wall.p1.x) / len : 0)
      + (s.pc.y - wall.p1.y) * (len > 0 ? (wall.p2.y - wall.p1.y) / len : 0);
    out.push([Math.max(0, t - s.width / 2), Math.min(len, t + s.width / 2)]);
  }
  for (const h of Object.values(wall.holes ?? {})) {
    // ревью 105 R7: holeRange для всех проёмов — и с at, и без (UI-модель держит
    // только pc; прежняя ветка с проверкой typeof h.at пропускала такие проёмы)
    const [lo, hi] = holeRange(wall, h);
    out.push([lo, hi]);
  }
  return out;
}

/**
 * demolish: демонтаж стены целиком, участка (range) или проёма (этап 103).
 * Атомарность обеспечивает обёртка atomic(): при ошибке модель не меняется.
 */
export function demolish(model: Model, params: DemolishParams): { wallId: string; sectorId?: string; holeId?: string } {
  if (params.target === "wall") {
    const wall = wallOf(model, params.id);
    assertDemolishable(wall);
    const len = axisLength(wall);
    if (len < 1e-6) {
      throw new McpError("INVALID_ARGUMENT", `стена ${wall.id} нулевой длины`, {
        details: { kind: "wall_zero_length", wall_id: wall.id },
      });
    }
    if (params.range === undefined) {
      // целиком: setDemount редактора сбрасывает участки
      wall.demount = 1;
      wall.p1.demount = 1;
      wall.p2.demount = 1;
      delete wall.sectors;
      return { wallId: wall.id };
    }
    // участок
    const off = mmToCm(params.range.offset_mm);
    const width = mmToCm(params.range.length_mm);
    if (!Number.isFinite(off) || !Number.isFinite(width) || width <= 0) {
      throw new McpError("INVALID_ARGUMENT", "range.offset_mm и range.length_mm должны быть конечными числами, length_mm > 0", {
        details: { kind: "range_invalid", range: params.range },
      });
    }
    const from = params.range.from ?? "start";
    const a = from === "start" ? off : len - off - width;
    const b = a + width;
    if (a < -0.01 || b > len + 0.01) {
      throw new McpError("INVALID_ARGUMENT", `участок выходит за пределы стены (стена ${Math.round(len * 10)} мм)`, {
        details: { kind: "range_outside_wall", wall_id: wall.id, from_cm: r2(a), to_cm: r2(b), wall_len_cm: r2(len) },
      });
    }
    if (width < 1) {
      throw new McpError("INVALID_ARGUMENT", "участок короче 10 мм — редактор такой участок не строит", {
        details: { kind: "range_too_short", length_mm: params.range.length_mm },
      });
    }
    for (const [lo, hi] of busyIntervals(wall)) {
      if (a < hi - 0.05 && b > lo + 0.05) {
        throw new McpError("INVALID_ARGUMENT", "участок демонтажа пересекает проём или другой участок демонтажа", {
          details: { kind: "range_overlap", wall_id: wall.id, busy_from_cm: r2(lo), busy_to_cm: r2(hi) },
        });
      }
    }
    const u = len > 0 ? { x: (wall.p2.x - wall.p1.x) / len, y: (wall.p2.y - wall.p1.y) / len } : { x: 1, y: 0 };
    const pc = { x: r2(wall.p1.x + u.x * (a + width / 2)), y: r2(wall.p1.y + u.y * (a + width / 2)) };
    const sectors = sectorsOf(wall);
    const sid = newId(10);
    sectors[sid] = { id: sid, pc, width: r2(width) };
    wall.sectors = sectors;
    return { wallId: wall.id, sectorId: sid };
  }
  // проём
  for (const wall of Object.values(model.walls)) {
    const hole = (wall.holes ?? {})[params.id];
    if (!hole) continue;
    if (hole.hasReplacement) {
      throw new McpError("INVALID_ARGUMENT", `проём ${hole.id} уже заменён проёмом листа «Перегородки» (hasReplacement) — демонтаж замены выполняется удалением нового проёма`, {
        details: { kind: "hole_replaced", wall_id: wall.id, hole_id: hole.id },
      });
    }
    if (hole.plan === "c") {
      throw new McpError("INVALID_ARGUMENT", `проём ${hole.id} — проём листа «Перегородки» (plan:c), он не демонтируется`, {
        hint: "проём plan:c удаляется (opening_delete) или заменяется",
        details: { kind: "hole_plan_c", wall_id: wall.id, hole_id: hole.id },
      });
    }
    hole.demount = 1;
    return { wallId: wall.id, holeId: hole.id };
  }
  throw new McpError("NOT_FOUND", `проём ${params.id} не найден ни на одной стене`, {
    details: { kind: "hole_not_found", hole_id: params.id },
  });
}

/**
 * demolish_cancel: отмена демонтажа стены/участка/проёма (эталон remove_break:
 * demount=0, p1/p2.demount=0, участок удаляется из sectors).
 */
export function demolishCancel(model: Model, params: DemolishCancelParams): { wallId: string; sectorId?: string; holeId?: string } {
  if (params.target === "wall") {
    const wall = wallOf(model, params.id);
    if (params.sector_id !== undefined) {
      const sectors = sectorsOf(wall);
      // ревью 129 C3: только собственные свойства — «toString»/«constructor» не проходят
      if (!Object.hasOwn(sectors, params.sector_id)) {
        throw new McpError("NOT_FOUND", `участок демонтажа ${params.sector_id} не найден на стене ${wall.id}`, {
          details: { kind: "sector_not_found", wall_id: wall.id, sector_id: params.sector_id },
        });
      }
      delete sectors[params.sector_id];
      if (Object.keys(sectors).length === 0) delete wall.sectors;
      else wall.sectors = sectors;
      return { wallId: wall.id, sectorId: params.sector_id };
    }
    if (!wall.demount && Object.keys(sectorsOf(wall)).length === 0) {
      throw new McpError("INVALID_ARGUMENT", `стена ${wall.id} не демонтирована`, {
        details: { kind: "not_demolished", wall_id: wall.id },
      });
    }
    wall.demount = 0;
    wall.p1.demount = 0;
    wall.p2.demount = 0;
    delete wall.sectors;
    return { wallId: wall.id };
  }
  for (const wall of Object.values(model.walls)) {
    const hole = (wall.holes ?? {})[params.id];
    if (!hole) continue;
    if (hole.demount !== 1) {
      throw new McpError("INVALID_ARGUMENT", `проём ${hole.id} не демонтирован`, {
        details: { kind: "not_demolished", wall_id: wall.id, hole_id: hole.id },
      });
    }
    hole.demount = 0;
    return { wallId: wall.id, holeId: hole.id };
  }
  throw new McpError("NOT_FOUND", `проём ${params.id} не найден ни на одной стене`, {
    details: { kind: "hole_not_found", hole_id: params.id },
  });
}

export type DemolitionHoleSig = {
  demount: number | undefined;
  /** Ревью 105 R5: семантика пары замены входит в сверку. */
  hasReplacement: number | undefined;
  /** Свойства замены — проём plan:c с parent = id этой стены и тем же центром. */
  replacement?: { type: string; width: number; height: number | undefined; center: number };
};

export type DemolitionSig = {
  demount: number | undefined;
  p1_demount: number | undefined;
  p2_demount: number | undefined;
  /** Участки {центр на оси, ширина}, см, отсортированы по центру — id сектора редактор может пересоздать. */
  sectors: Array<{ t: number; width: number }>;
  holes: Record<string, DemolitionHoleSig>;
};

/**
 * Замена проёма hole (ревью 108 R4): единое правило пары с openings — связь по
 * parent/hasReplacement (план:c, parent = id стены), центр только выбирает между
 * несколькими парами на стене (replacementPairOf).
 */
export function replacementOf(wall: Wall, hole: Hole): Hole | null {
  return replacementPairOf(wall, hole);
}

/**
 * Семантический снимок демонтажа стены (id секторов исключены — редактор их пересоздаёт).
 * Ревью 129 C1: инвариантен к направлению оси — разворот p1/p2 нормализатором не
 * меняет снимок: участки и центр замены приводятся к каноническому направлению
 * (t → len−t у развёрнутой стены). tShiftCm — сдвиг начала оси при сопоставлении
 * со слитой коллинеарной стеной (ревью 133 N3): прежняя ось начинается дальше
 * от начала слитой.
 */
export function demolitionSignature(wall: Wall, tShiftCm = 0): DemolitionSig {
  const len = axisLength(wall);
  const ux = len > 0 ? (wall.p2.x - wall.p1.x) / len : 1;
  const uy = len > 0 ? (wall.p2.y - wall.p1.y) / len : 0;
  const rev = axisIsReversed(wall);
  const canon = (t: number) => (rev ? len - t : t) + tShiftCm;
  const sectors = Object.values(sectorsOf(wall))
    .map((s) => {
      const t = (s.pc.x - wall.p1.x) * ux + (s.pc.y - wall.p1.y) * uy;
      return { t: canon(t), width: s.width };
    })
    .sort((a, b) => a.t - b.t || a.width - b.width);
  const holes: Record<string, DemolitionHoleSig> = {};
  for (const [hid, h] of Object.entries(wall.holes ?? {})) {
    const sig: DemolitionHoleSig = {
      demount: h.demount === 1 ? 1 : undefined,
      hasReplacement: h.hasReplacement ? 1 : undefined,
    };
    // ревью 105 R5: ключевые свойства замены (type, размеры, позиция) — часть сверки.
    // Ревью 133 N2: центр замены — проекция мирового центра (pc) на ось, БЕЗ
    // служебного at: мировые координаты не зависят от направления оси, а нормализатор
    // при развороте p1/p2 может оставить at в старых координатах (ложное расхождение
    // «центр 1500 → 4500», проба P9)
    if (h.hasReplacement) {
      const rep = replacementOf(wall, h);
      if (rep) {
        sig.replacement = {
          type: rep.type,
          width: rep.width,
          height: rep.height,
          center: canon((rep.pc.x - wall.p1.x) * ux + (rep.pc.y - wall.p1.y) * uy),
        };
      }
    }
    holes[hid] = sig;
  }
  return {
    demount: wall.demount === 1 ? 1 : undefined,
    p1_demount: wall.p1.demount === 1 ? 1 : undefined,
    p2_demount: wall.p2.demount === 1 ? 1 : undefined,
    sectors,
    holes,
  };
}

const TOL_CM = 0.5;

/**
 * Сверка демонтажа (двухрежимная сверка этапа 103, как finishCompare):
 * до save (после normalize) и после save по GET — флаги демонтажа и участки обязаны
 * сохраниться; изменённый id сектора, перестроенные связи и производная геометрия
 * редактора блокировкой не считаются.
 * Ревью 129 C2: стену под прежним ID нормализатор может перенумеровать — пара ищется
 * по геометрии оси (как в guard R10, в любом направлении), один-к-одному; стена
 * с пометками демонтажа без пары — расхождение, а не пропуск.
  * редактора блокировкой не считаются.
  * Ревью 129 C2: стену под прежним ID нормализатор может перенумеровать — пара ищется
  * по геометрии оси (как в guard R10, в любом направлении); стена с пометками демонтажа
  * без пары — расхождение, а не пропуск.
  * Ревью 133 N5: сначала ВСЕ прямые совпадения по ID, геометрические — по оставшимся;
  * прямой ID принимается только при совместимой геометрии (точная ось или покрытие),
  * иначе ID перебирает чужую стену и сверка перестаёт быть один-к-одному.
  * Ревью 133 N3: редактор сливает коллинеарные стены (design §12) — если стена с
  * пометками не нашла пару по ID/точной оси, ищем after-стену, отрезок которой
  * ПОКРЫВАЕТ прежнюю ось (слитая стена). Слитая after-стена обслуживает ОБЕ
  * before-половины (группа слияния): участки и центры замен каждой части сверяются
  * со сдвигом начала оси, проёмы с demount переносятся слитой стеной с теми же id.
  */
export function demolitionMismatches(
  before: Record<string, Wall> | undefined,
  after: Record<string, Wall> | undefined,
): string[] {
  const problems: string[] = [];
  const b = before ?? {};
  const a = after ?? {};
  const usedAfter = new Set<string>();
  const pair = new Map<string, { wall: Wall; tShift: number }>();
  const deferred: string[] = [];
  const covers = (segA: NonNullable<ReturnType<typeof axisSegmentOf>>, segB: NonNullable<ReturnType<typeof axisSegmentOf>>): boolean =>
    Math.abs(segA.ux - segB.ux) <= 1e-6 && Math.abs(segA.uy - segB.uy) <= 1e-6 &&
    Math.abs(segA.offset - segB.offset) <= SEG_TOL_CM &&
    segA.a <= segB.a + SEG_TOL_CM && segA.b >= segB.b - SEG_TOL_CM;
  // проход 1: прямые совпадения по ID с совместимой геометрией (точная ось или
  // покрытие слитой стеной); ID с чужой геометрией — в отложенные
  for (const [id, wallB] of Object.entries(b)) {
    const direct = a[id];
    if (!direct) continue;
    const segB = axisSegmentOf(wallB);
    const segA = axisSegmentOf(direct);
    if (!segB || !segA) {
      pair.set(id, { wall: direct, tShift: 0 });
      usedAfter.add(id);
    } else if (axisSegmentsMatch(segB, segA)) {
      pair.set(id, { wall: direct, tShift: 0 });
      usedAfter.add(id);
    } else if (covers(segA, segB)) {
      pair.set(id, { wall: direct, tShift: segB.a - segA.a });
      usedAfter.add(id);
    } else {
      deferred.push(id);
    }
  }
  // проход 2: точное совпадение оси (смена ID, любое направление)
  for (const [id, wallB] of Object.entries(b)) {
    if (pair.has(id)) continue;
    const segB = axisSegmentOf(wallB);
    if (!segB) continue;
    for (const [aid, aw] of Object.entries(a)) {
      if (usedAfter.has(aid)) continue;
      const segA = axisSegmentOf(aw);
      if (segA && axisSegmentsMatch(segB, segA)) {
        usedAfter.add(aid);
        pair.set(id, { wall: aw, tShift: 0 });
        break;
      }
    }
  }
  // проход 3: покрытие — слитая коллинеарная стена содержит прежнюю ось; слитая
  // after-стена обслуживает ВСЕ покрытые before-части (группа слияния), поэтому
  // переиспользование after-стены здесь допустимо (сначала — свободные)
  for (const [id, wallB] of Object.entries(b)) {
    if (pair.has(id)) continue;
    const segB = axisSegmentOf(wallB);
    if (!segB) continue;
    let best: { wall: Wall; tShift: number } | null = null;
    for (const preferUnused of [true, false]) {
      for (const [aid, aw] of Object.entries(a)) {
        if (usedAfter.has(aid) === preferUnused) continue;
        const segA = axisSegmentOf(aw);
        if (segA && covers(segA, segB)) {
          best = { wall: aw, tShift: segB.a - segA.a };
          if (preferUnused) usedAfter.add(aid);
          break;
        }
      }
      if (best) break;
    }
    if (best) pair.set(id, best);
  }
  // отложенные: прямой ID, если after-стена так и не нашлась по геометрии
  for (const id of deferred) {
    if (pair.has(id)) continue;
    const direct = a[id];
    if (direct && !usedAfter.has(id)) {
      usedAfter.add(id);
      pair.set(id, { wall: direct, tShift: 0 });
    }
  }
  // группировка по after-стене: слитая стена обслуживает несколько before-частей
  const unpaired = new Set<string>();
  const groups = new Map<Wall, Array<{ id: string; wallB: Wall; tShift: number }>>();
  for (const [id, wallB] of Object.entries(b)) {
    const matched = pair.get(id);
    if (!matched) {
      unpaired.add(id);
      continue;
    }
    const list = groups.get(matched.wall) ?? [];
    list.push({ id, wallB, tShift: matched.tShift });
    groups.set(matched.wall, list);
  }
  for (const [wallA, list] of groups) {
    const sigA = demolitionSignature(wallA);
    const merge = list.length > 1;
    for (const { id, wallB, tShift } of list) {
      const sigB = demolitionSignature(wallB, tShift);
      if (sigB.demount !== sigA.demount) {
        problems.push(`wall ${id}: demount ${sigB.demount ?? 0} → ${sigA.demount ?? 0}`);
      }
      if (sigB.demount === 1) {
        if (sigB.p1_demount !== sigA.p1_demount || sigB.p2_demount !== sigA.p2_demount) {
          problems.push(`wall ${id}: p1/p2.demount потеряны при демонтаже целиком`);
        }
        // ревью 105 R5: при демонтаже целиком участки редактор сбрасывает сам (setDemount),
        // но пометки demount проёмов сверяются как обычно — continue только для участков
      } else if (merge) {
        // группа слияния: у каждой части сверяем её участки (со сдвигом оси) по вхождению;
        // лишние участки слитой стены — от соседних частей, не потеря
        for (const s1 of sigB.sectors) {
          const found = sigA.sectors.some((s2) => Math.abs(s1.t - s2.t) <= TOL_CM && Math.abs(s1.width - s2.width) <= TOL_CM);
          if (!found) {
            problems.push(`wall ${id}: участок демонтажа потерян при слиянии стен (${Math.round(s1.t * 10)}..+${Math.round(s1.width * 10)} мм)`);
          }
        }
      } else if (sigB.sectors.length !== sigA.sectors.length) {
        problems.push(`wall ${id}: участков демонтажа ${sigB.sectors.length} → ${sigA.sectors.length}`);
      } else {
        for (let i = 0; i < sigB.sectors.length; i++) {
          const s1 = sigB.sectors[i]!;
          const s2 = sigA.sectors[i]!;
          if (Math.abs(s1.t - s2.t) > TOL_CM || Math.abs(s1.width - s2.width) > TOL_CM) {
            // величины в мм (t/width в см × 10) — ревью 129 C6
            problems.push(`wall ${id}: участок демонтажа ${i} изменился (${Math.round(s1.t * 10)}..+${Math.round(s1.width * 10)} мм → ${Math.round(s2.t * 10)}..+${Math.round(s2.width * 10)} мм)`);
          }
        }
      }
      for (const [hid, h] of Object.entries(sigB.holes)) {
        // ревью 105 R5: отсутствующий ожидаемый проём — расхождение, а не пропуск;
        // ревью 129 C5: holes:null у серверной модели (T27) — не TypeError
        if ((wallA.holes ?? {})[hid] === undefined) {
          problems.push(`wall ${id}: проём ${hid} отсутствует после операции`);
          continue;
        }
        if ((h.demount ?? 0) !== (sigA.holes[hid]?.demount ?? 0)) {
          problems.push(`wall ${id}: проём ${hid}: demount ${h.demount ?? 0} → ${sigA.holes[hid]?.demount ?? 0}`);
        }
        if ((h.hasReplacement ?? 0) !== (sigA.holes[hid]?.hasReplacement ?? 0)) {
          problems.push(`wall ${id}: проём ${hid}: hasReplacement ${h.hasReplacement ?? 0} → ${sigA.holes[hid]?.hasReplacement ?? 0}`);
        }
        if (h.replacement || sigA.holes[hid]?.replacement) {
          const rep1 = h.replacement;
          const rep2 = sigA.holes[hid]?.replacement;
          if (!rep1 || !rep2) {
            problems.push(`wall ${id}: проём ${hid}: замена ${rep1 ? "потеряна на сервере" : "появилась при операции"}`);
          } else if (
            rep1.type !== rep2.type ||
            Math.abs(rep1.width - rep2.width) > TOL_CM ||
            ((rep1.height ?? undefined) !== (rep2.height ?? undefined) && Math.abs((rep1.height ?? 0) - (rep2.height ?? 0)) > TOL_CM) ||
            Math.abs(rep1.center - rep2.center) > TOL_CM
          ) {
            problems.push(`wall ${id}: проём ${hid}: свойства замены изменились (type ${rep1.type} → ${rep2.type}, ширина ${Math.round(rep1.width * 10)} → ${Math.round(rep2.width * 10)} мм, центр ${Math.round(rep1.center * 10)} → ${Math.round(rep2.center * 10)} мм)`);
          }
        }
      }
    }
  }
  for (const id of unpaired) {
    // потерю стены без пометок ловит общий слой (wallAxisSetsEqual); здесь —
    // только случай, когда пропали пометки демонтажа вместе со стеной
    if (hasDemolitionMarks(b[id]!)) {
      problems.push(`wall ${id}: стена с пометками демонтажа отсутствует после операции`);
    }
  }
  return problems;
}
