// Ревью 331 Н3/Н4: поведение двухуровневого потолка при смене материала и
// снятии покрытия — полный путь MCP (офлайн-контекст, без сайта).
// Н3: complex_removed в ответах и complex/level2/material2 в finish_get
// покрыты тестами (мутации «complexRemoved=false» и «finish_get без complex»
// краснеют). Н4а: смена на ТОТ же материал — no-op, complex сохраняется (как в
// редакторе: бандл 268-app.js вызывает обработчик смены только при
// tool!==r.material). Н4б: finish_ceiling_remove при complex — ОТКАЗ (в
// редакторе ластик complex не снимает, живая проба 328-complex шаг 3).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as ToolCallResult).content as { text: string }[])[0]!.text;
const payload = <T>(r: unknown): T => JSON.parse(text(r)) as T;

async function start(): Promise<Client> {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "ceiling-complex-server", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

type CeilingView = { material: string; level?: number; complex: boolean; level2?: number; material2?: string };

async function ceilingOf(client: Client): Promise<CeilingView | undefined> {
  const res = await client.callTool({ name: "finish_get", arguments: { room_id: "R1" } });
  const rooms = payload<{ ceiling?: CeilingView }[]>(res);
  return rooms[0]?.ceiling;
}

test("ревью 331 Н3: complex → finish_get показывает complex/level2/material2; смена материала — warning complex_removed и complex:false в finish_get", async () => {
  const client = await start();
  try {
    const set = await client.callTool({ name: "finish_ceiling_complex_set", arguments: { room_id: "R1" } });
    assert.ok(!set.isError, text(set));
    const c1 = await ceilingOf(client);
    assert.ok(c1, "в finish_get есть потолок");
    assert.equal(c1!.complex, true, "finish_get показывает complex:true");
    assert.equal(c1!.level2, 7.5, "finish_get показывает level2");
    assert.equal(c1!.material2, "stretch_ceiling", "finish_get показывает material2");

    // смена на ДРУГОЙ материал: комплекс снят, не молча (ревью 329 №5/331 Н3)
    const change = await client.callTool({ name: "finish_ceiling_set", arguments: { room_id: "R1", material: "stretch_ceiling" } });
    assert.ok(!change.isError, text(change));
    const body = payload<{ warnings?: string[] }>(change);
    assert.ok(Array.isArray(body.warnings) && body.warnings.some((w) => w.startsWith("complex_removed")), `warning complex_removed в ответе: ${text(change)}`);
    const after = await ceilingOf(client);
    assert.ok(after, "после смены finish_get показывает потолок");
    assert.equal(after!.complex, false, "complex:false после смены материала");
    assert.equal(after!.level2, undefined, "level2 больше не показывается");
    assert.equal(after!.material2, undefined, "material2 больше не показывается");
  } finally {
    await client.close();
  }
});

test("ревью 331 Н4а: смена на тот же материал — no-op, complex сохраняется (как в редакторе, tool!==r.material)", async () => {
  const client = await start();
  try {
    assert.ok(!((await client.callTool({ name: "finish_ceiling_complex_set", arguments: { room_id: "R1" } })).isError));
    // базовый материал complex-записи — gypsum_ceiling (эталон 328-complex-etalon)
    const same = await client.callTool({ name: "finish_ceiling_set", arguments: { room_id: "R1", material: "gypsum_ceiling" } });
    assert.ok(!same.isError, text(same));
    const body = payload<{ warnings?: string[]; ceiling_id?: string }>(same);
    assert.ok(!body.warnings || body.warnings.length === 0, `нет complex_removed: ${text(same)}`);
    const c = await ceilingOf(client);
    assert.equal(c!.complex, true, "двухуровневая отделка сохранена при смене на тот же материал");
    assert.equal(c!.level2, 7.5, "level2 сохранён");
    assert.equal(c!.material2, "stretch_ceiling", "material2 сохранён");
  } finally {
    await client.close();
  }
});

test("ревью 333 Р1: тот же материал + level — уровень записан (no-op не глотает level/profile)", async () => {
  const client = await start();
  try {
    assert.ok(!((await client.callTool({ name: "finish_ceiling_set", arguments: { room_id: "R1", material: "gypsum_ceiling" } })).isError));
    const same = await client.callTool({ name: "finish_ceiling_set", arguments: { room_id: "R1", material: "gypsum_ceiling", level: 20 } });
    assert.ok(!same.isError, text(same));
    assert.ok(!(payload<{ warnings?: string[] }>(same).warnings ?? []).some((w) => w.startsWith("complex_removed")), "complex не снимается");
    const c = await ceilingOf(client);
    assert.equal(c!.level, 20, `уровень записан при том же материале: ${JSON.stringify(c)}`);
    assert.equal(c!.complex, false, "complex не появился");
  } finally {
    await client.close();
  }
});

test("ревью 333 Р1: тот же материал + level=-5 / profile=bogus — INVALID_ARGUMENT (валидация до no-op)", async () => {
  const client = await start();
  try {
    assert.ok(!((await client.callTool({ name: "finish_ceiling_set", arguments: { room_id: "R1", material: "gypsum_ceiling" } })).isError));
    const badLevel = await client.callTool({ name: "finish_ceiling_set", arguments: { room_id: "R1", material: "gypsum_ceiling", level: -5 } });
    assert.ok(badLevel.isError, `ожидался отказ level=-5: ${text(badLevel)}`);
    assert.equal(payload<{ code?: string }>(badLevel).code, "INVALID_ARGUMENT");
    const badProfile = await client.callTool({ name: "finish_ceiling_set", arguments: { room_id: "R1", material: "gypsum_ceiling", profile: "bogus" } });
    assert.ok(badProfile.isError, `ожидался отказ profile=bogus: ${text(badProfile)}`);
    assert.equal(payload<{ code?: string }>(badProfile).code, "INVALID_ARGUMENT");
    // модель не тронута: уровень остался прежним (0)
    const c = await ceilingOf(client);
    assert.equal(c!.level, 0, "после отказов уровень не изменился");
  } finally {
    await client.close();
  }
});

test("ревью 331 Н4б: finish_ceiling_remove при complex — отказ с понятным текстом (ластик в редакторе complex не снимает)", async () => {
  const client = await start();
  try {
    assert.ok(!((await client.callTool({ name: "finish_ceiling_complex_set", arguments: { room_id: "R1" } })).isError));
    const rm = await client.callTool({ name: "finish_ceiling_remove", arguments: { room_id: "R1" } });
    assert.ok(rm.isError, `ожидался отказ: ${text(rm)}`);
    const err = payload<{ code?: string; message?: string }>(rm);
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.ok((err.message ?? "").includes("двухуровневый"), `в тексте отказа — про двухуровневый потолок: ${err.message}`);
    // complex не тронут
    const c = await ceilingOf(client);
    assert.equal(c!.complex, true, "после отказа complex на месте");
  } finally {
    await client.close();
  }
});

test("ревью 333 Р4: цепочка complex → set другим материалом (complex_removed) → finish_ceiling_remove проходит", async () => {
  const client = await start();
  try {
    assert.ok(!((await client.callTool({ name: "finish_ceiling_complex_set", arguments: { room_id: "R1" } })).isError));
    const change = await client.callTool({ name: "finish_ceiling_set", arguments: { room_id: "R1", material: "stretch_ceiling" } });
    assert.ok(!change.isError, text(change));
    assert.ok((payload<{ warnings?: string[] }>(change).warnings ?? []).some((w) => w.startsWith("complex_removed")), "complex снят сменой материала");
    // после снятия complex ластик работает по обычной ветке
    const rm = await client.callTool({ name: "finish_ceiling_remove", arguments: { room_id: "R1" } });
    assert.ok(!rm.isError, `finish_ceiling_remove после снятия complex: ${text(rm)}`);
    const c = await ceilingOf(client);
    assert.ok(c === undefined || c.complex === false, "покрытие снято");
  } finally {
    await client.close();
  }
});

test("ревью 331 Н4б: finish_ceiling_remove без complex — работает, как раньше", async () => {
  const client = await start();
  try {
    assert.ok(!((await client.callTool({ name: "finish_ceiling_set", arguments: { room_id: "R1", material: "gypsum_ceiling" } })).isError));
    const rm = await client.callTool({ name: "finish_ceiling_remove", arguments: { room_id: "R1" } });
    assert.ok(!rm.isError, text(rm));
    const c = await ceilingOf(client);
    assert.ok(c === undefined || c.complex === false, "покрытие снято");
  } finally {
    await client.close();
  }
});
