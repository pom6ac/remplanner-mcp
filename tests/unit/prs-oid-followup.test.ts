// Этап 399 — follow-up ревью 397 (раздел «Follow-up», находки A, B, D, E):
//  - A: prs_set на комнате с пустым edges_prs — консервативный отказ
//    (редактор назначает oid случайно: Projections.getLines `oid=LIB.id()`,
//    LIB.id — `"_"+Math.random().toString(36).substr(2,5)`, @20601/@2684842
//    бандла), ключи derived_<i> не пишутся; сверка save ловит ключ
//    prs_disabled/prs_first, не совпадающий ни с одним oid edges_prs
//    (новый — ошибка, унаследованный — предупреждение, как №18);
//  - B: runSave с унаследованной висячей нишей — save verified, предупреждение;
//  - D: sameState «до/после» по стене ребра (+сторона) — перенумерация рёбер
//    без ложного «сброшены»;
//  - E: split/merge — «наследник не однозначен (разделение/слияние)».
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { prsSettingsMismatches, prsSettingsResetWarnings } from "../../src/verify/projections.ts";
import { setPrsSettings, hasRealPrsLayout } from "../../src/model/projections.ts";
import { Workspace } from "../../src/workspace.ts";
import type { Model } from "../../src/model/types.ts";

type AnyRec = Record<string, unknown>;

/** Прямоугольная комната 400×300 со стенами w1 (низ), w2 (право), w3 (верх), w4 (лево). */
function baseModel(): Model {
  return {
    v: 1, id: "o1", plan_id: "1", total_height: 270, final: false,
    walls: {
      w1: { id: "w1", plan: "a", role: "wall", depth: 20, height: 280, material: "a_block", p1: { x: 0, y: 0 }, p2: { x: 400, y: 0 }, holes: {} },
      w2: { id: "w2", plan: "a", role: "wall", depth: 20, height: 280, material: "a_block", p1: { x: 400, y: 0 }, p2: { x: 400, y: 300 }, holes: {} },
      w3: { id: "w3", plan: "a", role: "wall", depth: 20, height: 280, material: "a_block", p1: { x: 400, y: 300 }, p2: { x: 0, y: 300 }, holes: {} },
      w4: { id: "w4", plan: "a", role: "wall", depth: 20, height: 280, material: "a_glass", p1: { x: 0, y: 300 }, p2: { x: 0, y: 0 }, holes: {} },
    },
    items: {}, pillars: {}, rulers: {}, comments: {},
    rooms2: {
      roomA: {
        name: "Гостиная", plan: "rooms", height: 270, area: 12,
        polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
        points: [], pc: null, corners: [],
        zones: [{ name: "Гостиная" }], floors: [], ceilings: [], decors: [],
        edges: [
          { p1: { x: 0, y: 0 }, p2: { x: 400, y: 0 }, pid: "w1", length: 400, room_side: "l" },
          { p1: { x: 400, y: 0 }, p2: { x: 400, y: 300 }, pid: "w2", length: 300, room_side: "l" },
          { p1: { x: 400, y: 300 }, p2: { x: 0, y: 300 }, pid: "w3", length: 400, room_side: "l" },
          { p1: { x: 0, y: 300 }, p2: { x: 0, y: 0 }, pid: "w4", length: 300, room_side: "l" },
        ],
        edges_prs: [
          { edge_index: 0, p1: { x: 0, y: 0 }, p2: { x: 400, y: 0 }, oid: "oid1", pillars: [] },
          { edge_index: 1, p1: { x: 400, y: 0 }, p2: { x: 400, y: 300 }, oid: "oid2", pillars: [] },
          { edge_index: 2, p1: { x: 400, y: 300 }, p2: { x: 0, y: 300 }, oid: "oid3", pillars: [] },
          { edge_index: 3, p1: { x: 0, y: 300 }, p2: { x: 0, y: 0 }, oid: "oid4", pillars: [] },
        ],
        prs_disabled: {}, prs_first: 0, prs_hidden: 0,
      },
    },
  } as unknown as Model;
}

function roomOf(m: Model): AnyRec {
  return ((m.rooms2 as AnyRec)["roomA"] ?? {}) as AnyRec;
}

const throwsInvalid = (fn: () => unknown): { code?: string; message?: string } => {
  try {
    fn();
  } catch (e) {
    return e as { code?: string; message?: string };
  }
  return {};
};

// ---------- 399 A: prs_set без раскладки развёрток ----------

test("399 A: prs_set (записи под oid) на комнате с пустым edges_prs — INVALID_ARGUMENT, ключи derived_<i> не пишутся", () => {
  const params: Array<Parameters<typeof setPrsSettings>[2]> = [
    { hidden: true },
    { firstWall: "w2" },
    { hideWalls: ["w2"] },
  ];
  for (const p of params) {
    const m = baseModel();
    (roomOf(m) as AnyRec)["edges_prs"] = [];
    const err = throwsInvalid(() => setPrsSettings(m, "R1", p));
    assert.equal(err.code, "INVALID_ARGUMENT", `отказ для ${JSON.stringify(p)}: ${JSON.stringify(err)}`);
    assert.match(err.message ?? "", /раскладк/, `понятный текст: ${String(err.message)}`);
    assert.match(err.message ?? "", /Развёртк/i, "подсказка — открыть развёртки в редакторе");
    // находка 3 ревью 400: текст отказа адресован агенту — раскладку создаёт
    // ПОЛЬЗОВАТЕЛЬ (MCP сам её не создаёт)
    assert.match(err.message ?? "", /пользовател|попросите/, `текст для агента: ${String(err.message)}`);
    const room = roomOf(m);
    assert.deepEqual(Object.keys((room["prs_disabled"] as AnyRec) ?? {}), [], `prs_disabled не тронут (${JSON.stringify(p)})`);
    assert.equal(room["prs_first"], 0, `prs_first не тронут (${JSON.stringify(p)})`);
    assert.ok(!JSON.stringify(room).includes("derived_"), `синтетических ключей нет (${JSON.stringify(p)})`);
  }
});

// ---------- 401 №5: гард не блокирует операции, которым oid не нужен ----------

test("401 №5: hidden:false на комнате без раскладки — очищает prs_disabled (в т.ч. унаследованные derived_*) и prs_hidden", () => {
  const m = baseModel();
  const room = roomOf(m);
  (room as AnyRec)["edges_prs"] = [];
  (room["prs_disabled"] as unknown as AnyRec) = { derived_2: "", derived_3: "" } as never;
  (room["prs_hidden"] as unknown) = 1;
  const st = setPrsSettings(m, "R1", { hidden: false });
  assert.equal(st.hidden, false);
  assert.deepEqual(Object.keys((roomOf(m)["prs_disabled"] as AnyRec) ?? {}), [], "prs_disabled очищен");
  assert.equal((roomOf(m)["prs_hidden"] as unknown), 0, "prs_hidden=0");
});

test("401 №5: show_walls на комнате без раскладки — снимает унаследованный derived_* ключ", () => {
  const m = baseModel();
  const room = roomOf(m);
  (room as AnyRec)["edges_prs"] = [];
  (room["prs_disabled"] as unknown as AnyRec) = { derived_1: "" } as never; // скрыто ребро w2 (derived_1)
  const st = setPrsSettings(m, "R1", { showWalls: ["w2"] });
  assert.deepEqual(Object.keys((roomOf(m)["prs_disabled"] as AnyRec) ?? {}), [], "унаследованный ключ снят");
  assert.deepEqual(st.disabled_edges, []);
  assert.equal((roomOf(m)["prs_hidden"] as unknown), 0);
});

test("401 №5: first_wall:null на комнате без раскладки — prs_first=0 (авто) без отказа", () => {
  const m = baseModel();
  const room = roomOf(m);
  (room as AnyRec)["edges_prs"] = [];
  (room["prs_first"] as unknown) = "derived_0";
  setPrsSettings(m, "R1", { firstWall: null });
  assert.equal((roomOf(m)["prs_first"] as unknown), 0, "prs_first сброшен в авто");
});

test("399 A: раскладка частичная (запись edges_prs без oid) — тоже отказ", () => {
  const m = baseModel();
  const room = roomOf(m);
  (room["edges_prs"] as AnyRec[])[1] = { edge_index: 1, p1: { x: 400, y: 0 }, p2: { x: 400, y: 300 } };
  assert.equal(hasRealPrsLayout(room as never), false);
  const err = throwsInvalid(() => setPrsSettings(m, "R1", { hideWalls: ["w2"] }));
  assert.equal(err.code, "INVALID_ARGUMENT");
  assert.match(err.message ?? "", /раскладк/);
});

test("399 A (в обе стороны): раскладка есть — prs_set пишет ключи, совпадающие с oid edges_prs", () => {
  const m = baseModel();
  assert.equal(hasRealPrsLayout(roomOf(m) as never), true);
  const st = setPrsSettings(m, "R1", { hideWalls: ["w2"], firstWall: "w3" });
  const room = roomOf(m);
  const oids = ((room["edges_prs"] as AnyRec[]) ?? []).map((e) => e["oid"]);
  assert.deepEqual(st.disabled_edges, [1]);
  assert.deepEqual(Object.keys((room["prs_disabled"] as AnyRec) ?? {}), ["oid2"], "ключ — oid из edges_prs");
  assert.equal(room["prs_first"], "oid3");
  for (const k of Object.keys((room["prs_disabled"] as AnyRec) ?? {})) {
    assert.ok(oids.includes(k), `ключ ${k} — среди oid edges_prs`);
  }
  assert.ok(oids.includes(room["prs_first"] as string));
});

// ---------- 399 A: сверка save по ключам prs_disabled/prs_first ----------

test("399 A: сверка save — НОВЫЙ висячий ключ prs_disabled (derived_<i>) — ошибка", () => {
  const m = baseModel();
  const before = (m.rooms2 as AnyRec) as Record<string, AnyRec>;
  const after = structuredClone(before) as Record<string, AnyRec>;
  const room = after["roomA"] as AnyRec;
  (room["prs_disabled"] as AnyRec) = { derived_2: "" };
  const out = prsSettingsMismatches(before, after);
  assert.equal(out.problems.length, 1, `новый висячий ключ — ошибка: ${JSON.stringify(out)}`);
  assert.match(out.problems[0]!, /derived_2/);
  assert.match(out.problems[0]!, /не совпадает ни с одним oid edges_prs/);
  assert.deepEqual(out.warnings, []);
  // prs_first с несуществующим oid — тоже ошибка
  const afterFirst = structuredClone(before) as Record<string, AnyRec>;
  ((afterFirst["roomA"] as AnyRec)["prs_first"] as string) = "derived_0";
  const outFirst = prsSettingsMismatches(before, afterFirst);
  assert.equal(outFirst.problems.length, 1);
  assert.match(outFirst.problems[0]!, /derived_0/);
});

test("399 A: сверка save — унаследованный висячий ключ (был и в expected) — предупреждение, не ошибка", () => {
  const m = baseModel();
  const before = (m.rooms2 as AnyRec) as Record<string, AnyRec>;
  ((before["roomA"] as AnyRec)["prs_disabled"] as AnyRec) = { legacyX: "" };
  const after = structuredClone(before) as Record<string, AnyRec>;
  const out = prsSettingsMismatches(before, after);
  assert.deepEqual(out.problems, [], `унаследованный висячий ключ не блокирует save: ${JSON.stringify(out)}`);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0]!, /legacyX/);
  assert.match(out.warnings[0]!, /унаследован/);
});

test("399 A: сверка save — skip при изменённой нарезке и для висячих ключей (wall-операция)", () => {
  const m = baseModel();
  const before = (m.rooms2 as AnyRec) as Record<string, AnyRec>;
  const after = structuredClone(before) as Record<string, AnyRec>;
  ((after["roomA"] as AnyRec)["prs_disabled"] as AnyRec) = { derived_9: "" };
  ((after["roomA"] as AnyRec)["edges_prs"] as unknown[]).push({ edge_index: 4, p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, oid: "oid5" });
  assert.deepEqual(prsSettingsMismatches(before, after).problems, []);
});

// ---------- 399 B: runSave с унаследованной висячей нишей ----------

function danglingNiche(): AnyRec {
  return {
    id: "n1", type: "wall_niche", pc: { x: 120, y: 180 }, width: 40, height: 40, depth: 20,
    plan: "projections", plan_: "projections", on_size: 1,
    prs: { room: "roomGONE", edge_index: 0, pc_xd: 100, pc_yd: 150 },
  };
}

function wsDanglingDeps(server: { saveId: string; model: Model }) {
  let lastNormalized: Record<string, unknown> | null = null;
  const editor = {
    objectId: "123", planId: "1",
    async normalize(model: unknown) {
      const out = structuredClone(model) as Record<string, unknown>;
      lastNormalized = out;
      return { model: out, rooms: [], before: { walls: 4, holes: 0, items: 0 }, after: { walls: 4, holes: 0, items: 0 } };
    },
    async save() {
      server.saveId = `s${Math.random()}`;
      server.model = structuredClone(lastNormalized ?? server.model) as unknown as Model;
      return { ok: true, saveId: server.saveId, conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { throw new Error("not used"); },
    async close() {},
  };
  return {
    session: { cookies: [] },
    async loadModel() {
      return { object_id: "123", plan_id: "1", save_id: server.saveId, units: "cm", model: structuredClone(server.model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  } as unknown as import("../../src/workspace.ts").WorkspaceDeps;
}

test("399 B: runSave с унаследованной висячей нишей — save verified, предупреждение есть", async () => {
  const server = { saveId: "s1", model: baseModel() };
  (server.model as AnyRec)["wall_niches"] = { n1: danglingNiche() };
  const ws = new Workspace(wsDanglingDeps(server) as never);
  await ws.open("123", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, `унаследованная висячая ниша не блокирует save: ${JSON.stringify(res.warnings)}`);
  assert.ok(
    res.warnings.some((w) => /висячая ссылка prs\.room/.test(w)),
    `предупреждение о висячей prs.room в разводке warnings: ${JSON.stringify(res.warnings)}`,
  );
});

// ---------- 399 D: sameState по стене ребра (+сторона) ----------

/** Пересозданная комната с перенумерованными рёбрами: массив edges начинается
 *  с другой вершины (w2,w3,w4,w1), oid edges_prs перегенерированы (n1..n4),
 *  настройки перенесены на те же стены (w3 скрыта, первая — w2). */
function renumbered(m: Model, disabledOid: string, firstOid: string): Model {
  const after = structuredClone(m) as Model;
  const rooms = (after.rooms2 as AnyRec) as Record<string, AnyRec>;
  const src = rooms["roomA"]!;
  const rotatedEdges = [
    (src["edges"] as AnyRec[])[1]!,
    (src["edges"] as AnyRec[])[2]!,
    (src["edges"] as AnyRec[])[3]!,
    (src["edges"] as AnyRec[])[0]!,
  ];
  const rotatedPrs = [
    (src["edges_prs"] as AnyRec[])[1]!,
    (src["edges_prs"] as AnyRec[])[2]!,
    (src["edges_prs"] as AnyRec[])[3]!,
    (src["edges_prs"] as AnyRec[])[0]!,
  ].map((e, i) => ({ ...e, edge_index: i, oid: `n${i + 1}` }));
  const roomB: AnyRec = { ...structuredClone(src), edges: rotatedEdges, edges_prs: rotatedPrs, prs_disabled: { [disabledOid]: "" }, prs_first: firstOid };
  delete rooms["roomA"];
  rooms["roomB"] = roomB;
  return after;
}

test("399 D: перенумерация рёбер пересозданной комнаты (настройки на тех же стенах) — без ложного «сброшены»", () => {
  const m = baseModel();
  setPrsSettings(m, "R1", { hideWalls: ["w3"], firstWall: "w2" });
  const roomA = roomOf(m);
  assert.deepEqual(
    [...Object.keys(roomA["prs_disabled"] as AnyRec), roomA["prs_first"] as string].sort(),
    ["oid2", "oid3"],
  );
  // редактор пересоздал комнату: рёбра с другой вершины (w3 теперь ребро 1),
  // настройки перенесены по геометрии (restoreElementPrs) под новыми oid
  const after = renumbered(m, "n2", "n1");
  const out = prsSettingsResetWarnings(m, after);
  assert.deepEqual(out, [], `та же стена (+сторона) — ложного предупреждения нет: ${JSON.stringify(out)}`);
  // настройка уехала на ДРУГУЮ стену — предупреждение о сбросе есть
  const reset = renumbered(m, "n1", "n1"); // скрыта w2 вместо w3
  const outReset = prsSettingsResetWarnings(m, reset);
  assert.equal(outReset.length, 1);
  assert.match(outReset[0]!, /сброшены/);
});

// ---------- 399 E: split/merge — «наследник не однозначен» ----------

function roomsFromPolygons(list: Array<{ rid: string; poly: Array<{ x: number; y: number }>; disabled?: string }>): Record<string, AnyRec> {
  const out: Record<string, AnyRec> = {};
  for (const { rid, poly, disabled } of list) {
    out[rid] = {
      name: rid, plan: "rooms", height: 270, area: 12,
      polygon: poly, points: [], pc: null, corners: [],
      zones: [{ name: rid }], floors: [], ceilings: [], decors: [],
      edges: [], edges_prs: [], prs_disabled: disabled ? { [disabled]: "" } : {}, prs_first: 0, prs_hidden: 0,
    };
  }
  return out;
}

const FULL: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }];
const LEFT: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 300 }, { x: 0, y: 300 }];
const RIGHT: Array<{ x: number; y: number }> = [{ x: 200, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 200, y: 300 }];

test("399 E: split — «наследник не однозначен (разделение/слияние)», а не «не найден»", () => {
  const before = { roomA: { ...roomsFromPolygons([{ rid: "roomA", poly: FULL, disabled: "oid3" }])["roomA"]! } };
  const after = roomsFromPolygons([
    { rid: "roomL", poly: LEFT },
    { rid: "roomR", poly: RIGHT },
  ]);
  const out = prsSettingsResetWarnings({ rooms2: before } as never, { rooms2: after } as never as Model);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /roomA/);
  assert.match(out[0]!, /наследник не однозначен — разделение\/слияние/, `split: ${JSON.stringify(out)}`);
  // merge — две комнаты слились в одну: обе получают ту же формулировку
  const before2 = roomsFromPolygons([
    { rid: "roomL", poly: LEFT, disabled: "o1" },
    { rid: "roomR", poly: RIGHT },
  ]);
  const after2 = roomsFromPolygons([{ rid: "roomM", poly: FULL }]);
  const out2 = prsSettingsResetWarnings({ rooms2: before2 } as never, { rooms2: after2 } as never as Model);
  assert.equal(out2.length, 1);
  assert.match(out2[0]!, /наследник не однозначен — разделение\/слияние/);
});

test("399 E: комната исчезла без наследника — прежняя формулировка «наследник не найден»", () => {
  const before = { roomA: { ...roomsFromPolygons([{ rid: "roomA", poly: FULL, disabled: "oid3" }])["roomA"]! } };
  const after = { roomFar: { ...roomsFromPolygons([{ rid: "roomFar", poly: [{ x: 1000, y: 1000 }, { x: 1200, y: 1000 }, { x: 1200, y: 1200 }, { x: 1000, y: 1200 }] }])["roomFar"]! } };
  const out = prsSettingsResetWarnings({ rooms2: before } as never, { rooms2: after } as never as Model);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /наследник не найден/);
});

// ---------- 401 №4: sameState — мультимножество рёбер одной стены ----------

/** Комната со стеной w5, разрезанной колонной на ДВА ребра одной стороны
 *  (рёбра 0 и 1), плюс ребро 2 (w6); edges_prs с oid a/b/c. */
function splitWallModel(disabledOids: string[]): Model {
  const room = {
    name: "Комната", plan: "rooms", height: 270, area: 12,
    polygon: FULL, points: [], pc: null, corners: [],
    zones: [{ name: "Комната" }], floors: [], ceilings: [], decors: [],
    edges: [
      { p1: { x: 0, y: 0 }, p2: { x: 200, y: 0 }, pid: "w5", length: 200, room_side: "l" },
      { p1: { x: 200, y: 0 }, p2: { x: 400, y: 0 }, pid: "w5", length: 200, room_side: "l" },
      { p1: { x: 400, y: 0 }, p2: { x: 0, y: 300 }, pid: "w6", length: 500, room_side: "l" },
    ],
    edges_prs: [
      { edge_index: 0, p1: { x: 0, y: 0 }, p2: { x: 200, y: 0 }, oid: "a", pillars: [] },
      { edge_index: 1, p1: { x: 200, y: 0 }, p2: { x: 400, y: 0 }, oid: "b", pillars: [] },
      { edge_index: 2, p1: { x: 400, y: 0 }, p2: { x: 0, y: 300 }, oid: "c", pillars: [] },
    ],
    prs_disabled: Object.fromEntries(disabledOids.map((o) => [o, ""])), prs_first: 0, prs_hidden: 0,
  };
  return {
    walls: {
      w5: { id: "w5", plan: "a", role: "wall", depth: 20, height: 280, material: "a_block", p1: { x: 0, y: 0 }, p2: { x: 400, y: 0 }, holes: {} },
      w6: { id: "w6", plan: "a", role: "wall", depth: 20, height: 280, material: "a_block", p1: { x: 400, y: 0 }, p2: { x: 0, y: 300 }, holes: {} },
    },
    rooms2: { roomA: room },
  } as unknown as Model;
}

/** Пересозданная комната (403 №9): обход контура начат с ДРУГОГО ребра —
 *  ротация order, oid edges_prs перегенерированы (n1..n3), настройки
 *  переносятся под новыми oid. */
function rotatedSplitWall(before: Model, order: number[], disabledOids: string[], firstOid: string | 0 = 0): Model {
  const src = (((before.rooms2 as AnyRec) as Record<string, AnyRec>)["roomA"] ?? {}) as AnyRec;
  const room: AnyRec = { ...structuredClone(src) };
  const pick = (key: string): AnyRec[] =>
    order.map((i) => structuredClone((src[key] as AnyRec[])[i]!));
  room["edges"] = pick("edges");
  room["edges_prs"] = pick("edges_prs").map((e, i) => ({ ...e, edge_index: i, oid: `n${i + 1}` }));
  room["prs_disabled"] = Object.fromEntries(disabledOids.map((o) => [o, ""]));
  room["prs_first"] = firstOid;
  return { walls: structuredClone(before.walls), rooms2: { roomA: room } } as unknown as Model;
}

test("401 №4: два сегмента одной стены, редактор сбросил один — предупреждение о сбросе", () => {
  const before = splitWallModel(["a", "b"]); // скрыты ОБА сегмента w5
  const after = splitWallModel(["a"]); // редактор сбросил один
  const out = prsSettingsResetWarnings(before, after);
  assert.equal(out.length, 1, `сброс одного из двух сегментов той же стены ловится: ${JSON.stringify(out)}`);
  assert.match(out[0]!, /сброшены/);
  // оба сегмента живы после пересоздания (рёбра с другой вершины, настройки
  // перенесены на те же стены под новыми oid) — ложного «сброшены» нет
  const afterKept = structuredClone(before) as Model;
  const room = ((afterKept.rooms2 as AnyRec) as Record<string, AnyRec>)["roomA"] as AnyRec;
  const rot = <T,>(arr: T[]): T[] => [arr[2]!, arr[0]!, arr[1]!];
  (room["edges"] as AnyRec[]) = rot((room["edges"] as AnyRec[]).map((e) => structuredClone(e)));
  (room["edges_prs"] as AnyRec[]) = rot((room["edges_prs"] as AnyRec[]).map((e) => structuredClone(e)))
    .map((e, i) => ({ ...e, edge_index: i, oid: `n${i + 1}` }));
  // скрыты те же два сегмента w5 (сегменты 1 и 2 → новые рёбра 1 и 2, oid n2/n3)
  (room["prs_disabled"] as unknown as AnyRec) = { n2: "", n3: "" } as never;
  assert.deepEqual(prsSettingsResetWarnings(before, afterKept), [], `оба сегмента живы — предупреждения нет: ${JSON.stringify(prsSettingsResetWarnings(before, afterKept))}`);
});

// ---------- 403 №9: порядок вдоль стены — по положению на стене, не по обходу ----------

test("403 №9: скрыт один сегмент w5, пересоздание с обходом МЕЖДУ сегментами (ротация [1,2,0]) — без ложного «сброшены»", () => {
  // скрыт сегмент 0..200 (oid a); после пересоздания обход начат с сегмента
  // 200..400: сегмент 0..200 — ребро 2 (oid n3), но на стене он ПО-ПРЕЖНЕМУ
  // первый (проекция середины x=100 < x=300) — настройки не сброшены
  const before = splitWallModel(["a"]);
  const after = rotatedSplitWall(before, [1, 2, 0], ["n3"]);
  const out = prsSettingsResetWarnings(before, after);
  assert.deepEqual(out, [], `тот же сегмент скрыт — сброса нет: ${JSON.stringify(out)}`);
  // «первая» — тот же сегмент
  const beforeFirst = splitWallModel([]);
  ((beforeFirst.rooms2 as AnyRec as Record<string, AnyRec>)["roomA"]!["prs_first"] as unknown) = "a";
  const afterFirst = rotatedSplitWall(beforeFirst, [1, 2, 0], [], "n3");
  assert.deepEqual(prsSettingsResetWarnings(beforeFirst, afterFirst), [], "«первая» — тот же сегмент: сброса нет");
});

test("403 №9: сверка save — ротация [1,2,0] сегментов разрезанной стены — без ложной problem", () => {
  const before = splitWallModel(["a"]);
  const after = rotatedSplitWall(before, [1, 2, 0], ["n3"]);
  const walls = (structuredClone(before.walls) ?? {}) as Record<string, unknown>;
  const out = prsSettingsMismatches(
    (before.rooms2 as AnyRec) as Record<string, AnyRec>,
    (after.rooms2 as AnyRec) as Record<string, AnyRec>,
    walls,
  );
  assert.deepEqual(out.problems, [], `тот же сегмент скрыт — problem нет: ${JSON.stringify(out)}`);
  assert.deepEqual(out.warnings, []);
  // настройка уехала на ДРУГОЙ сегмент той же стены — problem есть (негатив)
  const other = rotatedSplitWall(before, [1, 2, 0], ["n1"]); // скрыт сегмент 200..400
  const outOther = prsSettingsMismatches(
    (before.rooms2 as AnyRec) as Record<string, AnyRec>,
    (other.rooms2 as AnyRec) as Record<string, AnyRec>,
    walls,
  );
  assert.equal(outOther.problems.length, 1, `сброс одного сегмента ловится: ${JSON.stringify(outOther)}`);
  assert.match(outOther.problems[0]!, /набор скрытых развёрток изменился/);
});

// ---------- 401 №8: prsSettingsMismatches — семантика по стене, как в sameState ----------

test("401 №8: сверка save — сдвинутая нумерация рёбер при той же нарезке — без ложной problem", () => {
  const m = baseModel();
  setPrsSettings(m, "R1", { hideWalls: ["w3"], firstWall: "w2" });
  const before = (m.rooms2 as AnyRec) as Record<string, AnyRec>;
  // редактор пересоздал комнату с той же нарезкой, но рёбра с другой вершины
  const after = structuredClone(before) as Record<string, AnyRec>;
  const room = after["roomA"] as AnyRec;
  const rot = <T,>(arr: T[]): T[] => [arr[1]!, arr[2]!, arr[3]!, arr[0]!];
  (room["edges"] as AnyRec[]) = rot((room["edges"] as AnyRec[]).map((e) => structuredClone(e)));
  (room["edges_prs"] as AnyRec[]) = rot((room["edges_prs"] as AnyRec[]).map((e) => structuredClone(e)))
    .map((e, i) => ({ ...e, edge_index: i, oid: `n${i + 1}` }));
  (room["prs_disabled"] as AnyRec) = { n2: "" }; // та же стена w3 (ребро 1 после сдвига)
  (room["prs_first"] as unknown) = "n1"; // та же стена w2 (ребро 0 после сдвига)
  const out = prsSettingsMismatches(before, after);
  assert.deepEqual(out.problems, [], `та же стена (+порядок) — ложной problem нет: ${JSON.stringify(out)}`);
  assert.deepEqual(out.warnings, []);
  // настройка уехала на ДРУГУЮ стену — problem есть
  const reset = structuredClone(after) as Record<string, AnyRec>;
  ((reset["roomA"] as AnyRec)["prs_disabled"] as AnyRec) = { n1: "" }; // w2 вместо w3
  const outReset = prsSettingsMismatches(before, reset);
  assert.equal(outReset.problems.length, 1);
  assert.match(outReset.problems[0]!, /набор скрытых развёрток изменился/);
});

// ---------- 401 №7: edges_prs не массив — Array.isArray-защита в тексте отказа ----------

test("401 №7: edges_prs не массив (legacy) при новом висячем ключе — проблема без TypeError", () => {
  const m = baseModel();
  const before = (m.rooms2 as AnyRec) as Record<string, AnyRec>;
  ((before["roomA"] as AnyRec)["edges_prs"] as unknown) = null; // legacy/rooms1-запись
  const after = structuredClone(before) as Record<string, AnyRec>;
  const room = after["roomA"] as AnyRec;
  (room["edges_prs"] as unknown) = null;
  (room["prs_disabled"] as AnyRec) = { legacyX: "" };
  const out = prsSettingsMismatches(before, after);
  assert.equal(out.problems.length, 1, `висячий ключ пойман без TypeError: ${JSON.stringify(out)}`);
  assert.match(out.problems[0]!, /legacyX/);
  assert.match(out.problems[0]!, /развертки комнаты: нет/);
});
