// 142: свободные концы стен — стандарт remplanner (отчёт 132 часть 1, FAQ 2.1).
// Эталоны ui-ref-free-wall-{partition,a}.json — клики UI в анонимном проекте
// (проба scripts/probes/142-free-wall-fixtures.ts): ГКЛ-перегородка plan:"c" и
// стена plan:"a" с двумя свободными концами. Эталоны сняты БЕЗ save (форма модели
// после draw); сохранение свободных стен без потерь подтверждено живыми пробами
// 132 и 142 (save verified → reopen → стены на месте, errors — нули), не эталоном.
// Здесь: модельный слой воспроизводит эталонную семантику; mock save сверяет
// присланные стены с эталоном (план, материал, глубина) и пишет точную форму из
// редактора — verified без ложной потери (дрейф координат 10.999 vs 11).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model, Wall } from "../../src/model/types.ts";
import { addWall, addPolyline, findUnattachedEnds } from "../../src/model/walls.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { NormalizeResult } from "../../src/editor/adapter.ts";
import type { LoadedModel } from "../../src/api.ts";
import { fileURLToPath } from "node:url";

const PART_REF = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/ui-ref-free-wall-partition.json", import.meta.url)), "utf8"),
) as { _source: string; walls: Record<string, Wall> };
const A_REF = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/ui-ref-free-wall-a.json", import.meta.url)), "utf8"),
) as { _source: string; walls: Record<string, Wall> };

const partitionRef = Object.values(PART_REF.walls)[0]!;
const wallARef = Object.values(A_REF.walls)[0]!;

function emptyModel(): Model {
  return { walls: {} } as unknown as Model;
}

/** Ось эталонной стены в мм (из координат эталона). */
function refAxisMm(w: Wall): { start: { x: number; y: number }; end: { x: number; y: number } } {
  return {
    start: { x: Math.round(w.p1.x * 10), y: Math.round(w.p1.y * 10) },
    end: { x: Math.round(w.p2.x * 10), y: Math.round(w.p2.y * 10) },
  };
}

test("142: wall_add свободной перегородки воспроизводит эталон ui-ref-free-wall-partition", () => {
  const m = emptyModel();
  const axis = refAxisMm(partitionRef);
  const w = addWall(m, { ...axis, plan: "c", material: "c_gypsum", thicknessMm: 100, heightMm: 2700 });
  assert.equal(w.plan, partitionRef.plan);
  assert.equal(w.role, partitionRef.role);
  assert.equal(w.material, partitionRef.material);
  assert.equal(w.depth, partitionRef.depth);
  assert.equal(w.height, partitionRef.height);
  assert.equal(w.p1.link, undefined, "p1 без связи (свободный конец)");
  assert.equal(w.p2.link, undefined, "p2 без связи (свободный конец)");
  const dangling = findUnattachedEnds(Object.values(m.walls));
  assert.equal(dangling.length, 2, "оба конца несоединённые");
});

test("142: wall_add свободной стены воспроизводит эталон ui-ref-free-wall-a", () => {
  const m = emptyModel();
  const axis = refAxisMm(wallARef);
  const w = addWall(m, { ...axis, plan: "a", material: "a_block", thicknessMm: 100, heightMm: 2700 });
  assert.equal(w.plan, wallARef.plan);
  assert.equal(w.role, wallARef.role);
  assert.equal(w.material, wallARef.material);
  assert.equal(w.depth, wallARef.depth);
  assert.equal(w.height, wallARef.height);
  const dangling = findUnattachedEnds(Object.values(m.walls));
  assert.equal(dangling.length, 2);
});

test("142: walls_add_polyline свободной ломаной — внутренний узел соединён, 2 внешних конца", () => {
  const m = emptyModel();
  const walls = addPolyline(m, {
    points: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 2000 }],
    plan: "c",
    material: "c_gypsum",
    thicknessMm: 100,
    heightMm: 2700,
  });
  assert.equal(walls.length, 2, "два сегмента ломаной");
  const dangling = findUnattachedEnds(Object.values(m.walls));
  assert.equal(dangling.length, 2, `внешних свободных конца 2 (общий узел сегментов соединён): ${JSON.stringify(dangling)}`);
});

// ---------- mock save verified на точной форме из редактора ----------

type EditorModel = Record<string, unknown>;

/**
 * Mock-редактор на эталонной форме: normalize отдаёт стены модели, дополненные
 * эталонной перегородкой с дрейфом координат редактора (p2.y = 10.999…), save
 * сверяет присланные стены с эталоном (план, материал, глубина — ревью 144 M4:
 * неверная стена от Workspace падает на assert, а не молча «сохраняется»; id
 * редактор перегенерирует при restore, сверяется семантика) и пишет точную
 * форму из редактора — verified без ложной потери (дрейф координат 10.999 vs 11).
 */
function fixtureEditor(partition: Wall, extraFree: Wall): { editor: EditorLike; server: { saveId: string; model: EditorModel } } {
  const server: { saveId: string; model: EditorModel } = { saveId: "s1", model: { walls: {} } };
  const refs = new Map([[partition.id, partition], [extraFree.id, extraFree]]);
  let sentWalls: Record<string, Wall> = {};
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(model) {
      const copy = structuredClone(model) as Model & Record<string, unknown>;
      sentWalls = structuredClone(copy.walls as Record<string, Wall>);
      // редактор при restore пересчитывает координаты (дрейф ~1e-12, эталон 10.999)
      const walls = Object.values(copy.walls as Record<string, Wall>).map((w) => ({ id: w.id, p1: w.p1, p2: w.p2, depth: w.depth }));
      const c = { walls: walls.length, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: copy, rooms: [], before: c, after: c, walls, errors: null } as unknown as NormalizeResult;
    },
    async save() {
      // сверка присланных стен с эталоном перед подменой (ревью 144 M4): id
      // редактор перегенерирует при restore, сверяем план/материал/глубину
      const sigOf = (w: Wall): string => `${w.plan}/${w.material}/${w.depth}`;
      assert.deepEqual(
        Object.values(sentWalls).map(sigOf).sort(),
        [...refs.values()].map(sigOf).sort(),
        `присланные стены соответствуют эталону: ${JSON.stringify(Object.values(sentWalls).map((w) => ({ plan: w.plan, material: w.material, depth: w.depth })))}`,
      );
      // редактор сохраняет точную эталонную форму (как в пробе 142 после save)
      const saved = structuredClone({ walls: { [partition.id]: partition, [extraFree.id]: extraFree } }) as unknown as EditorModel;
      server.model = saved;
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { global_version: null, planner_version: null, bundles: [], object_id: "0", plan_id: "1", present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } } as never; },
    async close() {},
  };
  return { editor, server };
}

function wsDeps(editor: EditorLike, server: { saveId: string; model: EditorModel }): WorkspaceDeps {
  return {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: server.saveId, units: "cm", data_empty: false, model: structuredClone(server.model) };
    },
    async openEditor() { return editor; },
  };
}

test("142: mock save свободной перегородки и стены — verified, свободные стены не «теряются»", async () => {
  // эталонная форма из редактора: перегородка с дрейфом p2.y = 10.999… и стена plan:"a"
  const partition = structuredClone(partitionRef);
  const freeA = structuredClone(wallARef);
  const { editor, server } = fixtureEditor(partition, freeA);
  const ws = new Workspace(wsDeps(editor, server));
  ws.writeBackup = () => "/mock/no-write";
  await ws.open("0", "1");
  // пользователь строит обе свободные стены инструментами MCP (мм-ось эталона)
  const partAxis = refAxisMm(partitionRef);
  const aAxis = refAxisMm(wallARef);
  const { warnings } = await ws.applyWalls("wall_add", (mm) => {
    const p = addWall(mm, { ...partAxis, plan: "c", material: "c_gypsum", thicknessMm: 100, heightMm: 2700 });
    const a = addWall(mm, { ...aAxis, plan: "a", material: "a_block", thicknessMm: 100, heightMm: 2700 });
    return { p: p.id, a: a.id };
  });
  assert.ok(warnings.some((w) => w.startsWith("wall_free_ends")), `wall_free_ends в warnings: ${JSON.stringify(warnings)}`);
  // save: редакторская форма (дрейф 10.999 vs 11) не должна дать ложную потерю
  const res = await ws.save();
  assert.equal(res.verified, true, `свободные стены сохраняются verified, rounds=1: ${JSON.stringify({ verified: res.verified, rounds: res.rounds, warnings: res.warnings })}`);
  assert.equal(res.rounds, 1);
  // после verified save каноническая модель — серверная (эталонные id редактора)
  const serverWalls = Object.values(ws.model.walls);
  assert.equal(serverWalls.length, 2, `обе свободные стены на сервере: ${JSON.stringify(Object.keys(ws.model.walls))}`);
  for (const w of serverWalls) {
    assert.equal(w.p1.link, undefined, `p1 без связи у ${w.id}`);
    assert.equal(w.p2.link, undefined, `p2 без связи у ${w.id}`);
  }
  assert.ok(serverWalls.some((w) => w.material === "c_gypsum" && w.plan === "c"), "свободная перегородка сохранилась без потерь");
  assert.ok(serverWalls.some((w) => w.material === "a_block" && w.plan === "a"), "свободная стена сохранилась без потерь");
});
