// Сторож PRO-ключей (ревью 331 Н1/Н2, решение координатора): единый источник
// данных — полный список is_pro-ключей из эталона разметки редактора
// (.orca-reports/tmp/328-pro-anon.json, анонимный проект = бесплатный тариф;
// генератор scripts/gen-pro-editor-keys.ts → src/server/pro-editor-keys.generated.ts).
// Проверяется, что КАЖДЫЙ is_pro-ключ эталона, принимаемый каким-либо
// инструментом MCP (item_add — весь список; opening_add — 13 PRO-типов дверей;
// finish_floor_set/finish_wall_set — PRO-покрытия), на free даёт
// NOT_AVAILABLE_ON_TARIFF (полный путь MCP через офлайн-контекст), а на pro —
// проходит гейт. Ключи эталона, которые MCP не принимает, перечислены в отчёте
// .orca-reports/332-fix2-ceiling.md (якорь: без инструмента).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { gitRepoRoot } from "../../src/repo-root.ts";
import {
  PRO_EDITOR_KEYS, PRO_OPENING_KINDS, PRO_ITEM_KEYS, PRO_FLOOR_COVERS, PRO_WALL_COVERS,
  PRO_PARTIAL_TOOLS, assertProPartialAllowed,
} from "../../src/server/pro.ts";
import { OPENING_KINDS } from "../../src/model/openings.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

/** Эталон в КОРНЕВОМ репо по git-common-dir (ревью 333 Р3: эвристика «ближайший
 *  предок с .orca-reports/tmp» перехватывалась каталогом в ~ или ~/projects). */
function findEtalon(): string | null {
  const root = gitRepoRoot(import.meta.dirname);
  if (root === null) return null;
  const candidate = join(root, ".orca-reports", "tmp", "328-pro-anon.json");
  return existsSync(candidate) ? candidate : null;
}

/** Синтетический бандл каталога, содержащий все is_pro-ключи как позиции
 *  item_add (тест генерирует его из единого списка — списки не пишутся руками). */
function proCatalogBundle(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(PRO_EDITOR_KEYS.map((k, i) => [
    k,
    { id: i + 1, title: k, group: "furniture", width: 40, height: 40, self_height: 40, plan: { furniture: 1 } },
  ]));
}

const payloadOf = (r: unknown): { code?: string } =>
  JSON.parse(((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("")) as { code?: string };

async function start(tariff: "free" | "pro" | null): Promise<Client> {
  const ctx = new ServerContext({
    offlineFixture: FIXTURE,
    // синтетический каталог с is_pro-ключами (без сайта; ревью 331 Н2)
    tools: proCatalogBundle(),
    // тариф для полного пути гейта (тест-инъекция ServerContext); null —
    // анонимный офлайн-проект (тоже бесплатный тариф, design §4)
    ...(tariff === null ? {} : { offlineTariff: tariff, offlineAnon: false }),
  });
  const server = buildServer(ctx);
  const client = new Client({ name: "pro-keys", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

test("pro-keys: единый список не пуст и совпадает с эталоном 328-pro-anon.json (если эталон локально есть)", (t) => {
  assert.ok(PRO_EDITOR_KEYS.length >= 500, `в списке ${PRO_EDITOR_KEYS.length} ключей`);
  assert.equal(new Set(PRO_EDITOR_KEYS).size, PRO_EDITOR_KEYS.length, "дубликаты в списке");
  const sorted = [...PRO_EDITOR_KEYS].sort();
  assert.deepEqual(PRO_EDITOR_KEYS, sorted, "список отсортирован (генератор)");
  const etalon = findEtalon();
  if (etalon === null) return t.skip("эталона нет (CI/чистое окружение)"); // ревью 335 n1: пропуск виден, не тихий pass
  const parsed = JSON.parse(readFileSync(etalon, "utf8")) as { pro?: unknown };
  const etalonKeys = [...new Set((Array.isArray(parsed.pro) ? parsed.pro : []).filter((k): k is string => typeof k === "string"))].sort();
  assert.deepEqual(PRO_EDITOR_KEYS, etalonKeys, "список в src разошёлся с эталоном — перегенерируйте scripts/gen-pro-editor-keys.ts");
});

test("pro-keys: PRO_OPENING_KINDS выведены из единого списка — 13 PRO-типов дверей (ревью 331 Н1)", () => {
  const expected = Object.keys(OPENING_KINDS).filter((k) => PRO_EDITOR_KEYS.includes(k)).sort();
  assert.deepEqual([...PRO_OPENING_KINDS].sort(), expected, "PRO_OPENING_KINDS — производное единого списка");
  assert.equal(PRO_OPENING_KINDS.length, 13, "в эталоне 328 — 13 PRO-типов дверей opening_add");
  for (const k of PRO_OPENING_KINDS) {
    assert.equal(OPENING_KINDS[k]!.group, "doors", `${k}: PRO-тип проёма — дверь`);
    assert.ok(!k.startsWith("window"), `${k}: окна не PRO`);
  }
});

test("pro-keys: PRO-покрытия пола/стен — подмножества единого списка (ревью 331 Н2)", () => {
  for (const k of PRO_FLOOR_COVERS) assert.ok(PRO_EDITOR_KEYS.includes(k), `${k}: нет в едином списке`);
  for (const k of PRO_WALL_COVERS) assert.ok(PRO_EDITOR_KEYS.includes(k), `${k}: нет в едином списке`);
});

test("pro-keys: item_add на free — NOT_AVAILABLE_ON_TARIFF для КАЖДОГО is_pro-ключа (полный путь MCP)", async () => {
  const client = await start(null);
  try {
    for (const key of PRO_EDITOR_KEYS) {
      const res = await client.callTool({ name: "item_add", arguments: { name: key, position: { in_room: { room_id: "R1", corner: "center" } } } });
      assert.ok(res.isError, `item_add ${key}: ожидался отказ на free`);
      assert.equal(payloadOf(res).code, "NOT_AVAILABLE_ON_TARIFF", `item_add ${key}: ${JSON.stringify(payloadOf(res)).slice(0, 200)}`);
    }
  } finally {
    await client.close();
  }
});

test("pro-keys: item_add на pro — гейт проходит для КАЖДОГО is_pro-ключа", async () => {
  const client = await start("pro");
  try {
    for (const key of PRO_EDITOR_KEYS) {
      const res = await client.callTool({ name: "item_add", arguments: { name: key, position: { in_room: { room_id: "R1", corner: "center" } } } });
      const code = payloadOf(res).code;
      assert.notEqual(code, "NOT_AVAILABLE_ON_TARIFF", `item_add ${key}: unexpectedly за гейтом на pro (${JSON.stringify(payloadOf(res)).slice(0, 200)})`);
    }
  } finally {
    await client.close();
  }
});

test("pro-keys: opening_add на free — NOT_AVAILABLE_ON_TARIFF для 13 PRO-типов дверей; door/doorway проходят гейт", async () => {
  const client = await start(null);
  try {
    for (const kind of PRO_OPENING_KINDS) {
      const res = await client.callTool({ name: "opening_add", arguments: { wall_id: "W1", type: kind } });
      assert.ok(res.isError, `opening_add ${kind}: ожидался отказ на free`);
      assert.equal(payloadOf(res).code, "NOT_AVAILABLE_ON_TARIFF", `opening_add ${kind}: ${JSON.stringify(payloadOf(res)).slice(0, 200)}`);
    }
    // не-PRO типы доходят до модельного слоя (гейт не срабатывает)
    for (const kind of ["door", "doorway", "door_coupe", "window"]) {
      const res = await client.callTool({ name: "opening_add", arguments: { wall_id: "nope", type: kind } });
      assert.notEqual(payloadOf(res).code, "NOT_AVAILABLE_ON_TARIFF", `opening_add ${kind}: неожиданно за гейтом`);
    }
  } finally {
    await client.close();
  }
});

test("pro-keys: opening_add на pro — 13 PRO-типов дверей проходят гейт", async () => {
  const client = await start("pro");
  try {
    for (const kind of PRO_OPENING_KINDS) {
      const res = await client.callTool({ name: "opening_add", arguments: { wall_id: "nope", type: kind } });
      assert.notEqual(payloadOf(res).code, "NOT_AVAILABLE_ON_TARIFF", `opening_add ${kind}: неожиданно за гейтом на pro`);
    }
  } finally {
    await client.close();
  }
});

test("pro-keys: finish_floor_set/finish_wall_set на free — NOT_AVAILABLE_ON_TARIFF для PRO-покрытий", async () => {
  const client = await start(null);
  try {
    for (const cover of PRO_FLOOR_COVERS) {
      const res = await client.callTool({ name: "finish_floor_set", arguments: { room_id: "R1", cover } });
      assert.equal(payloadOf(res).code, "NOT_AVAILABLE_ON_TARIFF", `finish_floor_set ${cover}: ${JSON.stringify(payloadOf(res)).slice(0, 200)}`);
    }
    for (const cover of PRO_WALL_COVERS) {
      const res = await client.callTool({ name: "finish_wall_set", arguments: { room_id: "R1", wall_id: "W1", type: cover } });
      assert.equal(payloadOf(res).code, "NOT_AVAILABLE_ON_TARIFF", `finish_wall_set ${cover}: ${JSON.stringify(payloadOf(res)).slice(0, 200)}`);
    }
  } finally {
    await client.close();
  }
});

test("pro-keys: частичные гейты — ядро на pro проходит для всех ключей, не-PRO ключи не гейтятся", async () => {
  const pro = { authStatus: async () => ({ logged_in: true, tariff: "pro" as const, mode: "account", projects_limit: null, account_email_masked: null }) };
  const free = { authStatus: async () => ({ logged_in: true, tariff: "free" as const, mode: "account", projects_limit: 1, account_email_masked: null }) };
  for (const [tool, partial] of Object.entries(PRO_PARTIAL_TOOLS)) {
    for (const key of PRO_EDITOR_KEYS) {
      const ek = partial.toEditorKey ? partial.toEditorKey(key) : key;
      if (ek !== key) continue; // wall_add: ключ модели не равен ключу редактора — цикл по кодам ниже
      await assert.doesNotReject(
        assertProPartialAllowed(pro, { anon: false }, tool, key),
        `${tool}/${key}: на pro гейт должен проходить`,
      );
      await assert.rejects(
        assertProPartialAllowed(free, { anon: false }, tool, key),
        (e: unknown) => e instanceof Error && (e as { code?: string }).code === "NOT_AVAILABLE_ON_TARIFF",
        `${tool}/${key}: на free должен отказать`,
      );
    }
  }
  // wall_add: коды модели c_glass/c_bar — перевод в ключи редактора (эталон 328)
  await assert.rejects(assertProPartialAllowed(free, { anon: false }, "wall_add", "c_glass"), (e: unknown) => (e as { code?: string }).code === "NOT_AVAILABLE_ON_TARIFF");
  await assert.rejects(assertProPartialAllowed(free, { anon: false }, "wall_add", "c_bar"), (e: unknown) => (e as { code?: string }).code === "NOT_AVAILABLE_ON_TARIFF");
  await assert.doesNotReject(assertProPartialAllowed(pro, { anon: false }, "wall_add", "c_glass"));
  await assert.doesNotReject(assertProPartialAllowed(pro, { anon: false }, "wall_add", "c_bar"));
  // не-PRO ключи — гейта нет на free
  for (const [tool, key] of [["wall_add", "c_pgb"], ["item_add", "socket"], ["finish_floor_set", "laminate"], ["finish_wall_set", "wallpaper"], ["opening_add", "door"]] as const) {
    await assert.doesNotReject(assertProPartialAllowed(free, { anon: false }, tool, key), `${tool}/${key}: не-PRO ключ не гейтится`);
  }
});
