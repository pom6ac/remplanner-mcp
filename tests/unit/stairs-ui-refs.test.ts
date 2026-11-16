// Этап 53 «Лестницы»: лестницы — предметы каталога (model.items, группа stairs и пункты
// меню «Лестницы» листа init). Структурная сверка с эталонами UI (ui-ref-stair-*.json):
// план (init→a, a:1 у пунктов меню), поля item_add, update-цепочки, удаление, атомарность,
// регрессии стен/колонн/ригелей/проёмов, верификация save (mock).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps } from "../../src/model/types.ts";
import { addItem, updateItem, deleteItem, itemsList, STAIR_MENU_EXTRA, itemPlanFromEntry } from "../../src/model/items.ts";
import { addWall } from "../../src/model/walls.ts";
import { addPillar } from "../../src/model/pillars.ts";
import { addRigel } from "../../src/model/rigels.ts";
import { validateModel } from "../../src/model/validate.ts";
import { compactModel } from "../../src/model/compact.ts";
import { toToolEntry } from "../../src/catalog.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
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
  return JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-stair-${name}.json`), "utf8")) as Ref;
}

const REFS = ["ladder_march", "ladder_2march", "spiral_staircase", "upper_march", "porch", "stair_spot"] as const;

/** Эталоны с anchor:"wall" — свободная постановка center/in_room в редакторе не выполняется
 *  (этап 55, ревью №4); в тестах ставятся against_wall, угол зависит от стены фикстуры. */
const WALL_ONLY = new Set<string>(["porch", "stair_spot"]);

/** Полное меню «Лестницы» из каталога (проба 53, .orca-reports/53-stairs-ui/scout.json:
 *  21 позиция группы `stairs` + stair_machine/stair_spot, которые редактор показывает
 *  в том же меню при группах furniture/lights). Тест закрепляет, что правило плана
 *  (itemPlanFromEntry по группе каталога) покрывает весь список, а не ручной набор. */
const STAIR_MENU_FULL = [
  "ladder_march", "ladder_console", "ladder_2march", "ladder_2march-fan", "ladder_2march_console-fan",
  "ladder_2march_console", "ladder_trapeze", "rounded_staircase", "ladder_march_double", "ladder_fan_2march",
  "ladder_3march", "ladder_3march_fan", "spiral_staircase", "upper_march", "ladder_circle", "porch",
  "attic_staircase", "step_ladder", "escalator", "elevator", "floor_hatch", "stair_machine", "stair_spot",
] as const;

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
    id: d["id"], title: ref.menu_title, group: "stairs",
    width: d["width"], height: d["height"], self_height: d["self_height"],
    plan: d["plan"], anchor: d["anchor"], is_magnetized: d["is_magnetized"],
    can_be_outside: d["can_be_outside"],
  });
}

test("stairs: план a:1 — все реальные пункты меню «Лестницы» (21 из группы stairs + 2 вне группы), правило по группе каталога", () => {
  assert.equal(STAIR_MENU_FULL.length, 23);
  assert.deepEqual([...STAIR_MENU_EXTRA].sort(), ["stair_machine", "stair_spot"]);
  let n = 0;
  for (const name of STAIR_MENU_FULL) {
    // план {furniture:6} у 17 пунктов меню (в т.ч. ladder_2march_console-fan, ladder_fan_2march,
    // ladder_3march_fan, floor_hatch — этап 55, ревью №2) и {init:1}/{light:10} у прочих
    const entry = toToolEntry(name, { id: 1, title: name, group: name === "stair_machine" ? "furniture" : name === "stair_spot" ? "lights" : "stairs", width: 100, height: 100, self_height: 0, plan: { furniture: 6 } });
    assert.deepEqual(itemPlanFromEntry(entry), { furniture: 6, a: 1 }, name);
    n++;
  }
  assert.equal(n, 23);
  // правило выводится из группы каталога: произвольное имя группы stairs тоже получает a:1
  assert.deepEqual(itemPlanFromEntry(toToolEntry("stair_future", { id: 2, title: "x", group: "stairs", width: 10, height: 10, self_height: 0, plan: { furniture: 6 } })), { furniture: 6, a: 1 });
  // escalator/elevator: каталог {init:1} → модель {a:1} (домашний лист — исходный план)
  assert.deepEqual(itemPlanFromEntry(toToolEntry("escalator", { id: 348, title: "Эскалатор", group: "stairs", width: 134, height: 520, self_height: 0, plan: { init: 1 } })), { a: 1 });
  assert.deepEqual(itemPlanFromEntry(toToolEntry("elevator", { id: 351, title: "Лифт", group: "stairs", width: 178, height: 158, self_height: 0, plan: { init: 1 } })), { a: 1 });
  // stair_spot: каталог {light:10} → {light:10, a:1} (эталон ui-ref-stair-stair_spot)
  assert.deepEqual(itemPlanFromEntry(toToolEntry("stair_spot", { id: 1543, title: "Светильник для подсветки пола", group: "lights", width: 12, height: 14, self_height: 6, plan: { light: 10 } })), { light: 10, a: 1 });
});

test("stairs: план из каталога — ключ init отображается в a; мебель вне меню не затронута", () => {
  // upper_march: каталог {init:1} → модель {a:1} (эталон ui-ref-stair-upper_march)
  assert.deepEqual(itemPlanFromEntry(toToolEntry("upper_march", { id: 357, title: "Спуск лестницы", group: "stairs", width: 180, height: 80, self_height: 0, plan: { init: 1 } })), { a: 1 });
  // ladder_march: каталог {furniture:6} → {furniture:6, a:1} (эталон ui-ref-stair-ladder_march)
  assert.deepEqual(itemPlanFromEntry(toToolEntry("ladder_march", { id: 146, title: "Прямая маршевая лестница", group: "stairs", width: 260, height: 80, self_height: 0, plan: { furniture: 6 } })), { furniture: 6, a: 1 });
  // мебель вне меню не получает a:1 (эталон ui-ref-sofa: {furniture:6})
  assert.deepEqual(itemPlanFromEntry(toToolEntry("sofa_double", { id: 92, title: "Диван", group: "furniture", width: 140, height: 80, self_height: 85, plan: { furniture: 6 } })), { furniture: 6 });
});

/** Семантическая проекция предмета (этап 55, ревью №3): значимые поля в нормализованном
 *  виде — углы modulo 360, over_floor в форме редактора {value, display}, display размеров. */
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
  test(`stairs: эталон ${key} — item_add воспроизводит семантическую проекцию эталона (обе стороны)`, () => {
    const ref = loadRef(key);
    const model = roomModel();
    const entry = entryOf(ref);
    const src = ref.model_object;
    // у porch/stair_spot (anchor:wall) свободной постановки в редакторе нет — ставим
    // against_wall; угол тогда задаёт стена фикстуры, а не клик эталона, поэтому угол
    // у этих двух сверяется отдельно (ниже), а не с эталонным 180
    const props = addItem(model, {
      name: entry.name,
      position: WALL_ONLY.has(key)
        ? { againstWall: { wallId: southWallId(model), offsetMm: 1000 } }
        : { center: { x: 20000, y: 15000 } },
      angleDeg: src["angle"] as number,
      catalogEntry: entry,
      ...(key === "stair_spot" ? { elevationMm: 200 } : {}),
    });
    assert.equal(props.name, src["name"]);
    // размеры из каталога = эталонные
    assert.equal(props.width, src["width"]);
    assert.equal(props.height, src["height"]);
    assert.equal(props.self_height, src["self_height"]);
    // semantic projection в обе стороны: item_add → эталон и эталон → item_add
    const got = itemProjection(props as unknown as Record<string, unknown>);
    const want = itemProjection(src);
    if (WALL_ONLY.has(key)) {
      const { angle: _a, ...rest } = want;
      assert.deepEqual({ ...got, angle: null }, { ...rest, angle: null }, "проекция item_add = проекция эталона (кроме угла у anchor:wall — угол задаёт стена фикстуры)");
    } else {
      assert.deepEqual(got, want, "проекция item_add = проекция эталона");
      assert.equal(props.angle, src["angle"]);
    }
    // reverse: эталон, вставленный в модель как есть, даёт ту же проекцию (поля не теряются)
    const copy = structuredClone(src) as unknown as Record<string, unknown>;
    copy["id"] = "_refitem";
    copy["id_room"] = Object.keys(model.rooms2 ?? {})[0] ?? null;
    model.items!["_refitem"] = copy as unknown as ItemProps;
    assert.deepEqual(itemProjection(itemsList(model).find((i) => i.id === "_refitem") as unknown as Record<string, unknown>), want, "проекция эталона в модели = проекция эталона");
    delete model.items["_refitem"];
    // служебные поля, которые пишет item_add (эталон редактора: dls/dls_prs/icon_center/
    // center3d/f0offset/id_room_zone/item_id — кеш UI, редактор пересчитывает при draw)
    assert.deepEqual(props.comment, { id: "" });
    assert.ok(props.id_room, "id_room проставлен по комнате");
    // модель валидна и предмет виден в compact/model_get-слое
    const errors = validateModel(model).filter((e) => e.code.startsWith("ITEM"));
    assert.deepEqual(errors, []);
    const compact = compactModel(model);
    assert.ok(compact.items.some((i: Record<string, unknown>) => i.name === entry.name));
  });
}

test("stairs: эталон в модели → compact/itemsList без потерь значимых полей; удаление", () => {
  const ref = loadRef("spiral_staircase");
  const model = roomModel();
  const src = structuredClone(ref.model_object) as unknown as ItemProps & Record<string, unknown>;
  src["id"] = "_tstair";
  src["id_room"] = Object.keys(model.rooms2 ?? {})[0] ?? null;
  model.items![src["id"] as string] = src as unknown as ItemProps;
  const compact = compactModel(model);
  assert.ok(compact.items.some((i) => i.name === "spiral_staircase"), "лестница в compact");
  const list = itemsList(model);
  const it = list.find((i) => i.name === "spiral_staircase")!;
  assert.equal(it.width, 250);
  assert.equal(it.height, 500);
  assert.deepEqual(it.plan, { furniture: 6, a: 1 });
  // стена-привязка эталона обезличена в "0": реального id в модели нет — редактор
  // пересчитывает wall_line при draw; отсутствие id_wall не ошибка валидации
  deleteItem(model, "_tstair");
  assert.equal(itemsList(model).length, 0);
});

test("stairs: update-цепочка — неуказанные поля не меняются; высота от пола", () => {
  const model = roomModel();
  const entry = entryOf(loadRef("ladder_march"));
  const props = addItem(model, { name: entry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry });
  const before = structuredClone(props);
  updateItem(model, { itemId: props.id, widthMm: 3000 });
  assert.equal(props.width, 300);
  assert.equal(props.height, before.height);
  assert.equal(props.angle, before.angle);
  assert.deepEqual(props.plan, before.plan);
  updateItem(model, { itemId: props.id, angleDeg: 15 });
  assert.equal(props.angle, 15);
  assert.equal(props.width, 300);
  updateItem(model, { itemId: props.id, elevationMm: 200 });
  // форма редактора {value, display} (этап 55, ревью №3)
  assert.deepEqual(props.over_floor, { value: 20, display: true });
  assert.equal(props.width, 300);
  assert.equal(props.angle, 15);
});

test("stairs: anchor:wall (porch, stair_spot) — свободная установка INVALID_ARGUMENT, против стены ставится (этап 55, ревью №4)", () => {
  for (const key of ["porch", "stair_spot"] as const) {
    const model = roomModel();
    const entry = entryOf(loadRef(key));
    const snapshot = JSON.stringify(model);
    // center и in_room — как в редакторе: клик вдали от стены предмет не создаёт
    assert.throws(
      () => addItem(model, { name: entry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry }),
      (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
    );
    assert.equal(JSON.stringify(model), snapshot, "модель не изменилась");
    assert.throws(
      () => addItem(model, { name: entry.name, position: { inRoom: { corner: "center" } }, catalogEntry: entry }),
      (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
    );
    assert.equal(JSON.stringify(model), snapshot);
    // против стены — работает, предмет привязан к стене
    const wallId = southWallId(model);
    const props = addItem(model, { name: entry.name, position: { againstWall: { wallId, offsetMm: 1000 } }, catalogEntry: entry });
    assert.equal(props.id_wall, wallId);
  }
});

test("stairs: атомарность — OUTSIDE_ROOM не меняет модель (снимок до вызова)", () => {
  const model = roomModel();
  const entry = entryOf(loadRef("ladder_march"));
  const snapshot = JSON.stringify(model);
  assert.throws(() => addItem(model, { name: entry.name, position: { center: { x: 99999, y: 99999 } }, catalogEntry: entry }), McpError);
  assert.equal(JSON.stringify(model), snapshot);
  // несуществующий name без записи каталога: дефолты, но всё равно позиция проверяется первой? —
  // позиция проверяется до записи в items
  assert.throws(() => addItem(model, { name: "ladder_march", position: { center: { x: 0, y: 0 } } }), McpError);
  assert.equal(JSON.stringify(model), snapshot);
});

test("stairs: регрессия стен/колонн/ригелей — операции не трогают лестницы и наоборот", () => {
  const model = roomModel();
  const entry = entryOf(loadRef("ladder_march"));
  const stair = addItem(model, { name: entry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry });
  const stairSnapshot = JSON.stringify(model.items[stair.id!]);
  // новая стена и колонна не меняют лестницу
  addWall(model, { start: { x: 10000, y: 10000 }, end: { x: 10000, y: 20000 }, thicknessMm: 100 });
  addPillar(model, { center: { x: 30000, y: 20000 }, widthMm: 400, heightMm: 400 });
  addRigel(model, { start: { x: 30000, y: 25000 }, end: { x: 35000, y: 25000 } });
  assert.equal(JSON.stringify(model.items[stair.id!]), stairSnapshot);
  // удаление лестницы не трогает стены/колонны/ригели
  const snapshot = JSON.stringify({ ...model, items: {} });
  deleteItem(model, stair.id!);
  assert.equal(JSON.stringify({ ...model, items: {} }), snapshot);
});

// ---------- workspace/save (mock) ----------

type Server = { saveId: string; model: Model };

function mockDeps(server: Server, opts: { droppedItems?: boolean; lostAfterSave?: boolean; changedAfterSave?: boolean } = {}) {
  let lastNormalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "123", planId: "1",
    async normalize(model) {
      lastNormalized = structuredClone(model) as Record<string, unknown>;
      const items = (model as { items: Record<string, unknown> }).items;
      const kept = opts.droppedItems ? {} : items;
      const out = structuredClone(model) as Record<string, unknown>;
      (out as { items: Record<string, unknown> }).items = structuredClone(kept);
      return {
        model: out,
        rooms: [],
        before: { walls: 0, holes: 0, items: Object.keys(items).length },
        after: { walls: 0, holes: 0, items: Object.keys(kept).length },
      };
    },
    async save() {
      server.saveId = `s${Math.random()}`;
      const saved = structuredClone(lastNormalized ?? fixtureModel()) as unknown as Model;
      // этап 55, ревью №1: сценарии потери ПОСЛЕ save — то, что ушло на save, и то,
      // что реально оказалось на сервере (по GET), расходятся
      if (opts.lostAfterSave) (saved as { items: Record<string, unknown> }).items = {};
      if (opts.changedAfterSave) {
        const first = Object.values((saved as { items: Record<string, unknown> }).items)[0] as Record<string, unknown> | undefined;
        if (first) {
          first["name"] = "sofa_double";
          first["pc"] = { x: (first["pc"] as { x: number }).x + 50, y: (first["pc"] as { y: number }).y + 50 };
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

test("stairs: mock save — лестница сохраняется и видна после reopen", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel() };
  const { deps } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const entry = entryOf(loadRef("ladder_march"));
  ws.apply("item_add", (m) => {
    addItem(m, { name: entry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry });
    return true;
  });
  const saved = await ws.save();
  assert.equal(saved.verified, true);
  // модель сервера содержит лестницу с планом {furniture:6, a:1}
  const items = Object.values(server.model.items ?? {}) as ItemProps[];
  const stair = items.find((i) => i.name === entry.name)!;
  assert.ok(stair, "лестница дошла до серверной модели");
  assert.deepEqual(stair.plan, { furniture: 6, a: 1 });
});

test("stairs: mock save — потеря лестницы при нормализации → NORMALIZATION_DROPPED, модель не пишется", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel() };
  const { deps } = mockDeps(server, { droppedItems: true });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const entry = entryOf(loadRef("ladder_2march"));
  ws.apply("item_add", (m) => {
    addItem(m, { name: entry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry });
    return true;
  });
  await assert.rejects(
    () => ws.save(),
    (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED",
  );
  // серверная модель не изменилась (лестницы нет)
  assert.equal(Object.values(server.model.items ?? {}).length, 0);
});

test("stairs: лестница светильника (группа lights) проходит ту же потерю-при-нормализации проверку", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel() };
  const { deps } = mockDeps(server, { droppedItems: true });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const entry = entryOf(loadRef("stair_spot"));
  ws.apply("item_add", (m) => {
    addItem(m, {
      name: entry.name,
      position: { againstWall: { wallId: southWallId(m), offsetMm: 1000 } },
      catalogEntry: entry, elevationMm: 200,
    });
    return true;
  });
  await assert.rejects(() => ws.save(), (e: unknown) => (e as McpError).code === "NORMALIZATION_DROPPED");
});

// ---------- этап 55, ревью №1: сверка предметов после save по GET ----------

test("stairs: mock save — предмет исчез на сервере после save → SITE_ERROR с item_mismatches (verified нет)", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel() };
  const { deps } = mockDeps(server, { lostAfterSave: true });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const entry = entryOf(loadRef("ladder_march"));
  ws.apply("item_add", (m) => {
    addItem(m, { name: entry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry });
    return true;
  });
  await assert.rejects(
    () => ws.save(),
    (e: unknown) => {
      assert.ok(e instanceof McpError && e.code === "SITE_ERROR", e instanceof McpError ? e.code : String(e));
      const details = (e as McpError).details as { item_mismatches?: string[] };
      assert.equal(details.item_mismatches?.length, 1);
      assert.match(details.item_mismatches![0]!, /исчез после сохранения/);
      return true;
    },
  );
});

test("stairs: mock save — id предмета сохранился, тип/позиция изменились на сервере → SITE_ERROR", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel() };
  const { deps } = mockDeps(server, { changedAfterSave: true });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const entry = entryOf(loadRef("ladder_march"));
  ws.apply("item_add", (m) => {
    addItem(m, { name: entry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry });
    return true;
  });
  await assert.rejects(
    () => ws.save(),
    (e: unknown) => {
      assert.ok(e instanceof McpError && e.code === "SITE_ERROR", e instanceof McpError ? e.code : String(e));
      const details = (e as McpError).details as { item_mismatches?: string[] };
      const mism = details.item_mismatches ?? [];
      assert.ok(mism.some((s) => s.includes("тип изменился")), mism.join("; "));
      assert.ok(mism.some((s) => s.includes("центр сместился")), mism.join("; "));
      return true;
    },
  );
});

test("stairs: mock save — штатный save с мебелью и лестницей проходит, verified=true (сверка предметов без ложных блокировок)", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel() };
  const { deps } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const stairEntry = entryOf(loadRef("ladder_march"));
  const sofaEntry = toToolEntry("sofa_double", { id: 92, title: "Диван", group: "furniture", width: 140, height: 80, self_height: 85, plan: { furniture: 6 } });
  ws.apply("item_add", (m) => {
    addItem(m, { name: stairEntry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: stairEntry });
    addItem(m, { name: sofaEntry.name, position: { center: { x: 15000, y: 15000 } }, catalogEntry: sofaEntry });
    return true;
  });
  const saved = await ws.save();
  assert.equal(saved.verified, true);
  assert.equal(Object.values(server.model.items ?? {}).length, 2);
});
