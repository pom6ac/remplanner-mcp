// 106: проверка исправлений ревью 105 настоящим нормализатором на синтетике БЕЗ save.
// Анонимный проект, аккаунт не используется. Сценарии:
//   R2 — сектор демонтажа при wall_move/wall_update/wall_split (перенос, распределение,
//        отказ при сокращении);
//   R3/R4 — замена проёма: центр по holeRange, жизненный цикл пары (удаление замены
//        снимает hasReplacement, удаление исходного удаляет замену, split переносит пару);
//   R5 — сверка demount/hasReplacement после нормализации (demolitionMismatches пуст).
// Запуск: node scripts/probes/106-norm-check.ts
import { readFileSync, writeFileSync } from "node:fs";
import { createAnonProject } from "../../src/api.ts";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { prepareForRestore } from "../../src/model/walls.ts";
import { demolish, demolitionMismatches } from "../../src/model/demolition.ts";
import { addWall, moveWall, updateWall, splitWall, deleteWall } from "../../src/model/walls.ts";
import { addOpening, deleteOpening } from "../../src/model/openings.ts";
import type { Model, Wall } from "../../src/model/types.ts";

const FIXTURE = "tests/fixtures/editor-corridor-3rooms.json";
const WATCHDOG = setTimeout(() => {
  console.error("TIMEOUT: общий watchdog 8 минут истёк");
  process.exit(90);
}, 8 * 60_000);
WATCHDOG.unref();

function base(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}
const sectorsOf = (w: Wall): Record<string, { id: string; pc: { x: number; y: number }; width: number }> =>
  (w.sectors ?? {}) as Record<string, { id: string; pc: { x: number; y: number }; width: number }>;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const out: Record<string, unknown> = {};

function scenario(): Model {
  const m = base();

  // R2: сектор переезжает вместе со стеной
  const w1 = addWall(m, { start: { x: 0, y: -6000 }, end: { x: 6000, y: -6000 } });
  demolish(m, { target: "wall", id: w1.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  moveWall(m, { wallId: w1.id, offsetMm: 200 });
  const s1 = Object.values(sectorsOf(w1))[0]!;
  assert(Math.abs(s1.pc.y - (-620)) < 0.05 && Math.abs(s1.pc.x - 100) < 0.05, `R2 move: pc ${JSON.stringify(s1.pc)}`);
  console.log("R2 move: сектор на новой оси, pc =", JSON.stringify(s1.pc));

  // R2: сокращение с участком за концом — атомарный отказ; после удлинения — на месте
  let refused = false;
  try {
    updateWall(m, { wallId: w1.id, lengthMm: 1000 });
  } catch (e) {
    refused = (e as { code?: string }).code === "INVALID_ARGUMENT";
  }
  assert(refused, "R2: сокращение не отклонено");
  updateWall(m, { wallId: w1.id, lengthMm: 7000 });
  assert(Object.values(sectorsOf(w1))[0]!.pc.x === 100, "R2: удлинение сохранило сектор");
  console.log("R2 update: сокращение отклонено атомарно, удлинение сохранило сектор");

  // R2: split — сектор остаётся в первой половине (центр t=100 см), у второй — пусто
  const { first: f1, second: sec1 } = splitWall(m, w1.id, 3000);
  assert(Object.keys(sectorsOf(f1)).length === 1 && Object.keys(sectorsOf(sec1)).length === 0, "R2 split: распределение по половинам");
  console.log("R2 split: сектор в первой половине, у второй стенки секторов нет");

  // R2/R4: вторая стена — сектор во второй половине и пара замены, split переносит пару
  const w2 = addWall(m, { start: { x: 0, y: -9000 }, end: { x: 6000, y: -9000 } });
  demolish(m, { target: "wall", id: w2.id, range: { from: "start", offset_mm: 3500, length_mm: 1000 } });
  const door = addOpening(m, { wallId: w2.id, type: "door", offsetMm: 4000 });
  const rep = addOpening(m, { wallId: w2.id, type: "doorway", replacesHoleId: door.id, widthMm: 800 });
  assert(Math.abs(rep.pc.x - door.pc.x) < 0.05, `R3: центр замены ${rep.pc.x} ≠ ${door.pc.x}`);
  console.log("R3: центр замены = центр исходного (UI-проём с at)");

  // R4: удаление замены снимает hasReplacement, повторная замена возможна
  deleteOpening(m, w2.id, rep.id);
  assert(!door.hasReplacement, "R4: hasReplacement не снят");
  const rep2 = addOpening(m, { wallId: w2.id, type: "doorway", replacesHoleId: door.id, widthMm: 800 });
  console.log("R4: удаление замены сняло hasReplacement, повторная замена создана");

  // R4: split — пара переезжает во вторую стену, parent обновляется
  const { first: f2, second: sec2 } = splitWall(m, w2.id, 3000);
  assert(sec2.holes[door.id] && sec2.holes[rep2.id], "R4 split: пара не в одной половине");
  assert(sec2.holes[rep2.id]!.parent === sec2.id, "R4 split: parent не обновлён");
  assert(f2.holes[door.id] === undefined, "R4 split: исходный остался в первой стене");
  const secSector = Object.values(sectorsOf(sec2))[0]!;
  assert(Math.abs(secSector.pc.x - 400) < 0.05, `R2 split: сектор второй половины pc=${secSector.pc.x}`);
  deleteWall(m, f2.id);
  const wall2 = Object.values(m.walls).find((x) => (x.holes ?? {})[rep2.id]);
  assert(wall2.holes[rep2.id]!.parent === wall2.id, "R4: висячий parent после deleteWall");
  console.log("R2/R4 split: сектор и пара во второй стене, parent корректен, deleteWall без висячих ссылок");

  // R7: проём без at — участок внутри проёма отклоняется
  const w3 = addWall(m, { start: { x: 0, y: -12000 }, end: { x: 6000, y: -12000 } });
  const door3 = addOpening(m, { wallId: w3.id, type: "door", offsetMm: 2000 });
  delete door3.at;
  let ref7 = false;
  try {
    demolish(m, { target: "wall", id: w3.id, range: { from: "start", offset_mm: 2200, length_mm: 300 } });
  } catch (e) {
    ref7 = (e as { code?: string }).code === "INVALID_ARGUMENT";
  }
  assert(ref7, "R7: участок внутри проёма без at не отклонён");
  console.log("R7: demolish участка внутри UI-проёма без at отклонён атомарно");

  // R5: демонтаж стены целиком + демонтаж проёма — оба флага в сигнатуре
  const w4 = addWall(m, { start: { x: 0, y: -15000 }, end: { x: 6000, y: -15000 } });
  const door4 = addOpening(m, { wallId: w4.id, type: "door", offsetMm: 2000 });
  demolish(m, { target: "wall", id: w4.id });
  demolish(m, { target: "opening", id: door4.id });
  console.log("R5: демонтаж целиком + демонтаж проёма выставлены");

  return m;
}

const session = { cookies: [] };
const created = await createAnonProject(session as never);
const model = scenario();
const prepared = structuredClone(model) as unknown as Record<string, unknown>;
prepareForRestore(prepared as unknown as Model);

const editor = await openEditor(session as never, created.object_id, created.plan_id, 60_000, { anonymous: true });
try {
  const norm = await editor.normalize(prepared, 1500) as { model: Model };
  const after = norm.model;
  const wallsAfter = after.walls as Record<string, Wall>;

  // сверка демонтажа (включая hasReplacement и свойства замены) после настоящей нормализации
  const mism = demolitionMismatches(model.walls as never, wallsAfter as never);
  out.demolition_mismatches = mism;
  console.log("сверка демонтажа после нормализации:", mism.length === 0 ? "OK" : JSON.stringify(mism));
  assert(mism.length === 0, "R5: нормализация потеряла пометки демонтажа/замены");

  // R5: демонтаж целиком — проёмы сверяются: потеря demount проёма должна давать расхождение
  const w4id = Object.keys(model.walls).find((k) => Math.abs(model.walls[k]!.p1.y - (-1500)) < 0.01);
  if (w4id && wallsAfter[w4id]) {
    const hid = Object.keys(model.walls[w4id]!.holes ?? {})[0]!;
    const clone = structuredClone(wallsAfter[w4id]!);
    delete (clone.holes ?? {})[hid]?.demount;
    const mism2 = demolitionMismatches({ [w4id]: wallsAfter[w4id] } as never, { [w4id]: clone } as never);
    assert(mism2.length > 0, "R5: потеря demount проёма при demount=1 не видна сверке");
    console.log("R5: потеря demount проёма при демонтаже стены целиком — расхождение OK");
  }

  // пары после нормализации: hasReplacement и parent сохранены
  const secId = Object.keys(model.walls).find((k) => Math.abs(model.walls[k]!.p1.y - (-900)) < 0.01 && model.walls[k]!.p2.x === 600);
  void secId;
  let pairsOk = 0;
  for (const w of Object.values(wallsAfter)) {
    for (const h of Object.values(w.holes ?? {})) {
      if (h.hasReplacement === 1) {
        const rep = Object.values(w.holes ?? {}).find((o) => o.plan === "c" && o.parent === w.id);
        if (rep) pairsOk++;
      }
    }
  }
  out.pairs = pairsOk;
  console.log("пар замена/исходный после нормализации:", pairsOk);
  assert(pairsOk >= 1, "R5: пара замены потеряна при нормализации");

  console.log("106-norm-check OK");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
writeFileSync(".orca-reports/tmp/106-norm-check.json", JSON.stringify({
  _source: "анонимный проект, синтетическая база, editor.normalize без save; id объектов не печатаются",
  out,
}, null, 1));
process.exit(0);
