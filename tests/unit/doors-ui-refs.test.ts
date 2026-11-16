// Этап 37 «Двери и проемы»: структурная сверка 20 типов с эталонами UI (ui-ref-door-*.json),
// атомарность (кандидат-копия), цепочки update, совместимость с объектами v0.1.1 (9ae566f),
// регрессия окон.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hole, Model, Wall } from "../../src/model/types.ts";
import { newId } from "../../src/model/types.ts";
import { mmToCm, roundTenthMm as r2 } from "../../src/model/units.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addOpening, updateOpening, deleteOpening, OPENING_KINDS, holeOffsetCm, holeRange } from "../../src/model/openings.ts";
import { pointsAroundCenter, pointAtLength } from "../../src/model/geometry.ts";
import { compactModel } from "../../src/model/compact.ts";

const here = dirname(fileURLToPath(import.meta.url));

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {} };
}

function rect(model: Model) {
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  return { top: walls[0]!, right: walls[1]!, bottom: walls[2]!, left: walls[3]! };
}

/** 20 пунктов меню «Двери и проемы», поставленных кликами в UI (этап 37). */
const DOOR_KEYS = [
  "doorway", "door", "door_double", "door_coupe", "door_coupe_double",
  "door_penal", "door_penal_double", "door_roto", "door_roto_double",
  "door_book", "door_book_double", "door_bellows", "door_glass", "door_garage",
  "door_system_x2", "door_system_x3", "door_system_x4",
  "door_system_penal_x2", "door_system_penal_x3", "door_system_penal_x4",
] as const;

/**
 * Сверка семантических ключей эталона В ОБЕ СТОРОНЫ (ревью 38, R2): идём и по ключам
 * эталона (лишнее поле в результате — ошибка, если эталон его не имеет), и по ключам
 * результата (потеря поля эталона — ошибка). Служебные и вычисляемые MCP поля
 * пропускаются по явным спискам. opening входит в эталоны: редактор пишет дефолт вида,
 * в MCP он задаётся параметром swing (формат зависит от типа — §5.2).
 */
const SERVICE_KEYS = new Set(["plan", "id", "parent", "parent_depth", "position", "offset", "f0offset", "_wall"]);
/** Вычисляемые MCP поля геометрии (края/центр проёма на оси) — не семантика эталона. */
const COMPUTED_KEYS = new Set(["pc", "at", "p1", "p2"]);

function expectStructural(hole: Hole, ref: Record<string, unknown>) {
  const et = ref.defaults_model_cm as Record<string, unknown>;
  // прямая: каждый ключ эталона обязан присутствовать в результате с тем же значением
  for (const f of Object.keys(et)) {
    if (SERVICE_KEYS.has(f)) continue;
    if (et[f] === undefined) {
      assert.ok(hole[f] === undefined, `${ref.catalog_key}: поле ${f} не должно задаваться (эталон без него)`);
    } else {
      assert.deepEqual(hole[f], et[f], `${ref.catalog_key}: поле ${f}`);
    }
  }
  // обратная: каждый семантический ключ результата обязан быть в эталоне
  for (const f of Object.keys(hole)) {
    if (SERVICE_KEYS.has(f) || COMPUTED_KEYS.has(f)) continue;
    if (hole[f] === undefined) continue;
    assert.ok(f in et && et[f] !== undefined, `${ref.catalog_key}: в результате лишнее поле ${f}, которого нет в эталоне`);
  }
}

test("двери не содержат оконных полей floor_height, sill, slopes (ревью 38, R2)", () => {
  const model = emptyModel();
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 36000, depthMm: 36000, thicknessMm: 200 });
  DOOR_KEYS.forEach((key, i) => {
    // по 5 дверей на стену с шагом 3400 мм — умещаются и гаражные (3000), и x4 (3200)
    const hole = addOpening(model, { wallId: walls[i % 4]!.id, type: key, centerMm: 2000 + Math.floor(i / 4) * 3400 });
    assert.equal(hole.floor_height, undefined, `${key}: floor_height`);
    assert.equal(hole.sill, undefined, `${key}: sill`);
    assert.equal(hole.slopes, undefined, `${key}: slopes`);
  });
});

for (const key of DOOR_KEYS) {
  test(`дверь ${key}: структура дефолтов совпадает с эталоном UI`, () => {
    const ref = JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-door-${key}.json`), "utf8"));
    assert.equal(OPENING_KINDS[key]!.type, ref.model_type);
    assert.equal(OPENING_KINDS[key]!.group, "doors");
    const model = emptyModel();
    const { top } = rect(model);
    const hole = addOpening(model, { wallId: top.id, type: key, centerMm: 2000 });
    expectStructural(hole, ref as unknown as Record<string, unknown>);
  });
}

test("каждый пункт меню «Двери и проемы» имеет русское имя в эталоне и тип в OPENING_KINDS", () => {
  for (const key of DOOR_KEYS) {
    const ref = JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-door-${key}.json`), "utf8"));
    assert.ok(ref.menu_title && ref.menu_title.length > 3, key);
    assert.ok(OPENING_KINDS[key], key);
  }
});

test("дверь: дефолтные размеры совпадают с defs редактора (сняты пробой 37-dbg-defs)", () => {
  // выборочно: гараж 300×225, каскадная x4 320, проем без двери 80×210, глубина всегда 4
  assert.deepEqual(
    Object.fromEntries(["doorway", "door", "door_double", "door_garage", "door_system_x4", "door_system_penal_x3"]
      .map((k) => [k, [OPENING_KINDS[k]!.widthMm, OPENING_KINDS[k]!.heightMm, OPENING_KINDS[k]!.depthCm]])),
    { doorway: [800, 2100, 4], door: [800, 2100, 4], door_double: [1200, 2100, 4],
      door_garage: [3000, 2250, 4], door_system_x4: [3200, 2100, 4], door_system_penal_x3: [2400, 2100, 4] },
  );
});

test("дверь: swing задаёт opening; casing выключает короб с наличниками", () => {
  const model = emptyModel();
  const { top, bottom } = rect(model);
  const h1 = addOpening(model, { wallId: top.id, type: "door", centerMm: 500, swing: { hinge: "start", into: "left" } });
  assert.equal(h1.opening, "l-l");
  assert.equal(h1.casing, 1); // эталон: короб включён по умолчанию
  const h2 = addOpening(model, { wallId: top.id, type: "door", centerMm: 1500, casing: false });
  assert.equal(h2.casing, 0);
  // у doorway и door_garage короб выключен по умолчанию (эталон UI)
  const dw = addOpening(model, { wallId: top.id, type: "doorway", centerMm: 2500 });
  assert.equal(dw.casing, 0);
  const gr = addOpening(model, { wallId: bottom.id, type: "door_garage", centerMm: 2000 });
  assert.equal(gr.casing, 0);
});

test("дверь: дефолтный opening по эталону UI — у сдвижных двухчастный, у двустворчатых однобуквенный", () => {
  const model = emptyModel();
  const { top, bottom, right, left } = rect(model);
  // сдвижные одинарные: двухчастный формат (restore без него падает — матрица 37-dbg-opening-matrix)
  assert.equal(addOpening(model, { wallId: top.id, type: "door_coupe", centerMm: 500 }).opening, "r-l");
  assert.equal(addOpening(model, { wallId: top.id, type: "door_roto", centerMm: 1500 }).opening, "r-l");
  assert.equal(addOpening(model, { wallId: top.id, type: "door_bellows", centerMm: 3500 }).opening, "r-l");
  assert.equal(addOpening(model, { wallId: bottom.id, type: "door_penal", centerMm: 500, swing: { hinge: "end", into: "left" } }).opening, "l");
  // двустворчатые сдвижные/garage: однобуквенный формат
  assert.equal(addOpening(model, { wallId: bottom.id, type: "door_coupe_double", centerMm: 1700, widthMm: 1600 }).opening, "r");
  assert.equal(addOpening(model, { wallId: top.id, type: "door_penal", centerMm: 2500 }).opening, "r");
  assert.equal(addOpening(model, { wallId: left.id, type: "door_garage", centerMm: 1500, widthMm: 2000, heightMm: 2000 }).opening, "r");
  const gr = addOpening(model, { wallId: right.id, type: "door_system_x3", centerMm: 1500, widthMm: 2400 });
  assert.equal(gr.opening, "r-l");
});

test("дверь: update нормализует opening legacy-объектов v0.1.1 к формату вида", () => {
  const model = emptyModel();
  const { top } = rect(model);
  // legacy door_coupe без opening (v0.1.1 не писал opening) — редактор такой объект не восстанавливает
  const legacy: Hole = {
    id: "lc1", plan: "a", type: "door_coupe", group: "doors",
    pc: { x: 170, y: -10 }, width: 80, height: 210, depth: 4, at: 130,
    p1: { x: 130, y: -10 }, p2: { x: 210, y: -10 },
  };
  top.holes[legacy.id] = legacy;
  updateOpening(model, { wallId: top.id, holeId: legacy.id, widthMm: 900 });
  assert.equal(legacy.opening, "r-l"); // дефолт вида (двухчастный формат обязателен)
  // legacy door_penal с двухчастным opening от v0.1.1 (ломает редактор) → однобуквенный
  const legacy2: Hole = {
    id: "lc2", plan: "a", type: "door_penal", group: "doors",
    pc: { x: 300, y: -10 }, width: 80, height: 210, depth: 4, at: 260, opening: "r-l",
    p1: { x: 260, y: -10 }, p2: { x: 340, y: -10 },
  };
  top.holes[legacy2.id] = legacy2;
  updateOpening(model, { wallId: top.id, holeId: legacy2.id, heightMm: 2100 });
  assert.equal(legacy2.opening, "l"); // буква направления (вторая часть "r-l")
  // распашная дверь без opening не дополняется (формат свободный)
  const legacy3: Hole = {
    id: "lc3", plan: "a", type: "single", group: "doors",
    pc: { x: 60, y: -10 }, width: 80, height: 210, depth: 4, at: 20,
    p1: { x: 20, y: -10 }, p2: { x: 100, y: -10 },
  };
  top.holes[legacy3.id] = legacy3;
  updateOpening(model, { wallId: top.id, holeId: legacy3.id, widthMm: 900 });
  assert.equal(legacy3.opening, undefined);
});

test("дверь: casing в update меняет короб, swing меняет открывание", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const h = addOpening(model, { wallId: top.id, type: "door", centerMm: 1000 });
  assert.equal(h.casing, 1);
  updateOpening(model, { wallId: top.id, holeId: h.id, casing: false, swing: { hinge: "end", into: "right" } });
  assert.equal(h.casing, 0);
  assert.equal(h.opening, "r-r");
});

test("лимиты размеров из defs: слишком узкая/широкая/низкая дверь — INVALID_ARGUMENT", () => {
  const model = emptyModel();
  const { top, bottom } = rect(model);
  assert.throws(() => addOpening(model, { wallId: top.id, type: "door", centerMm: 500, widthMm: 400 }), /минимума/);
  assert.throws(() => addOpening(model, { wallId: top.id, type: "door", centerMm: 500, widthMm: 7000 }), /максимума/);
  assert.throws(() => addOpening(model, { wallId: top.id, type: "door_double", centerMm: 700, widthMm: 600 }), /минимума/);
  assert.throws(() => addOpening(model, { wallId: top.id, type: "door", centerMm: 500, heightMm: 900 }), /минимума/);
  assert.throws(() => addOpening(model, { wallId: top.id, type: "door_garage", centerMm: 1500, heightMm: 1500 }), /минимума/);
  assert.throws(() => addOpening(model, { wallId: top.id, type: "door_garage", centerMm: 1500, heightMm: 3500 }), /максимума/);
  // в пределах лимитов — ок
  const h = addOpening(model, { wallId: bottom.id, type: "door_garage", centerMm: 2000, widthMm: 2000, heightMm: 2000 });
  assert.equal(h.width, 200);
});

test("смена типа двери в update по-прежнему запрещена, передача текущего — no-op", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const d = addOpening(model, { wallId: top.id, type: "door", centerMm: 1000 });
  const before = structuredClone(model);
  assert.throws(() => updateOpening(model, { wallId: top.id, holeId: d.id, type: "door_double" }), /смена типа не поддерживается/);
  assert.deepEqual(model, before, "модель не меняется при отказе");
  updateOpening(model, { wallId: top.id, holeId: d.id, type: "door" });
  assert.equal(d.type, "single");
});

test("атомарность: при ошибке валидации кандидат не попадает в модель (снимок до вызова)", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const d = addOpening(model, { wallId: top.id, type: "door", centerMm: 1800 });
  const w = addOpening(model, { wallId: top.id, type: "window", centerMm: 3500 });
  const before = structuredClone(model);
  // неприменимый параметр
  assert.throws(() => updateOpening(model, { wallId: top.id, holeId: d.id, sillOverhangMm: 50 }), /окнам/);
  assert.deepEqual(model, before, "модель не изменилась после INVALID_ARGUMENT");
  // геометрическая ошибка (пересечение с окном) после валидных значений
  assert.throws(() => updateOpening(model, { wallId: top.id, holeId: d.id, widthMm: 2200 }), /пересекает/);
  assert.deepEqual(model, before, "модель не изменилась после GEOMETRY_CONFLICT");
  // лимит размера
  assert.throws(() => updateOpening(model, { wallId: top.id, holeId: d.id, widthMm: 10 }), /минимума/);
  assert.deepEqual(model, before, "модель не изменилась после нарушения лимита");
  void w;
});

test("цепочка update: дверь меняет размеры, положение и открывание последовательно", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const d = addOpening(model, { wallId: top.id, type: "door", centerMm: 1000 });
  updateOpening(model, { wallId: top.id, holeId: d.id, widthMm: 900, heightMm: 2200 });
  assert.equal(d.width, 90);
  assert.equal(d.height, 220);
  updateOpening(model, { wallId: top.id, holeId: d.id, centerMm: 3000 });
  assert.deepEqual(holeRange(top, d), [255, 345]);
  updateOpening(model, { wallId: top.id, holeId: d.id, swing: { hinge: "end", into: "left" } });
  assert.equal(d.opening, "r-l");
  updateOpening(model, { wallId: top.id, holeId: d.id, offsetMm: 100, from: "end" });
  assert.equal(d.at, 310); // угол внутренней грани 400 (ось 420 − полутолщина) − отступ 10 − ширина 90
  // компактное представление отдаёт casing
  const cm = compactModel(model);
  const co = cm.walls.flatMap((w) => w.openings).find((o) => o.id === d.id)!;
  assert.equal(co.casing, 1);
  assert.equal(co.opening, "r-l");
});

// ---------- Совместимость с v0.1.1 (9ae566f) ----------

/**
 * Точный объект, который создаёт addOpening из релиза v0.1.1 (коммит 9ae566f) для двери:
 * логика скопирована из git show 9ae566f:src/model/openings.ts (функция addOpening)
 * дословно для случая двери — без applyWindowFields (тогда его не было).
 */
function legacyAddOpening9ae566f(model: Model, params: {
  wallId: string; type: string; centerMm?: number; widthMm?: number; heightMm?: number;
  swing?: { hinge: "start" | "end"; into: "left" | "right" }; casing?: boolean; leaves?: number;
}): Hole {
  const wall = model.walls[params.wallId]!;
  const kind = OPENING_KINDS[params.type]!;
  const width = mmToCm(params.widthMm ?? kind.widthMm);
  const at = params.centerMm !== undefined ? mmToCm(params.centerMm) - width / 2 : 0;
  const pc = pointAtLength({ p1: wall.p1, p2: wall.p2 }, at + width / 2);
  const holeId = newId(10);
  const hole: Hole = {
    id: holeId,
    plan: wall.plan,
    type: kind.type,
    group: kind.group,
    pc: { x: r2(pc.x), y: r2(pc.y) },
    width: r2(width),
    height: mmToCm(params.heightMm ?? kind.heightMm),
    depth: kind.depthCm,
    at: r2(at),
  };
  const opening = ((): string | undefined => {
    const swing = params.swing;
    if (!swing) return undefined;
    const leaf = swing.into === "left" ? "l" : "r";
    return `${swing.hinge === "end" ? "r" : "l"}-${leaf}`;
  })();
  if (opening) hole.opening = opening;
  if (params.casing !== undefined) hole.casing = params.casing ? 1 : 0;
  if (params.leaves !== undefined) hole.casements = params.leaves;
  const { p1, p2 } = pointsAroundCenter({ p1: wall.p1, p2: wall.p2 }, hole.pc, hole.width / 2);
  hole.p1 = { x: r2(p1.x), y: r2(p1.y) };
  hole.p2 = { x: r2(p2.x), y: r2(p2.y) };
  wall.holes[holeId] = hole;
  return hole;
}

test("legacy v0.1.1 (9ae566f): дверь без новых полей обновляется и двигается", () => {
  const model = emptyModel();
  const { top } = rect(model);
  // объект, созданный выпущенной версией: высота 200 (старый дефолт), нет casing/casements/slope_angle
  const d = legacyAddOpening9ae566f(model, {
    wallId: top.id, type: "door", centerMm: 1000, widthMm: 800, heightMm: 2000,
    swing: { hinge: "start", into: "left" },
  });
  assert.equal(d.height, 200);
  assert.equal(d.casing, undefined);
  assert.equal(d.slope_angle, undefined);
  const snapshot = structuredClone(model);
  // обновление размеров
  updateOpening(model, { wallId: top.id, holeId: d.id, widthMm: 900, heightMm: 2100 });
  assert.equal(d.width, 90);
  assert.equal(d.height, 210);
  // перенос
  updateOpening(model, { wallId: top.id, holeId: d.id, centerMm: 2500 });
  assert.deepEqual(holeRange(top, d), [205, 295]);
  // открывание и короб
  updateOpening(model, { wallId: top.id, holeId: d.id, swing: { hinge: "end", into: "right" }, casing: false });
  assert.equal(d.opening, "r-r");
  assert.equal(d.casing, 0);
  // удаление работает
  deleteOpening(model, top.id, d.id);
  assert.equal(top.holes[d.id], undefined);
  void snapshot;
});

test("legacy v0.1.1 (9ae566f): у legacy-двери, не тронутой update, ничего не добавляется", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const d = legacyAddOpening9ae566f(model, { wallId: top.id, type: "door", centerMm: 1000, heightMm: 2000 });
  const before = structuredClone(d);
  // чужой проём обновляется — legacy-дверь не меняется
  const w = addOpening(model, { wallId: top.id, type: "window", centerMm: 3000 });
  updateOpening(model, { wallId: top.id, holeId: w.id, widthMm: 1300 });
  assert.deepEqual(d, before, "legacy-дверь без явного update не дополняется новыми полями");
  assert.equal(d.casing, undefined);
  assert.equal(d.casements, undefined);
  assert.equal(d.slope_angle, undefined);
});

// ---------- Регрессия окон (этап 25) ----------

test("регрессия окон: window/windoor/window_door создаются с полями этапа 25", () => {
  const model = emptyModel();
  const { top, bottom } = rect(model);
  const w = addOpening(model, { wallId: top.id, type: "window", centerMm: 1000 });
  assert.equal(w.type, "window");
  assert.equal(w.depth, 6);
  assert.equal(w.floor_height, 85);
  assert.equal(w.opening, "r-l");
  assert.deepEqual(w.sill, { thinkness: 4, overhang: 0, overmeasure: 0, side: "l" });
  const wd = addOpening(model, { wallId: top.id, type: "window_balcony", centerMm: 3000 });
  assert.equal(wd.type, "windoor");
  assert.equal(wd.height, undefined);
  assert.equal(wd.window_width, 100);
  assert.equal(wd.door_width, 80);
  const bd = addOpening(model, { wallId: bottom.id, type: "window_door", centerMm: 1000 });
  assert.equal(bd.impost_offset, 75);
  // окна по-прежнему принимают sill_height_mm, двери — нет
  const w2 = addOpening(model, { wallId: bottom.id, type: "window", centerMm: 3000, sillHeightMm: 900 });
  assert.equal(w2.floor_height, 90);
});
