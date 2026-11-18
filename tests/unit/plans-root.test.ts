// 213 plans-root (аудит 65 B3, решение пользователя): политика корневого каталога
// import/export — пути tools project_export_plan/project_import_plan относительно
// корня <home>/plans (REMPLANNER_HOME/plans в тестах). Отказ при выходе за корень,
// symlink в компонентах пути, не-.plan расширении; позитивные сценарии и roundtrip.
// Офлайн: сеть не используется, состояние — во временном HOME (helpers/tmp-home).
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { resolvePlanPath } from "../../src/server/tools-projects.ts";
import { HOME_DIR, PLANS_DIR } from "../../src/config.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as ToolCallResult).content as { text: string }[])[0]!.text;
const parsed = (r: unknown): Record<string, unknown> => JSON.parse(text(r)) as Record<string, unknown>;

async function start(): Promise<Client> {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "plans-root", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

/** Вызов инструмента, который обязан вернуть структурированную ошибку. */
async function callError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ code: string; message: string }> {
  const r = await client.callTool({ name, arguments: args });
  assert.ok((r as ToolCallResult).isError, `${name}: ожидалась ошибка`);
  return JSON.parse(text(r)) as { code: string; message: string };
}

const mode = (p: string): number => statSync(p).mode & 0o777;
const inside = (p: string): boolean => p.startsWith(PLANS_DIR + "/");

test("plans-root: export по относительному пути — файл в корне plans (0600, каталог 0700), ответ с path и relative_path", async () => {
  const client = await start();
  try {
    const res = parsed(await client.callTool({ name: "project_export_plan", arguments: { path: "kitchen.plan" } }));
    assert.equal(res["relative_path"], "kitchen.plan");
    assert.ok(typeof res["path"] === "string" && inside(res["path"] as string), "path — абсолютный внутри plans");
    assert.equal(res["path"], join(PLANS_DIR, "kitchen.plan"));
    assert.ok(existsSync(join(PLANS_DIR, "kitchen.plan")));
    assert.equal(mode(PLANS_DIR), 0o700, "корень plans 0700");
    assert.equal(mode(join(PLANS_DIR, "kitchen.plan")), 0o600, "файл плана 0600");
  } finally {
    await client.close();
  }
});

test("plans-root: export в подкаталог — каталог создаётся внутри корня с 0700", async () => {
  const client = await start();
  try {
    const res = parsed(await client.callTool({ name: "project_export_plan", arguments: { path: "2026/kitchen.plan" } }));
    assert.equal(res["relative_path"], "2026/kitchen.plan");
    assert.ok(existsSync(join(PLANS_DIR, "2026", "kitchen.plan")));
    assert.equal(mode(join(PLANS_DIR, "2026")), 0o700);
  } finally {
    await client.close();
  }
});

test("plans-root: абсолютный путь внутри корня принимается", async () => {
  const client = await start();
  try {
    const abs = join(PLANS_DIR, "abs.plan");
    const res = parsed(await client.callTool({ name: "project_export_plan", arguments: { path: abs } }));
    assert.equal(res["path"], abs);
    assert.equal(res["relative_path"], "abs.plan");
    assert.ok(existsSync(abs));
  } finally {
    await client.close();
  }
});

test("plans-root: roundtrip export → import, imported с path и relative_path", async () => {
  const client = await start();
  try {
    await client.callTool({ name: "project_export_plan", arguments: { path: "roundtrip.plan" } });
    // правим модель, чтобы импорт что-то заменял
    await client.callTool({ name: "project_clear", arguments: { confirm: true } });
    const res = parsed(await client.callTool({ name: "project_import_plan", arguments: { path: "roundtrip.plan", replace: true } }));
    assert.equal(res["relative_path"], "roundtrip.plan");
    assert.ok(typeof res["imported"] === "string" && inside(res["imported"] as string), "imported — абсолютный внутри plans");
    assert.equal(res["imported"], join(PLANS_DIR, "roundtrip.plan"));
    assert.ok(Number(res["walls"]) > 0, "стены импортированы");
  } finally {
    await client.close();
  }
});

test("plans-root: ../x.plan отклонён, файл вне корня не создан", async () => {
  const client = await start();
  try {
    const err = await callError(client, "project_export_plan", { path: "../x.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /корень/);
    assert.ok(!existsSync(join(HOME_DIR, "x.plan")), "файл вне корня не создан");
  } finally {
    await client.close();
  }
});

test("plans-root: абсолютный путь вне корня отклонён, файл не создан", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-outside-"));
  try {
    const outside = join(outsideDir, "x.plan");
    const err = await callError(client, "project_export_plan", { path: outside });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.ok(!existsSync(outside), "файл вне корня не создан");
  } finally {
    await client.close();
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("plans-root: a/../../x.plan отклонён, файл вне корня не создан", async () => {
  const client = await start();
  try {
    const err = await callError(client, "project_export_plan", { path: "a/../../x.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.ok(!existsSync(join(HOME_DIR, "x.plan")), "файл вне корня не создан");
    assert.ok(!existsSync(join(PLANS_DIR, "a")), "промежуточный каталог не создан");
  } finally {
    await client.close();
  }
});

test("plans-root: import ../out.plan отклонён до чтения, файл вне корня не читается и не меняется", async () => {
  const client = await start();
  try {
    const outside = join(HOME_DIR, "out.plan");
    writeFileSync(outside, '{"walls":{}}');
    const before = readFileSync(outside, "utf8");
    const err = await callError(client, "project_import_plan", { path: "../out.plan", replace: true });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /корень/);
    assert.equal(readFileSync(outside, "utf8"), before, "файл вне корня не тронут");
  } finally {
    await client.close();
  }
});

test("plans-root: symlink-каталог внутри корня, указывающий наружу, отклонён; цель ссылки не тронута", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-link-out-"));
  try {
    symlinkSync(outsideDir, join(PLANS_DIR, "link"));
    const err = await callError(client, "project_export_plan", { path: "link/x.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /символическую ссылку/);
    assert.deepEqual(readdirSync(outsideDir), [], "в цель ссылки ничего не записано");
    // и import через symlink-каталог отклонён
    const err2 = await callError(client, "project_import_plan", { path: "link/x.plan", replace: true });
    assert.equal(err2.code, "INVALID_ARGUMENT");
  } finally {
    await client.close();
    rmSync(join(PLANS_DIR, "link"), { force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("plans-root: symlink-файл внутри корня отклонён (export и import), цель ссылки не тронута", async () => {
  const client = await start();
  try {
    const real = join(PLANS_DIR, "real.plan");
    writeFileSync(real, '{"walls":{}}');
    const link = join(PLANS_DIR, "link.plan");
    symlinkSync(real, link);
    const err = await callError(client, "project_export_plan", { path: "link.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /символическую ссылку/);
    const err2 = await callError(client, "project_import_plan", { path: "link.plan", replace: true });
    assert.equal(err2.code, "INVALID_ARGUMENT");
    assert.equal(readFileSync(real, "utf8"), '{"walls":{}}', "цель ссылки не перезаписана");
    assert.ok(lstatSync(link).isSymbolicLink(), "ссылка не заменена файлом");
  } finally {
    await client.close();
  }
});

test("plans-root: расширение не .plan отклонено, файл не создан", async () => {
  const client = await start();
  try {
    const err = await callError(client, "project_export_plan", { path: "kitchen.json" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /\.plan/);
    const err2 = await callError(client, "project_import_plan", { path: "kitchen.json", replace: true });
    assert.equal(err2.code, "INVALID_ARGUMENT");
    assert.ok(!existsSync(join(PLANS_DIR, "kitchen.json")), "файл не создан");
  } finally {
    await client.close();
  }
});

// ---------- resolvePlanPath: точечные случаи ----------

test("plans-root: resolvePlanPath — пустое имя и имя без файла (.plan) отклонены", () => {
  assert.throws(() => resolvePlanPath(""), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => resolvePlanPath("   "), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => resolvePlanPath(".plan"), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => resolvePlanPath("2026/.plan"), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

test("plans-root: resolvePlanPath — несуществующий хвост не мешает, существующие компоненты без symlink проходят", () => {
  const res = resolvePlanPath("deep/nested/x.plan");
  assert.equal(res.relative, "deep/nested/x.plan");
  assert.equal(res.absolute, join(PLANS_DIR, "deep", "nested", "x.plan"));
  rmSync(join(PLANS_DIR, "deep"), { recursive: true, force: true });
  assert.ok(!existsSync(join(PLANS_DIR, "deep")));
});

test("plans-root: resolvePlanPath сам корень plans создаёт с 0700 при первом использовании", () => {
  rmSync(PLANS_DIR, { recursive: true, force: true });
  assert.ok(!existsSync(PLANS_DIR));
  mkdirSync(HOME_DIR, { recursive: true });
  resolvePlanPath("boot.plan");
  assert.ok(existsSync(PLANS_DIR));
  assert.equal(mode(PLANS_DIR), 0o700);
});
