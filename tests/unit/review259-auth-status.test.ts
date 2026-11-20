// Ревью 258 №4: кеш статуса ЛК — auth_status всегда свежий (кеш только для
// гейтов), logged_in:false не кешируется, сброс при SESSION_TAKEN_OVER и при
// смене режима (сессия аккаунта назначена); комментарий кеша — честный TTL.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ServerContext } from "../../src/server/context.ts";
import { McpError } from "../../src/errors.ts";
import { STATE_PATH } from "../../src/config.ts";
import { saveSession } from "../../src/session.ts";
import type { ClientPageInfo } from "../../src/api.ts";

const STATE_DIR = join(STATE_PATH, "..");

function withAccountSession(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  saveSession(STATE_PATH, {
    cookies: [{ name: "sid", value: "x", domain: "remplanner.ru", path: "/", expires: Math.floor(Date.now() / 1000) + 3600 }],
    account: true,
  });
}

const INFO = (over: Partial<ClientPageInfo> = {}): ClientPageInfo => ({
  logged_in: true, login_error: false, tariff: "pro", projects: [], ...over,
});

test("258 №4: auth_status свежий при каждом вызове, гейт — из кеша (один GET на TTL)", async () => {
  withAccountSession();
  let calls = 0;
  const ctx = new ServerContext({ status: async () => INFO({ tariff: calls++ === 0 ? "pro" : "free" }) });
  const first = await ctx.authStatus();
  assert.equal(first.tariff, "pro");
  const gated = await ctx.authStatus();
  assert.equal(gated.tariff, "pro", "гейт читает кеш в пределах TTL");
  assert.equal(calls, 1, "второй гейт-вызов — без GET");
  const fresh = await ctx.authStatusFresh();
  assert.equal(fresh.tariff, "free", "auth_status всегда свежий");
  assert.equal(calls, 2, "свежий статус — новый GET");
  // после свежего значения кеш обновлён: гейт читает новое значение без GET
  const gated2 = await ctx.authStatus();
  assert.equal(gated2.tariff, "free");
  assert.equal(calls, 2);
});

test("258 №4: logged_in:false не кешируется (logout виден сразу), прежний кеш сброшен", async () => {
  withAccountSession();
  let calls = 0;
  const ctx = new ServerContext({
    status: async () => (calls++ === 0 ? INFO({ logged_in: false, tariff: "unknown" }) : INFO()),
  });
  const out = await ctx.authStatus();
  assert.equal(out.logged_in, false);
  const again = await ctx.authStatus();
  assert.equal(again.logged_in, true, "logged_in:false не отдаётся из кеша");
  assert.equal(calls, 2);
});

test("258 №4: SESSION_TAKEN_OVER сбрасывает кеш — следующий гейт идёт в сеть", async () => {
  withAccountSession();
  let fail = false;
  let calls = 0;
  const ctx = new ServerContext({
    status: async () => {
      calls++;
      if (fail) throw new McpError("SESSION_TAKEN_OVER", "сессию выбил вход в другом месте");
      return INFO();
    },
  });
  await ctx.authStatusFresh(); // calls=1, в кеше pro
  fail = true;
  await assert.rejects(() => ctx.authStatusFresh(), (e: unknown) => (e as { code: string }).code === "SESSION_TAKEN_OVER"); // calls=2, кеш сброшен
  fail = false;
  await ctx.authStatus(); // calls=3: кеша нет после ошибки — новый GET вместо устаревшего кеша
  assert.equal(calls, 3, "после SESSION_TAKEN_OVER кеш не отдаётся");
});

test("258 №4: смена режима (сессия аккаунта назначена) сбрасывает кеш anon-значений", async () => {
  rmSync(STATE_PATH, { force: true });
  const ctx = new ServerContext({ status: async () => INFO() });
  assert.equal((await ctx.authStatus()).mode, "anon");
  withAccountSession();
  // повторный session() с новым state.json — контекст в account, кеш anon сброшен
  (ctx as unknown as { sessionState: unknown }).sessionState = null;
  const st = await ctx.authStatus();
  assert.equal(st.mode, "account");
  assert.equal(st.logged_in, true);
});
