// 318: тесты зонирования ч.5 — zone_c (зоны листа «Перегородки», план "c"):
// эталон UI в обе стороны с привязками узлов к рёбрам комнаты (как mouseup
// редактора), пересечения в пределах своего плана, ингест делителей из
// editor/GET в рабочую копию (open→save не теряет), сверка зон комнат
// (безымянные наследники при новом делителе — без ложной ошибки, потеря
// именованных/микрозон ловится), затронутость при изменении стен, mock save.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model } from "../../src/model/types.ts";
import { addZoneDelimiter, removeZoneDelimiter, removeZoneFloor, zoneDelimiterList, zoneDelimiterCompare, roomsWithChangedZoneCDividers, ZONE_DELIMITER_PLANS } from "../../src/model/zone.ts";
import { roomsSaveCompare } from "../../src/model/rooms-save.ts";
import { finishList } from "../../src/model/finish.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;

type Pt = { x: number; y: number };
type ZoneRefFixture = {
  room: { polygon: Pt[]; edges: Array<Record<string, unknown>> };
  zone_delimiters: Record<string, Record<string, unknown>>;
};

const ZC_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-zonec-delimiter.json", "utf8")) as ZoneRefFixture;

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
  rec["polygon"] = structuredClone(ZC_REF.room.polygon);
  rec["edges"] = structuredClone(ZC_REF.room.edges);
  delete rec["delimiters"];
  delete rec["rigels"];
  return { m, room };
}

function modelLike(rooms: Record<string, unknown>, delims: Record<string, unknown>): Record<string, unknown> {
  return { rooms2: rooms, zone_delimiters: delims };
}

const rec = Object.values(ZC_REF.zone_delimiters)[0]!;
const vertexesMm = (r: Record<string, unknown>): Array<{ x: number; y: number }> =>
  ((r["vertexes"] ?? []) as Array<{ point: { x: number; y: number } }>).map((v) => ({ x: Math.round(v.point.x * 10), y: Math.round(v.point.y * 10) }));

/** Маска записи — id записи/узлов, ключи items, id_room; привязка zone (производное
 *  редактора) маскируется, как в zone2-ui-refs (ревью 298 №6); остальное deepEqual. */
function maskRecord(source: Record<string, unknown>): Record<string, unknown> {
  const c = structuredClone(source);
  c["id"] = "ID";
  c["id_room"] = "ROOM";
  const v = (c["vertexes"] ?? []) as Array<Record<string, unknown>>;
  v.forEach((vert, i) => {
    vert["id"] = `V${i}`;
    vert["zone"] = { type: String((vert["zone"] as Record<string, unknown> | undefined)?.["type"] ?? "") };
  });
  const items = (c["items"] ?? {}) as Record<string, string>;
  c["items"] = Object.fromEntries(Object.keys(items).sort().map((k, i) => [`K${i}`, items[k]!]));
  return c;
}

// ---------- эталон в обе стороны ----------

test("318: эталон UI zone_c — запись MCP совпадает с эталоном drag'а (обе стороны), план c", () => {
  const { m, room } = modelWithRefRoom();
  const V = vertexesMm(rec);
  const res = addZoneDelimiter(m, room, { type: "zone_c", fromMm: V[0]!, toMm: V[1]! });
  assert.equal(res.length_mm, Number(rec["length"]) * 1000, "длина в мм по эталону");
  const written = Object.values((m.zone_delimiters ?? {}) as Record<string, Record<string, unknown>>)[0]!;
  assert.deepEqual(maskRecord(written), maskRecord(rec), "запись MCP == эталон (маскированная форма)");
  assert.equal(written["plan"], "c");
  assert.equal(written["type"], "zone_c");
  assert.equal(written["on_size"], 1);
  // привязки узлов — как mouseup редактора (эталон 318): обе вершины type room
  const vw = (written["vertexes"] ?? []) as Array<{ zone?: Record<string, unknown> }>;
  assert.equal(vw[0]!.zone?.["type"], "room");
  assert.equal(vw[1]!.zone?.["type"], "room");
  assert.equal(vw[0]!.zone?.["room_id"], room);
  assert.deepEqual(vw[0]!.zone?.["edge_pids"], { wall3: "l" });
  assert.deepEqual(vw[1]!.zone?.["edge_pids"], { wall1: "r" });
  // сверка в обе стороны (ожидание — модель-эталон с ключом комнаты room1,
  // как в refModelFixture zone2-ui-refs)
  const expModel = modelLike(
    { room1: structuredClone(ZC_REF.room) as unknown as Record<string, unknown> },
    { zd1: structuredClone(rec) },
  );
  const gotModel = modelLike({ [room]: ((m.rooms2 ?? {}) as Record<string, Record<string, unknown>>)[room]! }, structuredClone(m.zone_delimiters as Record<string, unknown>));
  for (const mode of ["normalize", "save"] as const) {
    assert.deepEqual(zoneDelimiterCompare(expModel, gotModel, mode).problems, [], `expected→got ${mode}`);
    assert.deepEqual(zoneDelimiterCompare(gotModel, expModel, mode).problems, [], `got→expected ${mode}`);
  }
});

test("318: finish_get содержит zone_c с меткой ZD<n> и site_id; удаление по метке и по id", () => {
  const { m, room } = modelWithRefRoom();
  const res = addZoneDelimiter(m, room, { type: "zone_c", fromMm: vertexesMm(rec)[0]!, toMm: vertexesMm(rec)[1]! });
  const list = finishList(m, room);
  const entry = list[0] as { zone_delimiters?: Array<Record<string, unknown>> };
  assert.ok(entry.zone_delimiters && entry.zone_delimiters.length === 1);
  const z = entry.zone_delimiters![0]!;
  assert.equal(z["site_id"], res.id);
  assert.equal(z["type"], "zone_c");
  assert.equal(z["plan"], "c");
  assert.equal(removeZoneDelimiter(m, "ZD1").removed, true);
  assert.equal(zoneDelimiterList(m).length, 0);
});

test("318: remove проверяет тип — zone_floor_remove на zone_c отказ с подсказкой zone_c_remove", () => {
  const { m, room } = modelWithRefRoom();
  const res = addZoneDelimiter(m, room, { type: "zone_c", fromMm: vertexesMm(rec)[0]!, toMm: vertexesMm(rec)[1]! });
  assert.throws(
    () => removeZoneFloor(m, res.id),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      return err.code === "INVALID_ARGUMENT" && /zone_c_remove/.test(err.message ?? "");
    },
  );
  assert.equal(removeZoneDelimiter(m, res.id, { expectedType: "zone_c" }).removed, true);
});

// ---------- пересечения в пределах своего плана ----------

// вертикальная линия через эталонный горизонтальный делитель zone_c (y=158.2)
const CROSS_MM = { fromMm: { x: 2000, y: 100 }, toMm: { x: 2000, y: 3000 } };

test("318: zone_c пересекает делители других планов свободно, своего плана — отказ", () => {
  const { m, room } = modelWithRefRoom();
  addZoneDelimiter(m, room, { type: "zone_c", fromMm: vertexesMm(rec)[0]!, toMm: vertexesMm(rec)[1]! });
  assert.throws(() => addZoneDelimiter(m, room, { type: "zone_c", ...CROSS_MM }), /пересекает другой разделитель/);
  assert.doesNotThrow(() => addZoneDelimiter(m, room, { type: "zone_floor", ...CROSS_MM }));
});

// ---------- ингест делителей из editor/GET ----------

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

test("318: ингест — делитель zone_c, поставленный руками в UI и сохранённый (GET), доезжает через open→save, verified", async () => {
  const { m, room } = modelWithRefRoom();
  addZoneDelimiter(m, room, { type: "zone_c", fromMm: vertexesMm(rec)[0]!, toMm: vertexesMm(rec)[1]! });
  // сервер (GET после чужого save): модель с zone_c-делителем; зоны комнаты
  // разделены на безымянных наследников (эталон 318)
  const serverRooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  serverRooms[room]!["zones"] = [
    { polygon: ZC_REF.room.polygon, exist: false, name: "none" },
    { polygon: ZC_REF.room.polygon, exist: false, name: "none" },
  ];
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
  assert.deepEqual(res.warnings, []);
});

test("318: ингест — делители других типов из editor/GET тоже доезжают (общий путь)", async () => {
  const { m, room } = modelWithRefRoom();
  // одна и та же линия для всех типов: пересечения проверяются только внутри
  // своего плана, а здесь у каждого типа ровно один делитель
  const fromMm = { x: 100, y: 2000 }, toMm = { x: 3900, y: 2000 };
  for (const t of Object.keys(ZONE_DELIMITER_PLANS)) {
    addZoneDelimiter(m, room, { type: t as keyof typeof ZONE_DELIMITER_PLANS, fromMm, toMm });
  }
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.deepEqual(res.warnings, []);
});

test("318: mock save — нормализация потеряла zone_c → NORMALIZATION_DROPPED, записи не было", async () => {
  const { m, room } = modelWithRefRoom();
  addZoneDelimiter(m, room, { type: "zone_c", fromMm: vertexesMm(rec)[0]!, toMm: vertexesMm(rec)[1]! });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let wrote = false;
  const ws = saveMock(server, () => { wrote = true; }, (norm) => {
    delete norm["zone_delimiters"];
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => e instanceof Error && /NORMALIZATION_DROPPED|потерял объекты/.test(e.message));
  assert.equal(wrote, false, "модель с потерянным делителем не записывается");
});

test("318: mock save — сервер потерял zone_c → SITE_ERROR с zone_mismatches", async () => {
  const { m, room } = modelWithRefRoom();
  addZoneDelimiter(m, room, { type: "zone_c", fromMm: vertexesMm(rec)[0]!, toMm: vertexesMm(rec)[1]! });
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

// ---------- сверка зон комнат (rooms2[].zones) ----------

type ZoneSig = { name: string | null; zones: string[] };

function userSigs(rooms: Record<string, Record<string, unknown>>, rid: string): ZoneSig {
  const rec0 = rooms[rid] as { zones?: Array<{ name?: string; is_micro_zone?: boolean }>; name?: string };
  return {
    name: typeof rec0?.name === "string" ? rec0.name : null,
    zones: (rec0?.zones ?? []).map((z) => JSON.stringify([String(z?.name ?? ""), Boolean(z?.is_micro_zone)])),
  };
}

test("318: комната с именованной зоной + новый zone_c-делитель — без ложной ошибки (наследники безымянные)", () => {
  const rooms: Record<string, Record<string, unknown>> = {
    r1: {
      polygon: structuredClone(ZC_REF.room.polygon),
      name: "Гостиная",
      zones: [{ polygon: ZC_REF.room.polygon, exist: true, name: "Гостиная" }],
    },
  };
  // нормализация поделила зоны делителем: обе безымянные, имя комнаты на месте
  const got: Record<string, Record<string, unknown>> = {
    r1: {
      polygon: structuredClone(ZC_REF.room.polygon),
      name: "Гостиная",
      zones: [
        { polygon: ZC_REF.room.polygon, exist: false, name: "none" },
        { polygon: ZC_REF.room.polygon, exist: false, name: "none" },
      ],
    },
  };
  const div = roomsWithChangedZoneCDividers(
    { rooms2: structuredClone(rooms), zone_delimiters: {} },
    { rooms2: structuredClone(got), zone_delimiters: { zd1: { ...structuredClone(rec), id_room: "r1" } } },
  );
  assert.deepEqual([...div], ["r1"], "комната с новым zone_c-делителем");
  const res = roomsSaveCompare(rooms, got, "normalize", {}, { zoneDivisionRooms: div });
  assert.deepEqual(res.problems, [], JSON.stringify(res.problems));
  // в save-режиме то же сочетание (нормализованная модель уже поделена) — тоже без ошибки
  const resSave = roomsSaveCompare(got, structuredClone(got), "save");
  assert.deepEqual(resSave.problems, []);
});

// ревью 319 №1: симметричная разность — добавленные И удалённые делители,
// а также делители с изменившейся геометрией (при изменении стен)
test("318/319 №1: изменённый набор zone_c-делителей от базы — удаление и геометрия тоже в наборе", () => {
  const rooms: Record<string, Record<string, unknown>> = {
    r1: { polygon: structuredClone(ZC_REF.room.polygon), name: "Гостиная", zones: [{ polygon: ZC_REF.room.polygon, exist: true, name: "Гостиная" }] },
    r2: { polygon: structuredClone(ZC_REF.room.polygon), name: "Кухня", zones: [{ polygon: ZC_REF.room.polygon, exist: true, name: "Кухня" }] },
    r3: { polygon: structuredClone(ZC_REF.room.polygon), name: "Спальня", zones: [{ polygon: ZC_REF.room.polygon, exist: true, name: "Спальня" }] },
  };
  const delim = (id: string, idRoom: string, x1: number, x2: number): Record<string, unknown> => ({
    ...structuredClone(rec), id, id_room: idRoom,
    vertexes: [
      { id: `${id}v1`, point: { x: x1, y: 158.2 }, type: "node" },
      { id: `${id}v2`, point: { x: x2, y: 158.2 }, type: "node" },
    ],
  });
  const base = { rooms2: structuredClone(rooms), zone_delimiters: { zdA: delim("zdA", "r1", 10, 390), zdGeom: delim("zdGeom", "r3", 10, 390) } };
  // r1: делитель удалён (слияние зон); r2: делитель добавлен; r3: id тот же, геометрия изменилась
  const got = { rooms2: structuredClone(rooms), zone_delimiters: { zdB: delim("zdB", "r2", 10, 390), zdGeom: delim("zdGeom", "r3", 20, 390) } };
  const div = roomsWithChangedZoneCDividers(base, got);
  assert.deepEqual([...div].sort(), ["r1", "r2", "r3"], JSON.stringify([...div].sort()));
  // без изменений — пусто
  assert.deepEqual([...roomsWithChangedZoneCDividers(base, structuredClone(base))], []);
});

test("318: потеря именованной зоны БЕЗ нового делителя — ошибка; микрозона тоже", () => {
  const rooms: Record<string, Record<string, unknown>> = {
    r1: {
      polygon: structuredClone(ZC_REF.room.polygon),
      name: "Гостиная",
      zones: [{ polygon: ZC_REF.room.polygon, exist: true, name: "Гостиная" }, { polygon: ZC_REF.room.polygon, exist: true, name: "Спальня", is_micro_zone: true }],
    },
  };
  const got: Record<string, Record<string, unknown>> = {
    r1: {
      polygon: structuredClone(ZC_REF.room.polygon),
      name: "Гостиная",
      zones: [{ polygon: ZC_REF.room.polygon, exist: true, name: "Спальня", is_micro_zone: true }],
    },
  };
  const res = roomsSaveCompare(rooms, got, "normalize", {}, { zoneDivisionRooms: roomsWithChangedZoneCDividers({ rooms2: rooms, zone_delimiters: {} }, { rooms2: got, zone_delimiters: {} }) });
  assert.ok(res.problems.some((p) => p.includes("зоны")), JSON.stringify(res.problems));
  // микрозона: деление с новым делителем объясняет потерю имени, но появление
  // НОВОЙ именованной/микро зоны в got — подмена
  const gotExtra: Record<string, Record<string, unknown>> = {
    r1: {
      polygon: structuredClone(ZC_REF.room.polygon),
      name: "Гостиная",
      zones: [
        { polygon: ZC_REF.room.polygon, exist: true, name: "Гостиная" },
        { polygon: ZC_REF.room.polygon, exist: true, name: "Спальня", is_micro_zone: true },
        { polygon: ZC_REF.room.polygon, exist: true, name: "Спальня", is_micro_zone: true },
      ],
    },
  };
  const resExtra = roomsSaveCompare(rooms, gotExtra, "save");
  assert.ok(resExtra.problems.some((p) => p.includes("зоны")), JSON.stringify(resExtra.problems));
});

test("318: безымянные зоны — умолчание редактора: лишние/пропавшие без делителя не блокируют", () => {
  const rooms: Record<string, Record<string, unknown>> = {
    r1: {
      polygon: structuredClone(ZC_REF.room.polygon),
      name: "none",
      zones: [{ polygon: ZC_REF.room.polygon, exist: true, name: "none" }],
    },
  };
  const got: Record<string, Record<string, unknown>> = {
    r1: {
      polygon: structuredClone(ZC_REF.room.polygon),
      name: "none",
      zones: [
        { polygon: ZC_REF.room.polygon, exist: false, name: "none" },
        { polygon: ZC_REF.room.polygon, exist: false, name: "none" },
      ],
    },
  };
  assert.deepEqual(roomsSaveCompare(rooms, got, "normalize").problems, []);
  assert.deepEqual(roomsSaveCompare(got, rooms, "normalize").problems, []);
  assert.deepEqual(roomsSaveCompare(got, rooms, "save").problems, []);
});

test("318: затронутость при изменении стен — как у прочих делителей: сдвиг до магнита — предупреждение, потеря в незатронутой — проблема", () => {
  const roomPoly = [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }];
  const delim = (id: string, x: number, rid: string): Record<string, unknown> => ({
    id, matrix: [[null, { length: 1 }], [{ length: 1 }, null]],
    vertexes: [
      { id: `${id}v1`, point: { x, y: 158.2 }, type: "node" },
      { id: `${id}v2`, point: { x: x + 380, y: 158.2 }, type: "node" },
    ],
    items: { [`${id}v1`]: "node", [`${id}v2`]: "node" },
    type: "zone_c", length: 3.8, id_room: rid, plan: "c", on_size: 1,
  });
  const exp = { rooms2: { r1: { polygon: structuredClone(roomPoly) }, r2: { polygon: structuredClone(roomPoly) } }, zone_delimiters: { zd1: delim("zd1", 10, "r1"), zd2: delim("zd2", 10, "r2") } };
  // r1 затронута стенами: делитель переопределён редактором (конец смещён на 10 см
  // — в пределах магнита 15 см), r2 не затронута: делитель потерян
  const got = {
    rooms2: structuredClone(exp.rooms2),
    zone_delimiters: { zd1s: delim("zd1s", 20, "r1") },
  };
  const res = zoneDelimiterCompare(exp, got, "normalize", { affectedRooms: new Set(["r1"]) });
  // затронутая r1: делитель переопределён (сдвиг до магнита) — предупреждение;
  // незатронутая r2: делитель потерян — проблема (сервер не имеет права терять
  // делитель незатронутой комнаты)
  assert.deepEqual(res.problems, ["room r2: потерян разделитель зон (zone_c) zd2 (380 см)"], JSON.stringify(res.problems));
  assert.ok(res.warnings.some((w) => w.includes("zone_topology_changed") && w.includes("zone_c")), JSON.stringify(res.warnings));
  // в save затронутая комната сверяется строго: тот же сдвиг — проблема
  const resSave = zoneDelimiterCompare(exp, got, "save", { affectedRooms: new Set(["r1"]) });
  assert.ok(resSave.problems.length > 0, JSON.stringify(resSave.problems));
});

test("318: zoneDelimiterList/compact — zone_c виден как ZD<n> (сквозная нумерация с другими типами)", () => {
  const { m, room } = modelWithRefRoom();
  addZoneDelimiter(m, room, { type: "zone_floor", ...CROSS_MM });
  addZoneDelimiter(m, room, { type: "zone_c", fromMm: vertexesMm(rec)[0]!, toMm: vertexesMm(rec)[1]! });
  const list = zoneDelimiterList(m);
  assert.equal(list.length, 2);
  assert.equal(list[0]!["id"], "ZD1");
  assert.equal(list[1]!["id"], "ZD2");
  assert.equal(list[1]!["type"], "zone_c");
  assert.equal(list[1]!["plan"], "c");
  void userSigs;
});

// ---------- ревью 319 №1/№6: полный пайплайн ws.apply → ws.save на названной комнате ----------

/** Комната эталона с именем и зонами (как в офлайн-репро 319-repro A/B). */
function namedRoomServer(names: string[]): { m: Model; room: string } {
  const { m, room } = modelWithRefRoom();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  rooms[room]!["name"] = names[0] ?? "Гостиная";
  (rooms[room]! as { zones?: unknown[] })["zones"] = names.map((n) => ({
    polygon: structuredClone(ZC_REF.room.polygon), exist: true, name: n,
  }));
  return { m, room };
}

const divideZones = (norm: Record<string, unknown>, room: string, count: number): void => {
  (norm["rooms2"] as Record<string, Record<string, unknown>>)[room]!["zones"] = Array.from({ length: count }, () => ({
    polygon: structuredClone(ZC_REF.room.polygon), exist: false, name: "none",
  }));
};

test("319 №1 A: zone_c_add в комнате с именованной зоной → ws.apply → ws.save verified", async () => {
  const { m, room } = namedRoomServer(["Гостиная"]);
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  // нормализация редактора делит зоны на безымянных наследников (эталон 318)
  const ws = saveMock(server, () => {}, (norm) => divideZones(norm, room, 2));
  await ws.open("0", "1");
  ws.apply("zone_c_add", (mm) => addZoneDelimiter(mm, room, { type: "zone_c", fromMm: vertexesMm(rec)[0]!, toMm: vertexesMm(rec)[1]! }));
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res.warnings));
  assert.deepEqual(res.warnings, []);
});

test("319 №1 B: zone_c_remove именованных половинок → ws.apply → ws.save verified", async () => {
  const { m, room } = namedRoomServer(["Кухня", "Столовая"]);
  addZoneDelimiter(m, room, { type: "zone_c", fromMm: vertexesMm(rec)[0]!, toMm: vertexesMm(rec)[1]! });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  // слияние зон редактором: одна безымянная (эталон 318)
  const ws = saveMock(server, () => {}, (norm) => divideZones(norm, room, 1));
  await ws.open("0", "1");
  const id = Object.keys((ws.model.zone_delimiters ?? {}) as Record<string, unknown>)[0]!;
  ws.apply("zone_c_remove", (mm) => removeZoneDelimiter(mm, id, { expectedType: "zone_c" }));
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res.warnings));
  // штатное предупреждение об удалении делителя с сервера (он удалён через MCP намеренно)
  assert.ok(res.warnings.some((w) => w.includes("разделители зон")), JSON.stringify(res.warnings));
});

test("319 №1: потеря именованной зоны БЕЗ изменения делителей — по-прежнему не verified", async () => {
  const { m, room } = namedRoomServer(["Гостиная"]);
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let wrote = false;
  const ws = saveMock(server, () => { wrote = true; }, (norm) => {
    divideZones(norm, room, 1); // редактор потерял имя зоны, делителей не было
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as { code?: string; message?: string; details?: { room_mismatches?: string[] } };
    assert.equal(err.code, "NORMALIZATION_DROPPED", err.message ?? String(e));
    assert.ok((err.details?.room_mismatches ?? []).some((p) => p.includes("зоны")), JSON.stringify(err.details));
    return true;
  });
  assert.equal(wrote, false, "модель с потерянной именованной зоной не записывается");
});

// ---------- ревью 319 №8: save не воскрешает делитель, удалённый через MCP ----------

test("319 №8: mock save — нормализация вернула удалённый через MCP делитель → не verified", async () => {
  const { m, room } = namedRoomServer(["Кухня", "Столовая"]);
  addZoneDelimiter(m, room, { type: "zone_c", fromMm: vertexesMm(rec)[0]!, toMm: vertexesMm(rec)[1]! });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let wrote = false;
  const ws = saveMock(server, () => { wrote = true; }, (norm) => {
    // редактор «воскресил» делитель, удалённый через MCP zone_c_remove
    norm["zone_delimiters"] = structuredClone(m.zone_delimiters);
  });
  await ws.open("0", "1");
  const id = Object.keys((ws.model.zone_delimiters ?? {}) as Record<string, unknown>)[0]!;
  ws.apply("zone_c_remove", (mm) => removeZoneDelimiter(mm, id, { expectedType: "zone_c" }));
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as { code?: string; message?: string; details?: { zone_mismatches?: string[] } };
    assert.equal(err.code, "NORMALIZATION_DROPPED", err.message ?? String(e));
    assert.ok((err.details?.zone_mismatches ?? []).some((p) => p.includes("не было в рабочей копии")), JSON.stringify(err.details));
    return true;
  });
  assert.equal(wrote, false, "модель с воскрешённым делителем не записывается");
});
