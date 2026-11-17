// 103: проверка операций со стенами настоящим нормализатором на синтетике БЕЗ save.
// Анонимный проект, аккаунт не используется. Сценарий (как в юнит-тестах prepareScenario):
// демонтаж стены/участка/проёма, перегородка c_*, замена проёма, ГКЛ-короб —
// модель через prepareForRestore → editor.normalize → сверка флагов, секторов,
// материалов, замены и короба; комнаты и отделка не теряются.
// Запуск: node scripts/probes/103-norm-check.ts
import { readFileSync, writeFileSync } from "node:fs";
import { createAnonProject } from "../../src/api.ts";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { prepareForRestore } from "../../src/model/walls.ts";
import { demolish, demolitionSignature, demolitionMismatches } from "../../src/model/demolition.ts";
import { addWall } from "../../src/model/walls.ts";
import { addOpening } from "../../src/model/openings.ts";
import { addPillar } from "../../src/model/pillars.ts";
import { compactModel } from "../../src/model/compact.ts";
import type { Model } from "../../src/model/types.ts";

const FIXTURE = "tests/fixtures/editor-corridor-3rooms.json";
type Any = any;

function scenario(stage: "base" | "demolish" | "partition" | "replacement" | "box" | "all"): Model {
  const m = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  let door: Any = null;
  if (stage === "replacement" || stage === "all") {
    door = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 1100 });
    const rep = addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: door.id });
    // эталон замены (ui-ref-replan-replacement): у нового проёма есть parent/parent_depth,
    // offset, dls_prs, pcb/p1b/p2b — эксперимент: без них restore падает?
    rep.parent = corridor.id;
    rep.parent_depth = corridor.depth;
    rep.dls_prs = {};
    rep.offset = 0;
    rep.pcb = { ...rep.pc };
    rep.p1b = { ...rep.p1 };
    rep.p2b = { ...rep.p2 };
  }
  const door2 = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 3000 });
  if (stage === "demolish" || stage === "all") {
    demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
    demolish(m, { target: "wall", id: (Object.values(m.walls).find((w) => Math.abs(w.p1.x - 500) < 1))!.id });
    demolish(m, { target: "opening", id: door2.id });
  }
  if (stage === "partition" || stage === "all") {
    addWall(m, { start: { x: 1500, y: -2900 }, end: { x: 1500, y: -100 }, thicknessMm: 100, material: "c_pgb", plan: "c" });
  }
  if (stage === "box" || stage === "all") {
    const roomsArg = Object.entries<any>(m.rooms2 ?? {}).map(([rid, r]) => ({ roomId: rid, polygon: r.polygon ?? r.zones?.[0]?.polygon, areaCm2: 0, axisAreaCm2: null }));
    addPillar(m, { center: { x: 5500, y: -1500 }, kind: "gypsum_box" }, roomsArg as never);
  }
  return m;
}

const session = { cookies: [] };
const created = await createAnonProject(session as never);
const STAGE = (process.argv.find((a) => a.startsWith("--stage="))?.slice(8) ?? "all") as
  "base" | "demolish" | "partition" | "replacement" | "box" | "all";
const model = scenario(STAGE);
const partId = Object.keys(model.walls).find((k) => model.walls[k]!.material === "c_pgb") ?? "";
const boxId = Object.keys(model.pillars ?? {}).find((k) => (model.pillars as Any)[k]!.role === "gypsum") ?? "";
console.log("stage:", STAGE, "part:", partId || "—", "box:", boxId || "—");
const prepared = structuredClone(model) as unknown as Record<string, unknown>;
prepareForRestore(prepared as unknown as Model);

const editor = await openEditor(session as never, created.object_id, created.plan_id, 60_000, { anonymous: true });
const out: Record<string, unknown> = { stage: STAGE };
try {
  const norm = await editor.normalize(prepared, 1500) as Any;
  const after = norm.model as Model;
  const wallsAfter = after.walls as Record<string, Any>;

  // 1. демонтаж: флаги и участки пережили нормализацию
  const topId = Object.keys(model.walls).find((k) => model.walls[k]!.p1.y === -300 && model.walls[k]!.p2.x === 600)!;
  const sigBefore = demolitionSignature(model.walls[topId]!);
  const sigAfter = topId in wallsAfter ? demolitionSignature(wallsAfter[topId]!) : null;
  out.demolition = { survived: !!sigAfter, sigBefore, sigAfter };
  console.log("демонтаж верхней стены:", sigAfter ? JSON.stringify(sigAfter) : "СТЕНА ПОТЕРЯНА");
  const mism = demolitionMismatches(model.walls as never, wallsAfter as never);
  console.log("сверка демонтажа после нормализации:", mism.length === 0 ? "OK" : JSON.stringify(mism));
  out.demolition_mismatches = mism;

  // 2. перегородка: id, план, материал
  const gotPart = wallsAfter[partId];
  out.partition = gotPart ? { plan: gotPart.plan, material: gotPart.material, depth: gotPart.depth } : null;
  console.log("перегородка:", gotPart ? JSON.stringify(out.partition) : "ПОТЕРЯНА");

  // 3. замена проёма: hasReplacement + новый проём plan c
  const corridorId = Object.keys(model.walls).find((k) => Math.abs(model.walls[k]!.p1.y) < 1 && Math.abs(model.walls[k]!.p2.y) < 1)!;
  const holesAfter = (wallsAfter[corridorId]?.holes ?? {}) as Record<string, Any>;
  const replaced = Object.values(holesAfter).filter((h) => h.hasReplacement);
  const planC = Object.values(holesAfter).filter((h) => h.plan === "c");
  const demHole = Object.values(holesAfter).filter((h) => h.demount === 1);
  out.holes = { replaced: replaced.length, planC: planC.length, demounted: demHole.length };
  console.log("проёмы: заменённых", replaced.length, "plan-c", planC.length, "демонтированных", demHole.length);

  // 4. короб
  const pillarsAfter = (after.pillars ?? {}) as Record<string, Any>;
  const gotBox = boxId ? pillarsAfter[boxId] : null;
  out.box = gotBox ? { role_: gotBox.role_, plan: gotBox.plan, id_room: gotBox.id_room } : null;
  console.log("короб:", gotBox ? JSON.stringify(out.box) : "ПОТЕРЯН");

  // 5. комнаты листа «c»: перегородка разделила комнату? (число комнат не упало)
  const roomsAfter = Object.keys((after.rooms2 ?? after.rooms1 ?? {}) as Any).length;
  out.rooms = roomsAfter;
  console.log("комнат после нормализации:", roomsAfter);

  // 6. компакт читаем
  out.compactWalls = compactModel(after).walls.length;
  console.log("компакт стен:", out.compactWalls);
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
writeFileSync(".orca-reports/103-norm-check.json", JSON.stringify({ _source: "анонимный проект, синтетическая база, editor.normalize без save; id не печатаются", out }, null, 1));
console.log("103-norm-check OK");
process.exit(0);
