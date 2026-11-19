// Тест-сторож (аудит 65, C3 / этап 181-c3b; ревью 182 №1, ревью 185 №4, ревью
// 223 №1): парсит runtime-импорты src/model, src/save (194-fix-c2s, ревью 193 №8)
// и src/verify и краснеет при появлении цикла или запрещённой зависимости.
// Парсер общий с c4-сторожем — tests/unit/import-graph.ts (ревью 223 №4).
// Без новых зависимостей — только node:fs/node:path.
// Ревью 223 №1: узлы графа — абсолютные пути файлов, цель импорта ищется по
// resolve(dirname(path), target). Имена относительно своего корня сливали
// одноимённые файлы src/model и src/verify в один узел (ложные циклы) и теряли
// межкорневые рёбра (../save/…, ../model/…): цикл model↔save перестал ловиться.
// Имя для вывода — путь относительно src/ (model/walls.ts), без коллизий.
// Слойность (185 №4): src/model не импортирует src/verify (verify — слой над
// model, не под ним).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeImportTargets } from "./import-graph.ts";

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

type SourceFile = { path: string; code: string };

/**
 * Циклы runtime-импортов в наборе файлов (пути — абсолютные, как на диске):
 * чистая функция над файлами — самотесты внизу проверяют межкорневой цикл
 * и одноимённые файлы в разных каталогах (ревью 223 №1).
 */
export function importCycles(files: SourceFile[], displayRoot: string): string[] {
  const byAbs = new Map(files.map((f) => [f.path, f]));
  const edges = new Map<string, Set<string>>(files.map((f) => [f.path, new Set()]));
  for (const { path, code } of files) {
    for (const target of runtimeImportTargets(code, { stripComments: true })) {
      const to = resolve(dirname(path), target);
      if (!byAbs.has(to)) continue; // цель вне стороженных корней (или нерелятивная)
      edges.get(path)!.add(to);
    }
  }
  const state = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[] = [];
  const display = (abs: string): string => relative(displayRoot, abs)!;
  const dfs = (v: string): void => {
    state.set(v, 1);
    stack.push(v);
    for (const w of edges.get(v) ?? []) {
      if (state.get(w) === 1)
        cycles.push([...stack.slice(stack.indexOf(w)), w].map(display).join(" -> "));
      else if (!state.get(w)) dfs(w);
    }
    stack.pop();
    state.set(v, 2);
  };
  for (const f of edges.keys()) if (!state.get(f)) dfs(f);
  return cycles;
}

test("src/model, src/save, src/verify: нет runtime-циклов импортов (сторож 181-c3b, 194-fix-c2s; ревью 182 №1, 223 №1)", () => {
  const files: SourceFile[] = roots
    .flatMap((root) => collect(root))
    .map((path) => ({ path, code: readFileSync(path, "utf8") }));
  const cycles = importCycles(files, srcDir);
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
  for (const path of collect(join(srcDir, "model"))) {
    for (const target of runtimeImportTargets(readFileSync(path, "utf8"), { stripComments: true })) {
      const resolved = resolve(dirname(path), target);
      if (resolved.startsWith(join(srcDir, "verify") + "/")) {
        violations.push(
          `${relative(srcDir, path)!}: импортирует src/verify (${target}) — модельный слой не зависит от слоя сверок`,
        );
      }
    }
  }
  assert.deepEqual(violations, [], `запрещённые импорты в src/model:\n${violations.join("\n")}`);
});

// ---------- Самотесты графа (ревью 223 №1) ----------

test("самотест 223 №1: межкорневой цикл model↔save ловится", () => {
  // мутация ревьюера (import "../save/orchestration.ts" в model/walls.ts) на
  // f9b73c5 давала 8 pass / 0 fail — ребро ../save/… не находилось
  const cycles = importCycles(
    [
      { path: "/r/model/walls.ts", code: `import { runSave } from "../save/orchestration.ts";\n` },
      { path: "/r/save/orchestration.ts", code: `import { Wall } from "../model/walls.ts";\n` },
    ],
    "/r",
  );
  assert.deepEqual(cycles, ["model/walls.ts -> save/orchestration.ts -> model/walls.ts"]);
});

test("самотест 223 №1: одноимённые файлы в разных корнях без цикла — без срабатывания", () => {
  // verify/climate.ts → "./walls.ts" — легитимный ацикличный импорт; на f9b73c5
  // одноимённые model/walls и verify/walls сливались в один узел → ложный цикл
  const cycles = importCycles(
    [
      { path: "/r/model/walls.ts", code: `import { c } from "./climate.ts";\n` },
      { path: "/r/model/climate.ts", code: `export const c = 1;\n` },
      { path: "/r/verify/walls.ts", code: `export const w = 1;\n` },
      { path: "/r/verify/climate.ts", code: `import "./walls.ts";\n` },
    ],
    "/r",
  );
  assert.deepEqual(cycles, []);
});

// ---------- Самотесты парсера (ревью 182 №1, 223 №5) ----------

const q = (s: string, opts?: Parameters<typeof runtimeImportTargets>[1]): string[] =>
  runtimeImportTargets(s, opts);

test("самотест 182 №1: type-импорт из нерелятивного модуля не проглатывает следующий runtime-импорт", () => {
  // старый ленивый `[\s\S]*?` начинал совпадение на import type и захватывал
  // следующий импорт: тело начиналось с `type`, ребро отбрасывалось
  const src = `import type { Stats } from "node:fs";\nimport { addWall } from "./walls.ts";\n`;
  assert.deepEqual(q(src), ["./walls.ts"]);
});

test("самотест 223 №5: файл без точек с запятой — импорты не склеиваются", () => {
  // `[^;]*?` без ограничителя конца строки склеивал два оператора в файле без `;`;
  // в варианте type-первым тело начиналось с `type` и ребро терялось
  assert.deepEqual(
    q(`import type { A } from "./a.ts"\nimport { addWall } from "./walls.ts"\n`),
    ["./walls.ts"],
  );
  assert.deepEqual(
    q(`import type { Stats } from "node:fs"\nimport { addWall } from "./walls.ts"\n`),
    ["./walls.ts"],
  );
  // многострочный оператор с `;` по-прежнему парсится
  assert.deepEqual(q(`import {\n  addWall,\n} from "./walls.ts";\n`), ["./walls.ts"]);
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

test("самотест: комментарии не считаются импортами (stripComments)", () => {
  assert.deepEqual(
    q(`// import { x } from "./fake.ts";\n/* import "./fake2.ts"; */\nimport { y } from "./real.ts";\n`, {
      stripComments: true,
    }),
    ["./real.ts"],
  );
  // без stripComments (режим сторожа c4) динамический импорт в комментарии
  // консервативно виден (у RE_DYNAMIC нет якоря начала строки)
  assert.deepEqual(q(`// await import("./fake.ts");\n`, {}), ["./fake.ts"]);
});

test("самотест 231 R5: хвост после кавычки без ; не теряет ребро (с stripComments и без)", () => {
  // на b511493 хвостовой lookahead RE_STMT требовал после кавычки `;`/перевод
  // строки/конец файла: `with { type: "json" }` терялся и в c3b, комментарии — в c4
  for (const opts of [{ stripComments: true }, {}]) {
    assert.deepEqual(q(`import { a } from "./a.ts" // note\nimport { b } from "./b.ts"\n`, opts), ["./a.ts", "./b.ts"]);
    assert.deepEqual(q(`import { a } from "./a.ts" /* n */\n`, opts), ["./a.ts"]);
    assert.deepEqual(q(`import j from "./data.json" with { type: "json" };\n`, opts), ["./data.json"]);
    assert.deepEqual(q(`import j from "./data.json" with { type: "json" }\nimport type { T } from "./t.ts"\n`, opts), [
      "./data.json",
    ]);
  }
});
