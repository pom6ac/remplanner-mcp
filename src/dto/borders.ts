import { throwNotFound } from "./common.ts";
import type { Model, TerraceBorder } from "../model/types.ts";

// DTO группы «терраса и участок»: разрешение ссылок границ и публичный вид
// границы (см модели → мм ответа).

/** Граница террасы/участка по site-id или метке TB<n>/XB<n> из model_get. */
export function resolveBorder(model: Model, key: "terrace_borders" | "territory_borders", label: string, ref: string): TerraceBorder {
  const borders = (model[key] ?? {}) as Record<string, TerraceBorder>;
  if (borders[ref]) return borders[ref]!;
  const m = new RegExp(`^${label}(\\d+)$`).exec(ref);
  if (m) {
    const list = Object.values(borders);
    const border = list[Number(m[1]) - 1];
    if (border) return border;
  }
  return throwNotFound(`граница ${ref} не найдена (id сайта или метка ${label}<n> из model_get)`);
}

/** Конец границы в публичном ответе: мм (ревью 68 №3 — как во всём MCP). */
function mmPointOf(p: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(p.x * 10), y: Math.round(p.y * 10) };
}

/** Граница для публичного ответа: концы в мм. */
export function borderResponse(b: TerraceBorder): { id: string; p1: { x: number; y: number }; p2: { x: number; y: number } } {
  return { id: b.id, p1: mmPointOf(b.p1), p2: mmPointOf(b.p2) };
}
