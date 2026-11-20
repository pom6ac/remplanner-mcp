// 260: тесты зонирования потолка (zone_ceiling) — эталон UI в обе стороны,
// атомарность, update-цепочки, удаление/split/merge без висячих ссылок,
// mock save (NORMALIZATION_DROPPED, SITE_ERROR с zone_mismatches), legacy-формы.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model } from "../../src/model/types.ts";
import { addZoneCeiling, removeZoneCeiling, zoneDelimiterList, zoneDelimiterCompare, migrateLegacyDelimiter } from "../../src/model/zone.ts";
import { finishList } from "../../src/model/finish.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;

const REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-ceilzone-delimiter.json", "utf8")) as {
  room: {
    polygon: { x: number; y: number }[];
    edges: Array<{ p1?: { x: number; y: number }; p2?: { x: number; y: number }; side?: string; pid?: string; pids?: Record<string, string>; length?: number; c?: { x: number; y: number }; parent?: string; room_side?: string; inRoom?: number }>;
  };
  zone_delimiters: Record<string, Record<string, unknown>>;
};

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

function firstRoomId(m: Model): string {
  const rooms = (m.rooms2 ?? m.rooms1) as Record<string, unknown> | undefined;
  const id = Object.keys(rooms ?? {})[0];
  assert.ok(id, "в фикстуре есть комната");
  return id!;
}

function roomsOf(m: Model): Record<string, Record<string, unknown>> {
  return (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
}

/** Модель с эталонной комнатой (прямоугольник 10..390 × 10..310, рёбра эталона). */
function modelWithRefRoom(): { m: Model; room: string } {
  const m = baseModel();
  const room = firstRoomId(m);
  const rooms = roomsOf(m);
  const rec = rooms[room]!;
  rec["polygon"] = structuredClone(REF.room.polygon);
  rec["edges"] = structuredClone(REF.room.edges);
  delete rec["delimiters"];
  return { m, room };
}

const REF_DELIM = Object.values(REF.zone_delimiters)[0]!;
type V = { point: { x: number; y: number } };
const REF_V = REF_DELIM["vertexes"] as V[];
const FROM_MM = { x: Math.round(REF_V[0]!.point.x * 10), y: Math.round(REF_V[0]!.point.y * 10) };
const TO_MM = { x: Math.round(REF_V[1]!.point.x * 10), y: Math.round(REF_V[1]!.point.y * 10) };

/** Модель-подобная запись: комнаты + верхнеуровневые zone_delimiters. */
function modelLike(rooms: Record<string, unknown>, delims: Record<string, unknown>): Record<string, unknown> {
  return { rooms2: rooms, zone_delimiters: delims };
}

function refModel(delimsKey = "zd1"): Record<string, unknown> {
  const rooms = { room1: structuredClone(REF.room) as unknown as Record<string, unknown> };
  return modelLike(rooms, { [delimsKey]: structuredClone(REF_DELIM) });
}

// ---------- эталон в обе стороны ----------

test("260: эталон UI — запись инструмента совпадает с эталоном кликами (обе стороны)", () => {
  const { m, room } = modelWithRefRoom();
  const res = addZoneCeiling(m, room, { fromMm: FROM_MM, toMm: TO_MM });
  assert.equal(res.length_mm, Number(REF_DELIM["length"]) * 1000, "длина в мм по эталону");
  const written = Object.values((m.zone_delimiters ?? {}) as Record<string, Record<string, unknown>>)[0]!;
  // форма — как сериализация редактора (без производной zone)
  assert.equal(written["type"], "zone_ceiling");
  assert.equal(written["plan"], "ceiling");
  assert.equal(written["on_size"], 1);
  assert.equal(written["length"], REF_DELIM["length"]);
  assert.equal(written["id_room"], room);
  const v = written["vertexes"] as Array<{ point: { x: number; y: number } }>;
  assert.deepEqual(v[0]!.point, REF_V[0]!.point, "конец на ребре (магнит)");
  assert.deepEqual(v[1]!.point, REF_V[1]!.point);
  assert.deepEqual(written["matrix"], REF_DELIM["matrix"]);
  assert.deepEqual(Object.values(written["items"] as Record<string, string>), ["node", "node"]);
  assert.deepEqual(
    (written["vertexes"] as Array<{ id: string }>).map((x) => x.id).sort(),
    Object.keys(written["items"] as Record<string, string>).sort(),
    "items — ключи по вершинам",
  );
  // сверка в обе стороны (эталон как сервер, запись как ожидание — и наоборот);
  // zone — производное редактора: сверка по сигнатуре её не читает
  const expModel = refModel();
  const gotModel = modelLike({ [room]: roomsOf(m)[room]! }, structuredClone(m.zone_delimiters as Record<string, unknown>));
  for (const mode of ["normalize", "save"] as const) {
    assert.deepEqual(zoneDelimiterCompare(expModel, gotModel, mode).problems, [], `expected→got ${mode}`);
    assert.deepEqual(zoneDelimiterCompare(gotModel, expModel, mode).problems, [], `got→expected ${mode}`);
  }
});

test("260: finish_get содержит zone_delimiters с метками ZD<n> и site_id", () => {
  const { m, room } = modelWithRefRoom();
  const res = addZoneCeiling(m, room, { fromMm: FROM_MM, toMm: TO_MM });
  const list = finishList(m, room);
  const rec = list[0] as { zone_delimiters?: Array<Record<string, unknown>> };
  assert.ok(rec.zone_delimiters && rec.zone_delimiters.length === 1);
  const z = rec.zone_delimiters![0]!;
  assert.equal(z["site_id"], res.id);
  assert.equal(z["type"], "zone_ceiling");
  assert.equal(z["length_mm"], res.length_mm);
  assert.equal(z["room_id"], room);
  // remove по метке ZD1
  const removed = removeZoneCeiling(m, "ZD1");
  assert.equal(removed.removed, true);
  assert.equal(zoneDelimiterList(m).length, 0);
  // у комнаты без разделителей ключ delimiters не появляется (канонический вид)
  assert.equal(roomsOf(m)[room]!["delimiters"], undefined);
});

// ---------- атомарность и отказы ----------

test("260: атомарность — отказы add не меняют delimiters; update-цепочка remove→add", () => {
  const { m, room } = modelWithRefRoom();
  addZoneCeiling(m, room, { fromMm: FROM_MM, toMm: TO_MM });
  // ревью 261 №9: запись идёт в верхнеуровневое zone_delimiters — сверять его
  const before = structuredClone(m.zone_delimiters);
  // короче 100 мм (проверка длины — до магнита)
  assert.throws(() => addZoneCeiling(m, room, { fromMm: { x: 2000, y: 1600 }, toMm: { x: 2005, y: 1600 } }), /короче минимальной/);
  // центр комнаты — нет магнита
  assert.throws(() => addZoneCeiling(m, room, { fromMm: { x: 2000, y: 1600 }, toMm: { x: 2600, y: 1600 } }), /не магнитится/);
  assert.deepEqual(m.zone_delimiters, before, "delimiters не изменились при отказе");
  // оба конца на одном ребре
  assert.throws(() => addZoneCeiling(m, room, { fromMm: { x: 1200, y: 100 }, toMm: { x: 2400, y: 100 } }), /одном ребре/);
  // неизвестная комната
  assert.throws(() => addZoneCeiling(m, "R99", { fromMm: FROM_MM, toMm: TO_MM }), /не найдена/);
  assert.deepEqual(m.zone_delimiters, before, "после всех отказов delimiters без изменений");
  // update-цепочка: снять и поставить снова
  removeZoneCeiling(m, "ZD1");
  assert.equal(zoneDelimiterList(m).length, 0);
  const again = addZoneCeiling(m, room, { fromMm: FROM_MM, toMm: TO_MM });
  assert.notEqual(again.id, Object.keys(before ?? {})[0], "новый id сайта");
  assert.equal(zoneDelimiterList(m).length, 1);
});

test("260: удаление — по id сайта и метке ZD<n>; чужие разделители не задеты; NOT_FOUND", () => {
  const { m, room } = modelWithRefRoom();
  const first = addZoneCeiling(m, room, { fromMm: FROM_MM, toMm: TO_MM });
  // второй разделитель между левым и правым ребром
  const second = addZoneCeiling(m, room, { fromMm: { x: 2000, y: 200 }, toMm: { x: 2000, y: 3000 } });
  assert.equal(zoneDelimiterList(m).length, 2);
  assert.equal(removeZoneCeiling(m, "ZD1").removed, true);
  const left = zoneDelimiterList(m);
  assert.equal(left.length, 1);
  assert.equal(left[0]!["site_id"], second.id, "второй разделитель не задет");
  assert.equal(removeZoneCeiling(m, second.id).removed, true, "удаление по id сайта");
  assert.throws(() => removeZoneCeiling(m, first.id), /не найден/);
  assert.throws(() => removeZoneCeiling(m, "ZD5"), /не найден/);
});

// ---------- split/merge без висячих ссылок ----------

test("260: split комнаты — делитель переживает разрез (normalize: предупреждение, не отказ)", () => {
  const { m, room } = modelWithRefRoom();
  addZoneCeiling(m, room, { fromMm: FROM_MM, toMm: TO_MM });
  const expModel = structuredClone(m) as unknown as Record<string, unknown>;
  // got: комната разрезана на две части (левая/правая), делитель id_room → partR
  const gotDelims = structuredClone(m.zone_delimiters as Record<string, Record<string, unknown>>);
  for (const d of Object.values(gotDelims)) d["id_room"] = "partR";
  const got: Record<string, unknown> = modelLike(
    {
      partL: { polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 200, y: 310 }, { x: 200, y: 10 }] },
      partR: { polygon: [{ x: 200, y: 10 }, { x: 200, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }] },
    },
    gotDelims,
  );
  const norm = zoneDelimiterCompare(m as unknown as Record<string, unknown>, got, "normalize");
  assert.deepEqual(norm.problems, [], "split — без отказов (стандарт редактора эталоном не снят)");
  assert.equal(norm.warnings.length, 0, "делитель, переживший split по геометрии, без предупреждений");
  // делитель, попавший в разрезанную комнату без наследников, — потеря (проблема)
  const gotEmpty: Record<string, unknown> = modelLike(
    {
      partL: { polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 200, y: 310 }, { x: 200, y: 10 }] },
      partR: { polygon: [{ x: 200, y: 10 }, { x: 200, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }] },
    },
    {},
  );
  const lost = zoneDelimiterCompare(m as unknown as Record<string, unknown>, gotEmpty, "normalize");
  assert.ok(lost.problems.some((p) => p.includes("потерян")), JSON.stringify(lost));
  void got;
  void m;
  void room;
});

test("260: merge комнат — делитель источника в объединённой комнате (normalize), в save строго", () => {
  const mergedDelims = structuredClone(REF.zone_delimiters);
  for (const d of Object.values(mergedDelims as Record<string, Record<string, unknown>>)) d["id_room"] = "big";
  const merged: Record<string, unknown> = modelLike(
    { big: { polygon: structuredClone(REF.room.polygon) } },
    mergedDelims,
  );
  const srcDelims = structuredClone(REF.zone_delimiters);
  for (const d of Object.values(srcDelims as Record<string, Record<string, unknown>>)) d["id_room"] = "srcB";
  const source: Record<string, unknown> = modelLike(
    {
      srcA: { polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 200, y: 310 }, { x: 200, y: 10 }] },
      srcB: { polygon: [{ x: 200, y: 10 }, { x: 200, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }] },
    },
    srcDelims,
  );
  const norm = zoneDelimiterCompare(source, merged, "normalize");
  assert.deepEqual(norm.problems, [], "merge в normalize — без проблем (делитель пережил слияние по геометрии)");
  // в save-режиме — строго: делитель с id комнаты источника не совпал
  const save = zoneDelimiterCompare(source, merged, "save");
  assert.ok(save.problems.length > 0, "в save-режиме merge строго");
});

test("260: потеря делителя в той же комнате (перенос стены без split) — проблема в обоих режимах", () => {
  const { m, room } = modelWithRefRoom();
  addZoneCeiling(m, room, { fromMm: FROM_MM, toMm: TO_MM });
  const got = modelLike(structuredClone(roomsOf(m)), {});
  for (const mode of ["normalize", "save"] as const) {
    const res = zoneDelimiterCompare(m as unknown as Record<string, unknown>, got, mode);
    assert.ok(res.problems.some((p) => p.includes("потерян")), `${mode}: потеря обнаружена`);
  }
});

test("260: неожиданный делитель на сервере — SITE_ERROR (только save)", () => {
  const base = modelWithRefRoom();
  addZoneCeiling(base.m, base.room, { fromMm: FROM_MM, toMm: TO_MM });
  const gotDelims = structuredClone(base.m.zone_delimiters as Record<string, Record<string, unknown>>);
  gotDelims["extra"] = structuredClone(REF_DELIM);
  const got = modelLike(structuredClone(roomsOf(base.m)), gotDelims);
  assert.deepEqual(zoneDelimiterCompare(base.m as unknown as Record<string, unknown>, got, "normalize").problems, []);
  assert.ok(zoneDelimiterCompare(base.m as unknown as Record<string, unknown>, got, "save").problems.some((p) => p.includes("неожиданный")));
});

// ---------- legacy-формы ----------

test("260: legacy-типы d_ceiling/points мигрируют (convertOld редактора) и не блокируют save", () => {
  const legacy = structuredClone(REF_DELIM);
  legacy["type"] = "d_ceiling";
  delete legacy["vertexes"];
  delete legacy["items"];
  delete legacy["matrix"];
  legacy["points"] = [REF_V[0]!.point, REF_V[1]!.point];
  const mig = migrateLegacyDelimiter(legacy);
  assert.equal(mig["type"], "zone_ceiling");
  const got = modelLike({ room1: { polygon: structuredClone(REF.room.polygon) } }, { old: structuredClone(mig) });
  const exp = refModel();
  assert.deepEqual(zoneDelimiterCompare(exp, got, "save").problems, [], "legacy-форма совпадает с новой");
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

test("260: mock save — делитель зон потолка доезжает до сервера, verified", async () => {
  const { m, room } = modelWithRefRoom();
  addZoneCeiling(m, room, { fromMm: FROM_MM, toMm: TO_MM });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

test("260: mock save — нормализация потеряла делитель → NORMALIZATION_DROPPED, записи нет", async () => {
  const { m, room } = modelWithRefRoom();
  addZoneCeiling(m, room, { fromMm: FROM_MM, toMm: TO_MM });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let wrote = false;
  const ws = saveMock(server, () => { wrote = true; }, (norm) => {
    delete norm["zone_delimiters"];
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => e instanceof Error && /NORMALIZATION_DROPPED|потерял объекты/.test(e.message));
  assert.equal(wrote, false, "модель с потерянным делителем не записывается");
});

test("260: mock save — сервер потерял делитель после save → SITE_ERROR с zone_mismatches", async () => {
  const { m, room } = modelWithRefRoom();
  addZoneCeiling(m, room, { fromMm: FROM_MM, toMm: TO_MM });
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
