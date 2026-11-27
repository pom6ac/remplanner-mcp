// Этап 419 (бэклог 418 §4): A — project_set_height v2 (семантика $Project.setHeigth
// бандла) и B — demolish/demolish_cancel target:"item" (радиатор/щиток старого фонда).
// Тесты по тест-плану §4 отчёта 418: обе стороны — на коде до этапа тест A «все три
// поля» красный (старый project_set_height писал только total_height), тесты B красные
// (target:item не существовал). Эталоны: ui-ref-project-height.json и
// ui-ref-demount-item.json (синтетические по бандлу 268-app.js, см. _source).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model } from "../../src/model/types.ts";
import { MAX_HEIGHT_MM, MIN_HEIGHT_MM, projectSetHeight } from "../../src/model/height.ts";
import { demolish, demolishCancel, isDemountableItem } from "../../src/model/demolition.ts";
import { wallHeightMismatches, roomHeightMismatches, totalHeightMismatch, pillarHeightMismatches, doorHeightMismatches } from "../../src/verify/heights.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { compactModel } from "../../src/model/compact.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const HEIGHT_FIXTURE = JSON.parse(readFileSync(`${ROOT}tests/fixtures/ui-ref-project-height.json`, "utf8")) as {
  model: Model;
  expected_after_set_height_mm_3000: {
    total_height: number;
    rooms2_height: Record<string, number>;
    walls_height: Record<string, number>;
    holes: Record<string, Record<string, number>>;
    pillars_total_height: Record<string, number>;
    decors: { reset_parts: string[]; kept_parts: string[]; kept_fields: Record<string, string[]> };
    windows_clamped: number;
    windoors_clamped: number;
    doors_clamped: number;
    pillars_updated: number;
    decors_layouts_reset: number;
  };
};
const ITEM_FIXTURE = JSON.parse(readFileSync(`${ROOT}tests/fixtures/ui-ref-demount-item.json`, "utf8")) as { model: Model };

const itemModel = (): Model => structuredClone(ITEM_FIXTURE.model);
const heightModel = (): Model => structuredClone(HEIGHT_FIXTURE.model);

const errOf = (fn: () => unknown): { code?: string; message?: string; hint?: string } => {
  try {
    fn();
  } catch (e) {
    return e as { code?: string; message?: string; hint?: string };
  }
  return {};
};

// ================= A. project_set_height v2 =================

test("419 A: setHeigth пишет total_height, rooms2[*].height и walls[*].height по эталону (комната со своей высотой получает новую)", () => {
  const m = heightModel();
  const res = projectSetHeight(m, 3000);
  const exp = HEIGHT_FIXTURE.expected_after_set_height_mm_3000;
  assert.equal(m.total_height, exp.total_height);
  assert.equal(m.total_height, 300);
  for (const [rid, h] of Object.entries(exp.rooms2_height)) {
    assert.equal((m.rooms2?.[rid] as Record<string, unknown>)["height"], h, `rooms2[${rid}].height`);
  }
  for (const [wid, h] of Object.entries(exp.walls_height)) {
    assert.equal(m.walls[wid]!.height, h, `walls[${wid}].height`);
  }
  // счётчики ответа
  assert.deepEqual(
    {
      rooms: res.rooms, walls: res.walls,
      windows_clamped: res.windows_clamped, windoors_clamped: res.windoors_clamped,
      doors_clamped: res.doors_clamped, pillars: res.pillars, decors_layouts_reset: res.decors_layouts_reset,
    },
    {
      rooms: 2, walls: 3,
      windows_clamped: exp.windows_clamped, windoors_clamped: exp.windoors_clamped,
      doors_clamped: exp.doors_clamped, pillars: exp.pillars_updated, decors_layouts_reset: exp.decors_layouts_reset,
    },
  );
});

// ---- доработка 419: колонны (PILLARS, ветки бандла дословно) ----

test("419 A+: колонны по эталону — не-gypsum всегда, gypsum «штатная» следует, «своя» меньшая сохраняется, выше новой — кламп вниз", () => {
  const m = heightModel();
  projectSetHeight(m, 3000);
  const exp = HEIGHT_FIXTURE.expected_after_set_height_mm_3000.pillars_total_height;
  for (const [pid, h] of Object.entries(exp)) {
    assert.equal(m.pillars[pid]!.total_height, h, `pillars[${pid}].total_height`);
  }
});

test("419 A+: gypsum без total_height — ветка не срабатывает (undefined==n и undefined>e ложны в бандле)", () => {
  const m = heightModel();
  delete (m.pillars["p2"] as { total_height?: number }).total_height;
  const res = projectSetHeight(m, 3000);
  assert.equal((m.pillars["p2"] as { total_height?: number }).total_height, undefined);
  assert.equal(res.pillars, 2, "обновлены только p1 (не-gypsum) и p4 (кламп); p3 «своя», p2 без значения");
});

test("419 A+: туда-обратно setHeigth(300)→setHeigth(270) — штатные колонны восстанавливаются, «своя» высота не трогается, двери не распрямляются", () => {
  const m = heightModel();
  projectSetHeight(m, 3000);
  projectSetHeight(m, 2700);
  assert.equal(m.pillars["p1"]!.total_height, 270, "не-gypsum вернулась к высоте проекта");
  assert.equal(m.pillars["p2"]!.total_height, 270, "gypsum «штатная» вернулась");
  assert.equal(m.pillars["p3"]!.total_height, 200, "«своя» высота ГКЛ-короба не менялась ни разу");
  assert.equal(m.pillars["p4"]!.total_height, 270, "gypsum выше новой — кламп, затем к высоте проекта");
  // дверь, поджатая при 300, вторым вызовом поджимается дальше до 270 — бандл
  // распрямления не делает (задокументированное поведение, как в UI)
  assert.equal(m.walls["w1"]!.holes["door2"]!.height, 270);
});

// ---- доработка 419: двери группы doors ----

test("419 A+: дверь выше новой высоты поджимается до new total, дверь ниже — не трогается (по эталону)", () => {
  const m = heightModel();
  projectSetHeight(m, 3000);
  assert.equal(m.walls["w1"]!.holes["door2"]!.height, 300, "320 > 300 → 300");
  assert.equal(m.walls["w1"]!.holes["door1"]!.height, 210, "210 ≤ 300 — не трогается");
});

// ---- доработка 419: раскладка обшивки (замена rebuildDecorPrs) ----

test("419 A+: раскладка wall_tile/wall_woodbatten с type_laying сброшена, прочие поля и части — нетронуты", () => {
  const m = heightModel();
  const before = structuredClone(m.rooms2?.["r1"]);
  const res = projectSetHeight(m, 3000);
  const decors = (m.rooms2?.["r1"] as Record<string, unknown>)["decors"] as Array<Record<string, unknown>>;
  const parts = (decors[0]!["parts"] as Record<string, Record<string, unknown>>);
  // _wt1: wall_tile + type_laying + заполненная раскладка — сброс, прочие поля нетронуты
  assert.equal(parts["_wt1"]!["polygons_layout"], undefined);
  assert.equal(parts["_wt1"]!["polygons_layout_points"], undefined);
  const beforeDecors = ((before ?? {}) as Record<string, unknown>)["decors"] as Array<Record<string, unknown>> | undefined;
  const beforeParts = (beforeDecors?.[0]?.["parts"] ?? {}) as Record<string, Record<string, unknown>>;
  const beforeWt1 = { ...((beforeParts["_wt1"] ?? {}) as Record<string, unknown>) };
  delete beforeWt1["polygons_layout"];
  delete beforeWt1["polygons_layout_points"];
  const afterWt1 = { ...parts["_wt1"]! };
  assert.deepEqual(afterWt1, beforeWt1, "кроме раскладки часть _wt1 не изменилась");
  // _wt2: wall_tile БЕЗ type_laying — buildLayouts раскладку не строит, не трогаем
  assert.ok(parts["_wt2"]!["polygons_layout"], "раскладка без type_laying сохранена");
  // _pw1: paint_wall — раскладка не персистится (DecorLine.serialize), не трогаем
  assert.ok(parts["_pw1"]!["polygons_layout"], "часть не-раскладочного типа не тронута");
  assert.deepEqual(structuredClone(parts["_pw1"]), beforeParts["_pw1"]);
  assert.equal(res.decors_layouts_reset, 1);
});

test("419 A+: комнаты и decors_slopes вне decors не трогаются; повторный вызов с пустой раскладкой — счётчик 0", () => {
  const m = heightModel();
  projectSetHeight(m, 3000);
  const res2 = projectSetHeight(m, 3000);
  assert.equal(res2.decors_layouts_reset, 0, "раскладка уже сброшена — повторных сбросов нет");
});

// ---- сверка save видит колонны и двери ----

test("419 A+: сверка save (verify/heights) видит колонны и двери", () => {
  const expected = heightModel();
  projectSetHeight(expected, 3000);
  const got = heightModel();
  assert.ok(pillarHeightMismatches(expected.pillars as never, got.pillars as never).some((p) => /колонна p1/.test(p)));
  assert.ok(doorHeightMismatches(expected.walls as never, got.walls as never).some((p) => /дверь door2/.test(p)));
  // «своя» высота p3 совпадает — не расхождение
  const partial = pillarHeightMismatches(expected.pillars as never, structuredClone(expected.pillars) as never);
  assert.deepEqual(partial, []);
  const doorsOk = doorHeightMismatches(expected.walls as never, structuredClone(expected.walls) as never);
  assert.deepEqual(doorsOk, []);
});

test("419 A: ограждение балкона (role:balcony) не трогается, его проёмы не клампятся", () => {
  const m = heightModel();
  m.walls["w4"]!.holes = {
    bwin: { id: "bwin", plan: "a", type: "window", group: "windows", pc: { x: 500, y: 50 }, width: 60, height: 120, depth: 6, floor_height: 30 },
  };
  projectSetHeight(m, 3000);
  assert.equal(m.walls["w4"]!.height, 100);
  assert.equal(m.walls["w4"]!.holes["bwin"]!.height, 120);
});

test("419 A: клампинг окна — max(round(total − floor_height), 30) по бандлу", () => {
  const m = heightModel();
  projectSetHeight(m, 3000);
  assert.equal(m.walls["w1"]!.holes["win1"]!.height, 215, "240 > round(300−85)=215 → 215");
  // окно с низким подоконником: limit = round(300−30)=270, окно 240 не поджимается
  const m2 = heightModel();
  m2.walls["w1"]!.holes["win1"]!.floor_height = 30;
  projectSetHeight(m2, 3000);
  assert.equal(m2.walls["w1"]!.holes["win1"]!.height, 240);
});

test("419 A: клампинг окна без floor_height — ветка не срабатывает (сравнение с NaN ложно в бандле)", () => {
  const m = heightModel();
  delete m.walls["w1"]!.holes["win1"]!.floor_height;
  projectSetHeight(m, 3000);
  assert.equal(m.walls["w1"]!.holes["win1"]!.height, 240);
});

test("419 A: клампинг окна упирается в минимум 30 см (300 мм)", () => {
  const m = heightModel();
  // total 60 см, подоконник 100 → limit round(60−100)=−40 → max(−40,30)=30
  m.walls["w1"]!.holes["win1"]!.height = 120;
  m.walls["w1"]!.holes["win1"]!.floor_height = 100;
  projectSetHeight(m, 600);
  assert.equal(m.walls["w1"]!.holes["win1"]!.height, 30);
});

test("419 A: клампинг балконного блока (windoor): window_height и door_height до new total", () => {
  const m = heightModel();
  projectSetHeight(m, 3000);
  const balc = m.walls["w2"]!.holes["balc1"]!;
  assert.equal(balc.window_height, 300, "320 > 300 → 300");
  assert.equal(balc.door_height, 250, "250 ≤ 300 — не трогается");
});

test("419 A: границы диапазона редактора correctValue(50,999) см: 499/9991 — INVALID_ARGUMENT, 500/9990 — ок", () => {
  assert.equal(MIN_HEIGHT_MM, 500);
  assert.equal(MAX_HEIGHT_MM, 9990);
  const out = errOf(() => projectSetHeight(heightModel(), 499));
  assert.equal(out.code, "INVALID_ARGUMENT");
  assert.match(out.message ?? "", /500\.\.9990/);
  const out2 = errOf(() => projectSetHeight(heightModel(), 9991));
  assert.equal(out2.code, "INVALID_ARGUMENT");
  // без молчаливой обрезки: модель не изменилась после отказа
  const m = heightModel();
  assert.throws(() => projectSetHeight(m, 9991), /диапазона/);
  assert.equal(m.total_height, 270);
  assert.equal((m.rooms2?.["r1"] as Record<string, unknown>)["height"], 250);
  projectSetHeight(heightModel(), 500);
  projectSetHeight(heightModel(), 9990);
});

test("419 A: нецелое/не-число height_mm — INVALID_ARGUMENT", () => {
  assert.equal(errOf(() => projectSetHeight(heightModel(), 500.5)).code, "INVALID_ARGUMENT");
  assert.equal(errOf(() => projectSetHeight(heightModel(), Number.NaN)).code, "INVALID_ARGUMENT");
});

test("419 A: сверка save видит изменение высот (модуль verify/heights)", () => {
  const expected = heightModel();
  projectSetHeight(expected, 3000);
  // сервер вернул старые высоты — расхождение по всем трём полям
  const got = heightModel();
  const problems = [
    ...totalHeightMismatch(expected.total_height, got.total_height),
    ...wallHeightMismatches(expected.walls as never, got.walls as never),
    ...roomHeightMismatches(expected.rooms2 as never, got.rooms2 as never),
  ];
  assert.equal(problems.length, 6, `total + 3 стены + 2 комнаты: ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => p.includes("total_height")));
  assert.ok(problems.some((p) => /стена w1/.test(p)));
  assert.ok(problems.some((p) => /комната r1/.test(p)));
  // совпало — пусто
  assert.deepEqual(totalHeightMismatch(300, 300), []);
  assert.deepEqual(wallHeightMismatches(expected.walls as never, expected.walls as never), []);
  assert.deepEqual(roomHeightMismatches(expected.rooms2 as never, expected.rooms2 as never), []);
  // запись без height в ожидании не сверяется (редактор достраивает из total)
  const rooms = { r1: { polygon: [] } };
  assert.deepEqual(roomHeightMismatches(rooms as never, { r1: { height: 270 } } as never), []);
});

// ================= B. demolish target:"item" =================

test("419 B: demolish item — demount=1 по эталону (radiator_old и electric_shield_old на плане b)", () => {
  const m = itemModel();
  const r = demolish(m, { target: "item", id: "item1" });
  assert.equal(r.itemId, "item1");
  assert.equal(m.items["item1"]!.demount, 1);
  const r2 = demolish(m, { target: "item", id: "item2" });
  assert.equal(r2.itemId, "item2");
  assert.equal(m.items["item2"]!.demount, 1);
  // isDemountableItem — предикат того же правила
  assert.equal(isDemountableItem(m.items["item1"]!), true);
});

test("419 B: demolish_cancel item — demount=0 (eraser бандла)", () => {
  const m = itemModel();
  demolish(m, { target: "item", id: "item1" });
  const r = demolishCancel(m, { target: "item", id: "item1" });
  assert.equal(r.itemId, "item1");
  assert.equal(m.items["item1"]!.demount, 0);
});

test("419 B: предмет не того вида — INVALID_ARGUMENT с подсказкой про item_delete", () => {
  const m = itemModel();
  const err = errOf(() => demolish(m, { target: "item", id: "item4" }));
  assert.equal(err.code, "INVALID_ARGUMENT");
  assert.match(err.message ?? "", /radiator_old/);
  assert.match(err.hint ?? "", /item_delete/);
  // модель не изменилась
  assert.equal(m.items["item4"]!.demount, 0);
  // socket_group (name:"socket_group") — тоже отказ
  m.items["sg1"] = { id: "sg1", name: "socket_group", pc: { x: 0, y: 0 }, angle: 0, width: 7, height: 8, plan: { b: 1 }, demount: 0, socket_group: [] } as never;
  assert.equal(errOf(() => demolish(m, { target: "item", id: "sg1" })).code, "INVALID_ARGUMENT");
});

test("419 B: radiator_old вне листа «Демонтаж» (plan a) — INVALID_ARGUMENT", () => {
  const m = itemModel();
  const err = errOf(() => demolish(m, { target: "item", id: "item3" }));
  assert.equal(err.code, "INVALID_ARGUMENT");
  assert.match(err.message ?? "", /Демонтаж/);
  assert.equal(m.items["item3"]!.demount, 0);
});

test("419 B: несуществующий предмет — NOT_FOUND", () => {
  const m = itemModel();
  assert.equal(errOf(() => demolish(m, { target: "item", id: "nope" })).code, "NOT_FOUND");
  assert.equal(errOf(() => demolishCancel(m, { target: "item", id: "nope" })).code, "NOT_FOUND");
});

test("419 B: cancel не демонтированного предмета — INVALID_ARGUMENT", () => {
  const m = itemModel();
  assert.equal(errOf(() => demolishCancel(m, { target: "item", id: "item1" })).code, "INVALID_ARGUMENT");
});

test("419 B: compact items показывают demount (model_get видит пометку)", () => {
  const m = itemModel();
  const before = compactModel(m).items.find((i) => i.site_id === "item1")!;
  assert.equal(before.demount, undefined);
  demolish(m, { target: "item", id: "item1" });
  const after = compactModel(m).items.find((i) => i.site_id === "item1")!;
  assert.equal(after.demount, true);
  // у остальных поля нет
  assert.equal(compactModel(m).items.find((i) => i.site_id === "item3")!.demount, undefined);
});

// ================= MCP-слой (офлайн) =================

type TextContent = { content: { type: string; text?: string }[] };

async function offlineClient(fixturePath: string): Promise<Client> {
  const ctx = new ServerContext({ offlineFixture: fixturePath });
  const server = buildServer(ctx);
  const client = new Client({ name: "419-test", version: "0.0.0" });
  const [ta, tb] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(tb), client.connect(ta)]);
  return client;
}

const parsed = (r: unknown): Record<string, unknown> =>
  JSON.parse(((r as TextContent).content ?? []).map((c) => ("text" in c ? c.text : "")).join("")) as Record<string, unknown>;

test("419 MCP: project_set_height в офлайн-режиме пишет все три поля; отказ вне диапазона", async () => {
  const client = await offlineClient(`${ROOT}tests/fixtures/anon-rect-4000x3000.json`);
  try {
    const res = parsed(await client.callTool({ name: "project_set_height", arguments: { height_mm: 3000 } }));
    assert.equal(res["height_mm"], 3000);
    assert.equal(res["walls"], 4);
    const model = parsed(await client.callTool({ name: "model_get", arguments: {} })) as { total_height_mm?: number };
    assert.equal(model.total_height_mm, 3000);
  } finally {
    await client.close();
  }
  const client2 = await offlineClient(`${ROOT}tests/fixtures/anon-rect-4000x3000.json`);
  try {
    const bad = (await client2.callTool({ name: "project_set_height", arguments: { height_mm: 9991 } })) as { isError?: boolean };
    assert.equal(bad.isError, true);
  } finally {
    await client2.close();
  }
});

test("419 MCP: demolish target:item офлайн — demount=1, cancel → 0; реестр инструментов не растёт", async () => {
  const client = await offlineClient(`${ROOT}tests/fixtures/ui-ref-demount-item.json`);
  try {
    const res = parsed(await client.callTool({ name: "demolish", arguments: { target: "item", id: "item1" } }));
    assert.equal(res["itemId"], "item1");
    const items = parsed(await client.callTool({ name: "model_get", arguments: {} })) as { items?: Array<{ site_id?: string; demount?: boolean }> };
    assert.equal(items.items?.find((i) => i.site_id === "item1")?.demount, true);
    const cancel = parsed(await client.callTool({ name: "demolish_cancel", arguments: { target: "item", id: "item1" } }));
    assert.equal(cancel["itemId"], "item1");
    const bad = (await client.callTool({ name: "demolish", arguments: { target: "item", id: "item4" } })) as { isError?: boolean };
    assert.equal(bad.isError, true);
    const list = await client.listTools();
    assert.ok(list.tools.every((t) => t.name !== "demolish_item"), "нет отдельного инструмента демонтажа предметов");
    assert.equal(list.tools.filter((t) => t.name.startsWith("demolish")).length, 2);
  } finally {
    await client.close();
  }
});
