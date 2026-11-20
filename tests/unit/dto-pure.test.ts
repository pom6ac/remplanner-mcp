// Юнит-тесты чистых функций src/dto (ревью 188 №3 и №4): снапшот покрывает только
// ответы чтения, а преобразования входа (позиции, аргументы opening_add/update,
// разрешение меток, дефолты материалов) раньше не были покрыты — мутации
// I2, I9–I11, O1, O3–O6 и таблица структур выживали. Кейсы фиксированные,
// без сравнения со старым инлайн-кодом (эквивалентность доказана ревьюером).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWall, resolveWallMaterial } from "../../src/dto/walls.ts";
import { resolveBorder, borderResponse } from "../../src/dto/borders.ts";
import {
  resolveItem, catalogFoundView, catalogEntryView,
  normalizePosition, againstWallCenter, itemsInRoom,
} from "../../src/dto/items.ts";
import { resolveOpeningWall, openingAddArgs, openingUpdateParams } from "../../src/dto/openings.ts";
import {
  resolvePillar, resolveRigel, resolveGasLine, resolvePipe,
  resolveWarmFloor, resolveLightLine, resolveFloorHole,
} from "../../src/dto/structures.ts";
import { McpError } from "../../src/errors.ts";
import { addItem } from "../../src/model/items.ts";
import type { Model, Wall, ItemProps } from "../../src/model/types.ts";
import type { RoomPolygon } from "../../src/model/items.ts";

// ---------- фикстуры ----------

const here = dirname(fileURLToPath(import.meta.url));

function wall(id: string, x1: number, y1: number, x2: number, y2: number): Wall {
  return { id, plan: "a", role: "wall", depth: 20, height: 270, p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, material: "a_block", holes: {} };
}

function item(id: string, x: number, y: number): ItemProps {
  return { id, name: id, pc: { x, y }, angle: 0, width: 80, height: 180, plan: {} };
}

function model(over: Partial<Model> = {}): Model {
  return { v: 0, id: "model", plan_id: "plan", walls: {}, items: {}, pillars: {}, total_height: 300, final: false, ...over };
}

const pipe = (id: string) => ({ id, matrix: [], vertexes: [], items: {}, type: "water_pipe", length: 1 });
const entity = (id: string) => ({ id });

// комната 400×300 см со смещением: (100,200)–(500,500) см → в мм 1000..5000, 2000..5000
const room: RoomPolygon = {
  roomId: "room1",
  polygon: [{ x: 100, y: 200 }, { x: 500, y: 200 }, { x: 500, y: 500 }, { x: 100, y: 500 }],
  areaCm2: 160_000,
  axisAreaCm2: null,
};

function expectNotFound(fn: () => unknown, fragment: string): void {
  assert.throws(fn, (e: unknown) => e instanceof Error && (e as { code?: string }).code === "NOT_FOUND" && e.message.includes(fragment));
}

// ---------- walls ----------

test("resolveWall: по id сайта, по метке W<n> (индекс с 1) и NOT_FOUND", () => {
  const w1 = wall("site-a", 0, 0, 100, 0);
  const w2 = wall("site-b", 100, 0, 100, 100);
  const m = model({ walls: { "site-a": w1, "site-b": w2 } });
  assert.equal(resolveWall(m, "site-b"), w2);
  assert.equal(resolveWall(m, "W1"), w1);
  assert.equal(resolveWall(m, "W2"), w2);
  expectNotFound(() => resolveWall(m, "W3"), "стена W3 не найдена");
});

test("resolveWallMaterial: дефолты pgb (partition) и a_block (initial), отказ c_* у initial, PRO-флаг", () => {
  assert.deepEqual(resolveWallMaterial("partition", undefined), { plan: "c", material: "c_pgb", pro: false });
  assert.deepEqual(resolveWallMaterial("partition", "brick"), { plan: "c", material: "c_brick", pro: false });
  assert.deepEqual(resolveWallMaterial("partition", "glass"), { plan: "c", material: "c_glass", pro: true });
  assert.deepEqual(resolveWallMaterial("initial", undefined), { plan: "a", material: "a_block", pro: false });
  assert.deepEqual(resolveWallMaterial(undefined, "a_brick"), { plan: "a", material: "a_brick", pro: false });
  assert.throws(() => resolveWallMaterial("initial", "c_glass"), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
});

// ---------- borders ----------

test("resolveBorder: метки TB<n>/XB<n> (индекс с 1), borderResponse в мм", () => {
  const t1 = { id: "tb1", p1: { x: 1, y: 2 }, p2: { x: 3, y: 4 } };
  const t2 = { id: "tb2", p1: { x: 5, y: 6 }, p2: { x: 7, y: 8 } };
  const m = model({ terrace_borders: { tb1: t1, tb2: t2 } });
  assert.equal(resolveBorder(m, "terrace_borders", "TB", "TB1"), t1);
  assert.equal(resolveBorder(m, "terrace_borders", "TB", "TB2"), t2);
  assert.equal(resolveBorder(m, "terrace_borders", "TB", "tb1"), t1);
  expectNotFound(() => resolveBorder(m, "terrace_borders", "TB", "TB3"), "граница TB3 не найдена");
  assert.deepEqual(borderResponse(t1), { id: "tb1", p1: { x: 10, y: 20 }, p2: { x: 30, y: 40 } });
});

// ---------- structures: разрешение меток ----------

test("resolvePillar/resolveRigel/resolveGasLine/resolveWarmFloor/resolveFloorHole: метки и NOT_FOUND", () => {
  const p1 = { id: "pill1" } as never, p2 = { id: "pill2" } as never;
  const m = model({
    pillars: { pill1: p1, pill2: p2 },
    rigels: { rig1: { id: "rig1" } as never, rig2: { id: "rig2" } as never },
    pipes_gas: { gas1: { id: "gas1" } as never, gas2: { id: "gas2" } as never },
    warm_floors: { wf1: { id: "wf1" } as never, wf2: { id: "wf2" } as never },
    level_holes: { fh1: { id: "fh1" } as never, fh2: { id: "fh2" } as never },
  });
  assert.equal(resolvePillar(m, "P1"), p1);
  assert.equal(resolvePillar(m, "P2"), p2);
  assert.equal(resolveRigel(m, "B1").id, "rig1");
  assert.equal(resolveRigel(m, "B2").id, "rig2");
  assert.equal(resolveGasLine(m, "G1").id, "gas1");
  assert.equal(resolveGasLine(m, "G2").id, "gas2");
  assert.equal(resolveWarmFloor(m, "WF1").id, "wf1");
  assert.equal(resolveWarmFloor(m, "WF2").id, "wf2");
  assert.equal(resolveFloorHole(m, "FH1").id, "fh1");
  assert.equal(resolveFloorHole(m, "FH2").id, "fh2");
  expectNotFound(() => resolvePillar(m, "P3"), "колонна P3 не найдена");
  expectNotFound(() => resolveRigel(m, "B3"), "ригель B3 не найден");
  expectNotFound(() => resolveGasLine(m, "G3"), "газовая линия G3 не найдена");
  expectNotFound(() => resolveWarmFloor(m, "WF3"), "контур тёплого пола WF3 не найден");
  expectNotFound(() => resolveFloorHole(m, "FH3"), "проём в полу FH3 не найден");
});

test("resolvePipe: метки TP/PW/PC/PH/PV ведут в свои коллекции, site-id через findPipe", () => {
  const m = model({
    pipes: { tp: pipe("tp") },
    pipes_warm_floor: { pw: pipe("pw") },
    pipes_conditioner: { pc: pipe("pc") },
    pipes_heat: { ph: pipe("ph") },
    pipes_ventilation: { pv: pipe("pv") },
  });
  const byId = (ref: string): string => resolvePipe(m, ref).id;
  assert.equal(byId("tp"), "tp");
  assert.equal(byId("pw"), "pw");
  assert.equal(byId("pc"), "pc");
  assert.equal(byId("ph"), "ph");
  assert.equal(byId("pv"), "pv");
  const collOf = (ref: string): string => resolvePipe(m, ref).coll;
  assert.equal(collOf("TP1"), "pipes");
  assert.equal(collOf("PW1"), "pipes_warm_floor");
  assert.equal(collOf("PC1"), "pipes_conditioner");
  assert.equal(collOf("PH1"), "pipes_heat");
  assert.equal(collOf("PV1"), "pipes_ventilation");
  expectNotFound(() => resolvePipe(m, "PW9"), "труба PW9 не найдена");
});

test("resolveLightLine: метка зависит от вида (LS/SL/LL), NOT_FOUND", () => {
  const m = model({
    led_strips: { led1: { id: "led1" } as never },
    stripes_light: { strip1: { id: "strip1" } as never },
    line_strips: { line1: { id: "line1" } as never },
  });
  assert.equal(resolveLightLine(m, "led", "LS1").id, "led1");
  assert.equal(resolveLightLine(m, "recessed", "SL1").id, "strip1");
  assert.equal(resolveLightLine(m, "line", "LL1").id, "line1");
  expectNotFound(() => resolveLightLine(m, "line", "LL2"), "световая линия LL2 не найдена");
});

// ---------- openings ----------

test("resolveOpeningWall: ищет стену с проёмом; NOT_FOUND с сообщением", () => {
  const w = wall("site-a", 0, 0, 100, 0);
  w.holes = { hole1: { id: "hole1", plan: "a", type: "door", group: "doors", pc: { x: 50, y: 0 }, width: 80, depth: 10 } };
  const m = model({ walls: { "site-a": w } });
  assert.equal(resolveOpeningWall(m, "hole1"), "site-a");
  expectNotFound(() => resolveOpeningWall(m, "hole2"), "проём hole2 не найден ни на одной стене");
});

const openingArgs = {
  type: "door",
  offset_mm: 500, from: "end", center_mm: 700, width_mm: 800, height_mm: 2100,
  sill_height_mm: 10, swing: { hinge: "start", into: "left" }, casing: true, casements: 2,
  slope_angle_deg: 30, sill_thickness_mm: 20, sill_overhang_mm: 50, sill_overmeasure_mm: 5,
  window_width_mm: 1400, window_height_mm: 1500, door_width_mm: 800, door_height_mm: 2000,
  door_position: "left", impost_height_mm: 300, replaces: "hole-old",
};

test("openingAddArgs: все поля snake→camel, включая sill/impost/replaces", () => {
  assert.deepEqual(openingAddArgs("wall-a", openingArgs), {
    wallId: "wall-a",
    type: "door",
    offsetMm: 500, from: "end", centerMm: 700, widthMm: 800, heightMm: 2100,
    sillHeightMm: 10,
    swing: { hinge: "start", into: "left" },
    casing: true, casements: 2,
    slopeAngleDeg: 30, sillThicknessMm: 20, sillOverhangMm: 50, sillOvermeasureMm: 5,
    windowWidthMm: 1400, windowHeightMm: 1500, doorWidthMm: 800, doorHeightMm: 2000,
    doorPosition: "left", impostHeightMm: 300, replacesHoleId: "hole-old",
  });
  // не переданные поля — undefined, wallId — единственный источник стены
  const partial = openingAddArgs("wall-b", { type: "window" });
  assert.equal(partial.wallId, "wall-b");
  assert.equal(partial.offsetMm, undefined);
  assert.equal(partial.replacesHoleId, undefined);
  assert.equal(partial.impostHeightMm, undefined);
});

test("openingUpdateParams: те же поля + holeId, без replaces", () => {
  const r = openingUpdateParams("wall-a", "hole-1", openingArgs);
  assert.deepEqual(r, {
    wallId: "wall-a",
    holeId: "hole-1",
    type: "door",
    offsetMm: 500, from: "end", centerMm: 700, widthMm: 800, heightMm: 2100,
    sillHeightMm: 10,
    swing: { hinge: "start", into: "left" },
    casing: true, casements: 2,
    slopeAngleDeg: 30, sillThicknessMm: 20, sillOverhangMm: 50, sillOvermeasureMm: 5,
    windowWidthMm: 1400, windowHeightMm: 1500, doorWidthMm: 800, doorHeightMm: 2000,
    doorPosition: "left", impostHeightMm: 300,
  });
});

// ---------- items: каталог ----------

test("catalogFoundView: см каталога → мм, resizable по умолчанию false", () => {
  assert.deepEqual(catalogFoundView({ name: "sofa", title: "Диван", group: "g", width: 80, height: 180, self_height: 70 }), {
    name: "sofa", title: "Диван", group: "g",
    width_mm: 800, depth_mm: 1800, height_mm: 700, resizable: false,
  });
  assert.equal(catalogFoundView({ name: "t", title: "T", group: "g", width: 1, height: 2, self_height: 3, resizable: true }).resizable, true);
});

test("catalogEntryView: см → мм, дефолты subgroup/anchor/magnetized/can_be_outside", () => {
  assert.deepEqual(catalogEntryView({ name: "s", title: "S", group: "g", width: 40, height: 90, self_height: 85 }), {
    name: "s", title: "S", group: "g", subgroup: null,
    width_mm: 400, depth_mm: 900, height_mm: 850,
    resizable: false, anchor: null, magnetized: false, can_be_outside: false,
  });
  const full = catalogEntryView({
    name: "s", title: "S", group: "g", subgroup: "sub", width: 1, height: 2, self_height: 3,
    resizable: true, anchor: "floor", is_magnetized: true, can_be_outside: true,
  });
  assert.deepEqual(full, {
    name: "s", title: "S", group: "g", subgroup: "sub",
    width_mm: 10, depth_mm: 20, height_mm: 30,
    resizable: true, anchor: "floor", magnetized: true, can_be_outside: true,
  });
});

// ---------- items: позиции ----------

test("normalizePosition: center насквозь", () => {
  assert.deepEqual(normalizePosition({ center: { x: 1, y: 2 } }, model()), { center: { x: 1, y: 2 } });
});

test("normalizePosition: against_wall — from и gap_mm доходят до модельного слоя, метка W<n> разворачивается", () => {
  const m = model({ walls: { "site-a": wall("site-a", 0, 0, 100, 0), "site-b": wall("site-b", 100, 0, 100, 100) } });
  assert.deepEqual(
    normalizePosition({ against_wall: { wall_id: "site-a", offset_mm: 500, from: "end", gap_mm: 100 } }, m),
    { againstWall: { wallId: "site-a", offsetMm: 500, from: "end", gapMm: 100 } },
  );
  // метка W2 → вторая стена в порядке model_get
  assert.deepEqual(
    normalizePosition({ against_wall: { wall_id: "W2", offset_mm: 1 } }, m),
    { againstWall: { wallId: "site-b", offsetMm: 1, from: undefined, gapMm: undefined } },
  );
  expectNotFound(() => normalizePosition({ against_wall: { wall_id: "W3" } }, m), "стена W3 не найдена");
});

test("normalizePosition: in_room — углы с отступом 150 мм и центр, координаты комнаты в мм", () => {
  const m = model();
  const pos = (corner: string): { x: number; y: number } =>
    (normalizePosition({ in_room: { room_id: "R1", corner } }, m, [room]) as { center: { x: number; y: number } }).center;
  assert.deepEqual(pos("nw"), { x: 1150, y: 2150 });
  assert.deepEqual(pos("ne"), { x: 4850, y: 2150 });
  assert.deepEqual(pos("se"), { x: 4850, y: 4850 });
  assert.deepEqual(pos("sw"), { x: 1150, y: 4850 });
  assert.deepEqual(pos("center"), { x: 3000, y: 3500 });
  expectNotFound(() => normalizePosition({ in_room: { room_id: "R2", corner: "center" } }, m, [room]), "комната R2 не найдена");
  assert.throws(() => normalizePosition({}, m), (e: unknown) => (e as { code?: string }).code === "INVALID_ARGUMENT");
});

test("againstWallCenter: та же формула модельного слоя, что item_add against_wall (стена/полутолщина/сторона помещения)", () => {
  // ревью 190/196: раньше дубль формулы в DTO считал нормаль вектором в 10 раз
  // короче (мм↔см), не учитывал полутолщину стены, полуширину вдоль стены и брал
  // нормаль «вправо» без учёта комнаты. Теперь значения — ровно как даёт
  // againstWallPlacement (см addItem againstWall). Комната (100,200)–(500,500) см:
  // для стены h (0,0)→(100,0) внутренняя сторона — +y (вниз, к комнате).
  const h = wall("h", 0, 0, 100, 0);
  const roomsH = [room];
  // offset 500 мм + полуширина 40 см вдоль; полутолщина 10 + gap 10 + полуглубина 30 см по нормали
  assert.deepEqual(againstWallCenter(h, { offset_mm: 500, gap_mm: 100 }, 80, 60, roomsH), { center: { x: 900, y: 500 }, pcCm: { x: 90, y: 50 }, angleDeg: 0, probePointCm: { x: 90, y: 10.01 } });
  // from=end: 200 мм от конца = 400 мм от начала; gap 0 — только полутолщина + полуглубина
  assert.deepEqual(againstWallCenter(h, { offset_mm: 200, from: "end" }, 80, 60, roomsH), { center: { x: 400, y: 400 }, pcCm: { x: 40, y: 40 }, angleDeg: 0, probePointCm: { x: 40, y: 10.01 } });
  // вертикальная стена: ось → +y, внутренняя нормаль → +x; gap_mm 0
  const v = wall("v", 0, 0, 0, 100);
  assert.deepEqual(againstWallCenter(v, { offset_mm: 250, gap_mm: 0 }, 80, 60, roomsH), { center: { x: 400, y: 650 }, pcCm: { x: 40, y: 65 }, angleDeg: 90, probePointCm: { x: 10.01, y: 65 } });
  // offset больше длины — как в item_add, без clamp (эталон — item_add, он не режет)
  assert.deepEqual(againstWallCenter(h, { offset_mm: 5000 }, 80, 60, roomsH), { center: { x: 5400, y: 400 }, pcCm: { x: 540, y: 40 }, angleDeg: 0, probePointCm: { x: 540, y: 10.01 } });
  // ревью 198 №3: обратная ориентация p1→p2 (стена справа налево) — угол
  // нормируется в 0, а не 180 (нормировка в (−90; 90]), нормаль к той же комнате
  const hRev = wall("h-rev", 100, 0, 0, 0);
  assert.deepEqual(againstWallCenter(hRev, { offset_mm: 500, gap_mm: 100 }, 80, 60, roomsH), { center: { x: 100, y: 500 }, pcCm: { x: 10, y: 50 }, angleDeg: 0, probePointCm: { x: 10, y: 10.01 } });
  assert.deepEqual(againstWallCenter(hRev, { offset_mm: 200, from: "end" }, 80, 60, roomsH), { center: { x: 600, y: 400 }, pcCm: { x: 60, y: 40 }, angleDeg: 0, probePointCm: { x: 60, y: 10.01 } });
});

test("againstWallCenter == addItem againstWall: одна формула на разных стенах, ориентациях p1→p2, from и gap (±1 мм)", () => {
  // эталон ревью 190/196: item_update against_wall ставит предмет в ту же точку
  // и с тем же углом, что item_add against_wall
  const walls = [
    wall("top", 0, 0, 400, 0), // горизонтальная, комната снизу
    wall("top-rev", 400, 0, 0, 0), // та же ось, обратная ориентация p1→p2 (угол 180 → 0)
    wall("left", 0, 0, 0, 300), // вертикальная, комната справа
    wall("diag", 0, 0, 200, 300), // наклонная
  ];
  const m = model({ walls: Object.fromEntries(walls.map((w) => [w.id, w])) });
  const rooms: RoomPolygon[] = [{
    roomId: "room1",
    polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
    areaCm2: 120_000,
    axisAreaCm2: null,
  }];
  for (const w of walls) {
    for (const from of [undefined, "start", "end"] as const) {
      for (const gap_mm of [0, 50]) {
        const added = addItem(m, {
          name: "sofa",
          position: { againstWall: { wallId: w.id, offsetMm: 1000, from, gapMm: gap_mm } },
          widthMm: 800, depthMm: 600,
        }, rooms);
        const at = againstWallCenter(w, { offset_mm: 1000, from, gap_mm }, 80, 60, rooms);
        assert.ok(Math.abs(added.pc.x * 10 - at.center.x) <= 1,
          `${w.id} from=${from} gap=${gap_mm}: x ${added.pc.x * 10} vs ${at.center.x}`);
        assert.ok(Math.abs(added.pc.y * 10 - at.center.y) <= 1,
          `${w.id} from=${from} gap=${gap_mm}: y ${added.pc.y * 10} vs ${at.center.y}`);
        assert.equal(added.angle, at.angleDeg,
          `${w.id} from=${from} gap=${gap_mm}: angle ${added.angle} vs ${at.angleDeg}`);
      }
    }
  }
});

// ---------- ревью 198 №4: сторона стены по попаданию пробной точки в комнату ----------

// комнаты A 0..400×0..300 и B 400..600×0..100 см; B — маленькая комната справа
const roomA: RoomPolygon = {
  roomId: "roomA",
  polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
  areaCm2: 120_000,
  axisAreaCm2: null,
};
const roomB: RoomPolygon = {
  roomId: "roomB",
  polygon: [{ x: 400, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 100 }, { x: 400, y: 100 }],
  areaCm2: 20_000,
  axisAreaCm2: null,
};
const bothRooms = [roomA, roomB];

test("ревью 198 №4: стена маленькой комнаты B — нормаль в B (пробная точка в полигоне), item_add и item_update совпадают", () => {
  // стена B (400,100)→(600,100), предмет 40×40 см, offset_mm 500, gap_mm 0:
  // вдоль 50 + 20 = 70 см от начала → x = 470; полутолщина 10 + полуглубина 20
  // в сторону B → y = 70 (внутри B). Раньше нормаль бралась от центра самой
  // большой комнаты A → (470,130) вне обеих комнат → OUTSIDE_ROOM
  const wb = wall("wb", 400, 100, 600, 100);
  const added = addItem(model({ walls: { wb } }), {
    name: "sofa",
    position: { againstWall: { wallId: "wb", offsetMm: 500, gapMm: 0 } },
    widthMm: 400, depthMm: 400,
  }, bothRooms);
  assert.deepEqual(added.pc, { x: 470, y: 70 });
  assert.equal(added.angle, 0);
  assert.equal(added.id_room, "roomB");
  // та же стена с обратной ориентацией p1→p2: x = 600 − 70 = 530, угол тот же 0
  const wbRev = wall("wb-rev", 600, 100, 400, 100);
  const addedRev = addItem(model({ walls: { "wb-rev": wbRev } }), {
    name: "sofa",
    position: { againstWall: { wallId: "wb-rev", offsetMm: 500, gapMm: 0 } },
    widthMm: 400, depthMm: 400,
  }, bothRooms);
  assert.deepEqual(addedRev.pc, { x: 530, y: 70 });
  assert.equal(addedRev.angle, 0);
  // item_update (againstWallCenter) — ровно те же значения, что у item_add
  assert.deepEqual(againstWallCenter(wb, { offset_mm: 500, gap_mm: 0 }, 40, 40, bothRooms),
    { center: { x: 4700, y: 700 }, pcCm: { x: 470, y: 70 }, angleDeg: 0, probePointCm: { x: 470, y: 89.99 } });
  assert.deepEqual(againstWallCenter(wbRev, { offset_mm: 500, gap_mm: 0 }, 40, 40, bothRooms),
    { center: { x: 5300, y: 700 }, pcCm: { x: 530, y: 70 }, angleDeg: 0, probePointCm: { x: 530, y: 89.99 } });
});

test("ревью 198 №4: стена большой комнаты — сторона помещения как раньше", () => {
  // стена A (0,0)→(400,0): пробная точка со стороны A попадает в полигон A —
  // тот же выбор, что давало старое правило «центр самой большой комнаты»
  const wa = wall("wa", 0, 0, 400, 0);
  const added = addItem(model({ walls: { wa } }), {
    name: "sofa",
    position: { againstWall: { wallId: "wa", offsetMm: 500, gapMm: 0 } },
    widthMm: 400, depthMm: 400,
  }, bothRooms);
  assert.deepEqual(added.pc, { x: 70, y: 30 });
  assert.equal(added.angle, 0);
  assert.deepEqual(againstWallCenter(wa, { offset_mm: 500, gap_mm: 0 }, 40, 40, bothRooms),
    { center: { x: 700, y: 300 }, pcCm: { x: 70, y: 30 }, angleDeg: 0, probePointCm: { x: 70, y: 10.01 } });
});

test("ревью 198 №4: внутренняя перегородка A|B — обе нормали дают комнату, детерминированный выбор как раньше (самая большая)", () => {
  // перегородка (400,0)→(400,100): пробные точки попадают в A (слева) и в B
  // (справа) — правило не определено геометрией, сохраняем прежнее: комната
  // с центром самой большой комнаты (A) → предмет в A
  const wp = wall("wp", 400, 0, 400, 100);
  const added = addItem(model({ walls: { wp } }), {
    name: "sofa",
    position: { againstWall: { wallId: "wp", offsetMm: 500, gapMm: 0 } },
    widthMm: 400, depthMm: 400,
  }, bothRooms);
  assert.deepEqual(added.pc, { x: 370, y: 70 });
  assert.equal(added.angle, 90);
  assert.equal(added.id_room, "roomA");
  assert.deepEqual(againstWallCenter(wp, { offset_mm: 500, gap_mm: 0 }, 40, 40, bothRooms),
    { center: { x: 3700, y: 700 }, pcCm: { x: 370, y: 70 }, angleDeg: 90, probePointCm: { x: 389.99, y: 70 } });
});

test("ревью 198 №4: пробные точки вне обеих комнат — прежнее поведение, OUTSIDE_ROOM без падения", () => {
  // стена правее комнаты B (600,100)→(800,100): ни одна пробная точка не в
  // комнате → прежнее правило (самая большая комната) → точка вне помещений
  const wo = wall("wo", 600, 100, 800, 100);
  assert.throws(() => addItem(model({ walls: { wo } }), {
    name: "sofa",
    position: { againstWall: { wallId: "wo", offsetMm: 500, gapMm: 0 } },
    widthMm: 400, depthMm: 400,
  }, bothRooms), (e: unknown) => e instanceof McpError && e.code === "OUTSIDE_ROOM");
});

// ---------- ревью 209 №1: полигоны в формате редактора (rooms2 по ВНУТРЕННИМ граням стен) ----------

// комнаты контурами по граням — на 10 см от осей стен (как даёт rooms2 редактора:
// tests/fixtures/editor-corridor-3rooms.json), а не по осям, как в тестах выше:
// A 10..390 × 10..290, B 410..590 × 10..90. На таких полигонах пробная точка без
// отступа depth/2 (на самой оси) не попадает ни в одну комнату — тест краснеет
const faceRoomA: RoomPolygon = {
  roomId: "faceA",
  polygon: [{ x: 10, y: 10 }, { x: 390, y: 10 }, { x: 390, y: 290 }, { x: 10, y: 290 }],
  areaCm2: 106_400,
  axisAreaCm2: null,
};
const faceRoomB: RoomPolygon = {
  roomId: "faceB",
  polygon: [{ x: 410, y: 10 }, { x: 590, y: 10 }, { x: 590, y: 90 }, { x: 410, y: 90 }],
  areaCm2: 14_400,
  axisAreaCm2: null,
};
const faceRooms = [faceRoomA, faceRoomB];

test("ревью 209 №1: грани по rooms2 редактора — предмет у стены маленькой комнаты B, проба с отступом depth/2", () => {
  // стена B (400,100)→(600,100), ось y=100, грань B на y=90: проба вниз
  // (470, 89.99) — в B, вверх (470, 110.01) — вне A (A кончается на x=390).
  // Без отступа depth/2 проба легла бы на ось (470, 99.99) — вне B → прежнее
  // правило (самая большая комната A) → (470,130) вне комнат → OUTSIDE_ROOM
  const wb = wall("wb", 400, 100, 600, 100);
  const added = addItem(model({ walls: { wb } }), {
    name: "sofa",
    position: { againstWall: { wallId: "wb", offsetMm: 500, gapMm: 0 } },
    widthMm: 400, depthMm: 400,
  }, faceRooms);
  assert.deepEqual(added.pc, { x: 470, y: 70 });
  assert.equal(added.angle, 0);
  assert.equal(added.id_room, "faceB");
  // item_update (againstWallCenter) — те же значения
  assert.deepEqual(againstWallCenter(wb, { offset_mm: 500, gap_mm: 0 }, 40, 40, faceRooms),
    { center: { x: 4700, y: 700 }, pcCm: { x: 470, y: 70 }, angleDeg: 0, probePointCm: { x: 470, y: 89.99 } });
});

test("ревью 209 №1: реальная фикстура редактора editor-corridor-3rooms (rooms2 по граням) — w5 → коридор _sn2hk", () => {
  // стена перегородки w5 (10,0)→(590,0): комнаты над ней — контурами по граням
  // (y от −290 до −10), коридор под ней (y от 10 до 110). Проба вниз (300, 10.01)
  // — в коридор, вверх (300, −10.01) — вне комнат (между гранями y=−10 и телом
  // перегородки). Старое правило «центр самой большой комнаты» давало нормаль
  // вверх → (300,−30) вне комнат → OUTSIDE_ROOM
  const raw = JSON.parse(readFileSync(join(here, "../fixtures/editor-corridor-3rooms.json"), "utf8")) as { model: Model };
  const added = addItem(raw.model, {
    name: "sofa",
    position: { againstWall: { wallId: "w5", offsetMm: 2700, gapMm: 0 } },
    widthMm: 400, depthMm: 400,
  });
  assert.deepEqual(added.pc, { x: 300, y: 30 });
  assert.equal(added.angle, 0);
  assert.equal(added.id_room, "_sn2hk");
});

// ---------- ревью 209 №2: «ступенчатая стена» — from и width/2 в пробной точке ----------

// стена (0,100)→(800,100), вдоль неё комнаты по разные стороны на разных участках:
// A 10..390 × −290..90 над ней слева, C 410..790 × 110..390 под ней справа
const stepRoomA: RoomPolygon = {
  roomId: "stepA",
  polygon: [{ x: 10, y: -290 }, { x: 390, y: -290 }, { x: 390, y: 90 }, { x: 10, y: 90 }],
  areaCm2: 144_400,
  axisAreaCm2: null,
};
const stepRoomC: RoomPolygon = {
  roomId: "stepC",
  polygon: [{ x: 410, y: 110 }, { x: 790, y: 110 }, { x: 790, y: 390 }, { x: 410, y: 390 }],
  areaCm2: 106_400,
  axisAreaCm2: null,
};
const stepRooms = [stepRoomA, stepRoomC];
const wstep = wall("wstep", 0, 100, 800, 100);

test("ревью 209 №2: ступенчатая стена — проба на смещении from/offset+width/2, предмет по разные стороны", () => {
  // from=start, offset 500: проба (70, 89.99) — в A над стеной → предмет (70,70) в A
  const addedA = addItem(model({ walls: { wstep } }), {
    name: "sofa",
    position: { againstWall: { wallId: "wstep", offsetMm: 500, gapMm: 0 } },
    widthMm: 400, depthMm: 400,
  }, stepRooms);
  assert.deepEqual(addedA.pc, { x: 70, y: 70 });
  assert.equal(addedA.id_room, "stepA");
  // from=end, offset 500: проба (730, 110.01) — в C под стеной → предмет (730,130) в C.
  // Проба, игнорирующая from (легла бы на x=70), выбрала бы сторону A → (730,70)
  // вне комнат → OUTSIDE_ROOM
  const addedC = addItem(model({ walls: { wstep } }), {
    name: "sofa",
    position: { againstWall: { wallId: "wstep", offsetMm: 500, from: "end", gapMm: 0 } },
    widthMm: 400, depthMm: 400,
  }, stepRooms);
  assert.deepEqual(addedC.pc, { x: 730, y: 130 });
  assert.equal(addedC.id_room, "stepC");
  // ревью 269 М1: againstWallCenter дополнительно отдаёт точный центр в см (pcCm)
  // и пробную точку на внутренней грани (probePointCm)
  assert.deepEqual(againstWallCenter(wstep, { offset_mm: 500, from: "end", gap_mm: 0 }, 40, 40, stepRooms),
    { center: { x: 7300, y: 1300 }, pcCm: { x: 730, y: 130 }, angleDeg: 0, probePointCm: { x: 730, y: 110.01 } });
  // ширина 100 см, offset 3700: с width/2 проба на x=420 → (420, 110.01) в C →
  // предмет (420,130) в C; без width/2 проба на x=370 → (370, 89.99) в A —
  // сторона выбрана неверно → (420,70) вне комнат → OUTSIDE_ROOM. Проба на
  // середине стены (x=400) не попадает ни в одну комнату → тоже прежнее правило
  const addedW = addItem(model({ walls: { wstep } }), {
    name: "sofa",
    position: { againstWall: { wallId: "wstep", offsetMm: 3700, gapMm: 0 } },
    widthMm: 1000, depthMm: 400,
  }, stepRooms);
  assert.deepEqual(addedW.pc, { x: 420, y: 130 });
  assert.equal(addedW.id_room, "stepC");
});

test("itemsInRoom: индексы предметов внутри комнаты, roomIndex вне диапазона — пусто", () => {
  const m = model({ items: { in1: item("in1", 200, 300), out1: item("out1", 600, 600) } });
  assert.deepEqual([...itemsInRoom(m, [room], 0)], [0]);
  assert.equal(itemsInRoom(m, [room], -1).size, 0);
  assert.equal(itemsInRoom(m, [room], 5).size, 0);
});

test("resolveItem: id сайта или метка I<n>", () => {
  const m = model({ items: { a: item("a", 1, 1), b: item("b", 2, 2) } });
  assert.equal(resolveItem(m, "b").id, "b");
  assert.equal(resolveItem(m, "I1").id, "a");
  assert.equal(resolveItem(m, "I2").id, "b");
  expectNotFound(() => resolveItem(m, "I3"), "предмет I3 не найден");
});
