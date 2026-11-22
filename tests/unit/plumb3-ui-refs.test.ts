// Этап 360 — сантехника ч.3: группы выводов воды (GroupWaterSpots) и узлы труб.
// Источники формата: бандл app.3.0 (класс GroupWaterSpots, GraphLines.deleteByItem),
// эталон ui-ref-plumb3-waterspot-node.json (анонимная проба 360-ws-node),
// каталог tests/fixtures/catalog-waterspots.json (анонимная проба 360-ws-catalog).
// Правила «как в редакторе» — по обработчикам бандла отдельно для каждого пути
// (merge / unset / каскад труб): new-entity-section.md §49.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps, Pipe } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addItem, deleteItem, updateItem } from "../../src/model/items.ts";
import { addPipe, deletePipe, PIPE_LINK_KEY_BY_TYPE } from "../../src/model/pipes.ts";
import {
  mergeWaterSpot, unsetWaterSpot, removePipeVertex,
  waterSpotMergeResult, waterSpotUnsetError,
  WS_MERGE_RESULT, WS_UNSET_RESULT, WS_SINGLE_SPOTS, WS_COMPOSITE_ITEMS, WS_WATER_ITEMS,
} from "../../src/model/waterspots.ts";
import { pipeConnectionMismatches, WATER_PIPE_TYPES } from "../../src/verify/pipes.ts";
import { McpError } from "../../src/errors.ts";
import { assertProPartialAllowed, PRO_WATER_SPOT_SINGLES } from "../../src/server/pro.ts";

const here = dirname(fileURLToPath(import.meta.url));

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {} };
}

function baseModel(): Model {
  const model = emptyModel();
  addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  model.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return model;
}

/** Каталог waterspots (анонимная проба 360-ws-catalog) — габариты, высоты, over_floor. */
const WS_CATALOG = JSON.parse(readFileSync(join(here, "../fixtures/catalog-waterspots.json"), "utf8")) as {
  tools: Record<string, { width: number; height: number; over_floor: unknown }>;
};

function spotEntry(name: string): import("../../src/catalog.ts").ToolEntry {
  const t = WS_CATALOG.tools[name]!;
  return {
    id: 0, name, title: name, group: "waterspots",
    width: t.width, height: t.height, self_height: 0,
    plan: { water: 27 }, over_floor: t.over_floor as never,
  } as import("../../src/catalog.ts").ToolEntry;
}

function addSpot(model: Model, x: number, y: number, name = "waterspot_cold_hot"): ItemProps {
  return addItem(model, { name, position: { center: { x: x * 10, y: y * 10 } }, catalogEntry: spotEntry(name) });
}

function addWallSpot(model: Model, offsetMm: number, name = "waterspot_cold"): ItemProps {
  const wallId = Object.keys(model.walls)[0]!;
  return addItem(model, { name, position: { againstWall: { wallId, offsetMm } }, catalogEntry: spotEntry(name) });
}

function pipesOf(model: Model): Record<string, Pipe> {
  return (model as unknown as { pipes?: Record<string, Pipe> }).pipes ?? {};
}

// ---------- таблицы GroupWaterSpots: сверка с бандлом (обе стороны) ----------

test("360: таблицы source_items/structure_items совпадают с бандлом GroupWaterSpots", () => {
  assert.deepEqual(WS_MERGE_RESULT, {
    waterspot_cold: {
      waterspot_hot: "waterspot_cold_hot",
      waterspot_drainage: "waterspot_drainage_cold",
      waterspot_drainage_hot: "waterspot_drainage_cold_hot",
    },
    waterspot_hot: {
      waterspot_cold: "waterspot_cold_hot",
      waterspot_drainage_cold: "waterspot_drainage_cold_hot",
      waterspot_drainage: "waterspot_drainage_hot",
    },
    waterspot_drainage: {
      waterspot_hot: "waterspot_drainage_hot",
      waterspot_cold: "waterspot_drainage_cold",
      waterspot_cold_hot: "waterspot_drainage_cold_hot",
    },
    waterspot_cold_hot: { waterspot_drainage: "waterspot_drainage_cold_hot" },
    waterspot_drainage_cold: { waterspot_hot: "waterspot_drainage_cold_hot" },
    waterspot_drainage_hot: { waterspot_cold: "waterspot_drainage_cold_hot" },
  });
  assert.deepEqual(WS_UNSET_RESULT, {
    waterspot_drainage_cold_hot: {
      waterspot_hot: "waterspot_drainage_cold",
      waterspot_cold: "waterspot_drainage_hot",
      waterspot_drainage: "waterspot_cold_hot",
    },
    waterspot_drainage_hot: { waterspot_hot: "waterspot_drainage", waterspot_drainage: "waterspot_hot" },
    waterspot_drainage_cold: { waterspot_cold: "waterspot_drainage", waterspot_drainage: "waterspot_cold" },
    waterspot_cold_hot: { waterspot_cold: "waterspot_hot", waterspot_hot: "waterspot_cold" },
  });
  // группы $PipingWater (composite_items НЕ содержит waterspot_cold)
  assert.deepEqual([...WS_COMPOSITE_ITEMS].sort(), ["waterspot_drainage_cold", "waterspot_drainage_cold_hot", "waterspot_drainage_hot"]);
  assert.deepEqual([...WS_SINGLE_SPOTS].sort(), ["waterspot_cold", "waterspot_drainage", "waterspot_hot"]);
  assert.ok(WS_WATER_ITEMS.has("waterspot_cold_hot") && !WS_COMPOSITE_ITEMS.has("waterspot_cold_hot"));
  // unset-части всегда одиночные выводы (ключи каскада труб существуют)
  for (const table of Object.values(WS_UNSET_RESULT)) {
    for (const part of Object.keys(table)) assert.ok(WS_SINGLE_SPOTS.has(part), `часть ${part} — одиночный вывод`);
  }
});

// ---------- эталон узла ----------

test("360: эталон ui-ref-plumb3-waterspot-node — item_add воспроизводит формат (обе стороны)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-plumb3-waterspot-node.json"), "utf8"));
  const m = fx.model_object as Record<string, unknown>;
  assert.equal(m["name"], "waterspot_node");
  assert.equal(m["width"], 4);
  assert.equal(m["height"], 4);
  assert.deepEqual(m["plan"], { water: 27 });
  assert.equal(m["over_floor"], undefined, "у узла высоты вывода нет (каталог over_floor:false)");
  assert.equal((m["dimensions"] as { display: boolean }).display, true);
  const model = baseModel();
  const item = addItem(model, { name: "waterspot_node", position: { center: { x: 1500, y: 500 } }, catalogEntry: spotEntry("waterspot_node") });
  assert.equal(item.name, m["name"]);
  assert.deepEqual(item.plan, m["plan"]);
  assert.equal((item.over_floor as unknown), null as unknown, "item_add пишет over_floor:null (производное, редактор поле не пишет) — как у светильников");
  assert.equal(item.width, m["width"]);
  assert.equal(item.height, m["height"]);
  assert.equal((item.dimensions as { display: boolean }).display, true);
});

// ---------- waterspot_merge ----------

test("360: merge — все пары source_items, id сохранён, габариты из каталога, трубы живы", () => {
  const KIND: Record<string, "water" | "hot" | "drainage"> = {
    waterspot_cold: "water", waterspot_hot: "hot", waterspot_drainage: "drainage",
    waterspot_cold_hot: "water", waterspot_drainage_cold: "drainage", waterspot_drainage_hot: "hot",
  };
  const NEIGHBOR: Record<"water" | "hot" | "drainage", string> = { water: "waterspot_cold", hot: "waterspot_hot", drainage: "waterspot_drainage" };
  for (const [part, targets] of Object.entries(WS_MERGE_RESULT)) {
    for (const [targetName, result] of Object.entries(targets)) {
      const model = baseModel();
      const spot = addSpot(model, 150, 100, targetName);
      const node = addSpot(model, 250, 100, NEIGHBOR[KIND[targetName]!]!);
      const pipe = addPipe(model, { kind: KIND[targetName]!, path: [{ itemId: spot.id }, { itemId: node.id }] });
      const before = structuredClone(model);
      const res = mergeWaterSpot(model, { itemId: spot.id, part, widthCm: WS_CATALOG.tools[result]!.width, heightCm: WS_CATALOG.tools[result]!.height });
      assert.equal(res.result, result, `${part}+${targetName} → ${result}`);
      assert.equal(spot.id, before.items[spot.id]!.id, "id сохранён (ссылки труб живы)");
      assert.equal(spot.name, result);
      assert.equal(spot.width, WS_CATALOG.tools[result]!.width);
      assert.equal(spot.height, WS_CATALOG.tools[result]!.height);
      // трубы не потерялись: вершина-предмет продолжает ссылаться на тот же id
      const p = pipesOf(model)[pipe.id]!;
      assert.ok(p.vertexes.some((v) => v.id === spot.id), "труба подключена к переименованному выводу");
      // соседний вывод не задет
      assert.equal(model.items[node.id]!.name, NEIGHBOR[KIND[targetName]!]);
    }
  }
});

test("360: merge over_floor — пристенная цель-вода получает value_2=40, цель-канализация меняет местами", () => {
  // пристенный waterspot_cold + drainage → drainage_cold: value 50, value_2 40
  const m1 = baseModel();
  const s1 = addWallSpot(m1, 1500, "waterspot_cold");
  assert.ok(s1.id_wall, "постановка у стены пишет id_wall");
  mergeWaterSpot(m1, { itemId: s1.id, part: "waterspot_drainage", widthCm: 21, heightCm: 15 });
  assert.deepEqual(s1.over_floor, { value: 50, display: false, value_2: 40 });
  // пристенная канализация + cold → drainage_cold: value = прежний value_2, value = 50
  const m2 = baseModel();
  const s2 = addWallSpot(m2, 1500, "waterspot_drainage");
  (s2.over_floor as { value: number; display: boolean }).value = 30;
  mergeWaterSpot(m2, { itemId: s2.id, part: "waterspot_cold", widthCm: 21, heightCm: 15 });
  assert.deepEqual(s2.over_floor, { value: 50, display: false, value_2: 30 });
  // пристенная cold + hot → cold_hot (не composite): высоты не трогаются
  const m3 = baseModel();
  const s3 = addWallSpot(m3, 1500, "waterspot_cold");
  mergeWaterSpot(m3, { itemId: s3.id, part: "waterspot_hot", widthCm: 16, heightCm: 9 });
  assert.deepEqual(s3.over_floor, { value: 50, display: false }, "cold_hot не composite — over_floor без изменений");
  // свободный вывод: переименование без правки высот (freeAndWallIsWall ложно)
  const m4 = baseModel();
  const s4 = addSpot(m4, 150, 150, "waterspot_cold");
  mergeWaterSpot(m4, { itemId: s4.id, part: "waterspot_drainage", widthCm: 21, heightCm: 15 });
  assert.deepEqual(s4.over_floor, { value: 50, display: false }, "у свободного вывода value_2 не появляется");
  // цель уже composite: высоты не переопределяются (value/value_2 остаются согласованными)
  const m5 = baseModel();
  const s5 = addWallSpot(m5, 1500, "waterspot_drainage_hot");
  (s5.over_floor as { value: number; display: boolean; value_2?: number }).value_2 = 33;
  mergeWaterSpot(m5, { itemId: s5.id, part: "waterspot_cold", widthCm: 21, heightCm: 15 });
  assert.deepEqual(s5.over_floor, { value: 50, display: false, value_2: 33 }, "composite-цель: только имя");
});

test("360: merge — недопустимая пара INVALID_ARGUMENT, модель не меняется (атомарность)", () => {
  const model = baseModel();
  const spot = addSpot(model, 150, 150, "waterspot_cold_hot");
  const before = structuredClone(model);
  assert.throws(
    () => mergeWaterSpot(model, { itemId: spot.id, part: "waterspot_cold", widthCm: 21, heightCm: 15 }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && (e as McpError).message.includes("не объединяется"),
  );
  assert.deepEqual(model, before);
  // merge несуществующего предмета
  assert.throws(() => mergeWaterSpot(model, { itemId: "_nope", part: "waterspot_cold", widthCm: 1, heightCm: 1 }), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
  assert.deepEqual(model, before);
  // pure-хелпер согласован с модельной функцией
  assert.equal(waterSpotMergeResult("waterspot_cold", "waterspot_cold"), null);
  assert.equal(waterSpotMergeResult("waterspot_cold", "waterspot_hot"), "waterspot_cold_hot");
});

// ---------- waterspot_unset ----------

test("360: unset — все пути structure_items, id сохранён, габариты из каталога", () => {
  for (const [combined, parts] of Object.entries(WS_UNSET_RESULT)) {
    for (const [part, result] of Object.entries(parts)) {
      const model = baseModel();
      const spot = addSpot(model, 150, 100, combined);
      const res = unsetWaterSpot(model, { itemId: spot.id, part, widthCm: WS_CATALOG.tools[result]!.width, heightCm: WS_CATALOG.tools[result]!.height });
      assert.equal(res.result, result, `${combined} − ${part} → ${result}`);
      assert.equal(spot.name, result);
      assert.equal(spot.id, (model.items[spot.id] as ItemProps).id);
      assert.equal(spot.width, WS_CATALOG.tools[result]!.width);
      assert.equal(spot.height, WS_CATALOG.tools[result]!.height);
    }
  }
});

test("360: unset over_floor — остаток-канализация забирает value_2, остаток-вода сохраняет value", () => {
  const m1 = baseModel();
  const s1 = addWallSpot(m1, 1500, "waterspot_drainage_cold_hot");
  (s1.over_floor as { value: number; display: boolean; value_2?: number }).value_2 = 40;
  unsetWaterSpot(m1, { itemId: s1.id, part: "waterspot_drainage", widthCm: 16, heightCm: 9 });
  assert.equal(s1.name, "waterspot_cold_hot");
  assert.deepEqual(s1.over_floor, { value: 50, display: false }, "остаток-вода: value сохранён, value_2 удалён");
  assert.equal((s1.over_floor as { value_2?: number }).value_2, undefined);

  const m2 = baseModel();
  const s2 = addWallSpot(m2, 1500, "waterspot_drainage_cold_hot");
  (s2.over_floor as { value: number; display: boolean; value_2?: number }).value_2 = 40;
  unsetWaterSpot(m2, { itemId: s2.id, part: "waterspot_hot", widthCm: 21, heightCm: 15 });
  assert.equal(s2.name, "waterspot_drainage_cold");
  // ревью 364 №1: результат drainage_cold — тоже composite (GroupWaterSpots.unset_item:
  // !in_array(i, composite_items)) — высоты composite→composite не трогаются
  assert.deepEqual(s2.over_floor, { value: 50, display: false, value_2: 40 }, "composite→composite: value и value_2 сохранены");

  const m2b = baseModel();
  const s2b = addWallSpot(m2b, 1500, "waterspot_drainage_cold_hot");
  (s2b.over_floor as { value: number; display: boolean; value_2?: number }).value_2 = 40;
  unsetWaterSpot(m2b, { itemId: s2b.id, part: "waterspot_cold", widthCm: 21, heightCm: 15 });
  assert.equal(s2b.name, "waterspot_drainage_hot");
  assert.deepEqual(s2b.over_floor, { value: 50, display: false, value_2: 40 }, "composite→composite (hot): высоты не трогаются");

  // не пристенный вывод: высоты не трогаются (freeAndWallIsWall ложно в редакторе)
  const m3 = baseModel();
  const s3 = addSpot(m3, 150, 150, "waterspot_drainage_cold");
  (s3.over_floor as { value: number; display: boolean; value_2?: number }).value_2 = 40;
  unsetWaterSpot(m3, { itemId: s3.id, part: "waterspot_cold", widthCm: 15, heightCm: 15 });
  assert.deepEqual(s3.over_floor, { value: 50, display: false, value_2: 40 }, "свободный вывод: over_floor без изменений");
});

test("360: unset каскад трубы — скалярная ссылка, концевой вывод: труба удаляется", () => {
  const model = baseModel();
  const spot = addWallSpot(model, 1500, "waterspot_drainage_cold_hot");
  const node = addSpot(model, 250, 100, "waterspot_drainage");
  const pipe = addPipe(model, { kind: "drainage", path: [{ itemId: spot.id }, { itemId: node.id }] });
  assert.equal((spot as ItemProps & { pipes?: Record<string, unknown> }).pipes!.drainage_pipe_id, pipe.id);
  const res = unsetWaterSpot(model, { itemId: spot.id, part: "waterspot_drainage", widthCm: 16, heightCm: 9 });
  assert.equal(res.result, "waterspot_cold_hot");
  assert.deepEqual(res.pipes.deleted, [pipe.id], "труба канализации удаляется вместе со снятой частью");
  assert.deepEqual(res.pipes.created, []);
  assert.equal(pipesOf(model)[pipe.id], undefined);
  // предмет остался, ссылка на трубу снята (бокс пуст, как unsetFromItems редактора), сосед не задет
  assert.deepEqual((spot as ItemProps & { pipes?: Record<string, unknown> }).pipes, {});
  assert.equal(model.items[node.id]!.name, "waterspot_drainage");
  // атомарность ошибки: неснимаемая часть модель не меняет
  const snapshot = structuredClone(model);
  assert.throws(() => unsetWaterSpot(model, { itemId: spot.id, part: "waterspot_drainage", widthCm: 1, heightCm: 1 }), waterSpotUnsetError("waterspot_cold_hot", "waterspot_drainage"));
  assert.deepEqual(model, snapshot);
});

test("360: unset каскад — вершина в цепочке из 3: кусков нет, труба удаляется, соседи теряют ссылки", () => {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_drainage");
  const mid = addSpot(model, 200, 100, "waterspot_drainage_cold_hot");
  const b = addSpot(model, 300, 100, "waterspot_drainage");
  addPipe(model, { kind: "drainage", path: [{ itemId: a.id }, { itemId: mid.id }, { itemId: b.id }] });
  const res = unsetWaterSpot(model, { itemId: mid.id, part: "waterspot_drainage", widthCm: 16, heightCm: 9 });
  assert.equal(res.result, "waterspot_cold_hot", "сняли канализацию → остались вода + ГВС (structure_items)");
  assert.equal(res.pipes.created.length, 0, "соседи остались одиночками — кусков нет (deleteByItem)");
  assert.equal(Object.keys(pipesOf(model)).length, 0);
  assert.deepEqual((a as ItemProps & { pipes?: Record<string, unknown> }).pipes, {});
  assert.deepEqual((b as ItemProps & { pipes?: Record<string, unknown> }).pipes, {});
  assert.deepEqual((mid as ItemProps & { pipes?: Record<string, unknown> }).pipes, {});
});

test("360: unset каскад с внутренней вершиной 5-вершинной трубы — труба делится, ссылки переписаны", () => {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_drainage");
  const mid = addSpot(model, 200, 100, "waterspot_drainage_cold_hot");
  const b = addSpot(model, 300, 100, "waterspot_drainage");
  const pipe = addPipe(model, { kind: "drainage", path: [{ itemId: a.id }, { x: 1500, y: 1000 }, { itemId: mid.id }, { x: 2500, y: 1000 }, { itemId: b.id }] });
  const res = unsetWaterSpot(model, { itemId: mid.id, part: "waterspot_drainage", widthCm: 16, heightCm: 9 });
  assert.equal(res.result, "waterspot_cold_hot", "сняли канализацию → остались вода + ГВС (structure_items)");
  assert.deepEqual(res.pipes.deleted, [pipe.id], "исходная труба распалась");
  assert.equal(res.pipes.created.length, 2, "два куска ≥2 вершин — две новые трубы");
  const all = Object.values(pipesOf(model));
  assert.equal(all.length, 2);
  for (const p of all) {
    assert.equal(p.type, "drainage_pipe", "кусок наследует вид трубы");
    assert.equal(p.vertexes.length, 2, "кусок: предмет + перенятый узел");
  }
  // обратные ссылки переписаны на новые id (set_tree_id редактора)
  assert.deepEqual((a as ItemProps & { pipes?: Record<string, unknown> }).pipes!.drainage_pipe_id, all.find((p) => p.items[a.id])!.id);
  assert.deepEqual((b as ItemProps & { pipes?: Record<string, unknown> }).pipes!.drainage_pipe_id, all.find((p) => p.items[b.id])!.id);
  // у переименованного вывода ссылки на трубу больше нет
  assert.deepEqual((mid as ItemProps & { pipes?: Record<string, unknown> }).pipes, {});
});

test("365: unset — конец трубы из 3 вершин: висячей ссылки нет, сверка подключений пуста", () => {
  const model = baseModel();
  const col = addSpot(model, 100, 100, "waterspot_drainage");
  const a = addSpot(model, 300, 100, "waterspot_drainage_cold_hot");
  const pipe = addPipe(model, { kind: "drainage", path: [{ itemId: col.id }, { x: 1500, y: 1000 }, { itemId: a.id }] });
  assert.equal(pipe.vertexes.length, 3);
  const res = unsetWaterSpot(model, { itemId: a.id, part: "waterspot_drainage", widthCm: 16, heightCm: 9 });
  assert.equal(res.result, "waterspot_cold_hot");
  // один связный кусок [вывод, узел] — та же труба (rebuildGraph редактора)
  assert.deepEqual(res.pipes, { deleted: [], created: [] });
  const p = pipesOf(model)[pipe.id]!;
  assert.ok(p, "труба жива");
  assert.deepEqual(p.vertexes.map((v) => v.id).sort(), [col.id, pipe.vertexes[1]!.id].sort());
  // ревью 364 №2: у снятого вывода не остаётся ссылки на трубу, в которой его больше нет
  assert.deepEqual((a as ItemProps & { pipes?: Record<string, unknown> }).pipes, {}, "у снятой вершины ссылки нет");
  assert.equal((col as ItemProps & { pipes?: Record<string, unknown> }).pipes!.drainage_pipe_id, pipe.id, "ссылка соседа жива");
  // сверка подключений на той же модели пуста (иначе онлайн-нормализация откатит мутацию)
  const mm = pipeConnectionMismatches(structuredClone(pipesOf(model)), model.items as never, structuredClone(pipesOf(model)), model.items as never, { onlyTypes: WATER_PIPE_TYPES });
  assert.deepEqual(mm, []);
});

// ---------- распад труб всех видов: ключи обратных ссылок (ревью 364 №11) ----------

type RawItem = ItemProps & Record<string, unknown>;

function rawSpot(model: Model, id: string, name: string, xCm: number, box: string): RawItem {
  const item = {
    id, name, pc: { x: xCm, y: 100 }, width: 10, height: 10, angle: 0, plan: { water: 27 },
    [box]: {},
  } as RawItem;
  model.items[id] = item;
  return item;
}

function rawSplitPipe(
  model: Model,
  pipeId: string,
  type: string,
  coll: string,
  ends: [string, string],
): void {
  const ids = [ends[0]!, "n1", "x", "n2", ends[1]!];
  const types: Record<string, string> = { n1: "node", x: "node", n2: "node" };
  const vertexes = ids.map((id, i) => ({ id, point: { x: 100 + i * 100, y: 100 }, type: types[id] ?? "waterspot" }));
  const matrix: ({ length: number } | null)[][] = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => null));
  for (let i = 0; i + 1 < 5; i++) {
    matrix[i]![i + 1] = { length: 1 };
    matrix[i + 1]![i] = { length: 1 };
  }
  (model as unknown as Record<string, Record<string, Pipe>>)[coll]![pipeId] = {
    id: pipeId, type: type as Pipe["type"], length: 4, items: Object.fromEntries(ids.map((id) => [id, types[id] ?? "waterspot"])),
    vertexes, matrix,
  } as Pipe;
}

test("365: распад трубы каждого вида — обратные ссылки по PIPE_LINK_KEY_BY_TYPE, сверка пуста", () => {
  const CASES: { type: string; coll: string; kind: "water" | "climate"; item: string; box: string; multi?: boolean }[] = [
    { type: "water_pipe", coll: "pipes", kind: "water", item: "waterspot_cold", box: "pipes" },
    { type: "water_hot_pipe", coll: "pipes", kind: "water", item: "waterspot_hot", box: "pipes" },
    { type: "drainage_pipe", coll: "pipes", kind: "water", item: "waterspot_drainage", box: "pipes" },
    { type: "warm_floor_pipe", coll: "pipes_warm_floor", kind: "climate", item: "radiator_collector", box: "pipes_warm_floor", multi: true },
    { type: "conditioner_drainage", coll: "pipes_conditioner", kind: "climate", item: "conditioner", box: "pipes_conditioner" },
    { type: "heat_pipe_hot", coll: "pipes_heat", kind: "climate", item: "radiator_bimetal", box: "pipes_heat" },
    { type: "ventpipe_out", coll: "pipes_ventilation", kind: "climate", item: "fan", box: "pipes_ventilation" },
  ];
  for (const c of CASES) {
    const model = baseModel();
    (model as unknown as Record<string, Record<string, Pipe>>)[c.coll] ??= {};
    const left = rawSpot(model, "L", c.item, 100, c.box);
    const right = rawSpot(model, "S", c.item, 500, c.box);
    rawSplitPipe(model, "P1", c.type, c.coll, ["L", "S"]);
    const res = removePipeVertex(model, "P1", "x");
    assert.equal(res.created.length, 2, `${c.type}: два куска`);
    assert.deepEqual(res.deleted, ["P1"]);
    const key = PIPE_LINK_KEY_BY_TYPE[c.type]!;
    for (const end of [left, right]) {
      const held = end[c.box] as Record<string, unknown>;
      const piece = Object.values((model as unknown as Record<string, Record<string, Pipe>>)[c.coll]!).find((p) => p.items[end.id])!;
      const ref = held[key];
      assert.ok(
        c.multi ? Array.isArray(ref) && ref.includes(piece.id) : ref === piece.id,
        `${c.type}: у ${end.id} ссылка ${key} → ${piece.id} (факт ${JSON.stringify(ref)})`,
      );
      // прежний ошибочный ключ `${type}_id` не появляется там, где он не канонический
      // (ревью 364 №11: conditioner_drainage/warm_floor_pipe)
      if (`${c.type}_id` !== key) assert.equal(held[`${c.type}_id`], undefined, `${c.type}: ключа ${c.type}_id нет`);
    }
    const pipes = (model as unknown as Record<string, Record<string, Pipe>>)[c.coll];
    const onlyTypes = new Set([c.type]);
    const mm = pipeConnectionMismatches(structuredClone(pipes) as never, model.items as never, structuredClone(pipes) as never, model.items as never, { onlyTypes });
    assert.deepEqual(mm, [], `${c.type}: сверка подключений пуста`);
  }
});

test("367: распад трубы — куски наследуют color_custom и spots исходной (addNew бандла, ревью 366 №3)", () => {
  const CASES: { type: string; coll: string; item: string; box: string; extra: Record<string, unknown> }[] = [
    { type: "water_pipe", coll: "pipes", item: "waterspot_cold", box: "pipes", extra: { color_custom: "#112233", width_stroke: 3, prs: { a: 1 } } },
    { type: "ventpipe_out", coll: "pipes_ventilation", item: "fan", box: "pipes_ventilation", extra: { color_custom: "#445566", spots: { s1: 1 } } },
  ];
  for (const c of CASES) {
    const model = baseModel();
    (model as unknown as Record<string, Record<string, Pipe>>)[c.coll] ??= {};
    const left = rawSpot(model, "L", c.item, 100, c.box);
    const right = rawSpot(model, "S", c.item, 500, c.box);
    rawSplitPipe(model, "P1", c.type, c.coll, ["L", "S"]);
    const pipe = (model as unknown as Record<string, Record<string, Pipe>>)[c.coll]!["P1"]!;
    Object.assign(pipe as unknown as Record<string, unknown>, structuredClone(c.extra));
    removePipeVertex(model, "P1", "x");
    const pieces = Object.values((model as unknown as Record<string, Record<string, Pipe>>)[c.coll]!);
    assert.equal(pieces.length, 2, `${c.type}: два куска`);
    for (const piece of pieces) {
      for (const [k, v] of Object.entries(c.extra)) {
        assert.deepEqual((piece as unknown as Record<string, unknown>)[k], v, `${c.type}: кусок ${piece.id} наследует ${k}`);
      }
    }
    // у вершин-предметов ссылки переписаны (куски те же, что проверяет 365 №11)
    assert.ok(pieces.every((p) => p.items[left.id] || p.items[right.id]));
  }
});

test("365: removePipeVertex — multi-предмет в двух вершинах одной трубы: снимается из обеих", () => {  const model = baseModel();
  const col = rawSpot(model, "C", "waterspot_collector", 200, "pipes") as RawItem;
  (model as unknown as Record<string, Record<string, Pipe>>).pipes ??= {};
  // труба C(вершина 0) – n1 – x – n2 – C(вершина 4): multi-предмет в двух вершинах
  rawSplitPipe(model, "P1", "water_pipe", "pipes", ["C", "C"]);
  const pipe = (model as unknown as Record<string, Record<string, Pipe>>).pipes!["P1"]!;
  pipe.items["C"] = "multi";
  pipe.vertexes[0]!.type = "multi";
  pipe.vertexes[4]!.type = "multi";
  (col.pipes as Record<string, unknown>)!.water_pipe_id = ["P1"];
  // бандл deleteByItem: рекурсивное снятие обоих вхождений; после снятия остаётся
  // связный кусок узлов — та же труба без multi-предмета, ссылка снята
  const res = removePipeVertex(model, "P1", "C");
  assert.deepEqual(res.deleted, [], "кусок узлов жив — та же труба (rebuildGraph)");
  assert.deepEqual(res.created, []);
  const rest = pipesOf(model)["P1"]!;
  assert.ok(rest, "труба узлов жива");
  assert.deepEqual(rest.vertexes.map((v) => v.id).sort(), ["n1", "n2", "x"].sort());
  assert.deepEqual(col.pipes, {}, "ссылка коллектора снята");
});

// ---------- removePipeVertex (deleteByItem) ----------

test("360: removePipeVertex — концевой узел укорачивает, внутренний делит, из двух вершин удаляет", () => {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_cold");
  const b = addSpot(model, 300, 100, "waterspot_cold");
  const pipe = addPipe(model, { kind: "water", path: [{ itemId: a.id }, { x: 1500, y: 1000 }, { x: 2000, y: 1000 }, { x: 2500, y: 1000 }, { itemId: b.id }] });
  assert.equal(pipe.vertexes.length, 5);
  const n1 = pipe.vertexes[1]!.id;
  const n2 = pipe.vertexes[2]!.id;
  const n3 = pipe.vertexes[3]!.id;
  // 1) концевой узел n3: остался один кусок С РЁБРАМИ [a,n1,n2] и одиночка b —
  // бандл (1===A.length → rebuildGraph): та же труба без вершины, b теряет ссылку
  // (ревью 364 №3: условие «та же труба» — linked.length===1, не comps.length===1)
  const resEdge = removePipeVertex(model, pipe.id, n3);
  assert.deepEqual(resEdge.deleted, [], "id трубы сохранён (rebuildGraph редактора)");
  assert.deepEqual(resEdge.created, []);
  const p1 = pipesOf(model)[pipe.id]!;
  assert.equal(p1.vertexes.length, 3, "кусок = связная тройка a-n1-n2");
  assert.deepEqual([...p1.vertexes.map((v) => v.id)].sort(), [a.id, n1, n2].sort());
  assert.equal(p1.length, gasLengthM(p1));
  assert.deepEqual((b as ItemProps & { pipes?: Record<string, unknown> }).pipes, {}, "отрезанный конец теряет ссылку");
  assert.equal((a as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, pipe.id, "ссылка a жива (id сохранён)");
  // 2) внутренний узел n2 — оставшиеся a,n1 связны и покрывают весь граф (A.length===1):
  // та же труба без вершины (rebuildGraph редактора), id сохраняется
  const res = removePipeVertex(model, p1.id, n2);
  assert.deepEqual(res.deleted, []);
  assert.deepEqual(res.created, []);
  const part = pipesOf(model)[p1.id]!;
  assert.equal(part.type, "water_pipe");
  assert.deepEqual(part.vertexes.map((v) => v.id).sort(), [a.id, n1].sort(), "та же труба без удалённого узла");
  assert.equal(part.length, gasLengthM(part), "длина пересчитана по рёбрам");
  assert.equal((a as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, part.id);
  // 3) труба из двух вершин удаляется целиком
  const c = addSpot(model, 350, 100, "waterspot_cold");
  const two = addPipe(model, { kind: "water", path: [{ itemId: c.id }, { x: 2000, y: 1500 }] });
  const resTwo = removePipeVertex(model, two.id, two.vertexes[0]!.id);
  assert.deepEqual(resTwo.deleted, [two.id]);
  assert.equal(pipesOf(model)[two.id], undefined);
  assert.deepEqual((c as ItemProps & { pipes?: Record<string, unknown> }).pipes, {}, "ссылка снята");
});

test("360: removePipeVertex — граф без рёбер (все вершины-одиночки) удаляет трубу целиком", () => {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_cold");
  const b = addSpot(model, 200, 100, "waterspot_cold");
  const c = addSpot(model, 300, 100, "waterspot_cold");
  addPipe(model, { kind: "water", path: [{ itemId: a.id }, { itemId: b.id }, { itemId: c.id }] });
  // цепочка a-b-c без b: a и c — одиночки, рёбер нет → труба целиком (deleteByItem)
  const pipeId = Object.keys(pipesOf(model))[0]!;
  const res = removePipeVertex(model, pipeId, pipesOf(model)[pipeId]!.vertexes[1]!.id);
  assert.deepEqual(res.deleted, [pipeId]);
  assert.deepEqual(res.created, []);
  assert.equal(Object.keys(pipesOf(model)).length, 0);
  // предметы живы, ссылки сняты (пустой бокс — unsetFromItems редактора)
  assert.ok(model.items[a.id] && model.items[c.id]);
  assert.deepEqual((a as ItemProps & { pipes?: Record<string, unknown> }).pipes, {});
  assert.deepEqual((c as ItemProps & { pipes?: Record<string, unknown> }).pipes, {});
});

test("360: removePipeVertex — multi-предмет (коллектор): массив ссылок сокращается", () => {
  const model = baseModel();
  const col = addSpot(model, 300, 100, "waterspot_collector");
  const a = addSpot(model, 100, 100, "waterspot_cold");
  const p1 = addPipe(model, { kind: "water", path: [{ itemId: a.id }, { itemId: col.id }] });
  const p2 = addPipe(model, { kind: "water", path: [{ x: 1000, y: 1500 }, { itemId: col.id }] });
  assert.deepEqual((col as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, [p1.id, p2.id]);
  removePipeVertex(model, p1.id, col.id);
  assert.deepEqual((col as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, [p2.id], "осталась ссылка только на живую трубу");
  deletePipe(model, p2.id);
  assert.deepEqual((col as ItemProps & { pipes?: Record<string, unknown> }).pipes, {}, "бокс пуст после снятия последней ссылки");
});

test("360: removePipeVertex — несуществующие труба/вершина NOT_FOUND, модель не меняется", () => {
  const model = baseModel();
  const spot = addSpot(model, 100, 100, "waterspot_cold");
  addPipe(model, { kind: "water", path: [{ itemId: spot.id }, { x: 2000, y: 1000 }] });
  const before = structuredClone(model);
  assert.throws(() => removePipeVertex(model, "_nope", spot.id), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
  const pipeId = Object.keys(pipesOf(model))[0]!;
  assert.throws(() => removePipeVertex(model, pipeId, "_nopvertex"), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
  assert.deepEqual(model, before);
});

// ---------- item_delete: каскад труб (этап 360, replace отказа 78) ----------

test("360: item_delete вывода-внутренней вершины 5-вершинной трубы — труба делится, created_pipes с новыми id", () => {
  const model = baseModel();
  const mid = addSpot(model, 200, 100, "waterspot_cold_hot");
  const a = addSpot(model, 100, 100, "waterspot_cold");
  const b = addSpot(model, 300, 100, "waterspot_cold");
  const pipe = addPipe(model, { kind: "water", path: [{ itemId: a.id }, { x: 1500, y: 1000 }, { itemId: mid.id }, { x: 2500, y: 1000 }, { itemId: b.id }] });
  const res = deleteItem(model, mid.id);
  assert.deepEqual(res.deleted_pipes, [pipe.id]);
  assert.equal(res.created_pipes.length, 2, "два куска после удаления внутренней вершины");
  assert.equal(model.items[mid.id], undefined);
  assert.equal(Object.keys(pipesOf(model)).length, 2);
  // ссылки обоих соседей переписаны на свои куски
  const all = Object.values(pipesOf(model));
  assert.equal((a as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, all.find((p) => p.items[a.id])!.id);
  assert.equal((b as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, all.find((p) => p.items[b.id])!.id);
});

test("360: item_delete узла-предмета с двумя трубами (cold_hot: water+hot) — каскад по обеим", () => {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_cold_hot");
  const n1 = addSpot(model, 200, 100, "waterspot_cold");
  const n2 = addSpot(model, 200, 200, "waterspot_hot");
  const p1 = addPipe(model, { kind: "water", path: [{ itemId: a.id }, { itemId: n1.id }] });
  const p2 = addPipe(model, { kind: "hot", path: [{ itemId: a.id }, { itemId: n2.id }] });
  const res = deleteItem(model, a.id);
  assert.deepEqual([...res.deleted_pipes].sort(), [p1.id, p2.id].sort(), "обе трубы из 2 вершин удалены");
  assert.equal(Object.keys(pipesOf(model)).length, 0);
  assert.ok(model.items[n1.id] && model.items[n2.id], "соседние выводы живы");
});

// ---------- PRO-гейт waterspot_merge ----------

const AUTH = (tariff: "free" | "pro") => async () => ({
  logged_in: true, login_error: false, tariff, projects: [],
  mode: "account", projects_limit: 5, account_email_masked: null,
});

test("360: PRO-гейт merge — одиночные части (PRO): free отказ, pro проходит; свободные части — без гейта", async () => {
  assert.deepEqual(PRO_WATER_SPOT_SINGLES, ["waterspot_cold", "waterspot_drainage", "waterspot_hot"],
    "все три одиночных вывода — PRO в эталоне 328-pro-anon (ключи из единого списка)");
  for (const part of ["waterspot_cold", "waterspot_hot", "waterspot_drainage"]) {
    await assert.rejects(
      assertProPartialAllowed({ authStatus: AUTH("free") }, { anon: false }, "waterspot_merge", part),
      (e: unknown) => (e as { code?: string }).code === "NOT_AVAILABLE_ON_TARIFF",
    );
    await assert.doesNotReject(
      assertProPartialAllowed({ authStatus: AUTH("pro") }, { anon: false }, "waterspot_merge", part),
    );
    await assert.rejects(
      assertProPartialAllowed({ authStatus: AUTH("pro") }, { anon: true }, "waterspot_merge", part),
      (e: unknown) => (e as { code?: string }).code === "NOT_AVAILABLE_ON_TARIFF",
      "анонимный проект = бесплатный тариф",
    );
  }
  // части-комбинации — free-инструменты: гейт молчит
  for (const part of ["waterspot_cold_hot", "waterspot_drainage_cold", "waterspot_drainage_hot"]) {
    await assert.doesNotReject(
      assertProPartialAllowed({ authStatus: AUTH("free") }, { anon: false }, "waterspot_merge", part),
    );
  }
});

// ---------- узел waterspot_node и трубы (живая проба 360-ws-live-recon) ----------

test("360: эталон ui-ref-plumb3-node-pipe — труба до узла-предмета: вершина node без ссылки (обе стороны)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-plumb3-node-pipe.json"), "utf8"));
  const m = fx.model_object as Record<string, unknown>;
  assert.equal(m["type"], "water_pipe");
  assert.deepEqual((m["items"] as Record<string, string>), { v1: "node", v2: "node" });
  // обратная сторона: pipe_add с item_id узла-предмета воспроизводит формат
  const model = baseModel();
  const node = addSpot(model, 120, 100, "waterspot_node");
  const pipe = addPipe(model, { kind: "water", path: [{ x: 2000, y: 1000 }, { itemId: node.id }] });
  assert.equal(pipe.type, m["type"]);
  assert.deepEqual(Object.values(pipe.items).sort(), Object.values(m["items"] as Record<string, string>).sort(), "все вершины — node (id вершин генерируются)");
  assert.equal(pipe.vertexes.every((v) => v.type === "node"), true);
  assert.deepEqual(pipe.vertexes[1]!.point, { x: node.pc.x, y: node.pc.y });
});

test("360: pipe_add {item_id узла} — обычная вершина node в точке предмета, без обратной ссылки (как в редакторе)", () => {
  const model = baseModel();
  const node = addSpot(model, 150, 100, "waterspot_node");
  const a = addSpot(model, 100, 100, "waterspot_cold");
  const pipe = addPipe(model, { kind: "water", path: [{ itemId: a.id }, { itemId: node.id }] });
  assert.equal(pipe.vertexes.length, 2);
  const v = pipe.vertexes[1]!;
  assert.equal(v.type, "node", "вершина узла — type node, не предмет");
  assert.deepEqual(v.point, { x: node.pc.x, y: node.pc.y }, "точка вершины = pc узла-предмета");
  assert.notEqual(v.id, node.id, "вершина не ссылается на предмет");
  assert.deepEqual((node as ItemProps & { pipes?: unknown }).pipes, undefined, "у узла-предмета нет props.pipes");
  assert.equal(pipe.items[v.id], "node");
  // перенос узла-предмета не двигает вершину (в редакторе связи нет — проба 360)
  updateItem(model, { itemId: node.id, center: { x: 2500, y: 1000 } });
  assert.deepEqual(pipe.vertexes[1]!.point, { x: v.point.x, y: v.point.y }, "вершина трубы не следует за узлом-предметом");
  // удаление узла-предмета не затрагивает трубу (нет ссылки — каскада нет)
  const res = deleteItem(model, node.id);
  assert.deepEqual(res.deleted_pipes, []);
  assert.deepEqual(res.created_pipes, []);
  assert.equal(pipesOf(model)[pipe.id]!.vertexes.length, 2, "труба цела");
});

function gasLengthM(pipe: Pick<Pipe, "vertexes" | "matrix">): number {
  let cm = 0;
  for (let i = 0; i < pipe.vertexes.length; i++) {
    for (let j = i + 1; j < pipe.vertexes.length; j++) {
      if ((pipe.matrix[i]?.[j] ?? null) !== null) {
        cm += Math.hypot(pipe.vertexes[i]!.point.x - pipe.vertexes[j]!.point.x, pipe.vertexes[i]!.point.y - pipe.vertexes[j]!.point.y);
      }
    }
  }
  return Math.round((cm / 100) * 100) / 100;
}
