// Сторож DTO-слоя (аудит 65 C4, задача 187-c4 п.4; ревью 188 №1): src/dto — чистый
// слой преобразований editor↔public. Запрещены runtime-импорты server/, workspace,
// сети и браузера (api/http/browser/session/login/catalog/render/editor/config);
// type-only импорты допустимы (verbatimModuleSyntax: они исчезают в рантайме).
// Путь цели импорта считается от src (а не от каталога файла), иначе "../server/x.ts"
// даёт "../server/x.ts" и не совпадает ни с одним шаблоном FORBIDDEN.
// Ревью 190 N2: регулярка ограничена одним оператором (до `;`) и видит
// side-effect `import "../server/x.ts"`, динамический `import("../server/x.ts")`
// и одинарные кавычки.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dtoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "dto");
const saveDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "save");
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

// Запрещённые runtime-зависимости save-оркестрации (194-fix-c2s, ревью 193 №8):
// сервер и workspace (workspace и так импортирует src/save, обратное — цикл).
const FORBIDDEN_SAVE = [/^server\//, /^workspace\.ts$/];

/** Один оператор import/export (лениво до `;`), кавычки одинарные или двойные. */
const RE_STMT = /(?:^|[;\n])(import|export)\b([^;]*?)from\s*(["'])(\.[^"']+)\3/g;
/** Side-effect импорт без from: import "../server/x.ts". */
const RE_SIDE_EFFECT = /(?:^|[;\n])import\s*(["'])(\.[^"']+)\1/g;
/** Динамический импорт: import("../server/x.ts"). */
const RE_DYNAMIC = /\bimport\s*\(\s*(["'])(\.[^"']+)\1\s*\)/g;

/** Цели runtime-импортов одного файла: обычные, side-effect и динамические. */
export function runtimeImportTargets(code: string): string[] {
  const targets: string[] = [];
  for (const m of code.matchAll(RE_STMT)) {
    if (/^\s*type\b/.test(m[2]!)) continue; // import type / export type — стираются
    targets.push(m[4]!);
  }
  for (const m of code.matchAll(RE_SIDE_EFFECT)) targets.push(m[2]!);
  for (const m of code.matchAll(RE_DYNAMIC)) targets.push(m[2]!);
  return targets;
}

type SourceFile = { name: string; dir: string; code: string };

/** Нарушения в наборе файлов: цель импорта — путь от src относительно dir файла. */
function violationsOf(files: SourceFile[], forbidden: RegExp[] = FORBIDDEN, why = "DTO не зависит от сервера, workspace, сети и браузера"): string[] {
  const violations: string[] = [];
  for (const { name, dir, code } of files) {
    for (const target of runtimeImportTargets(code)) {
      const resolved = relative(srcDir, resolve(dir, target))!;
      if (forbidden.some((re) => re.test(resolved))) {
        violations.push(`${name}: runtime-импорт "${target}" (${why})`);
      }
    }
  }
  return violations;
}

const synthetic = (name: string, code: string): SourceFile => ({ name, dir: dtoDir, code });

test("src/dto: нет runtime-импортов server/workspace/сети/браузера (сторож 187-c4)", () => {
  const files = collect(dtoDir).map((f) => ({
    name: relative(dtoDir, f)!,
    dir: dirname(f),
    code: readFileSync(f, "utf8"),
  }));
  assert.deepEqual(violationsOf(files), [], `запрещённые импорты в src/dto:\n${violationsOf(files).join("\n")}`);
});

test("src/save: нет runtime-импортов server/workspace (сторож 194-fix-c2s, ревью 193 №8)", () => {
  const files = collect(saveDir).map((f) => ({
    name: relative(saveDir, f)!,
    dir: dirname(f),
    code: readFileSync(f, "utf8"),
  }));
  const violations = violationsOf(files, FORBIDDEN_SAVE, "save-оркестрация не зависит от сервера и workspace (workspace импортирует src/save, обратное — цикл)");
  assert.deepEqual(violations, [], `запрещённые импорты в src/save:\n${violations.join("\n")}`);
});

test("сторож ловит запрещённые импорты (самотест ревью 188 №1)", () => {
  // синтетические тексты как будто из src/dto: каждый запрещённый вид ловится
  const violations = violationsOf([
    synthetic("s1.ts", `import { x } from "../server/x.ts";\n`),
    synthetic("s2.ts", `import { Workspace } from "../workspace.ts";\n`),
    synthetic("s3.ts", `import * as B from "../browser.ts";\n`),
    synthetic("s4.ts", `import { get } from "../http.ts";\n`),
    synthetic("s5.ts", `import { api } from "../api.ts";\n`),
    // разрешённый импорт внутри dto — не нарушение
    synthetic("ok1.ts", `import { mm } from "./units.ts";\n`),
    // type-only импорт исчезает в рантайме — допустим
    synthetic("ok2.ts", `import type { Model } from "../server/unknown.ts";\n`),
  ]);
  assert.equal(violations.length, 5, `ожидались 5 нарушений, получено: ${JSON.stringify(violations, null, 1)}`);
  assert.match(violations[0]!, /s1\.ts: runtime-импорт "\.\.\/server\/x\.ts"/);
  assert.match(violations[1]!, /"\.\.\/workspace\.ts"/);
  assert.match(violations[2]!, /"\.\.\/browser\.ts"/);
  assert.match(violations[3]!, /"\.\.\/http\.ts"/);
  assert.match(violations[4]!, /"\.\.\/api\.ts"/);
});

// Ревью 190 N2: формы импорта, которые прежняя регулярка пропускала.
test("сторож ловит side-effect, динамический импорт и одинарные кавычки (самотест ревью 190 N2)", () => {
  const violations = violationsOf([
    synthetic("se.ts", `import "../server/x.ts";\n`),
    synthetic("dyn.ts", `const m = await import("../server/x.ts");\n`),
    synthetic("sq.ts", `import { x } from '../server/x.ts';\n`),
    // type-only из server по-прежнему допустим, нерелятивный type-импорт не
    // проглатывает следующий runtime-импорт (ревью 182 №1 — та же ошибка парсера)
    // type-only из server допустим, но нерелятивный type-импорт не проглатывает
    // следующий runtime-импорт (та же ошибка парсера, что в ревью 182 №1)
    synthetic("ok3.ts", `import type { Stats } from "node:fs";\nimport { x } from "../server/x.ts";\n`),
  ]);
  assert.equal(violations.length, 4, `ожидались 4 нарушения, получено: ${JSON.stringify(violations, null, 1)}`);
  assert.match(violations[0]!, /se\.ts.*"\.\.\/server\/x\.ts"/);
  assert.match(violations[1]!, /dyn\.ts.*"\.\.\/server\/x\.ts"/);
  assert.match(violations[2]!, /sq\.ts.*"\.\.\/server\/x\.ts"/);
  assert.match(violations[3]!, /ok3\.ts.*"\.\.\/server\/x\.ts"/);
});
