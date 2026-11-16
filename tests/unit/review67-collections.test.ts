// Ревью 67, major №2: project_clear и project_import_plan учитывают ВСЕ коллекции
// объектов (общий реестр): ригели, газовые линии, границы террас/участка, проёмы пола.
// Офлайн-режим на фикстуре.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import type { Model } from "../../src/model/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as ToolCallResult).content as { text: string }[])[0]!.text;

async function start(): Promise<{ client: Client; ctx: ServerContext }> {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "rev67-collections", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, ctx };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(!res.isError, `${name}: ${text(res)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
}

function fullModel(m: Record<string, unknown>): Model {
  return m as unknown as Model;
}

async function populate(client: Client): Promise<void> {
  await call(client, "terrace_add", {
    points: [{ x: 6000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 3000 }, { x: 6000, y: 3000 }],
  });
  await call(client, "territory_add", {
    points: [{ x: 10000, y: 1000 }, { x: 13000, y: 1000 }, { x: 13000, y: 4000 }, { x: 10000, y: 4000 }],
  });
  await call(client, "terrace_column_add", { center: { x: 7000, y: 2000 } });
  await call(client, "rigel_add", { start: { x: 1000, y: -1000 }, end: { x: 3000, y: -1000 } });
  await call(client, "gas_line_add", { start: { x: 3500, y: -500 }, end: { x: 3700, y: -500 } });
}

function counters(m: Model): Record<string, number> {
  return {
    walls: Object.keys(m.walls ?? {}).length,
    pillars: Object.keys(m.pillars ?? {}).length,
    rigels: Object.keys(m.rigels ?? {}).length,
    pipes_gas: Object.keys((m as Record<string, Record<string, unknown>>).pipes_gas ?? {}).length,
    terrace_borders: Object.keys((m as Record<string, Record<string, unknown>>).terrace_borders ?? {}).length,
    territory_borders: Object.keys((m as Record<string, Record<string, unknown>>).territory_borders ?? {}).length,
    level_holes: Object.keys((m as Record<string, Record<string, unknown>>).level_holes ?? {}).length,
  };
}

test("rev67 M2: project_clear убирает ВСЕ коллекции (ригели, газ, границы, проёмы пола); undo восстанавливает", async () => {
  const { client } = await start();
  await populate(client);
  await call(client, "project_clear", { confirm: true });
  const cleared = fullModel(await call(client, "model_get", { detail: "full" }));
  const c = counters(cleared);
  for (const [k, v] of Object.entries(c)) {
    assert.equal(v, 0, `${k} после clear = ${v}`);
  }
  const undone = await call(client, "undo", {});
  assert.equal((undone as { applied: number }).applied, 1);
  const restored = fullModel(await call(client, "model_get", { detail: "full" }));
  const c2 = counters(restored);
  assert.ok(c2.terrace_borders === 4 && c2.territory_borders === 4 && c2.rigels === 1 && c2.pipes_gas === 1 && c2.level_holes === 0, JSON.stringify(c2));
  await client.close();
});

test("rev67 M2: project_import_plan переносит новые коллекции и убирает старые лишние", async () => {
  const { client } = await start();
  await populate(client);
  const dir = mkdtempSync(join(tmpdir(), "rev67-"));
  const planPath = join(dir, "import.plan");
  await call(client, "project_export_plan", { path: planPath, scope: "full" });
  // импортируем пустую фикстуру (без новых коллекций) — старые коллекции должны уйти
  await call(client, "project_import_plan", { path: FIXTURE, replace: true });
  const afterEmpty = counters(fullModel(await call(client, "model_get", { detail: "full" })));
  for (const k of ["terrace_borders", "territory_borders", "level_holes", "pipes_gas"]) {
    assert.equal(afterEmpty[k], 0, `${k} после импорта пустой модели = ${afterEmpty[k]}`);
  }
  // импортируем сохранённую модель — новые коллекции возвращаются
  await call(client, "project_import_plan", { path: planPath, replace: true });
  const back = counters(fullModel(await call(client, "model_get", { detail: "full" })));
  assert.ok(back.terrace_borders === 4 && back.territory_borders === 4 && back.rigels === 1 && back.pipes_gas === 1, JSON.stringify(back));
  await client.close();
});

test("rev67 M2: export→import roundtrip сохраняет проём в полу без потерь", async () => {
  const { client } = await start();
  await populate(client);
  await call(client, "floor_hole_add", { corner1: { x: 1000, y: 1000 }, corner2: { x: 2000, y: 2000 } });
  const dir = mkdtempSync(join(tmpdir(), "rev67-"));
  const planPath = join(dir, "roundtrip.plan");
  await call(client, "project_export_plan", { path: planPath, scope: "full" });
  await call(client, "project_clear", { confirm: true });
  await call(client, "project_import_plan", { path: planPath, replace: true });
  const m = fullModel(await call(client, "model_get", { detail: "full" }));
  const holes = Object.values((m as unknown as { level_holes?: Record<string, unknown> }).level_holes ?? {});
  assert.equal(holes.length, 1);
  const h = holes[0] as unknown as { polygon: { x: number; y: number }[]; area: number; type: string };
  assert.equal(h.type, "floor_hole");
  assert.equal(h.polygon.length, 4);
  assert.ok(Math.abs(h.area - 1) < 0.01, `area ${h.area}`);
  await client.close();
});
