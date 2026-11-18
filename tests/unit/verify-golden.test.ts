/**
 * Golden-тест чистых entity-верификаторов (этап 184, C2): результаты всех сверк
 * на фикстурах + синтетически испорченных вариантах сверяются со снапшотом
 * побайтно. Снапшот снят с реализации до рефакторинга C2 (src/workspace.ts);
 * рефакторинг src/verify/ обязан давать тот же результат.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import * as verifiers from "../../src/verify/index.ts";
import { runGoldenCases } from "./verify-golden-cases.ts";

test("verify golden: результаты верификаторов совпадают со снапшотом побайтно", () => {
  const cases = runGoldenCases(verifiers as never);
  const actual = JSON.stringify(cases, null, 2) + "\n";
  const expected = readFileSync(join(import.meta.dirname, "verify-golden.json"), "utf8");
  assert.equal(actual, expected, "результаты верификаторов изменились относительно снапшота");
});

test("verify golden: в снапшоте есть непустые mismatch и пустые идентичности", () => {
  const snapshot = JSON.parse(readFileSync(join(import.meta.dirname, "verify-golden.json"), "utf8")) as Record<string, string[]>;
  const entries = Object.entries(snapshot);
  assert.ok(entries.length > 40, `слишком мало кейсов: ${entries.length}`);
  assert.ok(entries.some(([, v]) => v.length === 0), "нет кейсов-идентичностей");
  assert.ok(entries.some(([, v]) => v.length > 0), "нет кейсов с непустыми mismatch");
});
