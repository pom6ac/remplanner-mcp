// Ревью 256 №9: кеш статуса ЛК — тариф читается один раз на TTL, ошибки не
// кешируются, новая сессия (другой объект) — промах кеша.
import test from "node:test";
import assert from "node:assert/strict";
import { AuthStatusCache } from "../../src/server/context.ts";
import type { SessionState } from "../../src/session.ts";

const INFO = { logged_in: true, tariff: "pro" as const, mode: "account", projects_limit: null, account_email_masked: null };

test("256 №9: кеш — попадание в пределах TTL, промах после и на другой сессии", () => {
  const cache = new AuthStatusCache(5 * 60_000);
  const s = { cookies: [] } as SessionState;
  assert.equal(cache.get(s, 1000), null);
  cache.set(s, INFO, 1000);
  assert.deepEqual(cache.get(s, 1000 + 4 * 60_000), INFO);
  assert.equal(cache.get(s, 1000 + 5 * 60_000), null, "после TTL — промах");
  const other = { cookies: [] } as SessionState;
  assert.equal(cache.get(other, 2000), null, "другая сессия — промах");
  cache.clear();
  assert.equal(cache.get(s, 1100), null);
});
