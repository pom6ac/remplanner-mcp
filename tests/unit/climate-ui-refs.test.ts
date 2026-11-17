// Этап 122 «Тёплый пол, кондиционеры, вентиляция»: контуры model.warm_floors,
// климат-предметы (терморегулятор, кондиционеры, радиатор, вентилятор) и трубы климата
// (pipes_warm_floor/pipes_conditioner/pipes_heat/pipes_ventilation). Эталоны UI в обе
// стороны, атомарность, update/delete, реестр коллекций, mock save (подмена
// writeBackup/loadModel/openEditor — new-entity-section.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps, Pipe, WarmFloor } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addItem, deleteItem } from "../../src/model/items.ts";
import { addPipe, updatePipe, deletePipe, findPipe, addGasLine, gasLineLengthM, PIPE_TYPE_BY_KIND, PIPE_COLLECTIONS } from "../../src/model/pipes.ts";
import { addWarmFloor, updateWarmFloor, deleteWarmFloor, warmFloorMismatches, warmFloorLengthM, warmFloorAreaM2 } from "../../src/model/climate.ts";
import { compactModel } from "../../src/model/compact.ts";
import { clearEntityCollections, replaceEntityCollections, MODEL_ENTITY_COLLECTIONS } from "../../src/model/collections.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {} };
}

function baseModel(): Model {
  const model = emptyModel();
  addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  model.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return model;
}

function climateEntry(name: string, over: Record<string, unknown> | null): ItemProps extends never ? never : Parameters<typeof addItem>[1]["catalogEntry"] {
  const sizes: Record<string, { w: number; h: number; sh: number; group: string }> = {
    conditioner: { w: 75, h: 25, sh: 0, group: "furniture" },
    conditioner_engine: { w: 60, h: 25, sh: 40, group: "furniture" },
    floor_conditioner: { w: 27, h: 48, sh: 0, group: "furniture" },
    air_curtain: { w: 77, h: 13, sh: 0, group: "furniture" },
    radiator_bimetal: { w: 70, h: 12, sh: 56, group: "furniture" },
    fan: { w: 20, h: 20, sh: 0, group: "furniture" },
    socket_thermo: { w: 14, h: 14, sh: 0, group: "sockets" },
  };
  const s = sizes[name]!;
  const plans: Record<string, Record<string, number>> = {
    conditioner: { conditioners: 12 }, conditioner_engine: { conditioners: 12 },
    floor_conditioner: { conditioners: 12 }, air_curtain: { conditioners: 12 },
    radiator_bimetal: { radiators: 26 }, fan: { ventilation: 32 }, socket_thermo: { warm_floor: 11 },
  };
  return { id: 0, name, title: name, group: s.group, width: s.w, height: s.h, self_height: s.sh, plan: plans[name]!, ...(over ? { over_floor: over as never } : {}) } as never;
}

// ---------- эталоны климат-предметов (UI, обе стороны) ----------

test("122: эталон ui-ref-climate-conditioner — item_add у стены воспроизводит семантику (обе стороны)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-climate-conditioner.json"), "utf8"));
  const m = fx.model_object as Record<string, unknown>;
  assert.equal(m["name"], "conditioner");
  assert.equal(m["width"], 75);
  assert.equal(m["height"], 25);
  assert.deepEqual(m["plan"], { conditioners: 12 });
  assert.deepEqual(m["over_floor"], { value: 210, display: false });
  assert.equal(m["angle"], 180);
  // обратная сторона: item_add у стены даёт те же поля
  const model = baseModel();
  const wallId = Object.keys(model.walls)[0]!;
  const item = addItem(model, {
    name: "conditioner",
    position: { againstWall: { wallId, offsetMm: 1000 } },
    catalogEntry: climateEntry("conditioner", { value: 210, display: false }),
  });
  assert.equal(item.name, m["name"]);
  assert.deepEqual(item.plan, m["plan"]);
  assert.deepEqual(item.over_floor, m["over_floor"]);
  assert.equal(item.width, m["width"]);
  assert.equal(item.height, m["height"]);
});

test("122: эталон ui-ref-climate-conditioner_engine — dimensions {display:0, default_value_set:1}, self_height 40", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-climate-conditioner_engine.json"), "utf8"));
  const m = fx.model_object as Record<string, unknown>;
  assert.equal(m["name"], "conditioner_engine");
  assert.equal(m["self_height"], 40);
  assert.deepEqual(m["dimensions"], { display: 0, default_value_set: 1 });
  assert.deepEqual(m["over_floor"], { value: 20, display: false });
  const model = baseModel();
  const item = addItem(model, {
    name: "conditioner_engine",
    position: { center: { x: 2000, y: 1500 } },
    catalogEntry: climateEntry("conditioner_engine", { value: 20, display: false }),
  });
  assert.deepEqual(item.dimensions, { display: 0, default_value_set: 1 });
  assert.deepEqual(item.over_floor, { value: 20, display: false });
});

test("122: эталон ui-ref-climate-thermo-socket_thermo — терморегулятор пишется группой socket_group с планом warm_floor", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-climate-thermo-socket_thermo.json"), "utf8"));
  const m = fx.model_object as Record<string, unknown>;
  assert.equal(m["name"], "socket_group");
  assert.deepEqual(m["plan"], { warm_floor: 11 });
  assert.deepEqual(m["over_floor"], { value: 90, display: true, vd: 90 });
  const subs = m["socket_group"] as Array<{ name: string }>;
  assert.equal(subs.length, 1);
  assert.equal(subs[0]!.name, "socket_thermo");
  // обратная сторона: item_add группы sockets у стены
  const model = baseModel();
  const wallId = Object.keys(model.walls)[0]!;
  const item = addItem(model, {
    name: "socket_thermo",
    position: { againstWall: { wallId, offsetMm: 800 } },
    catalogEntry: climateEntry("socket_thermo", { value: 90, display: true }),
  });
  assert.equal(item.name, "socket_group");
  assert.deepEqual(item.plan, { warm_floor: 11 });
  assert.deepEqual(item.over_floor, { value: 90, display: true, vd: 90 });
  assert.equal((item.socket_group as Array<{ name: string }>)[0]!.name, "socket_thermo");
});

test("122: эталоны floor_conditioner/air_curtain/radiator_bimetal/fan — item_add воспроизводит умолчания каталога", () => {
  const cases: [string, { dims: unknown; over?: Record<string, unknown> }][] = [
    ["floor_conditioner", { dims: { display: 0, default_value_set: 1 }, over: undefined }],
    ["air_curtain", { dims: { display: true }, over: { value: 250, display: false } }],
    ["radiator_bimetal", { dims: { display: true }, over: { value: 10, display: false } }],
    ["fan", { dims: { display: true }, over: undefined }],
  ];
  for (const [name, exp] of cases) {
    const fx = JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-climate-${name}.json`), "utf8"));
    const m = fx.model_object as Record<string, unknown>;
    assert.equal(m["name"], name, name);
    const model = baseModel();
    const item = addItem(model, {
      name,
      position: { center: { x: 1500, y: 1500 } },
      catalogEntry: climateEntry(name, exp.over as never),
    });
    assert.equal(item.name, m["name"]);
    assert.deepEqual(item.over_floor, m["over_floor"] ?? null);
    assert.deepEqual(item.dimensions, m["dimensions"]);
    assert.equal(item.width, m["width"]);
    assert.equal(item.height, m["height"]);
  }
});

test("122: item_add отвергает сущности-графы климата — подсказка нужного инструмента", () => {
  const cases: [string, string][] = [
    ["warm_floor", "warm_floor_add"],
    ["warm_floor_ir", "warm_floor_add"],
    ["warm_floor_water", "warm_floor_add"],
    ["warm_floor_pipe", "pipe_add"],
    ["conditioner_drainage", "pipe_add"],
    ["heat_pipe_hot", "pipe_add"],
    ["heat_pipe_cold", "pipe_add"],
    ["ventpipe_out", "pipe_add"],
    ["ventpipe_in", "pipe_add"],
    ["warm_floor_wire", "pipe_add"],
    ["conditioner_wire", "pipe_add"],
  ];
  for (const [name, hint] of cases) {
    const model = baseModel();
    assert.throws(
      () => addItem(model, { name, position: { center: { x: 1000, y: 1000 } }, catalogEntry: { id: 0, name, title: name, group: "furniture", width: 0, height: 0, self_height: 0, plan: { warm_floor: 11 } } }),
      (e: unknown) => e instanceof McpError && (e as McpError).message.includes(hint),
      name,
    );
    assert.equal(Object.keys(model.items).length, 0, "модель не изменилась");
  }
});

// ---------- тёплый пол: add/update/delete ----------

test("122: warm_floor_add — прямоугольный контур, кольцо матрицы, периметр, площадь, id_room", () => {
  const model = baseModel();
  const wf = addWarmFloor(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
  assert.equal(Object.keys(model.warm_floors!).length, 1);
  assert.equal(wf.type, "warm_floor");
  assert.equal(wf.id_room, "r1");
  assert.deepEqual(wf.polygon, [{ x: 50, y: 50 }, { x: 300, y: 50 }, { x: 300, y: 200 }, { x: 50, y: 200 }]);
  assert.deepEqual(wf.matrix[0]![1], { length: 1 });
  assert.deepEqual(wf.matrix[3]![0], { length: 1 });
  assert.equal(wf.matrix[0]![2], null);
  assert.equal(wf.vertexes.length, 4);
  assert.deepEqual(wf.items, Object.fromEntries(wf.vertexes.map((v) => [v.id, "node"])));
  assert.equal(wf.length, warmFloorLengthM(wf.polygon));
  assert.equal(wf.length, 8);
  assert.equal(wf.area, warmFloorAreaM2(wf.polygon));
  assert.equal(wf.area, 3.75);
  assert.deepEqual(wf.props, { id: wf.id, name: "warm_floor" });
  // шаг/длины трубы у кабельного нет
  assert.equal(wf.step, undefined);
});

test("122: warm_floor_add water — умолчания водяного контура (эталон 122-dev-wf-water-pipe)", () => {
  const model = baseModel();
  const wf = addWarmFloor(model, { kind: "water", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
  assert.equal(wf.type, "warm_floor_water");
  assert.equal(wf.step, 10);
  assert.equal(wf.type_water, "spiral");
  assert.equal(wf.direction, "right");
  // проходов floor(150/10)=15 × длина 250 см = 37.5 м
  assert.equal(wf.length_pipes, 37.5);
});

test("122: warm_floor_add — атомарность: контур вне комнаты, вырожденный прямоугольник, занятая комната", () => {
  const model = baseModel();
  const before = JSON.stringify(model);
  assert.throws(() => addWarmFloor(model, { kind: "cable", corner1: { x: -500, y: 500 }, corner2: { x: 3000, y: 2000 } }),
    (e: unknown) => e instanceof McpError && e.code === "OUTSIDE_ROOM");
  assert.throws(() => addWarmFloor(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 500, y: 2000 } }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  const wf = addWarmFloor(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
  assert.throws(() => addWarmFloor(model, { kind: "water", corner1: { x: 600, y: 600 }, corner2: { x: 2900, y: 1900 } }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && (e as McpError).message.includes(wf.id));
  assert.equal(JSON.stringify(model.warm_floors), JSON.stringify({ [wf.id]: wf }));
});

test("122: warm_floor_update — новые углы, свойства водяного сохраняются; delete", () => {
  const model = baseModel();
  const wf = addWarmFloor(model, { kind: "water", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
  const upd = updateWarmFloor(model, { warmFloorId: wf.id, corner1: { x: 600, y: 600 }, corner2: { x: 2900, y: 1900 } });
  assert.deepEqual(upd.polygon[0], { x: 60, y: 60 });
  assert.deepEqual(upd.polygon[2], { x: 290, y: 190 });
  assert.equal(upd.length, 7.2);
  assert.equal(upd.step, 10);
  assert.equal(upd.type_water, "spiral");
  assert.equal(upd.length_pipes, 29.9);
  assert.throws(() => updateWarmFloor(model, { warmFloorId: "nope", corner1: { x: 0, y: 0 } }),
    (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
  assert.throws(() => updateWarmFloor(model, { warmFloorId: wf.id, corner1: { x: -500, y: 500 }, corner2: { x: 2900, y: 1900 } }),
    (e: unknown) => e instanceof McpError && e.code === "OUTSIDE_ROOM");
  deleteWarmFloor(model, wf.id);
  assert.equal(Object.keys(model.warm_floors ?? {}).length, 0);
  assert.throws(() => deleteWarmFloor(model, wf.id), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
});

test("122: warmFloorMismatches — потеря, сдвиг polygon, порча кольца, лишний контур", () => {
  const model = baseModel();
  const wf = addWarmFloor(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
  assert.deepEqual(warmFloorMismatches({ [wf.id]: structuredClone(wf) }, structuredClone(model.warm_floors!)), []);
  const got = structuredClone(model.warm_floors) as Record<string, WarmFloor>;
  got[wf.id]!.polygon[1]!.x += 5;
  assert.ok(warmFloorMismatches({ [wf.id]: wf }, got).some((s) => s.includes("polygon")));
  const got2 = structuredClone(model.warm_floors) as Record<string, WarmFloor>;
  got2[wf.id]!.area = 9.99;
  assert.ok(warmFloorMismatches({ [wf.id]: wf }, got2).some((s) => s.includes("площад")));
  const got3 = structuredClone(model.warm_floors) as Record<string, WarmFloor>;
  got3[wf.id]!.matrix[0]![1] = null;
  assert.ok(warmFloorMismatches({ [wf.id]: wf }, got3).some((s) => s.includes("ребро")));
  const extra = warmFloorMismatches({ [wf.id]: wf }, { ...structuredClone(model.warm_floors), extra: structuredClone(wf) });
  assert.ok(extra.some((s) => s.includes("лишний")));
});

// ---------- трубы климата: add/update/delete по коллекциям ----------

test("122: pipe_add климата — каждый вид пишет в свою коллекцию; длина по рёбрам; у воздуховодов spots {}", () => {
  const cases: [kind: string, coll: string][] = [
    ["warm_floor", "pipes_warm_floor"],
    ["conditioner_drainage", "pipes_conditioner"],
    ["heat_hot", "pipes_heat"],
    ["heat_cold", "pipes_heat"],
    ["vent_out", "pipes_ventilation"],
    ["vent_in", "pipes_ventilation"],
  ];
  for (const [kind, coll] of cases) {
    const model = baseModel();
    const pipe = addPipe(model, { kind: kind as never, path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] });
    assert.equal(pipe.type, { warm_floor: "warm_floor_pipe", conditioner_drainage: "conditioner_drainage", heat_hot: "heat_pipe_hot", heat_cold: "heat_pipe_cold", vent_out: "ventpipe_out", vent_in: "ventpipe_in" }[kind]);
    assert.equal(Object.keys((model as unknown as Record<string, Record<string, Pipe>>)[coll]!).length, 1, coll);
    assert.equal(pipe.length, 1);
    if (coll === "pipes_ventilation") assert.deepEqual(pipe.spots, {});
    else assert.equal(pipe.spots, undefined);
    // подключение предмета к климат-трубе отклоняется (следующий PR)
    const spot = addItem(model, { name: "waterspot_cold", position: { center: { x: 500, y: 1000 } }, catalogEntry: { id: 0, name: "waterspot_cold", title: "s", group: "waterspots", width: 16, height: 9, self_height: 0, plan: { water: 27 } } });
    assert.throws(() => addPipe(model, { kind: kind as never, path: [{ itemId: spot.id }, { x: 2000, y: 1000 }] }),
      (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
    // update/delete по всем коллекциям
    const upd = updatePipe(model, { pipeId: pipe.id, positions: [{ vertex: 1, x: 2500, y: 500 }] });
    assert.equal(upd.length, 2);
    deletePipe(model, pipe.id);
    assert.equal(findPipe(model, pipe.id), null);
    assert.equal(Object.keys((model as unknown as Record<string, Record<string, Pipe>>)[coll]!).length, 0);
  }
});

test("122: атомарность pipe_add климата — неизвестный вид/NOT_FOUND модель не меняют", () => {
  const model = baseModel();
  const before = JSON.stringify(model);
  assert.throws(() => addPipe(model, { kind: "nope" as never, path: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.throws(() => addPipe(model, { kind: "vent_out", path: [{ itemId: "nope" }, { x: 100, y: 100 }] }),
    (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
  assert.equal(JSON.stringify(model), before);
});

// ---------- реестр коллекций (clear/import) ----------

test("122: реестр коллекций покрывает тёплый пол и трубы климата — clear удаляет, import заменяет", () => {
  const model = baseModel();
  addWarmFloor(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
  addPipe(model, { kind: "vent_out", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] });
  addPipe(model, { kind: "heat_hot", path: [{ x: 500, y: 700 }, { x: 1500, y: 700 }] });
  for (const coll of ["warm_floors", "pipes_warm_floor", "pipes_conditioner", "pipes_heat", "pipes_ventilation"]) {
    assert.ok(MODEL_ENTITY_COLLECTIONS.includes(coll as never), coll);
  }
  clearEntityCollections(model);
  assert.equal(model.warm_floors, undefined);
  assert.equal(model.pipes_ventilation, undefined);
  assert.equal(model.pipes_heat, undefined);
  // import: источник с сущностями климата переносится целиком
  const target = baseModel();
  const src = baseModel();
  addWarmFloor(src, { kind: "infrared", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
  addPipe(src, { kind: "conditioner_drainage", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] });
  replaceEntityCollections(target, src);
  assert.equal(Object.keys(target.warm_floors ?? {}).length, 1);
  assert.equal(Object.keys(target.pipes_conditioner ?? {}).length, 1);
  assert.equal(target.pipes_heat, undefined);
});

// ---------- компактный API ----------

test("122: компактный API — метки WF/PW/PC/PH/PV, мм, площади и длины", () => {
  const model = baseModel();
  const wf = addWarmFloor(model, { kind: "water", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
  const pw = addPipe(model, { kind: "warm_floor", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] });
  const pv = addPipe(model, { kind: "vent_out", path: [{ x: 500, y: 700 }, { x: 1500, y: 700 }] });
  const c = compactModel(model);
  assert.equal(c.warm_floors.length, 1);
  const wfc = c.warm_floors[0]!;
  assert.equal(wfc.id, "WF1");
  assert.equal(wfc.site_id, wf.id);
  assert.equal(wfc.type, "warm_floor_water");
  assert.equal(wfc.width_mm, 2500);
  assert.equal(wfc.depth_mm, 1500);
  assert.equal(wfc.perimeter_mm, 8000);
  assert.equal(wfc.step_mm, 100);
  assert.equal(wfc.length_pipes_mm, 37500);
  assert.equal(wfc.room, "r1");
  assert.equal(c.pipes_warm_floor[0]!.id, "PW1");
  assert.equal(c.pipes_warm_floor[0]!.site_id, pw.id);
  assert.equal(c.pipes_warm_floor[0]!.length_mm, 1000);
  assert.equal(c.pipes_ventilation[0]!.id, "PV1");
  assert.equal(c.pipes_ventilation[0]!.site_id, pv.id);
});

// ---------- mock save (подмена writeBackup/loadModel/openEditor) ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

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
  // R6 (ревью 123): подменяется сам метод writeBackup — подмена в deps не работает,
  // Workspace.save вызывает this.writeBackup()
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/tmp/mock-not-written";
  return ws;
}

function climateScenario(): { model: Model; wf: WarmFloor; pipe: Pipe } {
  const model = baseModel();
  const wf = addWarmFloor(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
  const pipe = addPipe(model, { kind: "vent_out", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] });
  return { model, wf, pipe };
}

test("122: mock save — verified с контуром тёплого пола и трубой климата", async () => {
  const { model } = climateScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("122: mock save — редактор потерял контур тёплого пола при нормализации → NORMALIZATION_DROPPED", async () => {
  const { model, wf } = climateScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    delete (m as { warm_floors?: Record<string, WarmFloor> }).warm_floors![wf.id];
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED");
  assert.equal(saves, 0, "до записи дело не дошло");
});

test("122: mock save — сервер испортил polygon/площадь контура → SITE_ERROR; испортил трубу климата → SITE_ERROR", async () => {
  const { model, wf, pipe } = climateScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    (s.model as { warm_floors?: Record<string, WarmFloor> }).warm_floors![wf.id]!.polygon[1]!.x += 50;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    assert.ok(JSON.stringify((e as McpError).details).includes("climate_mismatches"));
    return true;
  });
  const server2: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws2 = saveMock(server2, (s) => {
    const got = (s.model as { pipes_ventilation?: Record<string, Pipe> }).pipes_ventilation![pipe.id]!;
    got.matrix[0]![1] = null;
  });
  await ws2.open("0", "1");
  await assert.rejects(ws2.save(), (e: unknown) => e instanceof McpError && e.code === "SITE_ERROR");
});

test("122: mock save — редактор сдвинул узел трубы климата на 1 см (допуск) — не ложная блокировка", async () => {
  const { model, pipe } = climateScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (m) => {
    const got = (m as { pipes_ventilation?: Record<string, Pipe> }).pipes_ventilation![pipe.id]!;
    got.vertexes[1]!.point = { x: got.vertexes[1]!.point.x + 0.09, y: got.vertexes[1]!.point.y };
    got.length = 1.0;
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("122: mock save — сервер потерял трубу климата целиком → SITE_ERROR (множество в обе стороны)", async () => {
  const { model, pipe } = climateScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    delete (s.model as { pipes_ventilation?: Record<string, Pipe> }).pipes_ventilation![pipe.id];
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError && e.code === "SITE_ERROR");
    assert.ok(JSON.stringify((e as McpError).details).includes("pipes_ventilation"));
    return true;
  });
});

void addGasLine;
void gasLineLengthM;
void deleteItem;
void PIPE_COLLECTIONS;
void replaceEntityCollections;
