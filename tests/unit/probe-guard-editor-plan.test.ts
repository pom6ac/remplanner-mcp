// №6г ревью 355: гард «план в редакторе == серверу» в probe-guard — FAIL-CLOSED.
// undefined/null/пустой compat.plan_id — отказ (раньше ветка `openedPlan !== undefined`
// молча пропускала сверку: 354-dev.log, `editor plan: undefined`); несовпадение — отказ;
// совпадение — проход. Обёртка assertEditorPlanMatch — process.exit(1) (не тестируется).
import test from "node:test";
import assert from "node:assert/strict";
import { ProbeGuardError, checkEditorPlanMatch } from "../../scripts/probes/probe-guard.ts";

test("гард плана редактора: undefined — отказ (fail-closed, №6г ревью 355)", () => {
  assert.throws(
    () => checkEditorPlanMatch(undefined, "42"),
    (e: unknown) => e instanceof ProbeGuardError && e.message.includes("fail-closed"),
  );
});

test("гард плана редактора: null и пустая строка — отказ", () => {
  assert.throws(() => checkEditorPlanMatch(null, "42"), ProbeGuardError);
  assert.throws(() => checkEditorPlanMatch("", "42"), ProbeGuardError);
});

test("гард плана редактора: чужой план — отказ с обоими id", () => {
  assert.throws(
    () => checkEditorPlanMatch("43", "42"),
    (e: unknown) => e instanceof ProbeGuardError && e.message.includes("43") && e.message.includes("42"),
  );
});

test("гард плана редактора: совпадающий план — проход", () => {
  assert.doesNotThrow(() => checkEditorPlanMatch("42", "42"));
});
