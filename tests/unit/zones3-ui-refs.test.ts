// 303: тесты потолочных закладных (ceiling_rigel) — эталон UI в обе стороны,
// атомарность, магнит/углы, update-цепочки, удаление (без каскада на разделители
// — живой эталон 303), сверка save (normalize/save, затронутые комнаты),
// mock save (NORMALIZATION_DROPPED, SITE_ERROR с ceiling_rigel_mismatches).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model, Wall } from "../../src/model/types.ts";
import { addCeilingRigel, updateCeilingRigel, deleteCeilingRigel, ceilingRigelCompare } from "../../src/model/ceiling-rigels.ts";
import { addZoneCeiling } from "../../src/model/zone.ts";
import { compactModel } from "../../src/model/compact.ts";
import { finishList } from "../../src/model/finish.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";

const REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-zones3-ceiling-rigel.json", "utf8")) as {
  room: { polygon: { x: number; y: number }[]; edges: unknown[] };
  rigels: Record<string, {
    id: string; id_room?: string;
    p1: { x: number; y: number; link?: unknown };
    p2: { x: number; y: number; link?: unknown };
    width: number; ceiling_type: string; polygon: { x: number; y: number }[];
  }>;
  zone_delimiters: Record<string, Record<string, unknown>>;
};

/** Комната эталона как запись rooms2. */
function refRoom(): Record<string, unknown> {
  return { polygon: structuredClone(REF.room.polygon), edges: structuredClone(REF.room.edges) };
}

/** Стены-рамка: боковые грани совпадают с рёбрами синтетической комнаты. */
function refWalls(): Record<string, Wall> {
  const mk = (id: string, p1: { x: number; y: number }, p2: { x: number; y: number }): Wall =>
    ({ id, plan: "a", role: "wall", child: 0, archive: 0, demount: 0, depth: 20, height: 270, p1: { ...p1, role: "p1", link: 0 }, p2: { ...p2, role: "p2", link: 0 } }) as unknown as Wall;
  return {
    wall1: mk("wall1", { x: 400, y: 0 }, { x: 400, y: 320 }),
    wall2: mk("wall2", { x: 0, y: 320 }, { x: 400, y: 320 }),
    wall3: mk("wall3", { x: 0, y: 0 }, { x: 0, y: 320 }),
    wall4: mk("wall4", { x: 0, y: 0 }, { x: 400, y: 0 }),
  };
}

function modelWithRefRoom(): { m: Model; room: string } {
  const m = { walls: refWalls(), pillars: {}, items: {}, rigels: {}, rooms2: { room1: refRoom() } } as unknown as Model;
  return { m, room: "room1" };
}

function roomsOf(m: Model): Record<string, Record<string, unknown>> {
  return (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
}

const RG = REF.rigels["rg1"]!;
const START_MM = { x: RG.p1.x * 10, y: RG.p1.y * 10 };
const END_MM = { x: RG.p2.x * 10, y: RG.p2.y * 10 };

function modelLike(rooms: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return { rooms2: rooms };
}

// ---------- эталон в обе стороны ----------

test("303: эталон UI — ceiling_rigel_add совпадает с закладной кликами (обе стороны)", () => {
  const { m, room } = modelWithRefRoom();
  const res = addCeilingRigel(m, room, { start: START_MM, end: END_MM });
  const written = Object.values((roomsOf(m)[room]!["rigels"] ?? {}) as Record<string, Record<string, unknown>>)[0]!;
  // m1 ревью 304: запись ≅ эталон целиком — маскированный deepEqual (лишний или
  // потерянный ключ заметен); маскируются только id и id_room
  const mask = (r: Record<string, unknown>): Record<string, unknown> => {
    const c = structuredClone(r);
    c["id"] = "<id>";
    delete c["id_room"];
    return c;
  };
  assert.deepEqual(mask(written), mask(RG as unknown as Record<string, unknown>), "запись MCP ≅ эталон UI (маскированы id/id_room)");
  void res;
  // сверка в обе стороны (эталон как сервер, запись как ожидание — и наоборот)
  const exp = modelLike({ room1: { polygon: structuredClone(REF.room.polygon), rigels: structuredClone(REF.rigels) } });
  const got = modelLike(structuredClone(roomsOf(m)));
  for (const mode of ["normalize", "save"] as const) {
    assert.deepEqual(ceilingRigelCompare(exp, got, mode).problems, [], `expected→got ${mode}`);
    assert.deepEqual(ceilingRigelCompare(got, exp, mode).problems, [], `got→expected ${mode}`);
  }
});

test("303: finish_get и compact — закладные с метками CR<n>; update ширины пересчитывает полигон", () => {
  const { m, room } = modelWithRefRoom();
  const res = addCeilingRigel(m, room, { start: START_MM, end: END_MM });
  const list = finishList(m, room);
  const rec = list[0] as { ceiling_rigels?: Array<Record<string, unknown>> };
  assert.ok(rec.ceiling_rigels && rec.ceiling_rigels.length === 1);
  const cr = rec.ceiling_rigels![0]!;
  assert.equal(cr["site_id"], res.id);
  assert.equal(cr["id"], "CR1");
  assert.equal(cr["room_id"], room);
  assert.equal(cr["width_mm"], 100);
  const compact = compactModel(m) as unknown as { ceiling_rigels: Array<Record<string, unknown>> };
  assert.equal(compact.ceiling_rigels.length, 1);
  assert.equal(compact.ceiling_rigels[0]!["id"], "CR1");
  assert.deepEqual(compact.ceiling_rigels[0]!["from"], [2000, 100]);
  assert.deepEqual(compact.ceiling_rigels[0]!["to"], [2000, 3100]);
  // update ширины (как контекстное меню) — полигон пересчитан
  updateCeilingRigel(m, res.id, { widthMm: 300 });
  const rec2 = Object.values((roomsOf(m)[room]!["rigels"] ?? {}) as Record<string, { width: number; polygon: { x: number; y: number }[] }>)[0]!;
  assert.equal(rec2.width, 30);
  assert.equal(rec2.polygon[0]!.x, 205 + 10, "полигон ±width/2 (30 см → 215)");
  // удаление: комната без закладных — ключ rigels остаётся пустым ({}, как в
  // редакторе — живой дамп 303-after-delete.json, m10 ревью 304)
  assert.equal(deleteCeilingRigel(m, res.id).room_id, room);
  assert.deepEqual(roomsOf(m)[room]!["rigels"], {});
  assert.throws(() => deleteCeilingRigel(m, res.id), /не найден/);
  assert.throws(() => deleteCeilingRigel(m, "CR5"), /не найден/);
});

// ---------- атомарность, магнит, отказы ----------

test("303: атомарность — отказы add не меняют модель; магнит 30 мм; концы на одной грани", () => {
  const { m, room } = modelWithRefRoom();
  const before = structuredClone(roomsOf(m));
  // оба конца в центре — нет грани рядом
  assert.throws(() => addCeilingRigel(m, room, { start: { x: 2000, y: 1600 }, end: { x: 2000, y: 1601 } }), /от стены до стены/);
  // конец в 40 мм от грани — вне магнита 30 мм
  assert.throws(() => addCeilingRigel(m, room, { start: { x: 2000, y: 140 }, end: { x: 2000, y: 3060 } }), /от стены до стены/);
  // оба конца на одной грани (нижняя стена)
  assert.throws(() => addCeilingRigel(m, room, { start: { x: 2000, y: 100 }, end: { x: 2400, y: 100 } }), /от стены до стены/);
  // неизвестная комната
  assert.throws(() => addCeilingRigel(m, "R99", { start: START_MM, end: END_MM }), /не найдена/);
  assert.deepEqual(roomsOf(m), before, "после всех отказов модель без изменений");
  // магнит: конец в 20 мм от грани прилипает
  addCeilingRigel(m, room, { start: { x: 2000, y: 120 }, end: { x: 2000, y: 3080 } });
  const rec = Object.values((roomsOf(m)[room]!["rigels"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>)[0]!;
  assert.equal(rec.p1.y, 10, "конец прилип к грани (20 мм → магнит)");
  assert.equal(rec.p2.y, 310);
});

test("303: конец у угла грани отодвигается на width/2 от угла (cursor редактора)", () => {
  const { m, room } = modelWithRefRoom();
  // конец запрошен в 30 мм от угла нижней стены — магнит сработает и отодвинет
  // конец от угла на width/2 (5 см)
  addCeilingRigel(m, room, { start: { x: 2000, y: 3080 }, end: { x: 2000, y: 100 } });
  const rec = Object.values((roomsOf(m)[room]!["rigels"] ?? {}) as Record<string, { p1: { x: number; y: number } }>)[0]!;
  assert.ok(rec.p1.y >= 15, `конец отодвинут от угла: ${rec.p1.y} >= 15 см`);
});

test("303: закладная не пересекает zone_ceiling (mouseup редактора)", () => {
  const { m, room } = modelWithRefRoom();
  addZoneCeiling(m, room, { fromMm: { x: 3900, y: 1600 }, toMm: { x: 100, y: 1600 } });
  assert.throws(() => addCeilingRigel(m, room, { start: START_MM, end: END_MM }), /пересекает разделитель зон/);
});

// ---------- update ----------

test("303: update — ширина и отделка; пределы панели; сброс отделки", () => {
  const { m, room } = modelWithRefRoom();
  const res = addCeilingRigel(m, room, { start: START_MM, end: END_MM });
  assert.equal(updateCeilingRigel(m, res.id, { ceilingType: "gypsum_ceiling" }).ceiling_type, "gypsum_ceiling");
  assert.throws(() => updateCeilingRigel(m, res.id, { widthMm: 50 }), /меньше минимума/);
  assert.throws(() => updateCeilingRigel(m, res.id, { widthMm: 2000 }), /больше максимума/);
  assert.throws(() => updateCeilingRigel(m, res.id, { ceilingType: "nope" }), /ceiling_type/);
  assert.equal(updateCeilingRigel(m, res.id, { ceilingType: "" }).ceiling_type, "");
  assert.throws(() => updateCeilingRigel(m, "CR99", { widthMm: 100 }), /не найден/);
  void room;
});

test("303: удаление закладной не трогает разделители зон (живой эталон 303)", () => {
  const { m, room } = modelWithRefRoom();
  const rg = addCeilingRigel(m, room, { start: START_MM, end: END_MM });
  const zd = addZoneCeiling(m, room, { fromMm: { x: 3900, y: 1600 }, toMm: { x: 2050, y: 1600 } });
  const delimsBefore = structuredClone(m.zone_delimiters);
  assert.equal(deleteCeilingRigel(m, rg.id).room_id, room);
  assert.deepEqual(m.zone_delimiters, delimsBefore, "разделители зон не тронуты");
  void zd;
});

// ---------- сверка save / затронутые комнаты ----------

function refModelLike(): Record<string, Record<string, unknown>> {
  return modelLike({ room1: { polygon: structuredClone(REF.room.polygon), rigels: structuredClone(REF.rigels) } });
}

test("303: сверка — ширина/тип изменены сервером, потеря, лишняя (save строго)", () => {
  const exp = refModelLike();
  const changed = modelLike({ room1: { polygon: structuredClone(REF.room.polygon), rigels: { rg1: { ...structuredClone(RG), width: 20 } } } });
  for (const mode of ["normalize", "save"] as const) {
    const res = ceilingRigelCompare(exp["rooms2"], changed["rooms2"], mode);
    assert.ok(res.problems.some((p) => p.includes("изменилась")), `${mode}: смена ширины видна`);
  }
  const lost = modelLike({ room1: { polygon: structuredClone(REF.room.polygon) } });
  for (const mode of ["normalize", "save"] as const) {
    const res = ceilingRigelCompare(exp["rooms2"], lost["rooms2"], mode);
    assert.ok(res.problems.some((p) => p.includes("потеряна")), `${mode}: потеря видна`);
  }
  const extra = modelLike({ room1: { polygon: structuredClone(REF.room.polygon), rigels: { ...structuredClone(REF.rigels), extra: { ...structuredClone(RG), id: "extra1" } } } });
  assert.deepEqual(ceilingRigelCompare(exp["rooms2"], extra["rooms2"], "normalize").problems, [], "лишняя в normalize — не отказ");
  assert.ok(ceilingRigelCompare(exp["rooms2"], extra["rooms2"], "save").problems.some((p) => p.includes("unexpected")), "лишняя в save — отказ");
});

test("303: сверка — затронутая комната (normalize: предупреждение; save: проблема)", () => {
  const exp = refModelLike();
  const moved = modelLike({ room1: { polygon: structuredClone(REF.room.polygon), rigels: { rg1: { ...structuredClone(RG), p1: { ...RG.p1, y: 20 } } } } });
  const norm = ceilingRigelCompare(exp["rooms2"], moved["rooms2"], "normalize", { affectedRooms: new Set(["room1"]) });
  assert.deepEqual(norm.problems, [], "затронутая комната в normalize — без отказов");
  assert.ok(norm.warnings.length > 0, "но с предупреждением");
  const save = ceilingRigelCompare(exp["rooms2"], moved["rooms2"], "save", { affectedRooms: new Set(["room1"]) });
  assert.ok(save.problems.length > 0, "в save — строго");
  // ось цела, полигон пересчитан редактором — предупреждение (normalize)
  const reshaped = modelLike({ room1: { polygon: structuredClone(REF.room.polygon), rigels: { rg1: { ...structuredClone(RG), polygon: [{ x: 206, y: 10 }, { x: 206, y: 310 }, { x: 194, y: 310 }, { x: 194, y: 10 }] } } } });
  const same = ceilingRigelCompare(exp["rooms2"], reshaped["rooms2"], "normalize", { affectedRooms: new Set(["room1"]) });
  assert.deepEqual(same.problems, [], "форма пересчитана, ось цела — предупреждение, не отказ");
});

test("303: сверка — split комнаты: закладная в части (normalize — без отказов)", () => {
  const exp = refModelLike();
  const partRigels = structuredClone(REF.rigels);
  for (const r of Object.values(partRigels)) r.id_room = "partR";
  const got = modelLike({
    partL: { polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 200, y: 310 }, { x: 200, y: 10 }] },
    partR: { polygon: [{ x: 200, y: 10 }, { x: 200, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }], rigels: partRigels },
  });
  const norm = ceilingRigelCompare(exp["rooms2"], got["rooms2"], "normalize");
  assert.deepEqual(norm.problems, [], "split в normalize — без отказов");
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

function mockModelWithRigel(): { m: Model; room: string } {
  const { m, room } = modelWithRefRoom();
  (m as unknown as Record<string, unknown>)["rooms2"] = { [room]: structuredClone(roomsOf(m)[room]!) };
  addCeilingRigel(m, room, { start: START_MM, end: END_MM });
  return { m, room };
}

test("303: mock save — закладная доезжает до сервера, verified", async () => {
  const { m } = mockModelWithRigel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

test("303: mock save — нормализация потеряла закладную → NORMALIZATION_DROPPED, записи нет", async () => {
  const { m } = mockModelWithRigel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let wrote = false;
  const ws = saveMock(server, () => { wrote = true; }, (norm) => {
    const rooms = norm["rooms2"] as Record<string, Record<string, unknown>>;
    for (const r of Object.values(rooms)) delete r["rigels"];
  });
  await ws.open("0", "1");
  // m9 ревью 304: сверяется details.ceiling_rigel_mismatches (не только текст ошибки),
  // иначе тест зелёный, даже если сработала другая сверка (rooms/finish)
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as Error & { details?: Record<string, unknown> };
    assert.match(err.message, /NORMALIZATION_DROPPED|потерял объекты/);
    const cm = err.details?.["ceiling_rigel_mismatches"] as string[] | undefined;
    assert.ok(Array.isArray(cm) && cm.some((p) => p.includes("потеряна")), `details.ceiling_rigel_mismatches: ${JSON.stringify(err.details)?.slice(0, 400)}`);
    return true;
  });
  assert.equal(wrote, false, "модель с потерянной закладной не записывается");
});

test("303: mock save — сервер потерял закладную после save → SITE_ERROR с ceiling_rigel_mismatches", async () => {
  const { m } = mockModelWithRigel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const rooms = s.model["rooms2"] as Record<string, Record<string, unknown>>;
    for (const r of Object.values(rooms)) delete r["rigels"];
  });
  await ws.open("0", "1");
  await assert.rejects(async () => ws.save(), (e: Error) => {
    const details = (e as Error & { details?: Record<string, unknown> }).details ?? {};
    const cm = details["ceiling_rigel_mismatches"] as string[] | undefined;
    assert.ok(Array.isArray(cm) && cm.some((p) => p.includes("потеряна")), JSON.stringify(details).slice(0, 600));
    return true;
  });
});

// ---------- 307 (повторное ревью 306): N1 — сверка без ложных problem из-за id_room ----------

/** Нормализация редактора, эмулирующая CeilingRigel.serialize: у записи остаются
 *  только id/p1/p2/width/ceiling_type/polygon — id_room редактор не выводит
 *  (бандл 268: serialize(){return copy.object({id,p1,p2,width,ceiling_type,polygon})}). */
function normalizeLikeSerialize(norm: Record<string, unknown>): void {
  const rooms = (norm["rooms2"] ?? norm["rooms1"]) as Record<string, Record<string, unknown>> | undefined;
  if (!rooms) return;
  for (const r of Object.values(rooms)) {
    const rigels = r["rigels"] as Record<string, Record<string, unknown>> | undefined;
    if (!rigels) continue;
    for (const [k, rec] of Object.entries(rigels)) {
      rigels[k] = {
        id: rec["id"],
        p1: rec["p1"],
        p2: rec["p2"],
        width: rec["width"],
        ceiling_type: rec["ceiling_type"],
        polygon: rec["polygon"],
      };
    }
  }
}

test("307 N1: id_room только у одной стороны (serialize без id_room) — без problem в normalize и save", () => {
  const exp = refModelLike(); // эталон с id_room (как раньше писала MCP / restore редактора)
  const got = structuredClone(exp) as Record<string, Record<string, unknown>>;
  for (const r of Object.values(((got["rooms2"] as Record<string, Record<string, unknown>>)["room1"])!["rigels"] as Record<string, Record<string, unknown>>)) {
    delete r["id_room"]; // так отдаёт CeilingRigel.serialize
  }
  for (const mode of ["normalize", "save"] as const) {
    assert.deepEqual(ceilingRigelCompare(exp["rooms2"], got["rooms2"], mode).problems, [], `id_room у одной стороны не судится (${mode})`);
    assert.deepEqual(ceilingRigelCompare(got["rooms2"], exp["rooms2"], mode).problems, [], `обратное направление (${mode})`);
  }
});

test("307 N1/N6: add → normalize как CeilingRigel.serialize (без id_room) → save verified, без NORMALIZATION_DROPPED", async () => {
  const { m, room } = modelWithRefRoom(); // сервер без закладной
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, normalizeLikeSerialize);
  await ws.open("0", "1");
  ws.apply("ceiling_rigel_add", (mm) => {
    addCeilingRigel(mm, room, { start: START_MM, end: END_MM });
    return true;
  });
  const res = await ws.save();
  assert.equal(res.verified, true, `save verified, warnings: ${JSON.stringify(res.warnings ?? [])}`);
});

test("307 N1: запись MCP не содержит id_room (формат CeilingRigel.serialize редактора)", () => {
  const { m, room } = modelWithRefRoom();
  addCeilingRigel(m, room, { start: START_MM, end: END_MM });
  const written = Object.values((roomsOf(m)[room]!["rigels"] ?? {}) as Record<string, Record<string, unknown>>)[0]!;
  assert.ok(!("id_room" in written), `id_room не пишется (serialize редактора его не выводит): ${Object.keys(written).join(",")}`);
});

test("307 N1: правка стен в проекте с MCP-закладной — без отката (нормализация без id_room)", async () => {
  const { m } = mockModelWithRigel();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, normalizeLikeSerialize);
  await ws.open("0", "1");
  // свободная стена вдали от комнаты с закладной — правка стен в режиме редактора
  await ws.applyWalls("wall_add", (mm) => {
    mm.walls["new1"] = {
      id: "new1", plan: "a", role: "wall", child: 0, archive: 0, demount: 0, depth: 20, height: 270,
      p1: { x: 600, y: 500, role: "p1", link: 0 }, p2: { x: 640, y: 500, role: "p2", link: 0 },
    } as unknown as Wall;
    return "new1";
  });
});

void refModelLike;
