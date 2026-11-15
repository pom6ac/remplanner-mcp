import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLoadResponse, parseSaveResponse, parseCreateResponse } from "../../src/api.ts";
import { RateLimiter } from "../../src/http.ts";

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = JSON.parse(readFileSync(join(here, "../fixtures/api-load-response.json"), "utf8"));
const saveOkFixture = JSON.parse(readFileSync(join(here, "../fixtures/api-save-response.json"), "utf8"));
const saveConflictFixture = JSON.parse(readFileSync(join(here, "../fixtures/api-save-conflict-response.json"), "utf8"));

test("parseLoadResponse: фикстура ответа load", () => {
  const loaded = parseLoadResponse(loadFixture);
  assert.equal(loaded.object_id, "0");
  assert.equal(loaded.save_id, "1");
  assert.equal(loaded.units, "cm");
  const walls = loaded.model["walls"] as Record<string, unknown>;
  assert.equal(Object.keys(walls).length, 4);
  assert.equal(loaded.model["total_height"], 270);
});

test("parseLoadResponse: нет data → SITE_ERROR", () => {
  assert.throws(() => parseLoadResponse({ object_id: "0", plan_id: "0", save_id: "1", data: 123 as unknown as string }), /data/);
  assert.throws(() => parseLoadResponse({ object_id: "0", plan_id: "0", save_id: "1", data: "{broken" }), /JSON/);
});

test("parseSaveResponse: success", () => {
  const r = parseSaveResponse(saveOkFixture);
  assert.equal(r.ok, true);
  assert.equal(r.save_id, "2");
  assert.equal(r.conflict, false);
});

test("parseSaveResponse: fail с диалогом «Сохранить все равно» → конфликт", () => {
  const r = parseSaveResponse(saveConflictFixture);
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
});

test("parseSaveResponse: fail без признака конфликта", () => {
  const r = parseSaveResponse({ result: "fail", html_code: "<div>что-то иное</div>" });
  assert.equal(r.ok, false);
  assert.equal(r.conflict, false);
});

test("parseCreateResponse: варианты ответа создания проекта", () => {
  assert.deepEqual(parseCreateResponse({ object_id: "123456", plan_id: "7" }), { object_id: "123456", plan_id: "7" });
  assert.deepEqual(parseCreateResponse({ id: 123456 }), { object_id: "123456", plan_id: "" });
  assert.throws(() => parseCreateResponse({ result: "fail" }));
  assert.throws(() => parseCreateResponse("x"));
});

test("RateLimiter выдерживает интервал", async () => {
  const limiter = new RateLimiter(30);
  const t0 = Date.now();
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  const dt = Date.now() - t0;
  assert.ok(dt >= 55, `два интервала ~60мс, прошло ${dt}мс`);
});
