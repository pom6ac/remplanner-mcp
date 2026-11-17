// Ревью 147 №1: ожидаемые ошибки пользователя из модельного слоя стен доходят до
// клиента через MCP-клиент с кодом и исходным текстом (не нейтральное
// «внутренняя ошибка: Error (ERR-…)»). E2E: SDK-клиент + InMemoryTransport,
// офлайн-фикстура (без сети).
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { join } from "node:path";
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
