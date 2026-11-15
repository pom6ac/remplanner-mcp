// Снять обезличенный эталон нормализованной модели «коридор + 3 комнаты» (T27).
// Анонимный проект: restore голой геометрии (T24 сценарий B) → draw → save → GET.
// Запуск вне песочницы: node scripts/probes/dump-corridor-fixture.ts
import { writeFileSync } from "node:fs";
import { createAnonProject, loadModel } from "../../src/api.ts";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import type { Model, SessionState, Wall, Point } from "../../src/model/types.ts";
import { prepareWallFaces } from "../../src/model/walls.ts";

const D = 20; // толщина, см

type Spec = { p1: Point; p2: Point };
const h = D / 2;
// оси: внешний прямоугольник x∈[0,600], y∈[-300,120]; коридор y=0; перегородки x=300, x=500
const SPECS: Spec[] = [
  { p1: { x: 0, y: -300 }, p2: { x: 600, y: -300 } },
  { p1: { x: 600, y: -300 }, p2: { x: 600, y: 120 } },
  { p1: { x: 600, y: 120 }, p2: { x: 0, y: 120 } },
  { p1: { x: 0, y: 120 }, p2: { x: 0, y: -300 } },
  { p1: { x: 0 + h, y: 0 }, p2: { x: 600 - h, y: 0 } },
  { p1: { x: 300, y: -300 + h }, p2: { x: 300, y: 0 - h } },
  { p1: { x: 500, y: -300 + h }, p2: { x: 500, y: 0 - h } },
];

function bareModel(id: string): Model {
  const model: Model = {
    v: 3, id, plan_id: "0",
    walls: {}, items: {}, pillars: {}, rulers: {}, comments: {},
    total_height: 270, final: false,
  };
  for (const [i, s] of SPECS.entries()) {
    const wall: Wall = {
      id: `w${i + 1}`, plan: "a", role: "wall", child: 0, archive: 0, demount: 0,
      depth: D, height: 270, p1: { ...s.p1 }, p2: { ...s.p2 }, p1st: 0, p2st: 0,
      material: "a_block", color: 0, level: "1", show_dls: true, holes: {},
    };
    model.walls[wall.id] = wall;
  }
  prepareWallFaces(model);
  return model;
}

const session: SessionState = { cookies: [] };
const created = await createAnonProject(session);
console.log("anon project:", created.object_id);
const editor = await openEditor(session, created.object_id, created.plan_id || "1", 30_000, { anonymous: true });
try {
  const model = bareModel(created.object_id);
  const norm = await editor.normalize(structuredClone(model) as unknown as Record<string, unknown>, 1200);
  const areas = norm.rooms.map((r) => r.area_m2).sort((a, b) => (b ?? 0) - (a ?? 0));
  console.log("walls:", norm.after.walls, "rooms:", JSON.stringify(areas));
  if (norm.after.walls !== 7 || norm.rooms.length !== 4) {
    throw new Error(`неожиданный результат: ${norm.after.walls} стен, ${norm.rooms.length} комнат`);
  }
  const save = await editor.save();
  console.log("save:", JSON.stringify(save));
  if (!save.ok) throw new Error("save не прошёл");
  const reloaded = await loadModel(session, editor.objectId, editor.planId);
  const walls = reloaded.model["walls"] as Record<string, unknown>;
  const rooms2 = (reloaded.model["rooms2"] ?? {}) as Record<string, unknown>;
  console.log("reload: walls =", Object.keys(walls).length, "rooms2 =", Object.keys(rooms2).length);
  const envelope = {
    _source: "GET-модель анонимного проекта после restore голой геометрии «коридор + 3 комнаты» " +
      "(оси как в .orca-reports/10-editor-api-probe.json сценарий B, global_version 757) → draw → save → reload; " +
      `снят scripts/probes/dump-corridor-fixture.ts 2026-11-15, object_id ${editor.objectId} (аноним, аккаунт не использовался)`,
    global_version: "757",
    model: reloaded.model,
  };
  writeFileSync("tests/fixtures/editor-corridor-3rooms.json", JSON.stringify(envelope, null, 1) + "\n");
  console.log("written tests/fixtures/editor-corridor-3rooms.json");
} finally {
  await editor.close();
  await closeBrowser().catch(() => {});
}
