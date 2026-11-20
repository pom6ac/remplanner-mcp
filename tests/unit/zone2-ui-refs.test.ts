// 296: тесты зонирования ч.2 — общий слой ZoneDelimitering (zone_floor /
// zone_hydroisolation / zone_floor_cap), эталоны UI в обе стороны, конец
// разделителя на грани потолочной закладной, фильтр пересечений по плану,
// ригели — только у зоны потолка, атомарность/удаление, mock save.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model } from "../../src/model/types.ts";
import { addZoneDelimiter, addZoneCeiling, removeZoneDelimiter, zoneDelimiterList, zoneDelimiterCompare, ZONE_DELIMITER_PLANS } from "../../src/model/zone.ts";
import { finishList } from "../../src/model/finish.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;

type Pt = { x: number; y: number };
type ZoneRefFixture = {
  room: { polygon: Pt[]; edges: Array<Record<string, unknown>> };
  rigels?: Record<string, Record<string, unknown>>;
  zone_delimiters: Record<string, Record<string, unknown>>;
};

function loadFixture(file: string): ZoneRefFixture {
  return JSON.parse(readFileSync(`tests/fixtures/${file}`, "utf8")) as ZoneRefFixture;
}

const FLOOR_REF = loadFixture("ui-ref-floorzone-delimiter.json");
const HYDRO_REF = loadFixture("ui-ref-hydrozone-delimiter.json");
const CAP_REF = loadFixture("ui-ref-capzone-delimiter.json");
const RIGEL_REF = loadFixture("ui-ref-ceilzone-delimiter-rigel.json");

const REF_ROOM = FLOOR_REF.room;

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

function firstRoomId(m: Model): string {
  const rooms = (m.rooms2 ?? m.rooms1) as Record<string, unknown> | undefined;
  const id = Object.keys(rooms ?? {})[0];
  assert.ok(id, "в фикстуре есть комната");
  return id!;
}

/** Модель с эталонной комнатой (прямоугольник 10..390 × 10..310, рёбра эталона). */
function modelWithRefRoom(): { m: Model; room: string } {
  const m = baseModel();
  const room = firstRoomId(m);
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  const rec = rooms[room]!;
  rec["polygon"] = structuredClone(REF_ROOM.polygon);
  rec["edges"] = structuredClone(REF_ROOM.edges);
  delete rec["delimiters"];
  delete rec["rigels"];
  return { m, room };
}

function modelLike(rooms: Record<string, unknown>, delims: Record<string, unknown>): Record<string, unknown> {
  return { rooms2: rooms, zone_delimiters: delims };
}

function refModelFixture(fix: ZoneRefFixture, delimsKey: string): Record<string, unknown> {
  const rooms: Record<string, unknown> = { room1: structuredClone(fix.room) as unknown as Record<string, unknown> };
  if (fix.rigels) rooms["room1"] = { ...(rooms["room1"] as Record<string, unknown>), rigels: structuredClone(fix.rigels) };
  return modelLike(rooms, { [delimsKey]: structuredClone(Object.values(fix.zone_delimiters)[0]!) });
}

const firstDelim = (fix: ZoneRefFixture): Record<string, unknown> => Object.values(fix.zone_delimiters)[0]!;
const vertexesMm = (rec: Record<string, unknown>): Array<{ x: number; y: number }> =>
  ((rec["vertexes"] ?? []) as Array<{ point: { x: number; y: number } }>).map((v) => ({ x: Math.round(v.point.x * 10), y: Math.round(v.point.y * 10) }));

/** ревью 298 №6: маска записи — id записи/узлов, ключи items, id_room (свой
 *  в модели, эталонный в фикстуре) и производное zone (привязка узлов,
 *  пересчитывается редактором) — дальше deepEqual всей записи целиком. */
function maskRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const c = structuredClone(rec);
  c["id"] = "ID";
  c["id_room"] = "ROOM";
  const v = (c["vertexes"] ?? []) as Array<Record<string, unknown>>;
  v.forEach((vert, i) => {
    vert["id"] = `V${i}`;
    delete vert["zone"];
  });
  const items = (c["items"] ?? {}) as Record<string, string>;
  c["items"] = Object.fromEntries(Object.keys(items).sort().map((k, i) => [`K${i}`, items[k]!]));
  return c;
}

// ---------- эталоны в обе стороны ----------

for (const [fix, typeName, label] of [
  [FLOOR_REF, "zone_floor", "зон пола"],
  [HYDRO_REF, "zone_hydroisolation", "зон гидроизоляции"],
  [CAP_REF, "zone_floor_cap", "зон стяжки"],
] as const) {
  const rec = firstDelim(fix);
  const V = vertexesMm(rec);

  test(`296: эталон UI ${typeName} — запись совпадает с эталоном кликами (обе стороны)`, () => {
    const { m, room } = modelWithRefRoom();
    const res = addZoneDelimiter(m, room, { type: typeName, fromMm: V[0]!, toMm: V[1]! });
    assert.equal(res.length_mm, Number(rec["length"]) * 1000, "длина в мм по эталону");
    const written = Object.values((m.zone_delimiters ?? {}) as Record<string, Record<string, unknown>>)[0]!;
    // ревью 298 №6: вывод == эталон целиком (маскированная форма, deepEqual) —
    // лишний ключ в записи MCP или потерянный ключ эталона ломает проверку
    assert.deepEqual(maskRecord(written), maskRecord(rec), "запись MCP == эталон (маскированная форма)");
    // сверка в обе стороны
    const expModel = refModelFixture(fix, Object.keys(fix.zone_delimiters)[0]!);
    const gotModel = modelLike({ [room]: ((m.rooms2 ?? {}) as Record<string, Record<string, unknown>>)[room]! }, structuredClone(m.zone_delimiters as Record<string, unknown>));
    for (const mode of ["normalize", "save"] as const) {
      assert.deepEqual(zoneDelimiterCompare(expModel, gotModel, mode).problems, [], `expected→got ${mode}`);
      assert.deepEqual(zoneDelimiterCompare(gotModel, expModel, mode).problems, [], `got→expected ${mode}`);
    }
    void label;
  });

  test(`296: finish_get содержит ${typeName} с меткой ZD<n> и site_id; удаление по метке`, () => {
    const { m, room } = modelWithRefRoom();
    const res = addZoneDelimiter(m, room, { type: typeName, fromMm: V[0]!, toMm: V[1]! });
    const list = finishList(m, room);
    const entry = list[0] as { zone_delimiters?: Array<Record<string, unknown>> };
    assert.ok(entry.zone_delimiters && entry.zone_delimiters.length === 1);
    const z = entry.zone_delimiters![0]!;
    assert.equal(z["site_id"], res.id);
    assert.equal(z["type"], typeName);
    assert.equal(z["plan"], rec["plan"]);
    assert.equal(removeZoneDelimiter(m, "ZD1").removed, true);
    assert.equal(zoneDelimiterList(m).length, 0);
  });
}

// ---------- конец разделителя на грани потолочной закладной ----------

test("296: эталон — конец zone_ceiling на грани потолочной закладной (магнит 100 мм, обе стороны)", () => {
  const rec = firstDelim(RIGEL_REF);
  const V = vertexesMm(rec);
  const { m, room } = modelWithRefRoom();
  // закладная — закладная комнаты из эталона (rooms2[rid].rigels)
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  rooms[room]!["rigels"] = structuredClone(RIGEL_REF.rigels);
  // ревью 298 №7: вход в 4 см от грани закладной (точка НЕ на грани) — магнит
  // должен довести конец до грани x=204.6; старт тоже в 4 см от ребра
  const res = addZoneCeiling(m, room, { fromMm: { x: 3860, y: 1594 }, toMm: { x: 2086, y: 1594 } });
  assert.equal(res.length_mm, Number(rec["length"]) * 1000);
  const written = Object.values((m.zone_delimiters ?? {}) as Record<string, Record<string, unknown>>)[0]!;
  // ревью 298 №6: запись == эталон целиком (маскированная форма)
  assert.deepEqual(maskRecord(written), maskRecord(rec), "запись MCP == эталон (маскированная форма)");
  // производная привязка zone (type rigel_ceiling) — сверка её не читает
  const expModel = refModelFixture(RIGEL_REF, Object.keys(RIGEL_REF.zone_delimiters)[0]!);
  const gotModel = modelLike({ [room]: rooms[room]! }, structuredClone(m.zone_delimiters as Record<string, unknown>));
  for (const mode of ["normalize", "save"] as const) {
    assert.deepEqual(zoneDelimiterCompare(expModel, gotModel, mode).problems, [], `expected→got ${mode}`);
    assert.deepEqual(zoneDelimiterCompare(gotModel, expModel, mode).problems, [], `got→expected ${mode}`);
  }
});

// ---------- фильтр пересечений по плану ----------

const CROSS_MM = { fromMm: { x: 3900, y: 800 }, toMm: { x: 100, y: 800 } };

test("296: разделители одного плана пересекать нельзя, разных планов — можно", () => {
  const { m, room } = modelWithRefRoom();
  addZoneDelimiter(m, room, { type: "zone_floor", fromMm: vertexesMm(firstDelim(FLOOR_REF))[0]!, toMm: vertexesMm(firstDelim(FLOOR_REF))[1]! });
  // та же линия того же плана — пересечение
  assert.throws(() => addZoneDelimiter(m, room, { type: "zone_floor", ...CROSS_MM }), /пересекает другой разделитель/);
  // другого плана (потолок) — можно (проба 296, check_delimiter фильтрует по plan)
  assert.doesNotThrow(() => addZoneCeiling(m, room, CROSS_MM));
  // общий узел/касание одного плана — соединение, не пересечение
  const { m: m2, room: room2 } = modelWithRefRoom();
  addZoneDelimiter(m2, room2, { type: "zone_floor", fromMm: vertexesMm(firstDelim(FLOOR_REF))[0]!, toMm: vertexesMm(firstDelim(FLOOR_REF))[1]! });
  assert.doesNotThrow(() => addZoneDelimiter(m2, room2, { type: "zone_floor", fromMm: vertexesMm(firstDelim(FLOOR_REF))[0]!, toMm: { x: 3900, y: 3000 } }));
});

// ---------- ригели и закладные — только у зоны потолка ----------

test("296: зона пола пересекает ригель свободно, зона потолка — отказ; магнит к грани — только потолок", () => {
  const { m, room } = modelWithRefRoom();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  rooms[room]!["rigels"] = structuredClone(RIGEL_REF.rigels);
  // горизонтальная линия через закладную (полоса x 192.7..204.6)
  assert.doesNotThrow(() => addZoneDelimiter(m, room, { type: "zone_floor", ...CROSS_MM }), "зона пола не проверяет ригели");
  assert.throws(() => addZoneCeiling(m, room, CROSS_MM), /не пересекайте ригели/);
  // конец НЕ на грани закладной, а в 5 см от неё (ревью 298 №7): магнит доводит
  // до грани x=204.6; зона потолка магнитится, зона пола — нет (магнит к ригелям
  // в редакторе только у zone_ceiling)
  const { m: m2, room: room2 } = modelWithRefRoom();
  const rooms2 = (m2.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  rooms2[room2]!["rigels"] = structuredClone(RIGEL_REF.rigels);
  const from = { x: 3900, y: 800 };
  const nearFace = { x: 2096, y: 800 };
  assert.doesNotThrow(() => addZoneCeiling(m2, room2, { fromMm: from, toMm: nearFace }));
  const written2 = Object.values((m2.zone_delimiters ?? {}) as Record<string, Record<string, unknown>>)[0]!;
  const v2 = (written2["vertexes"] as Array<{ point: Pt }>)[1]!.point;
  assert.deepEqual(v2, { x: 204.6, y: 80 }, "магнит довёл конец до грани закладной");
  assert.throws(() => addZoneDelimiter(m2, room2, { type: "zone_floor", fromMm: from, toMm: nearFace }), /не магнитится/);
});

// ревью 298 №7: приоритет магнитов как в редакторе (if(!r&&"zone_ceiling"===tool)):
// точка в 7 см от ребра комнаты и в 3 см от грани закладной — магнитится ребро
test("296: ребро комнаты в 7 см важнее грани закладной в 3 см (приоритет редактора)", () => {
  const { m, room } = modelWithRefRoom();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  // небольшая «плавающая» закладная у правого ребра: x 370..380, y 140..160
  rooms[room]!["rigels"] = {
    rg1: { id: "rg1", polygon: [{ x: 370, y: 140 }, { x: 380, y: 140 }, { x: 380, y: 160 }, { x: 370, y: 160 }], id_room: "room1" },
  };
  // точка (383,165): до правого ребра x=390 — 7 см, до грани закладной x=380 — 3 см
  const res = addZoneCeiling(m, room, { fromMm: { x: 100, y: 1600 }, toMm: { x: 3830, y: 1650 } });
  assert.ok(res.id);
  const written = Object.values((m.zone_delimiters ?? {}) as Record<string, Record<string, unknown>>)[0]!;
  const v = (written["vertexes"] as Array<{ point: Pt }>)[1]!.point;
  assert.deepEqual(v, { x: 390, y: 165 }, "конец лёг на ребро комнаты, а не на грань закладной");
});

// ---------- атомарность, удаление, нумерация ----------

test("296: атомарность отказов add; нумерация ZD сквозная по типам; удаление чужих не задевает", () => {
  const { m, room } = modelWithRefRoom();
  addZoneDelimiter(m, room, { type: "zone_floor", fromMm: vertexesMm(firstDelim(FLOOR_REF))[0]!, toMm: vertexesMm(firstDelim(FLOOR_REF))[1]! });
  addZoneDelimiter(m, room, { type: "zone_hydroisolation", fromMm: vertexesMm(firstDelim(HYDRO_REF))[0]!, toMm: vertexesMm(firstDelim(HYDRO_REF))[1]! });
  const list = zoneDelimiterList(m);
  assert.equal(list.length, 2);
  assert.equal(list[0]!["id"], "ZD1");
  assert.equal(list[1]!["id"], "ZD2");
  // отказ (нет магнита) не меняет модель
  const before = structuredClone(m.zone_delimiters);
  assert.throws(() => addZoneDelimiter(m, room, { type: "zone_floor_cap", fromMm: { x: 2000, y: 1600 }, toMm: { x: 2600, y: 1600 } }), /не магнитится/);
  assert.deepEqual(m.zone_delimiters, before);
  // удаление по метке первого, второй не задет
  assert.equal(removeZoneDelimiter(m, "ZD1").removed, true);
  const left = zoneDelimiterList(m);
  assert.equal(left.length, 1);
  assert.equal(left[0]!["type"], "zone_hydroisolation");
  // удаление по id сайта
  assert.equal(removeZoneDelimiter(m, String(left[0]!["site_id"])).removed, true);
  assert.throws(() => removeZoneDelimiter(m, "ZD9"), /не найден/);
});

test("296: неизвестный тип разделителя — INVALID_ARGUMENT", () => {
  const { m, room } = modelWithRefRoom();
  assert.throws(
    () => addZoneDelimiter(m, room, { type: "zone_c" as never, fromMm: { x: 2000, y: 100 }, toMm: { x: 2000, y: 3000 } }),
    /неизвестный тип/,
  );
  assert.equal(Object.keys(ZONE_DELIMITER_PLANS).length, 4);
});

// ---------- mock save ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
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

test("296: mock save — разделитель зон пола доезжает до сервера, verified", async () => {
  const { m, room } = modelWithRefRoom();
  addZoneDelimiter(m, room, { type: "zone_floor", fromMm: vertexesMm(firstDelim(FLOOR_REF))[0]!, toMm: vertexesMm(firstDelim(FLOOR_REF))[1]! });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

test("296: mock save — нормализация потеряла разделитель зон пола → NORMALIZATION_DROPPED", async () => {
  const { m, room } = modelWithRefRoom();
  addZoneDelimiter(m, room, { type: "zone_floor", fromMm: vertexesMm(firstDelim(FLOOR_REF))[0]!, toMm: vertexesMm(firstDelim(FLOOR_REF))[1]! });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let wrote = false;
  const ws = saveMock(server, () => { wrote = true; }, (norm) => {
    delete norm["zone_delimiters"];
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => e instanceof Error && /NORMALIZATION_DROPPED|потерял объекты/.test(e.message));
  assert.equal(wrote, false, "модель с потерянным разделителем не записывается");
});

test("296: mock save — сервер потерял разделитель зон пола → SITE_ERROR с zone_mismatches", async () => {
  const { m, room } = modelWithRefRoom();
  addZoneDelimiter(m, room, { type: "zone_floor", fromMm: vertexesMm(firstDelim(FLOOR_REF))[0]!, toMm: vertexesMm(firstDelim(FLOOR_REF))[1]! });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    delete s.model["zone_delimiters"];
  });
  await ws.open("0", "1");
  await assert.rejects(async () => ws.save(), (e: Error) => {
    const details = (e as Error & { details?: Record<string, unknown> }).details ?? {};
    const zm = details["zone_mismatches"] as string[] | undefined;
    assert.ok(Array.isArray(zm) && zm.some((p) => p.includes("потерян")), JSON.stringify(details).slice(0, 400));
    return true;
  });
});
