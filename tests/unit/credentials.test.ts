import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpError } from "../../src/errors.ts";
import { maskValue, parseEnvFile, readCredentials, scrubSecrets } from "../../src/credentials.ts";
import { saveSession, loadSession, hasLiveCookies, isExpired, cookieHeader, type SessionState } from "../../src/session.ts";

test("parseEnvFile: кавычки, комментарии, пустые строки", () => {
  const env = parseEnvFile(
    [
      "# комментарий",
      "",
      "REMPLANNER_LOGIN='user@example.com'",
      'REMPLANNER_PASSWORD="p@ss word"',
      "  SPACED =  value  ",
      "NOEQ",
    ].join("\n"),
  );
  assert.deepEqual(env, {
    REMPLANNER_LOGIN: "user@example.com",
    REMPLANNER_PASSWORD: "p@ss word",
    SPACED: "value",
  });
});

test("maskValue не раскрывает значение", () => {
  assert.equal(maskValue("secret-password"), "s***d");
  assert.equal(maskValue("ab"), "***");
  assert.ok(!maskValue("secret-password").includes("ecret"));
});

test("readCredentials читает пару логин/пароль", () => {
  const dir = mkdtempSync(join(tmpdir(), "remplanner-test-"));
  const path = join(dir, "credentials.env");
  writeFileSync(path, "REMPLANNER_LOGIN=user@example.com\nREMPLANNER_PASSWORD=s3cret\n");
  chmodSync(path, 0o600);
  const creds = readCredentials(path);
  assert.equal(creds.login, "user@example.com");
  assert.equal(creds.password, "s3cret");
});

test("readCredentials: нет файла → AUTH_REQUIRED без содержимого", () => {
  assert.throws(() => readCredentials("/nonexistent/path/credentials.env"), (e: McpError) => e.code === "AUTH_REQUIRED");
});

test("readCredentials: пустые значения → AUTH_REQUIRED", () => {
  const dir = mkdtempSync(join(tmpdir(), "remplanner-test-"));
  const path = join(dir, "credentials.env");
  writeFileSync(path, "REMPLANNER_LOGIN=\nREMPLANNER_PASSWORD=x\n");
  chmodSync(path, 0o600);
  assert.throws(() => readCredentials(path), (e: McpError) => e.code === "AUTH_REQUIRED");
});

test("scrubSecrets убирает логин и пароль из текста", () => {
  const creds = { login: "user@example.com", password: "s3cret" };
  const out = scrubSecrets("POST email=user@example.com password" + "=s3cret&x=1", creds);
  assert.ok(!out.includes("user@example.com"));
  assert.ok(!out.includes("s3cret"));
  assert.ok(out.includes("login" + "=***") && out.includes("password" + "=***"));
});

test("ошибка readCredentials не содержит значения пароля (через assert.throws, №17 ревью)", () => {
  const dir = mkdtempSync(join(tmpdir(), "remplanner-test-"));
  const path = join(dir, "credentials.env");
  // ошибочный путь: нет пароля; «хвостатое» значение в комментарии не должно утечь в ошибку
  writeFileSync(path, "# password" + "=topsecretvalue\nREMPLANNER_LOGIN=a\n");
  chmodSync(path, 0o600);
  assert.throws(() => readCredentials(path), (e: McpError) => {
    const json = JSON.stringify(e.toJSON());
    return e.code === "AUTH_REQUIRED" && !json.includes("topsecretvalue");
  });
});

test("№17: сериализованные McpError не содержат секретов в query и деталях", async () => {
  const { safePath } = await import("../../src/http.ts");
  const sentinel = "authkey-sentinel-abc";
  const err = new McpError("SITE_ERROR", `сбой на ${safePath(`/save/?authk` + `ey=${sentinel}&x=1`)}`, {
    details: { note: "body скрыт" },
  });
  const json = JSON.stringify(err.toJSON());
  assert.ok(!json.includes(sentinel));
});

test("№17: scrubSecrets чистит ошибки, собранные из ответа с credentials-подобными полями", () => {
  const creds = { login: "secret-login", password: "secret-pass" };
  const raw = "authk" + "ey=zzz; email=secret-login; password" + "=secret-pass";
  const cleaned = scrubSecrets(raw, creds);
  assert.ok(!cleaned.includes("secret-login") && !cleaned.includes("secret-pass"));
});

const tmp = mkdtempSync(join(tmpdir(), "remplanner-test-"));

function makeState(expiresSec: number): SessionState {
  return {
    cookies: [
      { name: "authcp", value: "v1", domain: ".remplanner.ru", path: "/", expires: expiresSec },
      { name: "session_tmp", value: "v2", domain: "remplanner.ru", path: "/", expires: -1 },
    ],
  };
}

test("saveSession пишет state.json с правами 0600, loadSession читает", () => {
  const path = join(tmp, "state.json");
  saveSession(path, makeState(Math.floor(Date.now() / 1000) + 3600));
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
  const state = loadSession(path);
  assert.equal(state.cookies.length, 2);
  assert.ok(readFileSync(path, "utf8").includes("authcp"));
});

test("loadSession: нет файла → AUTH_REQUIRED", () => {
  assert.throws(() => loadSession(join(tmp, "missing.json")), (e: McpError) => e.code === "AUTH_REQUIRED");
});

test("hasLiveCookies/isExpired по сроку", () => {
  const fresh = makeState(Math.floor(Date.now() / 1000) + 3600);
  assert.equal(isExpired(fresh), false);
  const datedOnly = (expires: number): SessionState => ({
    cookies: [{ name: "authcp", value: "v1", domain: ".remplanner.ru", path: "/", expires }],
  });
  assert.equal(isExpired(datedOnly(Math.floor(Date.now() / 1000) - 10)), true);
  assert.equal(isExpired(datedOnly(Math.floor(Date.now() / 1000) + 10)), false);
  // сессионные cookies (-1) считаются живыми
  assert.equal(hasLiveCookies(datedOnly(-1)), true);
});

test("cookieHeader собирает живые cookies по домену", () => {
  const state = makeState(Math.floor(Date.now() / 1000) + 3600);
  const header = cookieHeader(state, "remplanner.ru");
  assert.equal(header, "authcp=v1; session_tmp=v2");
  const expired = {
    cookies: [
      { name: "authcp", value: "v1", domain: ".remplanner.ru", path: "/", expires: Math.floor(Date.now() / 1000) - 10 },
      { name: "session_tmp", value: "v2", domain: "remplanner.ru", path: "/", expires: -1 },
    ],
  };
  assert.equal(cookieHeader(expired, "remplanner.ru"), "session_tmp=v2");
  assert.equal(cookieHeader(state, "example.com"), "");
});
