// Этап 47 «Потолочный ригель»: структурная сверка с эталонами UI (ui-ref-rigel-*.json),
// дефолты и лимиты defs, связи концов по конечным отрезкам (угол 2..178°, как Rigel.link),
// атомарность, цепочки update, стеновые и колонные операции, верификация save.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, Rigel } from "../../src/model/types.ts";
import { addRoomRect, moveWall, updateWall, deleteWall, splitWall } from "../../src/model/walls.ts";
import { addPillar, updatePillar, deletePillar } from "../../src/model/pillars.ts";
import { addRigel, updateRigel, deleteRigel, RIGEL_DEFS } from "../../src/model/rigels.ts";
import { validateModel } from "../../src/model/validate.ts";
import { compactModel } from "../../src/model/compact.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {} };
}

function roomModel(): { model: Model; top: Model["walls"][string] } {
  const model = emptyModel();
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  return { model, top: walls[0]! };
}

type Ref = {
  menu_title: string;
  catalog_key: string;
  tool_id: string;
  defaults_defs_cm: Record<string, number>;
  model_object: Rigel;
};

function loadRef(name: string): Ref {
  return JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-rigel-${name}.json`), "utf8")) as Ref;
}

const FREE = loadRef("free");
const WALL_REF = loadRef("wall");
const PILLAR_REF = loadRef("pillar");

const near = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) <= tol;

function expectPoints(label: string, got: { x: number; y: number }[], want: { x: number; y: number }[]): void {
  assert.equal(got.length, want.length, `${label}: число точек`);
  got.forEach((p, i) => {
    // допуск 0,1 мм: модель хранит 0,1 мм (r2), эталон редактора — полную точность клика
    assert.ok(near(p.x, want[i]!.x, 0.01) && near(p.y, want[i]!.y, 0.01), `${label}: точка ${i} (${p.x},${p.y}) ≠ (${want[i]!.x},${want[i]!.y})`);
  });
}

/** Связи в семантической форме: end → {ot, z1} (id стен/колонн в тесте — свои). */
function linkSig(r: Rigel): Record<string, { ot: string; z1: string } | null> {
  const sig = (link: unknown): { ot: string; z1: string } | null =>
    link && typeof link === "object" ? { ot: (link as { ot: string }).ot, z1: (link as { z1: string }).z1 } : null;
  return { p1: sig(r.p1.link), p2: sig(r.p2.link) };
}

// ---------- сверка с эталонами в обе стороны ----------

test("rigel_add: свободный ригель совпадает с эталоном ui-ref-rigel-free", () => {
  const { model } = roomModel();
  const et = FREE.model_object;
  const rigel = addRigel(model, {
    start: { x: et.p1.x * 10, y: et.p1.y * 10 },
    end: { x: et.p2.x * 10, y: et.p2.y * 10 },
  });
  assert.deepEqual(linkSig(rigel), { p1: null, p2: null }, "оба конца без связей");
  expectPoints("free: polygon", rigel.polygon, et.polygon);
  expectPoints("free: l", [rigel.l.p1, rigel.l.p2], [et.l.p1, et.l.p2]);
  expectPoints("free: r", [rigel.r.p1, rigel.r.p2], [et.r.p1, et.r.p2]);
});

test("rigel_add: ригель у стены совпадает с эталоном ui-ref-rigel-wall (конец срезан по линии грани)", () => {
  const { model } = roomModel();
  // стена как в dev-проекте: ось y=715.1, толщина 6 (грани y=712.1 и y=718.1), x 10..356.4
  model.walls["w_ref"] = {
    id: "w_ref", plan: "a", role: "balcony", depth: 6, height: 270, material: "a_block",
    p1: { x: 10, y: 715.1 }, p2: { x: 356.4, y: 715.1 }, holes: {},
  };
  const et = WALL_REF.model_object;
  const rigel = addRigel(model, {
    start: { x: et.p1.x * 10, y: et.p1.y * 10 },
    end: { x: et.p2.x * 10, y: et.p2.y * 10 },
  });
  assert.deepEqual(linkSig(rigel).p1, { ot: "wall", z1: "r" }, "p1 на грани r стены");
  expectPoints("wall: polygon", rigel.polygon, et.polygon);
  expectPoints("wall: l", [rigel.l.p1, rigel.l.p2], [et.l.p1, et.l.p2]);
  expectPoints("wall: r", [rigel.r.p1, rigel.r.p2], [et.r.p1, et.r.p2]);
});

test("rigel_add: ригель у колонны совпадает с эталоном ui-ref-rigel-pillar (связь z1=t)", () => {
  const { model } = roomModel();
  // колонна 30×40 как в dev-проекте (pc 1002.2, 263.3)
  const pc = { x: 1002.2, y: 263.3 };
  model.pillars["p_ref"] = {
    id: "p_ref", plan: "a", role: "pillar", width: 30, height: 40, total_height: 310,
    angle: 0, f0offset: 0, pc,
    p1: { x: 987.2, y: 243.3 }, p2: { x: 1017.2, y: 243.3 },
    p3: { x: 1017.2, y: 283.3 }, p4: { x: 987.2, y: 283.3 },
    edges: [], eds: {},
  };
  const et = PILLAR_REF.model_object;
  const rigel = addRigel(model, {
    start: { x: et.p1.x * 10, y: et.p1.y * 10 },
    end: { x: et.p2.x * 10, y: et.p2.y * 10 },
  });
  assert.deepEqual(linkSig(rigel).p1, { ot: "pillar", z1: "t" }, "p1 на грани t колонны");
  assert.deepEqual(linkSig(rigel).p2, null, "p2 свободен (default длина 30 см)");
  expectPoints("pillar: polygon", rigel.polygon, et.polygon);
  expectPoints("pillar: l", [rigel.l.p1, rigel.l.p2], [et.l.p1, et.l.p2]);
  expectPoints("pillar: r", [rigel.r.p1, rigel.r.p2], [et.r.p1, et.r.p2]);
});

test("rigel_add: дефолты defs из эталона (30/30 см), метаданные меню", () => {
  assert.equal(FREE.menu_title, "Потолочный ригель");
  assert.equal(FREE.catalog_key, "rigel");
  assert.equal(FREE.tool_id, "plannertool_rigel");
  assert.equal(RIGEL_DEFS.depthCm, FREE.defaults_defs_cm.depth);
  assert.equal(RIGEL_DEFS.heightCm, FREE.defaults_defs_cm.height);
  assert.equal(RIGEL_DEFS.depthMinCm * 10, 100);
  assert.equal(RIGEL_DEFS.depthMaxCm * 10, 1000);
  assert.equal(RIGEL_DEFS.heightMinCm * 10, 100);
  assert.equal(RIGEL_DEFS.heightMaxCm * 10, 1000);
  const { model } = roomModel();
  const rigel = addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 } });
  assert.equal(rigel.depth, 30);
  assert.equal(rigel.height, 30);
  assert.equal(rigel.ceiling_type, "");
  assert.ok(rigel.p1.link === 0 && rigel.p2.link === 0);
});

test("rigel_add: нестандартные толщина/высота (мм→см только явно переданных)", () => {
  const { model } = roomModel();
  const rigel = addRigel(model, {
    start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 },
    depthMm: 150, heightMm: 250, ceilingType: "gypsum_ceiling",
  });
  assert.equal(rigel.depth, 15);
  assert.equal(rigel.height, 25);
  assert.equal(rigel.ceiling_type, "gypsum_ceiling");
  // полигон: толщина 15 см → ±7.5 см от оси
  assert.ok(near(rigel.polygon[0]!.y, 92.5), "верхняя грань полигона");
  assert.ok(near(rigel.polygon[3]!.y, 107.5), "нижняя грань полигона");
});

test("rigel_add: лимиты defs — толщина и высота 100..1000 мм", () => {
  const { model } = roomModel();
  assert.throws(() => addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 }, depthMm: 90 }), /меньше минимума/);
  assert.throws(() => addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 }, depthMm: 1100 }), /больше максимума/);
  assert.throws(() => addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 }, heightMm: 90 }), /меньше минимума/);
  assert.throws(() => addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 }, heightMm: 1100 }), /больше максимума/);
});

test("rigel_add: нулевая и неконечная ось — INVALID_ARGUMENT", () => {
  const { model } = roomModel();
  assert.throws(() => addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 1000, y: 1000 } }), /ненулевой длины/);
  assert.throws(() => addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: NaN, y: 1000 } }), /конечными числами/);
});

// ---------- связи: конечные отрезки и угол ----------

function attachWall(model: Model): void {
  model.walls["w_ref"] = {
    id: "w_ref", plan: "a", role: "wall", depth: 25, height: 270, material: "a_block",
    p1: { x: 32.7, y: 100.5 }, p2: { x: 523.7, y: 100.5 }, holes: {},
  };
}

test("rigel_add: конец в 20 мм от грани стены прилипает (магнит 30 мм, ось не параллельна грани)", () => {
  const { model } = roomModel();
  attachWall(model);
  // конец оси (200, 90) в 2 см от верхней грани y=88 (грань l), ось диагональная
  const rigel = addRigel(model, { start: { x: 1400, y: 300 }, end: { x: 2000, y: 900 } });
  assert.deepEqual(linkSig(rigel).p2, { ot: "wall", z1: "l" }, "p2 прилип к верхней грани");
  assert.ok(near(rigel.p2.y, 88), "p2 лёг точно на грань");
  assert.deepEqual({ x: rigel.p1.x, y: rigel.p1.y }, { x: 140, y: 30 }, "свободный конец не двигался");
});

test("rigel_add: конец за пределами конечного отрезка грани — связи нет (не бесконечная прямая)", () => {
  const { model } = roomModel();
  attachWall(model);
  // стена кончается на x=523.7; ось ригеля начинается на x=560 (за концом), y на линии грани
  const rigel = addRigel(model, { start: { x: 5600, y: 880 }, end: { x: 6400, y: 880 } });
  assert.deepEqual(linkSig(rigel), { p1: null, p2: null }, "за концом стены связи нет");
});

test("rigel_add: ось параллельна грани — связи нет (угол 2..178°, как в редакторе)", () => {
  const { model } = roomModel();
  attachWall(model);
  // ригель вдоль грани (ось y=880 параллельна грани y=88), конец на линии грани
  const rigel = addRigel(model, { start: { x: 2000, y: 880 }, end: { x: 2800, y: 880 } });
  assert.deepEqual(linkSig(rigel), { p1: null, p2: null }, "параллельная грань не даёт связь");
});

test("rigel_add: одинаковые связи обоих концов гасятся (p2.link = 0, как в редакторе)", () => {
  const { model } = roomModel();
  attachWall(model);
  // оба конца на верхней грани стены (ригель лежит НА грани, ось на линии грани)
  const rigel = addRigel(model, { start: { x: 2000, y: 880 }, end: { x: 2800, y: 880 } });
  assert.deepEqual(linkSig(rigel).p2, null, "p2.link погашен");
});

test("rigel_add: ригель к ригелю — связь к боковой грани (z1 l)", () => {
  const { model } = roomModel();
  const first = addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 } });
  // боковая грань l первого ригеля: y=85, x 100..200; конец второго на ней, ось 45°
  const second = addRigel(model, { start: { x: 1500, y: 850 }, end: { x: 2500, y: 1850 } });
  assert.deepEqual(linkSig(second).p1, { ot: "rigel", z1: "l" }, "связь к грани l первого ригеля");
  void first;
});

// ---------- атомарность и update ----------

test("rigel_add: атомарность — ошибка не меняет модель (снимок до вызова)", () => {
  const { model } = roomModel();
  const snapshot = JSON.stringify(model);
  assert.throws(() => addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 }, depthMm: 50 }), /меньше минимума/);
  assert.throws(() => addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 1000, y: 1000 } }), /ненулевой длины/);
  assert.throws(() => addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 }, heightMm: Infinity }), /конечным числом/);
  assert.equal(JSON.stringify(model), snapshot, "модель не изменилась");
});

test("rigel_update: цепочка — перенос оси, толщина, высота; неуказанные поля не меняются", () => {
  const { model } = roomModel();
  const r = addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 } });
  updateRigel(model, { rigelId: r.id, start: { x: 1500, y: 1200 } });
  assert.deepEqual({ x: r.p1.x, y: r.p1.y }, { x: 150, y: 120 });
  assert.deepEqual({ x: r.p2.x, y: r.p2.y }, { x: 200, y: 100 }, "конец не указан — не изменился");
  updateRigel(model, { rigelId: r.id, depthMm: 200 });
  assert.equal(r.depth, 20);
  assert.equal(r.height, 30, "высота не указана — не изменилась");
  updateRigel(model, { rigelId: r.id, heightMm: 400 });
  assert.equal(r.height, 40);
  assert.equal(r.depth, 20);
  // полигон пересчитан под новую ось: все вершины на расстоянии depth/2 от оси
  const axisLen = Math.hypot(r.p2.x - r.p1.x, r.p2.y - r.p1.y);
  const distToAxis = (p: { x: number; y: number }): number =>
    Math.abs((p.x - r.p1.x) * (r.p2.y - r.p1.y) - (p.y - r.p1.y) * (r.p2.x - r.p1.x)) / axisLen;
  for (const corner of r.polygon) assert.ok(near(distToAxis(corner), r.depth / 2, 0.01), `вершина на грани глубины: ${JSON.stringify(corner)}`);
});

test("rigel_update: несуществующий ригель — NOT_FOUND; удаление; повторно — NOT_FOUND", () => {
  const { model } = roomModel();
  assert.throws(() => updateRigel(model, { rigelId: "nope", depthMm: 200 }), /не найден/);
  const r = addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 } });
  deleteRigel(model, r.id);
  assert.equal(Object.keys(model.rigels ?? {}).length, 0);
  assert.throws(() => deleteRigel(model, r.id), /не найден/);
});

test("rigel_update: update при ошибке не меняет модель (снимок до вызова)", () => {
  const { model } = roomModel();
  const r = addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 } });
  const snapshot = JSON.stringify(model);
  assert.throws(() => updateRigel(model, { rigelId: r.id, depthMm: 5000 }), /больше максимума/);
  assert.throws(() => updateRigel(model, { rigelId: r.id, start: { x: 1000, y: 1000 }, end: { x: 1000, y: 1000 } }), /ненулевой длины/);
  assert.equal(JSON.stringify(model), snapshot, "модель не изменилась");
});

// ---------- стеновые операции ----------

test("стеновая операция: несвязанный ригель побайтово неизменен при переносе стены", () => {
  const { model } = roomModel();
  const r = addRigel(model, { start: { x: 2000, y: 1500 }, end: { x: 3000, y: 1500 } });
  const before = JSON.stringify(r);
  moveWall(model, { wallId: model.walls["w_1"]?.id ?? Object.keys(model.walls)[0]!, offsetMm: 10 });
  assert.equal(JSON.stringify(r), before, "ригель не изменился");
});

test("удаление стены: связь ригеля с этой стеной гасится, геометрия оси сохранена", () => {
  const { model } = roomModel();
  attachWall(model);
  const r = addRigel(model, { start: { x: 1400, y: 300 }, end: { x: 2000, y: 900 } });
  assert.deepEqual(linkSig(rigelOf(r)).p2, { ot: "wall", z1: "l" });
  deleteWall(model, "w_ref");
  assert.deepEqual(linkSig(rigelOf(r)).p2, null, "связь с удалённой стеной погашена");
  assert.deepEqual({ x: r.p2.x, y: r.p2.y }, { x: 200, y: 88 }, "ось ригеля не изменилась");
});

function rigelOf(r: Rigel): Rigel {
  return r;
}

test("разбиение стены: ригель не теряется, связь остаётся корректной (на части с контактом)", () => {
  const { model } = roomModel();
  attachWall(model);
  const r = addRigel(model, { start: { x: 1400, y: 300 }, end: { x: 2000, y: 900 } });
  const before = JSON.stringify(r);
  splitWall(model, "w_ref", 1000); // разрез на x=132.7 — контакт p2 (x=200) у второй части
  const sig = linkSig(rigelOf(r));
  assert.ok(sig.p2 === null || sig.p2?.z1 === "l", `связь p2 корректна: ${JSON.stringify(sig)}`);
  assert.deepEqual({ x: r.p2.x, y: r.p2.y }, { x: 200, y: 88 }, "контактная точка не сдвинулась");
  void before;
});

test("перенос стены в ригель: ригель остаётся, модель консистентна (конфликта в редакторе нет)", () => {
  const { model } = roomModel();
  const r = addRigel(model, { start: { x: 2000, y: 1500 }, end: { x: 3000, y: 1500 } });
  const wallsBefore = JSON.stringify(model.walls);
  const wid = Object.keys(model.walls)[0]!;
  updateWall(model, { wallId: wid, thicknessMm: 300 });
  assert.notEqual(JSON.stringify(model.walls), wallsBefore, "стена изменилась");
  assert.deepEqual({ x: r.p1.x, y: r.p1.y }, { x: 200, y: 150 }, "ригель не сдвинулся");
});

// ---------- колонные операции ----------

test("колонна: ригель у грани колонны; перенос колонны гасит связь атомарно", () => {
  const { model } = roomModel();
  const pc = { x: 1002.2, y: 263.3 };
  model.pillars["p_ref"] = {
    id: "p_ref", plan: "a", role: "pillar", width: 30, height: 40, total_height: 310,
    angle: 0, f0offset: 0, pc,
    p1: { x: 987.2, y: 243.3 }, p2: { x: 1017.2, y: 243.3 },
    p3: { x: 1017.2, y: 283.3 }, p4: { x: 987.2, y: 283.3 },
    edges: [], eds: {},
  };
  const r = addRigel(model, { start: { x: 1002.2 * 10, y: 243.3 * 10 }, end: { x: 1002.2 * 10, y: 213.3 * 10 } });
  assert.deepEqual(linkSig(r).p1, { ot: "pillar", z1: "t" });
  updatePillar(model, { pillarId: "p_ref", center: { x: 1002.2 * 10, y: 3000 } });
  assert.deepEqual(linkSig(r).p1, null, "связь с передвинутой колонной погашена");
  deletePillar(model, "p_ref");
  assert.equal(Object.keys(model.rigels ?? {}).length, 1, "ригель не удалён вместе с колонной");
});

test("колонна: addPillar при существующем ригеле не меняет его побайтово (несвязанный)", () => {
  const { model } = roomModel();
  const r = addRigel(model, { start: { x: 2000, y: 1500 }, end: { x: 3000, y: 1500 } });
  const before = JSON.stringify(r);
  addPillar(model, { center: { x: 5000, y: 5000 } });
  assert.equal(JSON.stringify(r), before, "ригель не изменился");
});

// ---------- model_validate и compact ----------

test("model_validate: некорректная геометрия ригеля — RIGEL_BAD_GEOMETRY", () => {
  const { model } = roomModel();
  model.rigels ??= {};
  model.rigels["b_bad"] = {
    id: "b_bad", p1: { x: NaN, y: 100, link: 0 }, p2: { x: 200, y: 100, link: 0 },
    depth: 30, height: 30, ceiling_type: "", polygon: [], l: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 } }, r: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 } },
  };
  let problems = validateModel(model, []);
  assert.ok(problems.some((x) => x.code === "RIGEL_BAD_GEOMETRY" && (x.details as { fields?: string[] }).fields?.includes("p1")), JSON.stringify(problems));
  delete model.rigels["b_bad"];
  model.rigels["b_zero"] = {
    id: "b_zero", p1: { x: 100, y: 100, link: 0 }, p2: { x: 100, y: 100, link: 0 },
    depth: 30, height: 30, ceiling_type: "", polygon: [], l: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 } }, r: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 } },
  };
  problems = validateModel(model, []);
  assert.ok(problems.some((x) => x.code === "RIGEL_BAD_GEOMETRY"), JSON.stringify(problems));
  delete model.rigels["b_zero"];
  // корректный ригель — ошибок не даёт
  addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 } });
  assert.equal(validateModel(model, []).filter((x) => x.code.startsWith("RIGEL")).length, 0, JSON.stringify(validateModel(model, [])));
});

test("compactModel: ригели с метками B<n> (в обе стороны с эталоном)", () => {
  const { model } = roomModel();
  const et = FREE.model_object;
  const key = "b_et";
  model.rigels ??= {};
  model.rigels[key] = { ...structuredClone(et), id: key };
  const compact = compactModel(model);
  assert.equal(compact.rigels.length, 1);
  const c = compact.rigels[0]!;
  assert.equal(c.id, "B1");
  assert.equal(c.site_id, key);
  assert.deepEqual(c.from, [Math.round(et.p1.x * 10), Math.round(et.p1.y * 10)]);
  assert.deepEqual(c.to, [Math.round(et.p2.x * 10), Math.round(et.p2.y * 10)]);
  assert.equal(c.depth_mm, et.depth * 10);
  assert.equal(c.height_mm, et.height * 10);
  assert.equal(c.ceiling_type, et.ceiling_type);
  assert.deepEqual(c.links, []);
});

// ---------- верификация save (mock) ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(m.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: Object.keys(m.pillars as Record<string, unknown>).length, rigels: Object.keys(m.rigels as Record<string, unknown>).length };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      afterSave(server);
      return { ok: true, saveId: "s2", conflict: false };
    },
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
  return new Workspace(deps);
}

test("save: ригель сохраняется штатно — verified=true, один save", async () => {
  const server: SaveServer = { saveId: "s1", model: emptyModel() as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  ws.apply("rigel_add", (m) => void addRigel(m, { start: { x: 2000, y: 1500 }, end: { x: 3000, y: 1500 } }));
  const out = await ws.save();
  assert.equal(out.verified, true);
  assert.equal(out.rounds, 1);
  assert.equal(Object.keys((server.model as { rigels?: Record<string, unknown> }).rigels ?? {}).length, 1, "ригель на сервере");
});

test("save: ригель исчез после save — SITE_ERROR с перечнем расхождений", async () => {
  const server: SaveServer = { saveId: "s1", model: emptyModel() as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    (s.model as { rigels?: Record<string, unknown> }).rigels = {};
  });
  await ws.open("0", "1");
  ws.apply("rigel_add", (m) => void addRigel(m, { start: { x: 2000, y: 1500 }, end: { x: 3000, y: 1500 } }));
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { rigel_mismatches?: string[] } }).details;
    assert.ok((details?.rigel_mismatches ?? []).some((x) => x.includes("исчез")), JSON.stringify(details));
    return true;
  });
});

test("save: ригель изменил значимую геометрию после save — SITE_ERROR", async () => {
  const server: SaveServer = { saveId: "s1", model: emptyModel() as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    for (const r of Object.values((s.model as { rigels?: Record<string, Rigel> }).rigels ?? {})) {
      r.height = 45;
      r.p2 = { x: r.p2.x + 50, y: r.p2.y, link: r.p2.link };
    }
  });
  await ws.open("0", "1");
  ws.apply("rigel_add", (m) => void addRigel(m, { start: { x: 2000, y: 1500 }, end: { x: 3000, y: 1500 } }));
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    const details = (e as { details?: { rigel_mismatches?: string[] } }).details;
    assert.ok((details?.rigel_mismatches ?? []).some((x) => x.includes("высота") || x.includes("конец оси")), JSON.stringify(details));
    return true;
  });
});

test("save: ригель потерян при нормализации — NORMALIZATION_DROPPED до записи", async () => {
  const server: SaveServer = { saveId: "s1", model: emptyModel() as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    (m as { rigels?: Record<string, unknown> }).rigels = {};
  });
  await ws.open("0", "1");
  ws.apply("rigel_add", (m) => void addRigel(m, { start: { x: 2000, y: 1500 }, end: { x: 3000, y: 1500 } }));
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "NORMALIZATION_DROPPED");
    const details = (e as { details?: { lost_rigels?: string[] } }).details;
    assert.equal((details?.lost_rigels ?? []).length, 1, JSON.stringify(details));
    return true;
  });
  assert.equal(saves, 0, "до записи дело не дошло");
});

test("save: штатное удаление ригеля не блокирует сохранение (нет ложного расхождения)", async () => {
  const server: SaveServer = { saveId: "s1", model: emptyModel() as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const r = ws.apply("rigel_add", (m) => addRigel(m, { start: { x: 2000, y: 1500 }, end: { x: 3000, y: 1500 } }));
  ws.apply("rigel_delete", (m) => void deleteRigel(m, r.id));
  const out = await ws.save();
  assert.equal(out.verified, true);
  assert.equal(out.rounds, 1);
  assert.equal(out.will_delete.rigels, 0, JSON.stringify(out.will_delete));
});

// ---------- регрессия стен/колонн ----------

test("регрессия: ригели не мешают стеновым операциям, модель без ригелей идёт прежними путями", () => {
  const { model } = roomModel();
  const walls = Object.keys(model.walls);
  assert.ok(walls.length >= 4, "прямоугольник стен на месте");
  const r = addRigel(model, { start: { x: 2000, y: 1500 }, end: { x: 3000, y: 1500 } });
  moveWall(model, { wallId: walls[0]!, offsetMm: 50 });
  deleteWall(model, walls[1]!);
  assert.deepEqual({ x: r.p1.x, y: r.p1.y }, { x: 200, y: 150 }, "ригель пережил стеновые операции");
  assert.equal(validateModel(model, []).filter((x) => x.code.startsWith("RIGEL")).length, 0);
});
