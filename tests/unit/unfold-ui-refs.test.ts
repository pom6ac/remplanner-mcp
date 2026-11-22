// Этап 389 — развёртки: настройки prs_* (нумерация, скрытие), молдинги и ниши
// развёрток (wall_moldings/wall_niches), точка укладки плитки на стене
// (anchor_decor). Эталоны — синтетические по сериализации бандла
// (ui-ref-unfold-*), формат и умолчания — WallMolding/WallNiche 268-app.js.
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseModelImport } from "../../src/model/import-schema.ts";
import { prsFigureUserMismatches, prsSettingsMismatches } from "../../src/verify/projections.ts";
import {
  prsEdgesOf, prsStateOf, setPrsSettings, prsDisabledEdges, prsFirstEdge,
  addPrsFigure, updatePrsFigure, deletePrsFigure, resolvePrsFigure, prsFigureLabel,
  PRS_MOLDING_WIDTH_LINE_CM, PRS_NICHE_DEPTH_CM,
} from "../../src/model/projections.ts";
import { PRO_TOOL_GROUPS, proGatedTools, PRO_PARTIAL_TOOLS, PRO_EDITOR_KEYS } from "../../src/server/pro.ts";
import type { Model } from "../../src/model/types.ts";

type AnyRec = Record<string, unknown>;

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures");

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

const MOLDING = JSON.parse(readFileSync(join(FIXTURE_DIR, "ui-ref-unfold-wall-molding.json"), "utf8")) as AnyRec;
const NICHE = JSON.parse(readFileSync(join(FIXTURE_DIR, "ui-ref-unfold-wall-niche.json"), "utf8")) as AnyRec;

// ---------- эталоны в обе стороны ----------

test("389: эталон молдинга развёртки проходит импорт и читается модельным слоем", () => {
  const dict = MOLDING["wall_moldings"] as AnyRec;
  const m = parseModelImport({ ...baseModel(), wall_moldings: dict }) as Model;
  const rec = resolvePrsFigure(m, "wall_molding", "id1");
  assert.equal(rec.type, "wall_molding");
  assert.equal(rec.width_line, 4);
  assert.equal(rec.on_size, 1);
  assert.equal((rec.prs as AnyRec)["room"], "id2");
  assert.equal((rec.prs as AnyRec)["edge_index"], 0);
  assert.deepEqual(rec.pc, { x: 120.5, y: 300 });
});

test("389: эталон ниши развёртки проходит импорт и читается модельным слоем", () => {
  const dict = NICHE["wall_niches"] as AnyRec;
  const m = parseModelImport({ ...baseModel(), wall_niches: dict }) as Model;
  const rec = resolvePrsFigure(m, "wall_niche", "id3");
  assert.equal(rec.type, "wall_niche");
  assert.equal(rec.depth, 20);
  assert.equal((rec.prs as AnyRec)["pc_yd"], 140);
});

test("389: эталон молдинга — маскированная форма совпадает с полем модели (обе стороны)", () => {
  const dict = MOLDING["wall_moldings"] as AnyRec;
  const m = parseModelImport({ ...baseModel(), wall_moldings: dict }) as Model;
  assert.deepEqual(m.wall_moldings?.["id1"], dict["id1"]);
});

test("389: негативный импорт — мусор в записи развёртки отклоняется", () => {
  assert.throws(() => parseModelImport({ ...baseModel(), wall_moldings: { m1: { id: "m1", type: "hack", pc: { x: 0, y: 0 } } } }));
  assert.throws(() => parseModelImport({ ...baseModel(), wall_niches: { n1: { id: "n1", type: "wall_niche", text: "<img src=x>" } } }));
});

// ---------- add: формат, умолчания, slim ----------

test("389: wall_molding_add — pc в рамке развёрток, prs.pc_xd/pc_yd, умолчания", () => {
  const m = baseModel();
  const rec = addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 1000, bottomMm: 1200, widthMm: 600, heightMm: 30 });
  // развёртка w1 — первая линия: x0=20 (needGap-зазор перед первой развёрткой); y = 30 + 270 − 120
  assert.deepEqual(rec.pc, { x: 120, y: 180 });
  assert.deepEqual(rec.prs, { room: "roomA", edge_index: 0, pc_xd: 100, pc_yd: 150 });
  assert.equal(rec.width, 60);
  assert.equal(rec.height, 3);
  assert.equal(rec.width_line, PRS_MOLDING_WIDTH_LINE_CM);
  assert.equal(rec.plan, "projections");
  assert.equal(rec.on_size, 1);
  // рамка второй развёртки: x0 = 20 + 400
  const rec2 = addPrsFigure(m, "wall_molding", { room: "R1", wall: "w2", alongMm: 500, bottomMm: 1000, widthMm: 400, heightMm: 200 });
  assert.deepEqual(rec2.pc, { x: 470, y: 200 });
  assert.equal((rec2.prs as AnyRec)["pc_xd"], 50);
});

test("389: slim-типы молдинга — как в draw бандла", () => {
  const m = baseModel();
  const slim = addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 500, bottomMm: 500, widthMm: 400, heightMm: 80 });
  assert.equal(slim.type, "wall_molding_slim");
  const slimH = addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 500, bottomMm: 500, widthMm: 80, heightMm: 300 });
  assert.equal(slimH.type, "wall_molding_slim_h");
  const normal = addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 500, bottomMm: 500, widthMm: 200, heightMm: 200 });
  assert.equal(normal.type, "wall_molding");
});

test("389: ниша — depth default 20, минимум 10×10 см, пересечение и стеклянная стена", () => {
  const m = baseModel();
  const rec = addPrsFigure(m, "wall_niche", { room: "R1", wall: "w3", alongMm: 2000, bottomMm: 1000, widthMm: 800, heightMm: 1200 });
  assert.equal(rec.depth, PRS_NICHE_DEPTH_CM);
  assert.equal(rec.width, 80);
  // пересечение с существующей
  assert.throws(() =>
    addPrsFigure(m, "wall_niche", { room: "R1", wall: "w3", alongMm: 2100, bottomMm: 1000, widthMm: 800, heightMm: 1200 }),
  );
  // стеклянная стена w4
  assert.throws(() =>
    addPrsFigure(m, "wall_niche", { room: "R1", wall: "w4", alongMm: 500, bottomMm: 500, widthMm: 400, heightMm: 400 }),
  );
  // меньше 10 см
  assert.throws(() =>
    addPrsFigure(m, "wall_niche", { room: "R1", wall: "w3", alongMm: 2000, bottomMm: 1000, widthMm: 50, heightMm: 1200 }),
  );
});

test("389: фигура целиком в развёртке — выход за границы отклоняется", () => {
  const m = baseModel();
  // развёртка w1 длиной 400 см, молдинг 600 мм → центр максимум 3000−300 мм
  assert.throws(() =>
    addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 3800, bottomMm: 1200, widthMm: 600, heightMm: 30 }),
  );
  assert.throws(() =>
    addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 1000, bottomMm: 2650, widthMm: 600, heightMm: 200 }),
  );
});

// ---------- update/delete: атомарность, метки ----------

test("389: update пересчитывает позицию и тип; при отказе запись возвращается (атомарность)", () => {
  const m = baseModel();
  addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 500, bottomMm: 500, widthMm: 400, heightMm: 80 });
  const rec = updatePrsFigure(m, "wall_molding", "WM1", { heightMm: 300, alongMm: 1000 });
  assert.equal(rec.type, "wall_molding");
  assert.equal((rec.prs as AnyRec)["pc_xd"], 100);
  assert.equal(m.wall_moldings && Object.keys(m.wall_moldings).length, 1);
  // невалидный update — отказ, запись на месте
  assert.throws(() => updatePrsFigure(m, "wall_molding", "WM1", { widthMm: 999999 }));
  assert.equal(Object.keys(m.wall_moldings ?? {}).length, 1);
  assert.equal((resolvePrsFigure(m, "wall_molding", "WM1").prs as AnyRec)["pc_xd"], 100);
});

test("389: delete по метке WM<n>/WN<n> и по id сайта; метки — по полному списку", () => {
  const m = baseModel();
  addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 500, bottomMm: 500, widthMm: 400, heightMm: 80 });
  addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 2000, bottomMm: 500, widthMm: 400, heightMm: 80 });
  addPrsFigure(m, "wall_niche", { room: "R1", wall: "w3", alongMm: 2000, bottomMm: 1000, widthMm: 800, heightMm: 1200 });
  assert.equal(prsFigureLabel(m, "wall_niche", (m.wall_niches ? Object.keys(m.wall_niches)[0]! : "")), "WN1");
  assert.equal(deletePrsFigure(m, "wall_molding", "WM1").length > 0, true);
  assert.equal(Object.keys(m.wall_moldings ?? {}).length, 1);
  // после удаления метка WM1 указывает на следующую запись
  const secondId = Object.keys(m.wall_moldings ?? {})[0]!;
  assert.equal(prsFigureLabel(m, "wall_molding", secondId), "WM1");
  assert.throws(() => resolvePrsFigure(m, "wall_molding", "WM9"));
  assert.throws(() => deletePrsFigure(m, "wall_niche", "WN5"));
});

// ---------- prs_set: нумерация и скрытие ----------

test("389: prs_set — скрыть/показать все, одну; назначить первой; авто", () => {
  const m = baseModel();
  let st = setPrsSettings(m, "R1", { hidden: true });
  assert.equal(st.hidden, true);
  assert.deepEqual(st.disabledEdges, [0, 1, 2, 3]);
  const room = (m.rooms2 as AnyRec)["roomA"] as AnyRec;
  assert.equal(room["prs_hidden"], 1);
  assert.deepEqual(Object.keys(room["prs_disabled"] as AnyRec).sort(), ["oid1", "oid2", "oid3", "oid4"]);
  st = setPrsSettings(m, "R1", { hidden: false });
  assert.equal(st.hidden, false);
  assert.deepEqual(Object.keys(room["prs_disabled"] as AnyRec), []);
  // скрыть одну развёртку (w2) — prs_hidden сбрасывается в 0 (обработчик visibility)
  st = setPrsSettings(m, "R1", { hideWalls: ["w2"] });
  assert.equal(room["prs_hidden"], 0);
  assert.deepEqual(st.disabledEdges, [1]);
  assert.deepEqual(prsDisabledEdges(room as never), new Set([1]));
  // скрытая развёртка не назначается первой
  assert.throws(() => setPrsSettings(m, "R1", { firstWall: "w2" }));
  st = setPrsSettings(m, "R1", { firstWall: "w3", showWalls: ["w2"] });
  assert.equal(prsFirstEdge(room as never), 2);
  assert.equal(room["prs_first"], "oid3");
  // авто — prs_first=0
  setPrsSettings(m, "R1", { firstWall: null });
  assert.equal(room["prs_first"], 0);
  assert.equal(prsFirstEdge(room as never), null);
  // не граничащая стена — отказ
  assert.throws(() => setPrsSettings(m, "R1", { hideWalls: ["wX"] }));
});

test("389: prsStateOf читает состояние (модель редактора после save)", () => {
  const m = baseModel();
  setPrsSettings(m, "R1", { firstWall: "w2" });
  setPrsSettings(m, "R1", { hidden: true });
  const st = prsStateOf(((m.rooms2 as AnyRec)["roomA"] as AnyRec) as never);
  assert.equal(st.hidden, true);
  assert.equal(st.firstEdge, 1);
  assert.deepEqual(st.disabledEdges, [0, 1, 2, 3]);
});

// ---------- сверка save ----------

test("389: сверка молдингов/ниш — потеря, лишняя, смена размера; pc не сверяется", () => {
  const m = baseModel();
  const rec = addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 500, bottomMm: 500, widthMm: 400, heightMm: 80 });
  const rooms = (m.rooms2 as AnyRec) as Record<string, AnyRec>;
  const normModel = structuredClone(m) as Model;
  // редактор пересчитал pc (рамка сдвинулась) — не расхождение
  ((normModel.wall_moldings as AnyRec)[rec.id] as AnyRec)["pc"] = { x: 999, y: 999 };
  assert.deepEqual(prsFigureUserMismatches({ rooms: rooms as never, coll: m.wall_moldings }, { rooms: (normModel.rooms2 as AnyRec) as never, coll: normModel.wall_moldings }, "молдинг"), []);
  // размер изменился — расхождение
  const broken = structuredClone(m) as Model;
  ((broken.wall_moldings as AnyRec)[rec.id] as AnyRec)["width"] = 999;
  const sizeOut = prsFigureUserMismatches({ rooms: rooms as never, coll: m.wall_moldings }, { rooms: (broken.rooms2 as AnyRec) as never, coll: broken.wall_moldings }, "молдинг");
  assert.equal(sizeOut.length, 2, "смена размера — потеря ожидаемой и лишняя на сервере");
  assert.match(sizeOut[0]!, /потеряна/);
  // запись потеряна
  const lost = structuredClone(m) as Model;
  lost.wall_moldings = {};
  const lostOut = prsFigureUserMismatches({ rooms: rooms as never, coll: m.wall_moldings }, { rooms: (lost.rooms2 as AnyRec) as never, coll: lost.wall_moldings }, "молдинг");
  assert.equal(lostOut.length, 1);
  assert.match(lostOut[0]!, /потеряна/);
  // лишняя запись
  const extra = structuredClone(m) as Model;
  ((extra.wall_moldings as AnyRec)["x9"] as AnyRec) = { ...(extra.wall_moldings as AnyRec)[rec.id] as AnyRec, id: "x9" };
  assert.match(prsFigureUserMismatches({ rooms: rooms as never, coll: m.wall_moldings }, { rooms: (extra.rooms2 as AnyRec) as never, coll: extra.wall_moldings }, "молдинг")[0]!, /лишняя/);
});

test("389: сверка prs-настроек — по edge_index, skip при изменённой нарезке", () => {
  const m = baseModel();
  setPrsSettings(m, "R1", { hideWalls: ["w2"], firstWall: "w3" });
  const before = (m.rooms2 as AnyRec) as Record<string, AnyRec>;
  // на сервере oid перегенерирован, но edge-семантика та же
  const after = structuredClone(before) as Record<string, AnyRec>;
  const room = after["roomA"] as AnyRec;
  (room["edges_prs"] as AnyRec[]).forEach((e, i) => { (e as AnyRec)["oid"] = `new${i}`; });
  (room["prs_disabled"] as AnyRec)["new1"] = "";
  room["prs_first"] = "new2";
  assert.deepEqual(prsSettingsMismatches(before, after), []);
  // «первая» уехала на другое ребро — расхождение
  const broken = structuredClone(after) as Record<string, AnyRec>;
  ((broken["roomA"] as AnyRec)["prs_first"] as string) = "new0";
  assert.equal(prsSettingsMismatches(before, broken).length, 1);
  // нарезка изменилась (wall-операция) — skip (редактор переносит по геометрии)
  const recut = structuredClone(after) as Record<string, AnyRec>;
  ((recut["roomA"] as AnyRec)["edges_prs"] as unknown[]).push({ edge_index: 4, p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, oid: "new4" });
  assert.deepEqual(prsSettingsMismatches(before, recut), []);
  // стена делит комнату — без ложной ошибки (число развёрток меняется)
  assert.deepEqual(prsSettingsMismatches(before, recut), []);
});

// ---------- PRO ----------

test("389: молдинги/ниши развёрток и prs_set — НЕ PRO (разметка анонимного проекта)", () => {
  const gated = proGatedTools();
  for (const t of ["prs_set", "wall_molding_add", "wall_molding_update", "wall_niche_add", "wall_niche_update"]) {
    assert.ok(!gated.includes(t), `${t} не в реестре PRO_TOOL_GROUPS`);
  }
  for (const g of PRO_TOOL_GROUPS) {
    for (const k of g.editorKeys) {
      assert.ok(!["wall_molding", "wall_niche", "wall_profile", "anchor_decor"].includes(k), `${k} не PRO в разметке`);
    }
  }
  assert.ok(PRO_EDITOR_KEYS.includes("anchor_floor"), "точка укладки ПОЛА — PRO (эталон разметки)");
  assert.equal(PRO_PARTIAL_TOOLS["wall_molding_add"], undefined, "нет частичного гейта у развёрток");
});

// ---------- полный путь через Workspace (эталоны в обе стороны + сверка save) ----------

import { Workspace } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";

function wsFixture(): Model {
  const m = baseModel();
  // отделка стороны стены (для точки укладки в будущих этапах; развёрткам нужен prs)
  return m;
}

function wsDeps(server: { saveId: string; model: Model; dropMoldings?: boolean }) {
  let lastNormalized: Record<string, unknown> | null = null;
  const editor = {
    objectId: "123", planId: "1",
    async normalize(model: unknown) {
      const out = structuredClone(model) as Record<string, unknown>;
      if (server.dropMoldings) {
        delete out["wall_moldings"];
        delete out["wall_niches"];
      }
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
  const deps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "123", plan_id: "1", save_id: server.saveId, units: "cm", model: structuredClone(server.model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
  return deps as unknown as Parameters<typeof Workspace.prototype.open>[0] extends never ? never : import("../../src/workspace.ts").WorkspaceDeps;
}

test("389: полный путь через Workspace — prs_set + молдинг + ниша → save verified, сверка по GET", async () => {
  const server = { saveId: "s1", model: wsFixture() };
  const ws = new Workspace(wsDeps(server) as never);
  await ws.open("123", "1");
  ws.apply("prs_set", (m) => setPrsSettings(m, "R1", { hideWalls: ["w2"], firstWall: "w3" }));
  ws.apply("wall_molding_add", (m) => addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 1000, bottomMm: 1000, widthMm: 600, heightMm: 200 }));
  ws.apply("wall_niche_add", (m) => addPrsFigure(m, "wall_niche", { room: "R1", wall: "w3", alongMm: 2000, bottomMm: 1200, widthMm: 800, heightMm: 1200 }));
  const res = await ws.save();
  assert.equal(res.verified, true, `warnings: ${JSON.stringify(res.warnings)}`);
  assert.equal(Object.keys((server.model.wall_moldings ?? {}) as AnyRec).length, 1);
  assert.equal(Object.keys((server.model.wall_niches ?? {}) as AnyRec).length, 1);
  const room = ((server.model.rooms2 as AnyRec)["roomA"] ?? {}) as AnyRec;
  assert.equal((room["prs_disabled"] as AnyRec)["oid2"], "");
  assert.equal(room["prs_first"], "oid3");
});

test("389: Workspace — normalize уронил молдинг → NORMALIZATION_DROPPED (мутация краснеет)", async () => {
  const server = { saveId: "s1", model: wsFixture(), dropMoldings: true };
  const ws = new Workspace(wsDeps(server) as never);
  await ws.open("123", "1");
  ws.apply("wall_molding_add", (m) => addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 1000, bottomMm: 1000, widthMm: 600, heightMm: 200 }));
  await assert.rejects(() => ws.save(), (e: { code?: string }) => e.code === "NORMALIZATION_DROPPED");
});

test("389: Workspace — normalize уронил нишу → NORMALIZATION_DROPPED", async () => {
  const server = { saveId: "s1", model: wsFixture(), dropMoldings: true };
  const ws = new Workspace(wsDeps(server) as never);
  await ws.open("123", "1");
  ws.apply("wall_niche_add", (m) => addPrsFigure(m, "wall_niche", { room: "R1", wall: "w3", alongMm: 2000, bottomMm: 1200, widthMm: 800, heightMm: 1200 }));
  await assert.rejects(() => ws.save(), (e: { code?: string }) => e.code === "NORMALIZATION_DROPPED");
});

// ---------- точка укладки плитки на стене (anchor_decor) ----------

import { setWallDecorAnchor } from "../../src/model/projections.ts";
import { wallDecorAnchorMismatches } from "../../src/verify/projections.ts";

function withDecor(m: Model, type = "wall_tile"): Model {
  const room = (m.rooms2 as AnyRec)["roomA"] as AnyRec;
  room["decors"] = [
    { exist: true, parts: { p1: { id: "p1", type, layer: 1, line: { p1: { x: 0, y: 0 }, p2: { x: 400, y: 0 } }, line_wall: { p1: { x: 0, y: 0 }, p2: { x: 400, y: 0 } }, distance: 400, height: 250, height_from_floor: 0 } } },
    { exist: false },
    { exist: false },
    { exist: false },
  ];
  return m;
}

test("389: точка укладки отделки стены — anchor/angle/custom_angle как в обработчике anchor_decor", () => {
  const m = withDecor(baseModel());
  const res = setWallDecorAnchor(m, { room: "R1", wall: "w1", alongMm: 1000, heightMm: 500 });
  assert.equal(res.edge, 0);
  const part = ((((m.rooms2 as AnyRec)["roomA"] as AnyRec)["decors"] as AnyRec[])[0]!["parts"] as AnyRec)["p1"] as AnyRec;
  assert.deepEqual(part["anchor"], { p: { x: 120, y: 250 }, pc_xd: 100, pc_yd: 220 });
  assert.equal(part["angle"], 0);
  assert.equal("custom_angle" in part, false);
  // вне развёртки — отказ; без отделки — отказ
  assert.throws(() => setWallDecorAnchor(m, { room: "R1", wall: "w1", alongMm: 99999, heightMm: 500 }));
  assert.throws(() => setWallDecorAnchor(m, { room: "R1", wall: "w3", alongMm: 500, heightMm: 500 }));
});

test("389: сверка точки укладки — изменение и потеря ловятся, без изменений — пусто", () => {
  const m = withDecor(baseModel());
  setWallDecorAnchor(m, { room: "R1", wall: "w1", alongMm: 1000, heightMm: 500 });
  const rooms = (m.rooms2 as AnyRec) as Record<string, AnyRec>;
  assert.deepEqual(wallDecorAnchorMismatches(rooms, structuredClone(rooms) as Record<string, AnyRec>), []);
  const broken = structuredClone(rooms) as Record<string, AnyRec>;
  const part = (((broken["roomA"]!["decors"] as AnyRec[])[0]!["parts"] as AnyRec)["p1"] as AnyRec);
  (part["anchor"] as AnyRec)["pc_xd"] = 555;
  assert.equal(wallDecorAnchorMismatches(rooms, broken).length, 1);
  const lost = structuredClone(rooms) as Record<string, AnyRec>;
  delete (((lost["roomA"]!["decors"] as AnyRec[])[0]!["parts"] as AnyRec)["p1"] as AnyRec)["anchor"];
  assert.equal(wallDecorAnchorMismatches(rooms, lost).length, 1);
});
