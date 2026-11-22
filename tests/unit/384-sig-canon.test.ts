// Фикс по ревью 383 (PR #58): major 28 — канон sig живых проб не скрывает
// пользовательские данные: плинтусы (floorMoldings/ceilingMoldings — состав в
// parts записи exist:true) и вложенные поля отделки exist:true (params и т.п.)
// различаются; сериализация без replacer-массива (он фильтрует ключи на всех
// уровнях вложенности); minor 30 — ключи prs_disabled канонизируются через
// oid → ed{edge_index}; minor 31 — pictures.text не строкового типа — попадание.
// Кейсы шума — доказанный производный шум прогона 1 из 382-1.log (ревью 383,
// раздел «Канон sig»): новые id комнат/eds2/items.id_room, шум координат ≤1e-3 см,
// число exist:false заглушек, edges_ceiling/demolines_ceiling_moldings, oid.
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
  exist: true, parts: { p1: { id: "p1", id_room: "rA", type: "plinth_a", length: len, color } },
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
