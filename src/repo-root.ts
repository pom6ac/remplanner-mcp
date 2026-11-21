// Корень репо по git (ревью 331 Н6, ревью 333 Р2/Р3): `git rev-parse
// --git-common-dir` — общий каталог .git (в worktree указывает на основной
// репо), корень — его родитель. Общий модуль для probe-guard, генератора
// is_pro-ключей (scripts/gen-pro-editor-keys.ts) и сторожей юнит-тестов:
// эвристики «предок с .orca-reports»/«ближайший предок» убраны — такой каталог
// в ~ или ~/projects перехватывал бы эталоны. null — git недоступен (caller
// обязан отказать). Только локальный git через execFileSync, без shell.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

export function gitRepoRoot(cwd: string = import.meta.dirname): string | null {
  try {
    // ревью 335 n1: stderr подавлен — вне git `fatal: not a git repository`
    // не должен попадать в stderr процесса (пробы, генератор, тесты)
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!out) return null;
    return dirname(resolve(cwd, out));
  } catch {
    return null;
  }
}
