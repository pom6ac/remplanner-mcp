// Сторож фикстур (аудит 65 A2): каждый tests/fixtures/*.json должен иметь _source,
// не содержать числовых ID проектов/планов (≥ 6 цифр) в полях id/plan_id/project_id/
// object_id, email, абсолютных путей /Users/ и секретных ключей (authkey=, password=).
// Эталоны с исходными ID сайта (_XXXXX) внутри copy тоже запрещены — замена должна быть
// полной (scripts/anonymize.ts). Исключения — только через allowlist ниже, с обоснованием.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

// Фикстуры без _source. Пустой allowlist: любая запись требует обоснования в комментарии.
const ALLOW_NO_SOURCE = new Set<string>([]);

// Фикстура → список разрешённых числовых ID в полях id/plan_id/project_id/object_id.
// Формат: "файл:путь.к.полю" → обоснование.
const ALLOW_NUMERIC_IDS = new Map<string, string>([]);

// Ключи, в которых числовой ID выглядит как ID проекта/плана сайта.
const ID_KEYS = /^(id|plan_id|project_id|object_id)$/;

interface Violation {
  file: string;
  where: string;
  what: string;
}

function scanFile(file: string, root: unknown): Violation[] {
  const out: Violation[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const here = path ? `${path}.${k}` : k;
        if (ID_KEYS.test(k)) {
          const s = typeof v === "string" ? v : typeof v === "number" ? String(Math.trunc(v)) : "";
          if (/^\d{6,}$/.test(s)) {
            const allowKey = `${file}:${here}`;
            if (!ALLOW_NUMERIC_IDS.has(allowKey)) {
              out.push({ file, where: here, what: `числовой ID «${s}» (≥ 6 цифр) в поле ${k}` });
            }
          }
        }
        walk(v, here);
      }
    }
  };
  walk(root, "");
  return out;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const LEAK_RE = [/\/Users\//, /authkey\s*=/i, /password\s*=/i];

for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort()) {
  test(`сторож фикстур: ${name}`, () => {
    const text = readFileSync(join(FIXTURES, name), "utf8");
    const json = JSON.parse(text) as Record<string, unknown>;

    if (!ALLOW_NO_SOURCE.has(name)) {
      const source = json["_source"];
      assert.ok(
        typeof source === "string" && source.trim().length > 20,
        "нет _source (происхождение фикстуры не зафиксировано в артефакте)",
      );
    }

    const violations = scanFile(name, json);
    assert.deepEqual(
      violations.map((v) => `${v.where}: ${v.what}`),
      [],
      "числовые ID в id-полях — заменить на синтетические (см. scripts/anonymize.ts)",
    );

    for (const re of LEAK_RE) {
      assert.doesNotMatch(text, re, `запрещённый шаблон ${re} в ${name}`);
    }
    assert.doesNotMatch(text, EMAIL_RE, `похоже на email в ${name}`);
  });
}
