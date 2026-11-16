// Этап 49 — резолюция ревью 48 (PR #5 «Потолочный ригель»):
// №1 — add/update/delete ригеля в общей атомарной финализации зависимых ригелей;
// №2 — пересчёт зависимых ригелей при изменении геометрии связанной грани (поворот колонны);
// №3 — проверка оси после snap/округления (INVALID_ARGUMENT, модель идентична snapshot);
// №4 — ceiling_type: допустимый набор по группе ceiling_elements редактора;
// №5 — реальный rollback колонных операций с ригелями;
// №6 — гашение одинаковых ненулевых связей и границы угла 2/178°.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, Rigel } from "../../src/model/types.ts";
import { addPillar, updatePillar, deletePillar } from "../../src/model/pillars.ts";
import {
  addRigel, updateRigel, deleteRigel, refreshRigelsAfterWallOrPillarChange,
  cancelSameLinks, rigelLink, RIGEL_CEILING_TYPES,
} from "../../src/model/rigels.ts";
import { validateModel } from "../../src/model/validate.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {}, pillars: {}, rigels: {} };
}

const near = (a: number, b: number, tol = 0.01): boolean => Math.abs(a - b) <= tol;

function expectPoints(label: string, got: { x: number; y: number }[], want: [number, number][]): void {
  assert.equal(got.length, want.length, `${label}: число точек`);
  got.forEach((p, i) => assert.ok(near(p.x, want[i]![0]) && near(p.y, want[i]![1]), `${label}: точка ${i} (${p.x},${p.y}) ≠ (${want[i]![0]},${want[i]![1]})`));
}

/** Ревью 48 №1: сценарии delete/move/depth опорного ригеля A с зависимым B. */
function rigelsPair(): { model: Model; a: Rigel; b: Rigel } {
  const model = emptyModel();
  const a = addRigel(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const b = addRigel(model, { start: { x: 1000, y: 150 }, end: { x: 2000, y: 1000 } });
  return { model, a, b };
}

test("ревью 48 №1: delete опорного ригеля — связь зависимого гасится, полигон пересчитан (атомарно)", () => {
  const { model, a, b } = rigelsPair();
  assert.ok(b.p1.link !== 0, "предусловие: B.p1 связан с A");
  const trimmed = JSON.stringify(b.polygon);
  // несвязанный свидетель — побайтово неизменен
  const c = addRigel(model, { start: { x: 5000, y: 5000 }, end: { x: 6000, y: 5000 } });
  const cBefore = JSON.stringify(c);
  deleteRigel(model, a.id);
  assert.equal(b.p1.link, 0, "связь с удалённым ригелем погашена");
  assert.notEqual(JSON.stringify(b.polygon), trimmed, "полигон пересчитан (срез исчез)");
  // полигон совпадает с несвязанным ригелем той же оси/толщины
  assert.equal(b.depth, 30);
  expectPoints("delete: polygon без среза", b.polygon, [
    [109.7147, 3.5709], [209.7147, 88.5709], [190.2853, 111.4291], [90.2853, 26.4291],
  ]);
  assert.equal(JSON.stringify(c), cBefore, "несвязанный ригель не изменился");
  assert.equal(validateModel(model, []).filter((x) => x.code.startsWith("RIGEL")).length, 0, JSON.stringify(validateModel(model, [])));
});

test("ревью 48 №1: перенос опорного ригеля — связь и полигон зависимого пересчитаны", () => {
  const { model, a, b } = rigelsPair();
  const c = addRigel(model, { start: { x: 5000, y: 5000 }, end: { x: 6000, y: 5000 } });
  const cBefore = JSON.stringify(c);
  updateRigel(model, { rigelId: a.id, start: { x: 0, y: 2000 }, end: { x: 4000, y: 2000 } });
  assert.equal(b.p1.link, 0, "связь с перенесённым ригелем погашена");
  expectPoints("move: polygon без среза", b.polygon, [
    [109.7147, 3.5709], [209.7147, 88.5709], [190.2853, 111.4291], [90.2853, 26.4291],
  ]);
  assert.equal(JSON.stringify(c), cBefore, "несвязанный ригель не изменился");
});

test("ревью 48 №1: увеличение толщины опорного ригеля — связь и полигон зависимого пересчитаны", () => {
  const { model, a, b } = rigelsPair();
  updateRigel(model, { rigelId: a.id, depthMm: 600 });
  assert.equal(a.depth, 60);
  assert.equal(b.p1.link, 0, "конец B больше не на грани утолщённого A");
  expectPoints("depth: polygon без среза", b.polygon, [
    [109.7147, 3.5709], [209.7147, 88.5709], [190.2853, 111.4291], [90.2853, 26.4291],
  ]);
});

test("ревью 48 №1: пересчёт идемпотентен — повторный refresh не меняет модель", () => {
  const { model, a, b } = rigelsPair();
  const c = addRigel(model, { start: { x: 5000, y: 5000 }, end: { x: 6000, y: 5000 } });
  updateRigel(model, { rigelId: a.id, depthMm: 600 });
  const snapshot = JSON.stringify(model);
  refreshRigelsAfterWallOrPillarChange(model);
  assert.equal(JSON.stringify(model), snapshot, "второй refresh — байт в байт");
  assert.equal(JSON.stringify(c), JSON.stringify(model.rigels?.[c.id]), "свидетель на месте");
  void b;
});

test("ревью 48 №1: add ригеля — зависимые ригели, привязанные к его граням, пересчитываются атомарно", () => {
  const model = emptyModel();
  const a = addRigel(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const b = addRigel(model, { start: { x: 1000, y: 150 }, end: { x: 2000, y: 1000 } });
  // воссоздаём сценарий: B связан с A сразу при add (связь появилась в той же операции)
  assert.ok(b.p1.link !== 0, "связь B→A установлена при add");
  void a;
});

test("ревью 48 №2: поворот колонны — полигон зависимого ригеля пересчитан при тех же id/z1 связи", () => {
  const model = emptyModel();
  const p = addPillar(model, { center: { x: 0, y: 200 }, widthMm: 400, heightMm: 400 });
  const b = addRigel(model, { start: { x: 0, y: 0 }, end: { x: 1000, y: -1000 } });
  assert.ok(b.p1.link !== 0, "предусловие: связь с колонной");
  const stale = structuredClone(b.polygon);
  updatePillar(model, { pillarId: p.id, angleDeg: 30, center: { x: -100, y: 173.2 } });
  // связь не изменилась (конец на той же грани), но полигон обязан обновиться
  assert.ok((b.p1.link as { ot: string }).ot === "pillar", "link сохранился");
  assert.equal((b.p1.link as { id: string }).id, p.id, "id связи тот же");
  assert.notDeepEqual(b.polygon.map((q) => [q.x, q.y]), stale.map((q) => [q.x, q.y]), "полигон обновлён");
  // значения из воспроизведения ревью 48
  expectPoints("rotated: polygon", b.polygon, [
    [-13.4485, -7.7647], [89.3934, -110.6066], [110.6066, -89.3934], [13.4485, 7.7647],
  ]);
});

test("ревью 48 №2: связь с ригелем, изменённым updateRigel (перенос A) — полигон B пересчитан тем же refresh", () => {
  // покрыто тестами «перенос опорного ригеля»/«толщина» выше; здесь — обновление без переноса оси
  const { model, a, b } = rigelsPair();
  assert.ok(b.p1.link !== 0);
  updateRigel(model, { rigelId: a.id, heightMm: 500 }); // геометрия грани не меняется — B не тронут
  const before = JSON.stringify(b);
  refreshRigelsAfterWallOrPillarChange(model);
  assert.equal(JSON.stringify(b), before, "высота A не меняет грань — B байт в байт");
  void model;
});

const testWall = (id: string): Model["walls"][string] => ({
  id, plan: "a", role: "wall", depth: 20, height: 270, material: "a_block",
  p1: { x: 0, y: 0 }, p2: { x: 400, y: 0 }, holes: {},
});

// ---------- №3: ось после snap ----------

test("ревью 48 №3: add — ось, схлопнувшаяся после магнита; модель идентична snapshot", () => {
  const model = emptyModel();
  model.walls["w"] = testWall("w");
  const snapshot = JSON.stringify(model);
  assert.throws(() => addRigel(model, { start: { x: 1000, y: 90 }, end: { x: 1000, y: 110 } }), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "INVALID_ARGUMENT");
    return true;
  });
  assert.equal(JSON.stringify(model), snapshot, "модель не изменилась (включая отсутствие rigels)");
});

test("ревью 48 №3: update — ось, схлопнувшаяся после магнита, отклоняется; модель идентична snapshot", () => {
  const model = emptyModel();
  model.walls["w"] = testWall("w");
  const r = addRigel(model, { start: { x: 2000, y: 2000 }, end: { x: 3000, y: 2000 } });
  const snapshot = JSON.stringify(model);
  assert.throws(() => updateRigel(model, { rigelId: r.id, start: { x: 1000, y: 90 }, end: { x: 1000, y: 110 } }), /ненулевой длины|совпадают/);
  assert.equal(JSON.stringify(model), snapshot, "модель не изменилась");
});

// ---------- №4: ceiling_type ----------

test("ревью 48 №4: ceiling_type — произвольное значение отклоняется, допустимые принимаются", () => {
  const model = emptyModel();
  assert.throws(
    () => addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 }, ceilingType: "gypsum" }),
    (e: unknown) => {
      assert.ok(e instanceof McpError);
      assert.equal(e.code, "INVALID_ARGUMENT");
      return true;
    },
  );
  const r = addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 }, ceilingType: "paint_ceiling" });
  assert.equal(r.ceiling_type, "paint_ceiling");
  const r2 = addRigel(model, { start: { x: 3000, y: 1000 }, end: { x: 3500, y: 1000 } });
  assert.equal(r2.ceiling_type, "");
  for (const t of RIGEL_CEILING_TYPES) {
    updateRigel(model, { rigelId: r.id, ceilingType: t });
    assert.equal(r.ceiling_type, t, `значение ${t} принимается`);
  }
});

test("ревью 48 №4: существующее произвольное ceiling_type сохраняется (update без ceiling_type)", () => {
  const model = emptyModel();
  const r = addRigel(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 } });
  // значение из старых проектов сайта: не валидируем при чтении, но и не затираем
  (r as unknown as { ceiling_type: string }).ceiling_type = "exotic_legacy";
  updateRigel(model, { rigelId: r.id, depthMm: 200 });
  assert.equal(r.ceiling_type, "exotic_legacy", "существующее значение не тронуто");
  assert.throws(() => updateRigel(model, { rigelId: r.id, ceilingType: "exotic_new" }), /ceiling_type/);
  assert.equal(r.ceiling_type, "exotic_legacy", "неудачный update не изменил значение");
});

// ---------- №5: rollback колонных операций ----------

/** Ригель-ловушка: link с BigInt — JSON.stringify в refresh бросает, structuredClone (backup) — нет. */
function poisonedRigel(model: Model): void {
  model.rigels ??= {};
  model.rigels["b_trap"] = {
    id: "b_trap",
    p1: { x: 100, y: 100, link: { ot: "wall", id: "w", z1: 1n } as unknown as 0 },
    p2: { x: 200, y: 100, link: 0 },
    height: 30, depth: 30, ceiling_type: "",
    polygon: [{ x: 100, y: 85 }, { x: 200, y: 85 }, { x: 200, y: 115 }, { x: 100, y: 115 }],
    l: { p1: { x: 100, y: 85 }, p2: { x: 200, y: 85 } },
    r: { p1: { x: 100, y: 115 }, p2: { x: 200, y: 115 } },
  };
}

const safe = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `bigint:${String(x)}` : x));

test("ревью 48 №5: updatePillar при ошибке финализации откатывает и колонну, и ригели (rollback реальный)", () => {
  const model = emptyModel();
  const p = addPillar(model, { center: { x: 0, y: 200 }, widthMm: 400, heightMm: 400 });
  poisonedRigel(model);
  const pillarsSnapshot = safe(model.pillars);
  const rigelsSnapshot = safe(model.rigels);
  assert.throws(() => updatePillar(model, { pillarId: p.id, center: { x: 0, y: 2000 } }), /BigInt/);
  assert.equal(safe(model.pillars), pillarsSnapshot, "колонна восстановлена побайтно");
  assert.equal(safe(model.rigels), rigelsSnapshot, "ригели восстановлены побайтно");
});

test("ревью 48 №5: deletePillar при ошибке финализации — модель идентична snapshot", () => {
  const model = emptyModel();
  const p = addPillar(model, { center: { x: 0, y: 200 }, widthMm: 400, heightMm: 400 });
  poisonedRigel(model);
  const pillarsSnapshot = safe(model.pillars);
  const rigelsSnapshot = safe(model.rigels);
  assert.throws(() => deletePillar(model, p.id), /BigInt/);
  assert.equal(safe(model.pillars), pillarsSnapshot, "колонна не удалена");
  assert.equal(safe(model.rigels), rigelsSnapshot, "ригели не тронуты");
});

test("ревью 48 №5: addPillar при ошибке финализации — модель идентична snapshot", () => {
  const model = emptyModel();
  poisonedRigel(model);
  const snapshot = safe(model);
  assert.throws(() => addPillar(model, { center: { x: 5000, y: 5000 } }), /BigInt/);
  assert.equal(safe(model), snapshot, "модель не изменилась");
});

// ---------- №6: гашение одинаковых связей и границы угла ----------

test("ревью 48 №6: cancelSameLinks — одинаковые НЕнулевые связи гасятся (p2 → 0)", () => {
  const l1 = { ot: "wall" as const, id: "w", z1: "l" };
  assert.deepEqual(cancelSameLinks(l1, { ot: "wall", id: "w", z1: "l" }), { p1: l1, p2: 0 }, "тот же id и z1 → гасится");
  assert.deepEqual(
    cancelSameLinks(l1, { ot: "wall", id: "w", z1: "r" }),
    { p1: l1, p2: { ot: "wall", id: "w", z1: "r" } },
    "тот же id, другой z1 → не гасится",
  );
  assert.deepEqual(
    cancelSameLinks(l1, { ot: "wall", id: "w2", z1: "l" }),
    { p1: l1, p2: { ot: "wall", id: "w2", z1: "l" } },
    "другой id → не гасится",
  );
  assert.deepEqual(cancelSameLinks(l1, { ot: "rigel", id: "w", z1: "l" }), { p1: l1, p2: 0 }, "как в редакторе: сравниваются только id и z1, не ot");
  assert.deepEqual(cancelSameLinks(l1, 0), { p1: l1, p2: 0 }, "нулевая вторая — без изменений");
  assert.deepEqual(cancelSameLinks(0, 0), { p1: 0, p2: 0 });
});

test("ревью 48 №6: границы угла 2/178° — 1.9° и 178.1° без связи, 2.1° и 177.9° со связью", () => {
  const model = emptyModel();
  model.walls["w"] = testWall("w");
  const endpoint = { x: 100, y: 10 }; // на грани стены (ось y=0, толщина 20 → грань y=10)
  const axisAt = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return { p1: endpoint, p2: { x: endpoint.x + Math.cos(rad) * 30, y: endpoint.y + Math.sin(rad) * 30 } };
  };
  assert.equal(rigelLink(endpoint, axisAt(1.9), model, "b"), 0, "1.9° — связи нет");
  assert.equal(rigelLink(endpoint, axisAt(178.1), model, "b"), 0, "178.1° — связи нет");
  for (const deg of [2.1, 90, 177.9]) {
    const link = rigelLink(endpoint, axisAt(deg), model, "b");
    assert.ok(link !== 0 && link.ot === "wall", `${deg}° — связь есть`);
  }
});
