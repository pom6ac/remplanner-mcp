// Климат ч.3 (этап 268): кабель тёплого пола warm_floor_wire к контурам
// (кабельному/ИК; вершина-контур {id, point: polygon[0], type: warm_floor},
// ссылка props.cables_warm_floor.cable_warm_floor_id в контуре), коллекторные
// узлы как предметы каталога (radiator_collector/ext_manifold_box/int_manifold_box),
// guard'ы (один терморегулятор на кабель, водяной контур не подключается, у контура
// одно подключение, контуры не соединяются напрямую, пересчёт вершин при
// warm_floor_update, wiring_delete снимает ссылку контура, warm_floor_delete с
// кабелем — отказ), эталоны ui-ref-climate3-* в обе стороны, mock save.
// Форматы — живые пробы 268-recon4/268-recon5 (терморегулятор → кабельный контур).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps, WarmFloor, ElecCable } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addItem } from "../../src/model/items.ts";
import { addWarmFloor, updateWarmFloor, deleteWarmFloor } from "../../src/model/climate.ts";
import { addElecCable, deleteElecCable, elecLinkKey, elecContourVertex, elecLinkHolders } from "../../src/model/electric2.ts";
import { addPipe } from "../../src/model/pipes.ts";
import { compactModel } from "../../src/model/compact.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import { McpError } from "../../src/errors.ts";
import { elecCableConnectionMismatches } from "../../src/verify/elec.ts";
import { gasLineGraphMismatches, stripVertexIdRoom, type GasLineSig } from "../../src/verify/graphs.ts";
import type { ElecLinkItem } from "../../src/verify/elec.ts";
import type { ElecCableColl } from "../../src/model/electric2.ts";

const here = dirname(fileURLToPath(import.meta.url));
const COMPAT = { planner_version: "3", global_version: 1, tools_bundle: "t.js" } as never;

function baseModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  const m = { ...structuredClone(model), walls: {} } as Model;
  addRoomRect(m, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  // вторая комната — для дополнительных контуров (в комнате один контур)
  addRoomRect(m, { origin: { x: 5000, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  m.rooms2 = {
    r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never,
    r2: { polygon: [{ x: 500, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 300 }, { x: 500, y: 300 }], area: 12 } as never,
    r3: { polygon: [{ x: 1000, y: 0 }, { x: 1400, y: 0 }, { x: 1400, y: 300 }, { x: 1000, y: 300 }], area: 12 } as never,
  };
  return m;
}

const CATALOG: Record<string, Record<string, unknown>> = {
  socket_thermo: { id: 44, group: "sockets", width: 14, height: 14, self_height: 0, plan: { warm_floor: 11 }, anchor: "wall", over_floor: { value: 90, display: true }, title: "Терморегулятор" },
  radiator_collector: { id: 922, group: "furniture", width: 48, height: 10, self_height: 0, plan: { radiators: 26, warm_floor: 11 }, anchor: "wall", over_floor: { value: 0, display: false }, title: "Отопительный коллектор" },
  ext_manifold_box: { id: 1677, group: "furniture", width: 60, height: 15, self_height: 65, plan: { radiators: 26, warm_floor: 11 }, anchor: "wall", over_floor: { value: 0, display: false }, title: "Коллекторный шкаф внешний" },
  int_manifold_box: { id: 1678, group: "furniture", width: 60, height: 15, self_height: 65, plan: { radiators: 26, warm_floor: 11 }, anchor: "wall", over_floor: { value: 0, display: false }, title: "Коллекторный шкаф встроенный" },
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

/** Комната + терморегулятор + кабельный контур. */
function scenario(): { m: Model; thermo: ItemProps; thermoSubId: string; wfc: WarmFloor } {
  const m = baseModel();
  const thermo = addItem(m, { name: "socket_thermo", position: { againstWall: { wallId: topWall(m), offsetMm: 1000 } }, catalogEntry: entry("socket_thermo") } as never);
  const wfc = addWarmFloor(m, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 1500, y: 1500 } });
  const subs = thermo.socket_group as Array<{ id: string; name: string }>;
  const thermoSubId = subs.find((s) => s.name === "socket_thermo")!.id;
  return { m, thermo, thermoSubId, wfc };
}

const thermoVertexId = (thermo: ItemProps, subId: string): string => `${thermo.id}|s|${subId}`;

// ---------- эталон ui-ref-climate3-wire-wf-contour (обе стороны) ----------

test("268: эталон ui-ref-climate3-wire-wf-contour — wiring_add warm_floor_wire воспроизводит формат редактора (обе стороны)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-climate3-wire-wf-contour.json"), "utf8"));
  const cable = fx.model_object as ElecCable;
  // формат редактора: вершина-контур {id: id контура, point: polygon[0], type: warm_floor}
  const contourV = cable.vertexes.find((v) => v.type === "warm_floor")!;
  assert.equal(contourV.id, "id1");
  const wf1 = (fx.warm_floors as Record<string, WarmFloor>).id1!;
  void wf1;
  assert.deepEqual(contourV.point, wf1.polygon[0]);
  // ссылка в props КОНТУРА: cables_warm_floor.cable_warm_floor_id
  assert.equal((wf1.props as unknown as Record<string, Record<string, unknown>>).cables_warm_floor?.cable_warm_floor_id, cable.id);
  // items: вершина-контур и терморегулятор
  assert.equal(cable.items![contourV.id], "warm_floor");
  assert.equal(cable.items![cable.vertexes[0]!.id], "socket_thermo");
  // водяной контур в эталоне без ссылки на кабель (к проводу не подключается)
  assert.equal((fx.warm_floors.id8.props as unknown as Record<string, Record<string, unknown>>).cables_warm_floor, undefined);

  // обратная сторона: wiring_add воспроизводит семантику эталона
  const { m, thermo, thermoSubId, wfc } = scenario();
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  assert.equal(wire.type, "warm_floor_wire");
  assert.equal(wire.vertexes[0]!.id, thermoVertexId(thermo, thermoSubId));
  assert.equal(wire.vertexes[0]!.type, "socket_thermo");
  assert.equal(wire.vertexes[1]!.id, wfc.id);
  assert.equal(wire.vertexes[1]!.type, "warm_floor");
  // point вершины-контура = polygon[0] (get_point редактора)
  assert.deepEqual(wire.vertexes[1]!.point, wfc.polygon[0]);
  assert.equal(wire.items![wire.vertexes[1]!.id], "warm_floor");
  const props = wfc.props as unknown as Record<string, Record<string, unknown>>;
  assert.equal(props.cables_warm_floor?.cable_warm_floor_id, wire.id);
  // длина — по рёбрам между сохранёнными вершинами (в эталоне редактора — от точки
  // подключения pp; pp — производное протяжки, MCP его не пишет)
  const d = Math.hypot(wire.vertexes[0]!.point.x - wire.vertexes[1]!.point.x, wire.vertexes[0]!.point.y - wire.vertexes[1]!.point.y);
  assert.equal(wire.length, Math.round((d / 100) * 100) / 100);
});

test("268: elecContourVertex — водяной контур не подключается к проводу, IR подключается", () => {
  const { m, wfc } = scenario();
  const wfw = addWarmFloor(m, { kind: "water", corner1: { x: 5500, y: 500 }, corner2: { x: 6500, y: 1500 } });
  const wfi = addWarmFloor(m, { kind: "infrared", corner1: { x: 10500, y: 500 }, corner2: { x: 11500, y: 1500 } });
  const v = elecContourVertex(m, wfi.id);
  assert.equal(v.vertex.type, "warm_floor");
  assert.equal(v.kind, "warm_floor");
  assert.throws(() => elecContourVertex(m, wfw.id), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("водяного"));
  assert.throws(() => elecContourVertex(m, "nope"), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
  void wfc;
});

// ---------- guard'ы правил редактора ----------

test("268: у контура одно подключение — второй warm_floor_wire к тому же контуру отклоняется", () => {
  const { m, thermo, wfc } = scenario();
  const thermo2 = addItem(m, { name: "socket_thermo", position: { againstWall: { wallId: topWall(m), offsetMm: 3000 } }, catalogEntry: entry("socket_thermo") } as never);
  addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  assert.throws(
    () => addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo2.id }, { itemId: wfc.id }] }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("уже подключён"),
  );
});

test("268: один терморегулятор на кабель (l10n cabling_warm_floor_not_connect_two_thermo)", () => {
  const { m, thermo, wfc } = scenario();
  const thermo2 = addItem(m, { name: "socket_thermo", position: { againstWall: { wallId: topWall(m), offsetMm: 3000 } }, catalogEntry: entry("socket_thermo") } as never);
  assert.throws(
    () => addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: thermo2.id }, { x: 2000, y: 2000 }, { itemId: wfc.id }] }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("терморегулятора"),
  );
});

test("268: контуры не соединяются кабелем напрямую (not_connect_two_floor)", () => {
  const { m, wfc } = scenario();
  const wfi = addWarmFloor(m, { kind: "infrared", corner1: { x: 5500, y: 500 }, corner2: { x: 6500, y: 1500 } });
  assert.throws(
    () => addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: wfc.id }, { itemId: wfi.id }] }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("напрямую"),
  );
});

test("268: атомарность — отказ (контур уже подключён) не меняет модель (кабели, items, warm_floors)", () => {
  const { m, thermo, wfc } = scenario();
  const thermo2 = addItem(m, { name: "socket_thermo", position: { againstWall: { wallId: topWall(m), offsetMm: 3000 } }, catalogEntry: entry("socket_thermo") } as never);
  addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  const before = structuredClone({ cables: m.cables_warm_floor, items: m.items, wfs: m.warm_floors });
  assert.throws(() => addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo2.id }, { itemId: wfc.id }] }), McpError);
  assert.deepEqual(structuredClone({ cables: m.cables_warm_floor, items: m.items, wfs: m.warm_floors }), before);
});

test("268: wiring_delete снимает ссылку контура (props.cables_warm_floor), контур свободен для нового кабеля", () => {
  const { m, thermo, wfc } = scenario();
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  deleteElecCable(m, wire.id);
  assert.equal((m.cables_warm_floor ?? {})[wire.id], undefined);
  const props = wfc.props as unknown as Record<string, Record<string, unknown>>;
  assert.equal(props.cables_warm_floor, undefined);
  // повторное подключение возможно
  const wire2 = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  assert.equal((wfc.props as unknown as Record<string, Record<string, unknown>>).cables_warm_floor?.cable_warm_floor_id, wire2.id);
});

test("268: warm_floor_delete с подключённым кабелем — отказ (сначала wiring_delete); с магистралью — прежний отказ", () => {
  const { m, thermo, wfc } = scenario();
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  assert.throws(
    () => deleteWarmFloor(m, wfc.id),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("wiring_delete"),
  );
  deleteElecCable(m, wire.id);
  // после снятия кабеля — отказ только из-за… нет магистрали: удаление проходит
  deleteWarmFloor(m, wfc.id);
  assert.equal((m.warm_floors ?? {})[wfc.id], undefined);
});

test("268: warm_floor_update пересчитывает вершины-контуры кабелей (только затронутые привязки)", () => {
  const { m, thermo, thermoSubId, wfc } = scenario();
  const wfi = addWarmFloor(m, { kind: "infrared", corner1: { x: 5500, y: 500 }, corner2: { x: 6500, y: 1500 } });
  const thermo2 = addItem(m, { name: "socket_thermo", position: { againstWall: { wallId: topWall(m), offsetMm: 3000 } }, catalogEntry: entry("socket_thermo") } as never);
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  // другой кабель к ДРУГОМУ контуру — не затронут
  const wireIr = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo2.id }, { itemId: wfi.id }] });
  const beforeIr = structuredClone(wireIr);
  updateWarmFloor(m, { warmFloorId: wfc.id, corner1: { x: 700, y: 700 }, corner2: { x: 1700, y: 1700 } });
  const v = wire.vertexes.find((x) => x.id === wfc.id)!;
  assert.deepEqual(v.point, wfc.polygon[0]);
  assert.deepEqual(wireIr, beforeIr);
  void thermoSubId;
});

// ---------- коллекторные узлы как предметы ----------

test("268: коллекторные узлы — item_add against_wall с умолчаниями каталога (эталоны ui-ref-climate3-manifold-*)", () => {
  const fxNames: Record<string, string> = {
    radiator_collector: "ui-ref-climate3-manifold-radiator-collector.json",
    ext_manifold_box: "ui-ref-climate3-manifold-ext-box.json",
    int_manifold_box: "ui-ref-climate3-manifold-int-box.json",
  };
  for (const [name, file] of Object.entries(fxNames)) {
    const fx = JSON.parse(readFileSync(join(here, "../fixtures/", file), "utf8"));
    const ref = fx.model_object as Record<string, unknown>;
    assert.equal(ref["name"], name);
    // обратная сторона: item_add у стены даёт те же поля
    const m = baseModel();
    const item = addItem(m, { name, position: { againstWall: { wallId: topWall(m), offsetMm: 1000 } }, catalogEntry: entry(name) } as never);
    assert.equal(item.name, ref["name"]);
    assert.deepEqual(item.plan, ref["plan"]);
    assert.deepEqual(item.over_floor, ref["over_floor"]);
    assert.equal(item.width, ref["width"]);
    assert.equal(item.height, ref["height"]);
    assert.equal(item.self_height, ref["self_height"]);
    assert.deepEqual(item.dimensions, ref["dimensions"]);
    // anchor wall: свободная постановка отклоняется (как в редакторе)
    assert.throws(
      () => {
        const mm = baseModel();
        addItem(mm, { name, position: { center: { x: 2000, y: 1500 } }, catalogEntry: entry(name) } as never);
      },
      (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
    );
  }
});

test("268: коллекторный узел подключается к магистралям отопления и тёплого пола (multi — массив ссылок)", () => {
  const { m } = scenario();
  const wfw = addWarmFloor(m, { kind: "water", corner1: { x: 5500, y: 500 }, corner2: { x: 6500, y: 1500 } });
  const col = addItem(m, { name: "radiator_collector", position: { againstWall: { wallId: topWall(m), offsetMm: 2000 } }, catalogEntry: entry("radiator_collector") } as never);
  const p1 = addPipe(m, { kind: "heat_hot", path: [{ itemId: col.id }, { x: 3000, y: -100 }] });
  const p2 = addPipe(m, { kind: "warm_floor", path: [{ itemId: wfw.id }, { itemId: col.id }] });
  const box = (col as unknown as Record<string, Record<string, unknown>>).pipes_heat!;
  assert.deepEqual(box.heat_pipe_hot_id, [p1.id]);
  const boxWf = (col as unknown as Record<string, Record<string, unknown>>).pipes_warm_floor!;
  assert.deepEqual(boxWf.pipe_warm_floor_id, [p2.id]);
  // вершины: multi у коллектора, warm_floor у контура
  assert.equal(p1.vertexes[0]!.type, "multi");
  assert.equal(p2.vertexes[1]!.type, "collector");
  assert.equal(p2.vertexes[0]!.type, "warm_floor");
});

// ---------- держатели ссылок для сверок ----------

test("268: elecLinkHolders включает контуры тёплого пола (props + name = type контура)", () => {
  const { m, thermo, thermoSubId, wfc } = scenario();
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  const holders = elecLinkHolders(m);
  assert.equal((holders[wfc.id] as unknown as Record<string, Record<string, unknown>>).cables_warm_floor?.cable_warm_floor_id, wire.id);
  assert.equal(holders[wfc.id]!.name, wfc.type);
  // сверка подключений в обе стороны — пусто
  const colls: Partial<Record<ElecCableColl, Record<string, GasLineSig>>> = {
    cables_warm_floor: structuredClone((m.cables_warm_floor ?? {}) as Record<string, GasLineSig>),
  };
  assert.deepEqual(elecCableConnectionMismatches(colls, elecLinkHolders(m), colls, elecLinkHolders(m)), []);
  void thermoSubId;
});

test("268: сверка ловит потерю ссылки контура на кабель (SITE_ERROR-сценарий)", () => {
  const { m, thermo, wfc } = scenario();
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  const colls = (): Partial<Record<ElecCableColl, Record<string, GasLineSig>>> => ({
    cables_warm_floor: structuredClone((m.cables_warm_floor ?? {}) as Record<string, GasLineSig>),
  });
  // сервер стёр props.cables_warm_floor у контура
  delete (wfc.props as unknown as Record<string, Record<string, unknown>>).cables_warm_floor;
  const mis = elecCableConnectionMismatches(colls(), elecLinkHolders(m), colls(), elecLinkHolders(m), "cables_warm_floor");
  assert.ok(mis.some((x) => x.includes("потерял обратную ссылку") || x.includes(wire.id)), JSON.stringify(mis));
});

test("268: газовая сверка кабеля с вершиной-контуром — semantic graph без длины (pp отсутствует с обеих сторон)", () => {
  const { m, thermo, wfc } = scenario();
  addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  const exp = stripVertexIdRoom(structuredClone((m.cables_warm_floor ?? {}) as Record<string, GasLineSig>)) as Record<string, GasLineSig>;
  // нормализация редактора: pp у вершины-контура (производное) — не ломает сверку
  const norm = structuredClone(exp);
  for (const c of Object.values(norm)) {
    for (const v of c.vertexes ?? []) {
      if (v.type === "warm_floor") (v as Record<string, unknown>).pp = { [String(c.vertexes![0]!.id)]: { i: 0, d: 0.5 } };
    }
  }
  const mis = gasLineGraphMismatches(exp, norm, "кабель-проводка", false, undefined, { skipLength: true });
  assert.deepEqual(mis, []);
});

// ---------- компакт, метки ----------

test("268: компакт — кабель тёплого пола с вершиной-контуром читается (метка CW<n>, vertex_list)", () => {
  const { m, thermo, wfc } = scenario();
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  const compact = compactModel(m);
  const cw = compact.cables_warm_floor.find((c) => c.site_id === wire.id);
  assert.ok(cw, "кабель не найден в компактной модели");
  assert.equal(cw.type, "warm_floor_wire");
  const wfLabel = compact.warm_floors.find((w) => w.site_id === wfc.id);
  assert.ok(wfLabel, "контур не найден в компактной модели");
});

// ---------- mock save ----------

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

test("268: mock save — кабель тёплого пола с контуром сохраняется verified", async () => {
  const { m, thermo, wfc } = scenario();
  addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("268: mock save — сервер стёр props.cables_warm_floor.cable_warm_floor_id у контура → SITE_ERROR", async () => {
  const { m, thermo, wfc } = scenario();
  addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const wf = (s.model.warm_floors as Record<string, Record<string, unknown>>)[wfc.id]!;
    delete (wf.props as Record<string, Record<string, unknown>>).cables_warm_floor;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && (e as McpError).code === "SITE_ERROR");
});

test("268: mock save — нормализация потеряла кабель тёплого пола → NORMALIZATION_DROPPED", async () => {
  const { m, thermo, wfc } = scenario();
  addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wfc.id }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    delete norm.cables_warm_floor;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && (e as McpError).code === "NORMALIZATION_DROPPED");
});

test("268: ключ ссылки warm_floor_wire — cable_warm_floor_id (names_line_id_by_tool)", () => {
  assert.equal(elecLinkKey("cables_warm_floor", "warm_floor_wire"), "cable_warm_floor_id");
});
