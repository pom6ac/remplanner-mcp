import test from "node:test";
import assert from "node:assert/strict";
import { McpError } from "../../src/errors.ts";

test("McpError несёт код, hint и details", () => {
  const e = new McpError("NOT_FOUND", "проект не найден", { hint: "проверьте object_id", details: { object_id: "123" } });
  assert.equal(e.code, "NOT_FOUND");
  assert.equal(e.hint, "проверьте object_id");
  assert.deepEqual(e.toJSON(), {
    code: "NOT_FOUND",
    message: "проект не найден",
    hint: "проверьте object_id",
    details: { object_id: "123" },
  });
});

test("McpError без опций — только код и сообщение", () => {
  const e = new McpError("TIMEOUT", "таймаут");
  assert.equal(e.toJSON().hint, undefined);
  assert.equal(e.toJSON().details, undefined);
  assert.ok(e instanceof Error);
});
