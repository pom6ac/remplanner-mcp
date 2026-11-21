// Генератор обезличенного списка is_pro-ключей редактора (задача 332, ревью 331 Н1/Н2):
// единый источник данных для PRO-гейта src/server/pro.ts. Список НЕ дописывается
// руками по разделам — перегенерируется этой командой из эталона разметки:
//   node scripts/gen-pro-editor-keys.ts [<путь к 328-pro-anon.json>]
// Эталон: .orca-reports/tmp/328-pro-anon.json — разметка анонимного
// проекта (бесплатный тариф, design §4), снята пробой scripts/probes/328-pro-anon.ts
// (этап 328); только ключи plannertool_* с классом is_pro, без ID, заголовков и
// прочего ПДн. Путь эталона можно передать аргументом (по умолчанию — ближайший
// каталог-предок с .orca-reports/tmp). Пишет src/server/pro-editor-keys.generated.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function findRootReportsTmp(from: string): string | null {
  let found: string | null = null;
  let dir = from;
  for (;;) {
    const prev = dir;
    const candidate = join(dir, ".orca-reports", "tmp");
    try {
      if (existsSync(candidate)) found = candidate;
    } catch { /* нет каталога на этом уровне */ }
    dir = join(dir, "..");
    if (dir === prev) break;
  }
  return found;
}

const tmp = findRootReportsTmp(import.meta.dirname);
const etalonPath = process.argv[2] ?? (tmp !== null ? join(tmp, "328-pro-anon.json") : "");
if (!etalonPath || !existsSync(etalonPath)) {
  console.error(`эталон не найден: ${etalonPath || "(путь не передан)" } — стоп`);
  process.exit(1);
}
const parsed = JSON.parse(readFileSync(etalonPath, "utf8")) as { pro?: unknown; _source?: unknown };
const raw = Array.isArray(parsed.pro) ? parsed.pro : [];
const keys = [...new Set(raw.filter((k): k is string => typeof k === "string"))].sort();
if (keys.length < 500) {
  console.error(`эталон подозрительно мал (${keys.length} ключей) — не похож на разметку 328 — стоп`);
  process.exit(1);
}
const out = `// СГЕНЕРИРОВАНО scripts/gen-pro-editor-keys.ts — не править руками.
// Источник: .orca-reports/tmp/328-pro-anon.json (${etalonPath}; этап 328,
// разметка анонимного проекта = бесплатный тариф, design §4; снята пробой
// scripts/probes/328-pro-anon.ts, ПДн нет — только ключи plannertool_* с
// классом is_pro). Дата генерации: ${new Date().toISOString().slice(0, 10)}.
// Полный список is_pro-ключей редактора — единый источник для PRO-гейта
// (src/server/pro.ts, assertProPartialAllowed; ревью 331 Н1/Н2).
export const PRO_EDITOR_KEYS: readonly string[] = [
${keys.map((k) => `  "${k}",`).join("\n")}
] as const;
`;
const outPath = join(import.meta.dirname, "..", "src", "server", "pro-editor-keys.generated.ts");
writeFileSync(outPath, out);
console.error(`${outPath}: ${keys.length} ключей из ${etalonPath}`);
