// Ревью 335 M1: полный путь — комната с двухуровневым потолком исчезает при
// wall_delete → отказ с подсказкой (какая отделка мешает и порядок снятия) →
// выполнение подсказанного пути (finish_ceiling_set другим покрытием →
// finish_ceiling_remove) → wall_delete проходит. Офлайн: Workspace с mock
// редактором normalize, который как настоящий редактор пересобирает комнаты
// (комната, чья стена удалена, исчезает из rooms2).
// Фикс-5 (ревью 337 M1-а, n4): подсказка строится по ОДНОМУ реестру
// FINISH_LOSS_REGISTRY («вид потери → инструмент → порядок»), finishCompare
// помечает каждую problem кодом вида; полный путь для плинтуса пола,
// потолочного плинтуса, ниши и пол+плинтус; сторож реестра.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import type { Model } from "../../src/model/types.ts";
import { deleteWall } from "../../src/model/walls.ts";
import {
  setCeilingFinish, removeCeilingFinish, setFloorFinish, removeFloorFinish,
  setFloorMolding, removeFloorMolding, setCeilingMolding, removeCeilingMolding,
  addCeilingNiche, removeCeilingNiche,
  finishCompare, finishLossHint, FINISH_LOSS_KINDS, FINISH_LOSS_REGISTRY, type FinishLoss,
} from "../../src/model/finish.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function corridorModel(): Model {
  const env = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/editor-corridor-3rooms.json"), "utf8")) as { model: Model };
  return structuredClone(env.model);
}

/** Mock normalize: как настоящий редактор, комнаты пересобраны — dropRooms
 *  исчезли (их стены удалены), остальное без изменений. */
function mockEditor(dropRooms: string[]): EditorLike {
  return {
    objectId: "123", planId: "1",
    async normalize(model) {
      const copy = structuredClone(model) as Record<string, unknown>;
      const rooms = (copy["rooms2"] ?? {}) as Record<string, unknown>;
      for (const rid of dropRooms) delete rooms[rid];
      return {
        model: copy,
        rooms: [],
        before: { walls: 0, holes: 0, items: 0 },
        after: { walls: 0, holes: 0, items: 0 },
        walls: [],
        errors: null,
      };
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { global_version: "757", planner_version: "3", bundles: [], object_id: "123", plan_id: "1", present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } } as never; },
    async close() {},
  };
}

function deps(editor: EditorLike, model: Model): WorkspaceDeps {
  return {
    session: { cookies: [] },
    async loadModel(_s, _o, _p): Promise<LoadedModel> {
      return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", model: structuredClone(model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
}

/** Средняя верхняя комната (x 310..490) с двухуровневым потолком; стена w7
 *  (x=500) — её граница. */
function modelWithComplex(): Model {
  const m = corridorModel();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  const room = rooms["_dvxjh"]!;
  room["ceilings"] = [{
    exist: true,
    id: "_cx1",
    material: "gypsum_ceiling",
    material2: "stretch_ceiling",
    level: 15,
    level2: 75,
    offset: 40,
    radius: 10,
    type: "closed",
    profile: "standard",
    complex: true,
    polygon: structuredClone(room["polygon"]),
  }];
  return m;
}

test("335 M1: wall_delete при complex-отделке исчезающей комнаты — отказ с подсказкой, подсказанный путь проходит, wall_delete проходит", async () => {
  const ws = new Workspace(deps(mockEditor(["_dvxjh"]), modelWithComplex()));
  await ws.open("123", "1");
  // 1. wall_delete → отказ с подсказкой (не общий текст из дюжины категорий)
  await assert.rejects(
    ws.applyWalls("wall_delete", (m) => deleteWall(m, "w7")),
    (e: unknown) => {
      const err = e as { code?: string; message?: string; details?: Record<string, unknown> };
      assert.equal(err.code, "INVALID_GEOMETRY");
      assert.match(err.message ?? "", /двухуровнев/, `в отказе назван двухуровневый потолок: ${err.message}`);
      assert.match(err.message ?? "", /finish_ceiling_set/, `в отказе первый шаг снятия: ${err.message}`);
      assert.match(err.message ?? "", /finish_ceiling_remove/, `в отказе ластик: ${err.message}`);
      const mismatches = err.details?.["finish_mismatches"] as string[] | undefined;
      assert.ok(Array.isArray(mismatches) && mismatches.some((p) => p.includes("_dvxjh")), `finish_mismatches с фактическим расхождением: ${JSON.stringify(err.details)}`);
      return true;
    },
  );
  // модель не изменилась: complex на месте
  const rooms0 = (ws.model.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  assert.equal((rooms0["_dvxjh"]!.ceilings as Array<Record<string, unknown>>)[0]!.complex, true, "после отказа complex на месте");
  // 2. подсказанный путь: смена материала (complex_removed) → ластик
  const changed = ws.apply("finish_ceiling_set", (m) => setCeilingFinish(m, "_dvxjh", "stretch_ceiling", {}));
  assert.equal(changed.complexRemoved, true, "смена материала снимает complex");
  ws.apply("finish_ceiling_remove", (m) => { removeCeilingFinish(m, "_dvxjh"); return true; });
  const rooms1 = (ws.model.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  const ceilings1 = (rooms1["_dvxjh"]!.ceilings ?? []) as Array<Record<string, unknown>>;
  assert.ok(ceilings1.every((c) => c.exist !== true), "покрытие снято");
  // 3. wall_delete проходит
  const res = await ws.applyWalls("wall_delete", (m) => deleteWall(m, "w7"));
  assert.ok(res, "wall_delete после снятия отделки проходит");
  assert.equal(JSON.stringify((ws.model.rooms2 as Record<string, unknown>)["_dvxjh"]), undefined, "комната исчезла после нормализации");
});

// --- Фикс-5 (ревью 337 M1-а): реестр видов потери и полный путь для плинтусов/ниши ---

/** Комната _dvxjh с отделкой, собранной модельными функциями (как в UI). */
function modelDressed(dress: (m: Model) => void): Model {
  const m = corridorModel();
  dress(m);
  return m;
}

async function assertHintAndPath(
  model: Model,
  path: (m: Model) => void,
  hintChecks: (message: string) => void,
): Promise<void> {
  const ws = new Workspace(deps(mockEditor(["_dvxjh"]), model));
  await ws.open("123", "1");
  // 1. wall_delete → отказ с подсказкой по реестру
  await assert.rejects(
    ws.applyWalls("wall_delete", (m) => deleteWall(m, "w7")),
    (e: unknown) => {
      const err = e as { code?: string; message?: string; details?: Record<string, unknown> };
      assert.equal(err.code, "INVALID_GEOMETRY");
      hintChecks(err.message ?? "");
      const mismatches = err.details?.["finish_mismatches"] as string[] | undefined;
      assert.ok(Array.isArray(mismatches) && mismatches.length > 0, "finish_mismatches с фактическими расхождениями");
      return true;
    },
  );
  // 2. подсказанный путь снятия отделки
  path(ws.model);
  // 3. wall_delete проходит
  const res = await ws.applyWalls("wall_delete", (m) => deleteWall(m, "w7"));
  assert.ok(res, "wall_delete после снятия отделки проходит");
  assert.equal(JSON.stringify((ws.model.rooms2 as Record<string, unknown>)["_dvxjh"]), undefined, "комната исчезла");
}

test("338 M1-а: плинтус пола — отказ называет finish_floor_molding_remove, путь проходит, wall_delete проходит", async () => {
  await assertHintAndPath(
    modelDressed((m) => setFloorMolding(m, "_dvxjh", "w7", "floor_molding_mdf")),
    (m) => { removeFloorMolding(m, "_dvxjh"); },
    (message) => {
      assert.match(message, /finish_floor_molding_remove/, `в подсказке инструмент плинтуса: ${message}`);
      assert.doesNotMatch(message, /finish_floor_remove(?:_| )/, `общий ластик пола не нужен: ${message}`);
      assert.doesNotMatch(message, /finish_wall_remove/, `стены не мешают: ${message}`);
      assert.doesNotMatch(message, /finish_ceiling/, `потолок не мешает: ${message}`);
    },
  );
});

test("338 M1-а: потолочный плинтус — finish_ceiling_molding_remove раньше finish_ceiling_remove, путь проходит", async () => {
  await assertHintAndPath(
    modelDressed((m) => {
      setCeilingFinish(m, "_dvxjh", "gypsum_ceiling", {});
      setCeilingMolding(m, "_dvxjh", "w7");
    }),
    (m) => {
      removeCeilingMolding(m, "_dvxjh");
      removeCeilingFinish(m, "_dvxjh");
    },
    (message) => {
      const molding = message.indexOf("finish_ceiling_molding_remove");
      const erase = message.indexOf("finish_ceiling_remove", molding + 1);
      assert.ok(molding >= 0, `в подсказке инструмент потолочного плинтуса: ${message}`);
      assert.ok(erase > molding, `плинтус снимается раньше ластика (ластик при плинтусе не снять): ${message}`);
      // n6 ревью 339: простой потолок не должен получать шаг смены материала
      assert.doesNotMatch(message, /finish_ceiling_set/, `признак complex только по своей комнате: ${message}`);
      assert.doesNotMatch(message, /finish_floor_remove/, `пол не мешает: ${message}`);
    },
  );
});

test("338 M1-а: закарнизная ниша — finish_ceiling_niche_remove раньше finish_ceiling_remove, путь проходит", async () => {
  await assertHintAndPath(
    modelDressed((m) => {
      setCeilingFinish(m, "_dvxjh", "gypsum_ceiling", {});
      addCeilingNiche(m, "_dvxjh", "w7");
    }),
    (m) => {
      removeCeilingNiche(m, "_dvxjh");
      removeCeilingFinish(m, "_dvxjh");
    },
    (message) => {
      const niche = message.indexOf("finish_ceiling_niche_remove");
      const erase = message.indexOf("finish_ceiling_remove", niche + 1);
      assert.ok(niche >= 0, `в подсказке инструмент ниши: ${message}`);
      assert.ok(erase > niche, `ниша снимается раньше ластика (ластик при нише отказывает): ${message}`);
      // n6 ревью 339: простой потолок не должен получать шаг смены материала
      assert.doesNotMatch(message, /finish_ceiling_set/, `признак complex только по своей комнате: ${message}`);
      assert.doesNotMatch(message, /finish_floor_remove/, `пол не мешает: ${message}`);
    },
  );
});

test("338 M1-а: пол и плинтус — оба шага в подсказке (плинтус раньше ластика), путь проходит", async () => {
  await assertHintAndPath(
    modelDressed((m) => {
      setFloorFinish(m, "_dvxjh", "laminate", {});
      setFloorMolding(m, "_dvxjh", "w7", "floor_molding_mdf");
    }),
    (m) => {
      removeFloorMolding(m, "_dvxjh");
      removeFloorFinish(m, "_dvxjh");
    },
    (message) => {
      const molding = message.indexOf("finish_floor_molding_remove");
      const floor = message.indexOf("finish_floor_remove", molding + 1);
      assert.ok(molding >= 0, `в подсказке инструмент плинтуса: ${message}`);
      assert.ok(floor > molding, `плинтус снимается раньше ластика пола: ${message}`);
      assert.doesNotMatch(message, /finish_ceiling/, `потолок не мешает: ${message}`);
      assert.doesNotMatch(message, /finish_wall_remove/, `стены не мешают: ${message}`);
    },
  );
});

// --- сторож реестра (перечисление видов — из одного источника) ---

// n8 ревью 339, m3 ревью 342: тест закрепляет инвариант «problems — тексты
// losses»; структурная защита на другом уровне — переменной problems в
// finishCompare нет, прямой push в обход add не скомпилируется. Исходник
// дополнительно сторожится тестом ниже.
test("339 n8: problems и losses попарно равны (problem без кода вида невозможен)", () => {
  const m = corridorModel();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  const src = "_uwwgk";
  setCeilingFinish(m, src, "gypsum_ceiling", {});
  setFloorFinish(m, src, "laminate", {});
  const exp = structuredClone(rooms);
  const got: Record<string, Record<string, unknown>> = {};
  const res = finishCompare(exp, got, undefined, undefined, "normalize");
  assert.ok(res.problems.length > 0, "есть расхождения");
  assert.equal(res.problems.length, res.losses.length, "по problem на loss");
  assert.deepEqual(res.problems, res.losses.map((l) => l.text), "тексты problems и losses совпадают");
});

// m3 ревью 342: откат n8 (возврат локальной problems с push в обход add) должен
// краснеть структурно — сторож исходника: внутри finishCompare нет кода problems.push
// (комментарии вырезаются, чтобы не ловить упоминания в тексте)
test("339 n8 (342 m3): в исходнике finishCompare нет problems.push", () => {
  const src = readFileSync(join(ROOT, "src", "model", "finish.ts"), "utf8");
  const start = src.indexOf("export function finishCompare");
  assert.ok(start >= 0, "finishCompare найден");
  const end = src.indexOf("\nexport ", start + 1);
  const body = src.slice(start, end > start ? end : undefined).replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(body, /problems\s*\.\s*push/, "problems собирается только из losses через add");
});

// n2 ревью 342: дедуп шага ластика (n9) закреплён тестом — мутация «шаги без
// дедупа» краснит: finish_ceiling_remove встречается ровно один раз
test("342 n2: ceiling+ceiling_complex — finish_ceiling_remove ровно один раз (n9)", () => {
  const hint = finishLossHint([
    { kind: "ceiling", text: "room r1: потеряно покрытие потолка" },
    { kind: "ceiling_complex", text: "room r1: потеряно двухуровневое покрытие потолка" },
  ] as FinishLoss[]);
  assert.match(hint, /finish_ceiling_set с другим покрытием/, `шаг complex: ${hint}`);
  assert.equal(hint.split("finish_ceiling_remove").length - 1, 1, `ластик без повтора: ${hint}`);
});

// n1 ревью 342: чужое покрытие потолка снимается тем же ластиком, что и своё —
// дедуп по инструменту, а не по виду
test("342 n1: foreign_ceiling не добавляет повтор finish_ceiling_remove", () => {
  const plain = finishLossHint([
    { kind: "ceiling", text: "room r1: потеряно покрытие потолка" },
    { kind: "foreign_ceiling", text: "room r1: часть получила чужое покрытие потолка" },
  ] as FinishLoss[]);
  assert.match(plain, /чужое покрытие потолка/, `вид назван: ${plain}`);
  assert.equal(plain.split("finish_ceiling_remove").length - 1, 1, `ластик без повтора: ${plain}`);
  const complex = finishLossHint([
    { kind: "ceiling_complex", text: "room r1: потеряно двухуровневое покрытие потолка" },
    { kind: "foreign_ceiling", text: "room r1: часть получила чужое покрытие потолка" },
  ] as FinishLoss[]);
  assert.match(complex, /finish_ceiling_set с другим покрытием/, `шаг complex: ${complex}`);
  assert.equal(complex.split("finish_ceiling_remove").length - 1, 1, `ластик без повтора: ${complex}`);
});

test("338 сторож: каждый вид из FINISH_LOSS_KINDS имеет запись в FINISH_LOSS_REGISTRY", () => {
  const reg = new Set(FINISH_LOSS_REGISTRY.map((r) => r.kind));
  for (const kind of FINISH_LOSS_KINDS) {
    assert.ok(reg.has(kind), `вид «${kind}» есть в FINISH_LOSS_KINDS, но без записи в FINISH_LOSS_REGISTRY`);
  }
  assert.equal(reg.size, FINISH_LOSS_KINDS.length, "в реестре есть виды вне FINISH_LOSS_KINDS или дубли");
  const orders = FINISH_LOSS_REGISTRY.map((r) => r.order).sort((a, b) => a - b);
  assert.deepEqual(orders, [...FINISH_LOSS_KINDS.keys()].map((i) => i + 1), "order — 1..N без дублей и пропусков");
});

test("338 сторож: у каждого снимаемого вида его инструмент есть в подсказке (удаление записи реестра краснит)", () => {
  for (const rule of FINISH_LOSS_REGISTRY) {
    if (rule.tool === null) continue;
    const hint = finishLossHint([{ kind: rule.kind, text: `room r1: <${rule.kind}>` }]);
    const escaped = rule.tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(hint, new RegExp(escaped), `инструмент вида ${rule.kind} в подсказке: ${hint}`);
    assert.match(hint, new RegExp(rule.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `название вида ${rule.kind} в подсказке: ${hint}`);
  }
});

test("338 сторож: подсказка строится по кодам, не по тексту — чужой двухуровневый потолок не даёт смену материала (n4)", () => {
  // случай foreignComplex из пробы 337: простой потолок, сосед по split — двухуровневый
  const m = corridorModel();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  const src = "_uwwgk";
  setCeilingFinish(m, src, "gypsum_ceiling", {});
  const exp = structuredClone(rooms);
  const part = (key: string, polygon: Array<{ x: number; y: number }>, foreignComplex: boolean): Record<string, unknown> => {
    const s = structuredClone(rooms[src]!) as unknown as Record<string, unknown>;
    s["polygon"] = polygon;
    if (foreignComplex) {
      s["ceilings"] = [{
        exist: true, id: `_cx_${key}`, polygon: polygon, material: "stretch_ceiling",
        complex: true, material2: "gypsum_ceiling", level2: 75, offset: 40, radius: 10, type: "closed", profile: "standard",
      }];
    }
    return s;
  };
  const got: Record<string, Record<string, unknown>> = {
    _part1: part("_part1", [{ x: 150, y: -290 }, { x: 290, y: -290 }, { x: 290, y: -10 }, { x: 150, y: -10 }], false),
    _part2: part("_part2", [{ x: 10, y: -290 }, { x: 150, y: -290 }, { x: 150, y: -10 }, { x: 10, y: -10 }], true),
  };
  const res = finishCompare(exp, got, undefined, undefined, "normalize");
  assert.ok(res.problems.some((p) => p.includes("чужое покрытие потолка")), `чужое покрытие — problem: ${JSON.stringify(res.problems)}`);
  assert.ok(res.losses.length > 0 && res.losses.every((l) => l.kind === "foreign_ceiling"), `каждая problem — foreign_ceiling: ${JSON.stringify(res.losses)}`);
  const hint = finishLossHint(res.losses as FinishLoss[]);
  assert.doesNotMatch(hint, /finish_ceiling_set/, `смена материала не по чужому покрытию (n4): ${hint}`);
  // n5 ревью 339: чужое покрытие снимается ластиком покрытия потолка исходной
  // комнаты (expCeils пустеет, проверка частей не выполняется) — инструмент назван
  assert.match(hint, /finish_ceiling_remove/, `инструмент чужого покрытия назван (n5): ${hint}`);
  assert.doesNotMatch(hint, /finish_floor_remove/, `пол не упоминается: ${hint}`);
  assert.doesNotMatch(hint, /details\.finish_mismatches/, `не запасной вариант: ${hint}`);
});
