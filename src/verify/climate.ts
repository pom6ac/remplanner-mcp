import type { Model, WarmFloor } from "../model/types.ts";
import { warmFloorMismatches } from "../model/climate.ts";
import { CLIMATE_PIPE_KINDS, pipeLinkKey } from "../model/pipes.ts";
import { gasLineGraphMismatches, type GasLineSig } from "./graphs.ts";
import { pipeConnectionMismatches, type PipeLinkItem } from "./pipes.ts";
import { missingIds } from "./ids.ts";
import type { VerificationMismatches } from "./types.ts";

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
  for (const coll of climateColls) {
    const ws = structuredClone((local as Record<string, unknown>)[coll] ?? {}) as Record<string, GasLineSig>;
    const normColl = ((norm as Record<string, unknown>)[coll] ?? {}) as Record<string, unknown>;
    const lost = missingIds(new Set(Object.keys(ws)), new Set(Object.keys(normColl)));
    const graphNorm = gasLineGraphMismatches(structuredClone(ws), normColl, "труба климата");
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
    const onlyKeys = new Set(Object.values(CLIMATE_PIPE_KINDS).map((c) => pipeLinkKey(c.type)));
    const conn = pipeConnectionMismatches(
      mergeColls(local as unknown as Record<string, unknown>),
      opts.itemsExpected,
      mergeColls(norm),
      opts.itemsGot,
      { onlyKeys },
    );
    if (conn.length > 0) out.push(`подключения труб климата: ${JSON.stringify(conn)}`);
  }
  return out;
}
