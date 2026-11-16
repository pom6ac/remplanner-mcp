// Этап 41 «Несущая колонна»: структурная сверка с эталонами UI (ui-ref-pillar-*.json),
// дефолты и лимиты defs, атомарность, цепочки update, удаление, проверки model_validate.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, Pillar } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addPillar, updatePillar, deletePillar, assertPillarInvariants, PILLAR_DEFS } from "../../src/model/pillars.ts";
import { validateModel } from "../../src/model/validate.ts";
import { compactModel } from "../../src/model/compact.ts";
import { addOpening } from "../../src/model/openings.ts";

const here = dirname(fileURLToPath(import.meta.url));

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {} };
}

function room(x0: number, y0: number, x1: number, y1: number): import("../../src/model/items.ts").RoomPolygon {
  return {
    roomId: null,
    polygon: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    areaCm2: (x1 - x0) * (y1 - y0),
    axisAreaCm2: null,
  };
}

/** Комната 4000×3000 (внутренние грани), как в anon-rect фикстуре (origin — внутренний угол). */
const ROOM = room(0, 0, 400, 300);
/** Полигон под эталон ui-ref-pillar-free (колонна в точке (582.71, 462.53)). */
const ROOM_FREE = room(550, 430, 610, 490);
/** Полигон под тесты примыкания (колонна и стена-эталон в точке x≈450). */
const ROOM_ATTACH = room(0, 0, 600, 300);

function roomModel(): { model: Model; top: Model["walls"][string] } {
  const model = emptyModel();
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  return { model, top: walls[0]! };
}

type Ref = {
  menu_title: string;
  catalog_key: string;
  defaults_defs_cm: Record<string, number>;
  model_object: Pillar;
};

function loadRef(name: string): Ref {
  return JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-pillar-${name}.json`), "utf8")) as Ref;
}

const FREE = loadRef("free");
const WALL_REF = loadRef("wall");

/** Стена-эталон примыкания: горизонтальная ось y=100.5, толщина 25 (грани y=88 и y=113). */
function attachWall(model: Model): void {
  model.walls["w_ref"] = {
    id: "w_ref", plan: "a", role: "wall", depth: 25, height: 270, material: "a_block",
    p1: { x: 32.7, y: 100.5 }, p2: { x: 523.7, y: 100.5 }, holes: {},
  };
}

/** Сверка колонны с эталоном по семантическим ключам (в обе стороны, ревью 38 R2). */
function expectStructural(pillar: Pillar, et: Pillar, label: string) {
  const SERVICE = new Set(["id", "pc", "p1", "p2", "p3", "p4"]);
  // позиция: UI магнитится к направляющим (клик ≠ центр эталона), поэтому сверяем
  // геометрию ОТНОСИТЕЛЬНО центра, а не абсолютные координаты
  const rel = (p: { x: number; y: number }, c: { x: number; y: number }) =>
    [Math.round((p.x - c.x) * 100) / 100, Math.round((p.y - c.y) * 100) / 100];
  const etCorners = [et.p1, et.p2, et.p3, et.p4].map((p) => rel(p, et.pc));
  const gotCorners = [pillar.p1, pillar.p2, pillar.p3, pillar.p4].map((p) => rel(p, pillar.pc));
  assert.deepEqual(gotCorners, etCorners, `${label}: углы относительно центра`);
  for (const f of Object.keys(et)) {
    if (SERVICE.has(f) || f === "pc" || f === "p1" || f === "p2" || f === "p3" || f === "p4") continue;
    if (f === "edges") {
      // координаты граней редактор пересчитывает при restore (fixPoint даёт 472.529 и
      // т.п.) — сверяем структуру: стороны, порядок и признак no_wall
      assert.deepEqual((pillar.edges ?? []).map((e) => e.side), (et.edges ?? []).map((e) => e.side), `${label}: стороны граней`);
      assert.deepEqual((pillar.edges ?? []).map((e) => e.no_wall ?? null), (et.edges ?? []).map((e) => e.no_wall ?? null), `${label}: no_wall граней`);
      continue;
    }
    if (f === "eds") {
      // eds: пересчитывается редактором при restore; сверяем наличие примыканий и wall.balc
      const got = (pillar.eds ?? {}) as Record<string, { wall?: { balc?: boolean } }>;
      const want = (et.eds ?? {}) as Record<string, { wall?: { balc?: boolean } }>;
      assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${label}: примыкания eds`);
      for (const side of Object.keys(want)) {
        assert.equal(got[side]?.wall?.balc, want[side]!.wall?.balc, `${label}: eds.${side}.wall.balc`);
      }
      continue;
    }
    assert.deepEqual(pillar[f], et[f], `${label}: поле ${f}`);
  }
  // обратная сторона: у кандидата нет полей вне эталона
  for (const f of Object.keys(pillar)) {
    assert.ok(f in et || SERVICE.has(f), `${label}: лишнее поле ${f} вне эталона`);
  }
}

test("pillar_add: свободная колонна совпадает с эталоном ui-ref-pillar-free", () => {
  const { model } = roomModel();
  model.total_height = 310; // эталон снят в проекте с потолком 310
  const et = FREE.model_object;
  const pillar = addPillar(model, {
    center: { x: et.pc.x * 10, y: et.pc.y * 10 }, // 0.1 мм — точность модели
  }, [ROOM_FREE]);
  expectStructural(pillar, et, "free");
});

test("pillar_add: колонна у стены совпадает с эталоном ui-ref-pillar-wall (грань b на грани стены)", () => {
  const { model } = roomModel();
  model.total_height = 310; // эталон снят в проекте с потолком 310
  attachWall(model);
  const et = WALL_REF.model_object;
  const pillar = addPillar(model, {
    center: { x: et.pc.x * 10, y: et.pc.y * 10 }, // 0.1 мм — точность модели
  }, [ROOM_ATTACH]);
  expectStructural(pillar, et, "wall");
});

test("pillar_add: дефолты 20×20 см, умолчания defs из эталона", () => {
  const { model } = roomModel();
  const pillar = addPillar(model, { center: { x: 2000, y: 1500 } }, [ROOM]);
  assert.equal(pillar.width, FREE.defaults_defs_cm.width);
  assert.equal(pillar.height, FREE.defaults_defs_cm.height);
  assert.equal(pillar.plan, "a");
  assert.equal(pillar.role, "pillar");
  assert.equal(pillar.angle, 0);
  assert.equal(pillar.f0offset, 0);
  assert.equal(pillar.show_dls, true);
  assert.equal(pillar.total_height, model.total_height);
  assert.equal(pillar.edges?.length, 4);
  assert.deepEqual(pillar.edges?.map((e) => e.side), ["t", "r", "b", "l"]);
});

test("pillar_add: нестандартные габариты и поворот (мм→см только явно переданных)", () => {
  const { model } = roomModel();
  const pillar = addPillar(model, {
    center: { x: 2000, y: 1500 }, widthMm: 300, heightMm: 400, angleDeg: 30,
  }, [ROOM]);
  assert.equal(pillar.width, 30);
  assert.equal(pillar.height, 40);
  assert.equal(pillar.angle, 30);
  // углы согласованы с pc: p1 и p3 симметричны относительно центра
  assert.ok(Math.abs((pillar.p1.x + pillar.p3.x) / 2 - pillar.pc.x) < 0.02);
  assert.ok(Math.abs((pillar.p1.y + pillar.p3.y) / 2 - pillar.pc.y) < 0.02);
});

test("pillar_add: прижатие к грани стены в пределах 30 мм (как в UI)", () => {
  const { model } = roomModel();
  attachWall(model);
  // центр в 20 мм от грани y=88: колонна 20×20, поставлена на 2 см выше грани
  const pillar = addPillar(model, { center: { x: 4520, y: 760 } }, [ROOM_ATTACH]);
  assert.equal(pillar.p3.y, 88); // грань b легла точно на грань стены
  assert.equal(pillar.inRoom, 0);
  assert.ok((pillar.eds as Record<string, unknown>)["b"], "eds.b записан");
});

test("pillar_add: лимиты defs — ширина 100..20000 мм, глубина 100..6000 мм", () => {
  const { model } = roomModel();
  assert.equal(PILLAR_DEFS.widthMinCm * 10, 100);
  assert.equal(PILLAR_DEFS.widthMaxCm * 10, 20000);
  assert.equal(PILLAR_DEFS.heightMinCm * 10, 100);
  assert.equal(PILLAR_DEFS.heightMaxCm * 10, 6000);
  assert.throws(() => addPillar(model, { center: { x: 2000, y: 1500 }, widthMm: 90 }, [ROOM]), /меньше минимума/);
  assert.throws(() => addPillar(model, { center: { x: 2000, y: 1500 }, widthMm: 20100 }, [ROOM]), /больше максимума/);
  assert.throws(() => addPillar(model, { center: { x: 2000, y: 1500 }, heightMm: 50 }, [ROOM]), /меньше минимума/);
  assert.throws(() => addPillar(model, { center: { x: 2000, y: 1500 }, heightMm: 6100 }, [ROOM]), /больше максимума/);
});

test("pillar_add: атомарность — ошибка не меняет модель (снимок до вызова)", () => {
  const { model } = roomModel();
  const snapshot = JSON.stringify(model);
  // вне комнаты
  assert.throws(() => addPillar(model, { center: { x: 5000, y: 1500 } }, [ROOM]), /вне помещений/);
  // пересекает стену
  assert.throws(() => addPillar(model, { center: { x: 2000, y: 50 } }, [ROOM]), /пересекает стену/);
  // неконечные входы
  assert.throws(() => addPillar(model, { center: { x: 2000, y: 1500 }, widthMm: NaN }), /конечным числом/);
  assert.throws(() => addPillar(model, { center: { x: 2000, y: 1500 }, widthMm: Infinity }), /конечным числом/);
  assert.equal(JSON.stringify(model), snapshot, "модель не изменилась");
});

test("pillar_update: цепочка — перенос, габариты, поворот; неуказанные поля не меняются", () => {
  const { model } = roomModel();
  const p = addPillar(model, { center: { x: 2000, y: 1500 } }, [ROOM]);
  updatePillar(model, { pillarId: p.id, center: { x: 2500, y: 1200 } }, [ROOM]);
  assert.deepEqual(p.pc, { x: 250, y: 120 });
  assert.equal(p.width, 20);
  updatePillar(model, { pillarId: p.id, widthMm: 300 }, [ROOM]);
  assert.equal(p.width, 30);
  assert.equal(p.height, 20);
  updatePillar(model, { pillarId: p.id, angleDeg: 15 }, [ROOM]);
  assert.equal(p.angle, 15);
  assert.equal(p.height, 20);
  assert.ok(Math.abs((p.p1.x + p.p3.x) / 2 - p.pc.x) < 0.02, "углы пересчитаны");
  assert.ok(Math.abs((p.p1.y + p.p3.y) / 2 - p.pc.y) < 0.02, "углы пересчитаны");
});

test("pillar_update: конфликт при переносе — GEOMETRY_CONFLICT, модель не меняется", () => {
  const { model } = roomModel();
  const p = addPillar(model, { center: { x: 2000, y: 1500 } }, [ROOM]);
  const snapshot = JSON.stringify(p);
  assert.throws(() => updatePillar(model, { pillarId: p.id, center: { x: 2000, y: 50 } }, [ROOM]), /пересекает стену/);
  assert.equal(JSON.stringify(p), snapshot, "колонна не изменилась");
});

test("pillar_update: несуществующая колонна — NOT_FOUND", () => {
  const { model } = roomModel();
  assert.throws(() => updatePillar(model, { pillarId: "nope", widthMm: 300 }), /не найдена/);
});

test("pillar_delete: удаляет колонну; повторно — NOT_FOUND", () => {
  const { model } = roomModel();
  const p = addPillar(model, { center: { x: 2000, y: 1500 } }, [ROOM]);
  deletePillar(model, p.id);
  assert.equal(Object.keys(model.pillars).length, 0);
  assert.throws(() => deletePillar(model, p.id), /не найдена/);
});

test("pillar_add: две пересекающиеся колонны — GEOMETRY_CONFLICT", () => {
  const { model } = roomModel();
  addPillar(model, { center: { x: 2000, y: 1500 } }, [ROOM]);
  assert.throws(() => addPillar(model, { center: { x: 2050, y: 1500 } }, [ROOM]), /другую колонну/);
});

test("model_validate: пересечение со стеной, между колоннами и вне комнат", () => {
  const { model } = roomModel();
  // коллизия со стеной
  model.pillars["p_bad"] = {
    id: "p_bad", plan: "a", role: "pillar", width: 20, height: 20, total_height: 270, angle: 0,
    f0offset: 0, pc: { x: 200, y: -5 }, p1: { x: 190, y: -15 }, p2: { x: 210, y: -15 },
    p3: { x: 210, y: 5 }, p4: { x: 190, y: 5 }, show_dls: true,
  };
  let problems = validateModel(model, [ROOM]);
  assert.ok(problems.some((x) => x.code === "PILLAR_INTERSECTS_WALL"), JSON.stringify(problems));
  // вне комнат
  delete model.pillars["p_bad"];
  model.pillars["p_out"] = {
    id: "p_out", plan: "a", role: "pillar", width: 20, height: 20, total_height: 270, angle: 0,
    f0offset: 0, pc: { x: 500, y: 150 }, p1: { x: 490, y: 140 }, p2: { x: 510, y: 140 },
    p3: { x: 510, y: 160 }, p4: { x: 490, y: 160 }, show_dls: true,
  };
  problems = validateModel(model, [ROOM]);
  assert.ok(problems.some((x) => x.code === "PILLAR_OUTSIDE_ROOM"));
  // пересечение колонн
  delete model.pillars["p_out"];
  model.pillars["p1x"] = {
    id: "p1x", plan: "a", role: "pillar", width: 20, height: 20, total_height: 270, angle: 0,
    f0offset: 0, pc: { x: 200, y: 150 }, p1: { x: 190, y: 140 }, p2: { x: 210, y: 140 },
    p3: { x: 210, y: 160 }, p4: { x: 190, y: 160 }, show_dls: true,
  };
  model.pillars["p2x"] = {
    id: "p2x", plan: "a", role: "pillar", width: 20, height: 20, total_height: 270, angle: 0,
    f0offset: 0, pc: { x: 205, y: 150 }, p1: { x: 195, y: 140 }, p2: { x: 215, y: 140 },
    p3: { x: 215, y: 160 }, p4: { x: 195, y: 160 }, show_dls: true,
  };
  problems = validateModel(model, [ROOM]);
  assert.ok(problems.some((x) => x.code === "PILLARS_OVERLAP"));
  // касание грани стены — не ошибка (колонна вплотную к внутренней грани y=10)
  delete model.pillars["p2x"];
  model.pillars["p1x"].pc = { x: 200, y: 10 };
  model.pillars["p1x"].p1 = { x: 190, y: 0 };
  model.pillars["p1x"].p2 = { x: 210, y: 0 };
  model.pillars["p1x"].p3 = { x: 210, y: 20 };
  model.pillars["p1x"].p4 = { x: 190, y: 20 };
  problems = validateModel(model, [ROOM]);
  assert.equal(problems.filter((x) => x.code.startsWith("PILLAR")).length, 0, JSON.stringify(problems));
});

test("compactModel: колонны в компактном виде с метками P<n> (в обе стороны с эталоном)", () => {
  const { model } = roomModel();
  const et = FREE.model_object;
  const key = "p_et";
  model.pillars[key] = structuredClone(et);
  model.pillars[key]!.id = key;
  const compact = compactModel(model);
  assert.equal(compact.pillars.length, 1);
  const c = compact.pillars[0]!;
  assert.equal(c.id, "P1");
  assert.equal(c.site_id, key);
  assert.equal(c.width_mm, et.width * 10);
  assert.equal(c.depth_mm, et.height * 10);
  assert.equal(c.angle_deg, et.angle);
  assert.equal(c.total_height_mm, (et.total_height ?? 270) * 10);
});

test("инварианты: неконечная геометрия кандидата — INTERNAL, модель не меняется", () => {
  const { model } = roomModel();
  const broken = {
    id: "p_nan", plan: "a", role: "pillar" as const, width: NaN, height: 20, total_height: 270,
    angle: 0, f0offset: 0, pc: { x: 200, y: 150 }, p1: { x: 190, y: 140 }, p2: { x: 210, y: 140 },
    p3: { x: 210, y: 160 }, p4: { x: 190, y: 160 }, show_dls: true,
  };
  assert.throws(() => assertPillarInvariants(broken, model, [ROOM]), /неконечная геометрия колонны/);
});

test("регрессия: колонна не мешает стенам и проёмам (addOpening после колонны)", () => {
  const { model } = roomModel();
  addPillar(model, { center: { x: 2000, y: 1500 } }, [ROOM]);
  const walls = addRoomRect(model, { origin: { x: 5000, y: 0 }, widthMm: 3000, depthMm: 3000, thicknessMm: 200 });
  const hole = addOpening(model, { wallId: walls[0]!.id, type: "window", widthMm: 1200, centerMm: 1500 });
  assert.equal(hole.width, 120);
  const problems = validateModel(model, [ROOM]);
  assert.equal(problems.length, 0, JSON.stringify(problems));
});
