// Ревью 285 №1/№2: публичная схема shield_module_update (index — сетка 0.5 DIN,
// перенос вправо) и ответ shield_rail_delete (каскад deleted_modules/
// deleted_wires/deleted_collectors). Тесты через server.callTool
// (InMemoryTransport) в офлайне: гейт тарифа (assertShieldAllowed) открыт
// подменой authStatus на PRO и снятием флага anon у офлайн-проекта; предмет-
// щиток кладётся в модель напрямую (item_add в офлайне недоступен без каталога).
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import type { Model } from "../../src/model/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "../fixtures/anon-rect-4000x3000.json");

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as ToolCallResult).content as { text: string }[])[0]!.text;

async function start(): Promise<Client> {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "shield-tools", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  // гейт тарифа: офлайн-проект помечен anon, unknown-тариф — имитируем PRO-проект
  ctx.workspace().project!.anon = false;
  (ctx as unknown as { authStatus: () => Promise<unknown> }).authStatus = async () => ({
    logged_in: true, tariff: "pro", mode: "account", projects_limit: null, account_email_masked: null,
  });
  // предмет-щиток прямо в модель (как после item_add; resolveItem берёт по id)
  (ctx.workspace().model as Model).items = {
    sh1: { id: "sh1", name: "electric_shield", pc: { x: 100, y: 100 }, width: 30, height: 11 } as never,
  };
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name, arguments: args });
  if ((res as ToolCallResult).isError) throw new Error(`${name}: ${text(res).slice(0, 400)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
}

const errPayload = (r: unknown): { code?: string; details?: Record<string, unknown> } => {
  const t = text(r);
  try {
    return JSON.parse(t) as { code?: string; details?: Record<string, unknown> };
  } catch {
    // схема SDK отклоняет аргументы до zod-обработчика (текст «MCP error -32602…»)
    return { code: t.includes("Invalid") ? "INVALID_ARGUMENT" : undefined };
  }
};

/** Три модуля по 1 DIN на рейке 0 → их module_id. */
async function threeModules(client: Client): Promise<string[]> {
  const ids: string[] = [];
  for (const subtype of ["16A", "25A", "32A"]) {
    const res = await call(client, "shield_module_add", { item_id: "sh1", type: "shield_module", subtype });
    const mods = (res["entity"] as { modules: { module_id: string; type: string }[] }).modules;
    ids.push(mods[mods.length - 1]!.module_id);
  }
  return ids;
}

test("ревью 285 №1: shield_module_update index — сетка 0.5 DIN, 1.5 переносит модуль вправо", async () => {
  const client = await start();
  try {
    const [idA, idB, idC] = await threeModules(client);
    // перенос вправо: позиция drag «конец соседа − 0.5» = 1.5 — schema должна пустить;
    // модуль 1 DIN встаёт после соседа (хранится index = 1.5 − (1 − 0.5) = 1), сосед сдвигается влево
    const mv = await call(client, "shield_module_update", { item_id: "sh1", module_id: idA, index: 1.5 });
    const mods = (mv["entity"] as { modules: { module_id: string; index: number }[] }).modules;
    assert.equal(mods.find((m) => m.module_id === idA)!.index, 1, "модуль A после соседа (слот 1.5)");
    assert.equal(mods.find((m) => m.module_id === idB)!.index, 0, "модуль B сдвинулся влево");
    assert.equal(mods.find((m) => m.module_id === idC)!.index, 2, "модуль C на месте");
  } finally {
    await client.close();
  }
});

test("ревью 285 №1: shield_module_update index 1 и 2 — bad_slot (сосед 1 DIN), как в редакторе", async () => {
  const client = await start();
  try {
    const [idA] = await threeModules(client);
    for (const index of [1, 2]) {
      const res = await client.callTool({ name: "shield_module_update", arguments: { item_id: "sh1", module_id: idA, index } });
      assert.equal(res.isError, true, `index ${index} — ошибка`);
      const payload = errPayload(res);
      assert.equal(payload.code, "INVALID_ARGUMENT", `index ${index}`);
      assert.equal((payload.details as { kind?: string } | undefined)?.kind, "bad_slot", `index ${index}`);
    }
  } finally {
    await client.close();
  }
});

test("ревью 285 №1: shield_module_update index — дробные не кратные 0.5 и за лимитом рейки отвергаются схемой", async () => {
  const client = await start();
  try {
    const [idA] = await threeModules(client);
    for (const index of [0.3, 49, -1]) {
      const res = await client.callTool({ name: "shield_module_update", arguments: { item_id: "sh1", module_id: idA, index } });
      assert.equal(res.isError, true, `index ${index} — ошибка`);
      assert.equal(errPayload(res).code, "INVALID_ARGUMENT", `index ${index}`);
    }
  } finally {
    await client.close();
  }
});

test("ревью 287 N1: 3×1 DIN — index 2.5 переносит модуль на последнее место рейки (как get_module_slot)", async () => {
  const client = await start();
  try {
    const [idA, idB, idC] = await threeModules(client);
    // слот курсора клэмпится к «ширина рейки − 0.5» (get_module_slot редактора),
    // поэтому перенос вправо на последнее место — index = заполнено − 0.5
    const mv = await call(client, "shield_module_update", { item_id: "sh1", module_id: idA, index: 2.5 });
    const mods = (mv["entity"] as { modules: { module_id: string; index: number }[] }).modules;
    assert.equal(mods.find((m) => m.module_id === idA)!.index, 2, "модуль A последним (слот 2.5 → index 2)");
    assert.equal(mods.find((m) => m.module_id === idB)!.index, 0, "модуль B на месте");
    assert.equal(mods.find((m) => m.module_id === idC)!.index, 1, "модуль C на месте");
  } finally {
    await client.close();
  }
});

test("ревью 287 N1: позиция за концом рейки — по-прежнему index_out_of_rail", async () => {
  const client = await start();
  try {
    const [idA] = await threeModules(client);
    for (const index of [3, 3.5]) {
      const res = await client.callTool({ name: "shield_module_update", arguments: { item_id: "sh1", module_id: idA, index } });
      assert.equal(res.isError, true, `index ${index} — ошибка`);
      const payload = errPayload(res);
      assert.equal(payload.code, "INVALID_ARGUMENT", `index ${index}`);
      assert.equal((payload.details as { kind?: string } | undefined)?.kind, "index_out_of_rail", `index ${index}`);
    }
  } finally {
    await client.close();
  }
});

test("ревью 287 N2: bad_slot при переносе вправо подсказывает expected_index (конец соседа − 0.5)", async () => {
  const client = await start();
  try {
    // A (2 DIN) на 0, B (1 DIN) на 2; перенос A на начало соседа B (index 2) —
    // ожидаемая позиция drag: 2 + 1 − 0.5 = 2.5
    const add = await call(client, "shield_module_add", { item_id: "sh1", type: "shield_module_uzo", subtype: "16A/30mA" });
    const idA = (add["entity"] as { modules: { module_id: string; index: number }[] }).modules.find((m) => m.index === 0)!.module_id;
    await threeModules(client);
    const res = await client.callTool({ name: "shield_module_update", arguments: { item_id: "sh1", module_id: idA, index: 2 } });
    assert.equal(res.isError, true, "index 2 — ошибка (начало соседа, не конец − 0.5)");
    const payload = errPayload(res);
    assert.equal(payload.code, "INVALID_ARGUMENT");
    const details = payload.details as { kind?: string; expected_index?: number } | undefined;
    assert.equal(details?.kind, "bad_slot");
    assert.equal(details?.expected_index, 2.5, "подсказка: конец соседа − 0.5");
  } finally {
    await client.close();
  }
});

test("ревью 285 №2: shield_rail_delete — ответ с deleted_modules/deleted_wires (каскад проводов)", async () => {
  const client = await start();
  try {
    await call(client, "shield_rail_add", { item_id: "sh1" });
    // 2 модуля на рейке 1 + провод между ними
    const add1 = await call(client, "shield_module_add", { item_id: "sh1", type: "shield_module", subtype: "16A", rail: 1 });
    const idA = (add1["entity"] as { modules: { module_id: string; rail: number }[] }).modules.filter((m) => m.rail === 1)[0]!.module_id;
    const add2 = await call(client, "shield_module_add", { item_id: "sh1", type: "shield_module", subtype: "25A", rail: 1 });
    const modsRail1 = (add2["entity"] as { modules: { module_id: string; rail: number }[] }).modules.filter((m) => m.rail === 1);
    const idB = modsRail1[1]!.module_id;
    const wireRes = await call(client, "shield_wire_add", {
      item_id: "sh1", type: "shield_wire_phase",
      source: { module_id: idA, port: 0 }, target: { module_id: idB, port: 0 },
    });
    const wireId = (wireRes["entity"] as { wires: { wire_id: string }[] }).wires[0]!.wire_id;

    const del = await call(client, "shield_rail_delete", { item_id: "sh1", rail: 1 });
    assert.deepEqual(del["deleted_modules"], [idA, idB], "удалённые модули рейки");
    assert.deepEqual(del["deleted_wires"], [wireId], "каскад: провод модулей рейки");
    assert.equal(del["deleted_collectors"], undefined, "коллекторов не было — ключа нет");

    // рейка без модулей/проводов: ключи absent (как у shield_module_delete)
    await call(client, "shield_rail_add", { item_id: "sh1" });
    const delEmpty = await call(client, "shield_rail_delete", { item_id: "sh1", rail: 1 });
    assert.equal(delEmpty["deleted_modules"], undefined);
    assert.equal(delEmpty["deleted_wires"], undefined);
    const left = (delEmpty["entity"] as { rails: number }).rails;
    assert.equal(left, 1, "осталась одна рейка");
  } finally {
    await client.close();
  }
});

test("ревью 285 №2: shield_module_delete — ответ с deleted_wires (регрессия на форму ответа)", async () => {
  const client = await start();
  try {
    const [idA, idB] = await threeModules(client);
    await call(client, "shield_wire_add", {
      item_id: "sh1", type: "shield_wire_phase",
      source: { module_id: idA, port: 0 }, target: { module_id: idB, port: 0 },
    });
    const del = await call(client, "shield_module_delete", { item_id: "sh1", module_id: idA });
    assert.equal((del["deleted_wires"] as string[]).length, 1, "каскад провода в ответе");
  } finally {
    await client.close();
  }
});

// ---------- 291: шины и коллекторы через публичные инструменты ----------

test("291: shield_bus_add/update/delete — формат ответа (bus_list) и каскад deleted_wires", async () => {
  const client = await start();
  try {
    const [idA, idB] = await threeModules(client);
    const add = await call(client, "shield_bus_add", { item_id: "sh1", position: "T" });
    const sh = add["entity"] as { bus_list?: { bus_id: string; type: string; sockets: number; distance: number; connection: string }[]; buses: number };
    assert.equal(sh.buses, 1);
    assert.equal(sh.bus_list!.length, 1);
    const bus = sh.bus_list![0]!;
    assert.equal(bus.type, "TC");
    assert.equal(bus.sockets, 6);
    assert.equal(bus.distance, 157.5);
    assert.equal(bus.connection, "");
    // обновление: гнёзда 6 → 4, align R — distance по новому числу гнёзд
    // (ревью 293 №10): 393 − 2×15 − (6×4+12=36) = 327
    const u = await call(client, "shield_bus_update", { item_id: "sh1", bus_id: bus.bus_id, sockets: 4, align: "R" });
    const sh2 = u["entity"] as { bus_list: { bus_id: string; type: string; sockets: number; distance: number }[] };
    assert.equal(sh2.bus_list![0]!.sockets, 4);
    assert.equal(sh2.bus_list![0]!.type, "TR");
    assert.equal(sh2.bus_list![0]!.distance, 327);
    // провод к гнезду шины + удаление шины → deleted_wires
    await call(client, "shield_wire_add", { item_id: "sh1", type: "shield_wire_phase", source: { module_id: idA, port: 0 }, target: { bus: bus.bus_id, port: 0 } });
    const del = await call(client, "shield_bus_delete", { item_id: "sh1", bus_id: bus.bus_id });
    assert.equal((del as { deleted_wires?: string[] }).deleted_wires?.length, 1);
    void idB;
  } finally {
    await client.close();
  }
});

test("291: shield_bus_add — sockets вне 4..25 и position не T/B отвергаются схемой", async () => {
  const client = await start();
  try {
    for (const sockets of [3, 26]) {
      const res = await client.callTool({ name: "shield_bus_add", arguments: { item_id: "sh1", position: "T", sockets } });
      assert.equal(res.isError, true, `sockets ${sockets}`);
      assert.equal(errPayload(res).code, "INVALID_ARGUMENT");
    }
    const res = await client.callTool({ name: "shield_bus_add", arguments: { item_id: "sh1", position: "X" } });
    assert.equal(res.isError, true, "position X");
    assert.equal(errPayload(res).code, "INVALID_ARGUMENT");
  } finally {
    await client.close();
  }
});

test("291: shield_wire_add к шине с другим connection — bus_connection_conflict (как в редакторе)", async () => {
  const client = await start();
  try {
    const [idA] = await threeModules(client);
    const add = await call(client, "shield_bus_add", { item_id: "sh1", position: "T" });
    const busId = ((add["entity"] as { bus_list: { bus_id: string }[] }).bus_list![0]!).bus_id;
    await call(client, "shield_wire_add", { item_id: "sh1", type: "shield_wire_phase", source: { module_id: idA, port: 0 }, target: { bus: busId, port: 0 } });
    const [idB] = await threeModules(client);
    const res = await client.callTool({ name: "shield_wire_add", arguments: { item_id: "sh1", type: "shield_wire_null", source: { module_id: idB, port: 0 }, target: { bus: busId, port: 1 } } });
    assert.equal(res.isError, true, "конфликт connection");
    const payload = errPayload(res);
    assert.equal(payload.code, "INVALID_ARGUMENT");
    assert.equal((payload.details as { kind?: string } | undefined)?.kind, "bus_connection_conflict");
    // провод того же типа на другое гнездо — можно
    const ok2 = await call(client, "shield_wire_add", { item_id: "sh1", type: "shield_wire_phase", source: { module_id: idB, port: 0 }, target: { bus: busId, port: 2 } });
    assert.ok(ok2["entity"]);
  } finally {
    await client.close();
  }
});

// 293 ревью №1: провод между гнёздами шин (разных и одной шины) редактор не даёт
// начать (ShieldBus.port_mousedown) — через публичный инструмент тоже отказ.
test("293 №1: shield_wire_add шина→шина и гнездо той же шины — bus_to_bus (server.callTool)", async () => {
  const client = await start();
  try {
    const b1 = ((await call(client, "shield_bus_add", { item_id: "sh1", position: "T", align: "L" }))["entity"] as { bus_list: { bus_id: string }[] }).bus_list![0]!.bus_id;
    const b2 = ((await call(client, "shield_bus_add", { item_id: "sh1", position: "T", align: "R" }))["entity"] as { bus_list: { bus_id: string }[] }).bus_list![0]!.bus_id;
    const cases: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
      [{ bus: b1, port: 0 }, { bus: b2, port: 0 }, "шина→шина"],
      [{ bus: b1, port: 0 }, { bus: b1, port: 1 }, "гнездо→гнездо той же шины"],
    ];
    for (const [source, target, name] of cases) {
      const res = await client.callTool({ name: "shield_wire_add", arguments: { item_id: "sh1", type: "shield_wire_phase", source, target } });
      assert.equal(res.isError, true, name);
      const payload = errPayload(res);
      assert.equal(payload.code, "INVALID_ARGUMENT", name);
      assert.equal((payload.details as { kind?: string } | undefined)?.kind, "bus_to_bus", name);
    }
    // атомарность: шины без проводов, connection пуст
    const sh = ((await call(client, "model_get", {})) as unknown as { shields: { wires?: unknown[]; bus_list: { connection: string }[] }[] }).shields[0]!;
    assert.equal(sh.wires?.length ?? 0, 0, "проводов нет");
    assert.ok(sh.bus_list!.every((b) => b.connection === ""));
    // ревью 294 N2: шина→модуль разрешена (нельзя только шина→шина)
    const [modId] = await threeModules(client);
    const okBusToModule = await call(client, "shield_wire_add", { item_id: "sh1", type: "shield_wire_phase", source: { bus: b1, port: 1 }, target: { module_id: modId, port: 0 } });
    assert.ok(okBusToModule["entity"], "шина→модуль");
  } finally {
    await client.close();
  }
});

test("291: shield_collector_add/update/delete — collector_list и валидация", async () => {
  const client = await start();
  try {
    const [idA, idB, idC] = await threeModules(client);
    const add = await call(client, "shield_collector_add", { item_id: "sh1", modules: [idA, idB] });
    const sh = add["entity"] as { collectors: number; collector_list: { collector_id: string; rail: number; module_width: number; module_ids: string[]; position: string }[] };
    assert.equal(sh.collectors, 1);
    const col = sh.collector_list![0]!;
    assert.equal(col.rail, 0);
    assert.equal(col.module_width, 1);
    assert.deepEqual(col.module_ids, [idA, idB]);
    assert.equal(col.position, "T");
    // update: заменить набор
    const u = await call(client, "shield_collector_update", { item_id: "sh1", collector_id: col.collector_id, modules: [idB, idC] });
    const sh2 = u["entity"] as { collector_list: { module_ids: string[] }[] };
    assert.deepEqual(sh2.collector_list![0]!.module_ids, [idB, idC]);
    // один модуль — отказ
    const res = await client.callTool({ name: "shield_collector_update", arguments: { item_id: "sh1", collector_id: col.collector_id, modules: [idA] } });
    assert.equal(res.isError, true);
    assert.equal(errPayload(res).code, "INVALID_ARGUMENT");
    // удаление
    const del = await call(client, "shield_collector_delete", { item_id: "sh1", collector_id: col.collector_id });
    assert.equal(del["deleted"], col.collector_id);
    // повторное удаление — NOT_FOUND
    const res2 = await client.callTool({ name: "shield_collector_delete", arguments: { item_id: "sh1", collector_id: col.collector_id } });
    assert.equal(res2.isError, true);
    assert.equal(errPayload(res2).code, "NOT_FOUND");
  } finally {
    await client.close();
  }
});

test("291: shield_collector_add — неколлекторный модуль и разрыв отвергаются", async () => {
  const client = await start();
  try {
    // неколлекторный модуль (uvr) на рейке
    await call(client, "shield_module_add", { item_id: "sh1", type: "shield_module_uvr", subtype: "63A" });
    await call(client, "shield_module_add", { item_id: "sh1", type: "shield_module_uvr", subtype: "63A" });
    const sh = ((await call(client, "model_get", {})) as unknown as { shields: { modules: { module_id: string }[] }[] }).shields[0]!;
    const mods = sh.modules.map((m) => m.module_id);
    const res = await client.callTool({ name: "shield_collector_add", arguments: { item_id: "sh1", modules: [mods[0], mods[1]] } });
    assert.equal(res.isError, true, "uvr — не коллекторный");
    const payload = errPayload(res);
    assert.equal(payload.code, "INVALID_ARGUMENT");
    assert.equal((payload.details as { kind?: string } | undefined)?.kind, "not_collector_module");
    // разрыв: модули 0 и 2 — между ними чужой модуль 1
    const [idA, , idC] = await threeModules(client);
    const res2 = await client.callTool({ name: "shield_collector_add", arguments: { item_id: "sh1", modules: [idA, idC] } });
    assert.equal(res2.isError, true, "разрыв");
    assert.equal((errPayload(res2).details as { kind?: string } | undefined)?.kind, "collector_gap");
  } finally {
    await client.close();
  }
});
