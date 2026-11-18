// Сторож DTO-слоя (аудит 65 C4, задача 187-c4 п.4): src/dto — чистый слой
// преобразований editor↔public. Запрещены runtime-импорты server/, workspace,
// сети и браузера (api/http/browser/session/login/catalog/render/editor/config);
// type-only импорты допустимы (verbatimModuleSyntax: они исчезают в рантайме).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dtoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "dto");

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

test("src/dto: нет runtime-импортов server/workspace/сети/браузера (сторож 187-c4)", () => {
  const violations: string[] = [];
  for (const f of collect(dtoDir)) {
    const name = relative(dtoDir, f)!;
    for (const m of readFileSync(f, "utf8").matchAll(RE)) {
      const kw = m[1]!;
      const body = m[2]!;
      const target = relative(dtoDir, resolve(dirname(f), m[3]!))!;
      const isTypeImport = kw === "import" && /^\s*type\b/.test(body);
      if (isTypeImport) continue;
      if (FORBIDDEN.some((re) => re.test(target))) {
        violations.push(`${name}: runtime-импорт "${m[3]}" (DTO не зависит от сервера, workspace, сети и браузера)`);
      }
    }
  }
  assert.deepEqual(violations, [], `запрещённые импорты в src/dto:\n${violations.join("\n")}`);
});
