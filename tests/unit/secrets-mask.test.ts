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

function assertMasked(text: string, where: string): void {
  assert.ok(!text.includes(CANARY), `${where}: canary просочился в ответ: ${text}`);
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
