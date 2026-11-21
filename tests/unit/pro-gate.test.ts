// Этап 328 п.3: единый PRO-гейт — тест на КАЖДЫЙ инструмент реестра с моком
// тарифа free (и анонимным проектом через офлайн-контекст, design §4).
// Ревью 329 №9: циклы free→отказ / pro→проходит на каждый инструмент реестра
// и частичный гейт на каждый ключ — через инжектированный statusFn; не-PRO
// инструменты этапа (потолок ч.2) не гейтятся.
// Реестр: src/server/pro.ts; эталон разметки: .orca-reports/tmp/328-pro-anon.json
// (анонимный редактор = бесплатный тариф, 792 plannertool_* с is_pro).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { PRO_TOOL_GROUPS, PRO_PARTIAL_TOOLS, PRO_ITEM_KEYS, proGatedTools, assertProToolAllowed, assertProPartialAllowed, proGateError } from "../../src/server/pro.ts";
import type { ClientPageInfo } from "../../src/api.ts";
import type { AuthStatusInfo } from "../../src/server/context.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

const INFO = (over: Partial<ClientPageInfo> = {}): AuthStatusInfo => ({
  logged_in: true, login_error: false, tariff: "free", projects: [],
  mode: "account", projects_limit: 5, account_email_masked: null, ...over,
});

/** Фейковый контекст с инжектированным тарифом (ревью 329 №9). */
const ctxWithTariff = (tariff: ClientPageInfo["tariff"]) => ({
  authStatus: async () => INFO({ tariff }),
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
    case "comment_add":
      return { point: { x: 0, y: 0 }, text: "тест" };
    case "comment_update":
      return { comment_id: "1" };
    default:
      return {};
  }
}

// параметр цикла используется статически — линтер
void PRO_TOOL_GROUPS;

// ---------- ревью 329 №1/№2: единый источник ошибки тарифа ----------

function collectTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) collectTs(p, out);
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("ревью 329 №1: NOT_AVAILABLE_ON_TARIFF в src — только в pro.ts (и enum в errors.ts)", () => {
  const offenders: string[] = [];
  for (const f of collectTs(join(ROOT, "src"))) {
    const text = readFileSync(f, "utf8");
    if (!text.includes("NOT_AVAILABLE_ON_TARIFF")) continue;
    if (f.endsWith("server/pro.ts") || f.endsWith("errors.ts")) continue;
    offenders.push(f);
  }
  assert.deepEqual(offenders, [], "копии гейта тарифа вернулись");
});

// ---------- ревью 329 №9: инжектированный statusFn, free → отказ / pro → проходит ----------

test("ревью 329 №9: на каждый инструмент реестра free — отказ, pro — проходит", async () => {
  for (const tool of proGatedTools()) {
    const g = PRO_TOOL_GROUPS.find((x) => x.tools.includes(tool))!;
    await assert.rejects(
      assertProToolAllowed(ctxWithTariff("free"), { anon: false }, tool, g.label),
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === "NOT_AVAILABLE_ON_TARIFF",
      `${tool}: free должен отказать`,
    );
    await assert.doesNotReject(
      assertProToolAllowed(ctxWithTariff("pro"), { anon: false }, tool, g.label),
      `${tool}: pro должен пройти`,
    );
  }
});

test("ревью 329 №9: частичные гейты — is_pro-ключ: free отказ, pro проходит; не-PRO ключ проходит на free", async () => {
  for (const [tool, partial] of Object.entries(PRO_PARTIAL_TOOLS)) {
    for (const key of partial.editorKeys) {
      await assert.rejects(
        assertProPartialAllowed(ctxWithTariff("free"), { anon: false }, tool, key),
        (e: unknown) => e instanceof Error && (e as { code?: string }).code === "NOT_AVAILABLE_ON_TARIFF",
        `${tool}/${key}: free должен отказать`,
      );
      await assert.doesNotReject(
        assertProPartialAllowed(ctxWithTariff("pro"), { anon: false }, tool, key),
        `${tool}/${key}: pro должен пройти`,
      );
    }
  }
  // не-PRO ключи (обычные покрытия/предметы) на free не гейтятся
  const notPro: [string, string][] = [
    ["wall_add", "c_pgb"],
    ["item_add", "socket"],
    ["item_add", "sofa_ikea_kivik"],
    ["finish_floor_set", "laminate"],
    ["finish_wall_set", "wallpaper"],
  ];
  for (const [tool, key] of notPro) {
    await assert.doesNotReject(
      assertProPartialAllowed(ctxWithTariff("free"), { anon: false }, tool, key),
      `${tool}/${key}: не-PRO ключ не гейтится`,
    );
  }
});

test("ревью 329 №9: список is_pro-ключей item_add — из эталона 328-pro-sheets.json", () => {
  // ключи листов waterplan/sockets/light_connections/security/cables — PRO в разметке
  const must = [
    "waterspot_cold", "waterspot_hot", "waterspot_drainage", "waterspot_collector",
    "floor_socket", "ceiling_socket", "furniture_socket",
    "light_switch_triple", "light_dimmer", "light_switch_through", "light_switch_through_double",
    "light_switch_cross", "light_switch_cross_double", "light_switch_master",
    "electric_box", "electric_box_wall", "electric_kup",
    "motion_sensor", "light_sensor", "water_leakage_panel", "water_leakage_sensor", "alarm_panel",
  ];
  for (const k of must) assert.ok(PRO_ITEM_KEYS.includes(k), `${k}: нет в PRO_ITEM_KEYS`);
});

// ---------- ревью 329 №9: не-PRO инструменты этапа (потолок ч.2) не гейтятся ----------

const STAGE_NOT_PRO_TOOLS = [
  "ceiling_hole_add", "ceiling_hole_update", "ceiling_hole_delete",
  "ceiling_rigel_add", "ceiling_rigel_update", "ceiling_rigel_delete",
  "floor_hole_add", "floor_hole_update", "floor_hole_delete",
  "finish_ceiling_complex_set",
] as const;

test("ревью 329 №9: не-PRO инструменты этапа не в реестре и не гейтятся (офлайн-контекст)", () => {
  const gated = new Set(proGatedTools());
  for (const t of STAGE_NOT_PRO_TOOLS) assert.ok(!gated.has(t), `${t} попал в реестр PRO`);
});

for (const tool of STAGE_NOT_PRO_TOOLS) {
  test(`ревью 329 №9: ${tool} на анонимном проекте — без гейта тарифа`, async () => {
    const ctx = new ServerContext({ offlineFixture: FIXTURE });
    const server = buildServer(ctx);
    const client = new Client({ name: "pro-gate-not-pro", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const res = await client.callTool({ name: tool, arguments: notProArgs(tool) });
      const payload = JSON.parse((res.content as { type: string; text: string }[]).map((c) => c.text).join("")) as { code?: string };
      assert.notEqual(payload.code, "NOT_AVAILABLE_ON_TARIFF", `${tool}: неожиданно за гейтом тарифа`);
    } finally {
      await client.close();
    }
  });
}

function notProArgs(tool: string): Record<string, unknown> {
  switch (tool) {
    case "ceiling_hole_add":
    case "floor_hole_add":
      return { corner1: { x: 0, y: 0 }, corner2: { x: 500, y: 500 } };
    case "ceiling_hole_update":
    case "floor_hole_update":
      return { ceiling_hole_id: "nope", floor_hole_id: "nope" };
    case "ceiling_hole_delete":
    case "floor_hole_delete":
      return { ceiling_hole_id: "nope", floor_hole_id: "nope" };
    case "ceiling_rigel_add":
      return { room_id: "R1", start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, ceiling_type: "gypsum_ceiling" };
    case "ceiling_rigel_update":
      return { rigel_id: "nope" };
    case "ceiling_rigel_delete":
      return { rigel_id: "nope" };
    case "finish_ceiling_complex_set":
      return { room_id: "R1" };
    default:
      return {};
  }
}
