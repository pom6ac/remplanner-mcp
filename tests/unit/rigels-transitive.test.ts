// Этап 51 — резолюция ревью 50 (PR #5 «Потолочный ригель», второй круг):
// major 50-1 — транзитивная финализация зависимых ригелей до неподвижной точки
// (цепочка A→B→C после удаления/изменения A оставляла устаревший срез C),
// защита от циклов ограничением проходов; minor — snapshot до операции,
// зависимые при add ранее существовавшего объекта, цепочки.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, Rigel } from "../../src/model/types.ts";
import {
  addRigel, updateRigel, deleteRigel, refreshRigelsAfterWallOrPillarChange as refresh,
} from "../../src/model/rigels.ts";
import { validateModel } from "../../src/model/validate.ts";

const here = dirname(fileURLToPath(import.meta.url));

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {}, pillars: {}, rigels: {} };
}

const near = (a: number, b: number, tol = 0.01): boolean => Math.abs(a - b) <= tol;

/** Воспроизведение major 50-1 из ревью 50: порядок создания A, C, B. */
function chainACB(): { model: Model; a: Rigel; b: Rigel; c: Rigel } {
  const model = emptyModel();
  const a = addRigel(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const c = addRigel(model, { start: { x: 1100, y: 150 }, end: { x: 2100, y: -1000 }, depthMm: 100 });
  const b = addRigel(model, { start: { x: 1000, y: 150 }, end: { x: 2000, y: 1000 } });
  return { model, a, b, c };
}

test("ревью 50 major: delete опорного ригеля — цепочка A→B→C финализирована ОДНОЙ операцией", () => {
  const { model, a, b, c } = chainACB();
  assert.ok(c.p1.link !== 0 && (c.p1.link as { id: string }).id === b.id, "предусловие: C→B");
  assert.ok(b.p1.link !== 0 && (b.p1.link as { id: string }).id === a.id, "предусловие: B→A");
  const stable = JSON.stringify(model);
  refresh(model);
  assert.equal(JSON.stringify(model), stable, "предусловие: модель до удаления устойчива к refresh");
  deleteRigel(model, a.id);
  // связь C→B погашена сразу, без дополнительного refresh
  assert.equal(c.p1.link, 0, "устаревшая связь C→B погашена операцией удаления");
  // углы C из ревью 50: [106.22697239,11.71910643] и [113.77302761,18.28089357] см
  assert.ok(near(c.polygon[0]!.x, 106.2270) && near(c.polygon[0]!.y, 11.7191), `угол C: ${JSON.stringify(c.polygon[0])}`);
  assert.ok(near(c.polygon[3]!.x, 113.7730) && near(c.polygon[3]!.y, 18.2809), `угол C: ${JSON.stringify(c.polygon[3])}`);
  // результат операции сразу совпадает с повторной финализацией (байт в байт)
  const after = JSON.stringify(model);
  refresh(model);
  refresh(model);
  assert.equal(JSON.stringify(model), after, "повторный refresh не меняет модель");
  assert.equal(validateModel(model, []).filter((x) => x.code.startsWith("RIGEL")).length, 0);
});

test("ревью 50 major: delete в цепочке — несвязанные объекты побайтово неизменны", () => {
  const { model, a, b, c } = chainACB();
  const witness = addRigel(model, { start: { x: 5000, y: 5000 }, end: { x: 6000, y: 5000 } });
  const witnessBefore = JSON.stringify(witness);
  const cBefore = JSON.stringify(c);
  deleteRigel(model, a.id);
  assert.equal(JSON.stringify(witness), witnessBefore, "несвязанный ригель байт в байт");
  assert.notEqual(JSON.stringify(c), cBefore, "зависимый C пересчитан");
  void b;
});

/** Спецификации цепочки A→B→C→D (D.p1 на боковой грани C, срезанной при финализации). */
const chainSpec = {
  a: { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } },
  b: { start: { x: 1000, y: 150 }, end: { x: 2000, y: 1000 } },
  c: { start: { x: 1100, y: 150 }, end: { x: 2100, y: -1000 }, depthMm: 100 },
  d: { start: { x: 1047, y: 135 }, end: { x: 1547, y: 235 } },
};

function buildChain(order: string[]): { model: Model; made: Record<string, Rigel> } {
  const model = emptyModel();
  const made: Record<string, Rigel> = {};
  for (const k of order) made[k] = addRigel(model, chainSpec[k as keyof typeof chainSpec]!);
  return { model, made };
}

/** Канонизация: id → буквы роли (включая id в связях) для сравнения состояний. */
function canonChain(made: Record<string, Rigel>, keys: string[]): string {
  const roleOf = (id: string): string => Object.keys(made).find((k) => made[k]!.id === id) ?? "?";
  const mapLink = (l: unknown): unknown => {
    if (l === 0) return 0;
    const link = l as { ot: string; id: string; z1: string };
    return { ...link, id: roleOf(link.id) };
  };
  return JSON.stringify(
    Object.fromEntries(keys.map((k) => {
      const r = structuredClone(made[k]!);
      r.id = k;
      r.p1.link = mapLink(r.p1.link) as Rigel["p1"]["link"];
      r.p2.link = mapLink(r.p2.link) as Rigel["p2"]["link"];
      return [k, r];
    })),
  );
}

const linkOf = (r: Rigel, end: "p1" | "p2"): { id: string; z1: string } | 0 => r[end].link ?? 0;

const assertLink = (r: Rigel, end: "p1" | "p2", target: Rigel, msg = "связь"): void => {
  const l = linkOf(r, end);
  assert.ok(l !== 0 && l.id === target.id, `${msg}: ${end} → ${target.id}`);
};

test("ревью 50 major: цепочка из 4 ригелей — удаление корня транзитивно гасит связи C и D", () => {
  // порядок создания a,c,b,d — неtopологический (как в воспроизведении ревью 50)
  const { model, made } = buildChain(["a", "c", "b", "d"]);
  const a = made.a!;
  const b = made.b!;
  const c = made.c!;
  const d = made.d!;
  assertLink(b, "p1", a, "предусловие: B.p1→A");
  assertLink(c, "p1", b, "предусловие: C.p1→B");
  assertLink(d, "p1", c, "предусловие: D.p1→C");
  deleteRigel(model, a.id);
  const after = JSON.stringify(model);
  assert.equal(b.p1.link, 0, "B.p1 погашен");
  assert.equal(c.p1.link, 0, "C.p1 погашен транзитивно");
  assert.equal(d.p1.link, 0, "D.p1 погашен транзитивно");
  refresh(model);
  assert.equal(JSON.stringify(model), after, "неподвижная точка достигнута операцией удаления");
  // торцы без среза: ширина на конце p1 равна depth
  const widthP1 = (r: Rigel) => Math.hypot(r.polygon[3]!.x - r.polygon[0]!.x, r.polygon[3]!.y - r.polygon[0]!.y);
  assert.ok(Math.abs(widthP1(c) - c.depth) < 0.01, `торец C = depth: ${widthP1(c)} vs ${c.depth}`);
  assert.ok(Math.abs(widthP1(d) - d.depth) < 0.01, `торец D = depth: ${widthP1(d)} vs ${d.depth}`);
  assert.equal(validateModel(model, []).filter((x) => x.code.startsWith("RIGEL")).length, 0);
});

test("ревью 50 major: удаление СЕРЕДИНЫ цепочки A→B→C — связь C погашена, A не тронут", () => {
  const model = emptyModel();
  const a = addRigel(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const b = addRigel(model, { start: { x: 1000, y: 150 }, end: { x: 2000, y: 1000 } });
  // C.p1 на несрезанном торце B (e, у p2) — после удаления B заменяющей грани нет
  const c = addRigel(model, { start: { x: 2000, y: 1000 }, end: { x: 2050, y: 2000 } });
  assertLink(c, "p1", b, "предусловие: C.p1→B (торец e)");
  const aBefore = JSON.stringify(a);
  const cPolyBefore = JSON.stringify(c.polygon);
  deleteRigel(model, b.id);
  const after = JSON.stringify(model);
  assert.equal(JSON.stringify(a), aBefore, "опора A байт в байт");
  assert.equal(c.p1.link, 0, "связь C→удалённый B погашена");
  assert.notEqual(JSON.stringify(c.polygon), cPolyBefore, "срез C по торцу B исчез");
  refresh(model);
  assert.equal(JSON.stringify(model), after, "неподвижная точка достигнута операцией");
});

test("ревью 50 major: результат не зависит от порядка создания — финальное состояние цепочки одинаково", () => {
  const run = (order: string[]) => {
    const { model, made } = buildChain(order);
    deleteRigel(model, made.a!.id);
    return canonChain(made, ["b", "c", "d"]);
  };
  assert.equal(run(["a", "c", "b", "d"]), run(["a", "b", "c", "d"]), "состояние B, C, D после удаления не зависит от порядка создания");
  assert.equal(run(["a", "c", "d", "b"]), run(["a", "b", "c", "d"]), "состояние B, C, D после удаления не зависит от порядка создания");
});

test("ревью 50 major: update корня цепочки — зависимые финализированы одной операцией (snapshot до операции)", () => {
  const { model, a, b, c } = chainACB();
  const snapshotBefore = JSON.stringify(model);
  updateRigel(model, { rigelId: a.id, depthMm: 600 });
  const after = JSON.stringify(model);
  assert.notEqual(after, snapshotBefore, "update меняет модель");
  assert.equal(c.p1.link, 0, "C.p1 погашен транзитивно (без отдельного refresh)");
  refresh(model);
  assert.equal(JSON.stringify(model), after, "повторная финализация — байт в байт");
});

test("ревью 50 minor: add ригеля обновляет РАНЕЕ существовавший зависимый ригель атомарно", () => {
  const model = emptyModel();
  const a = addRigel(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const c = addRigel(model, { start: { x: 1100, y: 150 }, end: { x: 2100, y: -1000 }, depthMm: 100 });
  assertLink(c, "p1", a, "предусловие: C.p1→A");
  const b = addRigel(model, { start: { x: 1000, y: 150 }, end: { x: 2000, y: 1000 } });
  assertLink(c, "p1", b, "существующий C переключился на торец нового B");
  const after = JSON.stringify(model);
  refresh(model);
  assert.equal(JSON.stringify(model), after, "повторная финализация — байт в байт");
  void a;
});

// ---------- циклы ----------

test("ревью 50: цикл A↔B (взаимные связи через торцы) — финализация сходится, повторный refresh не меняет", () => {
  const model = emptyModel();
  const a = addRigel(model, { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } });
  const b = addRigel(model, { start: { x: 1000, y: 0 }, end: { x: 1100, y: 1000 } });
  assert.ok(a.p2.link !== 0 && (a.p2.link as { id: string }).id === b.id, "A.p2→B");
  assert.ok(b.p1.link !== 0 && (b.p1.link as { id: string }).id === a.id, "B.p1→A");
  const snapshot = JSON.stringify(model);
  refresh(model);
  refresh(model);
  assert.equal(JSON.stringify(model), snapshot, "цикл устойчив, refresh не меняет модель");
  void model;
});

test("ревью 50: цикл A→B→C→A (треугольник взаимных торцов) — сходится, изменение участника пересчитывает цикл", () => {
  const model = emptyModel();
  const a = addRigel(model, { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } });
  const b = addRigel(model, { start: { x: 1000, y: 0 }, end: { x: 500, y: 800 } });
  const c = addRigel(model, { start: { x: 500, y: 800 }, end: { x: 0, y: 0 } });
  const linked = (l: unknown): l is { id: string; z1: string } => l !== 0;
  assert.ok(linked(a.p2.link) && a.p2.link.id === b.id, "A.p2→B");
  assert.ok(linked(b.p1.link) && b.p1.link.id === a.id, "B.p1→A");
  assert.ok(linked(b.p2.link) && b.p2.link.id === c.id, "B.p2→C");
  assert.ok(linked(c.p1.link) && c.p1.link.id === b.id, "C.p1→B");
  assert.ok(linked(c.p2.link) && c.p2.link.id === a.id, "C.p2→A");
  assert.ok(linked(a.p1.link) && a.p1.link.id === c.id, "A.p1→C");
  const stable = JSON.stringify(model);
  refresh(model);
  assert.equal(JSON.stringify(model), stable, "устойчивый цикл: refresh не меняет модель");
  // мутация внутри цикла: утолщение B — связи пересчитаны, финализация сошлась
  updateRigel(model, { rigelId: b.id, depthMm: 600 });
  const after = JSON.stringify(model);
  refresh(model);
  assert.equal(JSON.stringify(model), after, "после мутации в цикле — неподвижная точка");
  assert.equal(validateModel(model, []).filter((x) => x.code.startsWith("RIGEL")).length, 0);
});

test("ревью 50: цикл + цепочка — изменение участника цикла транзитивно финализирует зависимый вне цикла", () => {
  const model = emptyModel();
  const a = addRigel(model, { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } });
  const b = addRigel(model, { start: { x: 1000, y: 0 }, end: { x: 1100, y: 1000 } });
  assert.ok(a.p2.link !== 0 && (a.p2.link as { id: string }).id === b.id, "предусловие: A.p2→B");
  assert.ok(b.p1.link !== 0 && (b.p1.link as { id: string }).id === a.id, "предусловие: B.p1→A (цикл)");
  // D.p1 на торце B (s), срезанном гранью A: линия торца x=100
  const d = addRigel(model, { start: { x: 1000, y: -500 }, end: { x: 2000, y: -500 } });
  assert.ok(d.p1.link !== 0 && (d.p1.link as { id: string }).id === b.id, "предусловие: D.p1→B.s");
  updateRigel(model, { rigelId: a.id, end: { x: 500, y: 0 } });
  const after = JSON.stringify(model);
  assert.equal(b.p1.link, 0, "B.p1 (цикл) погашен — грань A ушла");
  assert.equal(d.p1.link, 0, "D.p1 погашен транзитивно через участника цикла");
  refresh(model);
  assert.equal(JSON.stringify(model), after, "неподвижная точка после изменения участника цикла");
  void a;
});

// ---------- атомарность при не-сходимости / ошибках финализации ----------

/** Ригель-ловушка: link с BigInt — JSON.stringify в refresh бросает (как в ревью 48 №5). */
function poisonedRigel(model: Model): void {
  model.rigels!["b_trap"] = {
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

test("ревью 50: deleteRigel при ошибке финализации — модель идентична snapshot (rollback)", () => {
  const model = emptyModel();
  const a = addRigel(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  const b = addRigel(model, { start: { x: 1000, y: 150 }, end: { x: 2000, y: 1000 } });
  poisonedRigel(model);
  const rigelsSnapshot = safe(model.rigels);
  assert.throws(() => deleteRigel(model, a.id), /BigInt/);
  assert.equal(safe(model.rigels), rigelsSnapshot, "ригели восстановлены побайтно, A не удалён");
  void b;
});

test("ревью 50: updateRigel при ошибке финализации — модель идентична snapshot (rollback)", () => {
  const model = emptyModel();
  const a = addRigel(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  poisonedRigel(model);
  const rigelsSnapshot = safe(model.rigels);
  assert.throws(() => updateRigel(model, { rigelId: a.id, depthMm: 600 }), /BigInt/);
  assert.equal(safe(model.rigels), rigelsSnapshot, "ригели восстановлены побайтно");
});

test("ревью 50: addRigel при ошибке финализации — модель идентична snapshot, включая отсутствие rigels (rollback)", () => {
  const model = emptyModel();
  const a = addRigel(model, { start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } });
  poisonedRigel(model);
  const snapshot = safe(model);
  assert.throws(() => addRigel(model, { start: { x: 6000, y: 6000 }, end: { x: 7000, y: 6000 } }), /BigInt/);
  assert.equal(safe(model), snapshot, "модель не изменилась");
  void a;
});
