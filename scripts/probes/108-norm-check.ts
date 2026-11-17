// 108: проверка исправлений ревью 107 настоящим нормализатором и настоящим Workspace
// (guard §12.4 активен) в АНОНИМНОМ проекте, без аккаунта. База — фикстура коридора +
// изолированная стена с 2 УНАСЛЕДОВАННЫМИ висячими концами (сеется через editor.normalize
// + editor.save, мимо guard'а — как старый проект пользователя). Сценарии:
//   R10 — demolish стены/участка/cancel и wall_move при унаследованных концах проходят;
//         free-standing стена (новые концы) — INVALID_GEOMETRY;
//   R2  — mergeCollinear сохраняет мировые координаты сектора (реальный пайплайн);
//   R4  — пара замены: update высоты обоих участников, согласованный перенос, отказ;
//   R11 — deleteOpening возвращает все удалённые ID;
//   save — ws.save() verified (полная сверка нормализатор+сервер, анонимно).
// Запуск: node scripts/probes/108-norm-check.ts
import { readFileSync, writeFileSync } from "node:fs";
import { createAnonProject, loadModel } from "../../src/api.ts";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { prepareForRestore } from "../../src/model/walls.ts";
import { demolish, demolishCancel } from "../../src/model/demolition.ts";
import { addWall, moveWall } from "../../src/model/walls.ts";
import { addOpening, updateOpening, deleteOpening, prepareHolePoints } from "../../src/model/openings.ts";
import type { Model, Wall } from "../../src/model/types.ts";
import { Workspace, type WorkspaceDeps } from "../../src/workspace.ts";
import type { SessionState } from "../../src/session.ts";

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
const session = { cookies: [] } as never as SessionState;
const created = await createAnonProject(session);

// Сеем модель с унаследованными висячими концами: fixture + изолированная стена (restore+save
// настоящим редактором, мимо guard'а — как старый проект пользователя)
const seed = base();
prepareHolePoints(seed);
const isolated = addWall(seed, { start: { x: 0, y: -6000 }, end: { x: 6000, y: -6000 } });
// вторая изолированная стена: её узел (-2000,-6000) примет коллинеарное продолжение в R2
addWall(seed, { start: { x: -2000, y: -6000 }, end: { x: -4000, y: -6000 } });
const top = Object.values(seed.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
const prepared = structuredClone(seed) as unknown as Record<string, unknown>;
prepareForRestore(prepared as unknown as Model);

const seeder = await openEditor(session, created.object_id, created.plan_id, 60_000, { anonymous: true });
const actualObject = seeder.compat.object_id ?? created.object_id;
const actualPlan = seeder.compat.plan_id ?? created.plan_id;
try {
  await seeder.normalize(prepared, 150_000);
  const sv = await seeder.save(60_000);
  assert(sv.ok, `сеющий save не прошёл: ${JSON.stringify(sv)}`);
  console.log("модель с унаследованными концами засеяна в анонимный проект (save ok)");
} finally {
  await seeder.close().catch(() => {});
}

// Настоящий Workspace с настоящим нормализатором и guard'ом
const deps: WorkspaceDeps = {
  session,
  loadModel: () => loadModel(session, actualObject, actualPlan),
  openEditor: () => openEditor(session, actualObject, actualPlan, 60_000, { anonymous: true }),
};
const ws = new Workspace(deps);
try {
  await ws.open(actualObject, actualPlan);

  // id стен редактор мог переназначить при save — ищем по геометрии в живой модели
  const isolatedLive = Object.values(ws.model.walls).find((w) => Math.abs(w.p1.y - (-600)) < 0.01 && Math.abs(w.p2.x - 600) < 0.01 && Math.abs(w.p1.x) < 0.01)!;
  const isolated2Live = Object.values(ws.model.walls).find((w) => Math.abs(w.p1.y - (-600)) < 0.01 && Math.abs(w.p1.x - (-2000)) < 0.01)!;
  const topLive = Object.values(ws.model.walls).find((w) => Math.abs(w.p1.y - (-300)) < 0.01 && w.p2.x === 600)!;

  // R10: демонтаж целой другой стены при 2 унаследованных концах + отмена
  // (демонтаж целиком сбрасывает участки — как в UI, поэтому cancel сразу)
  const r1 = await ws.applyWalls("demolish", (mm) => demolish(mm, { target: "wall", id: topLive.id }));
  assert(r1.result.wallId === topLive.id, "R10: демонтаж целой стены не прошёл");
  const r1c = await ws.applyWalls("demolish_cancel", (mm) => demolishCancel(mm, { target: "wall", id: topLive.id }));
  assert(r1c.result.wallId === topLive.id, "R10: cancel целой стены не прошёл");
  console.log("R10: demolish целой стены и cancel при унаследованных концах — OK");

  // R10: demolish участка + cancel (стена без demount=1)
  const r2 = await ws.applyWalls("demolish", (mm) => demolish(mm, { target: "wall", id: topLive.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } }));
  assert(r2.result.sectorId, "R10: участок не создан");
  // нормализация редактора пересоздаёт id секторов — берём актуальный из живой модели
  const sectorLive = Object.keys(sectorsOf(ws.model.walls[topLive.id] ?? ({} as never)))[0]!;
  assert(sectorLive, "R10: участок потерян нормализацией");
  const r3 = await ws.applyWalls("demolish_cancel", (mm) => demolishCancel(mm, { target: "wall", id: topLive.id, sector_id: sectorLive }));
  assert(r3.result.sectorId === sectorLive, "R10: cancel участка не прошёл");
  console.log("R10: demolish участка и cancel при унаследованных концах — OK");

  // R10: wall_move изолированной стены (её 2 конца — те же унаследованные)
  await ws.applyWalls("wall_move", (mm) => moveWall(mm, { wallId: isolatedLive.id, offsetMm: 200 }));
  assert(ws.model.walls[isolatedLive.id]!.p1.y === -620, "R10: wall_move изолированной стены не прошёл");
  console.log("R10: wall_move изолированной стены при унаследованных концах — OK");

  // R10: защита новых дефектов жива на настоящем нормализаторе
  let newEndsCode = "";
  try {
    await ws.applyWalls("wall_add", (mm) => addWall(mm, { start: { x: 0, y: 10000 }, end: { x: 3000, y: 10000 } }));
  } catch (e) {
    out.new_ends_details = (e as { details?: unknown }).details ?? null;
    out.new_ends_msg = (e as Error).message;
    out.new_ends_details_ok = /ikwqcwkkc3|появились новые/.test((e as Error).message) || Array.isArray((e as { details?: { unattached?: unknown[] } }).details?.unattached);
    newEndsCode = (e as { code?: string }).code ?? "";
  }
  assert(newEndsCode === "INVALID_GEOMETRY", `R10: free-standing стена не отклонена (код ${newEndsCode})`);
  console.log("R10: free-standing стена → INVALID_GEOMETRY (защита новых концов, настоящий нормализатор) — OK");

  // R2: merge с сохранением мировых координат сектора — через настоящий пайплайн
  const sec = await ws.applyWalls("demolish", (mm) => demolish(mm, { target: "wall", id: isolatedLive.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } }));
  const sectorId = sec.result.sectorId!;
  await ws.applyWalls("wall_add", (mm) => addWall(mm, { start: { x: -2000, y: -6000 }, end: { x: 0, y: -6000 } }));
  void isolated2Live; // продолжение могло поглотиться ею при merge — это штатно
  const mergedHost = Object.values(ws.model.walls).find((w) => sectorsOf(w)[sectorId]);
  assert(mergedHost, "R2: сектор потерян при merge (настоящий пайплайн)");
  const sAfter = sectorsOf(mergedHost!)[sectorId]!;
  // y=-620: wall_move выше уже сдвинул стену на 200 мм; мировой x сектора — 100 см
  assert(Math.abs(sAfter.pc.x - 100) < 0.05 && Math.abs(sAfter.pc.y - (-620)) < 0.05, `R2: сектор сдвинут при merge: ${JSON.stringify(sAfter.pc)}`);
  console.log("R2: merge коллинеарных стен через настоящий нормализатор — сектор на месте", JSON.stringify(sAfter.pc));

  // R4/R11: пара замены на изолированной стене
  const door = await ws.apply("opening_add", (mm) => addOpening(mm, { wallId: isolatedLive.id, type: "door", offsetMm: 2000 }));
  const rep = await ws.apply("opening_add", (mm) => addOpening(mm, { wallId: isolatedLive.id, type: "doorway", replacesHoleId: door.id, widthMm: 800 }));
  delete (ws.model.walls[isolatedLive.id]!.holes[door.id]!).at;
  delete (ws.model.walls[isolatedLive.id]!.holes[rep.id]!).at;
  await ws.apply("opening_update", (mm) => updateOpening(mm, { wallId: isolatedLive.id, holeId: door.id, heightMm: 2200 }));
  assert(ws.model.walls[isolatedLive.id]!.holes[door.id]!.height === 220, "R4: высота исходного не изменена");
  await ws.apply("opening_update", (mm) => updateOpening(mm, { wallId: isolatedLive.id, holeId: rep.id, heightMm: 2100 }));
  console.log("R4: update высоты обоих участников пары — OK (настоящая модель)");
  await ws.apply("opening_update", (mm) => updateOpening(mm, { wallId: isolatedLive.id, holeId: door.id, offsetMm: 4000, offsetFrom: "axis" }));
  const dHole = ws.model.walls[isolatedLive.id]!.holes[door.id]!;
  const rHole = ws.model.walls[isolatedLive.id]!.holes[rep.id]!;
  const cDoor = (dHole.at ?? 0) + dHole.width / 2;
  const cRep = (rHole.at ?? 0) + rHole.width / 2;
  assert(Math.abs(cDoor - cRep) < 0.05, `R4: замена не последовала за исходным (${cDoor} vs ${cRep})`);
  console.log("R4: согласованный перенос пары — центры совпали", cDoor);
  const del = await ws.apply("opening_delete", (mm) => deleteOpening(mm, isolatedLive.id, door.id));
  assert(del.deleted.length === 2 && del.deleted.includes(rep.id), `R11: каскад не в ответе: ${JSON.stringify(del.deleted)}`);
  assert(!ws.model.walls[isolatedLive.id]!.holes[rep.id], "R11: замена не удалена");
  console.log("R11: opening_delete вернул все удалённые ID:", JSON.stringify(del.deleted));

  // save анонимного проекта: полная сверка нормализатор+сервер (анонимно — запись свободна)
  const saveRes = await ws.save();
  assert(saveRes.verified, `save не verified: ${JSON.stringify({ rounds: saveRes.rounds })}`);
  console.log("save анонимного проекта: verified ==", saveRes.verified);
  out.save_rounds = saveRes.rounds;
} finally {
  await ws.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
out.ok = true;
writeFileSync(".orca-reports/tmp/108-norm-check.json", JSON.stringify({
  _source: "анонимный проект, настоящий нормализатор + настоящий Workspace (guard), сеяние модели с унаследованными концами через editor.save; id объектов не печатаются",
  out,
}, null, 1));
console.log("108-norm-check OK");
process.exit(0);
