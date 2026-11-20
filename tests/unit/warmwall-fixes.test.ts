// Резолюция ревью 274 (этап 275): находки №1 (метки WW<n> — одна нумерация по
// ПОЛНОМУ списку), №2 (тёплая стена — «контур» в правиле кабеля), №3 (рёбра
// комнаты в мм и метки R<n>), №5 (полная проекция сверкой), №6 (формула
// distance по get_distance бандла), №9/№10/№11. Форматы — эталоны 273.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addItem } from "../../src/model/items.ts";
import { warmWallAdd, warmWallUpdate, warmWallDelete, warmWallList, warmWallEntries, warmWallDistance } from "../../src/model/warmwall.ts";
import { addElecCable, deleteElecCable } from "../../src/model/electric2.ts";
import { addWarmFloor } from "../../src/model/climate.ts";
import { compactModel } from "../../src/model/compact.ts";
import { parseModelImport } from "../../src/model/import-schema.ts";
import { McpError } from "../../src/errors.ts";
import { warmWallsCompare } from "../../src/verify/warmwall.ts";

const here = dirname(fileURLToPath(import.meta.url));

function baseModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  const m = { ...structuredClone(model), walls: {} } as Model;
  addRoomRect(m, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  m.rooms2 = {
    r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never,
    r2: { polygon: [{ x: 500, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 300 }, { x: 500, y: 300 }], area: 12 } as never,
  };
  return m;
}

const CATALOG: Record<string, Record<string, unknown>> = {
  socket_thermo: { id: 44, group: "sockets", width: 14, height: 14, self_height: 0, plan: { warm_floor: 11 }, anchor: "wall", over_floor: { value: 90, display: true }, title: "Терморегулятор" },
};

function entry(name: string) {
  const raw = CATALOG[name]!;
  return { id: Number(raw.id), name, title: String(raw.title ?? name), group: String(raw.group), width: Number(raw.width), height: Number(raw.height), self_height: Number(raw.self_height ?? 0), plan: raw.plan as Record<string, number>, anchor: raw.anchor as string | undefined, over_floor: raw.over_floor as never };
}

const topWall = (m: Model): string => {
  const w = Object.values(m.walls).find((w) => w.p1.y === w.p2.y)!;
  assert.ok(w, "нет горизонтальной стены");
  return w.id;
};

// ---------- №1: метки WW<n> — одна нумерация по полному списку ----------

test("274 №1: метки WW<n> в warm_wall_list(room) — глобальные; update/delete/wiring по метке из фильтра попадают в ту же часть", () => {
  const m = baseModel();
  const thermo = addItem(m, { name: "socket_thermo", position: { againstWall: { wallId: topWall(m), offsetMm: 1000 } }, catalogEntry: entry("socket_thermo") } as never);
  const a = warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 500, endMm: 1500 });
  const b = warmWallAdd(m, { roomRef: "r2", edge: 0, startMm: 500, endMm: 1500 });
  assert.notEqual(a.id, b.id);
  // полный список: a=WW1, b=WW2
  assert.deepEqual(warmWallList(m).map((x) => [x.label, x.room_id]), [["WW1", "R1"], ["WW2", "R2"]]);
  // фильтр по второй комнате НЕ перенумеровывает
  const filtered = warmWallList(m, "r2");
  assert.deepEqual(filtered.map((x) => [x.label, x.id]), [["WW2", b.id]]);
  assert.equal((filtered[0]! as { room_id: string }).room_id, "R2");
  // update по метке из отфильтрованного списка — та же часть b (ребро r2 от x=500)
  warmWallUpdate(m, { warmWallId: "WW2", startMm: 1000, endMm: 2000 });
  const partB = warmWallEntries(m).find((e) => e.part.id === b.id)!.part;
  assert.equal(partB.line.p1.x, 600);
  // wiring_add по метке WW2 — вершина части b
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: "WW2" }] });
  assert.equal(wire.vertexes.find((v) => v.type === "warm_wall")!.id, b.id);
  // delete по метке — удаляется b, a цела (кабель снят — удаление осознанное)
  deleteElecCable(m, wire.id);
  const del = warmWallDelete(m, "WW2");
  assert.equal(del.id, b.id);
  assert.deepEqual(warmWallEntries(m).map((e) => e.part.id), [a.id]);
});

test("274 №1: resolveWarmWall/elecWarmWallVertex/через wiring_add — одна карта меток", () => {
  const m = baseModel();
  const a = warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 500, endMm: 1500 });
  const b = warmWallAdd(m, { roomRef: "r2", edge: 0, startMm: 500, endMm: 1500 });
  // wiring_add по WW1 подключает a (первую в полном списке), по WW2 — b
  const thermo = addItem(m, { name: "socket_thermo", position: { againstWall: { wallId: topWall(m), offsetMm: 1000 } }, catalogEntry: entry("socket_thermo") } as never);
  const wire = addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: "WW1" }] });
  assert.equal(wire.vertexes.find((v) => v.type === "warm_wall")!.id, a.id);
  void b;
  assert.throws(() => warmWallUpdate(m, { warmWallId: "WW3", startMm: 0, endMm: 100 }), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
});

// ---------- №2: тёплая стена — «контур» в правиле кабеля ----------

function cableScenario(): { m: Model; thermo: ItemProps; wwA: string; wwB: string; wf: string } {
  const m = baseModel();
  const thermo = addItem(m, { name: "socket_thermo", position: { againstWall: { wallId: topWall(m), offsetMm: 1000 } }, catalogEntry: entry("socket_thermo") } as never);
  const wwA = warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 500, endMm: 1500 }).id;
  const wwB = warmWallAdd(m, { roomRef: "r1", edge: 2, startMm: 500, endMm: 1500 }).id;
  const wf = addWarmFloor(m, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 2000, y: 2000 } } as never).id;
  return { m, thermo, wwA, wwB, wf };
}

const twoContours = (e: unknown): boolean =>
  e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("MCP строже редактора");

test("274 №2: прямой штрих тёплая стена—тёплая стена — отказ (как в редакторе)", () => {
  const { m, thermo, wwA, wwB } = cableScenario();
  assert.throws(
    () => addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wwA }, { itemId: wwB }] }),
    twoContours,
  );
});

test("274 №2: тёплая стена → узел → тёплая стена — отказ (MCP строже редактора: не более одной тёплой стены/контура на кабель)", () => {
  const { m, thermo, wwA, wwB } = cableScenario();
  assert.throws(
    () => addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wwA }, { x: 2000, y: 1500 }, { itemId: wwB }] }),
    twoContours,
  );
});

test("274 №2: прямой штрих тёплая стена—контур и контур→узел→тёплая стена — отказ", () => {
  const { m, thermo, wwA, wf } = cableScenario();
  assert.throws(
    () => addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wwA }, { itemId: wf }] }),
    twoContours,
  );
  assert.throws(
    () => addElecCable(m, { tool: "warm_floor_wire", path: [{ itemId: thermo.id }, { itemId: wf }, { x: 2000, y: 1500 }, { itemId: wwA }] }),
    twoContours,
  );
});

test("274 №2: одна тёплая стена и один контур по отдельности — допустимо; подсказка называет оба пути", () => {
  // отдельные сценарии: у под-розетки терморегулятора одно подключение на кабель
  const s1 = cableScenario();
  const w1 = addElecCable(s1.m, { tool: "warm_floor_wire", path: [{ itemId: s1.thermo.id }, { itemId: s1.wwA }] });
  assert.equal(w1.vertexes.find((v) => v.type === "warm_wall")!.id, s1.wwA);
  const s2 = cableScenario();
  const w2 = addElecCable(s2.m, { tool: "warm_floor_wire", path: [{ itemId: s2.thermo.id }, { itemId: s2.wf }] });
  assert.equal(w2.vertexes.find((v) => v.type === "warm_floor")!.id, s2.wf);
  // смешанный путь стена+контур (через узел) — отказ с «MCP строже редактора»
  const s3 = cableScenario();
  try {
    addElecCable(s3.m, { tool: "warm_floor_wire", path: [{ itemId: s3.thermo.id }, { itemId: s3.wwB }, { x: 2000, y: 1500 }, { itemId: s3.wf }] });
    assert.fail("ожидался отказ");
  } catch (e) {
    const msg = String((e as McpError).message);
    assert.ok(msg.includes("тёпло"), msg);
    assert.ok(msg.includes("MCP строже редактора"), msg);
  }
});

// ---------- №3: рёбра комнаты в мм в rooms_list; room_id — метка R<n> ----------

test("274 №3: rooms_list отдаёт рёбра комнаты (edge/from/to/length_mm, мм, в порядке edges)", () => {
  const m = baseModel();
  const compact = compactModel(m);
  const room = compact.rooms[0]!;
  assert.ok(Array.isArray(room.edges) && room.edges.length >= 4, JSON.stringify(room));
  const e0 = room.edges![0]!;
  assert.equal(e0.edge, 0);
  assert.deepEqual(e0.from, [0, 0]);
  assert.deepEqual(e0.to, [4000, 0]);
  assert.equal(e0.length_mm, 4000);
  // у второй комнаты тоже есть рёбра, нумерация с 0
  const room2 = compact.rooms[1]!;
  assert.equal(room2.edges![0]!.edge, 0);
});

test("274 №3/№10: room_id в ответах warm_wall_* — метка R<n>; warm_wall_delete возвращает id части, room, edge", () => {
  const m = baseModel();
  const a = warmWallAdd(m, { roomRef: "r2", edge: 0, startMm: 500, endMm: 1500 });
  assert.equal(a.room_id, "R2");
  assert.equal(warmWallList(m, "r2")[0]!.room_id, "R2");
  const del = warmWallDelete(m, "WW1");
  assert.equal(del.id, a.id);
  assert.equal((del as unknown as { room: string }).room, "R2");
  assert.equal((del as unknown as { edge: number }).edge, 0);
});

// ---------- №5: полная проекция в сверке ----------

test("274 №5: сверка ловит смену layer, props.name, потерю props.id, exist:false и перенос на другое ребро (save)", () => {
  const mk = (): { m: Model; id: string } => {
    const m = baseModel();
    const id = warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 500, endMm: 1500 }).id;
    return { m, id };
  };
  const mutate = (kind: string): unknown => {
    const { m } = mk();
    const got = structuredClone(m) as unknown as Record<string, unknown>;
    const room = (got.rooms2 as Record<string, Record<string, unknown>>).r1!;
    const grp = (room.warms_walls as Array<Record<string, unknown>>)[0]!;
    const part = Object.values(grp.parts as Record<string, Record<string, unknown>>)[0]!;
    if (kind === "layer") part.layer = 2;
    if (kind === "name") (part.props as Record<string, unknown>).name = "other";
    if (kind === "propsId") delete (part.props as Record<string, unknown>).id;
    if (kind === "exist") grp.exist = false;
    if (kind === "edge") {
      room.warms_walls = [{ exist: false }, { exist: false }, { exist: true, parts: grp.parts }];
    }
    return warmWallsCompare(m as unknown as Record<string, unknown>, got, "save").problems;
  };
  for (const kind of ["layer", "name", "propsId", "exist", "edge"]) {
    const problems = mutate(kind) as string[];
    assert.ok(problems.length > 0, `${kind}: сверка должна дать проблему`);
  }
  // идентичная модель — без проблем
  const { m } = mk();
  assert.deepEqual(warmWallsCompare(m as unknown as Record<string, unknown>, structuredClone(m) as unknown as Record<string, unknown>, "save"), { problems: [], warnings: [] });
});

// ---------- №6: формула distance по get_distance бандла ----------

test("274 №6: эталоны дают свой distance без маски (get_distance: оба конца — длина демолинии, один конец — +5)", () => {
  const line = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-warmwall-line.json"), "utf8"));
  const wire = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-warmwall-wire.json"), "utf8"));
  const p1 = (line.warms_walls as Array<{ parts: Record<string, { line: unknown; line_wall: unknown; distance: number }> }>)[1]!.parts.id1!;
  const p2 = wire.warm_wall_part as { line: unknown; line_wall: unknown; distance: number };
  assert.equal(warmWallDistance(p2.line as never, p2.line_wall as never), p2.distance);
  assert.equal(warmWallDistance(p1.line as never, p1.line_wall as never), p1.distance);
  // минимум: участок 160 мм у конца ребра — допустим (16+5=21 ≥ 20), в середине — отказ
  const m = baseModel();
  const short = warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 0, endMm: 160 });
  assert.equal(short.length_mm, 160);
  assert.throws(
    () => warmWallAdd(m, { roomRef: "r1", edge: 0, startMm: 1000, endMm: 1150 }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("короче"),
  );
  // участок 150 мм на коротком ребре 15 см с обоими концами на концах —
  // distance = длина демолинии (15) < 20 — отказ, как в редакторе
  const m2 = baseModel();
  (m2.rooms2 as Record<string, Record<string, unknown>>).r1!.polygon = [{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 300 }, { x: 0, y: 300 }];
  assert.throws(
    () => warmWallAdd(m2, { roomRef: "r1", edge: 0, startMm: 0, endMm: 150 }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("короче"),
  );
});

// ---------- №11: rooms2.warms_walls в схеме импорта ----------

test("274 №11: импорт — слишком много частей warms_walls отклоняется с INVALID_ARGUMENT", () => {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Record<string, unknown>;
  const rooms2 = structuredClone(model.rooms2 ?? { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }] } }) as Record<string, Record<string, unknown>>;
  const room = rooms2[Object.keys(rooms2)[0]!]!;
  const parts: Record<string, unknown> = {};
  for (let i = 0; i < 2001; i++) parts[`p${i}`] = { id: `p${i}`, type: "warm_wall_cable", line: { p1: { x: 0, y: 5 }, p2: { x: 1, y: 5 } }, props: { id: `p${i}`, name: "warm_wall_cable" } };
  room.warms_walls = [{ exist: true, parts }];
  const bad = { ...structuredClone(model), rooms2 };
  assert.throws(
    () => parseModelImport(bad),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && String((e as McpError).message).includes("warms_walls"),
  );
  // допустимая модель проходит
  const ok2 = structuredClone(model) as Record<string, Record<string, unknown>>;
  const room2 = (ok2.rooms2 as Record<string, Record<string, unknown>>)[Object.keys(ok2.rooms2 as Record<string, unknown>)[0]!]!;
  room2.warms_walls = [{ exist: true, parts: { p1: { id: "p1", type: "warm_wall_cable", layer: 1, line: { p1: { x: 0, y: 5 }, p2: { x: 100, y: 5 } }, line_wall: { p1: { x: 0, y: 5 }, p2: { x: 400, y: 5 } }, height: 135, height_from_floor: 15, props: { id: "p1", name: "warm_wall_cable" } } } }];
  assert.doesNotThrow(() => parseModelImport(ok2));
});
