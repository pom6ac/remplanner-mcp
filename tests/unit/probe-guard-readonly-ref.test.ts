// 323 N6: ключ эталона контрольного проекта — только пара READONLY
// (readonlyId, readonlyPlanId), без dev-объекта: эталон общий на пару READONLY,
// смена dev-объекта между прогонами не должна снимать новый эталон.
// Ревью 329 №7: путь — АБСОЛЮТНЫЙ, в КОРНЕВОМ .orca-reports репо (не
// относительно cwd/worktree — инцидент 328: каждый worktree получал свой базис).
// Ревью 331 Н6: корень — по `git rev-parse --git-common-dir` (эвристика «самый
// внешний предок с .orca-reports» удалена — каталог .orca-reports в ~ или
// ~/projects перехватывал бы эталон); подмена корня на «ближайший» проходит
// мимо теста — тест сверяет путь с корнем, вычисленным тем же способом, что в
// проде (gitRepoRoot). Решение «загрузить / создать / отказ» — чистая функция
// readonlyRefDecision, все три ветки закреплены тестами.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readonlyRefDecision, readonlyRefPath } from "../../scripts/probes/probe-guard.ts";

test("readonlyRefPath: ключ — только пара READONLY, без dev-объекта (323 N6)", () => {
  const h = createHash("sha256").update("43|2").digest("hex").slice(0, 12);
  const got = readonlyRefPath("43", "2");
  assert.ok(isAbsolute(got), `путь эталона должен быть абсолютным: ${got}`);
  assert.ok(got.endsWith(`readonly-ref-${h}.json`), `ключ эталона зависит не только от пары READONLY: ${got}`);
  assert.ok(got.includes(".orca-reports"), "эталон живёт в .orca-reports корневого репо");
});

test("ревью 331 Н6: корень эталона — git common dir, а не ближайший предок с .orca-reports", () => {
  // ожидание вычисляется НЕЗАВИСИМО от gitRepoRoot (свой git rev-parse) —
  // иначе подмена корня внутри gitRepoRoot мимо теста не пройдёт
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: import.meta.dirname, encoding: "utf8" }).trim();
  const root = dirname(resolve(import.meta.dirname, commonDir));
  const h = createHash("sha256").update("43|2").digest("hex").slice(0, 12);
  const got = readonlyRefPath("43", "2");
  const expected = join(root, ".orca-reports", "tmp", `readonly-ref-${h}.json`);
  assert.equal(got, expected, `путь эталона привязан к корню по git: ${got} != ${expected}`);
  // подмена «ближайший .orca-reports» (worktree) больше не проходит: путь
  // обязан совпасть с <git-root>/.orca-reports/tmp/… построчно
});

test("ревью 331 Н6: readonlyRefDecision — load / create / refuse (чистая функция)", () => {
  assert.deepEqual(readonlyRefDecision(true, undefined), { action: "load" }, "файл есть — загрузить (флаг не нужен)");
  assert.deepEqual(readonlyRefDecision(true, "0"), { action: "load" }, "файл есть — загрузить, даже без флага");
  assert.deepEqual(readonlyRefDecision(false, "1"), { action: "create" }, "файла нет + явный флаг — создать базис");
  const refused = readonlyRefDecision(false, undefined);
  assert.equal(refused.action, "refuse", "файла нет без флага — отказ (молчаливое автосоздание запрещено)");
  assert.ok(refused.action === "refuse" && refused.reason.includes("REMPLANNER_PROBE_READONLY_REF_INIT"), "в отказе — команда создания базиса");
  assert.ok(readonlyRefDecision(false, "0").action === "refuse", "произвольное значение флага — не создание");
});
