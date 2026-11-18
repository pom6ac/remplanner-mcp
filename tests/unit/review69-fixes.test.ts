// Ревью 68, этап 69: 68-1 — clear/import сохраняют инвариант Model (обязательные
// коллекции остаются пустыми объектами, неизвестные поля модели сохраняются);
// 68-3 — ответы terrace_add/terrace_border_update/territory_add/territory_border_update в мм.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { clearEntityCollections, replaceEntityCollections } from "../../src/model/collections.ts";
import { PLANS_DIR } from "../../src/config.ts";
import type { Model } from "../../src/model/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as ToolCallResult).content as { text: string }[])[0]!.text;

async function start(): Promise<{ client: Client; ctx: ServerContext }> {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "rev69-fixes", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, ctx };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(!res.isError, `${name}: ${text(res)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
}

// ---------- 68-1: инвариант Model после clear/import ----------

test("rev68 M1: после project_clear обязательные коллекции — пустые объекты; validate и add работают", async () => {
  const { client } = await start();
  await call(client, "terrace_add", { points: [{ x: 6000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 3000 }, { x: 6000, y: 3000 }] });
  await call(client, "project_clear", { confirm: true });
  const m = (await call(client, "model_get", { detail: "full" })) as unknown as Model;
  for (const key of ["walls", "items", "pillars", "rulers", "comments"]) {
    assert.ok(typeof m[key as keyof Model] === "object" && m[key as keyof Model] !== null, `${key} существует после clear`);
    assert.equal(Object.keys(m[key as keyof Model] as object).length, 0, `${key} пуст`);
  }
  const validate = await call(client, "model_validate", {});
  assert.equal(validate.ok, true, JSON.stringify(validate));
  // прежняя регрессия ревью 68: add после clear падал INTERNAL на undefined-коллекциях
  await call(client, "pillar_add", { center: { x: 1000, y: 1000 }, width_mm: 200, height_mm: 200 });
  await call(client, "terrace_add", { points: [{ x: 6000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 3000 }, { x: 6000, y: 3000 }] });
  await call(client, "gas_line_add", { start: { x: 3500, y: -500 }, end: { x: 3700, y: -500 } });
  await client.close();
});

test("rev68 M1: clear сохраняет неизвестные поля модели", () => {
  const model = { v: 1, id: "x", plan_id: "1", walls: { w1: {} }, items: {}, pillars: {}, rulers: {}, comments: {}, custom_field: { a: 1 } } as unknown as Model;
  clearEntityCollections(model);
  assert.deepEqual((model as unknown as Record<string, unknown>).custom_field, { a: 1 });
  for (const key of ["walls", "items", "pillars", "rulers", "comments"]) {
    assert.ok(typeof model[key as keyof Model] === "object", `${key} остался`);
  }
});

test("rev68 M1: import модели без обязательных коллекций — инвариант восстановлен, validate и add работают", async () => {
  const { client } = await start();
  // 213 plans-root: путь импорта — относительно корня plans
  const planPath = "rev69-bare.plan";
  mkdirSync(PLANS_DIR, { recursive: true });
  writeFileSync(join(PLANS_DIR, planPath), JSON.stringify({ v: 1, id: "x", plan_id: "1", total_height: 270, terrace_borders: { t1: { id: "t1", p1: { x: 600, y: 100 }, p2: { x: 900, y: 100 } } } }));
  await call(client, "project_import_plan", { path: planPath, replace: true });
  const m = (await call(client, "model_get", { detail: "full" })) as unknown as Model;
  for (const key of ["walls", "items", "pillars", "rulers", "comments"]) {
    assert.ok(typeof m[key as keyof Model] === "object" && m[key as keyof Model] !== null, `${key} существует после import`);
  }
  const validate = await call(client, "model_validate", {});
  assert.equal(validate.ok, true, JSON.stringify(validate));
  await call(client, "pillar_add", { center: { x: 1000, y: 1000 }, width_mm: 200, height_mm: 200 });
  await client.close();
  rmSync(join(PLANS_DIR, planPath), { force: true });
});

test("rev68 M1: replaceEntityCollections — null/не-объект источника для обязательной коллекции даёт пустой объект", () => {
  const target = { v: 1, id: "t", plan_id: "1", walls: { w: {} }, items: {}, pillars: {}, rulers: {}, comments: {}, custom_field: 7 } as unknown as Model;
  const source = { v: 1, id: "s", plan_id: "1", walls: null, items: [], pillars: undefined, rigels: { r1: { id: "r1" } } } as unknown as Model;
  replaceEntityCollections(target, source);
  for (const key of ["walls", "items", "pillars", "rulers", "comments"]) {
    const v = target[key as keyof Model];
    assert.equal(typeof v, "object", `${key} — объект`);
    assert.ok(v !== null && v !== undefined, `${key} не пуст (инвариант)`);
  }
  assert.equal(Object.keys(target.walls).length, 0);
  assert.ok(Array.isArray(target.items), "массив источника скопирован как есть (валидация — отдельный долг)");
  assert.equal(Object.keys(target.rigels!).length, 1);
  assert.equal((target as unknown as Record<string, unknown>).custom_field, 7, "неизвестные поля цели сохранены");
  assert.equal(target.terrace_borders, undefined, "необязательная отсутствующая коллекция удалена");
});

// ---------- 68-3: ответы border-* в мм ----------

type Border = { id: string; p1: { x: number; y: number }; p2: { x: number; y: number } };

test("rev68 M3: terrace_add / terrace_border_update возвращают концы в мм", async () => {
  const { client } = await start();
  const added = await call(client, "terrace_add", { points: [{ x: 6000, y: 1000 }, { x: 9000, y: 1000 }, { x: 9000, y: 3000 }, { x: 6000, y: 3000 }] });
  const borders = added.borders as Border[];
  assert.equal(borders.length, 4);
  const first = borders.find((b) => b.p1.x === 6000 && b.p1.y === 1000)!;
  assert.ok(first, JSON.stringify(borders));
  assert.deepEqual(first.p2, { x: 9000, y: 1000 });
  const updated = await call(client, "terrace_border_update", { terrace_border_id: first.id, start: { x: 6500, y: 1000 } });
  const border = updated.border as Border;
  assert.deepEqual(border.p1, { x: 6500, y: 1000 });
  assert.deepEqual(border.p2, { x: 9000, y: 1000 });
  await client.close();
});

test("rev68 M3: territory_add / territory_border_update возвращают концы в мм", async () => {
  const { client } = await start();
  const added = await call(client, "territory_add", { points: [{ x: 10000, y: 1000 }, { x: 13000, y: 1000 }, { x: 13000, y: 4000 }, { x: 10000, y: 4000 }] });
  const borders = added.created as Border[];
  assert.equal(borders.length, 4);
  const first = borders.find((b) => b.p1.x === 10000 && b.p1.y === 1000)!;
  assert.ok(first, JSON.stringify(borders));
  assert.deepEqual(first.p2, { x: 13000, y: 1000 });
  const updated = await call(client, "territory_border_update", { territory_border_id: first.id, end: { x: 13000, y: 1500 } });
  const border = updated.border as Border;
  assert.deepEqual(border.p1, { x: 10000, y: 1000 });
  assert.deepEqual(border.p2, { x: 13000, y: 1500 });
  await client.close();
});
