// Ревью 241 (PR #36 «электрика ч.2»): резолюция находок.
// №1 (major): граф-коллекции схемы импорта выводятся из реестра
// MODEL_ENTITY_COLLECTIONS — новые cables_socket/warm_floor/conditioner проходят
// схему графа и лимиты; сторож: каждая граф-коллекция реестра отклоняет мусорную
// сущность, лимит MAX_IMPORT_ENTITIES действует.
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { parseModelImport } from "../../src/model/import-schema.ts";
import { MODEL_ENTITY_COLLECTIONS } from "../../src/model/collections.ts";
import { MAX_IMPORT_ENTITIES } from "../../src/limits.ts";
import { McpError } from "../../src/errors.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps, ElecCable } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addItem, updateItem } from "../../src/model/items.ts";
import { addElecCable } from "../../src/model/electric2.ts";
import { addCable } from "../../src/model/electric.ts";
import { addLightLine } from "../../src/model/lighting.ts";
import { compactModel } from "../../src/model/compact.ts";
import { toToolEntry, type ToolEntry } from "../../src/catalog.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";

const here = dirname(fileURLToPath(import.meta.url));

function baseModel(): Record<string, unknown> {
  return {
    v: 3, id: "0", plan_id: "0",
    walls: {}, items: {}, pillars: {}, rulers: {}, comments: {},
    total_height: 270, final: true,
  };
}

// Коллекции, у которых своя (не графовая) схема: обязательные и предметы/ригели/
// линейки/комментарии. Всё остальное в реестре — графы (graphEntity).
const NON_GRAPH_COLLECTIONS = new Set(["walls", "items", "pillars", "rigels", "rulers", "comments"]);

function garbageEntity(): Record<string, unknown> {
  return { id: "e0", vertexes: "garbage", matrix: 5, items: 7, length: -1 };
}

test("ревью 241 №1: каждая граф-коллекция реестра есть в схеме импорта (мусор отклоняется)", () => {
  const graphColls = MODEL_ENTITY_COLLECTIONS.filter((c) => !NON_GRAPH_COLLECTIONS.has(c));
  assert.ok(graphColls.includes("cables_socket"), "cables_socket — граф-коллекция реестра");
  assert.ok(graphColls.includes("cables_warm_floor"), "cables_warm_floor — граф-коллекция реестра");
  assert.ok(graphColls.includes("cables_conditioner"), "cables_conditioner — граф-коллекция реестра");
  for (const coll of graphColls) {
    assert.throws(
      () => parseModelImport({ ...baseModel(), [coll]: { e0: garbageEntity() } }),
      (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT",
      `${coll}: мусорная сущность должна отклоняться схемой графа`,
    );
  }
});

test("ревью 241 №1: лимит MAX_IMPORT_ENTITIES действует для cables_socket", () => {
  const entities: Record<string, unknown> = {};
  for (let i = 0; i <= MAX_IMPORT_ENTITIES; i++) entities[`e${i}`] = { id: `e${i}` };
  assert.throws(
    () => parseModelImport({ ...baseModel(), cables_socket: entities }),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT"
      && String((e as McpError).message).includes("слишком много сущностей"),
    `больше ${MAX_IMPORT_ENTITIES} сущностей — отказ`,
  );
});

// ---------- №2 (major): multi-вершина кабеля = pc предмета, elecVertexPoint — только выводы ----------

function elecBaseModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  const m = { ...structuredClone(model), walls: {} } as Model;
  addRoomRect(m, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  m.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return m;
}

const ELEC_CATALOG: Record<string, Record<string, unknown>> = {
  electric_shield: { id: 28, group: "furniture", width: 30, height: 11, self_height: 25, plan: { cables: 31, sockets: 9 }, anchor: "wall", over_floor: { value: 120, display: false }, title: "Накладной электрощиток" },
  electric_box: { id: 512, group: "furniture", width: 15, height: 15, self_height: 0, plan: { cables: 31 }, anchor: "free", over_floor: false, title: "Распред. короб" },
  wire: { id: 609, group: "wires", width: 14, height: 20, self_height: 0, plan: { sockets: 9 }, anchor: "wall", over_floor: { value: 30, display: false }, title: "Вывод провода 220В" },
  light_switch: { id: 577, group: "switches", width: 14, height: 18, self_height: 0, plan: { light_connections: 29 }, anchor: "wall", over_floor: { value: 90, display: false }, title: "1-клавишный выключатель" },
};

function elecEntry(name: string): ToolEntry {
  const raw = ELEC_CATALOG[name]!;
  return { id: Number(raw.id), name, title: String(raw.title ?? name), group: String(raw.group), width: Number(raw.width), height: Number(raw.height), self_height: Number(raw.self_height ?? 0), plan: raw.plan as Record<string, number>, anchor: raw.anchor as string | undefined, over_floor: raw.over_floor as never };
}

const elecTopWall = (m: Model): string => Object.values(m.walls).find((w) => w.p1.y === w.p2.y)!.id;

test("ревью 241 №2: item_update щитка у стены с кабелем — вершина multi = новый pc (без сдвига «7 см от грани»)", () => {
  const m = elecBaseModel();
  const shield = addItem(m, { name: "electric_shield", position: { againstWall: { wallId: elecTopWall(m), offsetMm: 3000 } }, catalogEntry: elecEntry("electric_shield") } as never);
  const box = addItem(m, { name: "electric_box", position: { center: { x: 2000, y: 1500 } }, catalogEntry: elecEntry("electric_box") } as never);
  assert.ok(shield.id_wall, "щиток у стены");
  addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: shield.id }] });
  const cable = Object.values(m.cables_socket ?? {})[0]!;
  const before = cable.vertexes.find((v) => v.id === shield.id)!.point;
  assert.deepEqual(before, { x: shield.pc.x, y: shield.pc.y }, "перед переносом вершина = pc");
  updateItem(m, { itemId: shield.id, angleDeg: shield.angle }); // как в редакторе: перенос вдоль стены
  const after = cable.vertexes.find((v) => v.id === shield.id)!.point;
  assert.deepEqual(after, { x: shield.pc.x, y: shield.pc.y }, `после item_update вершина = новый pc ${JSON.stringify(shield.pc)}, получено ${JSON.stringify(after)}`);
  assert.equal(after.y, shield.pc.y, "вершина не уехала на «7 см от грани»");
});

test("ревью 241 №2: вывод провода при item_update по-прежнему сдвигается к грани (elecVertexPoint для electrospot)", () => {
  const m = elecBaseModel();
  const shield = addItem(m, { name: "electric_shield", position: { againstWall: { wallId: elecTopWall(m), offsetMm: 3000 } }, catalogEntry: elecEntry("electric_shield") } as never);
  const wire = addItem(m, { name: "wire", position: { againstWall: { wallId: elecTopWall(m), offsetMm: 500 } }, catalogEntry: elecEntry("wire") } as never);
  assert.ok(wire.id_wall, "вывод у стены");
  addElecCable(m, { tool: "wire_2_25", path: [{ itemId: shield.id }, { itemId: wire.id }] });
  const cable = Object.values(m.cables_socket ?? {})[0]!;
  const v = cable.vertexes.find((x) => x.id === wire.id)!;
  assert.deepEqual(v.point, { x: wire.pc.x, y: 7 }, "вывод: 7 см от грани стены");
  updateItem(m, { itemId: wire.id, angleDeg: wire.angle });
  const v2 = cable.vertexes.find((x) => x.id === wire.id)!.point;
  assert.deepEqual(v2, { x: wire.pc.x, y: 7 }, "после item_update вывод считается через elecVertexPoint");
});

// ---------- №2: mock save сценария «перенос щитка с кабелем» ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm);
      transformNorm?.(normalized!);
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized!), rooms: [], before: c, after: c };
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
    async openEditor() { return editor as never; },
  };
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  return ws;
}

test("ревью 241 №2: mock save — перенос щитка с кабелем: вершина multi = pc до и после save, verified", async () => {
  const m = elecBaseModel();
  const shield = addItem(m, { name: "electric_shield", position: { againstWall: { wallId: elecTopWall(m), offsetMm: 3000 } }, catalogEntry: elecEntry("electric_shield") } as never);
  const box = addItem(m, { name: "electric_box", position: { center: { x: 2000, y: 1500 } }, catalogEntry: elecEntry("electric_box") } as never);
  addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: shield.id }] });
  updateItem(m, { itemId: shield.id, angleDeg: shield.angle });
  const wsModel = structuredClone(m);
  const cable = Object.values(wsModel.cables_socket ?? {})[0]!;
  const vBefore = cable.vertexes.find((v) => v.id === shield.id)!.point;
  assert.deepEqual(vBefore, { x: shield.pc.x, y: shield.pc.y });
  const server: SaveServer = { saveId: "s1", model: structuredClone(wsModel) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res).slice(0, 400));
  const sm = (server.model as { cables_socket?: Record<string, ElecCable> }).cables_socket!;
  const vAfter = Object.values(sm)[0]!.vertexes.find((v) => v.id === shield.id)!.point;
  assert.deepEqual(vAfter, { x: shield.pc.x, y: shield.pc.y }, "на сервере вершина = pc щитка, а не «7 см от грани»");
});

// ---------- №3 + №10: wiring_add — mmPoint/enum/лимиты, без дубля-параметра tool ----------

async function startOffline(): Promise<{ client: import("@modelcontextprotocol/sdk/client/index.js").Client; close: () => Promise<void> }> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { buildServer } = await import("../../src/server.ts");
  const { ServerContext } = await import("../../src/server/context.ts");
  const ctx = new ServerContext({ offlineFixture: join(here, "../fixtures/anon-rect-4000x3000.json") });
  const server = buildServer(ctx);
  const client = new Client({ name: "review241", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: () => client.close() };
}

test("ревью 241 №3/№10: wiring_add — kind enum всех кабелей, mmPoint с лимитом, item_id max, параметра tool нет", async () => {
  const { client, close } = await startOffline();
  try {
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "wiring_add")!.inputSchema as {
      properties: Record<string, { type?: string; enum?: string[]; maxLength?: number }>;
      required?: string[];
    };
    assert.ok(!("tool" in schema.properties), "дубля-параметра tool больше нет");
    const kind = schema.properties["kind"]!;
    assert.deepEqual(kind.type, "string");
    assert.ok(Array.isArray(kind.enum) && kind.enum.includes("wire_3_25") && kind.enum.includes("warm_floor_wire") && kind.enum.includes("conditioner_wire"));
    assert.equal(kind.enum!.length, 31 + 2, "enum = все ключи ELEC_CABLE_TOOLS (31 + 2)");
    // узел пути: целые мм в диапазоне TOOL_COORD_LIMIT_MM (mmPoint), item_id с максимумом
    const path = schema.properties["path"] as { items?: { anyOf?: Array<Record<string, unknown>> } };
    const variants = path.items!.anyOf ?? path.items!["oneOf" as never] ?? [];
    assert.ok(variants.length >= 2, "path — union узла и предмета");
    const node = variants.find((v) => "properties" in (v as object) && "x" in ((v as Record<string, unknown>)["properties"] as object)) as { properties: { x: { type: string; maximum?: number } } };
    assert.equal(node.properties.x.type, "integer");
    assert.equal(node.properties.x.maximum, 1_000_000);
    const item = variants.find((v) => "properties" in (v as object) && "item_id" in ((v as Record<string, unknown>)["properties"] as object)) as { properties: { item_id: { maxLength?: number } } };
    assert.equal(item.properties.item_id.maxLength, 64);
    // enum отклоняет мусорный kind и бесконечную координату (MCP-уровень)
    const r1 = await client.callTool({ name: "wiring_add", arguments: { kind: "x".repeat(80), path: [{ x: 0, y: 0 }, { x: 100, y: 0 }] } });
    assert.ok(r1.isError, "мусорный kind отклонён схемой");
    const r2 = await client.callTool({ name: "wiring_add", arguments: { kind: "wire_3_25", path: [{ x: 1e300, y: 0 }, { x: 100, y: 0 }] } });
    assert.ok(r2.isError, "координата 1e300 отклонена (лимит мм)");
  } finally {
    await close();
  }
});

// ---------- №4: три механизма без теста ----------

// ---------- №9: вершины кабеля в компактном API ----------

test("ревью 241 №9: compact — vertex_list с индексами, item_id/sub_id и узлами в мм", () => {
  const m = elecBaseModel();
  const shield = addItem(m, { name: "electric_shield", position: { againstWall: { wallId: elecTopWall(m), offsetMm: 3000 } }, catalogEntry: elecEntry("electric_shield") } as never);
  const wire = addItem(m, { name: "wire", position: { againstWall: { wallId: elecTopWall(m), offsetMm: 500 } }, catalogEntry: elecEntry("wire") } as never);
  addElecCable(m, { tool: "wire_3_25", path: [{ itemId: shield.id }, { x: 2000, y: 1500 }, { itemId: wire.id }] });
  const c = compactModel(m);
  const cs = c.cables_socket[0]!;
  assert.equal(cs.vertex_list.length, 3);
  const [v0, v1, v2] = cs.vertex_list;
  assert.deepEqual(v0, { index: 0, kind: "item", item_id: shield.id, x_mm: Math.round(shield.pc.x * 10), y_mm: Math.round(shield.pc.y * 10) });
  assert.deepEqual(v1, { index: 1, kind: "node", x_mm: 2000, y_mm: 1500 });
  assert.deepEqual(v2, { index: 2, kind: "item", item_id: wire.id, x_mm: Math.round(wire.pc.x * 10), y_mm: 70 });
  // аддитивность: прежние ключи на месте
  assert.ok("connected" in cs && "vertexes" in cs && "length_mm" in cs && "type" in cs && "site_id" in cs && "id" in cs);
  // вершина-предмет следом за item_update: индексы сохраняются, точка обновляется
  updateItem(m, { itemId: shield.id, angleDeg: shield.angle });
  const cs2 = compactModel(m).cables_socket[0]!;
  assert.deepEqual(cs2.vertex_list[0], { index: 0, kind: "item", item_id: shield.id, x_mm: Math.round(shield.pc.x * 10), y_mm: Math.round(shield.pc.y * 10) });
});

test("ревью 241 №4a: ws-мутация — нормализатор потерял кабель-проводку → INVALID_GEOMETRY", async () => {  const m = elecBaseModel();
  const shield = addItem(m, { name: "electric_shield", position: { againstWall: { wallId: elecTopWall(m), offsetMm: 3000 } }, catalogEntry: elecEntry("electric_shield") } as never);
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let normalized: Record<string, unknown> | null = null;
  const editor = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm);
      delete (normalized as Record<string, unknown>).cables_socket;
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized!), rooms: [], before: c, after: c };
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return COMPAT; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: server.saveId, units: "cm", data_empty: false, model: structuredClone(server.model) };
    },
    async openEditor() { return editor as never; },
  };
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  await ws.open("0", "1");
  await assert.rejects(
    () => ws.applyWalls("wiring_add", (mm) => {
      addElecCable(mm, { tool: "wire_3_25", path: [{ x: 1000, y: 1000 }, { itemId: shield.id }] });
      return true;
    }),
    (e: unknown) => {
      const err = e as McpError;
      return err instanceof McpError && err.code === "INVALID_GEOMETRY"
        && err.details !== undefined && "lost_cables_socket" in (err.details as Record<string, unknown>);
    },
  );
});

test("ревью 241 №4b: mock save — сервер вернул скаляр у multi-щитка → SITE_ERROR (форма ссылки)", async () => {
  const m = elecBaseModel();
  const shield = addItem(m, { name: "electric_shield", position: { againstWall: { wallId: elecTopWall(m), offsetMm: 3000 } }, catalogEntry: elecEntry("electric_shield") } as never);
  const box = addItem(m, { name: "electric_box", position: { center: { x: 2000, y: 1500 } }, catalogEntry: elecEntry("electric_box") } as never);
  const cable = addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: shield.id }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    // подмена формы ссылки у multi-предмета: массив → скаляр
    const it = (s.model.items as Record<string, { cables_socket?: Record<string, unknown> }>)[shield.id]!;
    it.cables_socket!["cable_wire_3_25_id"] = cable.id;
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as McpError;
    const d = (err.details ?? {}) as Record<string, unknown>;
    const list = d["cables_socket_connection_mismatches"] as string[] | undefined;
    return err instanceof McpError && err.code === "SITE_ERROR"
      && Array.isArray(list) && list.some((s) => s.includes("массивом") || s.includes(cable.id));
  });
});

test("ревью 241 №4c: mock save — сервер снял props.cables у ленты → SITE_ERROR cables_connection_mismatches", async () => {
  const m = elecBaseModel();
  const sw = addItem(m, { name: "light_switch", position: { againstWall: { wallId: elecTopWall(m), offsetMm: 500 } }, catalogEntry: elecEntry("light_switch") } as never);
  const strip = addLightLine(m, { kind: "led", path: [{ x: 1000, y: 800 }, { x: 3000, y: 800 }] });
  addCable(m, { switchItemId: sw.id, lampItemId: strip.id });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    // сервер потерял обратную ссылку линии
    const line = ((s.model.led_strips as Record<string, { props?: { cables?: unknown } }>)[strip.id]!);
    delete line.props!.cables;
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as McpError;
    const d = (err.details ?? {}) as Record<string, unknown>;
    const list = d["cables_connection_mismatches"] as string[] | undefined;
    return err instanceof McpError && err.code === "SITE_ERROR"
      && Array.isArray(list) && list.length > 0;
  });
});
