// Снапшот публичного контракта MCP (аудит 65 C4, задача 187-c4 п.1):
// для всех инструментов — имя, описание, inputSchema (JSON Schema от SDK);
// для ключевых инструментов чтения — ответы на синтетической модели из фикстуры
// anon-rect-4000x3000 через офлайн-путь, которым пользуются smoke-тесты
// (ServerContext offlineFixture + InMemoryTransport, без сайта).
//
// Снапшот снимается ДО рефакторинга DTO-слоя и обязан остаться побайтно тем же
// после вынесения преобразований editor↔public в src/dto: рефакторинг не меняет
// поведение и публичный API. Переснятие — только осознанно:
//   C4_SNAPSHOT_REGEN=1 npm test
// (затем diff снапшота в коммите показать ревьюеру как изменение контракта).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "anon-rect-4000x3000.json");
const SNAPSHOT = join(import.meta.dirname, "snapshots", "c4-contract-snapshot.json");
const REGEN = process.env["C4_SNAPSHOT_REGEN"] === "1";

const HOME = process.env["REMPLANNER_HOME"] ?? "<unset-home>";
const EXPORT_PATH = join(HOME, "c4-contract-snapshot.plan");

async function start(): Promise<Client> {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "c4-snapshot", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };

function text(r: ToolCallResult): string {
  return r.content?.map((c) => ("text" in c ? c.text : "")).join("\n") ?? "";
}

/** Разобрать первый text-content как JSON (формат ok() — jsonText). */
function parsed(r: unknown): unknown {
  const content = (r as { content?: { type: string; text?: string }[] }).content;
  const first = content?.find((c) => "text" in c);
  assert.ok(first && typeof first.text === "string", "ответ без text content");
  return JSON.parse(first.text) as unknown;
}

/** Заменить машино-зависимые строки (пути тестового HOME) на стабильные метки. */
function normalize(value: unknown): unknown {
  if (typeof value === "string") {
    return value.includes(HOME) ? value.split(HOME).join("<HOME>") : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

async function buildSnapshot(): Promise<string> {
  const client = await start();
  const { tools } = await client.listTools();
  const contract = {
    // список инструментов: имя, описание, inputSchema (JSON Schema, как её отдаёт SDK)
    tools: tools
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    responses: {
      model_get_compact: normalize(await parsed(await client.callTool({ name: "model_get", arguments: {} }))),
      model_get_full: normalize(await parsed(await client.callTool({ name: "model_get", arguments: { detail: "full" } }))),
      rooms_list: normalize(await parsed(await client.callTool({ name: "rooms_list", arguments: {} }))),
      items_list: normalize(await parsed(await client.callTool({ name: "items_list", arguments: {} }))),
      dims_list: normalize(await parsed(await client.callTool({ name: "dims_list", arguments: {} }))),
      comments_list: normalize(await parsed(await client.callTool({ name: "comments_list", arguments: {} }))),
      finish_get: normalize(await parsed(await client.callTool({ name: "finish_get", arguments: {} }))),
      floor_list: normalize(await parsed(await client.callTool({ name: "floor_list", arguments: {} }))),
      plan_list: normalize(await parsed(await client.callTool({ name: "plan_list", arguments: {} }))),
      model_validate: normalize(await parsed(await client.callTool({ name: "model_validate", arguments: {} }))),
      catalog_search: normalize(await parsed(await client.callTool({ name: "catalog_search", arguments: { query: "диван", limit: 5 } }))),
      project_export_plan_current: normalize(
        await parsed(await client.callTool({ name: "project_export_plan", arguments: { path: EXPORT_PATH, scope: "current" } })),
      ),
      project_export_plan_full: normalize(
        await parsed(await client.callTool({ name: "project_export_plan", arguments: { path: EXPORT_PATH, scope: "full" } })),
      ),
      // офлайн render_plan не выполняется — фиксируется структурированная ошибка
      // (единый формат design §8): сам формат ошибки — тоже часть публичного контракта
      render_plan_offline_error: normalize(parsed(await client.callTool({ name: "render_plan", arguments: {} }))),
    },
  };
  await client.close();
  return JSON.stringify(normalize(contract), null, 1) + "\n";
}

test("c4: снапшот публичного контракта (список инструментов и ответы) не изменился", async () => {
  const current = await buildSnapshot();
  if (REGEN) {
    mkdirSync(join(import.meta.dirname, "snapshots"), { recursive: true });
    writeFileSync(SNAPSHOT, current);
    return;
  }
  const stored = readFileSync(SNAPSHOT, "utf8");
  assert.equal(current, stored, "публичный контракт изменился — снапшот надо осознанно переснять и показать diff ревьюеру");
});

// Ревью 188 №5: снапшот вне fixtures-guard, поэтому чистоту проверяет сам снапшот-тест.
// Известные 7+-значные числа: лимит лимита редактора (1000000) и MAX_SAFE_INTEGER в схемах.
const KNOWN_BIG_NUMBERS = new Set([1_000_000, Number.MAX_SAFE_INTEGER]);

test("c4: снапшот не содержит локальных путей, email и неизвестных больших чисел", () => {
  const stored = readFileSync(SNAPSHOT, "utf8");
  assert.ok(!stored.includes("/Users/"), "в снапшоте локальный путь /Users/ — HOME не нормализован");
  assert.ok(!stored.includes("/home/"), "в снапшоте локальный путь /home/ — HOME не нормализован");
  assert.ok(!stored.includes("<unset-home>"), "в снапшоте ненормализованный HOME (<unset-home>)");
  assert.doesNotMatch(stored, /[\w.+-]+@[\w-]+\.[\w.-]+/, "в снапшоте email");
  const unexpected = [...new Set(stored.match(/\d{7,}/g) ?? [])]
    .filter((n) => !KNOWN_BIG_NUMBERS.has(Number(n)));
  assert.deepEqual(unexpected, [], "в снапшоте неизвестные 7+-значные числа (реальные ID вместо синтетических?)");
});
