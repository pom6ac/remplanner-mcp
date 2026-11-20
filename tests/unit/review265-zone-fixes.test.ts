// 266: регрессионные тесты по находкам ревью 265 (PR #40, зонирование потолка).
// Геометрия «ось ≠ грань» — как у редактора: контур комнаты идёт по грани стены,
// изменённая стена задана осью (ось = грань ± depth/2). Каждая находка: тест
// красный на bfa5cac, зелёный после фикса.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model } from "../../src/model/types.ts";
import { addZoneCeiling, zoneDelimiterCompare } from "../../src/model/zone.ts";
import { roomsChangePolicy, zoneAffectedRoomIds } from "../../src/model/rooms-save.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";

type Pt = { x: number; y: number };
const P = (x: number, y: number): Pt => ({ x, y });

function edgesOf(poly: Pt[]): Array<{ p1: Pt; p2: Pt }> {
  return poly.map((p, i) => ({ p1: p, p2: poly[(i + 1) % poly.length]! }));
}

function delimRec(id: string, idRoom: string, p1: Pt, p2: Pt): Record<string, unknown> {
  return {
    id,
    type: "zone_ceiling",
    plan: "ceiling",
    id_room: idRoom,
    matrix: [[null, { length: 1 }], [{ length: 1 }, null]],
    vertexes: [
      { id: `${id}a`, point: p1, type: "node" },
      { id: `${id}b`, point: p2, type: "node" },
    ],
    items: { [`${id}a`]: "node", [`${id}b`]: "node" },
    length: Math.round((Math.hypot(p2.x - p1.x, p2.y - p1.y) / 100) * 100) / 100,
    on_size: 1,
  };
}

// A и B: оси x=0/200/400, y=0/300, толщина 10 — грани комнат на 5 см от осей.
const A_POLY = [P(5, 5), P(195, 5), P(195, 295), P(5, 295)];
const B_POLY = [P(205, 5), P(395, 5), P(395, 295), P(205, 295)];
const WALLS = {
  w_top: { p1: P(0, 0), p2: P(400, 0), depth: 10, plan: "a" },
  w_right: { p1: P(400, 0), p2: P(400, 300), depth: 10, plan: "a" },
  w_bottom: { p1: P(400, 300), p2: P(0, 300), depth: 10, plan: "a" },
  w_left: { p1: P(0, 300), p2: P(0, 0), depth: 10, plan: "a" },
  w_shared: { p1: P(200, 0), p2: P(200, 300), depth: 10, plan: "a" },
};
const ROOMS = { A: { polygon: A_POLY, edges: edgesOf(A_POLY) }, B: { polygon: B_POLY, edges: edgesOf(B_POLY) } };

function affected(now: Record<string, unknown>, rooms: Record<string, unknown> = ROOMS): string[] {
  const set = zoneAffectedRoomIds({ rooms2: rooms }, roomsChangePolicy(rooms, WALLS, now as never));
  return [...(set ?? [])].sort();
}

// ---------- R1: затронутость по грани стены (ось ± depth/2) ----------

test("265 R1: удаление общей стены (ось между гранями) затрагивает обе комнаты", () => {
  const now: Record<string, unknown> = { ...WALLS };
  delete now["w_shared"];
  assert.deepEqual(affected(now), ["A", "B"]);
});

test("265 R1: удаление наружной стены затрагивает только её комнату", () => {
  const now: Record<string, unknown> = { ...WALLS };
  delete now["w_left"];
  assert.deepEqual(affected(now), ["A"]);
});

test("265 R1: перенос наружной стены наружу затрагивает её комнату", () => {
  const now: Record<string, unknown> = { ...WALLS, w_left: { p1: P(-50, 300), p2: P(-50, 0), depth: 10, plan: "a" } };
  assert.deepEqual(affected(now), ["A"]);
});

test("265 R1: длинная стена через малую комнату между точками выборки затрагивает её", () => {
  const rooms = { S: { polygon: [P(305, 5), P(395, 5), P(395, 95), P(305, 95)] } };
  const now: Record<string, unknown> = { ...WALLS, w_long: { p1: P(0, 50), p2: P(1000, 50), depth: 10, plan: "a" } };
  assert.deepEqual(affected(now, rooms), ["S"]);
});

test("265 R1: Т-разрез от оси общей стены — сосед не затронут (строгий)", () => {
  const now: Record<string, unknown> = { ...WALLS, w_split: { p1: P(200, 150), p2: P(0, 150), depth: 10, plan: "a" } };
  assert.deepEqual(affected(now), ["A"]);
});

test("265 R1: параллельная стена дальше depth/2+1 от грани не затрагивает комнату", () => {
  // новая стена x=-20 (ось на 25 см от грани A x=5), вне комнат
  const now: Record<string, unknown> = { ...WALLS, w_far: { p1: P(-20, 0), p2: P(-20, 300), depth: 10, plan: "a" } };
  assert.deepEqual(affected(now), []);
});

test("265 R1: normalize — общая стена удалена, делитель сохранён/продлён → OK, каскад → warning", () => {
  const now: Record<string, unknown> = { ...WALLS };
  delete now["w_shared"];
  const aff = zoneAffectedRoomIds({ rooms2: ROOMS }, roomsChangePolicy(ROOMS, WALLS, now as never));
  const exp = { rooms2: ROOMS, zone_delimiters: { za: delimRec("za", "A", P(5, 80), P(195, 80)) } };
  const merged = { AB: { polygon: [P(5, 5), P(395, 5), P(395, 295), P(5, 295)] } };
  const kept = zoneDelimiterCompare(exp, { rooms2: merged, zone_delimiters: { za: delimRec("za", "AB", P(5, 80), P(195, 80)) } }, "normalize", { affectedRooms: aff });
  assert.deepEqual(kept.problems, [], JSON.stringify(kept));
  const extended = zoneDelimiterCompare(exp, { rooms2: merged, zone_delimiters: { za: delimRec("za", "AB", P(5, 80), P(395, 80)) } }, "normalize", { affectedRooms: aff });
  assert.deepEqual(extended.problems, [], JSON.stringify(extended));
  const cascade = zoneDelimiterCompare(exp, { rooms2: merged, zone_delimiters: {} }, "normalize", { affectedRooms: aff });
  assert.deepEqual(cascade.problems, [], JSON.stringify(cascade));
  assert.ok(cascade.warnings.some((w) => w.includes("zone_ceiling_remove")), JSON.stringify(cascade.warnings));
});

test("265 R1: normalize — Т-разрез, редактор потерял делитель соседа → problem", () => {
  const now: Record<string, unknown> = { ...WALLS, w_split: { p1: P(200, 150), p2: P(0, 150), depth: 10, plan: "a" } };
  const aff = zoneAffectedRoomIds({ rooms2: ROOMS }, roomsChangePolicy(ROOMS, WALLS, now as never));
  const za = delimRec("za", "A", P(5, 80), P(195, 80));
  const exp = { rooms2: ROOMS, zone_delimiters: { za, zb: delimRec("zb", "B", P(300, 5), P(300, 295)) } };
  const got = {
    rooms2: { A1: { polygon: [P(5, 5), P(195, 5), P(195, 145), P(5, 145)] }, A2: { polygon: [P(5, 155), P(195, 155), P(195, 295), P(5, 295)] }, B: { polygon: B_POLY } },
    zone_delimiters: { za: { ...za, id_room: "A1" } },
  };
  const res = zoneDelimiterCompare(exp, got, "normalize", { affectedRooms: aff });
  assert.ok(res.problems.some((p) => p.includes("zb")), JSON.stringify(res));
});

// ---------- R1 через Workspace: реальная фикстура и A/B толщиной 10 ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

function wsMock(server: { saveId: string; model: Record<string, unknown> }, transformNorm: (m: Record<string, unknown>) => void): Workspace {
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      const n = structuredClone(mm as object) as Record<string, unknown>;
      transformNorm(n);
      const c = { walls: Object.keys(n["walls"] as object).length, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: n, rooms: [], before: c, after: c };
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
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

type FxRoom = { polygon: Pt[]; edges: Array<{ p1: Pt; p2: Pt; pid: string }> };

/** Фикстура editor-corridor-3rooms (оси x=0/300/500/600, толщина 20, контуры
 *  комнат по граням): малая комната, делитель между серединами рёбер 0 и 2,
 *  стена её первого ребра (наружная w2 — как в пробе 261-ws). */
function fixtureCase(): { m: Model; rid: string; wid: string } {
  const m = (JSON.parse(readFileSync("tests/fixtures/editor-corridor-3rooms.json", "utf8")) as { model: Model }).model;
  const rooms = m.rooms2 as unknown as Record<string, FxRoom>;
  const area = (p: Pt[]): number => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]!; return s + a.x * b.y - b.x * a.y; }, 0) / 2);
  const rid = Object.keys(rooms).sort((a, b) => area(rooms[a]!.polygon) - area(rooms[b]!.polygon))[0]!;
  const room = rooms[rid]!;
  const mid = (e: { p1: Pt; p2: Pt }): Pt => ({ x: Math.round(((e.p1.x + e.p2.x) / 2) * 10), y: Math.round(((e.p1.y + e.p2.y) / 2) * 10) });
  addZoneCeiling(m, rid, { fromMm: mid(room.edges[0]!), toMm: mid(room.edges[2]!) });
  const wid = room.edges[0]!.pid;
  assert.ok(m.walls[wid], "стена ребра есть в модели");
  return { m, rid, wid };
}

for (const keep of [true, false]) {
  test(`265 R1: фикстура, wall_delete стены контура (ось на 10 см от грани), комната исчезла, делитель ${keep ? "сохранён → OK" : "удалён каскадом → warning"}`, async () => {
    const { m, rid, wid } = fixtureCase();
    const ws = wsMock({ saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> }, (n) => {
      delete (n["rooms2"] as Record<string, unknown>)[rid];
      if (!keep) n["zone_delimiters"] = {};
    });
    await ws.open("0", "1");
    const res = await ws.applyWalls("wall_delete", (mm) => {
      delete mm.walls[wid];
      return "deleted";
    });
    assert.equal(res.result, "deleted");
    const zw = res.warnings.filter((w) => w.includes("zone_topology_changed"));
    if (keep) assert.deepEqual(zw, [], JSON.stringify(res.warnings));
    else assert.ok(zw.some((w) => w.includes("zone_ceiling_remove")), JSON.stringify(res.warnings));
  });
}

function abServer(): { saveId: string; model: Record<string, unknown> } {
  return {
    saveId: "s1",
    model: {
      rooms2: structuredClone(ROOMS),
      walls: structuredClone(WALLS),
      zone_delimiters: { za: delimRec("za", "A", P(5, 80), P(195, 80)) },
    },
  };
}

for (const [wall, keep] of [["w_shared", true], ["w_shared", false], ["w_left", true], ["w_left", false]] as const) {
  test(`265 R1: A/B толщиной 10, wall_delete ${wall}, делитель ${keep ? "сохранён → OK" : "удалён каскадом → warning"}`, async () => {
    const ws = wsMock(abServer(), (n) => {
      const rooms = n["rooms2"] as Record<string, unknown>;
      if (wall === "w_shared") {
        delete rooms["A"];
        delete rooms["B"];
        rooms["AB"] = { polygon: [P(5, 5), P(395, 5), P(395, 295), P(5, 295)] };
        const zd = (n["zone_delimiters"] as Record<string, Record<string, unknown>>)["za"];
        if (zd) zd["id_room"] = "AB";
      } else {
        delete rooms["A"]; // контур разомкнут
      }
      if (!keep) n["zone_delimiters"] = {};
    });
    await ws.open("0", "1");
    const res = await ws.applyWalls("wall_delete", (mm) => {
      delete mm.walls[wall];
      return "deleted";
    });
    const zw = res.warnings.filter((w) => w.includes("zone_topology_changed"));
    if (keep) assert.deepEqual(zw, [], JSON.stringify(res.warnings));
    else assert.ok(zw.some((w) => w.includes("zone_ceiling_remove")), JSON.stringify(res.warnings));
  });
}

// ---------- R2: save — «сдвиг до магнита» только при неизменной остальной проекции ----------

const R2_ROOMS = { A1: { polygon: [P(5, 5), P(195, 5), P(195, 145), P(5, 145)] }, C: { polygon: [P(205, 5), P(395, 5), P(395, 145), P(205, 145)] } };
const R2_NORM = { rooms2: R2_ROOMS, zone_delimiters: { za: delimRec("za", "A1", P(5, 80), P(195, 80)) } };
const R2_AFF = { affectedRooms: new Set(["A1"]) };

function r2(mutate: (d: Record<string, unknown> & { vertexes: Array<{ id: string; point: Pt; type: string }> }) => void): Record<string, unknown> {
  const g = structuredClone(R2_NORM) as unknown as { zone_delimiters: { za: never } };
  mutate(g.zone_delimiters.za);
  return g as unknown as Record<string, unknown>;
}

const R2_MUTATIONS: Record<string, Parameters<typeof r2>[0]> = {
  matrix_null: (d) => { d["matrix"] = null; },
  items_empty: (d) => { d["items"] = {}; },
  on_size_0: (d) => { d["on_size"] = 0; },
  length_0: (d) => { d["length"] = 0; },
  extra_vertex: (d) => { d.vertexes.splice(1, 0, { id: "m", point: P(100, 80), type: "node" }); },
  vertex_type: (d) => { d.vertexes[0]!.type = "x"; },
};

for (const [name, mutate] of Object.entries(R2_MUTATIONS)) {
  test(`265 R2: save, затронутая комната, концы на месте, ${name} → problem`, () => {
    const res = zoneDelimiterCompare(R2_NORM, r2(mutate), "save", R2_AFF);
    assert.ok(res.problems.length > 0, JSON.stringify(res));
    assert.equal(res.warnings.some((w) => w.includes("переопределил")), false, JSON.stringify(res.warnings));
  });
  test(`265 R2: save, затронутая комната, сдвиг конца 10 см + ${name} → problem`, () => {
    const res = zoneDelimiterCompare(R2_NORM, r2((d) => {
      mutate(d);
      const last = d.vertexes[d.vertexes.length - 1]!;
      last.point = P(195, 90);
    }), "save", R2_AFF);
    assert.ok(res.problems.length > 0, JSON.stringify(res));
  });
}

test("265 R2: save, затронутая комната, сдвиг конца 10 см с согласованной длиной → warning", () => {
  const res = zoneDelimiterCompare(R2_NORM, r2((d) => {
    d.vertexes[1]!.point = P(195, 90);
    d["length"] = Math.round((Math.hypot(190, 10) / 100) * 100) / 100;
  }), "save", R2_AFF);
  assert.deepEqual(res.problems, [], JSON.stringify(res));
  assert.ok(res.warnings.some((w) => w.includes("переопределил")), JSON.stringify(res.warnings));
});

test("265 R2: save, затронутая комната, сдвиг конца, length прежний (редактор не пересчитал, эталон 262) → warning", () => {
  const res = zoneDelimiterCompare(R2_NORM, r2((d) => {
    d.vertexes[1]!.point = P(195, 90);
  }), "save", R2_AFF);
  assert.deepEqual(res.problems, [], JSON.stringify(res));
  assert.ok(res.warnings.some((w) => w.includes("переопределил")), JSON.stringify(res.warnings));
});

test("265 R2: save, затронутая комната, сдвиг конца, length ни прежний, ни по геометрии (>1 см) → problem", () => {
  const res = zoneDelimiterCompare(R2_NORM, r2((d) => {
    d.vertexes[1]!.point = P(195, 90);
    d["length"] = 1.5; // 150 см при геометрии ~190 см
  }), "save", R2_AFF);
  assert.ok(res.problems.length > 0, JSON.stringify(res));
});

test("265 R2: save, затронутая комната, концы на месте и проекция цела → OK без warning", () => {
  const res = zoneDelimiterCompare(R2_NORM, structuredClone(R2_NORM), "save", R2_AFF);
  assert.deepEqual(res, { problems: [], warnings: [] });
});
