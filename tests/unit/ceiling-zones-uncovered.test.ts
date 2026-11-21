// Ревью 335 m1/m3: ветка «тот же материал» в setCeilingFinish.
// m1: непокрытые зоны зонированного потолка (в редакторе отделку ставят по зоне
// кликом — часть зон без покрытия) покрываются тем же материалом; существующие
// записи не трогаются, complex на покрытых зонах сохраняется.
// m3: переданные level/profile применяются на месте ко ВСЕМ записям exist:true
// (мутации «снимает complex», «только первая запись», «игнорирует profile»
// краснеют), uncovered-зона покрывается.
// M1 (текст отказа): finishLossHint строит подсказку из фактических строк
// problems — какая отделка мешает и порядок её снятия. Фикс-5 (ревью 337):
// сопоставление — по кодам видов потери (FinishLoss), не регулярками по тексту.
import test from "node:test";
import assert from "node:assert/strict";
import type { Model, Point } from "../../src/model/types.ts";
import { setCeilingFinish, finishLossHint, type FinishLoss } from "../../src/model/finish.ts";

const sq = (x0: number): Point[] => [
  { x: x0, y: 0 }, { x: x0 + 200, y: 0 }, { x: x0 + 200, y: 300 }, { x: x0, y: 300 },
];

function zoneModel(ceilings: Array<Record<string, unknown>>): Model {
  return {
    walls: {},
    items: {},
    rooms2: {
      r1: {
        id: "r1",
        polygon: [sq(0)[0]!, sq(0)[1]!, { x: 400, y: 0 }, { x: 400, y: 300 }, sq(0)[2]!, sq(0)[3]!],
        ceilings,
      },
    },
  } as unknown as Model;
}

function zonesOf(m: Model): Array<Record<string, unknown>> {
  return ((m.rooms2 as Record<string, Record<string, unknown>>).r1!.ceilings) as Array<Record<string, unknown>>;
}

const COMPLEX_FIELDS = { complex: true, material2: "stretch_ceiling", level2: 75, offset: 40, radius: 10, type: "closed" };

test("335 m1: тот же материал на зонированном потолке с непокрытой зоной — зона покрывается, complex сохраняется", () => {
  const m = zoneModel([
    { exist: true, id: "_c1", material: "gypsum_ceiling", level: 15, profile: "standard", polygon: sq(0), ...COMPLEX_FIELDS },
    { exist: false, polygon: sq(200) },
  ]);
  const res = setCeilingFinish(m, "r1", "gypsum_ceiling", {});
  assert.equal(res.complexRemoved, false, "complex не снимается тем же материалом");
  const zs = zonesOf(m);
  assert.equal(zs.length, 2);
  assert.equal(zs[0]!.exist, true);
  assert.equal(zs[0]!.complex, true, "complex на покрытой зоне сохранён");
  assert.equal(zs[0]!.material2, "stretch_ceiling", "material2 сохранён");
  assert.equal(zs[0]!.level2, 75, "level2 сохранён");
  assert.equal(zs[1]!.exist, true, `непокрытая зона покрыта тем же материалом: ${JSON.stringify(zs[1])}`);
  assert.equal(zs[1]!.material, "gypsum_ceiling", "материал непокрытой зоны — тот же");
  assert.deepEqual(zs[1]!.polygon, sq(200), "полигон зоны сохранён");
  assert.notEqual(zs[1]!.id, zs[0]!.id, "у зоны свой id");
});

test("335 m1/m3: тот же материал + level/profile — все exist-записи обновлены, непокрытая зона покрыта", () => {
  const m = zoneModel([
    { exist: true, id: "_c1", material: "gypsum_ceiling", level: 15, ...COMPLEX_FIELDS, polygon: sq(0) },
    { exist: true, id: "_c2", material: "gypsum_ceiling", level: 5, profile: "standard", polygon: sq(200) },
    { exist: false, polygon: sq(0) },
  ]);
  const res = setCeilingFinish(m, "r1", "gypsum_ceiling", { level: 20, profile: "standard" });
  assert.equal(res.complexRemoved, false);
  const zs = zonesOf(m);
  assert.equal(zs[0]!.level, 20, `level обновлён в первой записи: ${JSON.stringify(zs[0])}`);
  assert.equal(zs[0]!.profile, "standard", "profile записан в первую запись (было не задано)");
  assert.equal(zs[0]!.complex, true, "complex сохранён при level/profile на месте");
  assert.equal(zs[1]!.level, 20, "level обновлён во второй записи (не только в первой)");
  assert.equal(zs[1]!.profile, "standard", "profile записан во вторую запись");
  assert.equal(zs[2]!.exist, true, "непокрытая зона покрыта");
  assert.equal(zs[2]!.level, 20, "новая зона — с переданным level");
  assert.equal(zs[2]!.profile, "standard", "новая зона — с переданным profile");
});

test("335 m1: все зоны покрыты тем же материалом — no-op без изменений (раньше была ветка Р1)", () => {
  const m = zoneModel([
    { exist: true, id: "_c1", material: "gypsum_ceiling", level: 15, profile: "standard", polygon: sq(0) },
    { exist: true, id: "_c2", material: "gypsum_ceiling", level: 15, profile: "standard", polygon: sq(200) },
  ]);
  const res = setCeilingFinish(m, "r1", "gypsum_ceiling", {});
  assert.equal(res.id, "_c1", "no-op возвращает id существующей записи");
  assert.equal(res.complexRemoved, false);
  const zs = zonesOf(m);
  assert.equal(zs[0]!.id, "_c1", "записи не пересоздаются");
  assert.equal(zs[1]!.id, "_c2", "записи не пересоздаются");
});

// --- M1: подсказка в отказе по фактическим расхождениям ---

test("335 M1: двухуровневый потолок — подсказка с finish_ceiling_set другим покрытием → finish_ceiling_remove", () => {
  const hint = finishLossHint([
    { kind: "ceiling_complex", text: 'room r2: потеряно покрытие потолка ({"material":"gypsum_ceiling","level":15,"profile":"standard","complex":{"material2":"stretch_ceiling","level2":75,"offset":40,"radius":10,"type":"closed"}}) при split/merge' },
  ]);
  assert.match(hint, /двухуровневое покрытие потолка/, `что мешает: ${hint}`);
  assert.match(hint, /finish_ceiling_set с другим покрытием/, `первый шаг: ${hint}`);
  assert.match(hint, /finish_ceiling_remove/, `затем ластик: ${hint}`);
  assert.doesNotMatch(hint, /finish_floor_remove/, `пол не упоминается: ${hint}`);
  assert.doesNotMatch(hint, /finish_wall_remove/, `отделка стен не упоминается: ${hint}`);
});

test("335 M1: пол и отделка стен — подсказка с finish_floor_remove и finish_wall_remove", () => {
  const hint = finishLossHint([
    { kind: "floor", text: "room r1: потеряно покрытие пола (laminate) при split/merge" },
    { kind: "wall_side", text: "room r1: потеряна отделка стены W3 (paint_wall, слой 1) при split/merge" },
  ] as FinishLoss[]);
  assert.match(hint, /покрытие пола/, `что мешает: ${hint}`);
  assert.match(hint, /отделку сторон стен/, `что мешает: ${hint}`);
  assert.match(hint, /finish_floor_remove/, `снятие пола: ${hint}`);
  assert.match(hint, /finish_wall_remove/, `снятие отделки стен: ${hint}`);
  assert.doesNotMatch(hint, /finish_ceiling/, `потолок не упоминается: ${hint}`);
});

test("335 M1: простой потолок (complex:null) — подсказка без шага смены материала", () => {
  const hint = finishLossHint([
    { kind: "ceiling", text: 'room r1: потеряно покрытие потолка ({"material":"gypsum_ceiling","level":0,"profile":"standard","complex":null}) при split/merge' },
  ]);
  assert.match(hint, /покрытие потолка/, `что мешает: ${hint}`);
  assert.doesNotMatch(hint, /двухуровнев/, `не двухуровневый: ${hint}`);
  assert.match(hint, /finish_ceiling_remove/, `ластик: ${hint}`);
  assert.doesNotMatch(hint, /finish_ceiling_set/, `смена материала не нужна: ${hint}`);
});

// --- 337 n3: непокрытая зона наследует level/profile покрытых зон ---

test("337 n3: непокрытая зона без переданного level/profile наследует head (level 15), а не 0", () => {
  const m = zoneModel([
    { exist: true, id: "_c1", material: "gypsum_ceiling", level: 15, profile: "standard", polygon: sq(0), ...COMPLEX_FIELDS },
    { exist: false, polygon: sq(200) },
  ]);
  const res = setCeilingFinish(m, "r1", "gypsum_ceiling", {});
  assert.equal(res.complexRemoved, false);
  const zs = zonesOf(m);
  assert.equal(zs[1]!.exist, true, "непокрытая зона покрыта");
  assert.equal(zs[1]!.level, 15, `наследует level соседней покрытой зоны: ${JSON.stringify(zs[1])}`);
  assert.equal(zs[1]!.profile, "standard", "наследует profile соседней покрытой зоны");
});

// n7 ревью 339: прежнее название обещало «умолчания 0/standard» и «приоритет
// переданных параметров», а тело проверяло то же наследование level 15. Умолчания
// через existRecs недостижимы (exist:true всегда есть), приоритет параметров
// проверяется здесь: переданный level перекрывает наследуемый.
test("337 n3: переданный level приоритетнее наследования от покрытой зоны", () => {
  const m = zoneModel([
    { exist: false, polygon: sq(0) },
    { exist: true, id: "_c1", material: "gypsum_ceiling", level: 15, profile: "standard", polygon: sq(200) },
    { exist: false, polygon: sq(0) },
  ]);
  // exist:true есть только в [1]; непокрытая [0] без параметра наследовала бы 15
  setCeilingFinish(m, "r1", "gypsum_ceiling", { level: 20 });
  const zs = zonesOf(m);
  assert.equal(zs[0]!.exist, true, "первая зона покрыта");
  assert.equal(zs[0]!.level, 20, `переданный level приоритетнее наследования: ${JSON.stringify(zs[0])}`);
  assert.equal(zs[0]!.profile, "standard", "profile без параметра наследуется");
});
