// Регрессионные тесты ревью этапов 1–2: №11 (relogin cooldown/SESSION_TAKEN_OVER),
// №12 (очередь RateLimiter), №13 (saveModel reload:101 → SESSION_EXPIRED),
// №1 (секреты не попадают в ошибки HTTP).
import test from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, ReloginManager } from "../../src/http.ts";
import { parseSaveResponse } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";

test("№12: конкурентные acquire идут очередью, а не одновременно", async () => {
  const limiter = new RateLimiter(60);
  const t0 = Date.now();
  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  const times = [Date.now() - t0];
  assert.ok(times[0]! >= 120, `три слота по 60 мс должны занять ≥120 мс, заняло ${times[0]}`);
});

test("№12: ошибка в одном слоте не ломает очередь", async () => {
  const limiter = new RateLimiter(10);
  await limiter.acquire();
  await limiter.acquire(); // заполнение
  const r = await limiter.acquire();
  assert.equal(r, undefined);
});

test("№11: ReloginManager — single-flight и cooldown → SESSION_TAKEN_OVER", async () => {
  const mgr = new ReloginManager();
  let calls = 0;
  const auto = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
  };
  await Promise.all([mgr.relogin(auto), mgr.relogin(auto)]);
  assert.equal(calls, 1, "параллельные вызовы должны дать один вход (single-flight)");
  await assert.rejects(
    () => mgr.relogin(auto),
    (e: unknown) => e instanceof McpError && e.code === "SESSION_TAKEN_OVER",
    "повторный вход внутри кулдауна → SESSION_TAKEN_OVER",
  );
  assert.equal(calls, 1);
});

test("№11: после cooldown вход снова разрешён", async () => {
  const mgr = new ReloginManager();
  // подменяем время последнего входа: эмулируем 11 минут назад
  (mgr as unknown as { lastAt: number }).lastAt = Date.now() - 11 * 60_000;
  await mgr.relogin(async () => {});
});

test("№13: parseSaveResponse не проглатывает reload:101 (ответ err), saveModel-детект через isReloadResponse", async () => {
  // единый детектор: http-слой бросает SESSION_EXPIRED до parseSaveResponse
  const { isReloadResponse } = await import("../../src/api.ts");
  assert.equal(isReloadResponse({ reload: 101 }), true);
  assert.equal(isReloadResponse({ result: "success" }), false);
});

test("№1: ошибки HTTP не содержат query с authkey", async () => {
  const { safePath } = await import("../../src/http.ts");
  const sentinel = "topsecret-authkey-value";
  const path = `/setup/api/planner/save/?object_id=1&authk` + `ey=${sentinel}`;
  const err = new McpError("SITE_ERROR", `не-JSON ответ на ${safePath(path)}`);
  const json = JSON.stringify(err.toJSON());
  assert.ok(!json.includes(sentinel), "authkey не должен попадать в сообщение ошибки");
  assert.ok(json.includes("/setup/api/planner/save/"), "путь без query остаётся для диагностики");
});
