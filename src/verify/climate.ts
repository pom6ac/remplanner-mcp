import type { Model, WarmFloor } from "../model/types.ts";
import { warmFloorMismatches } from "../model/climate.ts";
import { CLIMATE_PIPE_KINDS, PIPE_LINK_KEY_BY_TYPE, pipeLinkHolders } from "../model/pipes.ts";
import { gasLineGraphMismatches, type GasLineSig } from "./graphs.ts";
import { pipeConnectionMismatches, type PipeLinkItem } from "./pipes.ts";
import { missingIds } from "./ids.ts";
import type { VerificationMismatches } from "./types.ts";

/** Геометрия предметов-вершин для мягкой сверки длины (pc/width/height/angle, см). */
type ItemGeom = Record<string, { pc?: { x: number; y: number }; width?: number; height?: number; angle?: number }>;

function itemGeomOf(items: Record<string, unknown> | undefined): ItemGeom {
  const out: ItemGeom = {};
  for (const [id, it] of Object.entries(items ?? {})) {
    const rec = it as { pc?: { x: number; y: number }; width?: number; height?: number; angle?: number };
    if (rec && typeof rec === "object" && rec.pc && typeof rec.width === "number" && typeof rec.height === "number") {
      out[id] = { pc: rec.pc, width: rec.width, height: rec.height, angle: rec.angle };
    }
  }
  return out;
}

/**
 * Сверка сущностей климата (этап 122): контуры тёплого пола (model.warm_floors —
 * семантика контура: polygon, кольцо, узлы, площадь) и трубы климата
 * (pipes_warm_floor/pipes_conditioner/pipes_heat/pipes_ventilation — общий слой
 * газовых графов). Возвращает список человекочитаемых расхождений. Аргументы —
 * модели или их фрагменты (ожидание после save — фрагмент нормализованной модели).
 * Ревью 124 R1: mode normalize — привязка контуров к комнатам по геометрии
 * (ID комнат штатно регенерируется); save — строго. Ревью 124 R2: обратные ссылки
 * предметов на трубы климата сверяются в обе стороны (общий слой
 * pipeConnectionMismatches, только ключи климата — правила воды не переносятся).
 */
export function climateGraphMismatches(
  local: Model,
  norm: Record<string, unknown>,
  opts: {
    mode?: "normalize" | "save";
    roomsExpected?: Record<string, unknown>;
    roomsGot?: Record<string, unknown>;
    itemsExpected?: Record<string, PipeLinkItem>;
    itemsGot?: Record<string, PipeLinkItem>;
  } = {},
): VerificationMismatches {
  const out: string[] = [];
  const wfLost = missingIds(new Set(Object.keys(local.warm_floors ?? {})), new Set(Object.keys((norm as { warm_floors?: Record<string, unknown> }).warm_floors ?? {})));
  const wfMism = warmFloorMismatches(
    structuredClone(local.warm_floors ?? {}) as Record<string, WarmFloor>,
    (norm as { warm_floors?: Record<string, unknown> }).warm_floors ?? {},
    { mode: opts.mode ?? "save", roomsExpected: opts.roomsExpected, roomsGot: opts.roomsGot },
  );
  if (wfLost.length > 0 || wfMism.length > 0) {
    out.push(`контуры тёплого пола: потеряны ${JSON.stringify(wfLost)}; расхождения ${JSON.stringify(wfMism)}`);
  }
  const climateColls = ["pipes_warm_floor", "pipes_conditioner", "pipes_heat", "pipes_ventilation"] as const;
  // мягкая сверка вершин-предметов: редактор считает длину магистралей от точки
  // подключения на габарите (пробы 250-connect-heat), поэтому локальная точка
  // (центр предмета) отличается от расчётной длины. Но точка вершины-предмета
  // ХРАНИТСЯ как pc предмета (эталоны ui-ref-climate2-*: point = pc, pp — отдельное
  // производное поле) — ревью 251 №6: сверяем point с pc факта (itemPointMatchesPc),
  // длину — допустимым диапазоном
  const geom = itemGeomOf(opts.itemsGot ?? opts.itemsExpected);
  for (const coll of climateColls) {
    const ws = structuredClone((local as Record<string, unknown>)[coll] ?? {}) as Record<string, GasLineSig>;
    const normColl = ((norm as Record<string, unknown>)[coll] ?? {}) as Record<string, unknown>;
    const lost = missingIds(new Set(Object.keys(ws)), new Set(Object.keys(normColl)));
    const graphNorm = gasLineGraphMismatches(structuredClone(ws), normColl, "труба климата", true, geom, { itemPointMatchesPc: true });
    if (lost.length > 0 || graphNorm.length > 0) {
      out.push(`${coll}: потеряны ${JSON.stringify(lost)}; расхождения ${JSON.stringify(graphNorm)}`);
    }
  }
  if (opts.itemsExpected && opts.itemsGot) {
    const mergeColls = (src: Record<string, unknown>): Record<string, GasLineSig> => {
      const merged: Record<string, GasLineSig> = {};
      for (const coll of climateColls) Object.assign(merged, (src[coll] ?? {}) as Record<string, GasLineSig>);
      return merged;
    };
    const onlyTypes = new Set(Object.values(CLIMATE_PIPE_KINDS).map((c) => c.type));
    // держатели ссылок — общая проекция pipeLinkHolders (модель/фрагмент):
    // предметы, водяные контуры (вершина-контур магистрали хранит обратную
    // ссылку в props контура — climate ч.2) и отверстия стен ventHole
    // (вершина вентиляции держит ссылку в props отверстия — ревью 371 №5:
    // без отверстий в проекции потеря/добавление ссылки у ventHole не ловится)
    const holdersExpected = pipeLinkHolders({ ...(local as Model), items: (opts.itemsExpected ?? {}) as unknown as Model["items"] } as Model) as unknown as Record<string, PipeLinkItem>;
    const holdersGot = pipeLinkHolders({ ...(norm as unknown as Model), items: (opts.itemsGot ?? {}) as unknown as Model["items"] } as Model) as unknown as Record<string, PipeLinkItem>;
    const conn = pipeConnectionMismatches(
      mergeColls(local as unknown as Record<string, unknown>),
      holdersExpected,
      mergeColls(norm),
      holdersGot,
      { onlyTypes },
    );
    if (conn.length > 0) out.push(`подключения труб климата: ${JSON.stringify(conn)}`);
  }
  return out;
}
