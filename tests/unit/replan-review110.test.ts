// 110: закрытие major R4 и R10 из ревью 109 (.orca-reports/109-rereview2-replan.md).
// По каждой находке тест, падающий на 8e48e69:
// R4 — replacementPairOf возвращает null для обычного проёма (не замены, без
//      hasReplacement); обычная дверь рядом с парами не переносит чужую замену;
// R10 — унаследованные висячие концы сопоставляются геометрически: смена ID
//      стены и разворот оси (p1/p2) нормализатором не дают ложного отказа.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model, Wall } from "../../src/model/types.ts";
import { demolish } from "../../src/model/demolition.ts";
import { addWall, moveWall } from "../../src/model/walls.ts";
import { addOpening, updateOpening, prepareHolePoints, holeOffsetCm } from "../../src/model/openings.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { NormalizeResult } from "../../src/editor/adapter.ts";
import type { LoadedModel } from "../../src/api.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

/** Свободная горизонтальная стена 6000 мм на оси y=-6000 (2 несоединённых конца). */
function probeWall(m: Model): Wall {
  prepareHolePoints(m);
  return addWall(m, { start: { x: 0, y: -6000 }, end: { x: 6000, y: -6000 } });
}

const centerCm = (wall: Wall, hole: { pc: { x: number; y: number }; width: number }): number =>
  holeOffsetCm(wall, hole as never) + hole.width / 2;

// ---------- R4: обычный проём не участвует в паре ----------

/** Одна пара (A исходный + R замена) и обычная дверь B — UI-модель без at. */
function pairWithPlainDoor(widthMm = 800): { m: Model; wall: Wall; a: Wall["holes"][string]; r: Wall["holes"][string]; b: Wall["holes"][string] } {
  const m = baseModel();
  const wall = probeWall(m);
  const a = addOpening(m, { wallId: wall.id, type: "door", offsetMm: 1000 });
  const r = addOpening(m, { wallId: wall.id, type: "doorway", replacesHoleId: a.id, widthMm });
  const b = addOpening(m, { wallId: wall.id, type: "door", offsetMm: 4000 });
  for (const h of [a, r, b]) delete h.at;
  return { m, wall, a, r, b };
}

function snapshotHoles(wall: Wall, ids: string[]): Array<Wall["holes"][string]> {
  return structuredClone(ids.map((id) => wall.holes[id]!));
}

test("110 R4: изменение высоты обычной двери не трогает чужую пару (воспроизведение 109)", () => {
  const { m, wall, a, r, b } = pairWithPlainDoor();
  const before = snapshotHoles(wall, [a.id, r.id]);
  updateOpening(m, { wallId: wall.id, holeId: b.id, heightMm: 2200 });
  assert.deepEqual(
    snapshotHoles(wall, [a.id, r.id]),
    before,
    "пара замены (исходный и замена) осталась на месте",
  );
  assert.equal(centerCm(wall, wall.holes[r.id]!), 140, `замена осталась на x=140 см, получено ${centerCm(wall, wall.holes[r.id]!)}`);
});

test("110 R4: изменение ширины обычной двери не трогает чужую пару", () => {
  const { m, wall, a, r, b } = pairWithPlainDoor();
  const before = snapshotHoles(wall, [a.id, r.id]);
  updateOpening(m, { wallId: wall.id, holeId: b.id, widthMm: 1200 });
  assert.deepEqual(snapshotHoles(wall, [a.id, r.id]), before);
});

test("110 R4: перенос обычной двери не трогает чужую пару", () => {
  const { m, wall, a, r, b } = pairWithPlainDoor();
  const before = snapshotHoles(wall, [a.id, r.id]);
  updateOpening(m, { wallId: wall.id, holeId: b.id, centerMm: 5500 });
  assert.deepEqual(snapshotHoles(wall, [a.id, r.id]), before);
  assert.equal(centerCm(wall, wall.holes[b.id]!), 550, "дверь переехала на новое место");
});

test("110 R4: обычная дверь рядом с двумя парами не трогает ни одну", () => {
  const m = baseModel();
  const wall = probeWall(m);
  const a1 = addOpening(m, { wallId: wall.id, type: "door", offsetMm: 1000 });
  const r1 = addOpening(m, { wallId: wall.id, type: "doorway", replacesHoleId: a1.id, widthMm: 800 });
  const a2 = addOpening(m, { wallId: wall.id, type: "door", offsetMm: 2200 });
  const r2 = addOpening(m, { wallId: wall.id, type: "doorway", replacesHoleId: a2.id, widthMm: 800 });
  const b = addOpening(m, { wallId: wall.id, type: "door", offsetMm: 4000 });
  for (const h of [a1, r1, a2, r2, b]) delete h.at;
  const before = snapshotHoles(wall, [a1.id, r1.id, a2.id, r2.id]);
  updateOpening(m, { wallId: wall.id, holeId: b.id, heightMm: 2200 });
  assert.deepEqual(snapshotHoles(wall, [a1.id, r1.id, a2.id, r2.id]), before);
});

// ---------- R10: геометрическое сопоставление унаследованных концов ----------

type EditorTweak = {
  /** Переименовать стену (вернуть новый id или null). Предикат — по геометрии: id генерируется случайно. */
  rename?: (w: Wall) => string | null;
  /** Поменять местами p1/p2 стены. */
  flip?: (w: Wall) => boolean;
};

/** identity-нормализатор с управляемыми трансформациями (пробы ревью 109). */
function tweakedEditor(tweak: EditorTweak): EditorLike {
  return {
    objectId: "123", planId: "1",
    async normalize(model) {
      const copy = structuredClone(model) as Model & Record<string, unknown>;
      for (const [key, w] of Object.entries(copy.walls)) {
        const renamed = tweak.rename?.(w);
        if (renamed) {
          delete copy.walls[key];
          w.id = renamed;
          copy.walls[renamed] = w;
        }
        if (tweak.flip?.(w)) {
          const p = w.p1;
          w.p1 = w.p2;
          w.p2 = p;
        }
      }
      const walls = Object.values(copy.walls).map((w) => ({ id: w.id, p1: w.p1, p2: w.p2, depth: w.depth }));
      const c = { walls: walls.length, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: copy, rooms: [], before: c, after: c, walls, errors: null } as unknown as NormalizeResult;
    },
    async save() { return { ok: true, saveId: "s2", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { global_version: null, planner_version: null, bundles: [], object_id: "123", plan_id: "1", present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } } as never; },
    async close() {},
  };
}

/** Изолированная стена пробы (0,-600)..(600,-600) см — обе концы висячие. */
const isIsolated = (w: Wall): boolean => w.p1.x === 0 && w.p1.y === -600 && w.p2.x === 600 && w.p2.y === -600;
/** Полуприсоединённая стена пробы (0,-300)..(-200,-600) см — висячий только конец (0,-300). */
const isHalf = (w: Wall): boolean => w.p1.x === 0 && w.p1.y === -300 && w.p2.x === -200 && w.p2.y === -600;
const isHalfReversed = (w: Wall): boolean => w.p2.x === 0 && w.p2.y === -300 && w.p1.x === -200 && w.p1.y === -600;

function wsDeps(editor: EditorLike, model: Model): WorkspaceDeps {
  return {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", data_empty: false, model: structuredClone(model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
}

function wsWithIsolatedWall(editor: EditorLike): { ws: Workspace; isolated: Wall; top: Wall } {
  const m = baseModel();
  prepareHolePoints(m);
  const isolated = probeWall(m); // 2 несоединённых конца ДО операции
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  return { ws: new Workspace(wsDeps(editor, m)), isolated, top };
}

test("110 R10: нормализатор меняет ID изолированной стены — демонтаж другой стены проходит", async () => {
  const { ws, isolated, top } = wsWithIsolatedWall(tweakedEditor({ rename: (w) => (isIsolated(w) ? "renumbered" : null) }));
  await ws.open("123", "1");
  const { result } = await ws.applyWalls("demolish", (mm) => demolish(mm, { target: "wall", id: top.id }));
  assert.equal(result.wallId, top.id);
  assert.ok(ws.model.walls["renumbered"], "переименованная стена в модели после сохранения");
  assert.equal(ws.model.walls[isolated.id], undefined);
});

/** Стена с одним свободным концом (p1 в стыке, p2 висит) — воспроизведение 109. */
function wsWithHalfAttachedWall(editor: EditorLike): { ws: Workspace; top: Wall } {
  const m = baseModel();
  prepareHolePoints(m);
  addWall(m, { start: { x: 0, y: -3000 }, end: { x: -2000, y: -6000 } });
  const top = Object.values(m.walls).find((w) => w.p1.y === -300 && w.p2.x === 600)!;
  return { ws: new Workspace(wsDeps(editor, m)), top };
}

test("110 R10: нормализатор меняет местами p1/p2 стены со свободным концом — демонтаж проходит", async () => {
  const { ws, top } = wsWithHalfAttachedWall(tweakedEditor({ flip: isHalf }));
  await ws.open("123", "1");
  const { result } = await ws.applyWalls("demolish", (mm) => demolish(mm, { target: "wall", id: top.id }));
  assert.equal(result.wallId, top.id);
});

test("110 R10: смена ID и разворот оси вместе — демонтаж проходит", async () => {
  const { ws, top } = wsWithHalfAttachedWall(tweakedEditor({
    rename: (w) => (isHalf(w) ? "renumbered" : null),
    flip: (w) => isHalf(w) || w.id === "renumbered",
  }));
  await ws.open("123", "1");
  await ws.applyWalls("demolish", (mm) => demolish(mm, { target: "wall", id: top.id }));
  assert.ok(ws.model.walls["renumbered"]);
});

test("110 R10: перенос изолированной стены с геометрическим сопоставлением проходит", async () => {
  const { ws, isolated } = wsWithIsolatedWall(tweakedEditor({}));
  await ws.open("123", "1");
  await ws.applyWalls("wall_move", (mm) => moveWall(mm, { wallId: isolated.id, offsetMm: 200 }));
  assert.equal(ws.model.walls[isolated.id]!.p1.y, -620);
});

test("110 R10: операция, создающая действительно новый висячий конец, — INVALID_GEOMETRY", async () => {
  const { ws } = wsWithIsolatedWall(tweakedEditor({}));
  await ws.open("123", "1");
  await assert.rejects(
    ws.applyWalls("wall_add", (mm) => addWall(mm, { start: { x: 0, y: 10000 }, end: { x: 3000, y: 10000 } })),
    (e: unknown) => {
      const err = e as { code?: string; details?: { unattached?: unknown[] } };
      return err.code === "INVALID_GEOMETRY" && Array.isArray(err.details?.unattached) && (err.details.unattached as unknown[]).length === 2;
    },
  );
});
