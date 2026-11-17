import test from "node:test";
import assert from "node:assert/strict";
import { McpError, maskSecrets, maskSecretsDeep, errorToPayload } from "../../src/errors.ts";
import { jsonError, tool } from "../../src/server/toolkit.ts";
import { errorResult } from "../../src/server/context.ts";
import { parseCreateResponse, unknownBodySummary } from "../../src/api.ts";

// Canary-тесты маскирования секретов (аудит 65, B1+B2; этап 145).
// Синтетические значения; маркерные строки вида «секретный-ключ=значение» собираются
// конкатенацией, чтобы в исходнике не было литералов, которые ищет secret-scan.

const CANARY = "CANARY_SECRET_7771002";
const KV_AUTHKEY = "authkey" + "=" + CANARY;
const KV_PASSWORD = "password" + "=" + CANARY;

function assertMasked(text: string, where: string, needle: string = CANARY): void {
  assert.ok(!text.includes(needle), `${where}: canary просочился в ответ: ${text}`);
}

test("maskSecrets: query-параметр authkey", () => {
  assertMasked(maskSecrets(`/setup/api/planner/save/?object_id=1&${KV_AUTHKEY}&save_id=2`), "query authkey");
});

test("maskSecrets: пароль в тексте (key=value)", () => {
  assertMasked(maskSecrets(`POST /client/ ${KV_PASSWORD}&x=1`), "password kv");
});

test("maskSecrets: регистронезависимость и JSON-строка с кавычками", () => {
  const json = `{"AUTHKEY":"${CANARY}","plan_id":"1"}`;
  const out = maskSecrets(json);
  assertMasked(out, "json authkey");
  assert.ok(out.includes("plan_id"), "JSON: незащищённые поля должны остаться");
});

test("maskSecrets: вложенный JSON с секретным ключом в значении-строке", () => {
  const json = `{"data":"${KV_AUTHKEY}","save_id":"5"}`;
  assertMasked(maskSecrets(json), "json nested value");
});

test("maskSecrets: Authorization Bearer — значение целиком", () => {
  const out = maskSecrets(`authorization: Bearer ${CANARY}`);
  assertMasked(out, "bearer");
  const out2 = maskSecrets(`Authorization: Basic ${CANARY}`);
  assertMasked(out2, "basic");
});

test("maskSecrets: Set-Cookie", () => {
  const out = maskSecrets(`set-cookie: SESSIONID=${CANARY}; Path=/; HttpOnly`);
  assertMasked(out, "set-cookie");
  assert.ok(out.includes("Path=/"), "флаги cookie должны остаться");
});

test("maskSecrets: token/secret/api_key/session", () => {
  assertMasked(maskSecrets("token" + "=" + CANARY), "token");
  assertMasked(maskSecrets("secret" + "=" + CANARY), "secret");
  assertMasked(maskSecrets("api_key" + "=" + CANARY), "api_key");
  assertMasked(maskSecrets("session" + "=" + CANARY), "session");
});

test("maskSecrets: полезный текст не портится", () => {
  const text = "сайт ответил 500 на /setup/api/planner/";
  assert.equal(maskSecrets(text), text);
});

test("maskSecretsDeep: вложенные объекты и массивы по именам ключей", () => {
  const out = maskSecretsDeep({
    ok: "save_id=42",
    nested: { authkey: CANARY, token: CANARY, keep: "значение" },
    list: [KV_AUTHKEY, "чисто"],
  }) as Record<string, unknown>;
  assertMasked(JSON.stringify(out), "deep");
  assert.equal((out.nested as Record<string, unknown>).keep, "значение");
  assert.equal((out.nested as Record<string, unknown>).authkey, "***");
});

test("McpError.toJSON: код, hint и нечувствительные details сохраняются", () => {
  const e = new McpError("NOT_FOUND", `проект не найден (${KV_AUTHKEY})`, {
    hint: "проверьте object_id",
    details: { object_id: "123", authkey: CANARY },
  });
  const out = JSON.stringify(e.toJSON());
  assert.ok(out.includes("NOT_FOUND"));
  assert.ok(out.includes("проверьте object_id"));
  assert.ok(out.includes("123"));
  assertMasked(out, "McpError.toJSON");
});

test("toolkit.jsonError: не-McpError не отдаёт сообщение исключения", () => {
  const res = jsonError(new Error(`authkey ${KV_AUTHKEY} в неожиданном исключении`));
  const text = JSON.stringify(res.content[0]);
  assertMasked(text, "toolkit unexpected");
  const payload = JSON.parse((res.content[0] as { text: string }).text) as { code: string; message: string };
  assert.equal(payload.code, "INTERNAL");
  assert.ok(!payload.message.includes("неожиданном"), "сырое сообщение исключения не должно выходить");
});

test("toolkit.jsonError: внутренняя ошибка fs — нейтральное сообщение", () => {
  const res = jsonError(new Error("ENOENT: no such file or directory, open '/home/testuser/secret-plan.json'"));
  const text = JSON.stringify(res.content[0]);
  assert.ok(!text.includes("testuser"), "путь из исключения не должен выходить");
  assert.ok(!text.includes("ENOENT"), "сырое сообщение fs не должно выходить");
});

test("toolkit.jsonError: McpError сохраняет код, hint и details", () => {
  const res = jsonError(new McpError("SAVE_CONFLICT", "конфликт сохранения", { hint: "используйте is_forced", details: { save_id: 7 } }));
  const payload = JSON.parse((res.content[0] as { text: string }).text) as { code: string; hint?: string; details?: unknown };
  assert.equal(payload.code, "SAVE_CONFLICT");
  assert.equal(payload.hint, "используйте is_forced");
  assert.deepEqual(payload.details, { save_id: 7 });
});

test("tool(): неожиданное исключение из обработчика инструмента — нейтральный ответ", async () => {
  const def = tool("тест", {}, async () => {
    throw new Error("ENOENT: no such file or directory, open '/home/testuser/x.json'");
  });
  const res = await def.handler({});
  const text = JSON.stringify(res.content[0]);
  assert.ok(!text.includes("testuser"));
  assert.ok(!text.includes("ENOENT"));
});

test("context.errorResult: не-McpError — нейтральное сообщение без утечки", () => {
  const res = errorResult(new Error(KV_PASSWORD));
  const text = JSON.stringify(res);
  assertMasked(text, "errorResult");
  assert.ok(!text.includes("ENOENT"));
});

test("context.errorResult: McpError сохраняет код и hint", () => {
  const res = errorResult(new McpError("TIMEOUT", "таймаут", { hint: "повторите" }));
  const payload = JSON.parse(res.content[0]!.text) as { code: string; hint?: string };
  assert.equal(payload.code, "TIMEOUT");
  assert.equal(payload.hint, "повторите");
});

test("errorToPayload: диагностический код стабилен и не зависит от канарейки", () => {
  const a = errorToPayload(new Error("внутренняя деталь"));
  const b = errorToPayload(new Error("внутренняя деталь"));
  assert.equal(a.message, b.message);
  assert.match(a.message, /ERR-[0-9a-f]{8}/);
  const c = errorToPayload(new Error(KV_AUTHKEY));
  assertMasked(JSON.stringify(c), "errorToPayload");
  assert.notEqual(a.message, c.message, "разные исключения — разные коды");
});

test("api.parseCreateResponse: неизвестное тело не отдаётся в details", () => {
  assert.throws(
    () => parseCreateResponse({ authkey: CANARY, junk: "тело-ответа-сервера" }),
    (e: unknown) => {
      const out = JSON.stringify((e as McpError).toJSON());
      assertMasked(out, "parseCreateResponse");
      assert.ok(!out.includes("тело-ответа-сервера"), "сырое тело не должно попадать в details");
      assert.ok(out.includes("SITE_ERROR"));
      return true;
    },
  );
});

test("api.unknownBodySummary: только статус, content-type и длина", () => {
  const summary = unknownBodySummary(200, "text/html; charset=utf-8", 4096);
  const text = JSON.stringify(summary);
  assert.ok(text.includes("200"));
  assert.ok(text.includes("text/html"));
  assert.ok(text.includes("4096"));
  assert.ok(!text.includes("<"), "в сводке нет фрагментов тела");
});

// ---------- Canary 35 форм (ревью 147, находка №2; все значения синтетические) ----------

const AKV = "authkey" + "=";
const C2 = "CANARY" + "_TEST_" + "4242";

/** [имя формы, функция, дающая канарейку наружу] — все 35 форм пробы probe147. */
const FORMS: Array<[string, () => unknown]> = [
  ["json spaces/newline", () => maskSecrets(`{"authkey" :\n  "${C2}"}`)],
  ["json escaped (double-stringified)", () => maskSecrets(JSON.stringify(JSON.stringify({ authkey: C2 })))],
  ["json value w/ escaped quote", () => maskSecrets(JSON.stringify({ password: `ab"${C2}` }))],
  ["url-encoded authkey%3D", () => maskSecrets(`/x?authkey%3D${C2}`)],
  ["url-encoded json", () => maskSecrets(encodeURIComponent(JSON.stringify({ authkey: C2 })))],
  ["fragment #authkey", () => maskSecrets(`https://h/p#${AKV}${C2}`)],
  ["cookie string", () => maskSecrets(`Cookie: visitor_id=1; PHPSESSID=${C2}`)],
  ["cookie remember", () => maskSecrets(`cookie: a=1; remember_me=${C2}`)],
  ["Authorization Basic b64", () => maskSecrets(`Authorization: Basic ${Buffer.from(`u:${C2}`).toString("base64")}`)],
  ["Authorization Bearer", () => maskSecrets(`Authorization: Bearer ${C2}`)],
  ["Authorization Token scheme", () => maskSecrets(`Authorization: Token ${C2}`)],
  ["Authorization Digest", () => maskSecrets(`Authorization: Digest username="u", response="${C2}"`)],
  ["x-api-key header", () => maskSecrets(`X-Api-Key: ${C2}`)],
  ["auth_key=", () => maskSecrets(`auth_key=${C2}`)],
  ["access_token=", () => maskSecrets(`access_token=${C2}`)],
  ["pass=", () => maskSecrets(`pass=${C2}`)],
  ["Playwright msg w/ url", () => maskSecrets(`page.goto: net::ERR_FAILED at https://remplanner.ru/planner/?${AKV}${C2}\nCall log:\n  - navigating to "https://remplanner.ru/planner/?${AKV}${C2}"`)],
  ["selector w/ value", () => maskSecrets(`locator.fill: Timeout 30000ms exceeded.\n  - waiting for locator('input[name=password][value="${C2}"]')`)],
  ["deep AUTHKEY", () => maskSecretsDeep({ AUTHKEY: C2 })],
  ["deep authKey", () => maskSecretsDeep({ authKey: C2 })],
  ["deep access_token", () => maskSecretsDeep({ access_token: C2 })],
  ["deep x-auth-token", () => maskSecretsDeep({ "x-auth-token": C2 })],
  ["deep refresh_token", () => maskSecretsDeep({ refresh_token: C2 })],
  ["deep client_secret", () => maskSecretsDeep({ client_secret: C2 })],
  ["deep PHPSESSID", () => maskSecretsDeep({ PHPSESSID: C2 })],
  ["deep nested arrays", () => maskSecretsDeep([[{ x: [[{ authkey: C2 }]] }]])],
  ["deep headers array pair", () => maskSecretsDeep([["authorization", C2]])],
  ["deep headers obj list", () => maskSecretsDeep([{ name: "authkey", value: C2 }])],
  ["deep Map", () => maskSecretsDeep(new Map([["authkey", C2]]))],
  ["deep URL obj", () => maskSecretsDeep({ url: new URL(`https://h/?${AKV}${C2}`) })],
  ["Error w/ cause", () => errorToPayload(new Error("x", { cause: new Error(`${AKV}${C2}`) }))],
  ["AggregateError", () => errorToPayload(new AggregateError([new Error(C2)], `token ${C2}`))],
  ["McpError details Error obj", () => new McpError("SITE_ERROR", "x", { details: { err: Object.assign(new Error(C2), { url: `https://h/?q=${C2}` }) } }).toJSON()],
  ["McpError details url-encoded", () => new McpError("SITE_ERROR", "x", { details: { path: `/a?authkey%3D${C2}` } }).toJSON()],
  ["plain NOT_FOUND w/ secret", () => errorToPayload(Object.assign(new Error(`${AKV}${C2} raw ${C2}`), { code: "NOT_FOUND" }))],
];

for (const [name, make] of FORMS) {
  test(`canary 35: ${name} — канарейка не проходит`, () => {
    assertMasked(JSON.stringify(make()), name, C2);
  });
}

test("canary 35: повтор CANARY_SECRET_7771002 без ключа тоже маскируется", () => {
  // значение, найденное после секретного ключа, маскируется во всём тексте
  assertMasked(maskSecrets(`ответ для ${AKV}${CANARY}; см. ${CANARY} в дампе`), "value repeat");
});

test("canary 35: маскировщик устойчив к ReDoS — 100 КБ быстрее 50 мс", () => {
  for (const [nm, str] of [
    ["token=\"", 'token="'.repeat(12_500)],
    ["bearer ", "bearer ".repeat(15_000)],
    ["token: :", "token" + " ".repeat(100_000) + "x"],
    ["authauth", "auth".repeat(25_000)],
    ["percent", "%22%3A%22".repeat(12_500)],
  ] as const) {
    const t0 = performance.now();
    maskSecrets(str);
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `${nm}: maskSecrets на ${str.length} байтах занял ${ms.toFixed(1)} мс`);
  }
});

test("ревью 147 №5: errorToPayload(null/undefined) безопасен", () => {
  for (const v of [null, undefined, 42, "строка"]) {
    const p = errorToPayload(v);
    assert.equal(p.code, "INTERNAL");
    assert.match(p.message, /ERR-[0-9a-f]{8}/);
  }
});

test("ревью 147 №6: диагностический текст не маскируется, объектные значения — рекурсивно", () => {
  // левая граница слова: «relogin» — не «login»
  assert.equal(maskSecrets("relogin: через 10 минут"), "relogin: через 10 минут");
  assert.equal(maskSecrets("author: Иванов"), "author: Иванов");
  assert.equal(maskSecrets("tokens=5"), "tokens=5");
  assert.equal(maskSecrets("sessions: 3"), "sessions: 3");
  const out = maskSecretsDeep({ session: { object_id: 1, plan_id: 2 }, auth: { logged_in: true }, token: 3 }) as Record<string, unknown>;
  assert.deepEqual(out.session, { object_id: 1, plan_id: 2 }, "объект под секретным ключом маскируется рекурсивно, а не целиком");
  assert.deepEqual(out.auth, { logged_in: true });
  assert.equal(out.token, "***");
});

test("ревью 147 №7: диагностический код не зависит от секрета в сообщении", () => {
  // одно и то же сообщение с разными секретами даёт один код (нет оракула перебора)
  const a = errorToPayload(new Error(`${AKV}${C2}`));
  const b = errorToPayload(new Error(AKV + "ДРУГОЙ_СЕКРЕТ_9183"));
  assert.equal(a.message, b.message);
});
