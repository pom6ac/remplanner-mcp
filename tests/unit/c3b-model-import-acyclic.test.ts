// Тест-сторож (аудит 65, C3 / этап 181-c3b; ревью 182 №1, ревью 185 №4): парсит
// runtime-импорты src/model, src/save (194-fix-c2s, ревью 193 №8) и src/verify
// и краснеет при появлении цикла или запрещённой зависимости.
// Без новых зависимостей — только node:fs/node:path.
// Runtime-импорт: `import …`, side-effect `import "./x.ts"`, динамический
// `import("./x.ts")` и реэкспорт `export … from` (не `import type`/`export type`).
// Смешанный `import { type X }` без `import type` считается runtime: verbatimModuleSyntax,
// node strip-types сохраняет такой импорт в рантайме.
// Ревью 182 №1: разбор ограничен одним оператором (до `;`), чтобы type-импорт из
// нерелятивного модуля не «проглатывал» следующий runtime-импорт; side-effect и
// динамический импорты тоже дают ребро. Слойность (185 №4): src/model
// не импортирует src/verify (verify — слой над model, не под ним).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const roots = [join(srcDir, "model"), join(srcDir, "save"), join(srcDir, "verify")];

function collect(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Убрать комментарии, чтобы сторож не видел импорты в тексте комментариев. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * Цели runtime-импортов одного файла — чистая функция над текстом (ревью 182 №1:
 * совпадение ограничено одним оператором до `;`, кавычки — одинарные и двойные).
 * Самотесты внизу закрепляют формы, которые старый `[\s\S]*?`-парсер пропускал.
 */
export function runtimeImportTargets(code: string): string[] {
  const text = stripComments(code);
  const targets: string[] = [];
  // import/export … from "./x" — один оператор: лениво до ближайшей `;`
  const STMT = /(?:^|[;\n])(import|export)\b([^;]*?)from\s*(["'])(\.[^"']+)\3/g;
  for (const m of text.matchAll(STMT)) {
    const kw = m[1]!;
    const body = m[2]!;
    // type-only импорт/реэкспорт стирается в рантайме — циклом не считается (181-c3b п.4)
    if (/^\s*type\b/.test(body)) continue;
    targets.push(m[4]!);
  }
  // side-effect: import "./x.ts" (без from)
  for (const m of text.matchAll(/(?:^|[;\n])import\s*(["'])(\.[^"']+)\1/g)) targets.push(m[2]!);
  // динамический: import("./x.ts")
  for (const m of text.matchAll(/\bimport\s*\(\s*(["'])(\.[^"']+)\1\s*\)/g)) targets.push(m[2]!);
  return targets;
}

function collectFiles(dir: string): Map<string, { path: string; code: string }> {
  const byName = new Map<string, { path: string; code: string }>();
  for (const f of collect(dir)) byName.set(relative(dir, f)!, { path: f, code: readFileSync(f, "utf8") });
  return byName;
}

test("src/model, src/save, src/verify: нет runtime-циклов импортов (сторож 181-c3b, 194-fix-c2s; ревью 182 №1)", () => {
  const files = roots.flatMap((root) => [...collectFiles(root).entries()]);
  const edges = new Map<string, Set<string>>(files.map(([name]) => [name, new Set()]));
  for (const [name, { path, code }] of files) {
    for (const target of runtimeImportTargets(code)) {
      const to = files.find(([n]) => n === relative(dirname(path), resolve(dirname(path), target))!);
      if (to === undefined) continue; // цель вне стороженных корней (или нерелятивная)
      edges.get(name)!.add(to[0]!);
    }
  }
  const state = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[] = [];
  const dfs = (v: string): void => {
    state.set(v, 1);
    stack.push(v);
    for (const w of edges.get(v) ?? []) {
      if (state.get(w) === 1) cycles.push([...stack.slice(stack.indexOf(w)), w].join(" -> "));
      else if (!state.get(w)) dfs(w);
    }
    stack.pop();
    state.set(v, 2);
  };
  for (const f of edges.keys()) if (!state.get(f)) dfs(f);
  assert.deepEqual(
    cycles,
    [],
    `найдены runtime-циклы в src/model, src/save, src/verify:\n${cycles.join("\n")}`,
  );
});

test("src/model не импортирует src/verify (сторож слоя, ревью 185 №4)", () => {
  // запрет именно для model (185 №4): save-оркестрация легитимно использует
  // верификаторы (src/save/orchestration.ts → ../verify/index.ts)
  const violations: string[] = [];
  for (const [name, { path, code }] of collectFiles(join(srcDir, "model"))) {
    for (const target of runtimeImportTargets(code)) {
      const resolved = resolve(dirname(path), target);
      if (resolved.startsWith(join(srcDir, "verify") + "/")) {
        violations.push(`${name}: импортирует src/verify (${target}) — модельный слой не зависит от слоя сверок`);
      }
    }
  }
  assert.deepEqual(violations, [], `запрещённые импорты в src/model:\n${violations.join("\n")}`);
});

// ---------- Самотест парсера (ревью 182 №1): формы, которые старый RE пропускал ----------

const q = (s: string): string[] => runtimeImportTargets(s);

test("самотест 182 №1: type-импорт из нерелятивного модуля не проглатывает следующий runtime-импорт", () => {
  // старый ленивый `[\s\S]*?` начинал совпадение на import type и захватывал
  // следующий импорт: тело начиналось с `type`, ребро отбрасывалось
  const src = `import type { Stats } from "node:fs";\nimport { addWall } from "./walls.ts";\n`;
  assert.deepEqual(q(src), ["./walls.ts"]);
});

test("самотест 182 №1: side-effect импорт даёт runtime-ребро", () => {
  assert.deepEqual(q(`import "./walls.ts";\n`), ["./walls.ts"]);
  assert.deepEqual(q(`import './walls.ts';\n`), ["./walls.ts"]);
});

test("самотест 190 N2: динамический import() даёт runtime-ребро", () => {
  assert.deepEqual(q(`await import("../server/x.ts");\n`), ["../server/x.ts"]);
});

test("самотест 190 N2: одинарные кавычки ловятся", () => {
  assert.deepEqual(q(`import { addWall } from './walls.ts';\n`), ["./walls.ts"]);
  assert.deepEqual(q(`export { addWall } from './walls.ts';\n`), ["./walls.ts"]);
});

test("самотест: type-only импорт и реэкспорт не дают ребра, смешанный — даёт", () => {
  assert.deepEqual(q(`import type { A } from "./a.ts";\nexport type { B } from "./b.ts";\n`), []);
  assert.deepEqual(q(`import { type A, addWall } from "./walls.ts";\n`), ["./walls.ts"]);
  assert.deepEqual(q(`export { addWall } from "./walls.ts";\n`), ["./walls.ts"]);
  assert.deepEqual(q(`export * from "./walls.ts";\n`), ["./walls.ts"]);
});

test("самотест: комментарии не считаются импортами", () => {
  assert.deepEqual(
    q(`// import { x } from "./fake.ts";\n/* import "./fake2.ts"; */\nimport { y } from "./real.ts";\n`),
    ["./real.ts"],
  );
});
