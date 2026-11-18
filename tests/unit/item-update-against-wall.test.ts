// Ревью 198 №1/№2/№3: item_update against_wall на уровне инструмента (MCP-клиент
// + офлайн-фикстура, как в server-smoke). Эталон — состояние модели после item_add
// с теми же аргументами (независимые значения, не функция с собой): pc, угол,
// id_wall, новые width_mm/depth_mm, у socket_group — угол «ось + 180» и под-элемент
// на той же стороне, что у item_add.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { join } from "node:path";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import type { ItemProps } from "../../src/model/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };

const text = (r: unknown): string => ((r as ToolCallResult).content as { text: string }[])[0]!.text;

async function start(): Promise<{ client: Client; ctx: ServerContext }> {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "item-update-against-wall", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, ctx };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(!res.isError, `${name}: ${text(res)}`);
}

/** Предметы канонической модели в порядке model_get (I<n> — индекс с 1). */
function itemsOf(ctx: ServerContext): ItemProps[] {
  return Object.values(ctx.workspace().model.items);
}

test("item_update against_wall == item_add: pc, угол, id_wall, новые размеры, под-элемент socket_group", async () => {
  const { client, ctx } = await start();
  // комнаты канонической модели — в см (как пишет нормализация редактора); в сырой
  // загрузке anon-фикстуры rooms2 лежит в мм, для детерминизма подменяем на см
  (ctx.workspace().model.rooms2 as unknown) = {
    r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 },
  };
  // эталоны — item_add с теми же аргументами (состояние модели после addItem)
  await call(client, "item_add", {
    name: "sofa",
    position: { against_wall: { wall_id: "W1", offset_mm: 1000, gap_mm: 0 } },
    width_mm: 800, depth_mm: 600,
  });
  await call(client, "item_add", {
    name: "socket",
    position: { against_wall: { wall_id: "W1", offset_mm: 1500, gap_mm: 0 } },
    depth_mm: 180,
  });
  // предметы для переноса — сначала у другой стены (W2, правая), потом against_wall W1
  await call(client, "item_add", { name: "sofa", position: { against_wall: { wall_id: "W2", offset_mm: 500, gap_mm: 0 } } });
  await call(client, "item_add", { name: "socket", position: { against_wall: { wall_id: "W2", offset_mm: 500, gap_mm: 0 } } });
  // эталон и перенос без width_mm/depth_mm — габариты из каталога (мутация
  // «width из target.height» в проводке tools-plan должна краснеть)
  await call(client, "item_add", { name: "sofa", position: { against_wall: { wall_id: "W1", offset_mm: 2000, gap_mm: 0 } } });
  await call(client, "item_add", { name: "sofa", position: { against_wall: { wall_id: "W2", offset_mm: 2000, gap_mm: 0 } } });
  await call(client, "item_update", {
    item_id: "I3",
    position: { against_wall: { wall_id: "W1", offset_mm: 1000, gap_mm: 0 } },
    width_mm: 800, depth_mm: 600,
  });
  await call(client, "item_update", {
    item_id: "I4",
    position: { against_wall: { wall_id: "W1", offset_mm: 1500, gap_mm: 0 } },
    depth_mm: 180,
  });
  await call(client, "item_update", {
    item_id: "I6",
    position: { against_wall: { wall_id: "W1", offset_mm: 2000, gap_mm: 0 } },
  });

  const [addedSofa, addedSocket, movedSofa, movedSocket, addedSofa2, movedSofa2] = itemsOf(ctx);
  assert.ok(addedSofa && addedSocket && movedSofa && movedSocket && addedSofa2 && movedSofa2);

  // ревью 198 №2: id_wall = новая стена (W1 — верхняя), как у item_add, не старая и не null
  const wallW1 = Object.values(ctx.workspace().model.walls)[0]!.id;
  assert.equal(addedSofa.id_wall, wallW1);
  assert.equal(movedSofa.id_wall, wallW1);
  assert.equal(movedSocket.id_wall, wallW1);
  assert.equal(movedSofa2.id_wall, wallW1);

  // те же аргументы → та же точка, угол и габариты (новые width_mm/depth_mm применены)
  assert.deepEqual(movedSofa.pc, addedSofa.pc);
  assert.equal(movedSofa.angle, addedSofa.angle);
  assert.equal(movedSofa.width, addedSofa.width);
  assert.equal(movedSofa.height, addedSofa.height);
  // без width_mm/depth_mm — габариты как у item_add из каталога
  assert.deepEqual(movedSofa2.pc, addedSofa2.pc);
  assert.equal(movedSofa2.width, addedSofa2.width);
  assert.equal(movedSofa2.height, addedSofa2.height);

  // ревью 198 №1: у socket_group угол «ось + 180» (как в item_add), под-элемент —
  // на той же стороне (center совпадает с item_add)
  assert.equal(addedSocket.name, "socket_group");
  assert.equal(movedSocket.angle, addedSocket.angle);
  assert.deepEqual(movedSocket.pc, addedSocket.pc);
  const addedSub = (addedSocket.socket_group as { center: { x: number; y: number } }[])[0]!;
  const movedSub = (movedSocket.socket_group as { center: { x: number; y: number } }[])[0]!;
  assert.ok(Math.abs(addedSub.center.x - addedSocket.pc.x) < 1e-9, "item_add: под-элемент по pc (розетка h=18: center ближе к стене)");
  assert.ok(addedSub.center.y < addedSocket.pc.y, "item_add: под-элемент со стороны стены (y меньше у верхней стены)");
  assert.deepEqual(movedSub.center, addedSub.center);
  await client.close();
});
