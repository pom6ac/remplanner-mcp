// Ревью 155 (раунд 5): закрытие находок ревью 154 — M5 (ReDoS в разбиении
// аббревиатур isSecretKey), M6 (предфильтр по сырому ключу обходит camelCase
// в тексте и query), m11 (camelCase-продолжение секретного слова — секретно
// по умолчанию, fail-closed; несекретные продолжения — явный короткий список).
// Все значения синтетические (canary собирается из частей, чтобы в исходнике
// не было литералов для secret-scan).
import test from "node:test";
import assert from "node:assert/strict";
import { maskSecrets, maskSecretsDeep, isSecretKey } from "../../src/errors.ts";

const C = "CANARY" + "_TEST_" + "4242";

function assertMasked(out: unknown, where: string, needle: string = C): void {
  const s = typeof out === "string" ? out : JSON.stringify(out);
  assert.ok(!s.includes(needle), `${where}: canary просочился: ${s.slice(0, 120)}`);
}

// ---------- M6: предфильтр по сырому ключу убран ----------

test("ревью 155 M6: camelCase-формы accessKey маскируются в тексте и query", () => {
  for (const k of ["accessKey", "AccessKey", "awsAccessKey", "s3AccessKey", "accessKeyId"]) {
    assertMasked(maskSecrets(`err ${k}=${C} end`), `text ${k}=`);
    assertMasked(maskSecrets(`/x?a=1&${k}=${C}&y=2`), `query ${k}=`);
    assertMasked(maskSecrets(`err ${k}: ${C} end`), `text ${k}: `);
    assert.ok(isSecretKey(k), `isSecretKey(${k})`);
  }
});

// ---------- m11: продолжение после секретного слова — секретно по умолчанию ----------

const M11_SECRET = [
  "passwordHash", "passwordConfirm", "passwordConfirmation", "tokenValue", "tokenString",
  "secretValue", "secretData", "authHeader", "authorizationHeader", "authCode", "authValue",
  "cookieValue", "cookieHeader", "sessionData", "sessionValue", "jwtValue", "csrfValue",
  "privateKey", "private_key", "PRIVATE_KEY",
] as const;

test("ревью 155 m11: camelCase-продолжения секретного слова маскируются во всех формах", () => {
  for (const k of M11_SECRET) {
    assertMasked(maskSecrets(`err ${k}=${C} end`), `text ${k}=`);
    assertMasked(maskSecrets(`err ${k}: ${C} end`), `text ${k}: `);
    assertMasked(maskSecrets(JSON.stringify({ [k]: C })), `json "${k}"`);
    assertMasked(maskSecretsDeep({ [k]: C }), `deep {${k}}`);
    assert.ok(isSecretKey(k), `isSecretKey(${k})`);
  }
});

test("ревью 155 m11: несекретные продолжения не маскируются (текст и isSecretKey)", () => {
  const same = [
    "sortKey: W12", "tokenCount: 5", "authMode: none", "loginAttempts: 3", "passCount: 4",
    "isSessionValid: false", "tokenType: bearer", "sessionStatus: ok", "loginRequired: true",
  ];
  for (const s of same) assert.equal(maskSecrets(s), s, s);
  for (const k of ["sortKey", "tokenCount", "authMode", "loginAttempts", "passCount", "tokenType", "sessionStatus", "passwordExpires", "keyPoint"]) {
    assert.ok(!isSecretKey(k), `isSecretKey(${k}) должен быть false`);
  }
});

// ---------- M5: ReDoS в разбиении аббревиатур — 100 КБ быстрее 50 мс ----------

const UPPER = "A".repeat(100_000);

test("ревью 155 M5: ключ из 100 КБ заглавных в тексте, JSON и details — быстрее 50 мс", () => {
  const t = (fn: () => unknown): number => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      fn();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const cases: Array<[string, () => unknown]> = [
    ["isSecretKey", () => isSecretKey(UPPER)],
    ["text", () => maskSecrets(`${UPPER}=1`)],
    ["text after token", () => maskSecrets(`token${UPPER}=1`)],
    ["json", () => maskSecrets(JSON.stringify({ [UPPER]: "v" }))],
    ["deep", () => maskSecretsDeep({ [UPPER]: "v" })],
  ];
  for (const [nm, fn] of cases) {
    const ms = t(fn);
    assert.ok(ms < 50, `${nm}: 100 КБ заглавных занял ${ms.toFixed(1)} мс`);
  }
});

test("ревью 155 M5: аббревиатуры по-прежнему маскируются после смены разбиения", () => {
  for (const k of ["APIToken", "JWTToken", "CSRFToken", "XSRFToken", "APIKey", "SessionID", "OAuthToken", "HTTPSProxyAuthToken"]) {
    assert.ok(isSecretKey(k), `isSecretKey(${k})`);
    assertMasked(maskSecretsDeep({ [k]: C }), `deep ${k}`);
  }
});
