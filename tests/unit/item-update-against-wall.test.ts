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
import { updateItem } from "../../src/model/items.ts";
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

test("ревью 203 №8: перенос against_wall многоэлементной socket_group сохраняет шаг под-розеток", async () => {
  const { client, ctx } = await start();
  (ctx.workspace().model.rooms2 as unknown) = {
    r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 },
  };
  // группа из двух под-розеток: item_add даёт одну, вторую редактор создаёт кликом
  // рядом (шаг 7 см вдоль стены, docs/remplanner-features.md) — воспроизводим это
  await call(client, "item_add", {
    name: "socket",
    position: { against_wall: { wall_id: "W2", offset_mm: 500, gap_mm: 0 } },
    depth_mm: 180,
  });
  const group = itemsOf(ctx)[itemsOf(ctx).length - 1]!;
  const subs = group.socket_group as { id: string; center: { x: number; y: number }; real_center: { x: number; y: number }; center_prs: { x: number; y: number } }[];
  assert.equal(subs.length, 1);
  const clone = structuredClone(subs[0]!);
  clone.id = "_sub2";
  clone.center = { x: clone.center.x, y: clone.center.y + 7 };
  clone.real_center = { x: clone.real_center.x, y: clone.real_center.y + 7 };
  clone.center_prs = { ...clone.center };
  subs.push(clone);
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
  const stepBefore = dist(subs[0]!.center, subs[1]!.center);
  assert.equal(stepBefore, 7);

  // перенос на другую стену (W1 — верхняя) — под-розетки не схлопываются в одну точку
  await call(client, "item_update", {
    item_id: "I1",
    position: { against_wall: { wall_id: "W1", offset_mm: 1000, gap_mm: 0 } },
    depth_mm: 180,
  });
  const moved = itemsOf(ctx)[itemsOf(ctx).length - 1]!;
  const after = moved.socket_group as typeof subs;
  assert.equal(after.length, 2);
  assert.equal(dist(after[0]!.center, after[1]!.center), stepBefore, "шаг между под-элементами сохранён");
  assert.equal(dist(after[0]!.real_center, after[1]!.real_center), stepBefore, "шаг real_center сохранён");
  // обе на внутренней стороне новой стены (у верхней стены y не больше pc.y)
  for (const s of after) {
    assert.ok(s.center.y <= moved.pc.y + 1e-9, "под-элемент со стороны стены (внутри)");
  }
  await client.close();
});

test("ревью 203 №3: angle_deg вместе с against_wall игнорируется — угол как у item_add", async () => {
  const { client, ctx } = await start();
  (ctx.workspace().model.rooms2 as unknown) = {
    r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 },
  };
  // эталоны: item_add с angle_deg и against_wall — угол задаёт стена
  await call(client, "item_add", {
    name: "sofa",
    position: { against_wall: { wall_id: "W1", offset_mm: 1000, gap_mm: 0 } },
    width_mm: 800, depth_mm: 600, angle_deg: 45,
  });
  await call(client, "item_add", {
    name: "socket",
    position: { against_wall: { wall_id: "W1", offset_mm: 1500, gap_mm: 0 } },
    depth_mm: 180, angle_deg: 45,
  });
  // предметы для переноса — у другой стены
  await call(client, "item_add", { name: "sofa", position: { against_wall: { wall_id: "W2", offset_mm: 500, gap_mm: 0 } } });
  await call(client, "item_add", { name: "socket", position: { against_wall: { wall_id: "W2", offset_mm: 500, gap_mm: 0 } }, depth_mm: 180 });
  // перенос с angle_deg: 45 — угол тот же, что у item_add (не 45 и не 45+180)
  await call(client, "item_update", {
    item_id: "I3",
    position: { against_wall: { wall_id: "W1", offset_mm: 1000, gap_mm: 0 } },
    width_mm: 800, depth_mm: 600, angle_deg: 45,
  });
  await call(client, "item_update", {
    item_id: "I4",
    position: { against_wall: { wall_id: "W1", offset_mm: 1500, gap_mm: 0 } },
    depth_mm: 180, angle_deg: 45,
  });
  const [addedSofa, addedSocket, movedSofa, movedSocket] = itemsOf(ctx);
  assert.ok(addedSofa && addedSocket && movedSofa && movedSocket);
  // верхняя стена W1: ось 0 → мебель 0, пристенная электрика «ось + 180» → 180
  assert.equal(addedSofa.angle, 0, "item_add sofa: angle_deg при against_wall игнорируется");
  assert.equal(addedSocket.angle, 180, "item_add socket: угол «ось + 180»");
  assert.equal(movedSofa.angle, addedSofa.angle, "item_update sofa: angle_deg игнорируется");
  assert.equal(movedSocket.angle, addedSocket.angle, "item_update socket: angle_deg игнорируется");
  await client.close();
});

test("ревью 203 №3: against_wall при пустом rooms2 — OUTSIDE_ROOM проверяется по комнатам кеша workspace", async () => {
  const { client, ctx } = await start();
  const ws = ctx.workspace();
  // rooms2 пуст (модель ещё не нормализовалась) — комнаты только в кешe нормализации
  (ws.model.rooms2 as unknown) = {};
  (ws as unknown as { roomsCache: unknown }).roomsCache = [{
    id: "r1", name: null, area: 12, area_m2: 12, height: null,
    polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
  }];
  await call(client, "item_add", { name: "sofa", position: { against_wall: { wall_id: "W2", offset_mm: 500, gap_mm: 0 } } });
  // перенос: расчёт позиции и проверка OUTSIDE_ROOM — по одним и тем же комнатам
  // (кеш workspace); падение означало бы проверку по пустому rooms2 модели
  await call(client, "item_update", {
    item_id: "I1",
    position: { against_wall: { wall_id: "W1", offset_mm: 1000, gap_mm: 0 } },
  });
  const moved = itemsOf(ctx)[0]!;
  assert.equal(moved.id_room, "r1", "id_room из переданных комнат");
  await client.close();
});

test("ревью 203 №3: updateItem проверяет точку по явным rooms, не только по rooms2 модели", async () => {
  const { client, ctx } = await start();
  const ws = ctx.workspace();
  (ws.model.rooms2 as unknown) = {};
  (ws as unknown as { roomsCache: unknown }).roomsCache = [{
    id: "r1", name: null, area: 12, area_m2: 12, height: null,
    polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
  }];
  await call(client, "item_add", { name: "sofa", position: { center: { x: 2000, y: 1500 } } });
  const item = itemsOf(ctx)[0]!;
  const model = ctx.workspace().model; // apply меняет modelInternal — берём актуальный
  // прямая запись в модель: центр внутри комнаты, переданной явно, при пустом rooms2 —
  // без OUTSIDE_ROOM (мутация «игнор params.rooms» краснеет)
  updateItem(model, {
    itemId: item.id,
    center: { x: 2500, y: 1500 },
    rooms: [{ roomId: "r1", polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], areaCm2: 120_000, axisAreaCm2: null }],
  });
  assert.deepEqual(model.items[item.id]!.pc, { x: 250, y: 150 });
  await client.close();
});
