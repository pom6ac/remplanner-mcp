// Ревью 150 (раунд 2): M1 — обход маскирования через camelCase- и составные ключи,
// M2 — квадратичный ReDoS в COOKIE_PAIR_RE, minor m1–m3, m6. Все значения синтетические
// (canary собирается из частей, чтобы в исходнике не было литералов для secret-scan).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { maskSecrets, maskSecretsDeep } from "../../src/errors.ts";

const C = "CANARY" + "_TEST_" + "4242";

function assertMasked(out: unknown, where: string, needle: string = C): void {
  const s = typeof out === "string" ? out : JSON.stringify(out);
  assert.ok(!s.includes(needle), `${where}: canary просочился: ${s}`);
}

// ---------- M1: camelCase и составные ключи в тексте ----------

test("ревью 150 M1: camelCase-ключи в тексте маскируются", () => {
  assertMasked(maskSecrets(`{"accessToken":"${C}"}`), "accessToken json");
  assertMasked(maskSecrets(`authToken=${C}`), "authToken kv");
  assertMasked(maskSecrets(`sessionToken: ${C}`), "sessionToken kv");
  assertMasked(maskSecrets(`userPassword=${C}`), "userPassword kv");
  assertMasked(maskSecrets(`xApiKey=${C}`), "xApiKey kv");
  assertMasked(maskSecrets(`sessionId=${C}`), "sessionId kv");
  assertMasked(maskSecrets(`clientSecret=${C}`), "clientSecret kv");
  assertMasked(maskSecrets(`refreshToken=${C}`), "refreshToken kv");
  assertMasked(maskSecrets(`csrfToken=${C}`), "csrfToken kv");
  assertMasked(maskSecrets(`userSession=${C}`), "userSession kv");
});

test("ревью 150 M1: camelCase-ключи в details маскируются", () => {
  for (const key of [
    "accessToken", "authToken", "refreshToken", "csrfToken", "sessionKey",
    "clientSecret", "sessionId", "userPassword", "xApiKey",
  ]) {
    assertMasked(maskSecretsDeep({ [key]: C }), `deep ${key}`);
  }
});

test("ревью 150 M1: фикс №6 сохранён — relogin, author, tokens, sessions, npm run login не маскируются", () => {
  assert.equal(maskSecrets("relogin: через 10 минут"), "relogin: через 10 минут");
  assert.equal(maskSecrets("author: Иванов"), "author: Иванов");
  assert.equal(maskSecrets("tokens=5"), "tokens=5");
  assert.equal(maskSecrets("sessions: 3"), "sessions: 3");
  assert.equal(maskSecrets("npm run login"), "npm run login");
  assert.equal(maskSecrets("plan_id: 5"), "plan_id: 5");
});

test("ревью 150 M1: camelCase в JSON с экранированными кавычками", () => {
  assertMasked(maskSecrets(JSON.stringify(JSON.stringify({ accessToken: C }))), "escaped accessToken");
});

// ---------- M2: ReDoS в cookie-правиле ----------

test("ревью 150 M2: cookie с длинным именем — линейное время (<50 мс на 100 КБ)", () => {
  for (const [nm, str] of [
    ["cookie: long name", "cookie: " + "a".repeat(100_000)],
    ["Set-Cookie: long name", "Set-Cookie: " + "a".repeat(20_000)],
    ["cookie url-encoded long", "cookie%3A%20" + "a".repeat(20_000)],
  ] as const) {
    const t0 = performance.now();
    maskSecrets(str);
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `${nm}: maskSecrets на ${str.length} байтах занял ${ms.toFixed(1)} мс`);
  }
});

// ---------- minor m1: тройное URL-кодирование ----------

test("ревью 150 m1: нормализация до неподвижной точки — тройное URL-кодирование", () => {
  assertMasked(maskSecrets(`/x?authkey%25253D${C}`), "triple-encoded");
});

// ---------- minor m2: свёрнутый (obs-fold) Authorization ----------

test("ревью 150 m2: obs-fold в Authorization маскируется целиком", () => {
  assertMasked(maskSecrets(`Authorization: Bearer\r\n  ${C}`), "folded authorization");
  assert.ok(!maskSecrets(`Authorization: Bearer\r\n  ${C}`).includes("Bearer\r\n  ***"), "затираться должен токен, а не слово Bearer");
});

// ---------- minor m3: секрет в имени ключа объекта ----------

test("ревью 150 m3: имя ключа объекта с секретом маскируется", () => {
  const out = maskSecretsDeep({ [`/p?authkey=${C}`]: 1 }) as Record<string, unknown>;
  assertMasked(out, "object key");
  assert.ok(!JSON.stringify(Object.keys(out)).includes(C), "значение секрета ушло и из имени ключа");
});

// ---------- minor m6: повтор значения затирается только для секретоподобных ----------

test("ревью 150 m6: короткое/числовое значение после ключа не затирает повторы во всём тексте", () => {
  const out = maskSecrets("pass: 1000 … координаты 1000 и ещё true true");
  assert.ok(!out.includes("pass: 1000"), "значение после ключа маскируется на месте");
  assert.ok(out.includes("координаты 1000"), "повтор числа не затирается");
});

// ---------- minor m6: grep-сторож — в src нет throw new Error вне разрешённых мест ----------

const SRC_ROOT = join(import.meta.dirname, "..", "..", "src");
/** Разрешённые места throw new Error: стартовая ошибка окружения, не пользовательский ввод. */
const ALLOWED = new Set([join("src", "config.ts")]);

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSources(p));
    else if (/\.(ts|js)$/.test(name)) out.push(p);
  }
  return out;
}

test("ревью 150 m6: в src нет throw new Error вне разрешённых мест (grep-сторож)", () => {
  const offenders: string[] = [];
  for (const file of listSources(SRC_ROOT)) {
    const text = readFileSync(file, "utf8");
    if (/throw new Error\(|throw Error\(/.test(text) && !ALLOWED.has(file.slice(SRC_ROOT.length - "src".length))) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});
