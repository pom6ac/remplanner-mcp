// Этап 88 «Электрика»: розетки/выключатели — предметы-группы socket_group
// (item_add), связь «выключатель → светильник» — model.cables (Cable, класс
// Cabling редактора). Эталоны UI в обе стороны (ui-ref-elec-*), слияние в группу
// при постановке рядом, лимиты клавиш, обратные ссылки в обе стороны,
// транзитивный пересчёт при переносе, удаление, реестр коллекций, компакт,
// mock save (подмена writeBackup/loadModel/openEditor), регрессия прежних разделов.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps, Cable } from "../../src/model/types.ts";
import { addRoomRect, moveWall, deleteWall } from "../../src/model/walls.ts";
import { roomPolygons } from "../../src/model/rooms.ts";
import { addItem, updateItem, deleteItem, socketGroupAngleDeg } from "../../src/model/items.ts";
import { againstWallCenter } from "../../src/dto/items.ts";
import {
  addCable, deleteCable, cablesReferencingItem, refreshSocketGroupSubs,
  SWITCH_MAX_KEYS, CABLE_LAMP_ITEMS, STANDALONE_SOCKETS, parseSwitchVertexId,
} from "../../src/model/electric.ts";
import { addPipe } from "../../src/model/pipes.ts";
import { compactModel } from "../../src/model/compact.ts";
import { clearEntityCollections, replaceEntityCollections, MODEL_ENTITY_COLLECTIONS } from "../../src/model/collections.ts";
import { toToolEntry, type ToolEntry } from "../../src/catalog.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exists = (p: string): boolean => existsSync(p);

function baseModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  const m = { ...structuredClone(model), walls: {} } as Model;
  addRoomRect(m, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  m.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return m;
}

function elecEntry(name: string): ToolEntry {
  const fx = join(here, `../fixtures/ui-ref-elec-${name}.json`);
  if (exists(fx)) {
    const d = JSON.parse(readFileSync(fx, "utf8")) as { catalog_defaults_cm: Record<string, unknown>; menu_title?: string };
    return toToolEntry(name, { ...(d.catalog_defaults_cm ?? {}), name, title: d.menu_title ?? name });
  }
  // PRO-пункты и пункты вне UI-кликов — реальные значения каталога
  // (проба 88-elec-catalog-full, .orca-reports) инлайном: общий catalog-sample
  // не расширяем — он дамп реальных ответов сайта
  const CATALOG: Record<string, Record<string, unknown>> = {
    wire: { id: 609, group: "wires", width: 14, height: 20, self_height: 0, plan: { sockets: 9 }, anchor: "wall", over_floor: { value: 30, display: false }, title: "Вывод провода 220В" },
    cable: { id: 617, group: "switches", width: 0, height: 0, self_height: 0, plan: { light_connections: 29 }, anchor: "wall", over_floor: false, title: "Соединительная линия" },
    light_switch: { id: 577, group: "switches", width: 14, height: 18, self_height: 0, plan: { light_connections: 29 }, anchor: "wall", over_floor: { value: 90, display: false }, title: "1-клавишный выключатель" },
    light_switch_double: { id: 578, group: "switches", width: 14, height: 18, self_height: 0, plan: { light_connections: 29 }, anchor: "wall", over_floor: { value: 90, display: false }, title: "2-клавишный выключатель" },
    chandelier: { id: 35, group: "lights", width: 24, height: 24, self_height: 0, plan: { light: 10 }, anchor: "free", over_floor: false, title: "Люстра" },
    socket_power: { id: 568, group: "sockets", width: 14, height: 14, self_height: 0, plan: { sockets: 9 }, anchor: "wall", over_floor: { value: 30, display: false }, title: "Розетка силовая" },
    socket_380: { id: 569, group: "sockets", width: 14, height: 14, self_height: 0, plan: { sockets: 9 }, anchor: "wall", over_floor: { value: 30, display: false }, title: "Розетка 380В" },
    wall_spot: { id: 47, group: "lights", width: 14, height: 12, self_height: 0, plan: { light: 10 }, anchor: "wall", over_floor: { value: 140, display: true }, title: "Настенный светильник" },
    waterspot_cold: { id: 640, group: "waterspots", width: 20, height: 20, self_height: 0, plan: { waterplan: 7 }, anchor: "wall", over_floor: { value: 50, display: false }, title: "Вывод холодной воды" },
    sofa: { id: 1, group: "furniture", width: 200, height: 90, self_height: 0, plan: { furniture: 6 }, anchor: "free", over_floor: false, title: "Диван" },
    lightspot: { id: 30, group: "lights", width: 10, height: 10, self_height: 0, plan: { light: 10 }, anchor: "free", over_floor: false, title: "Светильник точечный" },
    bra: { id: 41, group: "lights", width: 14, height: 12, self_height: 0, plan: { light: 10 }, anchor: "wall", over_floor: { value: 140, display: true }, title: "Бра" },
  };
  const raw = CATALOG[name];
  assert.ok(raw, `нет каталога для ${name}`);
  return toToolEntry(name, raw);
}

function addItemByName(model: Model, name: string, position: Record<string, unknown>, extra: Record<string, unknown> = {}): ItemProps {
  return addItem(model, {
    name,
    position: position as never,
    catalogEntry: elecEntry(name),
    ...extra,
  } as never);
}

const topWall = (m: Model): string => {
  const w = Object.values(m.walls).find((w) => w.p1.y === w.p2.y)!;
  assert.ok(w, "нет горизонтальной стены");
  return w.id;
};
const rightWall = (m: Model): string => {
  const w = Object.values(m.walls).find((w) => w.p1.x === w.p2.x && w.p1.x === 410)!;
  assert.ok(w, "нет правой стены");
  return w.id;
};

// ---------- состав раздела ----------

test("88: состав раздела — выключатели SWITCH_MAX_KEYS и светильники связи соответствуют классу Cabling", () => {
  assert.deepEqual(SWITCH_MAX_KEYS, {
    light_switch: 1, light_switch_double: 2, light_switch_triple: 3,
    light_switch_through: 1, light_switch_through_double: 2,
    light_switch_cross: 1, light_switch_cross_double: 2, light_dimmer: 1000,
  });
  for (const lamp of ["chandelier", "lightspot", "bra", "wall_spot", "hanging_light", "track_single", "fan", "armstrong_light"]) {
    assert.ok(CABLE_LAMP_ITEMS.has(lamp), lamp);
  }
  // шины/ленты — следующий этап (обратная ссылка на полосе не снята пробой)
  for (const strip of ["led_strip", "line_light", "recessed_strip", "surface_stripe", "pendent_strip"]) {
    assert.ok(!CABLE_LAMP_ITEMS.has(strip), strip);
  }
});

test("88: эталоны UI — розетка и выключатель пишутся группой socket_group с vd у over_floor", () => {
  for (const name of ["socket", "socket_ip44", "light_switch", "light_switch_double"]) {
    const fx = JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-elec-${name}.json`), "utf8")) as { model_object: ItemProps };
    const it = fx.model_object;
    assert.equal(it.name, "socket_group", name);
    const subs = it.socket_group as Array<{ name: string; id: string; center?: unknown }>;
    assert.equal(subs.length, 1, name);
    assert.equal(subs[0]!.name, name, name);
    const of = it.over_floor as { value: number; display: boolean; vd: number };
    if (name.startsWith("light_switch")) {
      assert.deepEqual([of.value, of.display, of.vd], [90, true, 90], name);
    } else {
      assert.deepEqual([of.value, of.display, of.vd], [30, true, 30], name);
    }
    // самостоятельные розетки — отдельные предметы
    for (const st of ["socket_power", "socket_380"]) {
      const fx2 = JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-elec-${st}.json`), "utf8")) as { model_object: ItemProps };
      assert.equal(fx2.model_object.name, st);
      assert.ok(Array.isArray(fx2.model_object.socket_group) === false || (fx2.model_object.socket_group as unknown[]).length === 0);
    }
  }
});

test("88: item_add socket — группа с под-розеткой, plan листа, pc у внутренней грани, angle = ось+180", () => {
  const m = baseModel();
  const item = addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  assert.equal(item.name, "socket_group");
  assert.deepEqual(item.plan, { sockets: 9 });
  assert.equal(item.angle, 180); // верхняя стена: ось 0 → 180
  assert.equal(item.height, 14);
  assert.equal(item.pc.y, 7); // 7 см от внутренней грани (ось y=-10, глубина 20)
  const subs = item.socket_group as Array<{ name: string; id: string; real_center: { x: number; y: number }; center: { x: number; y: number } }>;
  assert.equal(subs.length, 1);
  assert.equal(subs[0]!.name, "socket");
  assert.deepEqual(subs[0]!.real_center, { x: 97, y: 7 }); // 7 см от внутренней грани y=0
  assert.deepEqual(subs[0]!.center, { x: 97, y: 7 }); // h=14 → center совпадает
  assert.equal(item.id_wall, topWall(m));
  // выключатель: angle = ось+180 (правая стена: ось 90 → -90), pc на 9 см от грани, center на 7
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: rightWall(m), offsetMm: 500 } });
  assert.equal(sw.name, "socket_group");
  assert.equal(sw.angle, -90);
  assert.equal(sw.height, 18);
  const swSubs = sw.socket_group as Array<{ center: { x: number; y: number }; real_center: { x: number; y: number } }>;
  assert.equal(swSubs[0]!.real_center.x, 391); // грань x=400, pc на 9 см внутрь
  assert.equal(swSubs[0]!.center.x, 393); // center на 7 см от грани
  assert.equal((sw.over_floor as { value: number }).value, 90);
});

test("ревью 209 №3: выключатель на вогнутой стене L-комнаты — center под-элемента по правилу пробной точки (17 см от оси)", () => {
  // L-комната (0,0)-(400,0)-(400,100)-(100,100)-(100,400)-(0,400), вогнутое ребро
  // (400,100)→(100,100). Центр вершин (166.7,166.7) лежит СНАРУЖИ этого ребра,
  // поэтому старое правило «нормаль к центру комнаты» ставило center на 21 см от
  // оси вместо 17 (проба ниже — независимые значения, не из кода):
  // pc: вдоль 100 + 7 = 107 от p1 → x = 293; внутрь 10 + 9 = 19 → y = 81
  // center: 17 см от оси → y = 83 (10 полутолщина стены + 7 полупластина)
  const m: Model = { v: 0, id: "model", plan_id: "plan", walls: {}, items: {}, pillars: {}, total_height: 300, final: false };
  m.walls["wconcave"] = {
    id: "wconcave", plan: "a", role: "wall", depth: 20, height: 270, material: "a_block", holes: {},
    p1: { x: 400, y: 100 }, p2: { x: 100, y: 100 },
  };
  m.rooms2 = {
    lroom: {
      polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 400 }, { x: 0, y: 400 }],
      area: 5,
    } as never,
  };
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: "wconcave", offsetMm: 1000 } });
  assert.deepEqual(sw.pc, { x: 293, y: 81 });
  assert.equal(sw.angle, 180);
  assert.equal(sw.id_room, "lroom");
  const sub = (sw.socket_group as Array<{ real_center: { x: number; y: number }; center: { x: number; y: number }; center_prs: { x: number; y: number } }>)[0]!;
  assert.deepEqual(sub.real_center, { x: 293, y: 81 });
  assert.deepEqual(sub.center, { x: 293, y: 83 });
  assert.deepEqual(sub.center_prs, { x: 293, y: 83 });
});

// ---------- ревью 211 №4: ветки wallInwardNormal на реальной фикстуре ----------
// Значения независимые: под-элемент лежит в 17 см от оси стены на стороне pc
// (7 см от лица стены + 10 полутолщина). (а) ловит мутацию «якорь пробы —
// середина стены»: у w5 середина (300,0) лежит в Т-узле с перегородкой w6,
// проба там выбирает коридор, а предмет стоит в комнате ниже. (б) ловит
// мутацию «запасная ветка (обе пробы или ни одной) всегда nl»: у перегородки
// w6 пробы по обе стороны попадают в разные комнаты → сторона pc.

function corridorFixtureModel(): Model {
  const env = JSON.parse(readFileSync(join(here, "../fixtures/editor-corridor-3rooms.json"), "utf8")) as { model: Model };
  return structuredClone(env.model);
}

test("ревью 211 №4а: выключатель на w5 у Т-узла с перегородкой — якорь пробы = проекция pc (center 17,−17), не середина стены", () => {
  const m = corridorFixtureModel();
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: "w5", offsetMm: 0, from: "start" } });
  // pc: вдоль 0 + width/2 = 7 от p1 (10,0) → x=17; внутрь комнаты _uwwgk:
  // грань y=−10, pc на 9 см → y=−19
  assert.deepEqual(sw.pc, { x: 17, y: -19 });
  assert.equal(sw.id_room, "_uwwgk");
  const sub = (sw.socket_group as Array<{ center: { x: number; y: number } }>)[0]!;
  // 17 см от оси на стороне pc; мутация «якорь = середина стены» даёт (17,−21)
  assert.deepEqual(sub.center, { x: 17, y: -17 });
});

test("ревью 211 №4б: выключатель на перегородке w6 — запасная ветка (обе пробы в разных комнатах) берёт сторону pc, center (283,−283)", () => {
  const m = corridorFixtureModel();
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: "w6", offsetMm: 0, from: "start" } });
  assert.equal(sw.id_room, "_uwwgk");
  const sub = (sw.socket_group as Array<{ center: { x: number; y: number } }>)[0]!;
  // вдоль: −290 + 7 = −283; поперёк: грань x=290, center на 7 см в сторону pc
  // (283); мутация «запасная ветка всегда nl» даёт (279,−283)
  assert.deepEqual(sub.center, { x: 283, y: -283 });
});

test("88: item_add socket_power/socket_380 — самостоятельные предметы, over_floor {value, display:true} без vd", () => {
  const m = baseModel();
  for (const name of STANDALONE_SOCKETS) {
    if (name === "ceiling_socket" || name === "floor_socket") continue; // anchor ceiling — отдельная проба
    const item = addItemByName(m, name, { againstWall: { wallId: topWall(m), offsetMm: 500 } });
    assert.equal(item.name, name, name);
    const of = item.over_floor as { value: number; display: boolean; vd?: number };
    assert.deepEqual([of.value, of.display], [30, true], name);
    assert.equal(of.vd, undefined, name);
  }
});

test("88: item_add отклоняет cable и wires с подсказкой инструмента", () => {
  const m = baseModel();
  assert.throws(() => addItemByName(m, "cable", { againstWall: { wallId: topWall(m), offsetMm: 100 } }),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("cable_add"));
  assert.throws(() => addItemByName(m, "wire", { againstWall: { wallId: topWall(m), offsetMm: 100 } }),
    (e: unknown) => e instanceof McpError);
});

// ---------- связь «выключатель → светильник» ----------

function scenario(): { m: Model; sw: ItemProps; lamp: ItemProps } {
  const m = baseModel();
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: topWall(m), offsetMm: 500 } });
  const lamp = addItemByName(m, "chandelier", { center: { x: 1500, y: 1500 } });
  return { m, sw, lamp };
}

test("88: cable_add — вершина выключателя <gid>|s|<sub>, светильник по id, длина в метрах, on_arc 1", () => {
  const { m, sw, lamp } = scenario();
  const sub = (sw.socket_group as Array<{ id: string; center: { x: number; y: number } }>)[0]!;
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  assert.equal(cable.type, "cable");
  assert.equal(cable.on_arc, 1);
  assert.equal(cable.color_custom, "");
  assert.deepEqual(parseSwitchVertexId(cable.vertexes[0]!.id), [sw.id, sub.id]);
  assert.equal(cable.vertexes[0]!.type, "switch");
  assert.deepEqual(cable.vertexes[0]!.point, sub.center);
  assert.equal(cable.vertexes[1]!.id, lamp.id);
  assert.equal(cable.vertexes[1]!.type, "lamp");
  assert.deepEqual(cable.vertexes[1]!.point, lamp.pc);
  assert.deepEqual(cable.items, { [cable.vertexes[0]!.id]: "switch", [lamp.id]: "lamp" });
  const lenCm = Math.hypot(lamp.pc.x - sub.center!.x, lamp.pc.y - sub.center!.y);
  assert.equal(cable.length, Math.round(lenCm) / 100);
  // обратные ссылки в обе стороны
  assert.deepEqual((sw.socket_group as Array<{ cables?: { cable_id: string[] } }>)[0]!.cables, { cable_id: [cable.id] });
  assert.deepEqual((m.items[lamp.id] as ItemProps & { cables?: { cable_id: string } }).cables, { cable_id: cable.id });
  assert.deepEqual(cablesReferencingItem(m, sw.id).map((c) => c.id), [cable.id]);
  assert.deepEqual(cablesReferencingItem(m, lamp.id).map((c) => c.id), [cable.id]);
});

test("88: cable_add — лимит клавиш выключателя и занятый светильник отклоняются атомарно", () => {
  const { m, sw, lamp } = scenario();
  const c1 = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const lamp2 = addItemByName(m, "lightspot", { center: { x: 2500, y: 1500 } });
  // light_switch — 1 ключ: вторая связь отклоняется
  assert.throws(() => addCable(m, { switchItemId: sw.id, lampItemId: lamp2.id }),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT");
  assert.equal(Object.keys(m.cables ?? {}).length, 1);
  assert.equal((lamp2 as ItemProps & { cables?: unknown }).cables, undefined);
  // double — 2 ключа, третий отклоняется
  const sw2 = addItemByName(m, "light_switch_double", { againstWall: { wallId: topWall(m), offsetMm: 3000 } });
  addCable(m, { switchItemId: sw2.id, lampItemId: lamp2.id });
  const lamp3 = addItemByName(m, "bra", { againstWall: { wallId: rightWall(m), offsetMm: 1000 } });
  addCable(m, { switchItemId: sw2.id, lampItemId: lamp3.id });
  const lamp4 = addItemByName(m, "wall_spot", { againstWall: { wallId: rightWall(m), offsetMm: 2000 } });
  assert.throws(() => addCable(m, { switchItemId: sw2.id, lampItemId: lamp4.id }),
    (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("ключей"));
  // уже подключённый светильник — отклонение
  assert.throws(() => addCable(m, { switchItemId: sw2.id, lampItemId: lamp2.id }),
    (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("уже подключён"));
  // не-светильник — отклонение
  const socket = addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 100 } });
  assert.throws(() => addCable(m, { switchItemId: sw2.id, lampItemId: socket.id }),
    (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("не подключается"));
});

test("88: cable_add — не-выключатель и не-светильник отклоняются (INVALID_ARGUMENT)", () => {
  const { m, lamp } = scenario();
  const socket = addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 2000 } });
  assert.throws(() => addCable(m, { switchItemId: socket.id, lampItemId: lamp.id }),
    (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("нет выключателя"));
  const sofa = addItemByName(m, "sofa", { center: { x: 3000, y: 2500 } });
  const sw2 = addItemByName(m, "light_switch", { againstWall: { wallId: topWall(m), offsetMm: 3500 } });
  assert.throws(() => addCable(m, { switchItemId: sw2.id, lampItemId: sofa.id }),
    (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("не подключается"));
});

test("88: item_update переносит выключатель и светильник — под-розетки и вершины связи следуют, длина пересчитывается", () => {
  const { m, sw, lamp } = scenario();
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const len0 = cable.length;
  updateItem(m, { itemId: lamp.id, center: { x: 2500, y: 1500 } });
  assert.deepEqual(cable.vertexes[1]!.point, (m.items[lamp.id] as ItemProps).pc);
  assert.ok(cable.length > len0); // светильник отодвинули — длина выросла
  // выключатель: центр под-розетки переехал вместе с группой (смещение center относительно pc переносится)
  updateItem(m, { itemId: sw.id, center: { x: 3000, y: 1000 } });
  const swSubs = sw.socket_group as Array<{ center: { x: number; y: number }; real_center: { x: number; y: number } }>;
  assert.deepEqual(swSubs[0]!.real_center, { x: 300, y: 100 });
  assert.deepEqual(swSubs[0]!.center, { x: 300, y: 98 }); // прежнее смещение (0,-2): center на 7 см от грани, pc на 9
  assert.deepEqual(cable.vertexes[0]!.point, swSubs[0]!.center);
  assert.ok(cable.length > 0);
});

test("88: cable_delete — обратные ссылки сняты в обе стороны, потом item_delete проходит", () => {
  const { m, sw, lamp } = scenario();
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  assert.throws(() => deleteItem(m, lamp.id),
    (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("cable_delete"));
  assert.throws(() => deleteItem(m, sw.id),
    (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("cable_delete"));
  deleteCable(m, cable.id);
  assert.equal(m.cables![cable.id], undefined);
  assert.equal((sw.socket_group as Array<{ cables?: unknown }>)[0]!.cables, undefined);
  assert.equal((m.items[lamp.id] as ItemProps & { cables?: unknown }).cables, undefined);
  deleteItem(m, lamp.id);
  deleteItem(m, sw.id);
  assert.deepEqual(Object.keys(m.cables ?? {}), []);
});

test("88: refreshSocketGroupSubs перенос с поворотом — смещения под-розеток доворачиваются", () => {
  const m = baseModel();
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: topWall(m), offsetMm: 500 } });
  const before = JSON.parse(JSON.stringify((sw.socket_group as Array<{ center: { x: number; y: number } }>)[0]!.center));
  assert.deepEqual(before, { x: 47, y: 7 });
  updateItem(m, { itemId: sw.id, center: { x: 1000, y: 1000 }, angleDeg: 45 });
  const sub = (sw.socket_group as Array<{ center: { x: number; y: number }; real_center: { x: number; y: number } }>)[0]!;
  // смещение center относительно pc (0, -2) доворачивается на 45°
  const dx = sub.center.x - 100, dy = sub.center.y - 100;
  assert.ok(Math.abs(Math.hypot(dx, dy) - 2) < 1e-6);
  assert.ok(Math.abs(dx - 2 * Math.sin((45 * Math.PI) / 180)) < 1e-6 || Math.abs(dx + 2 * Math.sin((45 * Math.PI) / 180)) < 1e-6);
});

test("ревью 203 №8: перенос socket_group из 2 под-розеток against_wall — шаг между под-элементами сохранён", () => {
  const m = baseModel();
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: rightWall(m), offsetMm: 500 } });
  const subs = sw.socket_group as Array<{ id: string; center: { x: number; y: number }; real_center: { x: number; y: number }; center_prs: { x: number; y: number } }>;
  // вторая под-розетка — кликом рядом, шаг 7 см вдоль стены (правая стена вертикальна)
  const clone = structuredClone(subs[0]!);
  clone.id = "_sub2";
  clone.center = { x: clone.center.x, y: clone.center.y + 7 };
  clone.real_center = { x: clone.real_center.x, y: clone.real_center.y + 7 };
  clone.center_prs = { ...clone.center };
  subs.push(clone);
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
  const stepBefore = dist(subs[0]!.center, subs[1]!.center);
  assert.equal(stepBefore, 7);

  // перенос на верхнюю стену — те же аргументы, что у tools-plan item_update against_wall
  // (againstWallCenter возвращает центр в мм, updateItem принимает мм);
  // resnapToWall: true — как в tools-plan (ревью 206 №11): проверяем resnap-путь,
  // а не доворот по старому pc
  const top = m.walls[topWall(m)]!;
  const at = againstWallCenter(top, { offset_mm: 1000, gap_mm: 0 }, sw.width, sw.height, roomPolygons(m));
  updateItem(m, {
    itemId: sw.id,
    center: at.center,
    angleDeg: socketGroupAngleDeg(at.angleDeg),
    idWall: top.id,
    resnapToWall: true,
  });
  assert.equal(dist(subs[0]!.center, subs[1]!.center), stepBefore, "шаг center сохранён");
  assert.equal(dist(subs[0]!.real_center, subs[1]!.real_center), stepBefore, "шаг real_center сохранён");
  // обе под-розетки на внутренней стороне новой стены (center ближе к стене, чем pc)
  for (const s of subs) assert.ok(s.center.y <= sw.pc.y + 1e-9, "под-элемент со стороны стены");
  // эталон item_add: первая под-розетка там же, где поставила бы постановка с нуля
  const fresh = baseModel();
  const freshSw = addItemByName(fresh, "light_switch", { againstWall: { wallId: topWall(fresh), offsetMm: 1000 } });
  const freshSub = (freshSw.socket_group as Array<{ center: { x: number; y: number } }>)[0]!;
  assert.deepEqual(subs[0]!.center, freshSub.center);
});

test("ревью 203 №10: idWall сам по себе алгоритм пересчёта под-розеток не переключает — только явный resnapToWall", () => {
  const m = baseModel();
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: topWall(m), offsetMm: 500 } });
  // перенос с поворотом и записью id_wall БЕЗ resnapToWall — обычный путь:
  // смещение center относительно pc (0, -2) переносится с доворотом
  // (угол группы 180 → 90, доворот −90°) → (-2, 0)
  updateItem(m, { itemId: sw.id, center: { x: 2000, y: 1500 }, angleDeg: 90, idWall: topWall(m) });
  const carried = (sw.socket_group as Array<{ center: { x: number; y: number } }>)[0]!;
  assert.ok(Math.abs(carried.center.x - 198) < 1e-9 && Math.abs(carried.center.y - 150) < 1e-9,
    `без флага: прежнее смещение с доворотом, получили ${JSON.stringify(carried.center)}`);
  // тот же вызов С resnapToWall — нормальная составляющая ставится от стены заново:
  // вдоль (-2, 0) остаётся, нормаль от верхней стены → center на 7 см от лица стены
  updateItem(m, { itemId: sw.id, center: { x: 2000, y: 1500 }, angleDeg: 90, idWall: topWall(m), resnapToWall: true });
  const resnapped = (sw.socket_group as Array<{ center: { x: number; y: number } }>)[0]!;
  assert.ok(Math.abs(resnapped.center.x - 198) < 1e-9 && Math.abs(resnapped.center.y - 148) < 1e-9,
    `с флагом: нормаль от новой стены, получили ${JSON.stringify(resnapped.center)}`);
});

// ---------- реестр коллекций и компакт ----------

test("88: реестр коллекций — cables в clear/import, пустой проект не ломается", () => {
  const m = baseModel();
  assert.ok((MODEL_ENTITY_COLLECTIONS as readonly string[]).includes("cables"));
  const { sw, lamp } = { sw: addItemByName(m, "light_switch", { againstWall: { wallId: topWall(m), offsetMm: 500 } }), lamp: addItemByName(m, "chandelier", { center: { x: 1500, y: 1500 } }) };
  addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  clearEntityCollections(m);
  assert.equal(m.cables, undefined);
  assert.deepEqual(m.walls, {});
  const source = baseModel();
  const sw2 = addItemByName(source, "light_switch", { againstWall: { wallId: topWall(source), offsetMm: 500 } });
  const lamp2 = addItemByName(source, "chandelier", { center: { x: 1500, y: 1500 } });
  addCable(source, { switchItemId: sw2.id, lampItemId: lamp2.id });
  clearEntityCollections(m);
  replaceEntityCollections(m, source);
  assert.equal(Object.keys(m.cables ?? {}).length, 1);
});

test("88: компакт — метки CB с раздельными switch_item_id/switch_sub_id/lamp_item_id и длиной в мм (ревью 90 R5)", () => {
  const m = baseModel();
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: topWall(m), offsetMm: 500 } });
  const lamp = addItemByName(m, "chandelier", { center: { x: 1500, y: 1500 } });
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const c = compactModel(m);
  assert.equal(c.cables.length, 1);
  const cb = c.cables[0]!;
  assert.equal(cb.id, "CB1");
  assert.equal(cb.site_id, cable.id);
  const sub = (sw.socket_group as Array<{ id: string }>)[0]!;
  assert.equal(cb.switch_item_id, sw.id);
  assert.equal(cb.switch_sub_id, sub.id);
  assert.equal(cb.lamp_item_id, lamp.id);
  assert.ok(!JSON.stringify(cb).includes("|s|"), "id не склеены разделителем");
  assert.equal(cb.vertexes, 2);
  assert.equal(cb.length_mm, Math.round(cable.length * 1000));
  // ревью 90 R5: под-розетки и высота установки видны в компактных items
  const csw = c.items.find((it) => it.name === "socket_group")!;
  assert.ok(csw, "выключатель в компактных items");
  assert.equal(csw.over_floor_mm, 900);
  assert.equal(csw.socket_group!.length, 1);
  assert.equal(csw.socket_group![0]!.id, sub.id);
  assert.equal(csw.socket_group![0]!.name, "light_switch");
  const subCenter = (sw.socket_group as Array<{ center: { x: number; y: number } }>)[0]!.center;
  assert.equal(csw.socket_group![0]!.x_mm, Math.round(subCenter.x * 10));
  assert.equal(csw.socket_group![0]!.y_mm, Math.round(subCenter.y * 10));
});

// ---------- mock save (подмена writeBackup/loadModel/openEditor) ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm) {
      normalized = structuredClone(mm as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
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

function switchLampScenario(): { m: Model; sw: ItemProps; lamp: ItemProps } {
  const m = baseModel();
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: topWall(m), offsetMm: 500 } });
  const lamp = addItemByName(m, "chandelier", { center: { x: 1500, y: 1500 } });
  return { m, sw, lamp };
}

test("88: mock save — связь и обратные ссылки доходят до серверной модели, verified", async () => {
  const { m } = switchLampScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  ws.apply("add-cable", (mm) => {
    const sw = Object.values(mm.items).find((i) => (i.socket_group as Array<{ name?: string }>)?.some((s) => s.name === "light_switch"))!;
    const lamp = Object.values(mm.items).find((i) => i.name === "chandelier")!;
    addCable(mm, { switchItemId: sw.id, lampItemId: lamp.id });
    return true;
  });
  const res = await ws.save();
  assert.equal(res.verified, true);
  const sm = server.model as { cables?: Record<string, Cable> };
  assert.equal(Object.keys(sm.cables ?? {}).length, 1);
});

test("88: mock save — редактор дописал id_room вершинам и переставил их местами → verified без ложной блокировки", async () => {
  const { m } = switchLampScenario();
  const sw = Object.values(m.items).find((i) => (i.socket_group as Array<{ name?: string }>)?.some((s) => s.name === "light_switch"))!;
  const lamp = Object.values(m.items).find((i) => i.name === "chandelier")!;
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const c = (norm as { cables?: Record<string, Cable> }).cables![cable.id]!;
    const [a, b] = c.vertexes;
    c.vertexes = [structuredClone(b!), structuredClone(a!)];
    c.vertexes[0]!.id_room = "synthetic-room";
    c.vertexes[1]!.id_room = "synthetic-room";
    // items — карта id→тип: от перестановки вершин в массиве не меняется;
    // matrix 2×2 с ребром симметрична — тоже
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("88: mock save — редактор потерял связь при нормализации → NORMALIZATION_DROPPED, записи нет", async () => {
  const { m } = switchLampScenario();
  const sw = Object.values(m.items).find((i) => (i.socket_group as Array<{ name?: string }>)?.some((s) => s.name === "light_switch"))!;
  const lamp = Object.values(m.items).find((i) => i.name === "chandelier")!;
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    delete (norm as { cables?: Record<string, unknown> }).cables![cable.id];
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => e instanceof McpError && (e as McpError).code === "NORMALIZATION_DROPPED");
  // запись не состоялась: серверная модель не изменилась (в mock — исходная с кабелем)
  assert.equal(Object.keys((server.model as { cables?: Record<string, unknown> }).cables ?? {}).length, 1);
});

test("88: mock save — сервер испортил связь (узел сместился, ребро потеряно, длина изменена) → SITE_ERROR с cables_mismatches", async () => {
  const { m } = switchLampScenario();
  const sw = Object.values(m.items).find((i) => (i.socket_group as Array<{ name?: string }>)?.some((s) => s.name === "light_switch"))!;
  const lamp = Object.values(m.items).find((i) => i.name === "chandelier")!;
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (srv) => {
    // порча на СТОРОНЕ СЕРВЕРА (после записи): pre-save сверка не задета,
    // пост-сверка после save по GET должна отвергнуть
    const c = (srv.model as { cables?: Record<string, Cable> }).cables![cable.id]!;
    c.vertexes[1]!.point = { x: 999, y: 999 };
    c.matrix[0]![1] = null;
    c.matrix[1]![0] = null;
    c.length = 3.33;
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const ok = e instanceof McpError && (e as McpError).code === "SITE_ERROR";
    if (ok) {
      const det = (e as McpError).details as Record<string, unknown>;
      assert.ok(Array.isArray(det["cables_mismatches"]) && (det["cables_mismatches"] as string[]).length > 0);
    }
    return ok;
  });
});

test("88: mock save — сервер оторвал обратную ссылку светильника → SITE_ERROR (cables_connection_mismatches)", async () => {
  const { m } = switchLampScenario();
  const sw = Object.values(m.items).find((i) => (i.socket_group as Array<{ name?: string }>)?.some((s) => s.name === "light_switch"))!;
  const lamp = Object.values(m.items).find((i) => i.name === "chandelier")!;
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (srv) => {
    const lamp = Object.values(srv.model.items as Record<string, ItemProps & { cables?: unknown }>).find((i) => i.name === "chandelier")!;
    delete lamp.cables;
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const ok = e instanceof McpError && (e as McpError).code === "SITE_ERROR";
    if (ok) {
      const det = (e as McpError).details as Record<string, unknown>;
      assert.ok(Array.isArray(det["cables_connection_mismatches"]) && (det["cables_connection_mismatches"] as string[]).length > 0);
    }
    return ok;
  });
});

// ---------- ревью 90 R1: состав под-розеток при нормализации и после save ----------

test("90 R1: mock save — нормализация потеряла под-розетку → NORMALIZATION_DROPPED, записи нет", async () => {
  const m = baseModel();
  addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const it = Object.values(norm.items as Record<string, ItemProps>).find((i) => i.name === "socket_group")!;
    delete it.socket_group;
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => e instanceof McpError && (e as McpError).code === "NORMALIZATION_DROPPED");
  // запись не состоялась: у серверной группы под-розетка на месте
  const srvIt = Object.values((server.model as { items: Record<string, ItemProps> }).items).find((i) => i.name === "socket_group")!;
  assert.ok(Array.isArray(srvIt.socket_group) && srvIt.socket_group.length === 1);
});

test("90 R1: mock save — сервер потерял под-розетку после save → SITE_ERROR (socket_group_mismatches)", async () => {
  const m = baseModel();
  addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (srv) => {
    const it = Object.values((srv.model as { items: Record<string, ItemProps> }).items).find((i) => i.name === "socket_group")!;
    delete it.socket_group;
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const ok = e instanceof McpError && (e as McpError).code === "SITE_ERROR";
    if (ok) {
      const det = (e as McpError).details as Record<string, unknown>;
      assert.ok(Array.isArray(det["socket_group_mismatches"]) && (det["socket_group_mismatches"] as string[]).some((s) => s.includes("потеряна")));
    }
    return ok;
  });
});

test("90 R1: mock save — смена типа/смена высоты под-розетки → NORMALIZATION_DROPPED", async () => {
  const cases: Array<(it: ItemProps) => void> = [
    // смена типа под-розетки
    (it) => { (it.socket_group as Array<{ name: string }>)[0]!.name = "socket_usb"; },
    // смена высоты установки группы
    (it) => { (it.over_floor as { value: number }).value = 999; },
  ];
  let n = 0;
  for (const mutate of cases) {
    n++;
    const m = baseModel();
    addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server, () => {}, (norm) => {
      const it = Object.values(norm.items as Record<string, ItemProps>).find((i) => i.name === "socket_group")!;
      mutate(it);
    });
    await ws.open("0", "1");
    await assert.rejects(() => ws.save(), (e: unknown) => {
      const ok = e instanceof McpError && (e as McpError).code === "NORMALIZATION_DROPPED";
      if (ok) {
        const det = (e as McpError).details as Record<string, unknown>;
        assert.ok(Array.isArray(det["socket_group_mismatches"]) && (det["socket_group_mismatches"] as string[]).length > 0, `кейс ${n}`);
      }
      return ok;
    }, `кейс ${n}`);
  }
});

// ---------- ревью 92 R1a: производная геометрия под-розеток не блокирует save ----------

test("92 R1a: mock save — нормализатор пересчитал center/real_center/vd → verified=true, rounds=1", async () => {
  const { m, sw, lamp } = switchLampScenario();
  addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    // сценарий ревьюера R1-derived-recalc: пересчёт производных полей при нормализации
    const it = Object.values(norm.items as Record<string, ItemProps>).find((i) => i.name === "socket_group")!;
    (it.socket_group as Array<{ center: { x: number; y: number }; real_center: { x: number; y: number } }>)[0]!.center = { ...it.pc! };
    (it.socket_group as Array<{ real_center: { x: number; y: number } }>)[0]!.real_center = { ...it.pc! };
    (it.over_floor as { vd: number }).vd = 95;
    it.id_wall = "0";
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

test("92 R1a: mock save — moveWall + refreshSocketGroupSubs при нормализации → verified=true, rounds=1", async () => {
  const { m, sw, lamp } = switchLampScenario();
  addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const wid = topWall(m);
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    // редактор при нормализации пересчитал под-розетки вслед за перенесённой стеной
    const it = Object.values(norm.items as Record<string, ItemProps>).find((i) => i.name === "socket_group")!;
    refreshSocketGroupSubs(norm as unknown as Model, it);
  });
  await ws.open("0", "1");
  ws.apply("move-wall", (mm) => { moveWall(mm, { wallId: wid, offsetMm: 100 }); });
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

test("92 R1a: mock save — deleteWall + refreshSocketGroupSubs при нормализации → verified=true, rounds=1", async () => {
  const { m, sw, lamp } = switchLampScenario();
  addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const wid = topWall(m);
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const it = Object.values(norm.items as Record<string, ItemProps>).find((i) => i.name === "socket_group")!;
    refreshSocketGroupSubs(norm as unknown as Model, it);
  });
  await ws.open("0", "1");
  ws.apply("delete-wall", (mm) => { deleteWall(mm, wid); });
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

test("92 R1a: mock save — у модели нет real_center, совпадающее отсутствие не расхождение → verified=true", async () => {
  const { m, sw, lamp } = switchLampScenario();
  addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  delete (sw.socket_group as Array<{ real_center?: unknown }>)[0]!.real_center;
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

test("92 R1a: mock save — группа без cables, нормализатор пересчитал производные → verified=true, rounds=1", async () => {
  const m = baseModel();
  addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const it = Object.values(norm.items as Record<string, ItemProps>).find((i) => i.name === "socket_group")!;
    (it.socket_group as Array<{ center: { x: number; y: number } }>)[0]!.center = { x: it.pc!.x, y: it.pc!.y + 3 };
    (it.over_floor as { vd: number }).vd = 35;
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

// ---------- ревью 92 R1b: потеря over_floor.value не проходит молча ----------

const OVER_FLOOR_LOSS: Array<[string, (it: ItemProps) => void]> = [
  ["удаление over_floor", (it) => { delete it.over_floor; }],
  ["удаление value", (it) => { delete (it.over_floor as { value?: unknown }).value; }],
  ["замена нечисловым", (it) => { (it.over_floor as { value?: unknown }).value = "90"; }],
];

test("92 R1b: mock save — over_floor.value потерян при нормализации → NORMALIZATION_DROPPED", async () => {
  for (const [label, mutate] of OVER_FLOOR_LOSS) {
    const { m, sw, lamp } = switchLampScenario();
    addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server, () => {}, (norm) => {
      mutate(Object.values(norm.items as Record<string, ItemProps>).find((i) => i.name === "socket_group")!);
    });
    await ws.open("0", "1");
    await assert.rejects(() => ws.save(), (e: unknown) => {
      const ok = e instanceof McpError && (e as McpError).code === "NORMALIZATION_DROPPED";
      if (ok) {
        const det = (e as McpError).details as Record<string, unknown>;
        assert.ok(Array.isArray(det["socket_group_mismatches"]) && (det["socket_group_mismatches"] as string[]).some((s) => s.includes("over_floor.value")), `${label}: подробность`);
      }
      return ok;
    }, label);
  }
});

test("92 R1b: mock save — over_floor.value потерян только на сервере после save → SITE_ERROR", async () => {
  for (const [label, mutate] of OVER_FLOOR_LOSS) {
    const { m, sw, lamp } = switchLampScenario();
    addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server, (srv) => {
      mutate(Object.values((srv.model as { items: Record<string, ItemProps> }).items).find((i) => i.name === "socket_group")!);
    });
    await ws.open("0", "1");
    await assert.rejects(() => ws.save(), (e: unknown) => {
      const ok = e instanceof McpError && (e as McpError).code === "SITE_ERROR";
      if (ok) {
        const det = (e as McpError).details as Record<string, unknown>;
        assert.ok(Array.isArray(det["socket_group_mismatches"]) && (det["socket_group_mismatches"] as string[]).some((s) => s.includes("over_floor.value")), `${label}: подробность`);
      }
      return ok;
    }, label);
  }
});

// ---------- ревью 90 R2: связи с линиями не блокируют save, cable_delete снимает ссылку у линии ----------

/** Переносит цель связи из items в коллекцию световых линий (синтетический legacy-формат). */
function retargetToLine(m: Model, cable: Cable, collection: "led_strips" | "stripes_light" | "line_strips", vertexType: string): void {
  const lampId = cable.vertexes.find((v) => v.type === "lamp")!.id;
  const lamp = m.items[lampId]!;
  delete m.items[lampId];
  (m as unknown as Record<string, Record<string, unknown>>)[collection] = {
    [lampId]: {
      id: lampId, type: vertexType, length: 0, on_size: 1,
      props: { id: lampId, name: vertexType },
      vertexes: [], matrix: [], items: {},
    },
  };
  cable.vertexes.find((v) => v.id === lampId)!.type = vertexType;
  cable.items[lampId] = vertexType;
}

test("90 R2: mock save — существующая связь с led_strips/stripes_light/line_strips сохраняется (verified, без обратной ссылки на линии)", async () => {
  const cases: Array<["led_strips" | "stripes_light" | "line_strips", string]> = [
    ["led_strips", "led_strip"],
    ["stripes_light", "strip_light"],
    ["line_strips", "line_strip"],
  ];
  for (const [collection, vertexType] of cases) {
    const { m, sw, lamp } = switchLampScenario();
    const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
    retargetToLine(m, cable, collection, vertexType);
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server, () => {});
    await ws.open("0", "1");
    const res = await ws.save();
    assert.equal(res.verified, true, collection);
    assert.equal(res.rounds, 1, collection);
  }
});

test("90 R2: cable_delete снимает обратную ссылку и у световой линии (props.cables, скаляр и массив)", () => {
  for (const form of ["scalar", "array"] as const) {
    const { m, sw, lamp } = switchLampScenario();
    const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
    retargetToLine(m, cable, "led_strips", "led_strip");
    const line = m.led_strips![lamp.id]! as unknown as { props: { cables?: { cable_id?: unknown } } };
    line.props.cables = { cable_id: form === "scalar" ? cable.id : [cable.id] };
    deleteCable(m, cable.id);
    assert.equal(m.cables![cable.id], undefined, form);
    assert.equal(line.props.cables, undefined, form);
    // ссылка под-розетки тоже снята
    assert.equal((sw.socket_group as Array<{ cables?: unknown }>)[0]!.cables, undefined, form);
  }
});

// ---------- ревью 90 R3: держатель ссылки обязан быть вершиной кабеля ----------

test("90 R3: mock save — лишняя обратная ссылка (держатель не вершина) отвергается сверкой", async () => {
  const { m, sw, lamp } = switchLampScenario();
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const extra = addItemByName(m, "lightspot", { center: { x: 2500, y: 1500 } });
  (m.items[extra.id] as ItemProps & { cables: { cable_id: string } }).cables = { cable_id: cable.id };
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const ok = e instanceof McpError && (e as McpError).code === "NORMALIZATION_DROPPED";
    if (ok) {
      const det = (e as McpError).details as Record<string, unknown>;
      const conn = (det["cables_connection_mismatches"] ?? det["cables_mismatches"]) as string[] | undefined;
      assert.ok(Array.isArray(conn) && conn.some((s) => s.includes("не является вершиной связи")));
    }
    return ok;
  });
});

test("90 R3: cable_delete снимает и висячую ссылку держателя вне вершин связи", () => {
  const { m, sw, lamp } = switchLampScenario();
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const extra = addItemByName(m, "lightspot", { center: { x: 2500, y: 1500 } });
  (m.items[extra.id] as ItemProps & { cables: { cable_id: string } }).cables = { cable_id: cable.id };
  deleteCable(m, cable.id);
  assert.equal(m.cables![cable.id], undefined);
  assert.equal((m.items[extra.id] as ItemProps & { cables?: unknown }).cables, undefined);
  assert.equal((sw.socket_group as Array<{ cables?: unknown }>)[0]!.cables, undefined);
  assert.equal((m.items[lamp.id] as ItemProps & { cables?: unknown }).cables, undefined);
});

// ---------- ревью 90 R6: форма обратных ссылок (массив/скаляр) после save ----------

test("90 R6: mock save — сервер поменял форму ссылки (массив↔скаляр) → SITE_ERROR (cables_link_form_mismatches)", async () => {
  const { m, sw, lamp } = switchLampScenario();
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (srv) => {
    const items = (srv.model as { items: Record<string, ItemProps & { cables?: { cable_id: unknown } }> }).items;
    (Object.values(items).find((i) => (i.socket_group as Array<{ cables?: { cable_id: unknown } }>)?.some((s) => Array.isArray(s.cables?.cable_id)))!
      .socket_group as Array<{ cables: { cable_id: unknown } }>)[0]!.cables = { cable_id: cable.id };
    (items[lamp.id]!).cables = { cable_id: [cable.id] };
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const ok = e instanceof McpError && (e as McpError).code === "SITE_ERROR";
    if (ok) {
      const det = (e as McpError).details as Record<string, unknown>;
      assert.ok(Array.isArray(det["cables_link_form_mismatches"]) && (det["cables_link_form_mismatches"] as string[]).length >= 2);
    }
    return ok;
  });
});

test("90 R6: mock save — legacy-модель (скаляр у под-розетки) сохраняется без ложной блокировки", async () => {
  const { m, sw, lamp } = switchLampScenario();
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  // legacy: у под-розетки скаляр вместо массива (старая модель)
  (sw.socket_group as Array<{ cables: { cable_id: unknown } }>)[0]!.cables = { cable_id: cable.id };
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

// ---------- ревью 90 R4: согласованность кабельного эталона ----------

test("90 R4: кабельный эталон согласован — вершины = center/pc, длина по matrix, cable_id = id кабеля, round trip addCable", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-elec-cable.json"), "utf8")) as {
    model_cable: Cable;
    switch_item: ItemProps;
    lamp_item: ItemProps;
  };
  const cable = fx.model_cable;
  const sub = (fx.switch_item.socket_group as Array<{ id: string; center: { x: number; y: number } }>)[0]!;
  // вершина выключателя = center под-розетки, светильника = pc
  assert.deepEqual(cable.vertexes[0]!.point, sub.center);
  assert.deepEqual(cable.vertexes[1]!.point, fx.lamp_item.pc);
  // длина = длина по matrix (координаты вершин, 2 знака)
  const lenCm = Math.hypot(cable.vertexes[1]!.point.x - cable.vertexes[0]!.point.x, cable.vertexes[1]!.point.y - cable.vertexes[0]!.point.y);
  assert.equal(cable.length, Math.round(lenCm) / 100);
  assert.ok(cable.length > 0);
  // обратные ссылки — id этого кабеля (массив у под-розетки, скаляр у светильника)
  assert.deepEqual((fx.switch_item.socket_group as Array<{ cables: { cable_id: string[] } }>)[0]!.cables, { cable_id: [cable.id] });
  assert.deepEqual((fx.lamp_item as ItemProps & { cables: { cable_id: string } }).cables, { cable_id: cable.id });
  // операции → семантика эталона: addCable на модели из предметов эталона (ссылки
  // эталона сняты — их ставит сам addCable) даёт ту же связь
  const m = baseModel();
  const swItem = structuredClone(fx.switch_item);
  const lampItem = structuredClone(fx.lamp_item);
  delete (swItem.socket_group as Array<{ cables?: unknown }>)[0]!.cables;
  delete (lampItem as ItemProps & { cables?: unknown }).cables;
  m.items[swItem.id!] = swItem;
  m.items[lampItem.id!] = lampItem;
  const built = addCable(m, { switchItemId: swItem.id!, lampItemId: lampItem.id! });
  assert.deepEqual(built.vertexes.map((v) => [v.id, v.point, v.type]), cable.vertexes.map((v) => [v.id, v.point, v.type]));
  assert.equal(built.length, cable.length);
  assert.deepEqual(built.items, cable.items);
  assert.equal(built.on_arc, cable.on_arc);
  assert.equal(built.type, cable.type);
  assert.deepEqual((m.items[swItem.id!] as ItemProps & { socket_group: Array<{ cables: { cable_id: string[] } }> }).socket_group[0]!.cables, { cable_id: [built.id] });
  assert.deepEqual((m.items[lampItem.id!] as ItemProps & { cables: { cable_id: string } }).cables, { cable_id: built.id });
});

// ---------- регрессия прежних разделов ----------

test("88: регрессия — трубы и связи сосуществуют, item_delete отклоняет и трубу, и связь", () => {
  const { m, sw, lamp } = scenario();
  const cable = addCable(m, { switchItemId: sw.id, lampItemId: lamp.id });
  const spot = addItemByName(m, "waterspot_cold", { againstWall: { wallId: topWall(m), offsetMm: 2500 } });
  const pipe = addPipe(m, { kind: "water", path: [{ x: 500, y: 500 }, { itemId: spot.id }] });
  assert.throws(() => deleteItem(m, spot.id), (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("pipe_delete"));
  assert.throws(() => deleteItem(m, lamp.id), (e: unknown) => e instanceof McpError && String((e as McpError).message).includes("cable_delete"));
  deleteCable(m, cable.id);
  deleteItem(m, lamp.id);
  assert.ok(pipe);
  clearEntityCollections(m);
  assert.equal(m.cables, undefined);
  assert.equal(m.pipes, undefined);
});
