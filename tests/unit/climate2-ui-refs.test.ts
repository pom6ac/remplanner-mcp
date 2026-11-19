// Климат ч.2 (этап 250): подключения предметов к трубам климата (магистрали отопления,
// дренаж кондиционера, магистрали тёплого пола с водяным контуром, воздуховоды),
// обратные ссылки props.<коллекция> с ключами names_line_id_by_tool, multi-предметы,
// guard'ы (уже подключён, контур с магистралью не удалить, пересчёт при update),
// трасса кондиционера (conditioner_cable_id), mock save.
// Форматы — живые пробы 250-connect* (радиатор/фанат/кондиционер/водяной контур).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps, Pipe, WarmFloor, ElecCable } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addItem, updateItem, deleteItem } from "../../src/model/items.ts";
import { addWarmFloor, updateWarmFloor, deleteWarmFloor } from "../../src/model/climate.ts";
import { addPipe, deletePipe, updatePipe, pipeLinkKey, PIPE_LINK_KEY_BY_TYPE, CLIMATE_PIPE_CONNECTABLE, climatePipeVertexType } from "../../src/model/pipes.ts";
import {
  addElecCable, deleteElecCable, elecLinkKey, ELEC_CONDITIONER_ITEMS,
} from "../../src/model/electric2.ts";
import { compactModel } from "../../src/model/compact.ts";
import { clearEntityCollections, replaceEntityCollections } from "../../src/model/collections.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const COMPAT = { planner_version: "3", global_version: 1, tools_bundle: "t.js" } as never;

function baseModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  const m = { ...structuredClone(model), walls: {} } as Model;
  addRoomRect(m, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  m.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return m;
}

const CATALOG: Record<string, Record<string, unknown>> = {
  radiator_bimetal: { id: 184, group: "furniture", width: 70, height: 12, self_height: 56, plan: { radiators: 26 }, anchor: "wall", over_floor: { value: 10, display: false }, title: "Радиатор биметаллический" },
  radiator_collector: { id: 190, group: "furniture", width: 40, height: 30, self_height: 40, plan: { radiators: 26 }, anchor: "free", over_floor: false, title: "Коллекторный узел" },
  conditioner: { id: 205, group: "furniture", width: 75, height: 25, self_height: 30, plan: { conditioners: 24 }, anchor: "wall", over_floor: { value: 210, display: true }, title: "Внутренний блок сплит-системы" },
  conditioner_engine: { id: 206, group: "furniture", width: 60, height: 25, self_height: 40, plan: { conditioners: 24 }, anchor: "wall", over_floor: { value: 20, display: true }, title: "Внешний блок сплит-системы" },
  fan: { id: 214, group: "furniture", width: 20, height: 20, self_height: 0, plan: { ventilation: 25 }, anchor: "free", over_floor: false, title: "Вентилятор" },
};

function entry(name: string) {
  const raw = CATALOG[name];
  assert.ok(raw, `нет каталога для ${name}`);
  return { id: Number(raw.id), name, title: String(raw.title ?? name), group: String(raw.group), width: Number(raw.width), height: Number(raw.height), self_height: Number(raw.self_height ?? 0), plan: raw.plan as Record<string, number>, anchor: raw.anchor as string | undefined, over_floor: raw.over_floor as never };
}

const topWall = (m: Model): string => {
  const w = Object.values(m.walls).find((w) => w.p1.y === w.p2.y)!;
  assert.ok(w, "нет горизонтальной стены");
  return w.id;
};

type Sc = { m: Model; radiator: ItemProps; collector: ItemProps; cond: ItemProps; eng: ItemProps; fan: ItemProps; wf: WarmFloor };

function scenario(): Sc {
  const m = baseModel();
  const radiator = addItem(m, { name: "radiator_bimetal", position: { againstWall: { wallId: topWall(m), offsetMm: 1000 } }, catalogEntry: entry("radiator_bimetal") } as never);
  const collector = addItem(m, { name: "radiator_collector", position: { center: { x: 2000, y: 1500 } }, catalogEntry: entry("radiator_collector") } as never);
  const cond = addItem(m, { name: "conditioner", position: { againstWall: { wallId: topWall(m), offsetMm: 2500 } }, catalogEntry: entry("conditioner") } as never);
  const eng = addItem(m, { name: "conditioner_engine", position: { againstWall: { wallId: topWall(m), offsetMm: 3500 } }, catalogEntry: entry("conditioner_engine") } as never);
  const fan = addItem(m, { name: "fan", position: { center: { x: 3000, y: 1500 } }, catalogEntry: entry("fan") } as never);
  const wf = addWarmFloor(m, { kind: "water", corner1: { x: 500, y: 500 }, corner2: { x: 1500, y: 1500 } });
  return { m, radiator, collector, cond, eng, fan, wf };
}

// ---------- состав и ключи ----------

test("250: состав подключаемых предметов по видам труб (source_items бандла, пробы 250-connect*)", () => {
  for (const n of ["radiator_bimetal", "radiator_steel", "radiator_iron", "radiator_tubular_vert", "radiator_tubular_horizontal", "vertical_radiator", "floor_convector", "convector_on_floor", "radiator_collector", "ext_manifold_box", "int_manifold_box", "radiator_old"]) {
    assert.ok(CLIMATE_PIPE_CONNECTABLE.heat_hot!.has(n) && CLIMATE_PIPE_CONNECTABLE.heat_cold!.has(n), n);
  }
  for (const n of ["conditioner", "floor_conditioner", "duct_indoor_block", "breezer", "drainage_column", "waterspot_drainage"]) {
    assert.ok(CLIMATE_PIPE_CONNECTABLE.conditioner_drainage!.has(n), n);
  }
  for (const n of ["radiator_collector", "ext_manifold_box", "int_manifold_box", "warm_floor_water"]) {
    assert.ok(CLIMATE_PIPE_CONNECTABLE.warm_floor!.has(n), n);
  }
  for (const n of ["fan", "fan_wall", "ventilation_system", "inflow_valve", "air", "duct_indoor_block"]) {
    assert.ok(CLIMATE_PIPE_CONNECTABLE.vent_out!.has(n) && CLIMATE_PIPE_CONNECTABLE.vent_in!.has(n), n);
  }
});

test("250: ключи обратных ссылок — names_line_id_by_tool редактора (drainage_pipe_id, pipe_warm_floor_id)", () => {
  assert.equal(pipeLinkKey("water_pipe"), "water_pipe_id");
  assert.equal(pipeLinkKey("heat_pipe_hot"), "heat_pipe_hot_id");
  assert.equal(pipeLinkKey("heat_pipe_cold"), "heat_pipe_cold_id");
  assert.equal(pipeLinkKey("conditioner_drainage"), "drainage_pipe_id");
  assert.equal(pipeLinkKey("warm_floor_pipe"), "pipe_warm_floor_id");
  assert.equal(pipeLinkKey("ventpipe_out"), "ventpipe_out_id");
  assert.equal(pipeLinkKey("ventpipe_in"), "ventpipe_in_id");
  assert.deepEqual(Object.keys(PIPE_LINK_KEY_BY_TYPE).sort(), [
    "conditioner_drainage", "drainage_pipe", "heat_pipe_cold", "heat_pipe_hot",
    "ventpipe_in", "ventpipe_out", "warm_floor_pipe", "water_hot_pipe", "water_pipe",
  ]);
});

test("250: типы вершин труб климата (getTypeItem классов PipeHeat/PipeConditioner/PipeWarnFloor/PipeVentilation)", () => {
  assert.equal(climatePipeVertexType("heat_hot", "radiator_bimetal"), "waterspot");
  assert.equal(climatePipeVertexType("heat_hot", "radiator_collector"), "multi");
  assert.equal(climatePipeVertexType("warm_floor", "radiator_collector"), "collector");
  assert.equal(climatePipeVertexType("warm_floor", "warm_floor_water"), "warm_floor");
  assert.equal(climatePipeVertexType("warm_floor", "radiator_bimetal"), "waterspot");
  assert.equal(climatePipeVertexType("conditioner_drainage", "conditioner"), "waterspot");
  assert.equal(climatePipeVertexType("vent_out", "ventilation_system"), "multi");
  assert.equal(climatePipeVertexType("vent_out", "fan"), "waterspot");
});

// ---------- подключения к трубам климата ----------

test("250: pipe_add heat_hot — радиатор в pipes_heat: вершина waterspot у pc, ссылка props.pipes_heat.heat_pipe_hot_id", () => {
  const { m, radiator } = scenario();
  const pipe = addPipe(m, { kind: "heat_hot", path: [{ itemId: radiator.id }, { x: 1500, y: -100 }] });
  assert.equal(pipe.type, "heat_pipe_hot");
  assert.equal(pipe.vertexes[0]!.id, radiator.id);
  assert.deepEqual(pipe.vertexes[0]!.point, { x: radiator.pc.x, y: radiator.pc.y });
  assert.equal(pipe.vertexes[0]!.type, "waterspot");
  const box = (radiator as unknown as Record<string, Record<string, unknown>>).pipes_heat!;
  assert.equal(box.heat_pipe_hot_id, pipe.id);
  assert.equal(Object.values(m.pipes_heat ?? {})[0]!.id, pipe.id);
});

test("250: один радиатор подключается к подаче и обратке (разные ключи), но не к двум трубам подачи", () => {
  const { m, radiator } = scenario();
  const hot = addPipe(m, { kind: "heat_hot", path: [{ itemId: radiator.id }, { x: 1500, y: -100 }] });
  const cold = addPipe(m, { kind: "heat_cold", path: [{ itemId: radiator.id }, { x: 1500, y: -110 }] });
  const box = (radiator as unknown as Record<string, Record<string, unknown>>).pipes_heat!;
  assert.equal(box.heat_pipe_hot_id, hot.id);
  assert.equal(box.heat_pipe_cold_id, cold.id);
  assert.equal(cold.vertexes[0]!.type, "waterspot");
  assert.throws(() => addPipe(m, { kind: "heat_hot", path: [{ itemId: radiator.id }, { x: 1600, y: -100 }] }), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("уже подключён"));
});

test("250: дренаж кондиционера — props.pipes_conditioner.drainage_pipe_id; кондиционер к подаче не подключается", () => {
  const { m, cond, radiator } = scenario();
  const pipe = addPipe(m, { kind: "conditioner_drainage", path: [{ itemId: cond.id }, { x: 500, y: 2000 }] });
  assert.equal(pipe.vertexes[0]!.type, "waterspot");
  const box = (cond as unknown as Record<string, Record<string, unknown>>).pipes_conditioner!;
  assert.equal(box.drainage_pipe_id, pipe.id);
  assert.throws(() => addPipe(m, { kind: "heat_hot", path: [{ itemId: cond.id }, { x: 500, y: 2000 }] }), (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT");
  assert.throws(() => addPipe(m, { kind: "conditioner_drainage", path: [{ itemId: radiator.id }, { x: 500, y: 2000 }] }), (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT");
});

test("250: магистраль тёплого пола — водяной контур вершиной type warm_floor, point polygon[0], ссылка в props контура", () => {
  const { m, wf } = scenario();
  const pipe = addPipe(m, { kind: "warm_floor", path: [{ itemId: wf.id }, { x: 100, y: 100 }] });
  assert.equal(pipe.type, "warm_floor_pipe");
  assert.equal(pipe.vertexes[0]!.id, wf.id);
  assert.equal(pipe.vertexes[0]!.type, "warm_floor");
  assert.deepEqual(pipe.vertexes[0]!.point, wf.polygon[0]);
  const props = wf.props as { pipes_warm_floor?: Record<string, unknown> };
  assert.equal(props.pipes_warm_floor!.pipe_warm_floor_id, pipe.id);
  // второй магистрали к контуру не бывает (скалярная ссылка контура)
  assert.throws(() => addPipe(m, { kind: "warm_floor", path: [{ itemId: wf.id }, { x: 120, y: 120 }] }), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
});

test("250: multi-предметы (коллекторный узел, ventilation_system) — ссылка-массив", () => {
  const { m, collector } = scenario();
  const p1 = addPipe(m, { kind: "heat_hot", path: [{ itemId: collector.id }, { x: 2100, y: 100 }] });
  const p2 = addPipe(m, { kind: "heat_hot", path: [{ itemId: collector.id }, { x: 2500, y: 100 }] });
  const box = (collector as unknown as Record<string, Record<string, unknown>>).pipes_heat!;
  assert.deepEqual(box.heat_pipe_hot_id, [p1.id, p2.id]);
  assert.equal(p1.vertexes[0]!.type, "multi");
  const fan = baseModel();
  const f = addItem(fan, { name: "fan", position: { center: { x: 1000, y: 1000 } }, catalogEntry: entry("fan") } as never);
  const v1 = addPipe(fan, { kind: "vent_out", path: [{ itemId: f.id }, { x: 1500, y: 1000 }] });
  assert.equal(v1.vertexes[0]!.type, "waterspot");
  assert.equal(v1.spots && Object.keys(v1.spots).length, 0, "у воздуховодов spots {}");
});

test("250: pipe_delete снимает ссылки предметов и контура; контур с магистралью не удаляется", () => {
  const { m, radiator, wf } = scenario();
  const pipe = addPipe(m, { kind: "heat_hot", path: [{ itemId: radiator.id }, { x: 1500, y: -100 }] });
  const wfPipe = addPipe(m, { kind: "warm_floor", path: [{ itemId: wf.id }, { x: 100, y: 100 }] });
  assert.throws(() => deleteWarmFloor(m, wf.id), (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("магистрали"));
  deletePipe(m, wfPipe.id);
  assert.equal(Object.keys(m.pipes_warm_floor ?? {}).length, 0);
  const wfBox = (wf.props as { pipes_warm_floor?: Record<string, unknown> }).pipes_warm_floor;
  assert.ok(!wfBox || Object.keys(wfBox).length === 0, "ссылка контура снята");
  deleteWarmFloor(m, wf.id);
  deletePipe(m, pipe.id);
  const box = (radiator as unknown as Record<string, Record<string, unknown>>).pipes_heat!;
  assert.equal(box.heat_pipe_hot_id, undefined, "ссылка радиатора снята");
});

test("250: warm_floor_update пересчитывает вершины-контуры магистралей (point = новый polygon[0])", () => {
  const { m, wf } = scenario();
  const pipe = addPipe(m, { kind: "warm_floor", path: [{ itemId: wf.id }, { x: 100, y: 100 }] });
  const lenBefore = pipe.length;
  // перенос первого угла меняет polygon[0] — вершина-контур следует за ним
  updateWarmFloor(m, { warmFloorId: wf.id, corner1: { x: 300, y: 700 } });
  assert.deepEqual(pipe.vertexes[0]!.point, wf.polygon[0], "вершина = новый polygon[0]");
  assert.notEqual(pipe.length, lenBefore, "длина пересчитана");
  // второй угол polygon[0] не меняет — привязки не пересчитываются
  const p0 = { ...pipe.vertexes[0]!.point };
  const lenMid = pipe.length;
  updateWarmFloor(m, { warmFloorId: wf.id, corner2: { x: 1500, y: 2500 } });
  assert.deepEqual(pipe.vertexes[0]!.point, p0);
  assert.equal(pipe.length, lenMid);
});

test("250: вершина-предмет следует за предметом (item_update транзитивно), длина по рёбрам", () => {
  const { m, radiator } = scenario();
  const pipe = addPipe(m, { kind: "heat_hot", path: [{ itemId: radiator.id }, { x: 1500, y: -100 }] });
  const lenBefore = pipe.length;
  updateItem(m, { itemId: radiator.id, center: { x: 2600, y: 1500 } });
  assert.deepEqual(pipe.vertexes[0]!.point, { x: radiator.pc.x, y: radiator.pc.y });
  assert.notEqual(pipe.length, lenBefore);
  // узлы трубы двигаются, вершина-предмет — нет (pipe_update отвергает)
  assert.throws(() => updatePipe(m, { pipeId: pipe.id, positions: [{ vertex: 0, x: 1000, y: 1000 }] }), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
});

test("250: атомарность — NOT_FOUND и неподключаемый предмет модель не меняют", () => {
  const { m, radiator } = scenario();
  const before = structuredClone(m);
  assert.throws(() => addPipe(m, { kind: "heat_hot", path: [{ itemId: "missing" }, { x: 100, y: 100 }] }), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
  assert.deepEqual(m, before);
  assert.throws(() => addPipe(m, { kind: "vent_out", path: [{ itemId: radiator.id }, { x: 100, y: 100 }] }), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.deepEqual(m, before);
});

test("250: item_delete радиатора/кондиционера с трубой — отказ (нет висячих вершин)", () => {
  const { m, radiator, cond } = scenario();
  addPipe(m, { kind: "heat_hot", path: [{ itemId: radiator.id }, { x: 1500, y: -100 }] });
  addPipe(m, { kind: "conditioner_drainage", path: [{ itemId: cond.id }, { x: 500, y: 2000 }] });
  assert.throws(() => deleteItem(m, radiator.id), (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("трубе"));
  assert.throws(() => deleteItem(m, cond.id), (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("трубе"));
});

// ---------- трасса кондиционера (cables_conditioner) ----------

test("250: wiring_add conditioner_wire — conditioner↔conditioner_engine: вершины electrospot у pc, ссылка conditioner_cable_id", () => {
  const { m, cond, eng } = scenario();
  const cable = addElecCable(m, { tool: "conditioner_wire", path: [{ itemId: cond.id }, { itemId: eng.id }] });
  assert.equal(cable.type, "conditioner_wire");
  assert.equal(cable.vertexes[0]!.type, "electrospot");
  assert.deepEqual(cable.vertexes[0]!.point, { x: cond.pc.x, y: cond.pc.y }, "у трассы кондиционера вершина = pc без сдвига 7 см");
  const box = (cond as unknown as Record<string, Record<string, unknown>>).cables_conditioner!;
  assert.equal(box.conditioner_cable_id, cable.id);
  const boxEng = (eng as unknown as Record<string, Record<string, unknown>>).cables_conditioner!;
  assert.equal(boxEng.conditioner_cable_id, cable.id);
  // повторное подключение conditioner — отказ (скалярный слот занят)
  assert.throws(() => addElecCable(m, { tool: "conditioner_wire", path: [{ itemId: cond.id }, { x: 500, y: 500 }] }), (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("уже подключён"));
  deleteElecCable(m, cable.id);
  assert.equal((cond as unknown as Record<string, Record<string, unknown>>).cables_conditioner, undefined, "ссылка снята");
});

test("250: к трассе кондиционера подключаются блоки/клапан/бризер/рекуператор, розетки — нет", () => {
  assert.deepEqual([...ELEC_CONDITIONER_ITEMS].sort(), [
    "breezer", "cassette_indoor_block", "conditioner", "conditioner_engine",
    "duct_indoor_block", "external_block_multisplit", "floor_conditioner",
    "inflow_valve", "recuperator",
  ]);
  assert.equal(elecLinkKey("cables_conditioner", "conditioner_wire"), "conditioner_cable_id");
});

// ---------- компакт, реестр, mock save ----------

test("250: компактный API — трубы климата с подключениями (PW/PC/PH/PV), мм", () => {
  const { m, radiator, cond } = scenario();
  addPipe(m, { kind: "heat_hot", path: [{ itemId: radiator.id }, { x: 1500, y: -100 }] });
  addPipe(m, { kind: "conditioner_drainage", path: [{ itemId: cond.id }, { x: 500, y: 2000 }] });
  const c = compactModel(m);
  assert.equal(c.pipes_heat.length, 1);
  assert.equal(c.pipes_conditioner.length, 1);
  const ph = c.pipes_heat[0]!;
  assert.equal(ph.id, "PH1");
  assert.ok(ph.length_mm >= 0, "длина в мм");
  assert.deepEqual(ph.connected, [radiator.id], "подключения в компактном выводе");
});

test("250: реестр — clear/import не ломаются на ссылках климата", () => {
  const { m, radiator } = scenario();
  addPipe(m, { kind: "heat_hot", path: [{ itemId: radiator.id }, { x: 1500, y: -100 }] });
  const snapshot = structuredClone(m);
  clearEntityCollections(m);
  assert.equal(m.pipes_heat, undefined, "pipes_heat в реестре clear");
  replaceEntityCollections(m, snapshot as never);
});

// ---------- mock save (подмена writeBackup/loadModel/openEditor) ----------

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const c = { walls: Object.keys(m.walls as Record<string, unknown>).length, holes: 0, items: 0, pillars: 0, rigels: 0 };
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
    loadModel: async () => ({ saveId: server.saveId, model: structuredClone(server.model), dataEmpty: false }) as never,
    openEditor: async () => editor,
  } as unknown as WorkspaceDeps;
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/tmp/mock-not-written";
  return ws;
}

function connectedScenario(): { model: Model; radiator: ItemProps; cond: ItemProps; hot: Pipe; drain: Pipe } {
  const { m, radiator, cond } = scenario();
  const hot = addPipe(m, { kind: "heat_hot", path: [{ itemId: radiator.id }, { x: 1500, y: -100 }] });
  const drain = addPipe(m, { kind: "conditioner_drainage", path: [{ itemId: cond.id }, { x: 500, y: 2000 }] });
  return { model: m, radiator, cond, hot, drain };
}

test("250: mock save — verified с подключёнными радиатором и кондиционером", async () => {
  const { model } = connectedScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("250: mock save — сервер потерял обратную ссылку радиатора (props.pipes_heat) → SITE_ERROR", async () => {
  const { model, radiator } = connectedScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const it = (s.model as { items?: Record<string, Record<string, unknown>> }).items![radiator.id] as Record<string, Record<string, unknown>>;
    delete it.pipes_heat;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal((e as McpError).code, "SITE_ERROR");
    assert.ok(JSON.stringify((e as McpError).details).includes("climate_mismatches"));
    return true;
  });
});

test("250: mock save — сервер исказил ключ ссылки (cable-стиль вместо heat_pipe_hot_id) → SITE_ERROR", async () => {
  const { model, radiator, hot } = connectedScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const it = (s.model as { items?: Record<string, Record<string, unknown>> }).items![radiator.id] as Record<string, Record<string, unknown>>;
    delete it.pipes_heat!.heat_pipe_hot_id;
    it.pipes_heat!.heat_pipe_id = hot.id;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && (e as McpError).code === "SITE_ERROR");
});

test("250: mock save — редактор при нормализации потерял трубу с подключением → NORMALIZATION_DROPPED", async () => {
  const { model, hot } = connectedScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    delete (m as { pipes_heat?: Record<string, Pipe> }).pipes_heat![hot.id];
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && (e as McpError).code === "NORMALIZATION_DROPPED");
  assert.equal(saves, 0, "до записи дело не дошло");
});

test("250: mock save — редактор пересчитал длину магистрали от точки подключения (в пределах габарита) — verified", async () => {
  const { model, hot } = connectedScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    // радиатор 70×12: точка подключения на габарите — длина от грани, не от центра
    const got = (s.model as { pipes_heat?: Record<string, Pipe> }).pipes_heat![hot.id]!;
    got.length = Math.round((got.length * 100 + 6)) / 100;
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("250: mock save — сервер испортил тип вершины радиатора (waterspot→node) → SITE_ERROR", async () => {
  const { model, hot } = connectedScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const got = (s.model as { pipes_heat?: Record<string, Pipe> }).pipes_heat![hot.id]!;
    got.vertexes[0]!.type = "node";
    got.items![got.vertexes[0]!.id] = "node";
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && (e as McpError).code === "SITE_ERROR");
});
