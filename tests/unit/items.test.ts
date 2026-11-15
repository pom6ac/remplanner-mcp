import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addItem, updateItem, deleteItem, itemsList, roomPolygons } from "../../src/model/items.ts";
import { toToolEntry } from "../../src/catalog.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  // без стен, предметов и комнат: комнаты добавляет editorRooms (как вернул бы редактор)
  const clone = { ...structuredClone(model), walls: {}, items: {} };
  delete clone.rooms2;
  return clone;
}

/** Комнаты, как их вернул бы редактор (rooms2 по внутренним граням): (0,0)-(400,300), 12 м². */
function editorRooms(model: Model): void {
  model.rooms2 = {
    r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 },
  };
}

function rectModel(): { model: Model; top: string; right: string; bottom: string; left: string } {
  const model = emptyModel();
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  editorRooms(model);
  return { model, top: walls[0]!.id, right: walls[1]!.id, bottom: walls[2]!.id, left: walls[3]!.id };
}

test("roomPolygons: комнаты только из rooms2 (T27); без rooms2 их нет", () => {
  const { model } = rectModel();
  const rooms = roomPolygons(model);
  assert.equal(rooms.length, 1);
  const room = rooms[0]!;
  assert.equal(Math.round(room.areaCm2), 120000);
  const xs = room.polygon.map((p) => p.x);
  const ys = room.polygon.map((p) => p.y);
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.max(...xs), 400);
  assert.equal(Math.min(...ys), 0);
  assert.equal(Math.max(...ys), 300);
  // модель стен без rooms2 — комнат нет (их считает редактор)
  const bare = emptyModel();
  addRoomRect(bare, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  assert.equal(roomPolygons(bare).length, 0);
});

test("addItem: центр внутри комнаты", () => {
  const { model } = rectModel();
  const props = addItem(model, { name: "sofa_double", position: { center: { x: 2000, y: 1500 } }, widthMm: 1400, depthMm: 800 });
  assert.deepEqual(props.pc, { x: 200, y: 150 });
  assert.ok(Object.keys(model.items).length === 1);
});

test("addItem: диван у стены с gap_mm=0 касается внутренней грани", () => {
  const { model, bottom } = rectModel();
  // нижняя стена идёт (410,310)→(-10,310); внутренняя грань y=300
  const props = addItem(model, {
    name: "sofa_double",
    position: { againstWall: { wallId: bottom, offsetMm: 1000, gapMm: 0 } },
    widthMm: 1400,
    depthMm: 800,
  });
  assert.equal(props.id_wall, bottom);
  // центр: 1000 + 700 = 1700 мм от p2 назад → x = 410 - 170 = 240 см; y = 300 − 80/2 = 260 см
  assert.deepEqual(props.pc, { x: 240, y: 260 });
  // расстояние до внутренней грани = половина глубины
  assert.ok(Math.abs(props.pc.y + props.height / 2 - 300) < 0.01);
});

test("addItem: угол помещения (nw) с касанием граней", () => {
  const { model } = rectModel();
  const props = addItem(model, {
    name: "wardrobe",
    position: { inRoom: { corner: "nw" } },
    widthMm: 1000,
    depthMm: 800,
  });
  // внутренний угол (0,0), размеры 100x80 → центр (50,40)
  assert.deepEqual(props.pc, { x: 50, y: 40 });
});

test("addItem: точка вне комнат → OUTSIDE_ROOM", () => {
  const { model } = rectModel();
  assert.throws(
    () => addItem(model, { name: "sofa", position: { center: { x: 5000, y: 1500 } } }),
    (e: McpError) => e.code === "OUTSIDE_ROOM",
  );
});

test("addItem: без замкнутых комнат → GEOMETRY_CONFLICT no_rooms", () => {
  const model = emptyModel();
  assert.throws(
    () => addItem(model, { name: "sofa", position: { center: { x: 0, y: 0 } } }),
    (e: McpError) => e.code === "GEOMETRY_CONFLICT" && (e.toJSON().details as { kind: string }).kind === "no_rooms",
  );
});

test("addItem из каталога берёт размеры из записи", () => {
  const { model } = rectModel();
  const sofa = toToolEntry("sofa_double", { id: 92, title: "Диван двухместный", group: "furniture", width: 140, height: 80, self_height: 85, plan: { furniture: 6 } });
  const props = addItem(model, { name: "sofa_double", position: { center: { x: 2000, y: 1500 } }, catalogEntry: sofa });
  assert.equal(props.width, 140);
  assert.equal(props.height, 80);
  assert.equal(props.self_height, 85);
  assert.deepEqual(props.plan, { furniture: 6 });
});

test("updateItem: перенос и размеры", () => {
  const { model } = rectModel();
  const props = addItem(model, { name: "sofa", position: { center: { x: 2000, y: 1500 } } });
  updateItem(model, { itemId: props.id, center: { x: 2500, y: 1200 }, angleDeg: 90, widthMm: 900 });
  assert.deepEqual(props.pc, { x: 250, y: 120 });
  assert.equal(props.angle, 90);
  assert.equal(props.width, 90);
});

test("updateItem: перенос вне комнат → OUTSIDE_ROOM", () => {
  const { model } = rectModel();
  const props = addItem(model, { name: "sofa", position: { center: { x: 2000, y: 1500 } } });
  assert.throws(
    () => updateItem(model, { itemId: props.id, center: { x: -1000, y: 0 } }),
    (e: McpError) => e.code === "OUTSIDE_ROOM",
  );
});

test("deleteItem удаляет предмет", () => {
  const { model } = rectModel();
  const props = addItem(model, { name: "sofa", position: { center: { x: 2000, y: 1500 } } });
  deleteItem(model, props.id);
  assert.equal(Object.keys(model.items).length, 0);
  assert.throws(() => deleteItem(model, props.id), (e: McpError) => e.code === "NOT_FOUND");
});

test("itemsList: фильтр по комнате-точке", () => {
  const { model } = rectModel();
  addItem(model, { name: "sofa", position: { center: { x: 2000, y: 1500 } } });
  const list = itemsList(model, { x: 200, y: 150 });
  assert.equal(list.length, 1);
  assert.equal(itemsList(model, { x: 5000, y: 5000 }).length, 0);
});
