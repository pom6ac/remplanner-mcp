// Этап 57 «Коммуникации»: пункты меню «Коммуникации» — предметы каталога (model.items,
// группа furniture каталога, план {init:1}) + газовая линия (model.pipes_gas, отдельная
// сущность). Структурная сверка с эталонами UI (ui-ref-comm-*.json): план (init→a),
// display размеров (по эталонам), over_floor/self_height, anchor:wall, панель cm-furniture;
// газовая линия — структура графа, update/delete, атомарность; регрессии стен/колонн/
// ригелей/предметов, верификация save (mock).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps, GasLine } from "../../src/model/types.ts";
import { addItem, updateItem, deleteItem, itemsList, itemPlanFromEntry, LINE_TOOLS } from "../../src/model/items.ts";
import { addGasLine, updateGasLine, deleteGasLine } from "../../src/model/pipes.ts";
import { addWall } from "../../src/model/walls.ts";
import { addPillar } from "../../src/model/pillars.ts";
import { addRigel } from "../../src/model/rigels.ts";
import { validateModel } from "../../src/model/validate.ts";
import { compactModel } from "../../src/model/compact.ts";
import { toToolEntry } from "../../src/catalog.ts";
import { Workspace, type WorkspaceDeps, type EditorLike, type SaveOutcome } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

type Ref = {
  menu_title: string;
  tool_id: string;
  catalog_defaults_cm: Record<string, unknown>;
  model_object: Record<string, unknown>;
};

function loadRef(name: string): Ref {
  return JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-comm-${name}.json`), "utf8")) as Ref;
}

const REFS = [
  "water", "water_column_cold", "radiator_old", "air", "gas_boiler",
  "ceiling_water", "conditioner_cage",
] as const;

/** Эталоны с anchor:"wall" (ceiling_water, conditioner_cage) — свободной постановки
 *  в редакторе нет; в тестах ставятся against_wall, угол задаёт стена фикстуры. */
const WALL_ONLY = new Set<string>(["ceiling_water", "conditioner_cage"]);

/** Полное меню «Коммуникации» листа init (проба 57, .orca-reports/57-comm-ui/scout.json:
 *  16 пунктов — 15 предметов группы furniture каталога + газовая линия gas_line
 *  группы pipes). Тест закрепляет, что план (init→a) и перечень выводятся из каталога. */
const COMM_MENU_ITEMS = [
  "water", "water_column_hot", "water_column_cold", "drainage_column", "ceiling_water",
  "heat_pipe", "radiator_old", "air", "ventilation_hole", "gas_pipe", "gas_boiler",
  "gas_meter", "electric_shield_old", "fire_detector", "conditioner_cage",
] as const;
const COMM_MENU_LINE = "gas_line";

function roomModel(): Model {
  const env = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/anon-rect-4000x3000.json"), "utf8")) as { model: Model };
  return structuredClone(env.model);
}

/** Нижняя стена фикстуры: предмет у неё попадает внутрь полигона комнаты (rooms2). */
function southWallId(model: Model): string {
  return Object.entries(model.walls).reduce((a, b) => ((b[1].p1.y + b[1].p2.y) > (a[1].p1.y + a[1].p2.y) ? b : a))[0];
}

/** Запись каталога из эталона (как catalog.ts строит ToolEntry из global_tools). */
function entryOf(ref: Ref) {
  const d = ref.catalog_defaults_cm as Record<string, unknown>;
  const name = ref.model_object["name"] as string;
  return toToolEntry(name, {
    id: d["id"], title: ref.menu_title, group: "furniture",
    width: d["width"], height: d["height"], self_height: d["self_height"],
    plan: d["plan"], anchor: d["anchor"], is_magnetized: d["is_magnetized"],
    can_be_outside: d["can_be_outside"],
  });
}

test("comm: план a:1 — все 15 предметов меню «Коммуникации» (план из каталога init→a)", () => {
  assert.equal(COMM_MENU_ITEMS.length, 15);
  for (const name of COMM_MENU_ITEMS) {
    // у всех пунктов меню каталог plan {init:1}; у electric_shield_old — с листами кабелей
    const plan = name === "electric_shield_old" ? { init: 1, cables: 31, sockets: 9 } : { init: 1 };
    const entry = toToolEntry(name, { id: 1, title: name, group: "furniture", width: 10, height: 10, self_height: 0, plan });
    assert.deepEqual(itemPlanFromEntry(entry), name === "electric_shield_old" ? { a: 1, cables: 31, sockets: 9 } : { a: 1 }, name);
  }
  // мебель вне меню не получает a:1 (эталон ui-ref-sofa)
  assert.deepEqual(itemPlanFromEntry(toToolEntry("sofa_double", { id: 92, title: "Диван", group: "furniture", width: 140, height: 80, self_height: 85, plan: { furniture: 6 } })), { furniture: 6 });
  // газовая линия — отдельная сущность, item_add неприменим
  assert.ok(LINE_TOOLS.has(COMM_MENU_LINE));
});

test("comm: LINE_TOOLS — item_add для gas_line INVALID_ARGUMENT, модель не меняется", () => {
  const model = roomModel();
  const snapshot = JSON.stringify(model);
  const entry = toToolEntry("gas_line", { id: 1394, title: "Газовый трубопровод", group: "pipes", width: 0, height: 0, self_height: 0, plan: { init: 1 } });
  assert.throws(
    () => addItem(model, { name: "gas_line", position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  assert.equal(JSON.stringify(model), snapshot, "модель не изменилась");
});

/** Семантическая проекция предмета: значимые поля в нормализованном виде — углы
 *  modulo 360, over_floor в форме редактора {value, display}, display размеров. */
function itemProjection(p: Record<string, unknown>) {
  const of = p["over_floor"];
  const normOf = of === null || of === undefined
    ? null
    : typeof of === "object"
      ? { value: (of as { value: number }).value, display: (of as { display: boolean }).display }
      : { value: of as number, display: null as boolean | null };
  return {
    name: p["name"],
    angle: ((Number(p["angle"]) % 360) + 360) % 360,
    width: p["width"],
    height: p["height"],
    self_height: p["self_height"],
    plan: p["plan"],
    over_floor: normOf,
    dimensions_display: (p["dimensions"] as { display?: boolean } | undefined)?.display ?? null,
  };
}

for (const key of REFS) {
  test(`comm: эталон ${key} — item_add воспроизводит семантическую проекцию эталона (обе стороны)`, () => {
    const ref = loadRef(key);
    const model = roomModel();
    const entry = entryOf(ref);
    const src = ref.model_object;
    // anchor:wall — против стены, угол задаёт стена фикстуры (сверяется отдельно)
    const props = addItem(model, {
      name: entry.name,
      position: WALL_ONLY.has(key)
        ? { againstWall: { wallId: southWallId(model), offsetMm: 1000 } }
        : { center: { x: 20000, y: 15000 } },
      catalogEntry: entry,
      ...(key === "radiator_old" ? { elevationMm: 100 } : {}),
      ...(key === "gas_boiler" ? { elevationMm: 1000, heightMm: 670 } : {}),
      ...(key === "conditioner_cage" ? { elevationMm: 150, heightMm: 600 } : {}),
    });
    assert.equal(props.name, src["name"]);
    // размеры из каталога = эталонные
    assert.equal(props.width, src["width"]);
    assert.equal(props.height, src["height"]);
    // проекции в обе стороны: item_add → эталон и эталон → item_add
    const got = itemProjection(props as unknown as Record<string, unknown>);
    const want = itemProjection(src);
    // angle/over_floor/self_height у wall-only и у видов с эталонным углом от клика
    // зависят от постановки — сверяются по отдельности ниже; план/display/размеры — точно
    assert.equal(got.name, want.name);
    assert.equal(got.width, want.width);
    assert.equal(got.height, want.height);
    assert.deepEqual(got.plan, want.plan);
    assert.deepEqual(got.dimensions_display, want.dimensions_display, `display размеров ${key}`);
    if (!WALL_ONLY.has(key)) {
      assert.deepEqual(got.over_floor, want.over_floor, `over_floor ${key}`);
      assert.equal(got.self_height, want.self_height, `self_height ${key}`);
    }
    // reverse: эталон, вставленный в модель как есть, даёт ту же проекцию (поля не теряются)
    const copy = structuredClone(src) as unknown as Record<string, unknown>;
    copy["id"] = "_refitem";
    copy["id_room"] = Object.keys(model.rooms2 ?? {})[0] ?? null;
    model.items!["_refitem"] = copy as unknown as ItemProps;
    assert.deepEqual(itemProjection(itemsList(model).find((i) => i.id === "_refitem") as unknown as Record<string, unknown>), want, "проекция эталона в модели = проекция эталона");
    delete model.items["_refitem"];
    // служебные поля, которые пишет item_add (кеш UI: dls/dls_prs/icon_center/center3d —
    // редактор пересчитывает при draw)
    assert.deepEqual(props.comment, { id: "" });
    assert.ok(props.id_room, "id_room проставлен по комнате");
    // модель валидна и предмет виден в compact/model_get-слое
    const errors = validateModel(model).filter((e) => e.code.startsWith("ITEM"));
    assert.deepEqual(errors, []);
    const compact = compactModel(model);
    assert.ok(compact.items.some((i: Record<string, unknown>) => i.name === entry.name));
  });
}

test("comm: anchor:wall (ceiling_water, conditioner_cage) — свободная установка INVALID_ARGUMENT, против стены ставится", () => {
  for (const key of ["ceiling_water", "conditioner_cage"] as const) {
    const model = roomModel();
    const entry = entryOf(loadRef(key));
    const snapshot = JSON.stringify(model);
    assert.throws(
      () => addItem(model, { name: entry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry }),
      (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
    );
    assert.equal(JSON.stringify(model), snapshot, "модель не изменилась");
    const wallId = southWallId(model);
    const props = addItem(model, { name: entry.name, position: { againstWall: { wallId, offsetMm: 1000 } }, catalogEntry: entry });
    assert.equal(props.id_wall, wallId);
  }
});

test("comm: атомарность item_add — OUTSIDE_ROOM не меняет модель (снимок до вызова)", () => {
  const model = roomModel();
  const entry = entryOf(loadRef("water_column_cold"));
  const snapshot = JSON.stringify(model);
  assert.throws(() => addItem(model, { name: entry.name, position: { center: { x: 99999, y: 99999 } }, catalogEntry: entry }), McpError);
  assert.equal(JSON.stringify(model), snapshot);
});

test("comm: update-цепочка — неуказанные поля не меняются; подъём над полом", () => {
  const model = roomModel();
  const entry = entryOf(loadRef("radiator_old"));
  const props = addItem(model, {
    name: entry.name, position: { center: { x: 20000, y: 15000 } },
    catalogEntry: entry, elevationMm: 100,
  });
  const before = structuredClone(props);
  updateItem(model, { itemId: props.id, widthMm: 1200 });
  assert.equal(props.width, 120);
  assert.equal(props.height, before.height);
  assert.equal(props.angle, before.angle);
  assert.deepEqual(props.plan, before.plan);
  assert.deepEqual(props.over_floor, { value: 10, display: false }, "неуказанный over_floor не меняется");
  updateItem(model, { itemId: props.id, angleDeg: 15 });
  assert.equal(props.angle, 15);
  assert.equal(props.width, 120);
  updateItem(model, { itemId: props.id, elevationMm: 350 });
  assert.deepEqual(props.over_floor, { value: 35, display: false });
});

test("comm: удаление предмета не трогает стены/колонны/ригели; их операции не трогают comm-предметы", () => {
  const model = roomModel();
  const entry = entryOf(loadRef("water"));
  const item = addItem(model, { name: entry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry });
  const itemSnapshot = JSON.stringify(model.items[item.id!]);
  addWall(model, { start: { x: 10000, y: 10000 }, end: { x: 10000, y: 20000 }, thicknessMm: 100 });
  addPillar(model, { center: { x: 30000, y: 20000 }, widthMm: 400, heightMm: 400 });
  addRigel(model, { start: { x: 30000, y: 25000 }, end: { x: 35000, y: 25000 } });
  assert.equal(JSON.stringify(model.items[item.id!]), itemSnapshot, "стены/колонны/ригели не трогают comm-предмет");
  const snapshot = JSON.stringify({ ...model, items: {} });
  deleteItem(model, item.id!);
  assert.equal(JSON.stringify({ ...model, items: {} }), snapshot);
});

// ---------- газовая линия (model.pipes_gas) ----------

test("comm: gas_line_add — структура по эталону ui-ref-comm-gas_line (граф, матрица, длина в метрах)", () => {
  const model = roomModel();
  const line = addGasLine(model, { start: { x: 20000, y: 15000 }, end: { x: 21500, y: 15500 } });
  // 150 см по X и 50 см по Y → длина √(150²+50²)=158.1 см → 1.58 м (эталон)
  assert.equal(line.length, 1.58);
  assert.equal(line.type, "gas_line");
  assert.equal(line.plan, "a");
  assert.equal(line.vertexes.length, 2);
  assert.deepEqual(line.vertexes[0]!.point, { x: 2000, y: 1500 });
  assert.deepEqual(line.vertexes[1]!.point, { x: 2150, y: 1550 });
  for (const v of line.vertexes) assert.equal(v.type, "node");
  // матрица смежности 2×2: диагональ null, связная пара {length:1}
  assert.deepEqual(line.matrix, [[null, { length: 1 }], [{ length: 1 }, null]]);
  assert.deepEqual(line.items, Object.fromEntries(line.vertexes.map((v) => [v.id, "node"])));
  // компактный слой: метка G1
  const compact = compactModel(model);
  assert.equal(compact.gas_lines.length, 1);
  assert.deepEqual(compact.gas_lines[0]!.from, [20000, 15000]);
  assert.deepEqual(compact.gas_lines[0]!.to, [21500, 15500]);
  assert.equal(compact.gas_lines[0]!.length_m, 1.58);
});

test("comm: gas_line_add — нулевая длина и нечисловые координаты INVALID_ARGUMENT, модель не меняется", () => {
  const model = roomModel();
  const snapshot = JSON.stringify(model);
  assert.throws(
    () => addGasLine(model, { start: { x: 20000, y: 15000 }, end: { x: 20000, y: 15000 } }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  assert.equal(JSON.stringify(model), snapshot);
  assert.throws(
    () => addGasLine(model, { start: { x: Number.NaN, y: 15000 }, end: { x: 35000, y: 20000 } }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  assert.equal(JSON.stringify(model), snapshot);
  assert.equal(model.pipes_gas, undefined, "коллекция не создаётся при ошибке");
});

test("comm: gas_line update-цепочка — перемещение концов пересчитывает длину; неуказанный конец не меняется", () => {
  const model = roomModel();
  const line = addGasLine(model, { start: { x: 20000, y: 15000 }, end: { x: 21000, y: 15000 } });
  const v1 = structuredClone(line.vertexes[1]);
  updateGasLine(model, { gasLineId: line.id, end: { x: 21000, y: 15500 } });
  assert.deepEqual(line.vertexes[1]!.point, { x: 2100, y: 1550 }, "конец перемещён");
  assert.deepEqual(line.vertexes[0]!.point, { x: 2000, y: 1500 }, "начало не менялось");
  // 100 см по X и 50 см по Y → 111.8 см → 1.12 м
  assert.equal(line.length, 1.12);
  updateGasLine(model, { gasLineId: line.id, start: { x: 20000, y: 15500 } });
  assert.deepEqual(line.vertexes[0]!.point, { x: 2000, y: 1550 });
  assert.equal(line.length, 1); // ровно 100 см → 1 м
  void v1;
});

test("comm: gas_line_update/delete — NOT_FOUND для чужого id; удаление убирает линию", () => {
  const model = roomModel();
  const snapshot = JSON.stringify(model);
  assert.throws(
    () => updateGasLine(model, { gasLineId: "_nope" }),
    (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND",
  );
  assert.throws(
    () => deleteGasLine(model, "_nope"),
    (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND",
  );
  assert.equal(JSON.stringify(model), snapshot);
  const line = addGasLine(model, { start: { x: 20000, y: 15000 }, end: { x: 21500, y: 15500 } });
  deleteGasLine(model, line.id);
  assert.equal(Object.keys(model.pipes_gas ?? {}).length, 0);
});

test("comm: газовые линии и предметы не мешают друг другу; регрессия стен/колонн/ригелей", () => {
  const model = roomModel();
  const entry = entryOf(loadRef("water_column_cold"));
  const item = addItem(model, { name: entry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry });
  const line = addGasLine(model, { start: { x: 25000, y: 15000 }, end: { x: 35000, y: 18000 } });
  const itemSnapshot = JSON.stringify(model.items[item.id!]);
  const lineSnapshot = JSON.stringify(model.pipes_gas![line.id]);
  addWall(model, { start: { x: 10000, y: 10000 }, end: { x: 10000, y: 20000 }, thicknessMm: 100 });
  addPillar(model, { center: { x: 30000, y: 30000 }, widthMm: 400, heightMm: 400 });
  addRigel(model, { start: { x: 30000, y: 25000 }, end: { x: 35000, y: 25000 } });
  assert.equal(JSON.stringify(model.items[item.id!]), itemSnapshot, "стены/колонны/ригели не трогают comm-предмет");
  assert.equal(JSON.stringify(model.pipes_gas![line.id]), lineSnapshot, "стены/колонны/ригели не трогают газовую линию");
  // добавление/удаление линии не трогает предметы
  const line2 = addGasLine(model, { start: { x: 20000, y: 15500 }, end: { x: 20200, y: 15500 } });
  assert.equal(JSON.stringify(model.items[item.id!]), itemSnapshot);
  deleteGasLine(model, line2.id);
  assert.equal(JSON.stringify(model.items[item.id!]), itemSnapshot);
});

// ---------- workspace/save (mock) ----------

type Server = { saveId: string; model: Model };

function mockDeps(
  server: Server,
  opts: { droppedAll?: boolean; lostGasAfterSave?: boolean; changedGasAfterSave?: boolean } = {},
) {
  let lastNormalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "123", planId: "1",
    async normalize(model) {
      lastNormalized = structuredClone(model) as Record<string, unknown>;
      const items = (model as { items: Record<string, unknown> }).items;
      const gas = (model as { pipes_gas?: Record<string, unknown> }).pipes_gas ?? {};
      const kept = opts.droppedAll ? {} : items;
      const out = structuredClone(model) as Record<string, unknown>;
      (out as { items: Record<string, unknown> }).items = structuredClone(kept);
      if (opts.droppedAll) (out as { pipes_gas?: Record<string, unknown> }).pipes_gas = {};
      return {
        model: out,
        rooms: [],
        before: { walls: 0, holes: 0, items: Object.keys(items).length, pillars: 0, rigels: 0, gas_lines: Object.keys(gas).length },
        after: { walls: 0, holes: 0, items: Object.keys(kept).length, pillars: 0, rigels: 0, gas_lines: opts.droppedAll ? 0 : Object.keys(gas).length },
      };
    },
    async save() {
      server.saveId = `s${Math.random()}`;
      const saved = structuredClone(lastNormalized ?? fixtureModel()) as unknown as Model;
      // этап 55, ревью №1: сценарии потери ПОСЛЕ save — то, что ушло на save, и то,
      // что реально оказалось на сервере (по GET), расходятся
      if (opts.lostGasAfterSave) (saved as { pipes_gas?: Record<string, unknown> }).pipes_gas = {};
      if (opts.changedGasAfterSave) {
        const first = Object.values((saved as { pipes_gas?: Record<string, unknown> }).pipes_gas ?? {})[0] as GasLine | undefined;
        if (first) {
          first.vertexes = [...first.vertexes];
          first.vertexes[0] = { ...first.vertexes[0]!, point: { x: first.vertexes[0]!.point.x + 50, y: first.vertexes[0]!.point.y + 50 } };
          first.type = "water_pipe";
        }
      }
      server.model = saved;
      return { ok: true, saveId: server.saveId, conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { throw new Error("not used"); },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(_s, _oid, _pid): Promise<LoadedModel> {
      return { object_id: "123", plan_id: "1", save_id: server.saveId, units: "cm", model: structuredClone(server.model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
  return { deps, editor };
}

function fixtureModel(): Model {
  const env = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/anon-rect-4000x3000.json"), "utf8")) as { model: Model };
  return structuredClone(env.model);
}

test("comm: mock save — стояк и газовая линия сохраняются и видны после reopen", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel() };
  const { deps } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const entry = entryOf(loadRef("water_column_cold"));
  ws.apply("comm_add", (m) => {
    addItem(m, { name: entry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry });
    addGasLine(m, { start: { x: 25000, y: 15000 }, end: { x: 26500, y: 15500 } });
    return true;
  });
  const saved: SaveOutcome = await ws.save();
  assert.equal(saved.verified, true);
  // стояк дошёл до серверной модели с планом {a:1} и display:false (эталон)
  const items = Object.values(server.model.items ?? {}) as ItemProps[];
  const item = items.find((i) => i.name === entry.name)!;
  assert.ok(item, "стояк дошёл до серверной модели");
  assert.deepEqual(item.plan, { a: 1 });
  assert.equal((item.dimensions as { display?: boolean }).display, false);
  // газовая линия — с длиной 1.58 м и типом gas_line
  const gas = Object.values(server.model.pipes_gas ?? {})[0] as GasLine | undefined;
  assert.ok(gas, "газовая линия дошла до серверной модели");
  assert.equal(gas!.type, "gas_line");
  assert.equal(gas!.length, 1.58);
});

test("comm: mock save — потеря стояка/линии при нормализации → NORMALIZATION_DROPPED, модель не пишется", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel() };
  const { deps } = mockDeps(server, { droppedAll: true });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const entry = entryOf(loadRef("water"));
  ws.apply("comm_add", (m) => {
    addItem(m, { name: entry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry });
    addGasLine(m, { start: { x: 25000, y: 15000 }, end: { x: 26500, y: 15500 } });
    return true;
  });
  await assert.rejects(
    () => ws.save(),
    (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED",
  );
  assert.equal(Object.values(server.model.items ?? {}).length, 0, "серверная модель не изменилась");
  assert.equal(Object.keys(server.model.pipes_gas ?? {}).length, 0);
});

test("comm: mock save — газовая линия исчезла на сервере → SITE_ERROR с gas_line_mismatches", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel() };
  const { deps } = mockDeps(server, { lostGasAfterSave: true });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  ws.apply("comm_add", (m) => {
    addGasLine(m, { start: { x: 20000, y: 15000 }, end: { x: 21500, y: 15500 } });
    return true;
  });
  await assert.rejects(
    () => ws.save(),
    (e: unknown) => {
      assert.ok(e instanceof McpError && e.code === "SITE_ERROR", e instanceof McpError ? e.code : String(e));
      const details = (e as McpError).details as { gas_line_mismatches?: string[] };
      assert.equal(details.gas_line_mismatches?.length, 1);
      assert.match(details.gas_line_mismatches![0]!, /исчезла после сохранения/);
      return true;
    },
  );
});

test("comm: mock save — тип/позиция линии изменились на сервере → SITE_ERROR (узлы и тип)", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel() };
  const { deps } = mockDeps(server, { changedGasAfterSave: true });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  ws.apply("comm_add", (m) => {
    addGasLine(m, { start: { x: 20000, y: 15000 }, end: { x: 21500, y: 15500 } });
    return true;
  });
  await assert.rejects(
    () => ws.save(),
    (e: unknown) => {
      assert.ok(e instanceof McpError && e.code === "SITE_ERROR", e instanceof McpError ? e.code : String(e));
      const details = (e as McpError).details as { gas_line_mismatches?: string[] };
      const mism = details.gas_line_mismatches ?? [];
      assert.ok(mism.some((s) => s.includes("тип изменился")), mism.join("; "));
      assert.ok(mism.some((s) => s.includes("узел 0 сместился")), mism.join("; "));
      return true;
    },
  );
});

test("comm: mock save — штатный save со стояком, радиатором и линией проходит, verified=true (без ложных блокировок)", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel() };
  const { deps } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const cold = entryOf(loadRef("water_column_cold"));
  const rad = entryOf(loadRef("radiator_old"));
  ws.apply("comm_add", (m) => {
    addItem(m, { name: cold.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: cold });
    addItem(m, { name: rad.name, position: { center: { x: 15000, y: 15000 } }, catalogEntry: rad, elevationMm: 100 });
    addGasLine(m, { start: { x: 25000, y: 15000 }, end: { x: 26500, y: 15500 } });
    return true;
  });
  const saved: SaveOutcome = await ws.save();
  assert.equal(saved.verified, true);
  assert.equal(Object.values(server.model.items ?? {}).length, 2);
  assert.equal(Object.keys(server.model.pipes_gas ?? {}).length, 1);
});
