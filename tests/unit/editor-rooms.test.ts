// Этап 6, T27: комнаты берутся из нормализованной модели редактора (rooms2).
// Эталон — tests/fixtures/editor-corridor-3rooms.json (T24 сценарий B, «коридор + 3 комнаты»).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, FixtureEnvelope } from "../../src/model/types.ts";
import { roomPolygons } from "../../src/model/items.ts";
import { compactModel } from "../../src/model/compact.ts";
import { validateModel } from "../../src/model/validate.ts";
import { addItem } from "../../src/model/items.ts";

const here = dirname(fileURLToPath(import.meta.url));

function corridorModel(): Model {
  const env = JSON.parse(readFileSync(join(here, "../fixtures/editor-corridor-3rooms.json"), "utf8")) as FixtureEnvelope;
  return structuredClone(env.model);
}

const T24_AREAS = [7.84, 5.8, 5.04, 2.24];

test("T27: эталон редактора «коридор + 3 комнаты» — 4 комнаты с площадями T24", () => {
  const model = corridorModel();
  const rooms = roomPolygons(model);
  assert.equal(rooms.length, 4);
  const areas = rooms.map((r) => Math.round((r.areaCm2 / 10_000) * 100) / 100).sort((a, b) => b - a);
  assert.deepEqual(areas, T24_AREAS);
  // у каждой комнаты есть полигон и id комнаты редактора
  for (const r of rooms) {
    assert.ok(r.roomId, "id комнаты из rooms2");
    assert.ok(r.polygon.length >= 3);
    assert.equal(r.axisAreaCm2, null, "осевая площадь комнат редактора не восстанавливается");
  }
});

test("T27: rooms_list/compact — метки R1…R4, площади T24, имена комнат", () => {
  const model = corridorModel();
  const compact = compactModel(model);
  assert.equal(compact.rooms.length, 4);
  const areas = compact.rooms.map((r) => r.area_m2).sort((a, b) => b - a);
  assert.deepEqual(areas, T24_AREAS);
  assert.deepEqual(compact.rooms.map((r) => r.id).sort(), ["R1", "R2", "R3", "R4"]);
  assert.deepEqual(compact.rooms.map((r) => r.area_axis_m2), [null, null, null, null]);
});

test("T27/R2-7: толщина ребра больше не восстанавливается по умолчанию 20 см — код wallCycles удалён", () => {
  // R2-7: roomPolygons по wallCycles подставлял depth=200 мм для рёбер edge — площади
  // при толщине 400 были неверны. Теперь полигон приходит из редактора целиком:
  // меняем толщину стен — полигоны и площади комнат НЕ меняются.
  const model = corridorModel();
  const before = roomPolygons(model).map((r) => r.areaCm2);
  for (const w of Object.values(model.walls)) {
    w.depth = 40; // толщина 400 мм — как в воспроизведении R2-7
  }
  const after = roomPolygons(model).map((r) => r.areaCm2);
  assert.deepEqual(after, before, "площади комнат из редактора не зависят от пересчёта в Node");
});

test("T27: addItem по комнате редактора и validate на эталоне", () => {
  const model = corridorModel();
  const rooms = roomPolygons(model);
  const props = addItem(model, { name: "sofa", position: { inRoom: { corner: "center" } } }, rooms);
  assert.equal(props.id_room, rooms[0]!.roomId);
  const problems = validateModel(model).filter((p) => p.code === "ITEM_OUTSIDE_ROOM");
  assert.equal(problems.length, 0, JSON.stringify(problems));
});

test("T27: комната редактора — «Гостиная» из zones[0].name попадает в compact", () => {
  const model = corridorModel();
  const first = Object.keys(model.rooms2 as Record<string, unknown>)[0]!;
  (model.rooms2 as Record<string, { zones?: Array<{ name?: string }> }>)[first]!.zones = [{ name: "Коридор" }];
  const compact = compactModel(model);
  const named = compact.rooms.find((r) => r.name === "Коридор");
  assert.ok(named, "имя комнаты из rooms2.zones[0].name");
});
