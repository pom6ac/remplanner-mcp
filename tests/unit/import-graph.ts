/**
 * Общий парсер runtime-импортов для тестов-сторожей (ревью 223 №4: одна копия
 * в tests/unit/import-graph.ts вместо двух расходящихся — находка №1 ревью 223
 * возникла в одной из копий). Чистые функции над текстом, без node-модулей.
 *
 * Runtime-импорт: `import …`, side-effect `import "./x.ts"`, динамический
 * `import("./x.ts")` и реэкспорт `export … from` (не `import type`/`export type`).
 * Смешанный `import { type X }` без `import type` считается runtime:
 * verbatimModuleSyntax, node strip-types сохраняет такой импорт в рантайме.
 *
 * Ревью 182 №1 / 190 N2: разбор ограничен одним оператором; type-импорт из
 * нерелятивного модуля не «проглатывает» следующий runtime-импорт; side-effect,
 * динамический импорт и одинарные кавычки дают ребро. Ревью 223 №5: оператор
 * ограничен и следующим оператором — в файле без точек с запятой два импорта
 * больше не склеиваются в одно совпадение (тело не может перескочить через
 * следующий `import`/`export`).
 */

/** Убрать комментарии, чтобы сторож не видел импорты в тексте комментариев. */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

export interface RuntimeImportOptions {
  /**
   * Убрать комментарии перед разбором (сторож циклов c3b). По умолчанию false:
   * сторож c4 консервативен — импорт в комментарии в src/dto даёт срабатывание
   * (ревью 223 №4: поведение обеих копий сохранено).
   */
  stripComments?: boolean;
}

/**
 * Один оператор import/export (лениво до `;`, тело не перескакивает через
 * следующий `import`/`export`), относительная цель. Ревью 231 R5: хвоста после
 * закрывающей кавычки регулярка не требует — `// …`, `/* … *\/` и
 * `with { type: "json" }` без `;` не теряют импорт (c4 комментарии не вырезает).
 */
const RE_STMT =
  /(?:^|[;\n])(import|export)\b((?:(?!\b(?:import|export)\b)[^;])*?)from\s*(["'])(\.[^"']+)\3/g;
/** Side-effect импорт без from: import "../server/x.ts". */
const RE_SIDE_EFFECT = /(?:^|[;\n])import\s*(["'])(\.[^"']+)\1/g;
/** Динамический импорт: import("../server/x.ts"). */
const RE_DYNAMIC = /\bimport\s*\(\s*(["'])(\.[^"']+)\1\s*\)/g;

/** Цели runtime-импортов одного файла: обычные, side-effect и динамические. */
export function runtimeImportTargets(code: string, opts: RuntimeImportOptions = {}): string[] {
  const text = opts.stripComments ? stripComments(code) : code;
  const targets: string[] = [];
  for (const m of text.matchAll(RE_STMT)) {
    if (/^\s*type\b/.test(m[2]!)) continue; // import type / export type — стираются
    targets.push(m[4]!);
  }
  for (const m of text.matchAll(RE_SIDE_EFFECT)) targets.push(m[2]!);
  for (const m of text.matchAll(RE_DYNAMIC)) targets.push(m[2]!);
  return targets;
}
