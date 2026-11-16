// T18/T19: MCP smoke-тест — SDK-клиент подключается к серверу (InMemoryTransport),
// listTools видит все инструменты design §7, вызовы в офлайн-режиме (REMPLANNER_OFFLINE_FIXTURE)
// работают на фикстуре, сетевые операции дают AUTH_REQUIRED, схемы отвергают мусор.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { join } from "node:path";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

const EXPECTED_TOOLS = [
  // §7.1
  "auth_status", "project_list", "project_create", "project_open", "project_save",
  "project_rename", "project_export_plan", "project_import_plan", "project_clear",
  "floor_list", "plan_list", "undo", "redo", "editor_status",
  // §7.2
  "wall_add", "walls_add_polyline", "room_add_rect", "room_add_polygon", "wall_update",
  "wall_move", "wall_split", "wall_delete", "rooms_list", "project_set_height",
  // §7.3
  "opening_add", "opening_update", "opening_delete",
  // §7.4
  "catalog_search", "catalog_get", "item_add", "item_update", "item_delete", "items_list",
  // §7.4b — колонны (пункт меню «Несущая колонна», этап 41)
  "pillar_add", "pillar_update", "pillar_delete",
  // §7.4c — потолочные ригели (пункт меню «Потолочный ригель», этап 47)
  "rigel_add", "rigel_update", "rigel_delete",
  // §7.4d — газовая линия (пункт меню «Коммуникации», этап 57)
  "gas_line_add", "gas_line_update", "gas_line_delete",
  "pipe_add", "pipe_update", "pipe_delete",
  "led_strip_add", "led_strip_update", "led_strip_delete",
  "stripe_add", "stripe_update", "stripe_delete",
  "line_light_add", "line_light_update", "line_light_delete",
  // §7.4e — проем в полу, терраса и участок (этап 64)
  "floor_hole_add", "floor_hole_update", "floor_hole_delete",
  "terrace_add", "terrace_border_update", "terrace_border_delete",
  "terrace_fence_add", "terrace_column_add", "terrace_column_update", "terrace_column_delete",
  "territory_add", "territory_border_update", "territory_border_delete",
  // §7.4f — балкон (пункт меню «Нарисовать балкон», этап 71)
  "balcony_add", "balcony_update", "balcony_delete",
  // §7.6
  "model_get", "model_validate", "render_plan",
];

async function start(): Promise<Client> {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "smoke", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };

function errCode(result: unknown): string {
  assert.equal((result as ToolCallResult).isError, true, "ожидалась ошибка");
  const parsed = JSON.parse((result as ToolCallResult).content?.[0]?.text ?? "{}") as { code?: string };
  return parsed.code ?? "";
}

const text = (r: unknown): string => ((r as ToolCallResult).content as { text: string }[])[0]!.text;

test("smoke: listTools — все инструменты design §7.1–7.4, 7.6 с описаниями и схемами", async () => {
  const client = await start();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 30, `у ${t.name} пустое описание`);
  }
  // сценарий «нарисовал → validate → render → save» упомянут в описаниях мутирующих инструментов
  const wallAdd = tools.find((t) => t.name === "wall_add")!;
  assert.match(wallAdd.description!, /project_save/);
  const save = tools.find((t) => t.name === "project_save")!;
  assert.match(save.description!, /SAVE_CONFLICT/);
  const takeOverHint = tools.find((t) => t.name === "auth_status")!;
  assert.ok(takeOverHint.description!.length > 0);
  await client.close();
});

test("smoke: офлайн-режим — model_get и rooms_list на фикстуре 4000×3000", async () => {
  const client = await start();
  const res = await client.callTool({ name: "model_get", arguments: {} });
  assert.ok(!res.isError, JSON.stringify(res.content));
  const model = JSON.parse(text(res)) as {
    walls: { id: string; len_mm: number; thickness_mm: number }[];
    rooms: { area_m2: number }[];
    items: unknown[];
  };
  assert.equal(model.walls.length, 4);
  assert.ok(model.walls.every((w) => w.len_mm >= 2990), "осевые длины 4000/3000 мм");
  assert.equal(model.rooms.length, 1);
  assert.ok(Math.abs(model.rooms[0]!.area_m2 - 10.64) < 0.02, `площадь ${model.rooms[0]!.area_m2}`);

  const rooms = await client.callTool({ name: "rooms_list", arguments: {} });
  assert.ok(!rooms.isError);
  await client.close();
});

test("smoke: офлайн — wall_add меняет рабочую копию, validate проходит без связей, undo откатывает", async () => {
  const client = await start();
  // перегородка вне контура фикстуры (та занимает оси 0..400 x 0..300) — наложение по оси запрещено
  const add = await client.callTool({ name: "wall_add", arguments: { start: { x: 5000, y: 0 }, end: { x: 5000, y: 6000 } } });
  assert.ok(!add.isError, text(add));
  const added = JSON.parse(text(add)) as { entity: { id: string } | null };
  assert.ok(added.entity);

  // §12.3: Node не пишет связи; фикстура нормализованная (со связями редактора),
  // поэтому у новой стены валидатор отмечает только свободные узлы — геометрия чистая
  const validate = await client.callTool({ name: "model_validate", arguments: {} });
  const v = JSON.parse(text(validate)) as { ok: boolean; problems: { code: string }[] };
  assert.ok(v.problems.every((p) => p.code === "WALL_DANGLING"), `только свободные узлы: ${JSON.stringify(v.problems)}`);

  const undo = await client.callTool({ name: "undo", arguments: {} });
  const u = JSON.parse(text(undo)) as { applied: number };
  assert.equal(u.applied, 1);

  const get = await client.callTool({ name: "model_get", arguments: {} });
  const m = JSON.parse(text(get)) as { walls: unknown[] };
  assert.equal(m.walls.length, 4);
  await client.close();
});

test("smoke: офлайн — сетевые операции дают AUTH_REQUIRED", async () => {
  const client = await start();
  assert.equal(errCode(await client.callTool({ name: "project_save", arguments: {} })), "AUTH_REQUIRED");
  assert.equal(errCode(await client.callTool({ name: "render_plan", arguments: {} })), "AUTH_REQUIRED");
  assert.equal(errCode(await client.callTool({ name: "project_create", arguments: {} })), "AUTH_REQUIRED");
  await client.close();
});

test("smoke: каталог на фикстуре — «диван» находит позиции, catalog_get по имени", async () => {
  const client = await start();
  const res = await client.callTool({ name: "catalog_search", arguments: { query: "диван", limit: 5 } });
  assert.ok(!res.isError, JSON.stringify(res.content));
  const found = JSON.parse(text(res)) as { name: string; width_mm: number }[];
  assert.ok(found.length > 0, "есть совпадения по «диван»");
  const one = await client.callTool({ name: "catalog_get", arguments: { name: found[0]!.name } });
  assert.ok(!one.isError);
  await client.close();
});

test("smoke: схемы отвергают отрицательные размеры и неизвестный тип проёма", async () => {
  const client = await start();
  const neg = await client.callTool({ name: "wall_add", arguments: { start: { x: -100, y: 0 }, end: { x: 500, y: 0 } } });
  assert.equal(neg.isError, true, "отрицательная координата отвергается");
  const badType = await client.callTool({ name: "opening_add", arguments: { wall_id: "W1", type: "portal_x" } });
  assert.equal(badType.isError, true, "неизвестный тип проёма отвергается");
  const badProj = await client.callTool({ name: "project_clear", arguments: { confirm: "yes" } });
  assert.equal(badProj.isError, true, "confirm литерал true обязателен");
  await client.close();
});

test("smoke: световые линии — update принимает отрицательные координаты (85 №1: план может уходить в минус, как в add)", async () => {
  const client = await start();
  for (const [addTool, updTool, idKey] of [
    ["led_strip_add", "led_strip_update", "led_strip_id"],
    ["stripe_add", "stripe_update", "stripe_id"],
    ["line_light_add", "line_light_update", "line_light_id"],
  ] as const) {
    const add = await client.callTool({ name: addTool, arguments: { kind: "recessed", path: [{ x: -1000, y: -1000 }, { x: 0, y: -1000 }] } });
    assert.ok(!add.isError, `${addTool}: ${text(add)}`);
    const added = JSON.parse(text(add)) as { entity: { site_id: string } | null };
    assert.ok(added.entity, `${addTool}: сущность создана`);
    const upd = await client.callTool({
      name: updTool,
      arguments: { [idKey]: added.entity!.site_id, positions: [{ vertex: 0, x_mm: -500, y_mm: -2000 }] },
    });
    assert.ok(!upd.isError, `${updTool}: отрицательные координаты допустимы: ${text(upd)}`);
    const compact = JSON.parse(text(upd)) as { entity: { from: number[] } | null };
    assert.deepEqual(compact.entity!.from, [-500, -2000], `${updTool}: узел перенесён в минус`);
  }
  await client.close();
});

test("smoke: item_add в центр комнаты, items_list, item_delete", async () => {
  const client = await start();
  const { tools } = await client.listTools();
  void tools;
  // ищем диван в фикстурном каталоге
  const search = await client.callTool({ name: "catalog_search", arguments: { query: "диван", limit: 1 } });
  const found = JSON.parse(text(search)) as { name: string }[];
  assert.ok(found.length > 0, "в catalog-sample.json есть диван");
  const add = await client.callTool({ name: "item_add", arguments: {
    name: found[0]!.name,
    position: { in_room: { room_id: "R1", corner: "center" } },
  } });
  assert.ok(!add.isError, JSON.stringify(add.content));
  const list = await client.callTool({ name: "items_list", arguments: {} });
  const items = JSON.parse(text(list)) as { id: string }[];
  assert.equal(items.length, 1);
  const del = await client.callTool({ name: "item_delete", arguments: { item_id: items[0]!.id } });
  assert.ok(!del.isError);
  await client.close();
});

test("smoke: auth_status и editor_status в офлайне не падают", async () => {
  const client = await start();
  const auth = await client.callTool({ name: "auth_status", arguments: {} });
  assert.ok(!auth.isError);
  const status = JSON.parse(text(auth)) as { mode: string };
  assert.equal(status.mode, "offline");
  const es = await client.callTool({ name: "editor_status", arguments: {} });
  assert.ok(!es.isError, JSON.stringify(es.content));
  await client.close();
});
