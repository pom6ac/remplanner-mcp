// Этап 425 (бэклог 418 §3 п.E «Стояки и ввод воды — живая проверка», офлайн-часть):
// тест-контракт на каждый ключ water, water_column_hot, water_column_cold,
// drainage_column, ceiling_water — привязка к стене (item_add against_wall):
// id_wall, id_room, план {a:1}, размеры/высота из каталога, dimensions.display —
// по эталонам UI tests/fixtures/ui-ref-comm-*.json (пробы 57-comm-ui3, клики в
// dev-проекте, model project.copy("server")). Эталоны стояков сняты со свободных
// кликов с магнитом (anchor:free, is_magnetized) — свободная постановка у них
// есть, пристенная сверяется здесь; ceiling_water (anchor:wall) — только у стены.
// Инварианты сериализации редактора, которые живая проба 425 сверяет на
// dev-объекте, закреплены на самих эталонах (projection = pc − depth/2 к стене,
// wall_line — отрезок длиной width через projection); item_add их не пишет —
// кеш UI (projection/wall_line/dls/icon_center/center3d/id_wall_old/
// wall_direction/id_room_zone/f0offset) редактор пересчитывает при draw
// (этап 57, ревью 60 №4: mock-уровень покрывает семантику, round-trip — проба).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps, Wall } from "../../src/model/types.ts";
import { addItem, itemPlanFromEntry, itemsList } from "../../src/model/items.ts";
import { validateModel } from "../../src/model/validate.ts";
import { compactModel } from "../../src/model/compact.ts";
import { toToolEntry } from "../../src/catalog.ts";
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
  return JSON.parse(readFileSync(join(ROOT, `tests/fixtures/ui-ref-comm-${name}.json`), "utf8")) as Ref;
}

const KEYS = ["water", "water_column_hot", "water_column_cold", "drainage_column", "ceiling_water"] as const;

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

function roomModel(): Model {
  const env = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/anon-rect-4000x3000.json"), "utf8")) as { model: Model };
  return structuredClone(env.model);
}

/** Нижняя стена фикстуры: предмет у неё попадает внутрь полигона комнаты (rooms2). */
function southWallId(model: Model): string {
  return Object.entries(model.walls).reduce((a, b) => ((b[1].p1.y + b[1].p2.y) > (a[1].p1.y + a[1].p2.y) ? b : a))[0];
}

/** Восточная (правая) стена фикстуры: вертикальная, угол оси 90 — как у эталонов
 *  water_column_cold/drainage_column (стояк у вертикальной стены, angle 90).
 *  (Западная стена фикстуры не годится: её ось x=0 лежит вне полигона комнаты —
 *  полигон synthetic 100..2900, постановка даёт pc вне помещений.) */
function eastWallId(model: Model): string {
  return Object.entries(model.walls).reduce((a, b) => ((b[1].p1.x + b[1].p2.x) > (a[1].p1.x + a[1].p2.x) ? b : a))[0];
}

/** Расстояние от точки до оси стены (см). */
function distToWallAxis(wall: Wall, pc: { x: number; y: number }): number {
  const dx = wall.p2.x - wall.p1.x;
  const dy = wall.p2.y - wall.p1.y;
  const len = Math.hypot(dx, dy);
  return Math.abs(dy * (pc.x - wall.p1.x) - dx * (pc.y - wall.p1.y)) / len;
}

/**
 * Контракт привязки к стене для одного ключа (общий для южной/восточной стены):
 * id_wall = стена, id_room проставлен, план {a:1} (каталог init→a), размеры из
 * каталога = эталонные, self_height 0, over_floor нет (в эталонах поля нет),
 * dimensions.display — как в эталоне (у четырёх стояков false, у ceiling_water
 * true), pc на depth/2 от внутренней грани стены (= depth/2 + depth_стены/2 от
 * оси) — та же формула, что у редактора при магнитe (эталон: pc − projection).
 */
function assertAgainstWallContract(model: Model, props: ItemProps, ref: Ref, wall: Wall, wallId: string): void {
  const src = ref.model_object;
  assert.equal(props.name, src["name"]);
  assert.equal(props.id_wall, wallId, "id_wall = стена постановки (привязка к стене)");
  assert.equal(props.id_room != null && props.id_room !== "", true, "id_room проставлен по комнате");
  assert.deepEqual(props.plan, { a: 1 }, "план {a:1} (каталог init→a)");
  assert.equal(props.width, src["width"], "ширина из каталога = эталон");
  assert.equal(props.height, src["height"], "глубина из каталога = эталон");
  assert.equal(props.self_height, src["self_height"], "self_height = эталон");
  assert.equal(props.over_floor ?? null, null, "over_floor нет (в эталоне поля нет)");
  assert.equal((props.dimensions as { display?: boolean }).display, (src["dimensions"] as { display?: boolean }).display, "dimensions.display = эталон");
  // pc на depth/2 от внутренней грани: расстояние до оси = depth_стены/2 + depth/2
  const depthCm = Number(src["height"]);
  const got = distToWallAxis(wall, props.pc);
  const want = wall.depth / 2 + depthCm / 2;
  assert.ok(Math.abs(got - want) <= 0.02, `pc на ${want} см от оси стены (got ${got}) — вплотную к грани, как в эталоне (pc − projection = depth/2)`);
}

for (const key of KEYS) {
  test(`425 ${key}: item_add against_wall — привязка к стене по эталону ui-ref-comm-${key}`, () => {
    const ref = loadRef(key);
    const model = roomModel();
    const entry = entryOf(ref);
    const src = ref.model_object;
    const wallId = southWallId(model);
    const props = addItem(model, {
      name: entry.name,
      position: { againstWall: { wallId, offsetMm: 1000 } },
      catalogEntry: entry,
    });
    assertAgainstWallContract(model, props, ref, model.walls[wallId]!, wallId);
    // модель валидна, предмет виден в compact-слое
    assert.deepEqual(validateModel(model).filter((e) => e.code.startsWith("ITEM")), []);
    assert.ok(compactModel(model).items.some((i: Record<string, unknown>) => i.name === entry.name));
    // обратная сторона: эталон, вставленный в модель как есть, несёт те же
    // семантические поля привязки (поля не теряются при чтении модели)
    const copy = structuredClone(src) as unknown as Record<string, unknown>;
    copy["id"] = "_refitem";
    copy["id_room"] = Object.keys(model.rooms2 ?? {})[0] ?? null;
    model.items!["_refitem"] = copy as unknown as ItemProps;
    const list = itemsList(model).find((i) => i.id === "_refitem") as unknown as Record<string, unknown> | undefined;
    assert.ok(list, "эталонный предмет виден в compact-слое");
    assert.equal(list!["name"], src["name"]);
    assert.equal(list!["width"], src["width"]);
    assert.equal(list!["height"], src["height"]);
    assert.deepEqual(list!["plan"], src["plan"]);
    delete model.items["_refitem"];
  });
}

test("425 water_column_cold: у восточной стены угол оси 90 — как в эталоне (вертикальная стена)", () => {
  const ref = loadRef("water_column_cold");
  const model = roomModel();
  const entry = entryOf(ref);
  const wallId = eastWallId(model);
  const props = addItem(model, {
    name: entry.name,
    position: { againstWall: { wallId, offsetMm: 1000 } },
    catalogEntry: entry,
  });
  assertAgainstWallContract(model, props, ref, model.walls[wallId]!, wallId);
  assert.equal(props.angle, 90, "угол = угол оси стены (эталон water_column_cold: angle 90)");
});

test("425 drainage_column: у восточной стены угол оси 90 — как в эталоне (вертикальная стена)", () => {
  const ref = loadRef("drainage_column");
  const model = roomModel();
  const entry = entryOf(ref);
  const wallId = eastWallId(model);
  const props = addItem(model, {
    name: entry.name,
    position: { againstWall: { wallId, offsetMm: 1000 } },
    catalogEntry: entry,
  });
  assertAgainstWallContract(model, props, ref, model.walls[wallId]!, wallId);
  assert.equal(props.angle, 90, "угол = угол оси стены (эталон drainage_column: angle 90)");
});

test("425 ceiling_water: свободная установка отвергается (anchor:wall), у стены ставится", () => {
  const ref = loadRef("ceiling_water");
  const model = roomModel();
  const entry = entryOf(ref);
  const snapshot = JSON.stringify(model);
  assert.throws(
    () => addItem(model, { name: entry.name, position: { center: { x: 20000, y: 15000 } }, catalogEntry: entry }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  assert.equal(JSON.stringify(model), snapshot, "модель не изменилась");
});

/** Инварианты сериализации редактора на самих эталонах — то, что живая проба 425
 *  сверяет на dev-объекте после save/reopen (projection = pc − depth/2 к стене,
 *  wall_line — отрезок длиной width через projection). Инвариант закрепляется
 *  только на полноценно примагниченных эталонах (есть wall_line): эталон
 *  water_column_hot снят в промежуточном состоянии магнита (wall_line нет,
 *  projection ≠ pc − depth/2) — для него сверяются план/каталог, а derived-поля
 *  в живой пробе проверяются мягко (лог, без FAIL). */
for (const key of KEYS) {
  test(`425 ${key}: эталон — инварианты сериализации редактора (projection/wall_line)`, () => {
    const ref = loadRef(key);
    const src = ref.model_object;
    const wallLine = src["wall_line"] as { p1: { x: number; y: number }; p2: { x: number; y: number } } | undefined;
    if (wallLine) {
      const pc = src["pc"] as { x: number; y: number };
      const depthCm = Number(src["height"]);
      const projection = src["projection"] as { x: number; y: number };
      const d = Math.hypot(pc.x - projection.x, pc.y - projection.y);
      assert.ok(Math.abs(d - depthCm / 2) <= 0.01, `|pc − projection| = depth/2 (${depthCm / 2}), got ${d}`);
      const len = Math.hypot(wallLine.p2.x - wallLine.p1.x, wallLine.p2.y - wallLine.p1.y);
      assert.ok(Math.abs(len - Number(src["width"])) <= 0.01, `wall_line длиной width (${String(src["width"])}), got ${len}`);
      const mid = { x: (wallLine.p1.x + wallLine.p2.x) / 2, y: (wallLine.p1.y + wallLine.p2.y) / 2 };
      assert.ok(Math.abs(mid.x - projection.x) <= 0.01 && Math.abs(mid.y - projection.y) <= 0.01, "середина wall_line = projection");
    } else {
      assert.equal(key, "water_column_hot", "эталон без wall_line — только water_column_hot (промежуточный магнит)");
    }
    // план в эталоне {a:1} — как пишет item_add (каталог init→a)
    assert.deepEqual(ref.catalog_defaults_cm["plan"], { init: 1 }, "каталог plan {init:1} → модель {a:1}");
    assert.deepEqual(itemPlanFromEntry(entryOf(ref)), { a: 1 });
  });
}
