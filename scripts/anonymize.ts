// Общая санитизация эталонов-фикстур (аудит 65, A2). Детерминированно заменяет
// внутренние ID сайта на синтетические и пишет фикстуру с полем _source.
// Используется scripts/probe-normalize.ts и миграцией scripts/sanitize-ui-refs.ts.
import { writeFile } from "node:fs/promises";

/** Внутренний ID сайта: подчёркивание + 5 символов, опционально суффикс `_<число>`. */
export const EDITOR_ID_RE = /^_[a-z0-9]{5}(?:_\d+)?$/;

export interface AnonymizeResult {
  data: unknown;
  /** исходный ID → синтетический (id1, id2, … в порядке обхода) */
  map: Map<string, string>;
}

/**
 * Регистрирует все ID (значения полей `id`-подобных строк и ключи-объектов) одним
 * обходом, затем возвращает копию структуры, где каждый ID заменён на
 * `prefix<номер>`. Порядок обхода — порядок ключей JSON, поэтому замена
 * детерминирована для одного и того же входного файла.
 */
export function anonymizeEditorIds(root: unknown, prefix = "id"): AnonymizeResult {
  const map = new Map<string, string>();
  const claim = (raw: string): string => {
    if (!EDITOR_ID_RE.test(raw)) return raw;
    if (!map.has(raw)) map.set(raw, `${prefix}${map.size + 1}`);
    return map.get(raw)!;
  };
  const register = (v: unknown): void => {
    if (typeof v === "string") {
      claim(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) register(x);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        claim(k);
        register(val);
      }
    }
  };
  register(root);
  const rewrite = (v: unknown): unknown => {
    if (typeof v === "string") return map.get(v) ?? v;
    if (Array.isArray(v)) return v.map(rewrite);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[map.get(k) ?? k] = rewrite(val);
      return out;
    }
    return v;
  };
  return { data: rewrite(root), map };
}

/** Числовой ID проекта/плана → "0" (конвенция обезличивания этого репозитория). */
export function anonymizeProjectIds(copy: Record<string, unknown>): Record<string, unknown> {
  const out = { ...copy };
  for (const k of ["id", "plan_id"]) {
    if (typeof out[k] === "string" && /^\d+$/.test(out[k] as string)) out[k] = "0";
  }
  return out;
}

/** Пишет фикстуру: _source первым ключом, затем данные. Возвращает размер файла. */
export async function writeFixture(path: string, data: unknown, source: string): Promise<number> {
  const body = JSON.stringify({ _source: source, ...(data as Record<string, unknown>) }, null, 2);
  await writeFile(path, body + "\n");
  return Buffer.byteLength(body + "\n");
}
