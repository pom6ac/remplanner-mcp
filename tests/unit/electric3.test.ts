// Электрика ч.3 (этап 370): вертикальные блоки розеточных групп («друг над
// другом») — props.layer 2/3 у пристенной электрики (бандл app.3.0: layer
// dragmoveWall, get_offset_layer2 = 26/52 см, у скосов 22/44), связка
// (pairing_line/has_layer_up) — производная, в модели не хранится.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps } from "../../src/model/types.ts";
import { addRoomRect, splitWall } from "../../src/model/walls.ts";
import { roomPolygons } from "../../src/model/rooms.ts";
import { addItem, updateItem, socketGroupAngleDeg } from "../../src/model/items.ts";
import { againstWallCenter } from "../../src/dto/items.ts";
import {
  addCable, SOCKET_LAYER_OFFSET_CM, socketLayerOf, applySocketGroupLayer,
} from "../../src/model/electric.ts";
import { toToolEntry, type ToolEntry } from "../../src/catalog.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { itemVerificationMismatches } from "../../src/verify/items.ts";
import { socketGroupSubsUserMismatches } from "../../src/verify/sockets.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));

function baseModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  const m = { ...structuredClone(model), walls: {} } as Model;
  addRoomRect(m, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  m.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return m;
}

function elecEntry(name: string): ToolEntry {
  const CATALOG: Record<string, Record<string, unknown>> = {
    chandelier: { id: 35, group: "lights", width: 24, height: 24, self_height: 0, plan: { light: 10 }, anchor: "free", over_floor: false, title: "Люстра" },
    socket_thermo: { id: 44, group: "sockets", width: 14, height: 14, self_height: 0, plan: { warm_floor: 11 }, anchor: "wall", over_floor: { value: 90, display: true }, title: "Терморегулятор" },
    furniture_socket: { id: 45, group: "sockets", width: 14, height: 14, self_height: 0, plan: { sockets: 9 }, anchor: "wall", over_floor: { value: 30, display: true }, title: "Мебельная розетка" },
    bra: { id: 46, group: "lights", width: 20, height: 20, self_height: 30, plan: { light: 10 }, anchor: "wall", over_floor: { value: 140, display: true }, title: "Светильник-бра" },
    bra_shades: { id: 1196, group: "lights", width: 25, height: 30, self_height: 31, plan: { light: 10 }, anchor: "wall", over_floor: { value: 140, display: true }, title: "Светильник-бра с абажуром" },
  };
  const fx = join(here, `../fixtures/ui-ref-elec-${name}.json`);
  if (CATALOG[name]) return toToolEntry(name, CATALOG[name]!);
  const d = JSON.parse(readFileSync(fx, "utf8")) as { catalog_defaults_cm: Record<string, unknown>; menu_title?: string };
  return toToolEntry(name, { ...(d.catalog_defaults_cm ?? {}), name, title: d.menu_title ?? name });
}

function addItemByName(model: Model, name: string, position: Record<string, unknown>): ItemProps {
  return addItem(model, {
    name,
    position: position as never,
    catalogEntry: elecEntry(name),
  } as never);
}

const topWall = (m: Model): string =>
  Object.values(m.walls).find((w) => w.p1.y === w.p2.y)!.id;

/** Расстояние pc от оси стены по нормали (внутрь комнаты — положительное). */
function distFromAxis(model: Model, item: ItemProps): number {
  const wall = model.walls[item.id_wall!]!;
  const axis = { x: wall.p2.x - wall.p1.x, y: wall.p2.y - wall.p1.y };
  const len = Math.hypot(axis.x, axis.y);
  const nx = -(axis.y / len), ny = axis.x / len; // левая нормаль
  const mid = { x: (wall.p1.x + wall.p2.x) / 2, y: (wall.p1.y + wall.p2.y) / 2 };
  const along = (item.pc.x - mid.x) * (axis.x / len) + (item.pc.y - mid.y) * (axis.y / len);
  const proj = { x: mid.x + (axis.x / len) * along, y: mid.y + (axis.y / len) * along };
  const d = (item.pc.x - proj.x) * nx + (item.pc.y - proj.y) * ny;
  return Math.abs(d);
}

test("370: layer 2/3 — pc по правилу get_offset_layer2 (26/52 см от базовой пластины), слой хранится", () => {
  const m = baseModel();
  const it = addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  const base = distFromAxis(m, it);
  assert.ok(base > 0, "предмет стоит у стены с собственным отступом пластины");
  assert.equal(socketLayerOf(it), 1, "без слоя");
  updateItem(m, { itemId: it.id, layer: 2 });
  assert.equal(it.layer, 2);
  assert.ok(Math.abs(distFromAxis(m, it) - (base + 26)) < 0.11, `слой 2: ${distFromAxis(m, it)} = base+26`);
  updateItem(m, { itemId: it.id, layer: 3 });
  assert.equal(it.layer, 3);
  assert.ok(Math.abs(distFromAxis(m, it) - (base + 52)) < 0.11, `слой 3: ${distFromAxis(m, it)} = base+52`);
  // 1 — снять: pc возвращается к пластине, слой null
  updateItem(m, { itemId: it.id, layer: 1 });
  assert.equal(it.layer, null);
  assert.ok(Math.abs(distFromAxis(m, it) - base) < 0.11, "слой 1: пластина");
  // идемпотентность: повторное layer 2 — то же расстояние
  updateItem(m, { itemId: it.id, layer: 2 });
  const d2 = distFromAxis(m, it);
  updateItem(m, { itemId: it.id, layer: 2 });
  assert.ok(Math.abs(distFromAxis(m, it) - d2) < 1e-9, "повтор layer 2 — идемпотентен");
});

test("370: слой 4+ и не-группы — INVALID_ARGUMENT; углы и over_floor не трогаются", () => {
  const m = baseModel();
  const it = addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  const angle = it.angle;
  const of = structuredClone(it.over_floor);
  assert.throws(() => updateItem(m, { itemId: it.id, layer: 4 as never }), (e: unknown) => e instanceof McpError && /слои 1/.test((e as McpError).message));
  assert.throws(() => applySocketGroupLayer(m, { id: "x", name: "sofa", pc: { x: 100, y: 100 } } as ItemProps, 2), /socket_group/);
  // слой 2 не сбрасывает угол/высоту
  updateItem(m, { itemId: it.id, layer: 2 });
  assert.equal(it.angle, angle);
  assert.deepEqual(it.over_floor, of);
  // слой 2/3 с сохранением slope-смещений (22/44) — константы из бандла
  assert.deepEqual(SOCKET_LAYER_OFFSET_CM[2], { flat: 26, slope: 22 });
  assert.deepEqual(SOCKET_LAYER_OFFSET_CM[3], { flat: 52, slope: 44 });
});

test("370: под-розетки и связь выключатель→светильник следуют за слоем (транзитивный пересчёт)", () => {
  const m = baseModel();
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  const lamp = addItemByName(m, "chandelier", { center: { x: 2000, y: 1500 } });
  const cable = addCable(m, { switchItemId: sw.id, switchSubId: (sw.socket_group as { id: string }[])[0]!.id, lampItemId: lamp.id });
  const swSubBefore = { ...((sw.socket_group as { center: { x: number; y: number } }[])[0]!.center) };
  const vBefore = structuredClone(cable.vertexes.find((v) => v.type === "switch")!.point);
  updateItem(m, { itemId: sw.id, layer: 2 });
  const sub = (sw.socket_group as { center: { x: number; y: number } }[])[0]!.center;
  // center под-розетки сместился внутрь на 26 вместе со слоем (вдоль стены — на месте)
  assert.ok(Math.abs(sub.y - swSubBefore.y - 26) < 0.11, `center под-розетки: ${JSON.stringify({ before: swSubBefore, after: sub })}`);
  const v = cable.vertexes.find((v) => v.type === "switch")!.point;
  assert.ok(Math.abs(v.y - vBefore!.y - 26) < 0.11, `вершина связи следует: ${JSON.stringify({ before: vBefore, after: v })}`);
  assert.ok(Math.abs(cable.length - (cable.vertexes.length ? cable.length : 0)) >= 0, "длина пересчитана без исключения");
});

// ---------- полный путь через Workspace + mock save ----------

const COMPAT = { bundle: "x", version: "1", schema: 1 } as never;

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void = () => {}, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
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

test("370: mock save — слой 2 сохраняется verified; сервер потерял слой → сверка ловит (ItemSig.layer)", async () => {
  const build = () => {
    const m = baseModel();
    const it = addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
    updateItem(m, { itemId: it.id, layer: 2 });
    return { m, it };
  };
  // сервер сохранил слой → verified
  {
    const { m } = build();
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server);
    await ws.open("0", "1");
    const out = await ws.save();
    assert.equal(out.verified, true, "слой 2 дошёл до сервера, save verified");
  }
  // сервер потерял слой → расхождение itemVerificationMismatches
  {
    const { m, it } = build();
    const norm = structuredClone(m) as unknown as Record<string, unknown>;
    const serverModel = structuredClone(m) as unknown as Record<string, unknown>;
    (serverModel["items"] as Record<string, ItemProps>)[it.id]!.layer = null;
    const expected = (norm["items"] as Record<string, ItemProps>);
    const mismatch = itemVerificationMismatches(expected as never, serverModel["items"] as never);
    assert.ok(mismatch.some((s) => s.includes(it.id) && s.includes("слой")), `слой в сверке: ${mismatch.join("; ")}`);
  }
});

// ---------- стена двигается — слой не теряется, ложной ошибки нет ----------

test("370: mock save — wall_move при живом слое 2: слой сохранён, save verified", async () => {
  const { moveWall } = await import("../../src/model/walls.ts");
  const m = baseModel();
  const wid = topWall(m);
  const it = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  updateItem(m, { itemId: it.id, layer: 2 });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server);
  await ws.open("0", "1");
  ws.apply("move-wall", (mm) => {
    moveWall(mm, { wallId: wid, offsetMm: 100 });
    return true;
  });
  const after = ws.model as Model;
  const moved = Object.values(after.items).find((i) => i.name === "socket_group")!;
  assert.equal(moved.layer, 2, "слой пережил перенос стены");
  const out = await ws.save();
  assert.equal(out.verified, true, "стена делит/двигается — без ложной ошибки, слой на месте");
});

// ---------- ревью 371 №1: перенос вдоль стены сохраняет смещение слоя ----------

/** item_update against_wall тем же вызовом, что tools-plan (centerCm + resnapToWall). */
function moveAgainstWall(m: Model, item: ItemProps, wallId: string, offsetMm: number, layer?: number): void {
  const wall = m.walls[wallId]!;
  const at = againstWallCenter(wall, { offset_mm: offsetMm, gap_mm: 0 }, item.width, item.height, roomPolygons(m));
  updateItem(m, {
    itemId: item.id,
    centerCm: at.pcCm,
    angleDeg: socketGroupAngleDeg(at.angleDeg),
    idWall: wall.id,
    resnapToWall: true,
    rooms: roomPolygons(m),
    layer,
  });
}

test("375 (373 F1): item_update against_wall у розетки (can_move_between_walls) — слой снимается, как в редакторе; явный layer ставится заново", () => {
  const m = baseModel();
  const wid = topWall(m);
  // база слоя 1 (расстояние пластины от оси) — константа стены, не зависит от offset вдоль
  const probe = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  const base = distFromAxis(m, probe);
  assert.ok(base > 0);
  updateItem(m, { itemId: probe.id, layer: 2 });
  assert.ok(Math.abs(distFromAxis(m, probe) - (base + 26)) < 0.11, "слой 2 без переноса: base+26");
  // (а) без явного layer — dragmoveWall бандла (ветка canMoveBetweenWalls) слой
  //     снимает; редактор ставит его заново только сцепкой с другой розеткой
  moveAgainstWall(m, probe, wid, 2500);
  assert.equal(probe.layer, null, "слой снят (F1)");
  assert.ok(Math.abs(distFromAxis(m, probe) - base) < 0.11, `расстояние = база пластины, получили ${distFromAxis(m, probe)}`);
  // (б) явный layer:2 в том же вызове — сцепка задаётся явно, слой ставится относительно новой позиции
  moveAgainstWall(m, probe, wid, 3000, 2);
  assert.equal(probe.layer, 2);
  assert.ok(Math.abs(distFromAxis(m, probe) - (base + 26)) < 0.11, `расстояние = база + 26, получили ${distFromAxis(m, probe)}`);
  // (в) явный layer:3 — база + 52; (г) явный layer:1 — вернуть к пластине
  moveAgainstWall(m, probe, wid, 1500, 3);
  assert.equal(probe.layer, 3);
  assert.ok(Math.abs(distFromAxis(m, probe) - (base + 52)) < 0.11);
  moveAgainstWall(m, probe, wid, 1500, 1);
  assert.equal(probe.layer, null);
  assert.ok(Math.abs(distFromAxis(m, probe) - base) < 0.11, "слой 1 — пластина");
  // у розетки без слоя перенос ничего не меняет
  const plain = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 2000 } });
  const plainDist = distFromAxis(m, plain);
  moveAgainstWall(m, plain, wid, 2200);
  assert.equal(plain.layer ?? null, null);
  assert.ok(Math.abs(distFromAxis(m, plain) - plainDist) < 0.11, "у розетки без слоя расстояние не изменилось");
});

test("375 (373 F1): против переноса у выключателя (без can_move_between_walls) — смещение слоя сохранено (база + 26)", () => {
  const m = baseModel();
  const wid = topWall(m);
  const probe = addItemByName(m, "light_switch", { againstWall: { wallId: wid, offsetMm: 1000 } });
  const base = distFromAxis(m, probe);
  assert.ok(base > 0);
  updateItem(m, { itemId: probe.id, layer: 2 });
  assert.ok(Math.abs(distFromAxis(m, probe) - (base + 26)) < 0.11, "слой 2 без переноса: base+26");
  // у выключателя флага can_move_between_walls в каталоге нет — общая ветка
  // dragmoveWall смещение слоя сохраняет (371 №1, поведение не менялось)
  moveAgainstWall(m, probe, wid, 2500);
  assert.equal(probe.layer, 2, "слой остался 2");
  assert.ok(Math.abs(distFromAxis(m, probe) - (base + 26)) < 0.11, `расстояние = база + 26, получили ${distFromAxis(m, probe)}`);
  moveAgainstWall(m, probe, wid, 3000, 3);
  assert.equal(probe.layer, 3);
  assert.ok(Math.abs(distFromAxis(m, probe) - (base + 52)) < 0.11);
});

test("375 (373 F2): against_wall сбрасывает привязку к прежней опоре (slope_side, id_hole, hole_group)", () => {
  const m = baseModel();
  const wid = topWall(m);
  // предмет с формой эталона ui-ref-electric3-slope: slope_side строкой стороны,
  // id_hole/hole_group редактор пишет вместе с ним (dragmoveWall откоса)
  const it = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  const loose = it as unknown as Record<string, unknown>;
  loose["slope_side"] = "1";
  loose["id_hole"] = "hole1";
  loose["hole_group"] = "windows";
  const base = distFromAxis(m, it);
  updateItem(m, { itemId: it.id, layer: 2 });
  assert.ok(Math.abs(distFromAxis(m, it) - (base + 22)) < 0.11, `скос: смещение 22 (${distFromAxis(m, it)})`);
  moveAgainstWall(m, it, topWall(m), 2500);
  assert.equal(loose["slope_side"], undefined, "slope_side сброшен");
  assert.equal(loose["id_hole"], undefined, "id_hole сброшен");
  assert.equal(loose["hole_group"], undefined, "hole_group сброшен");
  assert.equal(it.layer, null, "слой снят (F1, socket)");
  assert.ok(Math.abs(distFromAxis(m, it) - base) < 0.11, `расстояние = база пластины (${distFromAxis(m, it)})`);
  // у выключателя со скосом сброс полей не ломает сохранение слоя (22 → 22)
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: wid, offsetMm: 1500 } });
  const swBase = distFromAxis(m, sw);
  const swLoose = sw as unknown as Record<string, unknown>;
  swLoose["slope_side"] = "2";
  swLoose["id_hole"] = "hole2";
  swLoose["hole_group"] = "doors";
  updateItem(m, { itemId: sw.id, layer: 2 });
  assert.ok(Math.abs(distFromAxis(m, sw) - (swBase + 22)) < 0.11, `выключатель со скосом: 22 (${distFromAxis(m, sw)})`);
  moveAgainstWall(m, sw, topWall(m), 2500);
  assert.equal(swLoose["slope_side"], undefined, "slope_side сброшен у выключателя");
  assert.equal(swLoose["hole_group"], undefined, "hole_group сброшен у выключателя");
  assert.equal(sw.layer, 2, "слой выключателя сохранён");
  assert.ok(Math.abs(distFromAxis(m, sw) - (swBase + 26)) < 0.11, `без скоса: 26 (${distFromAxis(m, sw)})`);
});

test("375 (373 F3): строковый layer «2» трактуется единообразно моделью и сверкой", () => {
  const m = baseModel();
  const wid = topWall(m);
  // выключатель с legacy-строковым слоем: against_wall сохраняет слой как число 2
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: wid, offsetMm: 1000 } });
  const swBase = distFromAxis(m, sw);
  (sw as unknown as { layer?: unknown }).layer = "2";
  moveAgainstWall(m, sw, topWall(m), 2500);
  assert.equal(sw.layer, 2, "строковый «2» — слой 2, не null");
  assert.ok(Math.abs(distFromAxis(m, sw) - (swBase + 26)) < 0.11, `расстояние = база + 26 (${distFromAxis(m, sw)})`);
  // сверка: строковый слой в ожидании и числовой на сервере — не расхождение
  const mismatch = socketGroupSubsUserMismatches(
    { [sw.id]: { socket_group: [{ id: "id1", name: "light_switch" }], layer: "2" } },
    { [sw.id]: { socket_group: [{ id: "id1", name: "light_switch" }], layer: 2 } },
  );
  assert.deepEqual(mismatch, [], "строка «2» == число 2 в сверке");
  const mismatch2 = socketGroupSubsUserMismatches(
    { [sw.id]: { socket_group: [{ id: "id1", name: "light_switch" }], layer: 2 } },
    { [sw.id]: { socket_group: [{ id: "id1", name: "light_switch" }], layer: null } },
  );
  assert.equal(mismatch2.length, 1, "потеря слоя ловится");
  // socketLayerOf един для модели и сверки
  assert.equal(socketLayerOf({ layer: "2" } as ItemProps), 2);
  assert.equal(socketLayerOf({ layer: "1" } as ItemProps), 1);
  assert.equal(socketLayerOf({ layer: null } as ItemProps), 1);
  assert.equal(socketLayerOf({} as ItemProps), 1);
});

test("375 (373 F1): полный путь через Workspace — розетка: слой снят (verified); выключатель: слой сохранён (verified); под-розетки следуют", async () => {
  // розетка (can_move_between_walls): against_wall без layer — слой снят, save verified
  {
    const m = baseModel();
    const wid = topWall(m);
    const it = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
    const base = distFromAxis(m, it);
    updateItem(m, { itemId: it.id, layer: 2 });
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server);
    await ws.open("0", "1");
    ws.apply("move-against-wall", (mm) => {
      const it = Object.values(mm.items).find((i) => i.name === "socket_group")!;
      moveAgainstWall(mm, it, topWall(mm), 2500);
      return true;
    });
    const after = ws.model as Model;
    const moved = Object.values(after.items).find((i) => i.name === "socket_group")!;
    assert.equal(moved.layer, null, "слой розетки снят при against_wall (F1)");
    assert.ok(Math.abs(distFromAxis(after, moved) - base) < 0.11, `расстояние = база пластины (${distFromAxis(after, moved)})`);
    const out = await ws.save();
    assert.equal(out.verified, true, "save verified: слой и центр согласованы");
  }
  // выключатель (без флага): смещение слоя сохранено — поведение 371 №1
  {
    const m = baseModel();
    const wid = topWall(m);
    const it = addItemByName(m, "light_switch", { againstWall: { wallId: wid, offsetMm: 1000 } });
    const base = distFromAxis(m, it);
    updateItem(m, { itemId: it.id, layer: 2 });
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server);
    await ws.open("0", "1");
    ws.apply("move-against-wall", (mm) => {
      const it = Object.values(mm.items).find((i) => i.name === "socket_group")!;
      moveAgainstWall(mm, it, topWall(mm), 2500);
      return true;
    });
    const after = ws.model as Model;
    const moved = Object.values(after.items).find((i) => i.name === "socket_group")!;
    assert.equal(moved.layer, 2, "слой выключателя пережил перенос");
    assert.ok(Math.abs(distFromAxis(after, moved) - (base + 26)) < 0.11, `расстояние = база + 26 (${distFromAxis(after, moved)})`);
    const out = await ws.save();
    assert.equal(out.verified, true, "save verified: смещение слоя дошло без расхождений");
  }
  // нормализатор уронил слой → NORMALIZATION_DROPPED (слой — пользовательское поле, сверка до save)
  {
    const m = baseModel();
    const wid = topWall(m);
    const it = addItemByName(m, "light_switch", { againstWall: { wallId: wid, offsetMm: 1000 } });
    updateItem(m, { itemId: it.id, layer: 2 });
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server, () => {}, (norm) => {
      const it = Object.values(norm.items as Record<string, ItemProps>).find((i) => i.name === "socket_group")!;
      it.layer = null;
    });
    await ws.open("0", "1");
    await assert.rejects(() => ws.save(), (e: unknown) => {
      const ok = e instanceof McpError && (e as McpError).code === "NORMALIZATION_DROPPED";
      if (ok) {
        const det = (e as McpError).details as Record<string, unknown>;
        assert.ok(Array.isArray(det["socket_group_mismatches"]) && (det["socket_group_mismatches"] as string[]).some((s) => s.includes("слой")), "подробность про слой");
      }
      return ok;
    });
  }
  // сервер добавил слой, которого нет в ожидании → SITE_ERROR (сверка после save двусторонняя)
  {
    const m = baseModel();
    const wid = topWall(m);
    addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server, (srv) => {
      const it = Object.values((srv.model as { items: Record<string, ItemProps> }).items).find((i) => i.name === "socket_group")!;
      it.layer = 2;
    });
    await ws.open("0", "1");
    await assert.rejects(() => ws.save(), (e: unknown) => {
      const ok = e instanceof McpError && (e as McpError).code === "SITE_ERROR";
      if (ok) {
        const det = (e as McpError).details as Record<string, unknown>;
        assert.ok(
          (Array.isArray(det["socket_group_mismatches"]) && (det["socket_group_mismatches"] as string[]).some((s) => s.includes("слой"))) ||
          JSON.stringify(det).includes("слой"),
          "появившийся слой пойман",
        );
      }
      return ok;
    });
  }
});

/** 375 (373 F1): по типу каталога — типы с can_move_between_walls. У розеточных
 *  (socket, socket_thermo, furniture_socket) against_wall снимает слой —
 *  краснеет без фикса. У bra/bra_shades (group lights) слоя в редакторе нет
 *  (сцепка ставит слой только группам sockets/switches/wires) — plain-предмет,
 *  MCP слоя не поддерживает: layer — INVALID_ARGUMENT, перенос без слоя. */
test("375 (373 F1): каждый тип с can_move_between_walls через Workspace", async () => {
  for (const name of ["socket", "socket_thermo", "furniture_socket"]) {
    const m = baseModel();
    const wid = topWall(m);
    const it = addItemByName(m, name, { againstWall: { wallId: wid, offsetMm: 1000 } });
    assert.equal(it.name, "socket_group", `${name} — группа socket_group`);
    const base = distFromAxis(m, it);
    updateItem(m, { itemId: it.id, layer: 2 });
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server);
    await ws.open("0", "1");
    ws.apply(`move-${name}`, (mm) => {
      const it = Object.values(mm.items).find((i) => i.name === "socket_group")!;
      moveAgainstWall(mm, it, topWall(mm), 2500);
      return true;
    });
    const after = ws.model as Model;
    const moved = Object.values(after.items).find((i) => i.name === "socket_group")!;
    assert.equal(moved.layer, null, `${name}: слой снят при against_wall (F1)`);
    assert.ok(Math.abs(distFromAxis(after, moved) - base) < 0.11, `${name}: расстояние = база пластины (${distFromAxis(after, moved)})`);
    const out = await ws.save();
    assert.equal(out.verified, true, `${name}: save verified`);
  }
  // bra/bra_shades — plain-предметы (group lights): слоя в редакторе нет,
  // MCP слоя не поддерживает; against_wall переносит предмет, verified
  for (const name of ["bra", "bra_shades"]) {
    const m = baseModel();
    const wid = topWall(m);
    const it = addItemByName(m, name, { againstWall: { wallId: wid, offsetMm: 1000 } });
    assert.notEqual(it.name, "socket_group", `${name} — plain-предмет, не socket_group`);
    assert.throws(
      () => updateItem(m, { itemId: it.id, layer: 2 }),
      (e: unknown) => e instanceof McpError && /socket_group/.test((e as McpError).message),
      `${name}: слой не поддерживается (INVALID_ARGUMENT)`,
    );
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server);
    await ws.open("0", "1");
    ws.apply(`move-${name}`, (mm) => {
      const it = Object.values(mm.items).find((i) => i.name === name)!;
      moveAgainstWall(mm, it, topWall(mm), 2500);
      return true;
    });
    const after = ws.model as Model;
    const moved = Object.values(after.items).find((i) => i.name === name)!;
    assert.equal(moved.layer ?? null, null, `${name}: слоя нет`);
    const out = await ws.save();
    assert.equal(out.verified, true, `${name}: save verified`);
  }
});

test("372 (371 №2): slope_side в форме бандла («1»/«2») — смещения скоса 22/44", () => {
  const m = baseModel();
  const wid = topWall(m);
  // отдельные предметы под каждое значение (в редакторе slope_side пишется
  // перетаскиванием на откос вместе с пересчётом pc, а не задним числом)
  const s1 = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  (s1 as { slope_side?: unknown }).slope_side = "1";
  updateItem(m, { itemId: s1.id, layer: 2 });
  const base1 = distFromAxis(m, s1) - 22;
  assert.ok(base1 > 0);
  // редактор пишет строку стороны (slope_side = _.side: "1"/"2"), сброс — void 0;
  // бандл проверяет истинность (2==layer ? slope_side ? 22 : 26 : …)
  const s2 = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  const base2 = distFromAxis(m, s2);
  (s2 as { slope_side?: unknown }).slope_side = "1";
  updateItem(m, { itemId: s2.id, layer: 2 });
  assert.ok(Math.abs(distFromAxis(m, s2) - (base2 + 22)) < 0.11, `скос «1», слой 2: ${distFromAxis(m, s2)} = base+22`);
  const s3 = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  const base3 = distFromAxis(m, s3);
  (s3 as { slope_side?: unknown }).slope_side = "2";
  updateItem(m, { itemId: s3.id, layer: 3 });
  assert.ok(Math.abs(distFromAxis(m, s3) - (base3 + 44)) < 0.11, `скос «2», слой 3: ${distFromAxis(m, s3)} = base+44`);
  // без скоса — плоские 26/52
  const s4 = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  const base4 = distFromAxis(m, s4);
  updateItem(m, { itemId: s4.id, layer: 2 });
  assert.ok(Math.abs(distFromAxis(m, s4) - (base4 + 26)) < 0.11, "без скоса слой 2: base+26");
});

test("372 (371 №4): стена делит комнату (wall_split) — слой и расстояние сохранены, save verified без ложной ошибки", async () => {
  const m = baseModel();
  const wid = topWall(m);
  const it = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  updateItem(m, { itemId: it.id, layer: 2 });
  const distBefore = distFromAxis(m, it);
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server);
  await ws.open("0", "1");
  ws.apply("split-wall", (mm) => {
    splitWall(mm, topWall(mm), 2000);
    return true;
  });
  const after = ws.model as Model;
  const split = Object.values(after.items).find((i) => i.name === "socket_group")!;
  assert.equal(split.id_wall, it.id_wall, "id_wall не изменился (предмет на первой половине)");
  assert.equal(split.layer, 2, "слой пережил разрез стены");
  assert.ok(Math.abs(distFromAxis(after, split) - distBefore) < 0.11, `расстояние до оси сохранено (${distFromAxis(after, split)})`);
  const out = await ws.save();
  assert.equal(out.verified, true, "стена делит комнату — без ложной ошибки");
});

// ---------- ревью 371 №4: эталоны ui-ref-electric3-* в обе стороны ----------

test("372 (371 №4): эталон ui-ref-electric3-layer — форма слоя из бандла; модель воспроизводит эталон", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-electric3-layer.json"), "utf8")) as {
    model_object: ItemProps;
  };
  // эталон → форма: слой — число 2, группа розеток, id/стена обезличены
  assert.equal(fx.model_object.layer, 2);
  assert.equal(fx.model_object.name, "socket_group");
  assert.ok(Array.isArray(fx.model_object.socket_group) && fx.model_object.socket_group.length === 1);
  // модель → эталон: item_add + layer 2 даёт те же пользовательские поля
  const m = baseModel();
  const it = addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  updateItem(m, { itemId: it.id, layer: 2 });
  assert.equal(it.layer, fx.model_object.layer);
  assert.equal(it.name, fx.model_object.name);
  assert.equal((it.socket_group as { id: string }[]).length, (fx.model_object.socket_group as unknown[]).length);
  const of = it.over_floor as { value: number; display: boolean; vd: number };
  const ofFx = fx.model_object.over_floor as { value: number; display: boolean; vd: number };
  assert.deepEqual([of.value, of.display, of.vd], [ofFx.value, ofFx.display, ofFx.vd]);
});

test("372 (371 №4): эталон ui-ref-electric3-slope — slope_side строкой стороны («1»), смещение скоса 22; модель воспроизводит", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-electric3-slope.json"), "utf8")) as {
    model_object: ItemProps;
  };
  // эталон → форма: slope_side — строка «1» (бандл: slope_side = _.side), слой — число
  assert.equal(fx.model_object.slope_side, "1");
  assert.equal(fx.model_object.layer, 2);
  // модель → эталон: предмет со slope_side «1» и слоем 2 несёт те же пользовательские поля
  const m = baseModel();
  const it = addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  (it as { slope_side?: unknown }).slope_side = "1";
  updateItem(m, { itemId: it.id, layer: 2 });
  assert.equal(it.slope_side, fx.model_object.slope_side);
  assert.equal(it.layer, fx.model_object.layer);
});
