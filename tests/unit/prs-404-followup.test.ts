// Этап 406, follow-up ревью 404:
//  - №12: проводка walls в runSave — сверка save (host → normalize и
//    normalize → сервер) получает стены моделей; ротация обхода [1,2,0]
//    сегментов разрезанной стены через ПОЛНЫЙ путь Workspace.save не даёт
//    ложной problem. Мутация «убрать wallsOf(...) из вызовов
//    prsSettingsMismatches в orchestration.ts» этот тест краснит;
//  - №13: без walls (модель без стен, rooms1, частичные данные) edgeSemKeyOf
//    откатывается к порядку обхода — честное ограничение: репро 402-rot без
//    стен даёт problem; со стенами — нет (зафиксировано тестом).
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { prsSettingsMismatches } from "../../src/verify/projections.ts";
import { Workspace, type WorkspaceDeps } from "../../src/workspace.ts";
import type { Model } from "../../src/model/types.ts";

type AnyRec = Record<string, unknown>;

const FULL = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }];

/** Стена w5 разрезана на два ребра одной стороны (0..200, 200..400), ребро 2 — w6. */
function splitWallModel(disabledOids: string[]): Model {
  return {
    v: 1, id: "o1", plan_id: "1", total_height: 270, final: false,
    walls: {
      w5: { id: "w5", plan: "a", role: "wall", depth: 20, height: 280, material: "a_block", p1: { x: 0, y: 0 }, p2: { x: 400, y: 0 }, holes: {} },
      w6: { id: "w6", plan: "a", role: "wall", depth: 20, height: 280, material: "a_block", p1: { x: 400, y: 0 }, p2: { x: 0, y: 300 }, holes: {} },
    },
    items: {}, pillars: {}, rulers: {}, comments: {},
    rooms2: {
      roomA: {
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
        id_of_edges: ["a", "b", "c"],
        prs_disabled: Object.fromEntries(disabledOids.map((o) => [o, ""])), prs_first: 0, prs_hidden: 0,
      },
    },
  } as unknown as Model;
}

/** Редактор пересоздал комнату с обходом [1,2,0]: oid n1..n3, скрыт тот же сегмент 0..200 (n3). */
function rotateRoom(m: AnyRec, prefix = "n"): void {
  const room = ((m["rooms2"] as AnyRec)["roomA"]) as AnyRec;
  const order = [1, 2, 0];
  const oldDisabled = Object.keys(room["prs_disabled"] as AnyRec);
  const oldOids = (room["edges_prs"] as AnyRec[]).map((e) => e["oid"]);
  const pick = (key: string): AnyRec[] => order.map((i) => structuredClone((room[key] as AnyRec[])[i]!));
  room["edges"] = pick("edges");
  room["edges_prs"] = pick("edges_prs").map((e, i) => ({ ...e, edge_index: i, oid: `${prefix}${i + 1}` }));
  room["id_of_edges"] = (room["edges_prs"] as AnyRec[]).map((e) => e["oid"]);
  // настройки переносятся на те же линии под новыми oid
  room["prs_disabled"] = Object.fromEntries(
    oldDisabled.map((k) => [`${prefix}${order.indexOf(oldOids.indexOf(k)) + 1}`, ""]),
  );
}

function wsRotating(server: { saveId: string; model: AnyRec }, rotateOnServer = false): Workspace {
  let normalized: AnyRec | null = null;
  const editor = {
    objectId: "123", planId: "1",
    async normalize(model: unknown) {
      normalized = structuredClone(model) as AnyRec;
      rotateRoom(normalized);
      return { model: structuredClone(normalized), rooms: [], before: { walls: 2, holes: 0, items: 0 }, after: { walls: 2, holes: 0, items: 0 } };
    },
    async save() {
      server.saveId = `s${Math.random()}`;
      server.model = structuredClone(normalized!);
      // сервер/редактор при save снова пересоздал комнату — обход ещё раз сдвинут
      if (rotateOnServer) rotateRoom(server.model, "m");
      return { ok: true, saveId: server.saveId, conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { throw new Error("not used"); },
    async close() {},
  };
  const deps = {
    session: { cookies: [] },
    async loadModel() {
      return { object_id: "123", plan_id: "1", save_id: server.saveId, units: "cm", model: structuredClone(server.model) };
    },
    async openEditor() { return editor; },
  } as unknown as WorkspaceDeps;
  return new Workspace(deps);
}

test("404 №12: runSave передаёт walls в сверку prs — ротация [1,2,0] сегментов разрезанной стены: save verified, без ложной problem", async () => {
  const server = { saveId: "s1", model: splitWallModel(["a"]) as unknown as AnyRec };
  const ws = wsRotating(server);
  await ws.open("123", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, `save verified при ротации обхода: ${JSON.stringify(res.warnings)}`);
  const room = ((server.model["rooms2"] as AnyRec)["roomA"]) as AnyRec;
  assert.deepEqual(room["prs_disabled"], { n3: "" }, "на сервере скрыт тот же сегмент под новым oid");
});

test("404 №12: сверка ПОСЛЕ save тоже получает walls — сервер сдвинул обход ещё раз: save verified", async () => {
  const server = { saveId: "s1", model: splitWallModel(["a"]) as unknown as AnyRec };
  const ws = wsRotating(server, true);
  await ws.open("123", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, `save verified при повторной ротации на сервере: ${JSON.stringify(res.warnings)}`);
  const room = ((server.model["rooms2"] as AnyRec)["roomA"]) as AnyRec;
  assert.deepEqual(room["prs_disabled"], { m2: "" }, "сегмент 0..200 — ребро 1 после второй ротации");
});

test("404 №13: без walls — откат к порядку обхода (документированное ограничение): ротация даёт problem; со стенами — нет", () => {
  const before = splitWallModel(["a"]);
  const after = structuredClone(before) as unknown as AnyRec;
  rotateRoom(after);
  const rb = before.rooms2 as unknown as Record<string, AnyRec>;
  const ra = after["rooms2"] as Record<string, AnyRec>;
  const noWalls = prsSettingsMismatches(rb, ra);
  assert.equal(noWalls.problems.length, 1, `без стен — порядок обхода, ложная problem (граница): ${JSON.stringify(noWalls)}`);
  assert.match(noWalls.problems[0]!, /набор скрытых развёрток изменился/);
  const withWalls = prsSettingsMismatches(rb, ra, before.walls as unknown as AnyRec, after["walls"] as AnyRec);
  assert.deepEqual(withWalls.problems, [], `со стенами — без ложной problem: ${JSON.stringify(withWalls)}`);
});
