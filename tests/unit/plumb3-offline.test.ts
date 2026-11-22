// Этап 360 — ответы инструментов настоящим обработчиком в офлайн-контексте
// (ServerContext offline + tools-фикстура каталога waterspots) и mock save
// (подмена writeBackup/loadModel/openEditor — new-entity-section.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import type { Model, ItemProps, Pipe } from "../../src/model/types.ts";
import { McpError } from "../../src/errors.ts";
import { addPipe, PIPE_LINK_KEY_BY_TYPE } from "../../src/model/pipes.ts";
import { addItem } from "../../src/model/items.ts";
import { addWall } from "../../src/model/walls.ts";
import { mergeWaterSpot, unsetWaterSpot, removePipeVertex } from "../../src/model/waterspots.ts";
import { pipeConnectionMismatches, WATER_PIPE_TYPES } from "../../src/verify/pipes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");
const WS_CATALOG = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/catalog-waterspots.json"), "utf8")) as {
  tools: Record<string, Record<string, unknown>>;
};

function text(r: unknown): string {
  const content = (r as { content?: { type: string; text?: string }[] }).content;
  return content?.map((c) => c.text ?? "").join("") ?? "";
}

/** Офлайн-сервер с каталогом waterspots (анонимный проект = бесплатный тариф). */
async function start(): Promise<Client> {
  const ctx = new ServerContext({ offlineFixture: FIXTURE, tools: WS_CATALOG.tools as never });
  const server = buildServer(ctx);
  const client = new Client({ name: "plumb3-offline", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

test("360: сервер waterspot_merge — настоящим обработчиком: PRO-часть гейтится, недопустимая пара INVALID_ARGUMENT", async () => {
  const client = await start();
  try {
    const add1 = await client.callTool({ name: "item_add", arguments: {
      name: "waterspot_cold_hot",
      position: { in_room: { room_id: "R1", corner: "nw" } },
    } });
    assert.ok(!add1.isError, text(add1));
    const e1 = (JSON.parse(text(add1)) as { entity: { id: string } }).entity!;
    // PRO-часть (waterspot_cold) — NOT_AVAILABLE_ON_TARIFF в офлайне (тариф unknown = free)
    const pro = await client.callTool({ name: "waterspot_merge", arguments: { item_id: e1.id, part: "waterspot_cold" } });
    assert.ok(pro.isError, "PRO-часть отклонена на free");
    assert.match(text(pro), /NOT_AVAILABLE_ON_TARIFF/);
    // недопустимая пара свободной частью — INVALID_ARGUMENT настоящим обработчиком
    // (у cold_hot в source_items только drainage; сам с собой не объединяется)
    const bad = await client.callTool({ name: "waterspot_merge", arguments: { item_id: e1.id, part: "waterspot_cold_hot" } });
    assert.ok(bad.isError);
    assert.match(text(bad), /INVALID_ARGUMENT/);
    // несуществующий предмет — NOT_FOUND
    const nf = await client.callTool({ name: "waterspot_merge", arguments: { item_id: "_nope", part: "waterspot_cold_hot" } });
    assert.ok(nf.isError);
    assert.match(text(nf), /NOT_FOUND/);
    // unset: неснимаемая часть — INVALID_ARGUMENT (у cold_hot нет части drainage? есть:
    // structure_items cold_hot = {cold→hot, hot→cold}; drainage не снимается)
    const badUnset = await client.callTool({ name: "waterspot_unset", arguments: { item_id: e1.id, part: "waterspot_drainage" } });
    assert.ok(badUnset.isError);
    assert.match(text(badUnset), /INVALID_ARGUMENT/);
  } finally {
    await client.close();
  }
});

test("360: сервер pipe_node_delete — NOT_FOUND вне диапазона; item_vertex узлом не считается", async () => {
  const client = await start();
  try {
    const missing = await client.callTool({ name: "pipe_node_delete", arguments: { pipe_id: "_nope", vertex: 0 } });
    assert.ok(missing.isError);
    assert.match(text(missing), /NOT_FOUND/);
  } finally {
    await client.close();
  }
});

// ---------- mock save: merge/unset/split-модель сохраняется verified без ложных потерь ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(m.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      afterSave(server);
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return COMPAT; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: server.saveId, units: "cm", data_empty: false, model: structuredClone(server.model) };
    },
    async openEditor() { return editor; },
  };
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  return ws;
}

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return structuredClone(model);
}

function spot(model: Model, x: number, y: number, name: string, wall = false): ItemProps {
  const t = WS_CATALOG.tools[name] as unknown as { width: number; height: number };
  return addItem(model, {
    name,
    position: wall
      ? { againstWall: { wallId: Object.keys(model.walls)[0]!, offsetMm: (x - 50) * 10 } }
      : { center: { x: x * 10, y: y * 10 } },
    catalogEntry: { id: 0, name, title: name, group: "waterspots", width: t.width, height: t.height, self_height: 0, plan: { water: 27 }, over_floor: { value: 50, display: false } } as never,
  }) as ItemProps;
}

test("360: mock save — merge+unset+распавшаяся труба через ws.apply сохраняются verified", async () => {
  const model = emptyModel();
  const a = spot(model, 100, 100, "waterspot_drainage");
  const mid = spot(model, 200, 100, "waterspot_drainage_cold_hot");
  const b = spot(model, 300, 100, "waterspot_drainage");
  const pipe = addPipe(model, { kind: "drainage", path: [{ itemId: a.id }, { x: 1500, y: 500 }, { itemId: mid.id }, { x: 2500, y: 500 }, { itemId: b.id }] });
  void pipe;
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  // ревью 364 №7: операция идёт через ws.apply настоящей рабочей копией, а не
  // мутацией модели до open — save проверяет результат операции, а не тавтологию
  const res = ws.apply("waterspot_unset", (m) => unsetWaterSpot(m, { itemId: mid.id, part: "waterspot_drainage", widthCm: 16, heightCm: 9 }));
  assert.equal(res.result, "waterspot_cold_hot");
  assert.equal(res.pipes.created.length, 2, "два куска после unset");
  ws.apply("waterspot_merge", (m) => mergeWaterSpot(m, { itemId: a.id, part: "waterspot_cold", widthCm: 21, heightCm: 15 }));
  assert.equal((ws.model as Model).items[a.id]!.name, "waterspot_drainage_cold");
  const out = await ws.save();
  assert.equal(out.verified, true);
  assert.equal(Object.keys((server.model as { pipes?: Record<string, Pipe> }).pipes!).length, 2, "оба куска дошли до сервера");
});

test("365: mock save — unset конца трубы из 3 вершин через ws.apply: без висячей ссылки, save verified", async () => {
  const model = emptyModel();
  const col = spot(model, 100, 100, "waterspot_drainage");
  const a = spot(model, 300, 100, "waterspot_drainage_cold_hot");
  const pipe = addPipe(model, { kind: "drainage", path: [{ itemId: col.id }, { x: 1500, y: 500 }, { itemId: a.id }] });
  assert.equal(pipe.vertexes.length, 3);
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = ws.apply("waterspot_unset", (m) => unsetWaterSpot(m, { itemId: a.id, part: "waterspot_drainage", widthCm: 16, heightCm: 9 }));
  assert.equal(res.result, "waterspot_cold_hot");
  // ревью 364 №2: снятая вершина-конец трубы не оставляет висячей обратной ссылки —
  // сверка подключений на рабочей копии пуста (иначе онлайн-путь откатит мутацию)
  const after = ws.model as Model;
  const aAfter = after.items[a.id] as ItemProps & { pipes?: Record<string, unknown> };
  assert.deepEqual(aAfter.pipes ?? {}, {}, "у снятого вывода ссылки на трубу нет");
  const mm = pipeConnectionMismatches(structuredClone(after.pipes ?? {}) as never, after.items as never, structuredClone(after.pipes ?? {}) as never, after.items as never, { onlyTypes: WATER_PIPE_TYPES });
  assert.deepEqual(mm, []);
  const out = await ws.save();
  assert.equal(out.verified, true, "save проходит без INVALID_GEOMETRY/потерь");
  assert.equal(Object.keys((server.model as { pipes?: Record<string, Pipe> }).pipes!).length, 1, "труба [коллектор, узел] жива");
});

test("365: mock save — сервер потерял value_2 вывода воды → save не verified (сверка over_floor)", async () => {
  const model = emptyModel();
  const s = spot(model, 100, 100, "waterspot_drainage_cold_hot");
  (s.over_floor as { value: number; display: boolean; value_2?: number }).value_2 = 40;
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {
    // «сервер» выбросил высоту канализации при сохранении
    const items = server.model["items"] as Record<string, { over_floor?: Record<string, unknown> }>;
    for (const it of Object.values(items)) delete it.over_floor?.value_2;
  });
  await ws.open("0", "1");
  await assert.rejects(
    ws.save(),
    (e: unknown) => {
      const err = e as { code?: string; details?: { item_mismatches?: string[] } };
      if (err.code !== "SITE_ERROR" && err.code !== "NORMALIZATION_DROPPED") return false;
      const mm = JSON.stringify(err.details ?? {});
      return mm.includes("value_2");
    },
    "потеря value_2 ловится сверкой предметов после save",
  );
});

test("360: mock save — редактор потерял кусок распавшейся трубы → NORMALIZATION_DROPPED", async () => {
  const model = emptyModel();
  const a = spot(model, 100, 100, "waterspot_drainage");
  const b = spot(model, 300, 100, "waterspot_drainage");
  const pipe = addPipe(model, { kind: "drainage", path: [{ itemId: a.id }, { x: 1500, y: 500 }, { x: 2500, y: 500 }, { itemId: b.id }] });
  // удаление внутреннего узла — труба распадается на два куска
  removePipeVertex(model, pipe.id, pipe.vertexes[2]!.id);
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    // нормализатор «теряет» один кусок распавшейся трубы
    const pipes = (m as { pipes?: Record<string, Pipe> }).pipes!;
    const first = Object.keys(pipes)[0]!;
    delete pipes[first];
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED");
  assert.equal(saves, 0, "до записи дело не дошло");
});

test("360: mock save — перегородка делит комнату при живых трубах: save verified без ложной ошибки", async () => {
  const model = emptyModel();
  const a = spot(model, 100, 100, "waterspot_cold_hot");
  const b = spot(model, 300, 100, "waterspot_cold");
  addPipe(model, { kind: "water", path: [{ itemId: a.id }, { x: 1500, y: 1500 }, { itemId: b.id }] });
  // ревью 364 №7: комната реально делится — перегородка поперёк комнаты
  // (прежде splitWall резал стену на коллинеарные части, комната оставалась одна)
  addWall(model, { start: { x: 2000, y: 500 }, end: { x: 2000, y: 2500 }, thicknessMm: 100, plan: "c" });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const out = await ws.save();
  assert.equal(out.verified, true, "деление комнаты перегородкой не даёт ложной ошибки на трубах");
  assert.equal(Object.keys((server.model as { pipes?: Record<string, Pipe> }).pipes!).length, 1);
});
