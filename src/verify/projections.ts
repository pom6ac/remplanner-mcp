import type { PrsFigureEntity } from "../model/projections.ts";
import type { VerificationMismatches } from "./types.ts";

/**
 * Сверка молдингов/ниш развёрток после save (этап 389) — семантическая
 * мультимножеством (один-к-одному): ключ — тип, комната (алиас по каноническому
 * полигону комнат), ребро, pc_xd/pc_yd (позиция на развёртке), размеры,
 * depth/width_line, on_size. pc и id НЕ входят: pc — кэш рамки развёрток
 * (редактор пересчитывает при каждой перерисовке развёрток), сопоставление
 * мультимножеством устойчиво к переупорядочиванию и переименованию id.
 */
export function prsFigureUserMismatches(
  expected: { rooms?: Record<string, Record<string, unknown>>; coll?: Record<string, PrsFigureEntity> },
  got: { rooms?: Record<string, Record<string, unknown>>; coll?: Record<string, unknown> },
  title: string,
): VerificationMismatches {
  const out: string[] = [];
  const alias = (rooms: Record<string, Record<string, unknown>> | undefined): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [rid, r] of Object.entries(rooms ?? {})) {
      out.set(rid, canonPoly(r["polygon"] ?? r["points"]) || rid);
    }
    return out;
  };
  const aliasE = alias(expected.rooms);
  const aliasG = alias(got.rooms);
  const keyOf = (rec: PrsFigureEntity, aliases: Map<string, string>): string => {
    const prs = (rec.prs ?? {}) as Record<string, unknown>;
    return JSON.stringify({
      type: rec.type ?? null,
      room: typeof prs["room"] === "string" ? (aliases.get(prs["room"]) ?? prs["room"]) : null,
      edge: typeof prs["edge_index"] === "number" ? prs["edge_index"] : null,
      pc_xd: typeof prs["pc_xd"] === "number" ? Math.round(prs["pc_xd"] * 10) / 10 : null,
      pc_yd: typeof prs["pc_yd"] === "number" ? Math.round(prs["pc_yd"] * 10) / 10 : null,
      width: typeof rec.width === "number" ? Math.round(rec.width * 10) / 10 : null,
      height: typeof rec.height === "number" ? Math.round(rec.height * 10) / 10 : null,
      depth: typeof rec.depth === "number" ? Math.round(rec.depth * 10) / 10 : null,
      width_line: typeof rec.width_line === "number" ? Math.round(rec.width_line * 10) / 10 : null,
      on_size: rec.on_size ?? null,
    });
  };
  const want = new Map<string, number>();
  for (const e of Object.values(expected.coll ?? {})) {
    const k = keyOf(e, aliasE);
    want.set(k, (want.get(k) ?? 0) + 1);
  }
  const have = new Map<string, number>();
  for (const g of Object.values(got.coll ?? {})) {
    const k = keyOf(g as PrsFigureEntity, aliasG);
    have.set(k, (have.get(k) ?? 0) + 1);
  }
  for (const [k, n] of want) {
    const h = have.get(k) ?? 0;
    if (h < n) {
      out.push(`${title}: потеряна запись после сохранения (${k}; на сервере ${h} из ${n})`);
    }
  }
  for (const [k, n] of have) {
    const w = want.get(k) ?? 0;
    if (w < n) {
      out.push(`${title}: на сервере лишняя запись (${k}; на сервере ${n}, ожидалось ${w})`);
    }
  }
  return out;
}

/** Канонический контур комнаты (полигональный алиас, как в probe-sig). */
function canonPoly(poly: unknown): string {
  if (!Array.isArray(poly)) return "";
  const pts = (poly as Array<{ x?: unknown; y?: unknown }>)
    .filter((p) => typeof p?.x === "number" && typeof p?.y === "number")
    .map((p) => ({ x: Math.round((p.x as number) * 10) / 10, y: Math.round((p.y as number) * 10) / 10 }));
  if (pts.length === 0) return "";
  let min = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]!.x < pts[min]!.x || (pts[i]!.x === pts[min]!.x && pts[i]!.y < pts[min]!.y)) min = i;
  }
  return pts.map((p) => `${p.x},${p.y}`).join(";") + `#${min}`;
}

/**
 * Сверка настроек развёрток (prs_hidden/prs_disabled/prs_first) комнат до/после
 * save — по семантике «развёртка ребра комнаты» (edge_index): oid перегенерируется
 * редактором при каждой перерисовке развёрток и при изменении нарезки рёбер.
 * При изменении числа рёбер/развёрток комнаты (wall-операция) редактор переносит
 * настройки по геометрии (restorePrsChangeEdges) — сверка пропускается
 * (консервативно: потерю настроек на wall-операции сверка не ловит).
 */
export function prsSettingsMismatches(
  before: Record<string, Record<string, unknown>> | undefined,
  after: Record<string, Record<string, unknown>> | undefined,
): VerificationMismatches {
  const out: string[] = [];
  const b = before ?? {};
  const a = after ?? {};
  for (const [rid, rb] of Object.entries(b)) {
    const ra = a[rid];
    if (!ra) continue;
    const edgesB = Array.isArray(rb["edges_prs"]) ? (rb["edges_prs"] as unknown[]).length : 0;
    const edgesA = Array.isArray(ra["edges_prs"]) ? (ra["edges_prs"] as unknown[]).length : 0;
    if (edgesB !== edgesA) continue;
    const hidB = rb["prs_hidden"] === 1;
    const hidA = ra["prs_hidden"] === 1;
    if (hidB !== hidA) {
      out.push(`${rid}: скрытие развёрток изменилось после сохранения (ожидалось ${hidB ? "скрыты" : "показаны"}; на сервере ${hidA ? "скрыты" : "показаны"})`);
    }
    const disB = disabledEdgesOf(rb);
    const disA = disabledEdgesOf(ra);
    if (disB.join(",") !== disA.join(",")) {
      out.push(`${rid}: набор скрытых развёрток изменился после сохранения (ожидалось [${disB.join(",")}]; на сервере [${disA.join(",")}])`);
    }
    const firstB = firstEdgeOf(rb);
    const firstA = firstEdgeOf(ra);
    if (firstB !== firstA) {
      out.push(`${rid}: «первая» развёртка изменилась после сохранения (ожидалось ребро ${firstB ?? "авто"}; на сервере ребро ${firstA ?? "авто"})`);
    }
  }
  return out;
}

function disabledEdgesOf(room: Record<string, unknown>): number[] {
  const disabled = room["prs_disabled"];
  if (!disabled || typeof disabled !== "object" || Array.isArray(disabled)) return [];
  const oids = new Set(Object.keys(disabled as Record<string, unknown>));
  const out: number[] = [];
  const edgesPrs = Array.isArray(room["edges_prs"]) ? (room["edges_prs"] as Array<Record<string, unknown>>) : [];
  for (const e of edgesPrs) {
    if (typeof e["oid"] === "string" && oids.has(e["oid"]) && typeof e["edge_index"] === "number") out.push(e["edge_index"]);
  }
  return out.sort((x, y) => x - y);
}

function firstEdgeOf(room: Record<string, unknown>): number | null {
  const first = room["prs_first"];
  if (typeof first !== "string" || first === "") return null;
  const edgesPrs = Array.isArray(room["edges_prs"]) ? (room["edges_prs"] as Array<Record<string, unknown>>) : [];
  const e = edgesPrs.find((x) => x["oid"] === first);
  return e && typeof e["edge_index"] === "number" ? e["edge_index"] : null;
}
