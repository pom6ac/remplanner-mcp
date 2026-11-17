// Ревью 147 №1: ожидаемые ошибки пользователя из модельного слоя стен доходят до
// клиента через MCP-клиент с кодом и исходным текстом (не нейтральное
// «внутренняя ошибка: Error (ERR-…)»). E2E: SDK-клиент + InMemoryTransport,
// офлайн-фикстура (без сети).
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

type Payload = { code: string; message: string };

async function payload(client: Client, name: string, args: Record<string, unknown>): Promise<Payload> {
  const res = await client.callTool({ name, arguments: args }) as { content?: Array<{ text?: string }> };
  return JSON.parse(res.content![0]!.text!) as Payload;
}

test("ошибки модельного слоя стен — код и понятный текст через MCP-клиент", async () => {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "review149", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const m = await client.callTool({ name: "model_get", arguments: {} }) as { content: Array<{ text: string }> };
    const walls = (JSON.parse(m.content[0]!.text) as { walls: Array<{ id: string }> }).walls;
    assert.ok(walls.length > 0, "в фикстуре есть стены");

    // wall_split at_mm:0 — «точка разреза слишком близко к краю стены»
    const split = await payload(client, "wall_split", { wall_id: walls[0]!.id, at_mm: 0 });
    assert.equal(split.code, "INVALID_ARGUMENT");
    assert.equal(split.message, "точка разреза слишком близко к краю стены");

    // wall_add с совпадающими точками — «стена нулевой длины»
    const zero = await payload(client, "wall_add", { start: { x: 100, y: 100 }, end: { x: 100, y: 100 } });
    assert.equal(zero.code, "INVALID_ARGUMENT");
    assert.equal(zero.message, "стена нулевой длины");

    // несуществующая стена — NOT_FOUND
    const missing = await payload(client, "wall_split", { wall_id: "W999", at_mm: 500 });
    assert.equal(missing.code, "NOT_FOUND");
    assert.match(missing.message, /не найдена/);

    // wall_move несуществующей стены — NOT_FOUND
    const move = await payload(client, "wall_move", { wall_id: "W999", offset_mm: 100 });
    assert.equal(move.code, "NOT_FOUND");
    assert.match(move.message, /не найдена/);
  } finally {
    await client.close();
  }
});

// Ревью 150 M3: ожидаемые ошибки пользователя у файловых инструментов — McpError
// с понятным текстом, путь в сообщении обезличен (basename, без абсолютного пути).
test("project_import/export_plan: ошибки файла — McpError без абсолютного пути", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-e2e-"));
  try {
    const badJson = join(dir, "bad.plan");
    writeFileSync(badJson, '{"walls": [1, 2');
    const badShape = join(dir, "shape.plan");
    writeFileSync(badShape, "[1, 2, 3]");
    const absent = join(dir, "nope.plan");
    const badDir = join(dir, "nodir", "x.plan");

    const ctx = new ServerContext({ offlineFixture: FIXTURE });
    const server = buildServer(ctx);
    const client = new Client({ name: "review150", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      // файл не найден — NOT_FOUND, basename без каталога
      const missing = await payload(client, "project_import_plan", { path: absent, replace: true });
      assert.equal(missing.code, "NOT_FOUND");
      assert.match(missing.message, /не найден/);
      assert.ok(missing.message.includes("nope.plan"), "в сообщении basename файла");
      assert.ok(!missing.message.includes(dir), "абсолютный путь не выходит наружу");

      // битый JSON — INVALID_ARGUMENT
      const bad = await payload(client, "project_import_plan", { path: badJson, replace: true });
      assert.equal(bad.code, "INVALID_ARGUMENT");
      assert.match(bad.message, /не является JSON/);
      assert.ok(!bad.message.includes(dir));

      // не тот формат (JSON, но не модель) — INVALID_ARGUMENT
      const shape = await payload(client, "project_import_plan", { path: badShape, replace: true });
      assert.equal(shape.code, "INVALID_ARGUMENT");
      assert.match(shape.message, /не является планом/);
      assert.ok(!shape.message.includes(dir));

      // экспорт в несуществующий каталог — NOT_FOUND
      const exp = await payload(client, "project_export_plan", { path: badDir });
      assert.equal(exp.code, "NOT_FOUND");
      assert.match(exp.message, /не найден/);
      assert.ok(!exp.message.includes(dir));

      // каталог вместо файла — INVALID_ARGUMENT
      const dirRes = await payload(client, "project_import_plan", { path: dir, replace: true });
      assert.equal(dirRes.code, "INVALID_ARGUMENT");
      assert.ok(!dirRes.message.includes(dir));
    } finally {
      await client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
