// Сторож DTO-слоя (аудит 65 C4, задача 187-c4 п.4; ревью 188 №1): src/dto — чистый
// слой преобразований editor↔public. Запрещены runtime-импорты server/, workspace,
// сети и браузера (api/http/browser/session/login/catalog/render/editor/config);
// type-only импорты допустимы (verbatimModuleSyntax: они исчезают в рантайме).
// Путь цели импорта считается от src (а не от каталога файла), иначе "../server/x.ts"
// даёт "../server/x.ts" и не совпадает ни с одним шаблоном FORBIDDEN.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dtoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "dto");
const srcDir = resolve(dtoDir, "..");

function collect(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

// Запрещённые runtime-зависимости DTO-слоя: сервер, workspace, сеть, браузер.
const FORBIDDEN = [
  /^server\//, /^workspace\.ts$/, /^api\.ts$/, /^http\.ts$/, /^browser\.ts$/,
  /^session\.ts$/, /^login\.ts$/, /^catalog\.ts$/, /^render\.ts$/, /^editor\//,
  /^config\.ts$/, /^credentials\.ts$/, /^fs-safe\.ts$/, /^cli\.ts$/, /^server\.ts$/,
];

const RE = /(?:^|\n)(import|export)([\s\S]*?)from\s*"(\.[^"]+)"/g;

type SourceFile = { name: string; dir: string; code: string };

/** Нарушения в наборе файлов: цель импорта — путь от src относительно dir файла. */
function violationsOf(files: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const { name, dir, code } of files) {
    for (const m of code.matchAll(RE)) {
      const kw = m[1]!;
      const body = m[2]!;
      const target = relative(srcDir, resolve(dir, m[3]!))!;
      const isTypeImport = kw === "import" && /^\s*type\b/.test(body);
      if (isTypeImport) continue;
      if (FORBIDDEN.some((re) => re.test(target))) {
        violations.push(`${name}: runtime-импорт "${m[3]}" (DTO не зависит от сервера, workspace, сети и браузера)`);
      }
    }
  }
  return violations;
}

const inDto = (name: string, code: string): SourceFile => ({ name, dir: dtoDir, code });

test("src/dto: нет runtime-импортов server/workspace/сети/браузера (сторож 187-c4)", () => {
  const files = collect(dtoDir).map((f) => ({
    name: relative(dtoDir, f)!,
    dir: dirname(f),
    code: readFileSync(f, "utf8"),
  }));
  assert.deepEqual(violationsOf(files), [], `запрещённые импорты в src/dto:\n${violationsOf(files).join("\n")}`);
});

test("сторож ловит запрещённые импорты (самотест ревью 188 №1)", () => {
  // синтетические тексты как будто из src/dto: каждый запрещённый вид ловится
  const synthetic = (code: string): SourceFile => ({ name: "synthetic.ts", dir: dtoDir, code });
  const violations = violationsOf([
    synthetic(`import { x } from "../server/x.ts";\n`),
    synthetic(`import { Workspace } from "../workspace.ts";\n`),
    synthetic(`import * as B from "../browser.ts";\n`),
    synthetic(`import { get } from "../http.ts";\n`),
    synthetic(`import { api } from "../api.ts";\n`),
    // разрешённый импорт внутри dto — не нарушение
    synthetic(`import { mm } from "./units.ts";\n`),
    // type-only импорт исчезает в рантайме — допустим
    synthetic(`import type { Model } from "../server/unknown.ts";\n`),
  ]);
  assert.equal(violations.length, 5, `ожидались 5 нарушений, получено: ${JSON.stringify(violations, null, 1)}`);
  assert.match(violations[0]!, /synthetic\.ts: runtime-импорт "\.\.\/server\/x\.ts"/);
  assert.match(violations[1]!, /"\.\.\/workspace\.ts"/);
  assert.match(violations[2]!, /"\.\.\/browser\.ts"/);
  assert.match(violations[3]!, /"\.\.\/http\.ts"/);
  assert.match(violations[4]!, /"\.\.\/api\.ts"/);
});
