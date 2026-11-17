// 103: тесты раздела «Перепланировка» — демонтаж и перегородки: эталоны UI в обе стороны,
// атомарность, замена проёма, ГКЛ-короб, сверка демонтажа, mock save, компакт, тарифный гейт.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model } from "../../src/model/types.ts";
import {
  demolish, demolishCancel, demolitionMismatches, demolitionSignature,
  PARTITION_MATERIALS, PARTITION_PRO_MATERIALS, partitionMaterialCode,
} from "../../src/model/demolition.ts";
import { addWall } from "../../src/model/walls.ts";
import { addOpening } from "../../src/model/openings.ts";
import { addPillar } from "../../src/model/pillars.ts";
import { compactModel } from "../../src/model/compact.ts";
import { Workspace, type WorkspaceDeps } from "../../src/workspace.ts";
import type { EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { ServerContext } from "../../src/server/context.ts";
import { planTools } from "../../src/server/tools-plan.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;
const DEMO_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-replan-demolition.json", "utf8")) as {
  break_whole: { demount: number; p1: { demount: number }; p2: { demount: number } };
  break_part: { sectors: Record<string, { id: string; pc: { x: number; y: number }; width: number }> };
  break_door: { holes: Record<string, { plan: string; type: string; demount: number }> };
  remove_break: { demount: number; p1: { demount: number }; p2: { demount: number } };
};
const PART_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-replan-partitions.json", "utf8")) as Record<string, Record<string, {
  plan: string; material: string; depth: number; height: number;
}>>;
const REPL_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-replan-replacement.json", "utf8")) as {
  original_hole: { plan: string; hasReplacement: number };
  new_hole: { plan: string; position: string };
};
const BOX_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-replan-gypsum-box.json", "utf8")) as {
  pillar: { plan: string; role: string; role_: string; width: number; height: number; total_height: number; inRoom: number; id_room: string };
};

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

const wallByGeom = (m: Model, test: (w: { p1: { x: number; y: number }; p2: { x: number; y: number } }) => boolean): string => {
  const w = Object.values(m.walls).find(test);
  assert.ok(w, "стена найдена");
  return w!.id;
};

// ---------- материалы перегородок (эталон ui-ref-replan-partitions) ----------

test("103: коды материалов перегородок — как в эталоне UI (c_*)", () => {
  assert.equal(PARTITION_MATERIALS.pgb, "c_pgb");
  assert.equal(PARTITION_MATERIALS.foam_block, "c_block");
  assert.equal(PARTITION_MATERIALS.brick, "c_brick");
  assert.equal(PARTITION_MATERIALS.gypsum, "c_gypsum");
  assert.equal(PARTITION_MATERIALS.glass, "c_glass");
  assert.equal(PARTITION_MATERIALS.bar, "c_bar");
  assert.equal(partitionMaterialCode(undefined), "c_pgb");
  assert.equal(partitionMaterialCode("c_gypsum"), "c_gypsum");
  for (const key of Object.keys(PART_REF).filter((k) => !k.startsWith("_"))) {
    for (const wall of Object.values(PART_REF[key]!)) {
      assert.equal(wall.plan, "c");
      assert.equal(wall.depth, 10);
      assert.ok(wall.material.startsWith("c_"), `материал перегородки c_*: ${wall.material}`);
    }
  }
});

test("103: материал перегородки — a_* и неизвестный — INVALID_ARGUMENT, модель не меняется", () => {
  const m = baseModel();
  const before = JSON.stringify(m.walls);
  assert.throws(() => addWall(m, { start: { x: 1000, y: -1500 }, end: { x: 1000, y: -100 }, material: "a_block", plan: "c" } as never), /материал исходных стен/);
  assert.throws(() => partitionMaterialCode("marble"), /неизвестный материал/);
  assert.equal(JSON.stringify(m.walls), before);
});

test("103: PRO-материалы glass/bar — в отдельном множестве", () => {
  assert.deepEqual([...PARTITION_PRO_MATERIALS].sort(), ["bar", "glass"]);
});

// ---------- демонтаж (эталон ui-ref-replan-demolition) ----------

test("103: демонтаж стены целиком — demount=1 на стене и концах, участки сбрасываются (setDemount)", () => {
  const m = baseModel();
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  // предсуществующий участок — setDemount редактора сбрасывает sectors
  top.sectors = { s1: { id: "s1", pc: { x: 100, y: -300 }, width: 100 } };
  demolish(m, { target: "wall", id: top.id });
  const got = demolitionSignature(top);
  assert.equal(got.demount, DEMO_REF.break_whole.demount);
  assert.equal(got.p1_demount, DEMO_REF.break_whole.p1.demount);
  assert.equal(got.p2_demount, DEMO_REF.break_whole.p2.demount);
  assert.deepEqual(got.sectors, [], "setDemount очищает sectors");
});

test("103: демонтаж участка — sectors{pc,width} совпадают с эталоном при тех же входных мм", () => {
  const m = baseModel();
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  const res = demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  assert.ok(res.sectorId);
  const sectors = top.sectors as Record<string, { id: string; pc: { x: number; y: number }; width: number }>;
  const exp = Object.values(DEMO_REF.break_part.sectors)[0]!;
  const got = Object.values(sectors)[0]!;
  assert.equal(got.width, exp.width);
  assert.equal(got.pc.x, exp.pc.x);
  assert.equal(got.pc.y, exp.pc.y);
  // второй участок рядом — ok; пересечение с первым — INVALID_ARGUMENT
  assert.ok(demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 1600, length_mm: 400 } }));
  assert.throws(() => demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 1200, length_mm: 500 } }), /пересекает|другой участок/);
  assert.throws(() => demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 5800, length_mm: 500 } }), /пределы стены/);
  // атомарность: неудача не оставила секторов
  assert.equal(Object.keys(top.sectors as Record<string, unknown>).length, 2);
});

test("103: демонтаж проёма — holes[hid].demount=1; заменённый и plan:c — INVALID_ARGUMENT", () => {
  const m = baseModel();
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const hole = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 1100 });
  const res = demolish(m, { target: "opening", id: hole.id });
  assert.equal(res.holeId, hole.id);
  assert.equal(hole.demount, DEMO_REF.break_door.holes[Object.keys(DEMO_REF.break_door.holes)[0]!]!.demount);
  // уже демонтированный — повторный demount без ошибки (idempotent-запись того же значения)
  assert.equal(demolish(m, { target: "opening", id: hole.id }).holeId, hole.id);
  // замена поверх демонтированного → INVALID_ARGUMENT (проба 103-replan-extra)
  assert.throws(() => addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: hole.id }), /демонтирован/);
});

test("103: демонтаж перегородки и ограждения — INVALID_ARGUMENT", () => {
  const m = baseModel();
  const part = addWall(m, { start: { x: 1500, y: -2900 }, end: { x: 1500, y: -100 }, plan: "c", material: "c_pgb" });
  assert.throws(() => demolish(m, { target: "wall", id: part.id }), /перегородка/);
  const m2 = baseModel();
  const fence = Object.values(m2.walls).find((w) => w.role === "balcony" || w.role === "terrace_fence");
  if (fence) assert.throws(() => demolish(m2, { target: "wall", id: fence.id }), /ограждение/);
});

test("103: demolish_cancel — стена, участок, проём; не демонтированное — INVALID_ARGUMENT", () => {
  const m = baseModel();
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  const s1 = demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  assert.ok(demolishCancel(m, { target: "wall", id: top.id, sector_id: s1.sectorId }));
  assert.equal(Object.keys(top.sectors ?? {}).length, 0);
  demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  demolish(m, { target: "wall", id: top.id });
  assert.ok(demolishCancel(m, { target: "wall", id: top.id }));
  assert.equal(top.demount, 0);
  assert.equal(top.p1.demount, DEMO_REF.remove_break.p1.demount);
  assert.equal(top.p2.demount, DEMO_REF.remove_break.p2.demount);
  assert.equal(top.sectors, undefined);
  assert.throws(() => demolishCancel(m, { target: "wall", id: top.id }), /не демонтирована/);
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  assert.throws(() => demolishCancel(m, { target: "wall", id: top.id, sector_id: "nope" }), /не найден/);
  assert.throws(() => demolishCancel(m, { target: "wall", id: "nope" }), /не найдена/);
  // проём: demount → cancel
  const hole = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 1100 });
  demolish(m, { target: "opening", id: hole.id });
  assert.ok(demolishCancel(m, { target: "opening", id: hole.id }));
  assert.equal(hole.demount, 0);
  assert.throws(() => demolishCancel(m, { target: "opening", id: hole.id }), /не демонтирован/);
});

// ---------- замена проёма (эталон ui-ref-replan-replacement) ----------

test("103: замена исходного проёма — plan:c + position:c, у исходного hasReplacement=1", () => {
  const m = baseModel();
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const door = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 1100 });
  const rep = addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: door.id });
  assert.equal(rep.plan, REPL_REF.new_hole.plan);
  assert.equal(rep.position, REPL_REF.new_hole.position);
  assert.equal(door.hasReplacement, REPL_REF.original_hole.hasReplacement);
  // замена встала по центру исходного
  assert.ok(Math.abs((rep.pc.x - door.pc.x)) < 0.1, "центр замены = центр исходного");
  // обязательные поля замены (без них редактор падает на restore — проба 103-norm-check)
  assert.equal(rep.parent, corridor.id);
  assert.equal(rep.parent_depth, corridor.depth);
  assert.deepEqual(rep.dls_prs, {});
  assert.equal(rep.offset, 0);
  const pt = (v: unknown) => v as { x: number; y: number };
  const pcb = pt(rep.pcb), p1b = pt(rep.p1b), p2b = pt(rep.p2b);
  assert.ok(Math.abs((pcb.x - rep.pc.x)) < 0.1, "pcb = центр замены");
  assert.ok(Math.abs((p1b.x - rep.p1!.x)) < 0.1 && Math.abs((p2b.y - rep.p2!.y)) < 0.1, "p1b/p2b = края");
  // повторная замена — INVALID_ARGUMENT
  assert.throws(() => addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: door.id }), /уже заменён/);
  // замена проёма plan:c — INVALID_ARGUMENT
  assert.throws(() => addOpening(m, { wallId: corridor.id, type: "door", replacesHoleId: rep.id }), /план «Перегородки»|plan:c/);
  // удаление замены снимает... (opening_delete не обязан чистить hasReplacement — вне ядра)
});

// ---------- ГКЛ-короб (эталон ui-ref-replan-gypsum-box) ----------

test("103: ГКЛ-короб — plan:c, роль gypsum, id_room, умолчания 700×200 мм", () => {
  const m = baseModel();
  const rooms = (m.rooms2 ?? {}) as Record<string, { polygon: { x: number; y: number }[] }>;
  const [roomId, room] = Object.entries(rooms)[0]!;
  const cx = room.polygon.reduce((s, p) => s + p.x, 0) / room.polygon.length;
  const cy = room.polygon.reduce((s, p) => s + p.y, 0) / room.polygon.length;
  const roomsArg = Object.entries(rooms).map(([id, r]) => ({ roomId: id, polygon: r.polygon, areaCm2: 0, axisAreaCm2: null }));
  const box = addPillar(m, { center: { x: Math.round(cx * 10), y: Math.round(cy * 10) }, kind: "gypsum_box" }, roomsArg);
  assert.equal(box.plan, BOX_REF.pillar.plan);
  assert.equal(box.role, BOX_REF.pillar.role);
  assert.equal((box as unknown as Record<string, unknown>)["role_"], BOX_REF.pillar.role_);
  assert.equal(box.width, BOX_REF.pillar.width);
  assert.equal(box.height, BOX_REF.pillar.height);
  assert.equal(box.total_height, BOX_REF.pillar.total_height);
  assert.equal(box.id_room, roomId);
  assert.equal(box.inRoom, 1);
  // короб прижимается к грани стены — inRoom 0, как в UI
  const box2 = addPillar(m, { center: { x: 2000, y: -2800 }, kind: "gypsum_box" }, roomsArg);
  assert.equal(box2.inRoom, 0);
  // вне комнаты — OUTSIDE_ROOM
  assert.throws(() => addPillar(m, { center: { x: 8000, y: 8000 }, kind: "gypsum_box" }, roomsArg), /вне помещения/);
  // обычная колонна не изменилась (другое место — не пересекать короб)
  const col = addPillar(m, { center: { x: Math.round(cx * 10) + 3000, y: Math.round(cy * 10) } }, roomsArg);
  assert.equal(col.plan, "a");
  assert.equal(col.role, "pillar");
});

// ---------- семантическая сверка демонтажа ----------

test("103: сверка демонтажа — флаги и участки сохраняются, переименованный сектор не блокирует", () => {
  const m = baseModel();
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  const part = Object.values(m.walls).find((w) => Math.abs(w.p1.x - 500) < 1)!;
  demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  demolish(m, { target: "wall", id: part.id });
  const after = structuredClone(m.walls);
  assert.deepEqual(demolitionMismatches(m.walls, after), []);
  // редактор пересоздал id сектора — не расхождение
  const sectors = after[top.id]!.sectors as Record<string, { id: string; pc: { x: number; y: number }; width: number }>;
  const [sid, s] = Object.entries(sectors)[0]!;
  delete sectors[sid];
  sectors["renamed"] = { id: "renamed", pc: s.pc, width: s.width };
  assert.deepEqual(demolitionMismatches(m.walls, after), []);
  // потеря demount — расхождение
  delete after[part.id]!.demount;
  after[part.id]!.p1.demount = 0;
  after[part.id]!.p2.demount = 0;
  assert.ok(demolitionMismatches(m.walls, after).length > 0);
  // сдвиг участка — расхождение
  const back = structuredClone(m.walls);
  const sb = back[top.id]!.sectors as Record<string, { pc: { x: number; y: number }; width: number }>;
  Object.values(sb)[0]!.pc = { x: 130, y: -300 };
  assert.ok(demolitionMismatches(m.walls, back).length > 0);
});

test("103: сверка демонтажа — пустые модели и чужие стены не блокируют", () => {
  assert.deepEqual(demolitionMismatches(undefined, undefined), []);
  assert.deepEqual(demolitionMismatches({}, {}), []);
  const m = baseModel();
  const got = structuredClone(m.walls);
  delete (got as Record<string, unknown>)["w1"];
  assert.deepEqual(demolitionMismatches(m.walls, got), []); // потерю стены ловит общий слой
});

test("103: сверка демонтажа — проём без пометок не даёт расхождений, потеря demount проёма — да", () => {
  const m = baseModel();
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const hole = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 1100 });
  demolish(m, { target: "opening", id: hole.id });
  const got = structuredClone(m.walls);
  assert.deepEqual(demolitionMismatches(m.walls, got), []);
  delete got[corridor.id]!.holes[hole.id]!.demount;
  assert.ok(demolitionMismatches(m.walls, got).some((p) => p.includes(hole.id)));
});

// ---------- компакт ----------

test("103: компакт — план, материал, демонтаж и замена проёма видны в model_get", () => {
  const m = baseModel();
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const door = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 1100 });
  addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: door.id });
  const door2 = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 3000 });
  demolish(m, { target: "opening", id: door2.id });
  demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  const part = addWall(m, { start: { x: 1500, y: -2900 }, end: { x: 1500, y: -100 }, thicknessMm: 100, material: partitionMaterialCode("gypsum"), plan: "c" });
  const c = compactModel(m);
  const topC = c.walls.find((w) => w.site_id === top.id)!;
  assert.equal(topC.plan, "a");
  assert.equal(topC.material, "a_block");
  assert.equal(topC.demount, undefined);
  assert.deepEqual(topC.sectors, [{ offset_mm: 500, width_mm: 1000 }]);
  const partC = c.walls.find((w) => w.site_id === part.id)!;
  assert.equal(partC.plan, "c");
  assert.equal(partC.material, "c_gypsum");
  assert.equal(partC.thickness_mm, 100);
  const doorC = c.walls.find((w) => w.site_id === corridor.id)!.openings.find((o) => o.id === door.id)!;
  assert.equal(doorC.replaced, true);
  const door2C = c.walls.find((w) => w.site_id === corridor.id)!.openings.find((o) => o.id === door2.id)!;
  assert.equal(door2C.demount, true);
});

// ---------- mock save ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
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
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  return ws;
}

function prepareScenario(): Model {
  const m = baseModel();
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  const corridor = Object.values(m.walls).find((w) => Math.abs(w.p1.y) < 1 && Math.abs(w.p2.y) < 1)!;
  const door = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 1100 });
  addOpening(m, { wallId: corridor.id, type: "doorway", replacesHoleId: door.id });
  const door2 = addOpening(m, { wallId: corridor.id, type: "door", offsetMm: 3000 });
  demolish(m, { target: "wall", id: top.id, range: { from: "start", offset_mm: 500, length_mm: 1000 } });
  demolish(m, { target: "opening", id: door2.id });
  addWall(m, { start: { x: 1500, y: -2900 }, end: { x: 1500, y: -100 }, material: "gypsum", plan: "c" });
  return m;
}

test("103: mock save — демонтаж и перегородка доходят до серверной модели, verified", async () => {
  const m = prepareScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.rounds, 1);
});

test("103: mock save — редактор пересоздал id сектора при нормализации → verified без ложной блокировки", async () => {
  const m = prepareScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const top = (norm["walls"] as Record<string, Record<string, unknown>>)[
      Object.entries(m.walls).find(([, w]) => w.p1.y === -300 && w.p2.x === 600)![0]
    ]!;
    const sectors = top["sectors"] as Record<string, { id: string; pc: { x: number; y: number }; width: number }>;
    const [sid, s] = Object.entries(sectors)[0]!;
    delete sectors[sid];
    sectors["norm1"] = { id: "norm1", pc: s.pc, width: s.width };
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("103: mock save — нормализация потеряла пометку демонтажа → NORMALIZATION_DROPPED (demolition_mismatches)", async () => {
  const m = prepareScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const top = (norm["walls"] as Record<string, Record<string, unknown>>)[
      Object.entries(m.walls).find(([, w]) => w.p1.y === -300 && w.p2.x === 600)![0]
    ]!;
    delete top["sectors"];
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: Error) => {
    const details = (e as Error & { details?: Record<string, unknown> }).details ?? {};
    assert.ok(Array.isArray(details["demolition_mismatches"]) && (details["demolition_mismatches"] as string[]).length > 0, JSON.stringify(details).slice(0, 300));
    return true;
  });
});

test("103: mock save — сервер потерял демонтаж после save → SITE_ERROR (demolition_mismatches)", async () => {
  const m = prepareScenario();
  const topId = Object.entries(m.walls).find(([, w]) => w.p1.y === -300 && w.p2.x === 600)![0];
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const top = (s.model["walls"] as Record<string, Record<string, unknown>>)[topId]!;
    delete top["sectors"];
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: Error) => {
    assert.match(e.message, /не совпала с рабочей копией/);
    const details = (e as Error & { details?: Record<string, unknown> }).details ?? {};
    assert.ok(Array.isArray(details["demolition_mismatches"]) && (details["demolition_mismatches"] as string[]).length > 0);
    return true;
  });
});

// ---------- тарифный гейт (инструмент wall_add, офлайн-контекст) ----------

test("103: wall_add kind=partition material=glass в анонимном проекте — NOT_AVAILABLE_ON_TARIFF", async () => {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const tools = planTools(ctx);
  const res = await tools["wall_add"]!.handler({ kind: "partition", material: "glass", start: { x: 1000, y: -1500 }, end: { x: 1000, y: -500 } });
  assert.equal(res.isError, true);
  const payload = JSON.parse((res.content[0] as { type: string; text: string }).text) as { code: string };
  assert.equal(payload.code, "NOT_AVAILABLE_ON_TARIFF");
});
