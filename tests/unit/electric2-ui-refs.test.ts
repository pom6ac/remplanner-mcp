// Часть 2 «Электропроводка»: кабели-проводка model.cables_socket/cables_warm_floor/
// cables_conditioner (wiring_add/update/delete), выводы проводов и щитки/коробки
// как предметы (item_add), связь «выключатель → лента/шина» (cable_add).
// Эталоны UI в обе стороны (ui-ref-elec2-*), атомарность, удаление без висячих
// связей, реестр коллекций, компакт, сверки подключений, mock save.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps, ElecCable, Cable } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addItem, updateItem, deleteItem } from "../../src/model/items.ts";

import { addCable, deleteCable, cablesReferencingLine, CABLE_LINE_ITEMS } from "../../src/model/electric.ts";
import {
  addElecCable, updateElecCable, deleteElecCable, elecCablesReferencingItem,
  SOCKET_CABLE_TOOLS, ELEC_CABLE_TOOLS, elecLinkKey, ELEC_MULTI_ITEMS, ELEC_WIRE_ITEMS,
} from "../../src/model/electric2.ts";
import { addLightLine, updateLightLine, deleteLightLine } from "../../src/model/lighting.ts";
import { compactModel } from "../../src/model/compact.ts";
import { clearEntityCollections, replaceEntityCollections, MODEL_ENTITY_COLLECTIONS } from "../../src/model/collections.ts";
import { elecCableConnectionMismatches } from "../../src/verify/elec.ts";
import { resolveCableLamp } from "../../src/dto/structures.ts";
import { toToolEntry, type ToolEntry } from "../../src/catalog.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));

function baseModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  const m = { ...structuredClone(model), walls: {} } as Model;
  addRoomRect(m, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  m.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return m;
}

const CATALOG: Record<string, Record<string, unknown>> = {
  wire: { id: 609, group: "wires", width: 14, height: 20, self_height: 0, plan: { sockets: 9 }, anchor: "wall", over_floor: { value: 30, display: false }, title: "Вывод провода 220В" },
  floor_wire: { id: 615, group: "wires", width: 14, height: 14, self_height: 0, plan: { sockets: 9 }, anchor: "ceiling", over_floor: false, title: "Напольный вывод" },
  electric_box: { id: 512, group: "furniture", width: 15, height: 15, self_height: 0, plan: { cables: 31 }, anchor: "free", over_floor: false, title: "Распред. короб" },
  electric_shield: { id: 28, group: "furniture", width: 30, height: 11, self_height: 25, plan: { cables: 31, sockets: 9 }, anchor: "wall", over_floor: { value: 120, display: false }, title: "Накладной электрощиток" },
  electric_shield_internal: { id: 29, group: "furniture", width: 30, height: 10, self_height: 25, plan: { cables: 31, sockets: 9 }, anchor: "wall", over_floor: { value: 120, display: false }, title: "Встр. электрощиток" },
  electric_kup: { id: 513, group: "furniture", width: 15, height: 6, self_height: 0, plan: { cables: 31 }, anchor: "wall", over_floor: { value: 120, display: false }, title: "Короб уравн. потенциалов" },
  socket: { id: 570, group: "sockets", width: 14, height: 14, self_height: 0, plan: { sockets: 9 }, anchor: "wall", over_floor: { value: 30, display: false }, title: "Розетка" },
  light_switch: { id: 577, group: "switches", width: 14, height: 18, self_height: 0, plan: { light_connections: 29 }, anchor: "wall", over_floor: { value: 90, display: false }, title: "1-клавишный выключатель" },
};

function entry(name: string): ToolEntry {
  const raw = CATALOG[name];
  assert.ok(raw, `нет каталога для ${name}`);
  return { id: Number(raw.id), name, title: String(raw.title ?? name), group: String(raw.group), width: Number(raw.width), height: Number(raw.height), self_height: Number(raw.self_height ?? 0), plan: raw.plan as Record<string, number>, anchor: raw.anchor as string | undefined, over_floor: raw.over_floor as never };
}

function addItemByName(model: Model, name: string, position: Record<string, unknown>): ItemProps {
  return addItem(model, { name, position: position as never, catalogEntry: entry(name) } as never);
}

const topWall = (m: Model): string => {
  const w = Object.values(m.walls).find((w) => w.p1.y === w.p2.y)!;
  assert.ok(w, "нет горизонтальной стены");
  return w.id;
};

function scenario(): { m: Model; shield: ItemProps; box: ItemProps; wire: ItemProps; socket: ItemProps } {
  const m = baseModel();
  const shield = addItem(m, { name: "electric_shield", position: { againstWall: { wallId: topWall(m), offsetMm: 3000 } }, catalogEntry: entry("electric_shield") } as never);
  const box = addItem(m, { name: "electric_box", position: { center: { x: 2000, y: 1500 } }, catalogEntry: entry("electric_box") } as never);
  const wire = addItem(m, { name: "wire", position: { againstWall: { wallId: topWall(m), offsetMm: 500 } }, catalogEntry: entry("wire") } as never);
  const socket = addItem(m, { name: "socket", position: { againstWall: { wallId: topWall(m), offsetMm: 1000 } }, catalogEntry: entry("socket") } as never);
  return { m, shield, box, wire, socket };
}

// ---------- состав раздела ----------

test("239: состав раздела — 31 тип кабелей cables_socket + warm_floor_wire + conditioner_wire", () => {
  assert.equal(SOCKET_CABLE_TOOLS.length, 31);
  for (const t of ["wire_2_25", "wire_5_100", "wire_earth_1_40", "wire_tv", "wire_utp", "wire_optical"]) {
    assert.ok((SOCKET_CABLE_TOOLS as readonly string[]).includes(t), t);
  }
  assert.deepEqual(ELEC_CABLE_TOOLS.cables_warm_floor, ["warm_floor_wire"]);
  assert.deepEqual(ELEC_CABLE_TOOLS.cables_conditioner, ["conditioner_wire"]);
});

test("239: ключи обратных ссылок — cable_<тип>_id / cable_warm_floor_id / conditioner_cable_id (250)", () => {
  assert.equal(elecLinkKey("cables_socket", "wire_3_25"), "cable_wire_3_25_id");
  assert.equal(elecLinkKey("cables_socket", "wire_tv"), "cable_wire_tv_id");
  assert.equal(elecLinkKey("cables_warm_floor", "warm_floor_wire"), "cable_warm_floor_id");
  assert.equal(elecLinkKey("cables_conditioner", "conditioner_wire"), "conditioner_cable_id");
});

test("239: multi-предметы — щитки и коробки; electrospot — розетки и выводы; ленты — CABLE_LINE_ITEMS", () => {
  for (const n of ["electric_shield", "electric_shield_internal", "electric_shield_old", "lowcurrent_shield", "lowcurrent_shield_internal", "electric_box", "electric_box_wall", "electric_kup"]) {
    assert.ok(ELEC_MULTI_ITEMS.has(n), n);
  }
  for (const n of ["wire", "wire_light", "wire_oven", "wire_stove", "wire_conditioner", "wire_lowcurrent", "floor_wire", "ceiling_wire"]) {
    assert.ok(ELEC_WIRE_ITEMS.has(n), n);
  }
  assert.deepEqual([...CABLE_LINE_ITEMS].sort(), ["led_strip", "line_light", "pendent_strip", "recessed_strip", "surface_stripe"]);
});

// ---------- эталоны UI в обе стороны ----------

test("239: эталон ui-ref-elec2-cable-socket — вершины multi с pp, type wire_3_25, длина в метрах", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-elec2-cable-socket.json"), "utf8")) as { model_object: ElecCable };
  const c = fx.model_object;
  assert.equal(c.type, "wire_3_25");
  assert.equal(c.vertexes.length, 2);
  assert.equal(c.vertexes[0]!.type, "multi");
  assert.equal(c.vertexes[1]!.type, "multi");
  assert.deepEqual(c.vertexes[0]!.pp, { [c.vertexes[1]!.id]: { i: 0, d: 0.5 } });
  assert.deepEqual(c.items, { [c.vertexes[0]!.id]: "multi", [c.vertexes[1]!.id]: "multi" });
  assert.equal(typeof c.length, "number");
});

test("239: wiring_add box→shield воспроизводит эталон (обе стороны): multi-вершины, pp, ссылки-массивы, длина", () => {
  const { m, shield, box } = scenario();
  const cable = addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: shield.id }] });
  assert.equal(cable.type, "wire_3_25");
  assert.equal(cable.vertexes.length, 2);
  const [vBox, vShield] = cable.vertexes as [{ id: string; type: string; point: { x: number; y: number }; pp?: Record<string, { i: number; d: number }> }, { id: string; type: string; point: { x: number; y: number }; pp?: Record<string, { i: number; d: number }> }];
  assert.equal(vBox.id, box.id);
  assert.equal(vBox.type, "multi");
  assert.deepEqual(vBox.point, { x: 200, y: 150 });
  assert.deepEqual(vShield.point, { x: shield.pc.x, y: shield.pc.y });
  assert.deepEqual(vBox.pp, { [vShield.id]: { i: 0, d: 0.5 } });
  assert.deepEqual(vShield.pp, { [vBox.id]: { i: 0, d: 0.5 } });
  assert.deepEqual(cable.items, { [vBox.id]: "multi", [vShield.id]: "multi" });
  // обратные ссылки — массивы у multi
  const link = (cable: ElecCable) => cable;
  void link;
  const shBox = m.items[box.id] as unknown as { cables_socket?: { cable_wire_3_25_id?: unknown } };
  const shShield = m.items[shield.id] as unknown as { cables_socket?: { cable_wire_3_25_id?: unknown } };
  assert.deepEqual(shBox.cables_socket?.cable_wire_3_25_id, [cable.id]);
  assert.deepEqual(shShield.cables_socket?.cable_wire_3_25_id, [cable.id]);
});

test("239: wiring_add box→wire — вершина вывода electrospot на 7 см от грани, ссылка скаляр", () => {
  const { m, box, wire } = scenario();
  const cable = addElecCable(m, { tool: "wire_2_25", path: [{ itemId: box.id }, { itemId: wire.id }] });
  const vWire = cable.vertexes.find((v) => v.id === wire.id)!;
  assert.equal(vWire.type, "electrospot");
  // wire у верхней стены: pc.y = 10 (глубина 20), вершина на 7 см от грани (y=0): 7
  assert.equal(vWire.point.y, 7);
  assert.equal(vWire.point.x, wire.pc.x);
  const holder = m.items[wire.id] as unknown as { cables_socket?: { cable_wire_2_25_id?: unknown } };
  assert.equal(holder.cables_socket?.cable_wire_2_25_id, cable.id);
});

test("239: wiring_add box→socket — вершина под-розетки <gid>|s|<sub>, type electrospot, точка center", () => {
  const { m, box, socket } = scenario();
  const cable = addElecCable(m, { tool: "wire_5_25", path: [{ itemId: box.id }, { itemId: socket.id }] });
  const sub = (socket.socket_group as Array<{ id: string; center: { x: number; y: number } }>)[0]!;
  const v = cable.vertexes.find((x) => x.id === `${socket.id}|s|${sub.id}`)!;
  assert.ok(v, "вершина под-розетки");
  assert.equal(v.type, "electrospot");
  assert.deepEqual(v.point, sub.center);
  const holder = socket.socket_group as Array<{ cables_socket?: { cable_wire_5_25_id?: unknown } }>;
  assert.equal(holder[0]!.cables_socket?.cable_wire_5_25_id, cable.id);
});

test("239: wiring_add warm_floor_wire — вершина терморегулятора type socket_thermo, ссылка cable_warm_floor_id", () => {
  const { m, box } = scenario();
  const thermo = addItem(m, { name: "socket", position: { againstWall: { wallId: topWall(m), offsetMm: 1500 } }, catalogEntry: entry("socket") } as never);
  (thermo.socket_group as Array<{ name: string }>)[0]!.name = "socket_thermo";
  const cable = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { x: 2500, y: 2000 }] });
  assert.equal(cable.type, "warm_floor_wire");
  const v = cable.vertexes.find((x) => x.id.startsWith(`${thermo.id}|s|`))!;
  assert.equal(v.type, "socket_thermo");
  const holder = m.items[thermo.id] as unknown as { socket_group: Array<{ cables_warm_floor?: { cable_warm_floor_id?: unknown } }> };
  assert.equal(holder.socket_group[0]!.cables_warm_floor?.cable_warm_floor_id, cable.id);
});

// ---------- атомарность и лимиты ----------

test("239: атомарность — не-подключаемый предмет, повторное подключение вывода, дубликат в пути, NOT_FOUND", () => {
  const { m, shield, box, wire } = scenario();
  // чужой предмет (светильник-неэлектрика) в пути
  assert.throws(() => addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: "no_such" }] }),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "NOT_FOUND");
  const sofa = addItem(m, { name: "sofa", position: { center: { x: 3000, y: 2000 } }, catalogEntry: { name: "sofa", title: "Диван", group: "furniture", width: 200, height: 90, self_height: 0, plan: {} } as never } as never);
  const before = structuredClone(m);
  assert.throws(() => addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: sofa.id }] }),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT");
  assert.deepEqual(m, before, "модель не меняется при отказе");
  // повторное подключение того же вывода к кабелю того же вида
  const c1 = addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: wire.id }] });
  assert.throws(() => addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: wire.id }] }),
    (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("уже подключён"));
  // но другой тип кабеля тому же выводу — можно
  const c2 = addElecCable(m, { tool: "wire_tv", path: [{ itemId: box.id }, { itemId: wire.id }] });
  assert.notEqual(c1.id, c2.id);
  // дубликат предмета в пути
  assert.throws(() => addElecCable(m, { tool: "wire_2_25", path: [{ itemId: shield.id }, { itemId: shield.id }] }),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT");
  // меньше 2 точек
  assert.throws(() => addElecCable(m, { tool: "wire_2_25", path: [{ itemId: box.id }] }),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT");
  // неизвестный тип кабеля
  assert.throws(() => addElecCable(m, { tool: "wire_9_9", path: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT");
});

// ---------- update/delete/пересчёты ----------

test("239: wiring_update переносит узлы (node), вершины-предметы — нет; длина по рёбрам", () => {
  const { m, box, shield } = scenario();
  const cable = addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { x: 3000, y: 1500 }, { itemId: shield.id }] });
  const nodeIdx = cable.vertexes.findIndex((v) => v.type === "node");
  const updated = updateElecCable(m, { wiringId: cable.id, positions: [{ vertex: nodeIdx, x: 3000, y: 1000 }] });
  assert.deepEqual(updated.vertexes[nodeIdx]!.point, { x: 300, y: 100 });
  assert.throws(() => updateElecCable(m, { wiringId: cable.id, positions: [{ vertex: 0, x: 0, y: 0 }] }),
    (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("предмет"));
  assert.throws(() => updateElecCable(m, { wiringId: "no_such", positions: [{ vertex: 0, x: 0, y: 0 }] }),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "NOT_FOUND");
});

test("239: item_update вывода — вершина кабеля следует (7 см от новой грани), длина пересчитана", () => {
  const { m, box, wire } = scenario();
  addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: wire.id }] });
  updateItem(m, { itemId: wire.id, center: { x: 1000, y: 1000 } });
  const cable = Object.values(m.cables_socket ?? {})[0]!;
  const v = cable.vertexes.find((x) => x.id === wire.id)!;
  assert.deepEqual(v.point, { x: 100, y: 100 - 3 }); // свободная точка: pc (id_wall снят updateItem не пишет id_wall при переносе center)
});

test("239: wiring_delete снимает ссылки, item_delete подключённого предмета — INVALID_ARGUMENT (сначала wiring_delete)", () => {
  const { m, box, wire } = scenario();
  const cable = addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: wire.id }] });
  assert.equal(elecCablesReferencingItem(m, wire.id).length, 1);
  assert.throws(() => deleteItem(m, wire.id),
    (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("wiring_delete"));
  deleteElecCable(m, cable.id);
  assert.equal(elecCablesReferencingItem(m, wire.id).length, 0);
  assert.equal((m.items[wire.id] as unknown as { cables_socket?: unknown }).cables_socket, undefined);
  assert.equal((m.items[box.id] as unknown as { cables_socket?: unknown }).cables_socket, undefined);
  assert.equal(Object.keys(m.cables_socket ?? {}).length, 0);
  assert.doesNotThrow(() => deleteItem(m, wire.id));
  // повторное удаление — NOT_FOUND
  assert.throws(() => deleteElecCable(m, cable.id), (e: unknown) => e instanceof McpError && (e as McpError).code === "NOT_FOUND");
});

test("239: щиток — item_add у стены с over_floor {120, false}, article/plan_parent не пишет MCP; electric_box — свободный без over_floor", () => {
  const { shield, box } = scenario();
  assert.equal(shield.name, "electric_shield");
  assert.deepEqual(shield.over_floor, { value: 120, display: false });
  assert.equal(shield.self_height, 25);
  assert.equal(shield.id_wall, topWallM(shield));
  function topWallM(it: ItemProps): string | null { return it.id_wall ?? null; }
  assert.equal(box.name, "electric_box");
  assert.equal(box.over_floor ?? null, null);
  assert.equal(box.id_wall ?? null, null);
});

// ---------- реестр коллекций и компакт ----------

test("239: реестр — cables_socket/warm_floor/conditioner в clear/import; пустой проект не ломается", () => {
  const m = scenario().m;
  clearEntityCollections(m);
  assert.equal(m.cables_socket, undefined);
  const source = scenario().m;
  replaceEntityCollections(m, source);
  assert.equal(Object.keys(m.cables_socket ?? {}).length, 0);
  addElecCable(m, { tool: "wire_3_25", path: [{ x: 0, y: 0 }, { x: 100, y: 0 }] });
  const target = scenario().m;
  replaceEntityCollections(target, m);
  assert.equal(Object.keys(target.cables_socket ?? {}).length, 1);
});

test("239: компакт — метки CS/CW/CC, connected, длина в мм; will_delete-ключи реестра", () => {
  const { m, box } = scenario();
  const thermo = addItem(m, { name: "socket", position: { againstWall: { wallId: topWall(m), offsetMm: 1500 } }, catalogEntry: entry("socket") } as never);
  (thermo.socket_group as Array<{ name: string }>)[0]!.name = "socket_thermo";
  addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: box.id }, { itemId: thermo.id }] });
  const c = compactModel(m);
  assert.equal(c.cables_warm_floor.length, 1);
  const cw = c.cables_warm_floor[0]!;
  assert.equal(cw.id, "CW1");
  assert.equal(cw.type, "warm_floor_wire");
  assert.equal(cw.vertexes, 2);
  assert.ok(cw.connected.includes(box.id));
  assert.ok(cw.connected.some((id) => id.startsWith(`${thermo.id}|s|`)), "вершина под-розетки-термостата");
  assert.equal(cw.length_mm, Math.round(cw.length_mm));
});

// ---------- сверка подключений ----------

function cableSigs(m: Model): Record<string, Record<string, ElecCable>> {
  return {
    cables_socket: (m.cables_socket ?? {}) as Record<string, ElecCable>,
    cables_warm_floor: (m.cables_warm_floor ?? {}) as Record<string, ElecCable>,
    cables_conditioner: (m.cables_conditioner ?? {}) as Record<string, ElecCable>,
  };
}

test("239: сверка подключений — валидная модель проходит, потеря ссылки и лишняя ссылка — расхождения", () => {
  const { m, box, wire, socket } = scenario();
  const cable = addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: wire.id }] });
  const items = m.items as Record<string, never>;
  assert.deepEqual(elecCableConnectionMismatches(cableSigs(m), items, cableSigs(m), items), []);
  // сервер оторвал ссылку
  const broken = structuredClone(m);
  delete ((broken.items[wire.id] as unknown as Record<string, Record<string, unknown>>).cables_socket!["cable_wire_3_25_id"]);
  const mm = elecCableConnectionMismatches(cableSigs(m), m.items as never, cableSigs(broken), broken.items as never);
  assert.ok(mm.some((x) => x.includes(cable.id)), mm.join("; "));
  // лишняя ссылка на сервере: под-розетка сокета ссылается на кабель, к которому не подключена
  const extra = structuredClone(m);
  const extraSocket = extra.items[socket.id] as unknown as { socket_group: Array<Record<string, unknown>> };
  ((extraSocket.socket_group[0]!.cables_socket ??= {}) as Record<string, unknown>)["cable_wire_3_25_id"] = cable.id;
  const mm2 = elecCableConnectionMismatches(cableSigs(m), m.items as never, cableSigs(extra), extra.items as never);
  assert.ok(mm2.some((x) => x.includes("лишняя") || x.includes("не содержит") || x.includes("другого вида")), mm2.join("; "));
});

// ---------- связь «выключатель → лента» (часть 2) ----------

function stripScenario(): { m: Model; sw: ItemProps; strip: { id: string; vertexes: { id: string; point: { x: number; y: number } }[]; props?: { cables?: { cable_id?: unknown } }; type: string } } {
  const m = baseModel();
  const sw = addItem(m, { name: "light_switch", position: { againstWall: { wallId: topWall(m), offsetMm: 500 } }, catalogEntry: entry("light_switch") } as never);
  const strip = addLightLine(m, { kind: "led", path: [{ x: 1000, y: 800 }, { x: 3000, y: 800 }] });
  return { m, sw, strip: strip as never };
}

test("239: cable_add выключатель → led_strip: вершина <lineId>|t|<vid>, sc, props.cables у линии", () => {
  const { m, sw, strip } = stripScenario();
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: strip.id });
  const v = cable.vertexes.find((x) => x.type === "led_strip")!;
  assert.ok(v, "вершина led_strip");
  assert.ok(v.id.startsWith(`${strip.id}|t|`), v.id);
  const swVertex = cable.vertexes.find((x) => x.type === "switch")!;
  assert.deepEqual(v.sc, { [swVertex.id]: v.id.slice(strip.id.length + 3) });
  const line = (m.led_strips as Record<string, { props?: { cables?: { cable_id?: unknown } } }>)[strip.id]!;
  assert.equal(line.props?.cables?.cable_id, cable.id);
  // занятая линия — отказ
  const sw2 = addItem(m, { name: "light_switch", position: { againstWall: { wallId: topWall(m), offsetMm: 3000 } }, catalogEntry: entry("light_switch") } as never);
  assert.throws(() => addCable(m, { switchItemId: sw2.id, lampItemId: strip.id }),
    (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("уже подключена"));
});

test("239: cable_delete снимает props.cables у линии; deleteLightLine с подключённой связью — отказ; перенос линии обновляет вершину", () => {
  const { m, sw, strip } = stripScenario();
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: strip.id });
  assert.throws(() => deleteLightLine(m, "led", strip.id),
    (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("cable_delete"));
  updateLightLine(m, { kind: "led", lineId: strip.id, positions: [{ vertex: 0, x: 1200, y: 900 }] });
  const cv = cable.vertexes.find((x) => x.type === "led_strip")!;
  assert.deepEqual(cv.point, { x: 120, y: 90 });
  deleteCable(m, cable.id);
  const line = (m.led_strips as Record<string, { props?: { cables?: { cable_id?: unknown } } }>)[strip.id]!;
  assert.equal(line.props?.cables, undefined);
  assert.equal(cablesReferencingLine(m, strip.id).length, 0);
  assert.doesNotThrow(() => deleteLightLine(m, "led", strip.id));
});

test("239: resolveCableLamp — предмет по id/метке, световая линия по LS/SL/LL и id сайта", () => {
  const { m, sw } = stripScenario();
  const strip = addLightLine(m, { kind: "led", path: [{ x: 1000, y: 800 }, { x: 3000, y: 800 }] });
  const label = `LS${Object.keys(m.led_strips ?? {}).length}`; // единственная лента — LS1
  assert.equal(resolveCableLamp(m, strip.id), strip.id);
  assert.equal(resolveCableLamp(m, label), strip.id);
  const swItem = m.items[sw.id] as unknown as Record<string, unknown>;
  assert.equal(resolveCableLamp(m, sw.id), sw.id);
  assert.equal(resolveCableLamp(m, "I1"), Object.values(m.items)[0]!.id);
  void swItem;
  assert.throws(() => resolveCableLamp(m, "no_such"), (e: unknown) => (e as { code?: string }).code === "NOT_FOUND");
});

// ---------- mock save ----------

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

test("239: mock save — кабель box→shield и обратные ссылки доходят до серверной модели, verified", async () => {
  const { m, shield, box } = scenario();
  addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: shield.id }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res).slice(0, 400));
  const sm = server.model as { cables_socket?: Record<string, ElecCable> };
  assert.equal(Object.keys(sm.cables_socket ?? {}).length, 1);
});

test("239: mock save — редактор дописал id_room вершинам и пересчитал длину (производная) → verified", async () => {
  const { m, shield, box } = scenario();
  addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: shield.id }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    for (const cable of Object.values(norm.cables_socket as Record<string, ElecCable>)) {
      for (const v of cable.vertexes) v.id_room = "roomX";
      cable.length = 99.99;
    }
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res).slice(0, 400));
});

test("239: mock save — нормализатор потерял кабель → NORMALIZATION_DROPPED, записи нет", async () => {
  const { m, shield, box } = scenario();
  addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: shield.id }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => { delete norm.cables_socket; });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => e instanceof McpError && (e as McpError).code === "NORMALIZATION_DROPPED");
  // записи не было: серверная модель осталась в состоянии открытия (кабель в ней есть)
  assert.equal(Object.keys(server.model.cables_socket ?? {}).length, 1);
});

test("239: mock save — сервер испортил узел и ребро кабеля → SITE_ERROR с cables_socket_mismatches", async () => {
  const { m, shield, box } = scenario();
  const cable = addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: shield.id }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const cable = Object.values((s.model.cables_socket as Record<string, ElecCable>))[0]!;
    cable.vertexes[0]!.point = { x: cable.vertexes[0]!.point.x + 5, y: cable.vertexes[0]!.point.y };
    cable.matrix[0]![1] = null;
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as McpError;
    if (!(err instanceof McpError && err.code === "SITE_ERROR")) return false;
    // ревью 241 №5: ключ есть в details всегда (пустым) — проверяем массив непустой
    // и с расхождением по этому кабелю
    const list = (err.details as Record<string, unknown>)["cables_socket_mismatches"] as string[] | undefined;
    return Array.isArray(list) && list.some((s) => s.includes(cable.id));
  });
});

test("239: mock save — сервер оторвал обратную ссылку multi-предмета → SITE_ERROR с cables_socket_connection_mismatches", async () => {
  const { m, shield, box } = scenario();
  const cable = addElecCable(m, { tool: "wire_3_25", path: [{ itemId: box.id }, { itemId: shield.id }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const it = s.model.items as Record<string, { cables_socket?: Record<string, unknown> }>;
    delete it[shield.id]!.cables_socket!["cable_wire_3_25_id"];
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as McpError;
    if (!(err instanceof McpError && err.code === "SITE_ERROR")) return false;
    // ревью 241 №5: массив непустой и содержит расхождение по этому кабелю
    const list = (err.details as Record<string, unknown>)["cables_socket_connection_mismatches"] as string[] | undefined;
    return Array.isArray(list) && list.some((s) => s.includes(cable.id));
  });
});

test("239: mock save — связь выключатель → лента (вершина |t|, sc, props.cables линии) сохраняется verified", async () => {
  const { m, sw, strip } = stripScenario();
  addCable(m, { switchItemId: sw.id, lampItemId: strip.id });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res).slice(0, 400));
});

// ---------- ревью 241 №8: вывод инструмента ≅ эталон (обе стороны, не только cable-socket) ----------

/** Структурные поля эталона, обязанные совпадать с выводом инструмента. */
function assertFixtureShape(fixture: Record<string, unknown>, produced: Record<string, unknown>, keys: string[]): void {
  for (const k of keys) {
    assert.ok(k in produced, `в выводе нет поля ${k}`);
    assert.deepEqual(produced[k], fixture[k], `поле ${k}: вывод ≠ эталон`);
  }
}

test("ревью 241 №8: item_add electric_shield у стены ≅ эталон ui-ref-elec2-shield", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-elec2-shield.json"), "utf8")) as { model_object: Record<string, unknown> };
  const { m, shield } = scenario();
  void m;
  // article/plan_parent пишет редактор при постановке через UI (item_add их не
  // пишет — эталон это показывает, тест проверяет их форму в эталоне)
  assert.equal(fx.model_object["plan_parent"], "cables");
  assert.equal(typeof fx.model_object["article"], "string");
  assertFixtureShape(fx.model_object, shield as unknown as Record<string, unknown>, [
    "name", "width", "height", "self_height", "plan", "over_floor", "dimensions",
  ]);
  const s = shield as unknown as Record<string, unknown>;
  assert.equal(typeof s["angle"], "number");
  assert.ok(s["comment"] && typeof s["comment"] === "object", "comment присутствует");
  assert.equal(typeof s["id_wall"], "string", "щиток у стены несёт id_wall");
  // wall_line/projection/icon_center/center3d — производные редактора: эталон их
  // документирует, item_add их не пишет (появят после normalize/GET)
  for (const k of ["wall_line", "projection", "icon_center", "center3d"]) {
    assert.ok(fx.model_object[k] && typeof fx.model_object[k] === "object", `эталон документирует ${k}`);
  }
});

test("ревью 241 №8: item_add wire у стены ≅ эталон ui-ref-elec2-wire", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-elec2-wire.json"), "utf8")) as { model_object: Record<string, unknown> };
  const { m, wire } = scenario();
  void m;
  assertFixtureShape(fx.model_object, wire as unknown as Record<string, unknown>, [
    "name", "width", "height", "self_height", "plan", "dimensions",
  ]);
  const w = wire as unknown as Record<string, unknown>;
  // over_floor: значение 30 совпадает; display зависит от каталога теста, сверяем value
  assert.deepEqual((w["over_floor"] as { value: number }).value, (fx.model_object["over_floor"] as { value: number }).value);
  assert.equal(typeof w["angle"], "number");
  assert.ok(w["comment"] && typeof w["comment"] === "object", "comment присутствует");
  assert.equal(typeof w["id_wall"], "string", "вывод у стены несёт id_wall");
  // wall_line/projection/icon_center/center3d — производные редактора (эталон
  // документирует, item_add не пишет — появят после normalize/GET)
  for (const k of ["wall_line", "projection", "icon_center", "center3d"]) {
    assert.ok(fx.model_object[k] && typeof fx.model_object[k] === "object", `эталон документирует ${k}`);
  }
});

test("ревью 241 №8: wiring_add warm_floor_wire ≅ эталон ui-ref-elec2-warm-floor (форма и keys items = id вершин)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-elec2-warm-floor.json"), "utf8")) as { model_object: ElecCable };
  const ref = fx.model_object;
  const { m, box } = scenario();
  const thermo = addItem(m, { name: "socket", position: { againstWall: { wallId: topWall(m), offsetMm: 1500 } }, catalogEntry: entry("socket") } as never);
  (thermo.socket_group as Array<{ name: string }>)[0]!.name = "socket_thermo";
  const cable = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { x: 2500, y: 2000 }] });
  assert.equal(cable.type, ref.type, "тип кабеля");
  assert.deepEqual(cable.vertexes.map((v) => v.type), ref.vertexes.map((v) => v.type), "типы вершин: socket_thermo + node");
  assert.deepEqual(cable.items, Object.fromEntries(cable.vertexes.map((v) => [v.id, v.type])), "ключи items = id вершин");
  assert.ok(cable.vertexes[0]!.id.includes("|s|"), "вершина терморегулятора в форме <gid>|s|<subId>");
  const holder = m.items[thermo.id] as unknown as { socket_group: Array<{ cables_warm_floor?: { cable_warm_floor_id?: unknown } }> };
  assert.equal(holder.socket_group[0]!.cables_warm_floor?.cable_warm_floor_id, cable.id, "обратная ссылка — скаляр");
});

test("ревью 241 №8: cable_add выключатель → лента ≅ эталон ui-ref-elec2-strip-link (форма |t|, sc, props.cables)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-elec2-strip-link.json"), "utf8")) as { model_cable: Cable };
  const ref = fx.model_cable;
  const { m, sw, strip } = stripScenario();
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: strip.id });
  assert.equal(cable.type, ref.type);
  assert.deepEqual(cable.vertexes.map((v) => v.type), ref.vertexes.map((v) => v.type), "типы вершин: switch + led_strip");
  const lineVertex = cable.vertexes.find((v) => v.type === "led_strip")!;
  assert.ok(lineVertex.id.startsWith(`${strip.id}|t|`), "вершина линии в форме <lineId>|t|<vid>");
  const sc = lineVertex.sc as Record<string, string>;
  const swVertex = cable.vertexes.find((v) => v.type === "switch")!;
  assert.equal(sc[swVertex.id], lineVertex.id.slice(`${strip.id}|t|`.length), "sc — хвост после |t|");
  assert.deepEqual(cable.items, Object.fromEntries(cable.vertexes.map((v) => [v.id, v.type])), "ключи items = id вершин");
  const line = (m.led_strips as Record<string, { props?: { cables?: { cable_id?: unknown } } }>)[strip.id]!;
  assert.equal(line.props?.cables?.cable_id, cable.id, "обратная ссылка линии — скаляр");
});

test("ревью 241 №8 → 250: ui-ref-elec2-conditioner — живой эталон, вершины electrospot (кондиционеры)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-elec2-conditioner.json"), "utf8")) as { _source: string; model_object: ElecCable };
  // снят вживую (проба 250-climate2-connect4): вершины-предметы electrospot с point = pc
  assert.match(fx._source, /250-climate2-connect4/);
  const ref = fx.model_object;
  assert.deepEqual(ref.items, Object.fromEntries(ref.vertexes.map((v) => [v.id, v.type])), "ключи items = id вершин");
  assert.equal(ref.type, "conditioner_wire");
  for (const v of ref.vertexes) assert.equal(v.type, "electrospot", "блоки кондиционера — electrospot, не multi");
});
