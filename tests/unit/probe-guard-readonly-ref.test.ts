// 323 N6: ключ эталона контрольного проекта — только пара READONLY
// (readonlyId, readonlyPlanId), без dev-объекта: эталон общий на пару READONLY,
// смена dev-объекта между прогонами не должна снимать новый эталон.
import test from "node:test";
import { createHash } from "node:crypto";
import { readonlyRefPath } from "../../scripts/probes/probe-guard.ts";

test("readonlyRefPath: ключ — только пара READONLY, без dev-объекта (323 N6)", () => {
  const h = createHash("sha256").update("43|2").digest("hex").slice(0, 12);
  const got = readonlyRefPath("43", "2");
  if (got !== `.orca-reports/tmp/readonly-ref-${h}.json`) {
    throw new Error(`ключ эталона зависит не только от пары READONLY: получено ${got}, ожидался readonly-ref-${h}.json`);
  }
});
