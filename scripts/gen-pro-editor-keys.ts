// Генератор обезличенного списка is_pro-ключей редактора (задача 332, ревью 331 Н1/Н2):
// единый источник данных для PRO-гейта src/server/pro.ts. Список НЕ дописывается
// руками по разделам — перегенерируется этой командой из эталона разметки:
//   node scripts/gen-pro-editor-keys.ts [<путь к 328-pro-anon.json>]
// Эталон: .orca-reports/tmp/328-pro-anon.json в КОРНЕВОМ репо — разметка
// анонимного проекта (бесплатный тариф, design §4), снята пробой
// scripts/probes/328-pro-anon.ts (этап 328); только ключи plannertool_* с
// классом is_pro, без ID, заголовков и прочего ПДн. Путь эталона можно передать
// аргументом (по умолчанию — корневой tmp по git-common-dir, ревью 333 Р2:
// эвристика «предок с .orca-reports» перехватывалась каталогом в ~ или
// ~/projects). В заголовок сгенерированного файла пишется относительный путь
// эталона (ревью 333 Р2: абсолютный путь с домашним каталогом унёс бы в git
// то, что ищет скан ПДн).
// Пишет src/server/pro-editor-keys.generated.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gitRepoRoot } from "../src/repo-root.ts";

const root = gitRepoRoot(import.meta.dirname);
const tmp = root !== null ? join(root, ".orca-reports", "tmp") : null;
const etalonPath = process.argv[2] ?? (tmp !== null ? join(tmp, "328-pro-anon.json") : "");
if (!etalonPath || !existsSync(etalonPath)) {
  console.error(`эталон не найден: ${etalonPath || "(путь не передан)"} — стоп`);
  process.exit(1);
}
const parsed = JSON.parse(readFileSync(etalonPath, "utf8")) as { pro?: unknown; _source?: unknown };
const raw = Array.isArray(parsed.pro) ? parsed.pro : [];
const keys = [...new Set(raw.filter((k): k is string => typeof k === "string"))].sort();
if (keys.length < 500) {
  console.error(`эталон подозрительно мал (${keys.length} ключей) — не похож на разметку 328 — стоп`);
  process.exit(1);
}
// ревью 333 Р2: в заголовок — только относительный путь эталона (от корня репо);
// если эталон вне репо — только имя файла. Даты нет: перегенерация без изменений
// не даёт дифф.
const etalonRef = root !== null && !relative(root, etalonPath).startsWith("..")
  ? relative(root, etalonPath).replaceAll("\\", "/")
  : existsSync(etalonPath) ? etalonPath.split("/").pop()! : etalonPath;
const out = `// СГЕНЕРИРОВАНО scripts/gen-pro-editor-keys.ts — не править руками.
// Источник: ${etalonRef} (этап 328, разметка анонимного проекта = бесплатный
// тариф, design §4; снята пробой scripts/probes/328-pro-anon.ts, ПДн нет —
// только ключи plannertool_* с классом is_pro). Ключи сохраняются как в
// разметке редактора, ВКЛЮЧАЯ ОПЕЧАТКИ редактора (пробел в «pumping _station»,
// кириллическая «с» в начале «сhest_freezer_two_tier»/«сlay_sump»/
// «сontrol_scales», дефисы): каталог сравнивается с гейтом точно, править их
// здесь нельзя (ревью 333 Р5).
// Полный список is_pro-ключей редактора — единый источник для PRO-гейта
// (src/server/pro.ts, assertProPartialAllowed; ревью 331 Н1/Н2).
export const PRO_EDITOR_KEYS: readonly string[] = [
${keys.map((k) => `  "${k}",`).join("\n")}
] as const;
`;
const outPath = join(import.meta.dirname, "..", "src", "server", "pro-editor-keys.generated.ts");
writeFileSync(outPath, out);
console.error(`${outPath}: ${keys.length} ключей из ${etalonPath}`);
