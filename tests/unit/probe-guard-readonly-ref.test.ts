// 323 N6: ключ эталона контрольного проекта — только пара READONLY
// (readonlyId, readonlyPlanId), без dev-объекта: эталон общий на пару READONLY,
// смена dev-объекта между прогонами не должна снимать новый эталон.
// Ревью 329 №7: путь — АБСОЛЮТНЫЙ, в КОРНЕВОМ .orca-reports репо (не
// относительно cwd/worktree — инцидент 328: каждый worktree получал свой базис).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { readonlyRefPath } from "../../scripts/probes/probe-guard.ts";

test("readonlyRefPath: ключ — только пара READONLY, без dev-объекта (323 N6)", () => {
  const h = createHash("sha256").update("43|2").digest("hex").slice(0, 12);
  const got = readonlyRefPath("43", "2");
  assert.ok(isAbsolute(got), `путь эталона должен быть абсолютным: ${got}`);
  assert.ok(got.endsWith(`readonly-ref-${h}.json`), `ключ эталона зависит не только от пары READONLY: ${got}`);
  assert.ok(got.includes(".orca-reports"), "эталон живёт в .orca-reports корневого репо");
});
