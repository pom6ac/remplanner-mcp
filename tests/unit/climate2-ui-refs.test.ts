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

test("ревью 251 №1: warm_floor_update не стирает props контура (обратная ссылка pipes_warm_floor)", () => {
  const { m, wf } = scenario();
  const pipe = addPipe(m, { kind: "warm_floor", path: [{ itemId: wf.id }, { x: 100, y: 100 }] });
  // перенос обоих углов: кандидат собирается с нуля — пользовательские поля props
  // (обратная ссылка магистрали) обязаны переехать в нового кандидата
  updateWarmFloor(m, { warmFloorId: wf.id, corner1: { x: 300, y: 700 }, corner2: { x: 1700, y: 2100 } });
  const props = wf.props as { pipes_warm_floor?: Record<string, unknown> };
  assert.equal(props.pipes_warm_floor!.pipe_warm_floor_id, pipe.id, "ссылка контура на магистраль пережила update");
  assert.equal(Object.values(m.pipes_warm_floor ?? {})[0]!.vertexes.some((v) => v.id === wf.id && v.type === "warm_floor"), true, "вершина-контур у магистрали на месте");
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

// ---------- миграция legacy-ключа трассы кондиционера (ревью 251 №3) ----------

import { toModel } from "../../src/model/canonical.ts";

/** Модель в формате PR #36 (этап 239): ключ трассы кондиционера cable_conditioner_id. */
function legacyConditionerModel(): Model {
  const { m, cond, eng } = scenario();
  const cableId = "c1";
  (cond as unknown as Record<string, Record<string, unknown>>).cables_conditioner = { cable_conditioner_id: cableId };
  (eng as unknown as Record<string, Record<string, unknown>>).cables_conditioner = { cable_conditioner_id: cableId };
  (m as unknown as Record<string, Record<string, unknown>>).cables_conditioner = {
    [cableId]: {
      id: cableId,
      type: "conditioner_wire",
      matrix: [[null, { length: 1 }], [{ length: 1 }, null]],
      vertexes: [
        { id: cond.id, point: { ...cond.pc }, type: "electrospot" },
        { id: eng.id, point: { ...eng.pc }, type: "electrospot" },
      ],
      items: { [cond.id]: "electrospot", [eng.id]: "electrospot" },
      length: 1.5,
    },
  };
  return m;
}

test("ревью 251 №3: toModel мигрирует legacy cable_conditioner_id → conditioner_cable_id (скаляр, массив, под-розетки)", () => {
  const m = legacyConditionerModel();
  // массивная форма у multi-предмета и под-розетка группы с legacy-ключом
  const shield = structuredClone(m.items![Object.keys(m.items!)[0]!]!) as unknown as Record<string, unknown>;
  shield.id = "sh1";
  shield.name = "electric_shield";
  shield.cables_conditioner = { cable_conditioner_id: ["c1"] };
  shield.socket_group = [{ id: "sg1", name: "socket_thermo", cables_conditioner: { cable_conditioner_id: "c1" } }];
  (m.items as Record<string, unknown>)["sh1"] = shield;
  const canon = toModel(JSON.parse(JSON.stringify(m)) as Record<string, unknown>);
  for (const id of [condIdOf(canon, "conditioner"), condIdOf(canon, "conditioner_engine")]) {
    const box = (canon.items![id] as unknown as Record<string, Record<string, unknown>>).cables_conditioner!;
    assert.equal(box.conditioner_cable_id, "c1", `${id}: скаляр мигрировал`);
    assert.equal("cable_conditioner_id" in box, false, `${id}: legacy-ключ удалён`);
  }
  const sh = canon.items!["sh1"] as unknown as Record<string, Record<string, unknown>>;
  assert.deepEqual(sh.cables_conditioner!.conditioner_cable_id, ["c1"], "массив мигрировал с сохранением формы");
  const sub = (sh.socket_group as Record<string, Record<string, unknown>>[])[0]!;
  assert.equal(sub.cables_conditioner!.conditioner_cable_id, "c1", "под-розетка мигрировала");
});

function condIdOf(m: Model, name: string): string {
  const found = Object.values(m.items ?? {}).find((it) => it.name === name);
  assert.ok(found, `нет предмета ${name}`);
  return found.id;
}

test("ревью 251 №3: mock save — legacy-модель PR #36 сохраняется verified (сверка не падает на старом ключе)", async () => {
  const model = legacyConditionerModel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, "legacy-модель сохраняется без расхождений сверки");
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

// ---------- живые эталоны ui-ref-climate2-* (пробы 250-connect*) в обе стороны ----------

import { climateGraphMismatches } from "../../src/verify/climate.ts";
import { gasLineLengthM } from "../../src/model/pipes.ts";

type Fixture = { _source: string; model_object: Record<string, unknown>; item_props?: Record<string, unknown>; warm_floor_object?: Record<string, unknown> };

const loadFixture = (name: string): Fixture =>
  JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-climate2-${name}.json`), "utf8")) as Fixture;

/** Переименование id эталона под фактические id сценария (обезличенные id1… → модельные). */
function substitute(node: unknown, map: Record<string, string>): unknown {
  if (typeof node === "string") return map[node] ?? node;
  if (Array.isArray(node)) return node.map((x) => substitute(x, map));
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [substitute(k, map) as string, substitute(v, map)]));
  }
  return node;
}

/** Убрать pp (MCP не воспроизводит точку захвата мыши — производное поле протяжки). */
function stripPp(pipe: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(pipe) as { vertexes?: Record<string, unknown>[] };
  for (const v of copy.vertexes ?? []) delete v.pp;
  return copy;
}

test("250: эталон ui-ref-climate2-heat-pipe — формат из редактора и проекция MCP совпадают (обе стороны)", () => {
  const fx = loadFixture("heat-pipe");
  const ref = structuredClone(fx.model_object!) as Record<string, unknown>;
  const props = fx.item_props!;
  // живой формат: pp на вершине-предмете, ключ heat_pipe_hot_id в props.pipes_heat
  const refVertex = (ref.vertexes as Record<string, unknown>[])[0]!;
  
  assert.ok((refVertex as { pp: Record<string, unknown> }).pp, "в редакторе у вершины-предмета есть pp");
  assert.equal(((props.pipes_heat as Record<string, unknown>).heat_pipe_hot_id), "id2");
  // обратная сторона: MCP воспроизводит семантику (pp и длина от грани — производные)
  const { m, radiator } = scenario();
  const pipe = addPipe(m, { kind: "heat_hot", path: [{ itemId: radiator.id }, { x: 1807.2, y: -211.8 }] });
  const nodeId = pipe.vertexes[1]!.id;
  const map = { id1: radiator.id, id2: pipe.id, id3: nodeId };
  const expected = { warm_floors: structuredClone(m.warm_floors ?? {}) as never, pipes_heat: { [pipe.id]: stripPp(substitute(ref, map) as Record<string, unknown>) } };
  const itemsExpected = { [radiator.id]: substitute(props, map) as Record<string, unknown> };
  const mism = climateGraphMismatches(expected as never, m as never, {
    mode: "save",
    itemsExpected: itemsExpected as never,
    itemsGot: m.items as never,
  });
  assert.deepEqual(mism, []);
  // обратная сторона: модель MCP как ожидание против эталона редактора
  const mism2 = climateGraphMismatches({ pipes_heat: structuredClone((m as { pipes_heat?: Record<string, Pipe> }).pipes_heat ?? {}) } as never, { pipes_heat: { [pipe.id]: substitute(ref, map) } } as never, {
    mode: "save",
    itemsExpected: structuredClone(m.items) as never,
    itemsGot: { [radiator.id]: substitute(props, map) } as never,
  });
  assert.deepEqual(mism2, []);
});

test("250: эталон ui-ref-climate2-conditioner-drainage — ссылка drainage_pipe_id в props.pipes_conditioner", () => {
  const fx = loadFixture("conditioner-drainage");
  const ref = structuredClone(fx.model_object!) as Record<string, unknown>;
  const props = fx.item_props!;
  assert.equal((props.pipes_conditioner as Record<string, unknown>).drainage_pipe_id, "id2");
  const { m, cond } = scenario();
  const pipe = addPipe(m, { kind: "conditioner_drainage", path: [{ itemId: cond.id }, { x: -0.93, y: 1000 }] });
  const map = { id1: cond.id, id2: pipe.id, id3: pipe.vertexes[1]!.id };
  const expected = { warm_floors: structuredClone(m.warm_floors ?? {}) as never, pipes_conditioner: { [pipe.id]: stripPp(substitute(ref, map) as Record<string, unknown>) } };
  const itemsExpected = { [cond.id]: substitute(props, map) as Record<string, unknown> };
  assert.deepEqual(climateGraphMismatches(expected as never, m as never, { mode: "save", itemsExpected: itemsExpected as never, itemsGot: m.items as never }), []);
  assert.deepEqual(climateGraphMismatches({ pipes_conditioner: structuredClone((m as { pipes_conditioner?: Record<string, Pipe> }).pipes_conditioner ?? {}) } as never, { pipes_conditioner: { [pipe.id]: substitute(ref, map) } } as never, { mode: "save", itemsExpected: structuredClone(m.items) as never, itemsGot: { [cond.id]: substitute(props, map) } as never }), []);
});

test("250: эталон ui-ref-climate2-warm-floor-pipe-contour — вершина-контур и ссылка в props контура", () => {
  const fx = loadFixture("warm-floor-pipe-contour");
  const wfRef = fx.warm_floor_object as Record<string, unknown>;
  const ref = fx.model_object as Record<string, unknown>;
  // живой формат: вершина type "warm_floor" у polygon[0], pp на ребре контура,
  // ссылка pipe_warm_floor_id в props КОНТУРА
  const refVertex = (ref.vertexes as Record<string, unknown>[])[0]!;
  assert.equal(refVertex.type, "warm_floor");
  assert.ok(refVertex.pp, "pp точки подключения на полигоне контура");
  assert.equal(((wfRef.props as Record<string, unknown>).pipes_warm_floor as Record<string, unknown>).pipe_warm_floor_id, "id2");
  // обратная сторона: магистраль MCP с вершиной-контуром семантически совпадает с эталоном
  const { m, wf } = scenario();
  (wf as unknown as { length_pipes: number }).length_pipes = 6.18;
    const p0 = wf.polygon[0]!;
  const pipe = addPipe(m, { kind: "warm_floor", path: [{ itemId: wf.id }, { x: (p0.x - 61.12) * 10, y: (p0.y - 40.75) * 10 }] });
  const map = { id1: wf.id, id2: pipe.id, id3: pipe.vertexes[1]!.id, id8: String(wf.id_room) };
  const expectedPipe = stripPp(substitute(ref, map) as Record<string, unknown>) as { vertexes: { point?: { x: number; y: number } }[]; length: number };
  expectedPipe.vertexes[0]!.point = { ...wf.polygon[0]! };
  expectedPipe.vertexes[1]!.point = { ...pipe.vertexes[1]!.point! };
  expectedPipe.length = pipe.length;
  assert.deepEqual(climateGraphMismatches({ warm_floors: structuredClone(m.warm_floors ?? {}) as never, pipes_warm_floor: { [pipe.id]: expectedPipe } } as never, m as never, { mode: "save", itemsExpected: structuredClone(m.items) as never, itemsGot: m.items as never }), []);
});

test("250: эталон ui-ref-climate2-vent-pipe-fan — сечение рёбер, spots {}, ключ ventpipe_out_id", () => {
  const fx = loadFixture("vent-pipe-fan");
  const ref = structuredClone(fx.model_object!) as Record<string, unknown>;
  const props = fx.item_props!;
  // живой формат: ребро с сечением, spots {}, ссылка в props.pipes_ventilation
  const edge = (ref.matrix as Array<Array<Record<string, unknown> | null>>)[0]![1]!;
  assert.equal(edge.width, 20.4);
  assert.equal(edge.type, "flat");
  assert.equal(edge.height, 6);
  assert.deepEqual(ref.spots, {});
  assert.equal((props.pipes_ventilation as Record<string, unknown>).ventpipe_out_id, "id2");
  const { m, fan } = scenario();
  const pipe = addPipe(m, { kind: "vent_out", path: [{ itemId: fan.id }, { x: 2088.6, y: 1100 }] });
  const map = { id1: fan.id, id2: pipe.id, id3: pipe.vertexes[1]!.id };
  // ревью 251 №2: MCP пишет сечение в рёбра матрицы воздуховода, как редактор
  // (defs.ventilation_pipe: {length, width, type "flat", height})
  const mcpEdge = ((m.pipes_ventilation as Record<string, Pipe>)[pipe.id]!.matrix as Array<Array<Record<string, unknown> | null>>)[0]![1]!;
  assert.deepEqual(mcpEdge, { length: 1, width: 20.4, type: "flat", height: 6 }, "ребро воздуховода MCP несёт сечение из defs.ventilation_pipe");
  const expected = { warm_floors: structuredClone(m.warm_floors ?? {}) as never, pipes_ventilation: { [pipe.id]: stripPp(substitute(ref, map) as Record<string, unknown>) } };
  const itemsExpected = { [fan.id]: substitute(props, map) as Record<string, unknown> };
  assert.deepEqual(climateGraphMismatches(expected as never, m as never, { mode: "save", itemsExpected: itemsExpected as never, itemsGot: m.items as never }), []);
  assert.deepEqual(climateGraphMismatches({ pipes_ventilation: structuredClone((m as { pipes_ventilation?: Record<string, Pipe> }).pipes_ventilation ?? {}) } as never, { pipes_ventilation: { [pipe.id]: substitute(ref, map) } } as never, { mode: "save", itemsExpected: structuredClone(m.items) as never, itemsGot: { [fan.id]: substitute(props, map) } as never }), []);
});

test("ревью 251 №2: сервер потерял сечение ребра воздуховода → расхождение (сверка payload ребра целиком)", () => {
  const fx = loadFixture("vent-pipe-fan");
  const ref = structuredClone(fx.model_object!) as Record<string, unknown>;
  const props = fx.item_props!;
  const { m, fan } = scenario();
  const pipe = addPipe(m, { kind: "vent_out", path: [{ itemId: fan.id }, { x: 2088.6, y: 1100 }] });
  const map = { id1: fan.id, id2: pipe.id, id3: pipe.vertexes[1]!.id };
  // сервер (редактор) отдал ребро без сечения — раньше сверка видела только length
  const got = structuredClone(substitute(ref, map)) as { matrix: Array<Array<Record<string, unknown> | null>> };
  got.matrix[0]![1] = { length: 1 };
  got.matrix[1]![0] = { length: 1 };
  const mism = climateGraphMismatches(
    { pipes_ventilation: { [pipe.id]: structuredClone((m as { pipes_ventilation?: Record<string, Pipe> }).pipes_ventilation ?? {})[pipe.id]! } } as never,
    { pipes_ventilation: { [pipe.id]: stripPp(got) } } as never,
    { mode: "save", itemsExpected: structuredClone(m.items) as never, itemsGot: { [fan.id]: substitute(props, map) } as never },
  );
  assert.notEqual(mism.length, 0, "потеря сечения ребра — расхождение");
  assert.ok(mism.some((s) => s.includes("ребро") || s.includes("payload")), JSON.stringify(mism));
});

test("250: эталоны климата ч.2 без внутренних ID сайта и без секретов", () => {
  for (const name of ["heat-pipe", "conditioner-drainage", "warm-floor-pipe-contour", "vent-pipe-fan"]) {
    const raw = readFileSync(join(here, `../fixtures/ui-ref-climate2-${name}.json`), "utf8");
    assert.doesNotMatch(raw, /"id":\s*"_[a-z0-9]{5}"/, `${name}: внутренние ID сайта обезличены`);
    assert.match(raw, /обезличены/, `${name}: _source фиксирует обезличивание`);
  }
});

void gasLineLengthM;
void updatePipe;
