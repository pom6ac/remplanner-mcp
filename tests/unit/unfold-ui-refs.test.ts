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
  // форма slim — по draw бандла (height<=10 → type=wall_molding_slim, height=width_line);
  // эталон исправлен по ревью 390 №13 (type:"wall_molding" при height:3 противоречил draw)
  assert.equal(rec.type, "wall_molding_slim");
  assert.equal(rec.height, rec.width_line);
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
  // height ≤ 10 см → slim: height = width_line (draw бандла, major 3 ревью 390)
  assert.equal(rec.height, rec.width_line);
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

test("391 major 3: форма slim по draw бандла — slim: height=width_line, slim_h: width=width_line", () => {
  const m = baseModel();
  // height_mm=100 → редактор (draw) переписал бы height в width_line (4 см)
  const slim = addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 500, bottomMm: 500, widthMm: 400, heightMm: 100 });
  assert.equal(slim.type, "wall_molding_slim");
  assert.equal(slim.height, slim.width_line, "height == width_line (draw бандла)");
  assert.equal(slim.width, 40, "width — пользовательская");
  // slim_h: ширина = толщине линии
  const slimH = addPrsFigure(m, "wall_molding", { room: "R1", wall: "w1", alongMm: 500, bottomMm: 500, widthMm: 100, heightMm: 300, widthLineMm: 60 });
  assert.equal(slimH.type, "wall_molding_slim_h");
  assert.equal(slimH.width, slimH.width_line, "width == width_line (draw бандла)");
  assert.equal(slimH.height, 30, "height — пользовательская");
  // update пересчитывает форму тоже
  const upd = updatePrsFigure(m, "wall_molding", "WM1", { widthMm: 500, heightMm: 100 });
  assert.equal(upd.type, "wall_molding_slim");
  assert.equal(upd.height, upd.width_line);
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

test("391 major 4: глубина ниши ≤ min(толщина стены, 80 см) — как в редакторе (draw/menu)", () => {
  const m = baseModel();
  // тонкая стена w1 — толщина 10 см
  ((m.walls as AnyRec)["w1"] as AnyRec)["depth"] = 10;
  // default = min(200, толщина стены 100 мм) = 100 мм (draw: depth=min(20,getWallDepth(),80))
  const n1 = addPrsFigure(m, "wall_niche", { room: "R1", wall: "w1", alongMm: 1000, bottomMm: 1200, widthMm: 400, heightMm: 400 });
  assert.equal(n1.depth, 10, `default на стене 10 см: min(20,10,80)=${String(n1.depth)}`);
  // вход больше предела — INVALID_ARGUMENT (меню: correctValue(t,5,min(80,getWallDepth())))
  assert.throws(() =>
    addPrsFigure(m, "wall_niche", { room: "R1", wall: "w1", alongMm: 2500, bottomMm: 1200, widthMm: 400, heightMm: 400, depthMm: 1000 }),
  );
  // на стене 20 см глубина ограничена толщиной (меню: min(80, getWallDepth()=20))
  const n2 = addPrsFigure(m, "wall_niche", { room: "R1", wall: "w3", alongMm: 2000, bottomMm: 1000, widthMm: 800, heightMm: 1200, depthMm: 200 });
  assert.equal(n2.depth, 20);
  assert.throws(() =>
    addPrsFigure(m, "wall_niche", { room: "R1", wall: "w3", alongMm: 2000, bottomMm: 1000, widthMm: 800, heightMm: 1200, depthMm: 210 }),
  );
  // меньше 50 мм — отказ (correctValue(t,5,…))
  assert.throws(() =>
    addPrsFigure(m, "wall_niche", { room: "R1", wall: "w3", alongMm: 2000, bottomMm: 2600, widthMm: 800, heightMm: 20, depthMm: 40 }),
  );
  // update: тот же предел
  assert.throws(() => updatePrsFigure(m, "wall_niche", "WN1", { depthMm: 1000 }));
  // сторона e/s ребра — глубина ограничена длиной стены (get_wall_depth: side e/s → длина),
  // default min(20, длина 400, 80)=20; вход до 800 мм принимается
  const m2 = baseModel();
  const room = (m2.rooms2 as AnyRec)["roomA"] as AnyRec;
  ((room["edges"] as AnyRec[])[0] as AnyRec)["side"] = "s";
  const n3 = addPrsFigure(m2, "wall_niche", { room: "R1", wall: "w1", alongMm: 1000, bottomMm: 1200, widthMm: 400, heightMm: 400 });
  assert.equal(n3.depth, PRS_NICHE_DEPTH_CM, "сторона e/s: default min(20, длина 400, 80) = 20");
  const n4 = addPrsFigure(m2, "wall_niche", { room: "R1", wall: "w1", alongMm: 2500, bottomMm: 1200, widthMm: 400, heightMm: 400, depthMm: 800 });
  assert.equal(n4.depth, 80, "сторона e/s: до 800 мм принимается (длина стены 400 см > 80)");
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
  assert.deepEqual(st.disabled_edges, [0, 1, 2, 3]);
  const room = (m.rooms2 as AnyRec)["roomA"] as AnyRec;
  assert.equal(room["prs_hidden"], 1);
  assert.deepEqual(Object.keys(room["prs_disabled"] as AnyRec).sort(), ["oid1", "oid2", "oid3", "oid4"]);
  st = setPrsSettings(m, "R1", { hidden: false });
  assert.equal(st.hidden, false);
  assert.deepEqual(Object.keys(room["prs_disabled"] as AnyRec), []);
  // скрыть одну развёртку (w2) — prs_hidden сбрасывается в 0 (обработчик visibility)
  st = setPrsSettings(m, "R1", { hideWalls: ["w2"] });
  assert.equal(room["prs_hidden"], 0);
  assert.deepEqual(st.disabled_edges, [1]);
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

test("391 minor 6: скрытие всех развёрток по одной ставит prs_hidden=1 (visibility бандла)", () => {
  const m = baseModel();
  const room = (m.rooms2 as AnyRec)["roomA"] as AnyRec;
  const st = setPrsSettings(m, "R1", { hideWalls: ["w1", "w2", "w3", "w4"] });
  assert.equal(room["prs_hidden"], 1, "все не-короткие скрыты по одной → prs_hidden=1");
  assert.equal(st.hidden, true);
  // показать одну — prs_hidden обратно 0
  setPrsSettings(m, "R1", { showWalls: ["w1"] });
  assert.equal(room["prs_hidden"], 0);
});

test("391 minor 7: метка W<n> принимается во входе wall (общий резолвер стен)", () => {
  const m = baseModel();
  const rec = addPrsFigure(m, "wall_molding", { room: "R1", wall: "W1", alongMm: 1500, bottomMm: 1200, widthMm: 800, heightMm: 300 });
  assert.equal((rec.prs as AnyRec)["room"], "roomA");
  assert.equal((rec.prs as AnyRec)["edge_index"], 0);
  // prs_set и anchor тоже принимают W<n>
  const st = setPrsSettings(m, "R1", { firstWall: "W2" });
  assert.equal(st.first_edge, 1);
  const m2 = withDecor(baseModel());
  const res = setWallDecorAnchor(m2, { room: "R1", wall: "W1", alongMm: 1000, heightMm: 500 });
  assert.equal(res.edge, 0);
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

// ---------- 391 major 1: затронутость молдингов/ниш при wall-операциях ----------

/**
 * Мок normalize для wall-операций (поведение редактора по бандлу):
 *  - dropFigures: комната исчезла (контур разомкнут wall_delete) → Room.delete
 *    удаляет WALL_MOLDINGS/WALL_NICHES комнаты;
 *  - keepDangling: фигуры остаются с висячим prs.room (restorePrsChangeEdges
 *    не переносит непоместившуюся фигуру);
 *  - recut: wall_split-подобная смена нарезки — комната сохранена, число рёбер
 *    выросло, prs_first/prs_disabled сброшены (restorePrsChangeEdges), фигура
 *    получила edge_index вне диапазона → сигнал 43 (перенос на последнюю линию).
 */
function wsWallDeps(
  server: { saveId: string; model: Model },
  mode: "drop-figures" | "keep-dangling" | "recut",
) {
  let lastNormalized: Record<string, unknown> | null = null;
  const editor = {
    objectId: "123", planId: "1",
    async normalize(model: unknown) {
      const out = structuredClone(model) as AnyRec;
      const walls = out["walls"] as AnyRec;
      const rooms = (out["rooms2"] ?? {}) as AnyRec;
      if (!walls["w1"]) {
        // контур разомкнут — комната исчезает
        if (rooms["roomA"]) {
          delete rooms["roomA"];
          if (mode === "drop-figures") {
            for (const c of ["wall_moldings", "wall_niches"]) {
              const coll = (out[c] ?? {}) as AnyRec;
              for (const [k, v] of Object.entries(coll)) if (((v as AnyRec)["prs"] as AnyRec)?.["room"] === "roomA") delete coll[k];
            }
          }
        }
      }
      const w1rec = walls["w1"] as AnyRec | undefined;
      if (mode === "recut" && w1rec && (((w1rec["p1"] ?? {}) as AnyRec)["y"] as number | undefined ?? 0) > 1) {
        // стена w1 подвинута: редактор пересчитал комнаты — id сменился,
        // нарезка выросла, настройки prs сброшены, фигура уехала на последнюю линию
        if (rooms["roomA"]) {
          rooms["roomB"] = rooms["roomA"];
          delete rooms["roomA"];
          const roomB = rooms["roomB"] as AnyRec;
          roomB["edges_prs"] = [
            ...(roomB["edges_prs"] as AnyRec[]),
            { edge_index: 4, p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, oid: "oid5", pillars: [] },
          ];
          roomB["prs_first"] = 0;
          roomB["prs_disabled"] = {};
          for (const c of ["wall_moldings", "wall_niches"]) {
            for (const v of Object.values((out[c] ?? {}) as AnyRec)) {
              const prs = (v as AnyRec)["prs"] as AnyRec;
              if (prs?.["room"] === "roomA") prs["room"] = "roomB";
              // restorePrsChangeEdges перенёс фигуру на совпавшую по геометрии
              // линию с новой нумерацией (последняя) — edge_index сменился
              if (prs && typeof prs["edge_index"] === "number") prs["edge_index"] = 4;
            }
          }
        }
      }
      lastNormalized = out;
      return { model: out, rooms: [], walls: [], before: { walls: 4, holes: 0, items: 0 }, after: { walls: 4, holes: 0, items: 0 } };
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
    async loadModel() { return { object_id: "123", plan_id: "1", save_id: server.saveId, units: "cm", model: structuredClone(server.model) as unknown as AnyRec }; },
    async openEditor() { return editor; },
  } as unknown as import("../../src/workspace.ts").WorkspaceDeps;
}

test("391 major 1: wall_delete с молдингом — предупреждение о потере (Room.delete редактора)", async () => {
  const server = { saveId: "s1", model: wsFixture() };
  const ws = new Workspace(wsWallDeps(server, "drop-figures") as never);
  await ws.open("123", "1");
  ws.apply("wall_molding_add", (m) => addPrsFigure(m, "wall_molding", { room: "R1", wall: "w2", alongMm: 1500, bottomMm: 1200, widthMm: 800, heightMm: 300 }));
  const { warnings } = await ws.applyWalls("wall_delete", (m) => { delete m.walls["w1"]; return true; });
  assert.ok(warnings.some((w) => /молдинг развёртки/.test(w)), `предупреждение о фигуре: ${JSON.stringify(warnings)}`);
  assert.equal(Object.keys(ws.model.wall_moldings ?? {}).length, 0, "молдинг удалён редактором");
  const res = await ws.save();
  assert.equal(res.verified, true, `save verified, warnings: ${JSON.stringify(res.warnings)}`);
});

test("391 major 1: wall_delete с висячим prs.room — каскад как Room.delete, verified=true", async () => {
  const server = { saveId: "s1", model: wsFixture() };
  const ws = new Workspace(wsWallDeps(server, "keep-dangling") as never);
  await ws.open("123", "1");
  ws.apply("wall_niche_add", (m) => addPrsFigure(m, "wall_niche", { room: "R1", wall: "w2", alongMm: 1500, bottomMm: 1200, widthMm: 800, heightMm: 300 }));
  const { warnings } = await ws.applyWalls("wall_delete", (m) => { delete m.walls["w1"]; return true; });
  assert.ok(warnings.some((w) => /ниша развёртки.*удал|висяч/.test(w) || /висячая ссылка/.test(w)), `предупреждение о каскаде: ${JSON.stringify(warnings)}`);
  assert.equal(Object.keys(ws.model.wall_niches ?? {}).length, 0, "висячая запись удалена каскадом");
  const res = await ws.save();
  assert.equal(res.verified, true, `save verified (без каскада — NORMALIZATION_DROPPED «лишняя запись»), warnings: ${JSON.stringify(res.warnings)}`);
});

test("391 major 1: wall_move — фигура переживает (id комнаты сменился), потери нет; перенос ребра — предупреждение (сигнал 43)", async () => {
  const server = { saveId: "s1", model: wsFixture() };
  const ws = new Workspace(wsWallDeps(server, "recut") as never);
  await ws.open("123", "1");
  ws.apply("prs_set", (m) => setPrsSettings(m, "R1", { hideWalls: ["w2"], firstWall: "w3" }));
  ws.apply("wall_molding_add", (m) => addPrsFigure(m, "wall_molding", { room: "R1", wall: "w2", alongMm: 1500, bottomMm: 1200, widthMm: 800, heightMm: 300 }));
  const { warnings } = await ws.applyWalls("wall_move", (m) => {
    const w1 = m.walls["w1"]!;
    w1.p1 = { x: w1.p1.x, y: w1.p1.y + 20 };
    w1.p2 = { x: w1.p2.x, y: w1.p2.y + 20 };
    return true;
  });
  assert.ok(warnings.some((w) => /на другую развёртку|сигнал 43/.test(w)), `предупреждение о переносе: ${JSON.stringify(warnings)}`);
  assert.ok(warnings.some((w) => /настройки развёрток комнаты .* сброшены/.test(w)), `предупреждение о сбросе prs (minor 14): ${JSON.stringify(warnings)}`);
  // фигура пережила: комната сменила id, ссылка обновлена редактором
  const molds = Object.values(ws.model.wall_moldings ?? {}) as AnyRec[];
  assert.equal(molds.length, 1);
  assert.equal((molds[0]!["prs"] as AnyRec)["room"], "roomB", "ссылка на комнату обновлена редактором");
  const res = await ws.save();
  assert.equal(res.verified, true, `save verified, warnings: ${JSON.stringify(res.warnings)}`);
});

test("391 major 1: фигура на незатронутой стене — предупреждений о развёртках нет", async () => {
  const server = { saveId: "s1", model: wsFixture() };
  const ws = new Workspace(wsWallDeps(server, "drop-figures") as never);
  await ws.open("123", "1");
  ws.apply("wall_molding_add", (m) => addPrsFigure(m, "wall_molding", { room: "R1", wall: "w2", alongMm: 1500, bottomMm: 1200, widthMm: 800, heightMm: 300 }));
  const { warnings } = await ws.applyWalls("wall_move", (m) => {
    const w1 = m.walls["w1"]!;
    w1.p1 = { x: w1.p1.x, y: w1.p1.y + 20 };
    w1.p2 = { x: w1.p2.x, y: w1.p2.y + 20 };
    return true;
  });
  assert.ok(!warnings.some((w) => /молдинг развёртки/.test(w)), `без ложных предупреждений: ${JSON.stringify(warnings)}`);
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
  // pc_yd — от yMin полигона ЧАСТИ (бандл: new Polygon(WALL_DECORS[a.id].polygon));
  // часть 0..250 см: yMin = 30+270−250 = 50 → pc_yd = (300−50) − 50 = 200
  assert.deepEqual(part["anchor"], { p: { x: 120, y: 250 }, pc_xd: 100, pc_yd: 200 });
  assert.equal(part["angle"], 0);
  assert.equal("custom_angle" in part, false);
  // вне развёртки — отказ; без отделки — отказ
  assert.throws(() => setWallDecorAnchor(m, { room: "R1", wall: "w1", alongMm: 99999, heightMm: 500 }));
  assert.throws(() => setWallDecorAnchor(m, { room: "R1", wall: "w3", alongMm: 500, heightMm: 500 }));
});

test("391 major 2: точка ставится только в часть, содержащую точку; pc_yd от части; остальные части не тронуты", () => {
  const m = baseModel();
  const room = (m.rooms2 as AnyRec)["roomA"] as AnyRec;
  room["decors"] = [
    { exist: true, parts: {
      p1: { id: "p1", type: "wall_tile", layer: 1, height_from_floor: 0, height: 120, angle: 0 },
      p2: { id: "p2", type: "wall_tile", layer: 1, height_from_floor: 120, height: 0, angle: 45, custom_angle: 45 },
    } },
    { exist: false }, { exist: false }, { exist: false },
  ];
  // точка 50 см от пола — в части p1 (0..120); редактор: pc_yd = (300−50) − (300−120) = 70
  const res = setWallDecorAnchor(m, { room: "R1", wall: "w1", alongMm: 1000, heightMm: 500 });
  const parts = ((room["decors"] as AnyRec[])[0]!["parts"]) as Record<string, AnyRec>;
  const p1 = parts["p1"]! as AnyRec;
  const p2 = parts["p2"]! as AnyRec;
  assert.equal((p1["anchor"] as AnyRec)["pc_yd"], 70, "pc_yd от полигона части p1");
  assert.equal(res.part, "p1");
  assert.equal(res.angle, 0);
  // p2 не тронута: angle 45 и custom_angle сохранены, якоря нет
  assert.equal(p2["angle"], 45, "angle другой части не сброшен");
  assert.equal(p2["custom_angle"], 45, "custom_angle другой части не стёрт");
  assert.equal("anchor" in p2, false, "якорь не ставится в другую часть");
  // точка в части p2 (выше 120) — по layer
  const res2 = setWallDecorAnchor(m, { room: "R1", wall: "w1", alongMm: 1000, heightMm: 1500, layer: 1 });
  assert.equal(res2.part, "p2");
  const p2b = (((((m.rooms2 as AnyRec)["roomA"] as AnyRec)["decors"] as AnyRec[])[0]!["parts"] as AnyRec)["p2"]) as AnyRec;
  // p2: 120..270 (height 0 → до верха): pc_yd = (300−150) − (300−270) = 120
  assert.equal((p2b["anchor"] as AnyRec)["pc_yd"], 120);
  assert.equal("custom_angle" in p2b, false, "custom_angle стёрт у целевой части");
  // без layer и точка на границе двух частей (120 см) — отказ с перечнем слоёв
  assert.throws(() => setWallDecorAnchor(m, { room: "R1", wall: "w1", alongMm: 1000, heightMm: 1200 }), /layer/);
  // неизвестный layer — отказ
  assert.throws(() => setWallDecorAnchor(m, { room: "R1", wall: "w1", alongMm: 1000, heightMm: 500, layer: 7 }), /layer/);
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
