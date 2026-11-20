// Тёплая стена (этап 273): warm_wall_cable в rooms2[rid].warms_walls[edge].parts
// (WarmLine, лист «Тёплые полы»), кабель терморегулятора к тёплой стене
// (вершина {id части, point: центр линии, type: "warm_wall"}, ссылка в props
// части), guard'ы редактора (одно подключение на стену — l10n
// cabling_warm_floor_not_connect_same_wall, минимальная длина, пересечение
// частей, warm_wall_delete с кабелем — отказ), каскады (update → вершина
// кабеля, wiring_delete снимает ссылку), эталоны ui-ref-warmwall-* в обе
// стороны, сверка warmWallsCompare, mock save.
// Форматы — живые пробы 273-recon2/273-recon3 (протяжка вдоль ребра комнаты).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps, ElecCable } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addItem } from "../../src/model/items.ts";
import { warmWallAdd, warmWallUpdate, warmWallDelete, warmWallList, warmWallEntries, warmWallDistance } from "../../src/model/warmwall.ts";
import { addElecCable, deleteElecCable, elecLinkHolders } from "../../src/model/electric2.ts";
import { compactModel } from "../../src/model/compact.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import { McpError } from "../../src/errors.ts";
import { elecCableConnectionMismatches } from "../../src/verify/elec.ts";
import { warmWallsCompare } from "../../src/verify/warmwall.ts";
import type { GasLineSig } from "../../src/verify/graphs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const COMPAT = { planner_version: "3", global_version: 1, tools_bundle: "t.js" } as never;

function baseModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  const m = { ...structuredClone(model), walls: {} } as Model;
  addRoomRect(m, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  m.rooms2 = {
    r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never,
  };
  return m;
}

const CATALOG: Record<string, Record<string, unknown>> = {
  socket_thermo: { id: 44, group: "sockets", width: 14, height: 14, self_height: 0, plan: { warm_floor: 11 }, anchor: "wall", over_floor: { value: 90, display: true }, title: "Терморегулятор" },
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

/** Комната + терморегулятор + тёплая стена на верхнем ребре r1. */
function scenario(): { m: Model; thermo: ItemProps; thermoSubId: string; ww: ReturnType<typeof warmWallAdd> } {
  const m = baseModel();
  const thermo = addItem(m, { name: "socket_thermo", position: { againstWall: { wallId: topWall(m), offsetMm: 1000 } }, catalogEntry: entry("socket_thermo") } as never);
  // верхнее ребро r1: (0,0)→(400,0), «внутрь» — +y; участок 100..300 мм от (0,0)
  const ww = warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 1000, endMm: 3000 });
  const subs = thermo.socket_group as Array<{ id: string; name: string }>;
  const thermoSubId = subs.find((s) => s.name === "socket_thermo")!.id;
  return { m, thermo, thermoSubId, ww };
}

// ---------- эталон ui-ref-warmwall-line (обе стороны) ----------

/** Маска части тёплой стены для сверки с эталоном ЦЕЛИКОМ: id и производные
 *  (distance — размерная подпись get_distance, line_wall — демолиния после
 *  подрезки редактора, MCP пишет демолинию без подрезки) маскируются. */
function maskedPart(raw: unknown): Record<string, unknown> {
  const p = structuredClone(raw) as Record<string, unknown>;
  delete p["id"];
  delete p["distance"];
  delete p["line_wall"];
  const props = { ...(p.props as Record<string, unknown>) };
  delete props["id"];
  p.props = props;
  return p;
}

test("273: эталон ui-ref-warmwall-line — warm_wall_add воспроизводит формат редактора (обе стороны)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-warmwall-line.json"), "utf8"));
  const group = (fx.warms_walls as Array<Record<string, unknown>>)[1]!;
  const ref = (group.parts as Record<string, Record<string, unknown>>).id1!;
  // линия на демолинии ребра: ребро + 5 см внутрь комнаты
  assert.deepEqual(ref.line, { p1: { x: 100, y: 200 }, p2: { x: 119.86, y: 200 } });
  assert.equal(ref.type, "warm_wall_cable");
  assert.equal(ref.layer, 1);
  assert.equal(ref.height, 135);
  assert.equal(ref.height_from_floor, 15);
  assert.deepEqual(ref.props, { id: "id1", name: "warm_wall_cable" });
  // line_wall коллинеарен и содержит line (MCP пишет демолинию без подрезки)
  const lw = ref.line_wall as { p1: { x: number; y: number }; p2: { x: number; y: number } };
  assert.equal(lw.p1.y, 200);
  assert.ok(lw.p1.x <= (ref.line as { p1: { x: number } }).p1.x && lw.p2.x >= (ref.line as { p2: { x: number } }).p2.x);
  // расстояние подписи = длина + 5 за открытый конец демолинии (get_distance)
  const line = ref.line as { p1: { x: number; y: number }; p2: { x: number; y: number } };
  assert.equal(ref.distance, warmWallDistance(line, lw));

  // обратная сторона: warm_wall_add с теми же координатами
  const m = baseModel();
  // ребро 0 комнаты: (40.86,205)→(124.86,205), комната ВЫШЕ (y<205) — «внутрь» −y
  m.rooms2 = {
    r1: { polygon: [{ x: 40.86, y: 205 }, { x: 124.86, y: 205 }, { x: 124.86, y: 105 }, { x: 40.86, y: 105 }], area: 8 } as never,
  };
  const made = warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 591.4, endMm: 790 });
  const part = warmWallEntries(m).find((e) => e.part.id === made.id)!.part;
  assert.deepEqual(part.line, ref.line);
  assert.equal(part.type, "warm_wall_cable");
  assert.equal(part.layer, 1);
  assert.equal(part.height, 135);
  assert.equal(part.height_from_floor, 15);
  assert.deepEqual(part.props, { id: part.id, name: "warm_wall_cable" });
  assert.equal(part.distance, 24.9);
  // group-запись ребра: {exist: true, parts}
  const room = m.rooms2!.r1 as { warms_walls: Array<Record<string, unknown>> };
  assert.equal(room.warms_walls.length, 4);
  assert.deepEqual(room.warms_walls[0]!.exist, true);
  assert.deepEqual(room.warms_walls[1]!.exist, false);
  // маскированная форма части ≅ эталону (ЦЕЛИКОМ, не выборочные поля)
  assert.deepEqual(maskedPart(part), maskedPart(ref));
});

// ---------- эталон ui-ref-warmwall-wire (обе стороны) ----------

/** Маска кабеля для сверки с эталоном ЦЕЛИКОМ (как в 268): id → позиционные
 *  метки, point/pp/length маскируются (координаты синтетические, pp —
 *  производное протяжки, length — по точкам). */
function maskedCable(raw: unknown, labels: Record<string, string>): Record<string, unknown> {
  const w = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(w)) {
    if (k === "id" || k === "length") continue;
    if (k === "items") {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([ik, iv]) => [labels[ik] ?? ik, iv]));
    } else if (k === "vertexes") {
      out[k] = (v as Array<Record<string, unknown>>).map((vert) =>
        Object.fromEntries(
          Object.entries(vert)
            .filter(([vk]) => vk !== "point" && vk !== "pp")
            .map(([vk, vv]) => [vk, vk === "id" ? labels[String(vv)] ?? vv : vv]),
        ),
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

const vertexLabels = (c: ElecCable): Record<string, string> =>
  Object.fromEntries(c.vertexes.map((v, i) => [v.id, `v${i}`]));

test("273: эталон ui-ref-warmwall-wire — wiring_add warm_floor_wire к тёплой стене (обе стороны)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-warmwall-wire.json"), "utf8"));
  const ref = fx.cable as ElecCable;
  const wwV = ref.vertexes.find((v) => v.type === "warm_wall")!;
  // вершина тёплой стены: {id: id части, point: центр линии, type: "warm_wall"}
  const part = fx.warm_wall_part as { id: string; line: { p1: { x: number; y: number }; p2: { x: number; y: number } } };
  assert.equal(wwV.id, part.id);
  const center = { x: Math.round(((part.line.p1.x + part.line.p2.x) / 2) * 100) / 100, y: Math.round(((part.line.p1.y + part.line.p2.y) / 2) * 100) / 100 };
  assert.deepEqual(wwV.point, center);
  assert.equal(ref.items![wwV.id], "warm_wall");
  // ссылка в props ЧАСТИ (скаляр)
  assert.equal((fx.warm_wall_part.props as { cables_warm_floor: { cable_warm_floor_id: string } }).cables_warm_floor.cable_warm_floor_id, ref.id);
  assert.equal((fx.thermo.sub as { cables_warm_floor: { cable_warm_floor_id: string } }).cables_warm_floor.cable_warm_floor_id, ref.id);

  // обратная сторона: терморегулятор + тёплая стена + wiring_add (метка WW1)
  const { m, thermo, thermoSubId, ww } = scenario();
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: `WW1` }] });
  void ww;
  assert.equal(wire.type, "warm_floor_wire");
  assert.equal(wire.vertexes[0]!.id, `${thermo.id}|s|${thermoSubId}`);
  assert.equal(wire.vertexes[0]!.type, "socket_thermo");
  const partMade = warmWallEntries(m)[0]!.part;
  assert.equal(wire.vertexes[1]!.id, partMade.id);
  assert.equal(wire.vertexes[1]!.type, "warm_wall");
  assert.deepEqual(wire.vertexes[1]!.point, { x: (partMade.line.p1.x + partMade.line.p2.x) / 2, y: (partMade.line.p1.y + partMade.line.p2.y) / 2 });
  assert.equal(wire.items![partMade.id], "warm_wall");
  assert.equal((partMade.props as { cables_warm_floor?: { cable_warm_floor_id?: string } }).cables_warm_floor?.cable_warm_floor_id, wire.id);
  const subs = thermo.socket_group as Array<{ id: string; cables_warm_floor?: { cable_warm_floor_id?: string } }>;
  assert.equal(subs.find((s) => s.id === thermoSubId)!.cables_warm_floor?.cable_warm_floor_id, wire.id);
  // маскированный deepEqual кабеля целиком
  assert.deepEqual(maskedCable(wire, vertexLabels(wire)), maskedCable(ref, vertexLabels(ref)));
});

// ---------- guard'ы ----------

test("273: у тёплой стены одно подключение (l10n cabling_warm_floor_not_connect_same_wall)", () => {
  const { m, thermo, ww } = scenario();
  const thermo2 = addItem(m, { name: "socket_thermo", position: { againstWall: { wallId: topWall(m), offsetMm: 3000 } }, catalogEntry: entry("socket_thermo") } as never);
  addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: ww.id }] });
  assert.throws(
    () => addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo2.id }, { itemId: ww.id }] }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("уже подключена"),
  );
  assert.throws(
    () => addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo2.id }, { itemId: "WW1" }] }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  void ww;
});

test("273: warm_wall_delete с подключённым кабелем — отказ с подсказкой wiring_delete", () => {
  const { m, thermo, ww } = scenario();
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: ww.id }] });
  assert.throws(
    () => warmWallDelete(m, ww.id),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("wiring_delete"),
  );
  // после wiring_delete удаление возможно
  deleteElecCable(m, wire.id);
  const res = warmWallDelete(m, ww.id);
  assert.equal(res.room_id, "r1");
  assert.equal(warmWallEntries(m).length, 0);
  const room = m.rooms2!.r1 as { warms_walls: Array<{ exist: boolean; parts?: unknown }> };
  assert.equal(room.warms_walls[0]!.exist, false);
  assert.equal(room.warms_walls[0]!.parts, undefined);
});

test("273: минимальная длина и границы ребра — как в редакторе", () => {
  const m = baseModel();
  // короче 200 мм в середине ребра — отказ
  assert.throws(
    () => warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 1000, endMm: 1190 }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("короче"),
  );
  // 150 мм на конце ребра — допустимо (бонус открытого конца демолинии, get_distance)
  const short = warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 3850, endMm: 4000 });
  assert.equal(short.length_mm, 150);
  // за пределами ребра — отказ
  assert.throws(
    () => warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: -100, endMm: 1000 }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  assert.throws(
    () => warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 0, endMm: 4100 }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  // несуществующее ребро
  assert.throws(
    () => warmWallAdd(m, { roomRef: "r1", edge: 9, startMm: 0, endMm: 1000 }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("диапазон"),
  );
});

test("273: пересечение с существующей частью того же ребра — отказ; стык вплотную и другое ребро — допустимы", () => {
  const m = baseModel();
  warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 1000, endMm: 2000 });
  assert.throws(
    () => warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 1500, endMm: 2500 }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("пересекает"),
  );
  // вплотную — допустимо
  warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 2000, endMm: 3000 });
  assert.equal(warmWallEntries(m).length, 2);
  // на другом ребре — допустимо
  warmWallAdd(m, { roomRef: "r1", edge: 1, startMm: 0, endMm: 1000 });
  assert.equal(warmWallEntries(m).length, 3);
});

test("273: warm_wall_update — границы, высоты, вершина кабеля следует за центром линии", () => {
  const { m, thermo, ww } = scenario();
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: ww.id }] });
  const before = structuredClone(warmWallEntries(m)[0]!.part);
  const res = warmWallUpdate(m, { warmWallId: ww.id, startMm: 2000, endMm: 3000, heightMm: 1200, heightFromFloorMm: 100 });
  const part = warmWallEntries(m)[0]!.part;
  assert.equal(res.length_mm, 1000);
  assert.equal(part.height, 120);
  assert.equal(part.height_from_floor, 10);
  // линия сместилась, вершина кабеля = новый центр линии, длина пересчитана
  assert.deepEqual(part.line, { p1: { x: 200, y: 5 }, p2: { x: 300, y: 5 } });
  assert.deepEqual(part.line, res && part.line);
  const v = wire.vertexes.find((x) => x.type === "warm_wall")!;
  assert.deepEqual(v.point, { x: 250, y: 5 });
  const d = Math.hypot(wire.vertexes[0]!.point.x - v.point.x, wire.vertexes[0]!.point.y - v.point.y);
  assert.equal(wire.length, Math.round((d / 100) * 100) / 100);
  assert.notDeepEqual(part.line, before.line);
  // пересечение при update — отказ, модель не меняется
  warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 3100, endMm: 3600 });
  const snapshot = structuredClone(warmWallEntries(m).map((e) => e.part));
  assert.throws(
    () => warmWallUpdate(m, { warmWallId: ww.id, startMm: 3000, endMm: 3400 }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  assert.deepEqual(structuredClone(warmWallEntries(m).map((e) => e.part)), snapshot);
});

test("273: NOT_FOUND — несуществующие часть/комната", () => {
  const m = baseModel();
  assert.throws(() => warmWallUpdate(m, { warmWallId: "nope" }), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
  assert.throws(() => warmWallDelete(m, "nope"), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
  assert.throws(() => warmWallAdd(m, { roomRef: "zz", edge: 0, startMm: 0, endMm: 1000 }), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
});

test("273: warm_wall_list — метки WW<n>, кабель, фильтр по комнате", () => {
  const { m, thermo, ww } = scenario();
  addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: ww.id }] });
  const list = warmWallList(m);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.label, "WW1");
  assert.equal(list[0]!.id, ww.id);
  assert.equal(list[0]!.room_id, "r1");
  assert.equal(list[0]!.edge, 0);
  assert.equal(list[0]!.length_mm, 2000);
  assert.equal(list[0]!.height_mm, 1350);
  assert.equal(list[0]!.height_from_floor_mm, 150);
  assert.equal(list[0]!.cable, wire0(m));
  assert.equal(warmWallList(m, "r1").length, 1);
  assert.throws(() => warmWallList(m, "nope"), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
  function wire0(mm: Model): string {
    return Object.values(mm.cables_warm_floor ?? {})[0]!.id;
  }
});

// ---------- каскады и ссылки ----------

test("273: wiring_delete снимает ссылку части тёплой стены, часть свободна", () => {
  const { m, thermo, ww } = scenario();
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: ww.id }] });
  deleteElecCable(m, wire.id);
  const part = warmWallEntries(m)[0]!.part;
  assert.equal((part.props as { cables_warm_floor?: unknown }).cables_warm_floor, undefined);
  const wire2 = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: ww.id }] });
  assert.equal((warmWallEntries(m)[0]!.part.props as { cables_warm_floor?: { cable_warm_floor_id?: string } }).cables_warm_floor?.cable_warm_floor_id, wire2.id);
});

test("273: elecLinkHolders включает части тёплых стен; сверка связей ловит потерю ссылки (SITE_ERROR-сценарий)", () => {
  const { m, thermo, ww } = scenario();
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: ww.id }] });
  const holders = elecLinkHolders(m);
  assert.equal(holders[ww.id] !== undefined, true);
  assert.equal((holders[ww.id] as { name?: string }).name, "warm_wall_cable");
  const cables = { cables_warm_floor: { [wire.id]: structuredClone(wire) as unknown as GasLineSig } };
  const items = elecLinkHolders(m);
  assert.deepEqual(elecCableConnectionMismatches({ cables_warm_floor: cables.cables_warm_floor }, items, { cables_warm_floor: structuredClone(cables.cables_warm_floor) }, structuredClone(items)), []);
  // сервер стёр ссылку части — расхождение
  const gotItems = structuredClone(items);
  delete (gotItems[ww.id] as Record<string, unknown>).cables_warm_floor;
  const mis = elecCableConnectionMismatches({ cables_warm_floor: cables.cables_warm_floor }, items, { cables_warm_floor: structuredClone(cables.cables_warm_floor) }, gotItems);
  assert.ok(mis.some((x) => x.includes(ww.id) && x.includes("потерял обратную ссылку")), mis.join("; "));
});

// ---------- сверка warmWallsCompare ----------

test("273: warmWallsCompare — совпадение, потеря части, изменение высоты, лишняя часть", () => {
  const { m, thermo, ww } = scenario();
  addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: ww.id }] });
  const norm = structuredClone(m) as unknown as Record<string, unknown>;
  assert.deepEqual(warmWallsCompare(m as unknown as Record<string, unknown>, norm, "normalize"), { problems: [], warnings: [] });
  assert.deepEqual(warmWallsCompare(m as unknown as Record<string, unknown>, norm, "save"), { problems: [], warnings: [] });
  // сервер потерял часть — проблема (строгий путь)
  const lost = structuredClone(norm) as Record<string, unknown>;
  const room = (lost.rooms2 as Record<string, Record<string, unknown>>).r1!;
  (room.warms_walls as Array<Record<string, unknown>>)[0] = { exist: false };
  const cmp = warmWallsCompare(m as unknown as Record<string, unknown>, lost, "save");
  assert.ok(cmp.problems.some((x) => x.includes("потеряна тёплая стена")), cmp.problems.join("; "));
  // та же потеря в комнате, затронутой стенами, при normalize — предупреждение
  const cmpA = warmWallsCompare(m as unknown as Record<string, unknown>, lost, "normalize", { affectedRooms: new Set(["r1"]) });
  assert.deepEqual(cmpA.problems, []);
  assert.ok(cmpA.warnings.some((x) => x.includes("warmwall_topology_changed")), cmpA.warnings.join("; "));
  // потеря в НЕЗатронутой комнате — проблема и в normalize
  assert.ok(warmWallsCompare(m as unknown as Record<string, unknown>, lost, "normalize").problems.length > 0);
  // сервер изменил высоты — проблема
  const changed = structuredClone(norm) as Record<string, unknown>;
  const part2 = Object.values(((changed.rooms2 as Record<string, Record<string, unknown>>).r1!.warms_walls as Array<{ parts: Record<string, Record<string, unknown>> }>)[0]!.parts)[0]!;
  part2.height = 100;
  assert.ok(warmWallsCompare(m as unknown as Record<string, unknown>, changed, "save").problems.some((x) => x.includes("изменилась")), "");
  // лишняя часть на сервере — проблема
  const extra = structuredClone(norm) as Record<string, unknown>;
  const parts = ((extra.rooms2 as Record<string, Record<string, unknown>>).r1!.warms_walls as Array<{ parts: Record<string, Record<string, unknown>> }>)[1]!.parts ??= {};
  parts.extra1 = { id: "extra1", type: "warm_wall_cable", layer: 1, line: { p1: { x: 320, y: 5 }, p2: { x: 380, y: 5 } }, line_wall: { p1: { x: 0, y: 5 }, p2: { x: 400, y: 5 } }, height: 135, height_from_floor: 15, props: { id: "extra1", name: "warm_wall_cable" } };
  assert.ok(warmWallsCompare(m as unknown as Record<string, unknown>, extra, "save").problems.some((x) => x.includes("неожиданная тёплая стена")), "");
});

test("273: warmWallsCompare — split комнаты: часть, пережившая разрез по геометрии, — норма в normalize", () => {
  const { m, ww } = scenario();
  const exp = m as unknown as Record<string, unknown>;
  const got = structuredClone(exp) as Record<string, unknown>;
  // split: r1 разрезан на r1a/r1b (часть в нижней половине); id части редактор пересоздаёт
  const rooms = got.rooms2 as Record<string, Record<string, unknown>>;
  const part = structuredClone(Object.values(((rooms.r1!.warms_walls as Array<{ parts: Record<string, Record<string, unknown>> }>)[0]!).parts)[0]!) as Record<string, unknown>;
  part.id = "newid1";
  (part.props as Record<string, unknown>).id = "newid1";
  delete rooms.r1;
  rooms.r1a = { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 150 }, { x: 0, y: 150 }], area: 6 } as never;
  rooms.r1b = { polygon: [{ x: 0, y: 150 }, { x: 400, y: 150 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 6 } as never;
  rooms.r1a = rooms.r1a as { warms_walls: Array<Record<string, unknown>> };
  // часть (верхнее ребро y=5) пережила разрез в верхней половине r1a
  (rooms.r1a).warms_walls = [
    { exist: true, parts: { newid1: part } },
  ];
  const cmp = warmWallsCompare(exp, got, "normalize");
  assert.deepEqual(cmp.problems, []);
  assert.deepEqual(cmp.warnings, []);
  // в save (ожидание уже нормализовано, топология та же) потеря той же части — проблема
  assert.ok(warmWallsCompare(exp, got, "save").problems.length > 0);
  void ww;
});

// ---------- compact и mock save ----------

test("273: compactModel — тёплые стены не попадают в публичные коллекции (part внутри rooms2)", () => {
  const { m } = scenario();
  const compact = compactModel(m);
  assert.equal((compact as unknown as Record<string, unknown>).warm_walls, undefined);
  assert.equal((compact as unknown as Record<string, unknown>)["warms_walls"], undefined);
});

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm) {
      normalized = structuredClone(mm as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const c = { walls: Object.keys(mm.walls as Record<string, unknown>).length, holes: 0, items: 0, pillars: 0, rigels: 0 };
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

test("273: mock save — тёплая стена с кабелем сохраняется verified", async () => {
  const { m, thermo, ww } = scenario();
  addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: ww.id }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("273: mock save — сервер стёр ссылку части на кабель → SITE_ERROR", async () => {
  const { m, thermo, ww } = scenario();
  addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: ww.id }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const part = Object.values(((s.model.rooms2 as Record<string, Record<string, unknown>>).r1!.warms_walls as Array<{ parts: Record<string, Record<string, unknown>> }>)[0]!.parts)[0]!;
    delete (part.props as Record<string, unknown>).cables_warm_floor;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && (e as McpError).code === "SITE_ERROR");
});

test("273: mock save — нормализация потеряла тёплую стену → NORMALIZATION_DROPPED", async () => {
  const { m, ww } = scenario();
  void ww;
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const room = (norm.rooms2 as Record<string, Record<string, unknown>>).r1!;
    (room.warms_walls as Array<Record<string, unknown>>)[0] = { exist: false };
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && (e as McpError).code === "NORMALIZATION_DROPPED");
});
