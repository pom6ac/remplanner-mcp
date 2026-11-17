import type { Model, Wall, Hole, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import { holeRange, holeOffsetCm, replacementPairOf } from "./openings.ts";
import { McpError } from "../errors.ts";

// Раздел «Перепланировка» (этап 103): демонтаж — лист break_walls редактора.
// Демонтаж — это пометки для строителей на стене/проёме (план «до/после»), а не удаление:
// стена остаётся в модели с флагами, комнаты листа «c» редактор перестраивает сам при draw.
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
      if (!(params.sector_id in sectors)) {
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

/** Семантический снимок демонтажа стены (id секторов исключены — редактор их пересоздаёт). */
export function demolitionSignature(wall: Wall): DemolitionSig {
  const len = axisLength(wall);
  const ux = len > 0 ? (wall.p2.x - wall.p1.x) / len : 1;
  const uy = len > 0 ? (wall.p2.y - wall.p1.y) / len : 0;
  const sectors = Object.values(sectorsOf(wall))
    .map((s) => ({
      t: (s.pc.x - wall.p1.x) * ux + (s.pc.y - wall.p1.y) * uy,
      width: s.width,
    }))
    .sort((a, b) => a.t - b.t || a.width - b.width);
  const holes: Record<string, DemolitionHoleSig> = {};
  for (const [hid, h] of Object.entries(wall.holes ?? {})) {
    const sig: DemolitionHoleSig = {
      demount: h.demount === 1 ? 1 : undefined,
      hasReplacement: h.hasReplacement ? 1 : undefined,
    };
    // ревью 105 R5: ключевые свойства замены (type, размеры, позиция) — часть сверки
    if (h.hasReplacement) {
      const rep = replacementOf(wall, h);
      if (rep) {
        sig.replacement = {
          type: rep.type,
          width: rep.width,
          height: rep.height,
          center: holeOffsetCm(wall, rep) + rep.width / 2,
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
 */
export function demolitionMismatches(
  before: Record<string, Wall> | undefined,
  after: Record<string, Wall> | undefined,
): string[] {
  const problems: string[] = [];
  const b = before ?? {};
  const a = after ?? {};
  for (const [id, wallB] of Object.entries(b)) {
    const wallA = a[id];
    if (!wallA) continue; // потерю стены ловит общий слой (wallAxisSetsEqual)
    const sigB = demolitionSignature(wallB);
    const sigA = demolitionSignature(wallA);
    if (sigB.demount !== sigA.demount) {
      problems.push(`wall ${id}: demount ${sigB.demount ?? 0} → ${sigA.demount ?? 0}`);
    }
    if (sigB.demount === 1) {
      if (sigB.p1_demount !== sigA.p1_demount || sigB.p2_demount !== sigA.p2_demount) {
        problems.push(`wall ${id}: p1/p2.demount потеряны при демонтаже целиком`);
      }
      // ревью 105 R5: при демонтаже целиком участки редактор сбрасывает сам (setDemount),
      // но пометки demount проёмов сверяются как обычно — continue только для участков
    } else if (sigB.sectors.length !== sigA.sectors.length) {
      problems.push(`wall ${id}: участков демонтажа ${sigB.sectors.length} → ${sigA.sectors.length}`);
    } else {
      for (let i = 0; i < sigB.sectors.length; i++) {
        const s1 = sigB.sectors[i]!;
        const s2 = sigA.sectors[i]!;
        if (Math.abs(s1.t - s2.t) > TOL_CM || Math.abs(s1.width - s2.width) > TOL_CM) {
          problems.push(`wall ${id}: участок демонтажа ${i} изменился (${Math.round(s1.t * 10)}..+${Math.round(s1.width * 10)} см → ${Math.round(s2.t * 10)}..+${Math.round(s2.width * 10)} см)`);
        }
      }
    }
    for (const [hid, h] of Object.entries(sigB.holes)) {
      // ревью 105 R5: отсутствующий ожидаемый проём — расхождение, а не пропуск
      if (a[id]?.holes[hid] === undefined) {
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
  return problems;
}
