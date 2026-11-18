// Тест-сторож (аудит 65, C3 / этап 181-c3b): парсит runtime-импорты src/model
// и краснеет при появлении цикла. Без новых зависимостей — только node:fs/node:path.
// Runtime-импорт: `import …` (не `import type …`) и реэкспорт `export … from`.
// Смешанный `import { type X }` без `import type` считается runtime: verbatimModuleSyntax,
// node strip-types сохраняет такой импорт в рантайме.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modelDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "model");

function collect(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

const RE = /(?:^|\n)(import|export)([\s\S]*?)from\s*"(\.[^"]+)"/g;

function runtimeEdges(): Map<string, Set<string>> {
  const files = collect(modelDir);
  const edges = new Map(files.map((f) => [relative(modelDir, f), new Set<string>()]));
  for (const f of files) {
    const name = relative(modelDir, f)!;
    for (const m of readFileSync(f, "utf8").matchAll(RE)) {
      const kw = m[1]!;
      const body = m[2]!;
      const spec = m[3]!;
      const target = relative(modelDir, resolve(dirname(f), spec))!;
      if (!edges.has(target)) continue;
      const isTypeImport = kw === "import" && /^\s*type\b/.test(body);
      if (isTypeImport) continue; // type-only импорт циклом не считается (181-c3b п.4)
      edges.get(name)!.add(target);
    }
  }
  return edges;
}

test("src/model: нет runtime-циклов импортов (сторож 181-c3b)", () => {
  const edges = runtimeEdges();
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
  assert.deepEqual(cycles, [], `найдены runtime-циклы в src/model:\n${cycles.join("\n")}`);
});
