// Тест-сторож (аудит 65, C3 / этап 181-c3b): парсит runtime-импорты src/model
// и src/save (194-fix-c2s, ревью 193 №8) и краснеет при появлении цикла.
// Без новых зависимостей — только node:fs/node:path.
// Runtime-импорт: `import …` (не `import type …`) и реэкспорт `export … from`.
// Смешанный `import { type X }` без `import type` считается runtime: verbatimModuleSyntax,
// node strip-types сохраняет такой импорт в рантайме.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const roots = [join(srcDir, "model"), join(srcDir, "save")];

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
  const nameOf = new Map<string, string>();
  for (const root of roots) {
    for (const f of collect(root)) nameOf.set(f, relative(root, f)!);
  }
  const edges = new Map<string, Set<string>>();
  for (const name of nameOf.values()) edges.set(name, new Set());
  for (const [f, name] of nameOf) {
    for (const m of readFileSync(f, "utf8").matchAll(RE)) {
      const kw = m[1]!;
      const body = m[2]!;
      const target = nameOf.get(resolve(dirname(f), m[3]!));
      if (target === undefined) continue;
      const isTypeImport = kw === "import" && /^\s*type\b/.test(body);
      if (isTypeImport) continue; // type-only импорт циклом не считается (181-c3b п.4)
      edges.get(name)!.add(target);
    }
  }
  return edges;
}

test("src/model и src/save: нет runtime-циклов импортов (сторож 181-c3b, 194-fix-c2s)", () => {
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
  assert.deepEqual(cycles, [], `найдены runtime-циклы в src/model и src/save:\n${cycles.join("\n")}`);
});
