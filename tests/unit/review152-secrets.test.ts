// Ревью 152 (раунд 3): M4 — kv-правило матчит ключ целиком и проверяет isSecretKey
// (суффиксы после секретного слова и цифры маскируются в тексте и details);
// m7 — разбиение аббревиатур (APIToken), m8 — нет ложного маскирования
// sortKey/tokenCount, m9 — одно kv-правило (повтор после camel-ключа),
// m10 — export в несуществующий каталог. Все значения синтетические (canary
// собирается из частей, чтобы в исходнике не было литералов для secret-scan).
import test from "node:test";
import assert from "node:assert/strict";
import { maskSecrets, maskSecretsDeep, isSecretKey } from "../../src/errors.ts";

const C = "CANARY" + "_TEST_" + "4242";

function assertMasked(out: unknown, where: string, needle: string = C): void {
  const s = typeof out === "string" ? out : JSON.stringify(out);
  assert.ok(!s.includes(needle), `${where}: canary просочился: ${s}`);
}

// ---------- M4: 43 ключа × 6 форм (проба probe152 ревью 152) ----------

/** Все ключи пробы probe152: snake, kebab, SCREAMING, цифры, Pascal/аббревиатуры, dotted. */
const KEYS = [
  // snake
  "access_token", "client_secret", "api_key", "x_api_key", "user_password", "session_token",
  "auth_token", "refresh_token_v2",
  // kebab
  "x-auth-token", "access-token", "x-csrf-token", "api-key", "x-session-id",
  // SCREAMING
  "ACCESS_TOKEN", "REMPLANNER_PASSWORD", "API_KEY", "AUTH_TOKEN", "CLIENT_SECRET", "SESSION_ID",
  "X_API_KEY",
  // цифры
  "token2", "apiKey2", "auth0Token", "accessToken1", "password1", "x-api-key-2", "token_v2",
  "oauth2Token", "s3SecretKey",
  // Pascal / аббревиатуры
  "AccessToken", "XAuthToken", "APIKey", "APIToken", "JWTToken", "OAuthToken", "ClientSecret",
  "SessionID", "CSRFToken", "XSRFToken",
  // dotted / прочие
  "auth.token", "config.password", "credentials.password",
];

test("ревью 152 M4: все ключи пробы × 6 форм — канарейка не проходит", () => {
  for (const k of KEYS) {
    assertMasked(maskSecrets(`${k}=${C}`), `text ${k}=`);
    assertMasked(maskSecrets(`err ${k}: ${C} end`), `text ${k}: `);
    assertMasked(maskSecrets(`{"${k}":"${C}"}`), `json "${k}"`);
    assertMasked(maskSecrets(JSON.stringify(JSON.stringify({ [k]: C }))), `json-esc "${k}"`);
    assertMasked(maskSecrets(`GET /api?x=1&${k}=${C}&y=2`), `query ?${k}=`);
    assertMasked(maskSecretsDeep({ [k]: C }), `deep {${k}}`);
  }
});

test("ревью 152 M4: суффиксы и цифры в details маскируются по isSecretKey", () => {
  for (const k of ["session_id", "SECRET_KEY", "token2", "password1", "access_key_id", "client_secret_v2", "x-api-key-2"]) {
    assertMasked(maskSecretsDeep({ [k]: C }), `deep ${k}`);
  }
});

test("ревью 152 M4: camelCase-ключи без разделителей (js-объект, python-repr)", () => {
  assertMasked(maskSecrets(`{accessToken: '${C}'}`), "js obj unquoted");
  assertMasked(maskSecrets(`{'accessToken': '${C}'}`), "python repr");
});

// ---------- m9: повтор значения после camel-ключа ----------

test("ревью 152 m9: значение после camel-ключа затирается и без ключа", () => {
  assertMasked(maskSecrets(`accessToken=${C}LONGVALUE then again ${C}LONGVALUE`), "repeat after camel");
});

// ---------- m7: аббревиатуры в details ----------

test("ревью 152 m7: APIToken/JWTToken/CSRFToken/XSRFToken маскируются в details", () => {
  for (const k of ["APIToken", "JWTToken", "CSRFToken", "XSRFToken"]) {
    assertMasked(maskSecretsDeep({ [k]: C }), `deep ${k}`);
    assert.ok(isSecretKey(k), `isSecretKey(${k})`);
  }
});

// ---------- M4: вложенная пара внутри значения не-секретного ключа ----------

test("ревью 152 M4: секретная пара внутри значения не-секретного ключа маскируется", () => {
  // матч не должен «съедать» value не-секретного ключа целиком
  assertMasked(maskSecrets("details: password" + `=${C}`), "nested after details:");
  assertMasked(maskSecrets(`{"error":"authkey` + `=${C}"}`), "nested in json string value");
  assertMasked(maskSecrets(`msg: see token=${C} in log`), "nested in text value");
});

// ---------- фикс №6 и m8: ложных срабатываний нет ----------

test("ревью 152: фикс №6 сохранён — диагностические строки не маскируются", () => {
  const same = [
    "relogin: через 10 минут", "author: Иван", "tokens=5", "sessions: 3", "npm run login",
    "запустите npm run login, затем auth_status", "authorName: Иван", "sessionsCount: 3",
    "secretary: Анна", "monkey=1", "whiskey: 2", "turkey: 3", "keyboard: ru", "authorized: true",
    "passed: 12/12", "tokenizer: ok", "keyPoint: (100, 200)", "isSessionValid: false",
  ];
  for (const s of same) assert.equal(maskSecrets(s), s, s);
});

test("ревью 152 m8: sortKey/tokenCount и подобные не маскируются (текст и isSecretKey)", () => {
  const same = [
    "sortKey: W12", "primaryKey: R3", "hotKey: ctrl", "passCount: 4", "loginAttempts: 3",
    "authMode: none", "tokenCount: 5", "roomKey: R12, wallKey: W7", "cacheKey=project-123",
  ];
  for (const s of same) assert.equal(maskSecrets(s), s, s);
  for (const k of ["sortKey", "primaryKey", "hotKey", "passCount", "loginAttempts", "authMode", "tokenCount", "roomKey", "wallKey", "cacheKey", "keyPoint", "sessions", "tokens", "author", "relogin", "sessionsCount"]) {
    assert.ok(!isSecretKey(k), `isSecretKey(${k}) должен быть false`);
  }
  // секретные ключи остаются секретными
  for (const k of ["session_id", "secret_key", "token2", "password1", "apiKey2", "accessToken", "s3SecretKey"]) {
    assert.ok(isSecretKey(k), `isSecretKey(${k}) должен быть true`);
  }
});

test("ревью 152: sessionId — секрет, координаты и значения W/R целы", () => {
  assertMasked(maskSecrets("sessionId: R3"), "sessionId");
  const out = maskSecrets("stena W12 ne naydena (W1, W2, R3); wall_id: W12, room_id: R3, at_mm: 1500");
  assert.equal(out, "stena W12 ne naydena (W1, W2, R3); wall_id: W12, room_id: R3, at_mm: 1500");
  assert.ok(maskSecrets("pass: 1000 … координаты 1000").includes("координаты 1000"));
});

// ---------- m10: export в несуществующий подкаталог корня plans ----------

// 213 plans-root: подкаталоги внутри корня plans export создаёт (0700); прежний
// NOT_FOUND «путь не найден» остаётся для путей, где создание невозможно.
test("ревью 152 m10: export в несуществующий подкаталог plans — каталог создан, ответ без абсолюта вне plans", async () => {
  const { mkdirSync, existsSync, rmSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { ServerContext } = await import("../../src/server/context.ts");
  const { buildServer } = await import("../../src/server.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { PLANS_DIR } = await import("../../src/config.ts");
  const rel = "rev152-m10/nested/x.plan";
  const ctx = new ServerContext({ offlineFixture: join(import.meta.dirname, "..", "..", "tests", "fixtures", "anon-rect-4000x3000.json") });
  const server = buildServer(ctx);
  const client = new Client({ name: "review152", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const res = await client.callTool({ name: "project_export_plan", arguments: { path: rel } });
    const payload = JSON.parse(((res as { content: Array<{ text: string }> }).content[0] as { text: string }).text) as { code?: string; path?: string };
    assert.equal(payload.code, undefined, JSON.stringify(payload));
    assert.ok(existsSync(join(PLANS_DIR, rel)), "файл создан в подкаталоге plans");
    assert.equal(statSync(join(PLANS_DIR, "rev152-m10", "nested")).mode & 0o777, 0o700, "подкаталог 0700");
  } finally {
    await client.close();
    rmSync(join(PLANS_DIR, "rev152-m10"), { recursive: true, force: true });
  }
});

// ---------- ReDoS: новые паттерны kv-правила на 100 КБ ----------

const REDOS_CASES = [
  ["kv chain a=a=a=", "a=a=".repeat(25_000)],
  ["kv chain a:b:c:d:", "a:b:c:d:".repeat(20_000)],
  ["kv pairs spaces", "k1=v1 k2:v2 ".repeat(8_000)],
  ["long key no sep", ("x".repeat(50_000) + ": ").repeat(2)],
  ["long value no sep", "token=" + "v".repeat(100_000)],
  ["quote no close", 'token="' + "v".repeat(100_000)],
  ["mixed kv junk", "a.b-c_d=e.f:g; ".repeat(7_000)],
] as const;

test("ревью 152 M4: ReDoS — 100 КБ быстрее 200 мс (медиана 5 прогонов после прогрева)", () => {
  // устойчивость к шуму параллельных тестов (169-b5b6): прогрев JIT, медиана
  // 5 прогонов и порог с запасом против квадратичного случая — тот занимал
  // секунды на этих же входах, линейный вариант проходит за единицы мс
  const t = (str: string): number => {
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      maskSecrets(str);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return (times[2]! + times[3]!) / 2;
  };
  // прогрев на первом (самом дешёвом) входе
  t(REDOS_CASES[0]![1].slice(0, 1000));
  for (const [nm, str] of REDOS_CASES) {
    const ms = t(str);
    assert.ok(ms < 200, `${nm}: maskSecrets на ${str.length} байтах занял ${ms.toFixed(1)} мс`);
  }
});
