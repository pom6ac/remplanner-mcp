// Этап 328 п.3: единый PRO-гейт — тест на КАЖДЫЙ инструмент реестра с моком
// тарифа free (и анонимным проектом через офлайн-контекст, design §4).
// Реестр: src/server/pro.ts; эталон разметки: .orca-reports/tmp/328-pro-anon.json
// (анонимный редактор = бесплатный тариф, 792 plannertool_* с is_pro).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { PRO_TOOL_GROUPS, proGatedTools, assertProToolAllowed, proGateError } from "../../src/server/pro.ts";
import type { ClientPageInfo } from "../../src/api.ts";
import type { AuthStatusInfo } from "../../src/server/context.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

const INFO = (over: Partial<ClientPageInfo> = {}): AuthStatusInfo => ({
  logged_in: true, login_error: false, tariff: "free", projects: [],
  mode: "account", projects_limit: 5, account_email_masked: null, ...over,
});

test("pro-gate: реестр не пуст, инструменты уникальны, _delete/_remove не гейтятся", () => {
  const tools = proGatedTools();
  assert.ok(tools.length >= 20, `в реестре ${tools.length} инструментов`);
  assert.equal(new Set(tools).size, tools.length, "дубликаты в реестре");
  for (const t of tools) {
    // исключение — shield_* (seniorOnly, весь лист «Электрощиток» закрыт);
    // у остальных PRO-инструментов удаление не гейтится (ластик не is_pro)
    if (t.startsWith("shield_")) continue;
    assert.ok(!t.endsWith("_delete") && !t.endsWith("_remove"), `${t}: удаление не гейтится (ластик не is_pro)`);
  }
});

test("pro-gate: ядро правила — тариф free/unknown отказ, pro проходит", async () => {
  const gate = (tariff: string) => assertProToolAllowed({ authStatus: async () => INFO({ tariff: tariff as ClientPageInfo["tariff"] }) }, { anon: false }, "zone_floor_add", "зонирование пола");
  await assert.rejects(gate("free"), (e: unknown) => e instanceof Error && (e as { code?: string }).code === "NOT_AVAILABLE_ON_TARIFF");
  await assert.rejects(gate("unknown"), (e: unknown) => e instanceof Error && (e as { code?: string }).code === "NOT_AVAILABLE_ON_TARIFF");
  await assert.doesNotReject(gate("pro"));
  // анонимный проект — отказ без запроса статуса
  await assert.rejects(
    assertProToolAllowed({ authStatus: async () => INFO({ tariff: "pro" }) }, { anon: true }, "pipe_add", "трубы"),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "NOT_AVAILABLE_ON_TARIFF",
  );
  const err = proGateError("трубы", "pipe_add", "free");
  assert.equal(err.code, "NOT_AVAILABLE_ON_TARIFF");
  assert.ok(!JSON.stringify(err.details ?? {}).includes("authkey"), "секретов в деталях нет");
});

test("pro-gate: zone_c не в реестре — гейта нет (как в редакторе, эталон 328-pro-anon.json)", async () => {
  assert.ok(!proGatedTools().includes("zone_c_add"));
  assert.ok(!proGatedTools().includes("zone_c_remove"));
  // полный путь MCP: zone_c_add на анонимном проекте работает
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "pro-gate-zonec", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const rooms = await client.callTool({ name: "model_get", arguments: {} });
    const payload = JSON.parse((rooms.content as { type: string; text: string }[]).map((c) => c.text).join("")) as { rooms?: { id: string }[] };
    const room = payload.rooms?.[0]?.id;
    assert.ok(room, "в фикстуре есть комната");
    const res = await client.callTool({ name: "zone_c_add", arguments: { room_id: room, from_mm: { x: 100, y: 100 }, to_mm: { x: 100, y: 2000 } } });
    // гейта нет: не NOT_AVAILABLE_ON_TARIFF (INVALID_ARGUMENT магнита — тоже признак
    // того, что вызов дошёл до модельного слоя)
    const body = (res.content as { text?: string }[]).map((c) => c.text ?? "").join("");
    assert.ok(!body.includes("NOT_AVAILABLE_ON_TARIFF"), `zone_c_add неожиданно за гейтом: ${body.slice(0, 200)}`);
  } finally {
    await client.close();
  }
});

// Тест на КАЖДЫЙ инструмент реестра: анонимный проект (офлайн-контекст) →
// NOT_AVAILABLE_ON_TARIFF до любых проверок аргументов.
for (const tool of proGatedTools()) {
  test(`pro-gate: ${tool} на анонимном проекте — NOT_AVAILABLE_ON_TARIFF (328 п.3)`, async () => {
    const ctx = new ServerContext({ offlineFixture: FIXTURE });
    const server = buildServer(ctx);
    const client = new Client({ name: "pro-gate", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const res = await client.callTool({ name: tool, arguments: minimalArgs(tool) });
      assert.ok(res.isError, `${tool}: ожидался отказ`);
      const payload = JSON.parse((res.content as { type: string; text: string }[]).map((c) => c.text).join("")) as { code?: string };
      assert.equal(payload.code, "NOT_AVAILABLE_ON_TARIFF", `${tool}: ${JSON.stringify(payload).slice(0, 300)}`);
    } finally {
      await client.close();
    }
  });
}

/** Минимальные валидные по схеме аргументы (гейт срабатывает до проверок,
 *  но SDK проверяет схему до обработчика — даём схемно-валидный минимум). */
function minimalArgs(tool: string): Record<string, unknown> {
  if (tool.startsWith("shield_")) {
    if (tool === "shield_rail_add") return { item_id: "1" };
    if (tool === "shield_rail_delete") return { item_id: "1", rail: 1 };
    if (tool === "shield_bus_add") return { item_id: "1", position: "T" };
    if (tool === "shield_bus_delete" || tool === "shield_bus_update") return { item_id: "1", bus_id: "1" };
    if (tool === "shield_collector_add") return { item_id: "1", modules: ["m1", "m2"] };
    if (tool === "shield_collector_delete" || tool === "shield_collector_update") return { item_id: "1", collector_id: "1" };
    if (tool === "shield_module_add") return { item_id: "1", type: "shield_module" };
    if (tool === "shield_module_delete" || tool === "shield_module_update") return { item_id: "1", module_id: "1" };
    if (tool === "shield_wire_add") return { item_id: "1", type: "shield_wire_phase", source: { module_id: "m1", port: 1 }, target: { module_id: "m2", port: 1 } };
    if (tool === "shield_wire_delete") return { item_id: "1", wire_id: "1" };
  }
  switch (tool) {
    case "zone_floor_add":
    case "zone_ceiling_add":
    case "zone_hydroisolation_add":
    case "zone_floor_cap_add":
      return { room_id: "R1", from_mm: { x: 0, y: 0 }, to_mm: { x: 1000, y: 0 } };
    case "led_strip_add":
    case "stripe_add":
    case "line_light_add":
      return { kind: "recessed", path: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] };
    case "led_strip_update":
      return { led_strip_id: "1", positions: [{ vertex: 0, x_mm: 0, y_mm: 0 }] };
    case "stripe_update":
      return { stripe_id: "1", positions: [{ vertex: 0, x_mm: 0, y_mm: 0 }] };
    case "line_light_update":
      return { line_light_id: "1", positions: [{ vertex: 0, x_mm: 0, y_mm: 0 }] };
    case "cable_add":
      return { switch_item_id: "1", lamp_item_id: "2" };
    case "wiring_add":
      return { kind: "wire_2_15", path: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] };
    case "wiring_update":
      return { wiring_id: "1", positions: [{ vertex: 0, x_mm: 0, y_mm: 0 }] };
    case "pipe_add":
      return { kind: "water", path: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] };
    case "pipe_update":
      return { pipe_id: "1", positions: [{ vertex: 0, x_mm: 0, y_mm: 0 }] };
    case "warm_floor_add":
      return { kind: "water", corner1: { x: 0, y: 0 }, corner2: { x: 1000, y: 1000 } };
    case "warm_floor_update":
      return { warm_floor_id: "1", positions: [{ vertex: 0, x_mm: 0, y_mm: 0 }] };
    case "finish_ceiling_niche_add":
      return { room_id: "R1", wall_id: "W1" };
    case "finish_ceiling_molding_set":
      return { room_id: "R1", wall_id: "W1" };
    case "finish_floor_molding_set":
      return { room_id: "R1", wall_id: "W1", type: "floor_molding_wood" };
    default:
      return {};
  }
}

// параметр цикла используется статически — линтер
void PRO_TOOL_GROUPS;
