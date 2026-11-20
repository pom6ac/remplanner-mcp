// 262: регрессионные тесты по находкам ревью 261 (PR #40, зонирование потолка).
// Каждая находка: тест красный на 3a99bf7, зелёный после фикса.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model } from "../../src/model/types.ts";
import {
  addZoneCeiling,
  removeZoneCeiling,
  zoneDelimiterList,
  zoneDelimiterCompare,
  migrateLegacyDelimiter,
  type ZoneDelimiterRec,
} from "../../src/model/zone.ts";
import { compactModel } from "../../src/model/compact.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;
const REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-ceilzone-delimiter.json", "utf8")) as {
  room: { polygon: Array<{ x: number; y: number }>; edges: unknown[] };
  zone_delimiters: Record<string, ZoneDelimiterRec>;
};
const REF_DELIM = Object.values(REF.zone_delimiters)[0]!;
const REF_V = REF_DELIM["vertexes"] as Array<{ point: { x: number; y: number } }>;
const FROM_MM = { x: Math.round(REF_V[0]!.point.x * 10), y: Math.round(REF_V[0]!.point.y * 10) };
const TO_MM = { x: Math.round(REF_V[1]!.point.x * 10), y: Math.round(REF_V[1]!.point.y * 10) };

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

function firstRoomId(m: Model): string {
  const rooms = (m.rooms2 ?? m.rooms1) as Record<string, unknown> | undefined;
  const id = Object.keys(rooms ?? {})[0];
  assert.ok(id, "в фикстуре есть комната");
  return id!;
}

/** Прямоугольная комната 10..390 × 10..310 с рёбрами эталона. */
function modelWithRefRoom(): { m: Model; room: string } {
  const m = baseModel();
  const room = firstRoomId(m);
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  const rec = rooms[room]!;
  rec["polygon"] = structuredClone(REF.room.polygon);
  rec["edges"] = structuredClone(REF.room.edges);
  delete rec["delimiters"];
  return { m, room };
}

function modelLike(rooms: Record<string, unknown>, delims: Record<string, unknown>): Record<string, unknown> {
  return { rooms2: rooms, zone_delimiters: delims };
}

function refModel(delimsKey = "zd1"): Record<string, unknown> {
  return modelLike({ room1: structuredClone(REF.room) as unknown as Record<string, unknown> }, { [delimsKey]: structuredClone(REF_DELIM) });
}

/** Рёбра комнаты по контуру (для синтетических комнат тестов). */
function edgesOf(poly: Array<{ x: number; y: number }>): Array<{ p1: { x: number; y: number }; p2: { x: number; y: number } }> {
  return poly.map((p, i) => ({ p1: p, p2: poly[(i + 1) % poly.length]! }));
}

// ---------- №1: пересечения читают новое хранилище model.zone_delimiters ----------

test("262 №1: две линии, добавленные через add, не могут пересекаться (top-level zone_delimiters)", () => {
  const { m, room } = modelWithRefRoom();
  addZoneCeiling(m, room, { fromMm: { x: 2000, y: 100 }, toMm: { x: 2000, y: 3100 } });
  assert.throws(
    () => addZoneCeiling(m, room, { fromMm: { x: 100, y: 1600 }, toMm: { x: 3900, y: 1600 } }),
    (e: Error) => e instanceof Error && /другой разделитель/.test(e.message),
    "пересечение новых линий отвергается",
  );
});

test("262 №1: legacy per-room линии тоже участвуют в проверке пересечений", () => {
  const { m, room } = modelWithRefRoom();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  rooms[room]!["delimiters"] = {
    old: { type: "zone_ceiling", plan: "ceiling", id_room: room, points: [{ x: 200, y: 10 }, { x: 200, y: 310 }] },
  };
  assert.throws(
    () => addZoneCeiling(m, room, { fromMm: { x: 100, y: 1600 }, toMm: { x: 3900, y: 1600 } }),
    /другой разделитель/,
    "новая линия поперёк legacy — отказ",
  );
});

// ---------- №2: линия обязана лежать внутри полигона комнаты ----------

function gRoomModel(): { m: Model; room: string } {
  const m = baseModel();
  const room = firstRoomId(m);
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  const poly = [
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 },
    { x: 200, y: 200 }, { x: 200, y: 400 }, { x: 0, y: 400 },
  ];
  rooms[room]!["polygon"] = poly;
  rooms[room]!["edges"] = edgesOf(poly);
  delete rooms[room]!["delimiters"];
  return { m, room };
}

test("262 №2: хорда через выемку Г-комнаты (оба конца на рёбрах) — INVALID_ARGUMENT", () => {
  const { m, room } = gRoomModel();
  // отрезок (300,200)-(200,300) целиком в выемке, концы магнитятся к рёбрам
  assert.throws(
    () => addZoneCeiling(m, room, { fromMm: { x: 3000, y: 2000 }, toMm: { x: 2000, y: 3000 } }),
    (e: Error) => /вне комнаты|не магнитится/.test(e.message),
  );
});

test("262 №2: корректная линия внутри Г-комнаты проходит", () => {
  const { m, room } = gRoomModel();
  // (150,0)-(150,400): от нижнего ребра до верхнего, в левой части комнаты
  const res = addZoneCeiling(m, room, { fromMm: { x: 1500, y: 0 }, toMm: { x: 1500, y: 4000 } });
  assert.ok(res.length_mm > 0);
});

// ---------- №3: точка на границе ригеля — не внутренняя ----------

function rigelModel(): { m: Model; room: string } {
  const { m, room } = modelWithRefRoom();
  (m as unknown as { rigels: Record<string, unknown> }).rigels = {
    r1: {
      polygon: [{ x: 150, y: 120 }, { x: 250, y: 120 }, { x: 250, y: 200 }, { x: 150, y: 200 }],
    },
  };
  return { m, room };
}

test("262 №3: конец на каждой из 4 граней ригеля — не «внутри ригеля»", () => {
  const faces: Array<[string, { x: number; y: number }, { x: number; y: number }]> = [
    ["левая", { x: 1500, y: 1600 }, { x: 3900, y: 1600 }],
    ["правая", { x: 2500, y: 1600 }, { x: 100, y: 1600 }],
    ["нижняя", { x: 2000, y: 1200 }, { x: 2000, y: 3100 }],
    ["верхняя", { x: 2000, y: 2000 }, { x: 2000, y: 100 }],
  ];
  for (const [name, from, to] of faces) {
    const { m, room } = rigelModel();
    const res = addZoneCeiling(m, room, { fromMm: from, toMm: to });
    assert.ok(res.length_mm > 0, `грань ${name}: конец на грани ригеля допустим`);
  }
});

test("262 №3: конец строго внутри ригеля по-прежнему отказ", () => {
  const { m, room } = rigelModel();
  // второй ригель, чья нижняя грань проходит внутри первого: конец на ней
  // магнитится, но остаётся строго внутри r1
  (m as unknown as { rigels: Record<string, unknown> }).rigels["r2"] = {
    polygon: [{ x: 200, y: 160 }, { x: 300, y: 160 }, { x: 300, y: 240 }, { x: 200, y: 240 }],
  };
  assert.throws(
    () => addZoneCeiling(m, room, { fromMm: { x: 2200, y: 1600 }, toMm: { x: 3900, y: 1600 } }),
    /внутри ригеля/,
  );});

// ---------- №4: полная проекция графа в сверке ----------

test("262 №4: мутации matrix/items/вершин на сервере ловятся сверкой", () => {
  const cases: Array<[string, (d: ZoneDelimiterRec) => unknown]> = [
    ["matrix → null", (d) => ({ ...structuredClone(d), matrix: [[null, null], [null, null]] })],
    ["items → {}", (d) => {
      const c = structuredClone(d);
      c["items"] = {};
      return c;
    }],
    ["лишняя средняя вершина", (d) => {
      const c = structuredClone(d);
      const vv = c["vertexes"] as NonNullable<ZoneDelimiterRec["vertexes"]>;
      c["vertexes"] = [
        vv[0]!,
        { id: "vm", point: { x: 160.3, y: 160 }, type: "node" },
        vv[1]!,
      ];
      c["items"] = Object.fromEntries((c["vertexes"] as Array<{ id: string }>).map((v) => [v.id, "node"]));
      c["matrix"] = [[null, { length: 1 }, { length: 1 }], [{ length: 1 }, null, { length: 1 }], [{ length: 1 }, { length: 1 }, null]];
      return c;
    }],
    ["длина ребра матрицы изменена", (d) => {
      const c = structuredClone(d);
      c["matrix"] = [[null, { length: 5 }], [{ length: 5 }, null]];
      return c;
    }],
  ];
  for (const [name, mutate] of cases) {
    const got = modelLike(
      { room1: structuredClone(REF.room) as unknown as Record<string, unknown> },
      { zd1: mutate(structuredClone(REF_DELIM)) as Record<string, unknown> },
    );
    for (const mode of ["normalize", "save"] as const) {
      const res = zoneDelimiterCompare(refModel(), got, mode);
      assert.ok(res.problems.length > 0, `${name} (${mode}): мутация поймана`);
    }
  }
  // потеря средней вершины: ожидание с 3 вершинами, сервер с 2
  const exp3 = structuredClone(REF_DELIM);
  const vv = exp3["vertexes"] as NonNullable<ZoneDelimiterRec["vertexes"]>;
  exp3["vertexes"] = [
    vv[0]!,
    { id: "vm", point: { x: 160.3, y: 160 }, type: "node" },
    vv[1]!,
  ];
  exp3["items"] = Object.fromEntries((exp3["vertexes"] as Array<{ id: string }>).map((v) => [v.id, "node"]));
  exp3["matrix"] = [[null, { length: 1 }, { length: 1 }], [{ length: 1 }, null, { length: 1 }], [{ length: 1 }, { length: 1 }, null]];
  const expModel = modelLike({ room1: structuredClone(REF.room) as unknown as Record<string, unknown> }, { zd1: exp3 });
  for (const mode of ["normalize", "save"] as const) {
    const res = zoneDelimiterCompare(expModel, refModel(), mode);
    assert.ok(res.problems.length > 0, `потеря средней вершины (${mode}) поймана`);
  }
  // эталон против себя по-прежнему совпадает (полная проекция)
  for (const mode of ["normalize", "save"] as const) {
    assert.deepEqual(zoneDelimiterCompare(refModel(), refModel(), mode).problems, [], `эталон==эталон (${mode})`);
  }
});

// ---------- №5: исчезновение затронутой комнаты (wall_delete) ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

function wsMock(server: { saveId: string; model: Record<string, unknown> }, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
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

/** Модель: одна эталонная комната + стена её верхнего ребра + разделитель.
 *  Геометрия редактора «ось ≠ грань» (ревью 265 R4): контур комнаты идёт по
 *  грани y=10, ось стены толщиной 20 — на y=0 (грань ± depth/2). */
function wallDeleteModel(): { server: { saveId: string; model: Record<string, unknown> }; m: Model; room: string } {
  const { m, room } = modelWithRefRoom();
  (m as unknown as Record<string, unknown>)["walls"] = {
    w1: { p1: { x: 0, y: 0 }, p2: { x: 400, y: 0 }, depth: 20, plan: "a" },
  };
  addZoneCeiling(m, room, { fromMm: FROM_MM, toMm: TO_MM });
  return { server: { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> }, m, room };
}

test("262 №5: wall_delete в комнате с разделителем, редактор сохранил делитель — без блокировки", async () => {
  const { server, room } = wallDeleteModel();
  const ws = wsMock(server, (norm) => {
    delete (norm["rooms2"] as Record<string, unknown>)[room]; // контур разомкнут
    // zone_delimiters редактор сохранил
  });
  await ws.open("0", "1");
  const res = await ws.applyWalls("wall_delete", (mm) => {
    delete mm.walls["w1"];
    return "deleted";
  });
  assert.equal(res.result, "deleted");
  assert.equal(res.warnings.some((w) => w.includes("zone_topology_changed")), false, "без ложной блокировки делитель — не потеря");
});

test("262 №5: wall_delete, редактор удалил делитель вместе с комнатой — предупреждение с подсказкой", async () => {
  const { server, room } = wallDeleteModel();
  const ws = wsMock(server, (norm) => {
    delete (norm["rooms2"] as Record<string, unknown>)[room];
    delete norm["zone_delimiters"]; // каскад редактора
  });
  await ws.open("0", "1");
  const res = await ws.applyWalls("wall_delete", (mm) => {
    delete mm.walls["w1"];
    return "deleted";
  });
  assert.ok(
    res.warnings.some((w) => w.includes("zone_ceiling_remove") || w.includes("сначала удалите разделители")),
    JSON.stringify(res.warnings),
  );
});

test("262 №5: незатронутая комната с делителем исчезла — по-прежнему отказ (ревью 263 N8: по details, не regex)", async () => {
  const { server, room } = wallDeleteModel();
  const ws = wsMock(server, (norm) => {
    delete (norm["rooms2"] as Record<string, unknown>)[room];
  });
  await ws.open("0", "1");
  // стены не менялись — комната исчезла без причины; проверяем детали отказа,
  // а не общий regex (ревью 263 N8): отказ именно от сверки разделителей —
  // zone_mismatches непуст и объясняет потерю делителя исчезнувшей комнаты
  await assert.rejects(() => ws.applyWalls("noop", () => "ok"), (e: unknown) => {
    const err = e as { code?: string; details?: Record<string, unknown> };
    assert.equal(err.code, "INVALID_GEOMETRY", `код: ${err.code}`);
    const details = err.details ?? {};
    const zm = details["zone_mismatches"] as string[] | undefined;
    assert.ok(Array.isArray(zm) && zm.some((p) => p.includes("потерян")), JSON.stringify(details).slice(0, 400));
    return true;
  });
});

// ---------- №6: legacy points-форма vs нормализованная — обе стороны ----------

function legacyPointsRec(): Record<string, unknown> {
  return {
    id: "legacy1",
    type: "d_ceiling",
    plan: "ceiling",
    id_room: "room1",
    points: [REF_V[0]!.point, REF_V[1]!.point],
  };
}

test("262 №6: локальная legacy (points, без on_size/length) → normalize top-level — без проблем, save не блокируется", () => {
  const exp = refModel();
  const got = modelLike(
    { room1: structuredClone(REF.room) as unknown as Record<string, unknown> },
    { legacy1: legacyPointsRec() },
  );
  // миграция дописывает on_size 1 и length по геометрии
  const mig = migrateLegacyDelimiter(legacyPointsRec());
  assert.equal(mig["on_size"], 1);
  assert.equal(mig["length"], REF_DELIM["length"]);
  for (const mode of ["normalize", "save"] as const) {
    assert.deepEqual(zoneDelimiterCompare(exp, got, mode).problems, [], `legacy ожидание → top-level сервер (${mode})`);
    assert.deepEqual(zoneDelimiterCompare(got, exp, mode).problems, [], `top-level ожидание → legacy сервер (${mode})`);
  }
});

// ---------- №7: одна нумерация ZD во всех путях ----------

test("262 №7: list/remove/compact нумеруют одинаково; remove(\"ZD1\") удаляет то, что list показал как ZD1", () => {
  const { m, room } = modelWithRefRoom();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  rooms[room]!["delimiters"] = { old: legacyPointsRec() };
  const added = addZoneCeiling(m, room, { fromMm: { x: 2000, y: 100 }, toMm: { x: 2000, y: 3100 } });
  const list = zoneDelimiterList(m);
  assert.equal(list.length, 2);
  assert.equal(list[0]!["site_id"], "legacy1", "ZD1 — legacy points-форма");
  assert.equal(list[1]!["site_id"], added.id, "ZD2 — новая запись");
  // compact — те же метки
  const compact = compactModel(m);
  assert.deepEqual(compact["zone_delimiters"].map((d) => [d.id, d.site_id]), [["ZD1", "legacy1"], ["ZD2", added.id]]);
  // remove по метке удаляет тот же объект
  const removed = removeZoneCeiling(m, "ZD1");
  assert.equal(removed.removed, true);
  assert.equal(rooms[room]!["delimiters"], undefined, "удалён legacy-объект, а не новый");
  const list2 = zoneDelimiterList(m);
  assert.equal(list2.length, 1);
  assert.equal(list2[0]!["site_id"], added.id);
  assert.equal(removeZoneCeiling(m, added.id).removed, true, "остаток удаляется по id сайта");
  assert.deepEqual(zoneDelimiterList(m), []);
  assert.throws(() => removeZoneCeiling(m, "ZD1"), /не найден/);
});

// ---------- живой эталон 262: split с перепривязкой конца разделителя ----------

test("262 эталон 262: split — редактор перепривязал конец к новой стене (сдвиг 5 см) — предупреждение, не отказ, в save тоже", () => {
  // ожидание (нормализованная копия): делитель (1773,100)-(1863,5) в левой части
  const expDelim = structuredClone(REF_DELIM) as unknown as Record<string, unknown>;
  (expDelim["vertexes"] as Array<{ point: { x: number; y: number } }>)[0]!.point = { x: 1773, y: 100 };
  (expDelim["vertexes"] as Array<{ point: { x: number; y: number } }>)[1]!.point = { x: 1863, y: 5 };
  expDelim["length"] = 1.31;
  expDelim["id_room"] = "left";
  const exp = modelLike(
    {
      left: { polygon: [{ x: 1863, y: 5 }, { x: 1863, y: 195 }, { x: 1773, y: 195 }, { x: 1773, y: 5 }] },
      right: { polygon: [{ x: 2063, y: 5 }, { x: 2063, y: 195 }, { x: 1873, y: 195 }, { x: 1873, y: 5 }] },
    },
    { zd1: expDelim },
  );
  // сервер: конец перепривязан к новой стене, точка сдвинута до (1863,10),
  // id_room другой (редактор пересоздаёт id комнат)
  const srvDelim = structuredClone(expDelim);
  (srvDelim["vertexes"] as Array<{ point: { x: number; y: number } }>)[1]!.point = { x: 1863, y: 10 };
  srvDelim["id_room"] = "srvLeft";
  const got = modelLike(
    {
      srvLeft: { polygon: [{ x: 1863, y: 5 }, { x: 1863, y: 195 }, { x: 1773, y: 195 }, { x: 1773, y: 5 }] },
      srvRight: { polygon: [{ x: 2063, y: 5 }, { x: 2063, y: 195 }, { x: 1873, y: 195 }, { x: 1873, y: 5 }] },
    },
    { zd1x: srvDelim },
  );
  const opts = { affectedRooms: new Set(["left"]) };
  for (const mode of ["normalize", "save"] as const) {
    const res = zoneDelimiterCompare(exp, got, mode, opts);
    assert.deepEqual(res.problems, [], `${mode}: перепривязанный делитель не блокирует`);
    assert.ok(
      res.warnings.some((w) => w.includes("zone_topology_changed")),
      `${mode}: предупреждение о переопределении присутствует`,
    );
  }
  // без затронутости той же расхождение — проблема (мутации ловятся)
  const strict = zoneDelimiterCompare(exp, got, "save");
  assert.ok(strict.problems.length > 0, "без affectedRooms сверка строга");
});
