// Фикс по ревью 383 (PR #58): major 28 — канон sig живых проб не скрывает
// пользовательские данные: плинтусы (floorMoldings/ceilingMoldings — состав в
// parts записи exist:true) и вложенные поля отделки exist:true (params и т.п.)
// различаются; сериализация без replacer-массива (он фильтрует ключи на всех
// уровнях вложенности); minor 30 — ключи prs_disabled канонизируются через
// oid → ed{edge_index}; minor 31 — pictures.text не строкового типа — попадание.
// Кейсы шума — доказанный производный шум прогона 1 из 382-1.log (ревью 383,
// раздел «Канон sig»): новые id комнат/eds2/items.id_room, шум координат ≤1e-3 см,
// число exist:false заглушек, edges_ceiling/demolines_ceiling_moldings, oid.
// Фикс-2 по ревью 385 (386): major 35 — потолок exist:true: вся запись минус
// производные (бандл при пересчёте комнат ПЕРЕНОСИТ angle/type_laying/anchor/
// complex/material2/niches/… — this.room.ceilings[e].anchor=s.ceilings[t].anchor,
// restoreCeilingNiches; конструктор class Ceiling их читает), зоны — color
// (zones[e].color=t.zones[i].color), ригели — height/depth (class Rigel);
// minor 37 — вложенное поле props.name в части плинтуса (replacer в частях
// больше не прячется); nit 40 — eds2 без replacer-массива.
import test from "node:test";
import assert from "node:assert/strict";
import { sig } from "../../scripts/probes/probe-sig.ts";
import { findUnsafeEditorStrings } from "../../src/model/strings.ts";
import type { Model } from "../../src/model/types.ts";

type AnyRec = Record<string, unknown>;

function baseModel(): AnyRec {
  return {
    v: 3, id: "o1", plan_id: "1",
    walls: {
      w1: {
        id: "w1", p1: { x: 0, y: 0 }, p2: { x: 921.2, y: 345.1 }, depth: 20,
        eds2: { left: [{ id: "e1", pc: "pc1", type: "plaster", exist: true }] },
      },
    },
    rooms1: {},
    rooms2: {
      rA: {
        name: "Кухня", plan: "rooms", height: 250, area: 12,
        polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 292.5 }],
        points: [], pc: null, corners: [],
        floors: [{ exist: false }],
        floorMoldings: [{ exist: false }],
        ceilingMoldings: [{ exist: false }],
        ceilings: [{ exist: true, material: "m1", level: 1, profile: null, polygons: [[1, 2]], edges: [1] }],
        zones: [{ name: "зона", is_micro_zone: true, area: 12.34, polygon: [{ x: 0, y: 0 }] }],
        edges_prs: [{ edge_index: 0, p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, oid: "abc", pillars: [] }],
        prs_disabled: {}, prs_first: 0, prs_hidden: 0,
        edges: [{ id: "ed9" }], id_of_edges: ["ed9"],
        edges_ceiling: [{ x: 1 }], demolines_ceiling_moldings: [{ x: 1 }],
        delimiters: {},
      },
    },
    items: { i1: { id: "i1", id_room: "rA" } },
    session: "s1", save_id: "sv1", version: "1",
  };
}

/** Производный шум прогона 1 (382-1.log / ревью 383): семантика та же. */
function noiseModel(): AnyRec {
  const m = structuredClone(baseModel()) as AnyRec;
  const room = (m.rooms2 as AnyRec)["rA"] as AnyRec;
  delete (m.rooms2 as AnyRec)["rA"];
  (m.rooms2 as AnyRec)["rB"] = room; // новый id комнаты
  const r = (m.rooms2 as AnyRec)["rB"] as AnyRec;
  r.polygon = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 292.4999 }]; // шум ≤1e-3 см
  r.floors = [{ exist: false }, { exist: false }]; // другое число заглушек
  r.floorMoldings = [{ exist: false }, { exist: false }];
  r.ceilingMoldings = [];
  r.edges_ceiling = []; // производные демолайны — пересчитаны
  r.demolines_ceiling_moldings = [];
  r.edges_prs = [{ edge_index: 0, p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, oid: "xyz", pillars: [] }]; // oid перегенерирован
  r.edges = [{ id: "ed77" }]; r.id_of_edges = ["ed77"]; // id перегенерированы
  const w = (m.walls as AnyRec)["w1"] as AnyRec;
  (w.eds2 as AnyRec).left = [{ id: "e2", pc: "pc2", type: "plaster", exist: true }]; // новые id eds2
  (m.items as AnyRec)["i1"] = { id: "i1", id_room: "rB" }; // id_room переименован
  m.session = "s2"; m.save_id = "sv2"; // служебные
  return m;
}

const withFinish = (mut: (room: AnyRec) => void): [AnyRec, AnyRec] => {
  const a = baseModel();
  const b = baseModel();
  mut(((b.rooms2 as AnyRec)["rA"] as AnyRec));
  return [a, b];
};
const molding = (len: number, color = "white"): AnyRec => ({
  exist: true, parts: { p1: { id: "p1", id_room: "rA", type: "plinth_a", length: len, color, props: { name: "плинтус-1" } } },
});

test("384 major28: производный шум прогона 1 (382-1.log) — sig равен", () => {
  assert.equal(sig(baseModel()), sig(noiseModel()), "новые id/шум координат/заглушки/edges_ceiling/oid — не различаются");
});

test("384 major28: плинтус — добавление, длина, цвет различаются (ранее скрывались)", () => {
  const [a, added] = withFinish((r) => { r.floorMoldings = [molding(300)]; });
  assert.notEqual(sig(a), sig(added), "плинтус добавлен (exist:true, parts) — различается");
  const [c, shorter] = withFinish((r) => { r.floorMoldings = [molding(150)]; });
  assert.notEqual(sig(added), sig(shorter), "длина плинтуса 300→150 — различается");
  const [d, black] = withFinish((r) => { r.floorMoldings = [molding(300, "black")]; });
  assert.notEqual(sig(added), sig(black), "цвет плинтуса — различается");
  // потолочный плинтус — так же
  const [e, ceil] = withFinish((r) => { r.ceilingMoldings = [molding(300)]; });
  assert.notEqual(sig(e), sig(ceil), "потолочный плинтус добавлен — различается");
});

test("384 major28: вложенные поля отделки exist:true различаются (replacer больше не прячет их)", () => {
  const [a, angle45] = withFinish((r) => {
    r.floors = [{ exist: true, cover: "laminate", type_laying: "straight", params: { angle: 45, shift: 10 } }];
  });
  const b = baseModel();
  (((b.rooms2 as AnyRec)["rA"] as AnyRec).floors as AnyRec[]) =
    [{ exist: true, cover: "laminate", type_laying: "straight", params: { angle: 0, shift: 10 } }];
  assert.notEqual(sig(b), sig(angle45), "пол exist:true, params.angle 0→45 — различается");
  assert.notEqual(sig(a), sig(angle45), "пол отсутствует vs пол с параметрами — различается");
  const removed = baseModel();
  (((removed.rooms2 as AnyRec)["rA"] as AnyRec).floors as AnyRec[]) = [{ exist: false }];
  assert.notEqual(sig(angle45), sig(removed), "пол exist:true удалён — различается");
});

test("384 major28: грубые изменения по-прежнему различаются (стена 5 мм, имя комнаты)", () => {
  const a = baseModel();
  const b = baseModel();
  const w = (b.walls as AnyRec)["w1"] as AnyRec;
  w.p2 = { x: 921.7, y: 345.1 }; // +5 мм
  assert.notEqual(sig(a), sig(b), "стена сдвинута на 5 мм — различается");
  const c = baseModel();
  (((c.rooms2 as AnyRec)["rA"] as AnyRec).name = "Гостиная");
  assert.notEqual(sig(a), sig(c), "имя комнаты изменено — различается");
});

test("384 minor30: ключи prs_disabled канонизуются через oid → ed{edge_index}, висячий ключ не скрывается", () => {
  const a = baseModel();
  const b = baseModel();
  const ra = ((a.rooms2 as AnyRec)["rA"] as AnyRec);
  const rb = ((b.rooms2 as AnyRec)["rA"] as AnyRec);
  ra.prs_disabled = { abc: "" };
  rb.prs_disabled = { xyz: "" }; // тот же отключённый край после перегенерации oid
  (rb.edges_prs as AnyRec[])[0]!["oid"] = "xyz"; // oid перегенерирован и в edges_prs
  assert.equal(sig(a), sig(b), "prs_disabled по одному краю — sig равен при смене oid");
  const c = baseModel();
  (((c.rooms2 as AnyRec)["rA"] as AnyRec).prs_disabled = { abc: "", dead: "" });
  assert.notEqual(sig(a), sig(c), "лишний (висячий) ключ prs_disabled — различается");
});

// ---------- minor 383 №31: pictures.text — fail-closed по типу ----------

test("384 minor31: pictures.text не строка (массив/объект/число) — попадание детектора", () => {
  for (const bad of [["<b>"], {}, 42]) {
    const m = { walls: {}, pictures: { p1: { text: bad } } } as unknown as Model;
    assert.ok(
      findUnsafeEditorStrings(m).some((h) => h.collection === "pictures" && h.field === "text"),
      `pictures.text = ${JSON.stringify(bad)} — попадание (fail-closed по типу)`,
    );
  }
  const ok = { walls: {}, pictures: { p1: { text: "подпись" } } } as unknown as Model;
  assert.equal(findUnsafeEditorStrings(ok).length, 0, "строковая безопасная подпись — не попадание");
});

// ---------- nit 383 №34: custom_plans[].content — тот же селекторный сток, что after_plan ----------

test("384 nit34: content не массив / не строковые элементы / опасные символы селектора — попадание", () => {
  for (const bad of ["<b>", 'x"] , .plan_other', "a\\b", ["plan", ["nested"]], { 0: "plan" }, 42]) {
    const m = { walls: {}, custom_plans: { sh1: { id: "sh1", name: "Лист", content: bad } } } as unknown as Model;
    assert.ok(
      findUnsafeEditorStrings(m).some((h) => h.collection === "custom_plans" && h.field === "content"),
      `content = ${JSON.stringify(bad)} — попадание`,
    );
  }
  const ok = { walls: {}, custom_plans: { sh1: { id: "sh1", name: "Лист", content: ["plan", "santeh"] } } } as unknown as Model;
  assert.equal(findUnsafeEditorStrings(ok).length, 0, "массив безопасных строк — не попадание");
  const absent = { walls: {}, custom_plans: { sh1: { id: "sh1", name: "Лист" } } } as unknown as Model;
  assert.equal(findUnsafeEditorStrings(absent).length, 0, "content отсутствует/null — не попадание");
});

// ---------- major 385 №35: потолки/зоны/ригели — переносимые бандлом поля ----------

// Поля потолка, которые бандл при пересчёте комнат ПЕРЕНОСИТ из старой записи
// в новую (this.room.ceilings[e].X=s.ceilings[t].X: level2, material2, type,
// profile, complex, radius, offset, anchor, type_laying, angle, custom_angle,
// interval, width, height, height_rail, on_interval) и читает конструктор
// class Ceiling; niches — restoreCeilingNiches. Раньше белый список
// {exist,material,level,profile} их выбрасывал.
const CEIL_FIELDS: [string, unknown, unknown][] = [
  ["angle", 0, 90],
  ["type_laying", "straight", "diagonal"],
  ["anchor", "a1", "a2"],
  ["complex", false, true],
  ["material2", null, "stretch_ceiling"],
  ["niches", [], [{ polygon: [{ x: 1, y: 1 }], edges: [1] }]],
  ["custom_angle", 0, 15],
  ["height_rail", null, 12],
  ["radius", null, 30],
  ["offset", 40, 60],
  ["level2", null, 7.5],
  ["type", "closed", "open"],
  ["width", 20, 40],
  ["height", 10, 20],
];

const withCeilingField = (field: string, v: unknown): AnyRec => {
  const m = baseModel();
  const r = (m.rooms2 as AnyRec)["rA"] as AnyRec;
  (r.ceilings as AnyRec[])[0] = { ...(r.ceilings as AnyRec[])[0]!, [field]: v };
  return m;
};

test("386 major35: потолок exist:true — каждое переносимое бандлом поле различается", () => {
  for (const [field, v0, v1] of CEIL_FIELDS) {
    assert.notEqual(sig(withCeilingField(field, v0)), sig(withCeilingField(field, v1)), `потолок ${field}: ${JSON.stringify(v0)} → ${JSON.stringify(v1)} — различается`);
    assert.equal(sig(withCeilingField(field, v0)), sig(withCeilingField(field, v0)), `потолок ${field}: то же значение — sig равен`);
  }
});

test("386 major35: потолок со всеми переносимыми полями — одинаковые записи не различаются", () => {
  const full = (m: AnyRec): AnyRec => {
    const r = (m.rooms2 as AnyRec)["rA"] as AnyRec;
    (r.ceilings as AnyRec[])[0] = {
      ...(r.ceilings as AnyRec[])[0]!,
      angle: 45, type_laying: "diagonal", anchor: "a1", complex: true, material2: "stretch_ceiling",
      niches: [{ polygon: [{ x: 1, y: 1 }] }], custom_angle: 15, height_rail: 12, radius: 30,
      offset: 40, level2: 7.5, type: "closed", width: 40, height: 20,
      interval: 300, on_interval: true,
    };
    return m;
  };
  assert.equal(sig(full(baseModel())), sig(full(baseModel())), "полная запись потолка с равными полями — sig равен");
});

test("386 major35: зона color различается (бандл zones[e].color=t.zones[i].color)", () => {
  const withColor = (color: unknown): AnyRec => {
    const m = baseModel();
    const r = (m.rooms2 as AnyRec)["rA"] as AnyRec;
    (r.zones as AnyRec[])[0] = { ...(r.zones as AnyRec[])[0]!, color };
    return m;
  };
  assert.notEqual(sig(withColor("red")), sig(withColor("blue")), "зона color red → blue — различается");
  assert.equal(sig(withColor("red")), sig(withColor("red")), "зона с тем же color — sig равен");
  assert.notEqual(sig(withColor("red")), sig(baseModel()), "зона с color vs без color — различается");
});

test("386 major35: ригель height/depth различаются (бандл class Rigel: this.height=e.height, this.depth=e.depth)", () => {
  const withRigel = (height: number, depth: number): AnyRec => {
    const m = baseModel();
    const r = (m.rooms2 as AnyRec)["rA"] as AnyRec;
    r.rigels = { rg1: { id: "rg1", p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, width: 20, ceiling_type: "m1", height, depth, polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }] } };
    return m;
  };
  assert.notEqual(sig(withRigel(20, 5)), sig(withRigel(40, 5)), "ригель height 20→40 — различается");
  assert.notEqual(sig(withRigel(20, 5)), sig(withRigel(20, 10)), "ригель depth 5→10 — различается");
  assert.equal(sig(withRigel(20, 5)), sig(withRigel(20, 5)), "ригель с теми же height/depth — sig равен");
});

// ---------- minor 385 №37: replacer в частях плинтуса ----------

test("386 minor37: вложенное поле части плинтуса (props.name) различается — replacer в частях больше не прячет", () => {
  const withProps = (name: string): AnyRec => {
    const m = baseModel();
    const r = (m.rooms2 as AnyRec)["rA"] as AnyRec;
    r.floorMoldings = [molding(300)];
    (((r.floorMoldings as AnyRec[])[0]!["parts"] as AnyRec)["p1"] as AnyRec)["props"] = { name };
    return m;
  };
  assert.notEqual(sig(withProps("плинтус-1")), sig(withProps("плинтус-2")), "props.name части плинтуса изменено — различается");
  assert.equal(sig(withProps("плинтус-1")), sig(withProps("плинтус-1")), "то же props.name — sig равен");
});

// ---------- nit 385 №40: eds2 без replacer-массива ----------

test("386 nit40: вложенные поля eds2 различаются — replacer-массив убран", () => {
  const withEds2Nested = (w: number): AnyRec => {
    const m = baseModel();
    const wall = (m.walls as AnyRec)["w1"] as AnyRec;
    ((wall.eds2 as AnyRec).left as AnyRec[])[0] = { id: "e1", pc: "pc1", type: "plaster", exist: true, p1: { x: 0, y: 0 }, p2: { x: 100, y: w } };
    return m;
  };
  assert.notEqual(sig(withEds2Nested(5)), sig(withEds2Nested(10)), "вложенная точка eds2 (p2.y) изменена — различается");
  assert.equal(sig(withEds2Nested(5)), sig(withEds2Nested(5)), "те же вложенные точки eds2 — sig равен");
});

// ---------- minor 387 №41: производные поля потолка polygon2/index_*/area_childs/polygons_layout_points ----------

// Бандл сериализует при exist:true (serialize, «e.polygon2=this.polygon2,…e.
// index_parent=…,e.index_childs=…,e.area_childs=…,e.polygons_layout=…,e.
// polygons_layout_points=…») — все пересчитываются при пересчёте комнат:
// this.area_childs={} затем gelCalcArea(…,this.area_childs); this.polygon2=e
// после get_inner_polygon+fixPolygon; polygons_layout_points — точки раскладки
// (class Ceiling читает e.polygons_layout_points||[], раскладка перестраивается);
// index_parent/index_childs — индексы зон потолка за закладными/делителями
// (пересчитываются вместе с polygons_layout). Канон их удаляет — но только их.
const CEIL_DERIVED_FIELDS = ["polygon2", "index_parent", "index_childs", "area_childs", "polygons_layout_points"] as const;

test("387 №41: производные поля потолка (polygon2/index_*/area_childs/polygons_layout_points) не дают ложного расхождения", () => {
  const withDerived = (v: Record<string, unknown>): AnyRec => {
    const m = baseModel();
    const r = (m.rooms2 as AnyRec)["rA"] as AnyRec;
    (r.ceilings as AnyRec[])[0] = { ...(r.ceilings as AnyRec[])[0]!, ...v };
    return m;
  };
  for (const f of CEIL_DERIVED_FIELDS) {
    assert.equal(
      sig(withDerived({ [f]: v1Of(f) })),
      sig(withDerived({ [f]: v2Of(f) })),
      `потолок ${f} (производное, бандл пересчитывает) — sig равен (ложного РАСХОЖДЕНИЕ нет)`,
    );
  }
});

function v1Of(f: string): unknown {
  if (f === "polygon2") return [{ x: 1, y: 2 }, { x: 3, y: 4 }];
  if (f === "area_childs") return { z1: 5.5 };
  if (f === "index_parent") return 0;
  if (f === "index_childs") return [1, 2];
  return [{ x: 9, y: 9 }];
}
function v2Of(f: string): unknown {
  if (f === "polygon2") return [{ x: 5, y: 6 }, { x: 7, y: 8 }];
  if (f === "area_childs") return { z1: 7.25 };
  if (f === "index_parent") return 1;
  if (f === "index_childs") return [3];
  return [];
}

test("387 №41: пользовательские поля потолка по-прежнему различаются (канон сузил исключения)", () => {
  // complex-набор пользовательских полей (268: serialize exist:true переносит
  // level2/material2/complex/radius/offset/anchor/type_laying/angle). 391 minor 11
  // (ревью 390): каждое поле проверяется ОТДЕЛЬНО — мутация канона, выбрасывающая
  // одно из набора, краснит тест, а не прячется за общим изменением восьми полей.
  const withUser = (field: string, value: unknown): AnyRec => {
    const m = baseModel();
    const r = (m.rooms2 as AnyRec)["rA"] as AnyRec;
    (r.ceilings as AnyRec[])[0] = {
      ...(r.ceilings as AnyRec[])[0]!,
      [field]: value,
    };
    return m;
  };
  const USER_FIELDS: Array<[string, unknown, unknown]> = [
    ["complex", true, false],
    ["material2", "stretch_ceiling", "gypsum_ceiling"],
    ["level2", 7.5, 8.5],
    ["radius", 10, 11],
    ["offset", 40, 41],
    ["anchor", { p: { x: 10, y: 20 } }, { p: { x: 11, y: 20 } }],
    ["type_laying", "diagonal", "straight"],
    ["angle", 0, 45],
  ];
  for (const [field, v1, v2] of USER_FIELDS) {
    assert.notEqual(sig(withUser(field, v1)), sig(withUser(field, v2)), `пользовательское поле потолка ${field} различается — канон не прячет данные`);
    assert.equal(sig(withUser(field, v1)), sig(withUser(field, v1)), `${field}: то же значение — sig равен`);
  }
  // index_parent/area_childs/… (производные) не дают расхождения — покрыто тестом выше
});
