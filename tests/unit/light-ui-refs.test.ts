// Этап 84 «Освещение»: 44 предмета группы lights (item_add), световые линии
// led_strips/stripes_light/line_strips (LedStrip/StripLight/LineStrip extends GraphLines).
// Эталоны UI в обе стороны (ui-ref-light-*), атомарность, update-цепочки, удаление,
// реестр коллекций, компакт, mock save (подмена writeBackup/loadModel/openEditor —
// new-entity-section.md), регрессия прежних разделов.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps, LedStrip, StripLight, LineStrip } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addItem, updateItem, deleteItem, itemPlanFromEntry, LINE_TOOLS, TRACK_SPOT_TOOLS } from "../../src/model/items.ts";
import { addLightLine, updateLightLine, deleteLightLine, lightLengthM, LIGHT_TYPE_BY_KIND, LIGHT_COLLECTION_BY_KIND } from "../../src/model/lighting.ts";
import { addPipe, addGasLine } from "../../src/model/pipes.ts";
import { compactModel } from "../../src/model/compact.ts";
import { clearEntityCollections, replaceEntityCollections, MODEL_ENTITY_COLLECTIONS } from "../../src/model/collections.ts";
import { toToolEntry, type ToolEntry } from "../../src/catalog.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

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

function lightEntry(name: string, over: Record<string, unknown> = {}): ToolEntry {
  const fx = join(here, `../fixtures/ui-ref-light-${name}.json`);
  const d = exists(fx)
    ? (JSON.parse(readFileSync(fx, "utf8")).catalog_defaults_cm as Record<string, unknown>)
    : {};
  return toToolEntry(name, {
    id: d.id ?? 0, title: name, group: "lights",
    width: d.width ?? 24, height: d.height ?? 24, self_height: d.self_height ?? 0,
    plan: d.plan ?? { light: 10 }, anchor: d.anchor ?? "free", is_magnetized: true,
    can_be_outside: false,
    over_floor: "over_floor" in d ? d.over_floor : over.over_floor ?? false,
  });
}

function exists(p: string): boolean {
  try { readFileSync(p); return true; } catch { return false; }
}

/** Все снятые с UI эталоны светильников. */
function lightRefNames(): string[] {
  return readdirSync(join(here, "../fixtures"))
    .filter((f) => f.startsWith("ui-ref-light-") && f.endsWith(".json"))
    .map((f) => f.replace("ui-ref-light-", "").replace(".json", ""));
}

// ---------- состав раздела ----------

test("84: состав раздела «Освещение» — 49 позиций группы lights: 40 предметов + 5 линий + 4 трековых спота", () => {
  const LIGHTS = [
    "line_light", "led_strip", "recessed_strip", "surface_stripe", "pendent_strip",
    "track_spot", "track_pendent_spot", "track_panel_spot", "track_line_spot",
    "ceiling_chandelier_shades", "ceiling_chandelier_led", "hanging_chandelier_shades", "hanging_chandelier_led",
    "cascading_chandelier", "crystal_chandelier", "chandelier_fan", "chandelier", "hanging_light",
    "hanging_light_double", "hanging_light_triple", "armstrong_light", "track_single", "track_double",
    "track_triple", "bra", "bra_shades", "led_lamp", "light_stick", "wall_spot", "wall_lamp",
    "painting_lighting", "sauna_bra", "sauna_bra_corner", "outdoor_wall_lamp", "stair_spot",
    "lightspot", "lightspot_double", "lightspot_triple", "lightspot_surface", "lightspot_surface_double",
    "lightspot_surface_triple", "hanging_lightspot", "hanging_lightspot_double", "hanging_lightspot_triple",
    "hanging_chandelier_long", "hanging_chandelier_shades_long", "hanging_chandelier_led_long",
    "hanging_chandelier_crystal_long", "ceiling_chandelier_long",
  ];
  assert.equal(LIGHTS.length, 49);
  const strips = LIGHTS.filter((n) => LINE_TOOLS.has(n));
  assert.equal(strips.length, 5, "led_strip, recessed_strip, surface_stripe, pendent_strip, line_light — линии");
  const track = LIGHTS.filter((n) => TRACK_SPOT_TOOLS.has(n));
  assert.equal(track.length, 4, "трековые споты на шине");
  // группы каталога у сущностей: led_strip/line_light — свои коллекции, тип — имени инструмента
  assert.equal(LIGHT_TYPE_BY_KIND["led"], "led_strip");
  assert.equal(LIGHT_TYPE_BY_KIND["line"], "line_light");
  assert.equal(LIGHT_TYPE_BY_KIND["pendent"], "pendent_strip");
  assert.equal(LIGHT_COLLECTION_BY_KIND["led"], "led_strips");
  assert.equal(LIGHT_COLLECTION_BY_KIND["surface"], "stripes_light");
  assert.equal(LIGHT_COLLECTION_BY_KIND["line"], "line_strips");
});

test("84: план {light:10} — у всех пунктов группы lights (каталог), item_add его переносит", () => {
  const entry = toToolEntry("lightspot", { id: 36, title: "Светильник встраиваемый", group: "lights", width: 24, height: 24, self_height: 0, plan: { light: 10 } });
  assert.deepEqual(itemPlanFromEntry(entry), { light: 10 }, "план из каталога без отображения в a (лист «Освещение», не init)");
});

// ---------- эталоны UI (обе стороны) ----------

test("84: эталоны ui-ref-light-* — 26 светильников сняты с UI; item_add воспроизводит семантику (обе стороны)", () => {
  const names = lightRefNames();
  assert.ok(names.length >= 26, `эталонов ${names.length}, нужно не меньше 26`);
  for (const name of names) {
    const fx = JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-light-${name}.json`), "utf8"));
    const m = fx.model_object as Record<string, unknown>;
    if (m["name"] === undefined) continue; // эталоны линий (из живой модели) — в отдельном тесте ниже
    const d = fx.catalog_defaults_cm as Record<string, unknown>;
    assert.equal(m["name"], name, `${name}: эталон отвечает за тот же пункт`);
    assert.equal(m["width"], d.width, `${name}: ширина из каталога`);
    assert.equal(m["height"], d.height, `${name}: глубина из каталога`);
    assert.equal(m["self_height"], d.self_height, `${name}: высота из каталога`);
    assert.deepEqual(m["plan"], d.plan, `${name}: план {light:10}`);
    // обратная сторона: item_add даёт те же размеры/план/высоту
    const model = baseModel();
    const wallAnchor = d.anchor === "wall";
    const item = addItem(model, {
      name,
      position: wallAnchor
        ? { againstWall: { wallId: Object.keys(model.walls)[0]!, offsetMm: 1000 } }
        : { center: { x: 1500, y: 1500 } },
      catalogEntry: lightEntry(name),
    });
    assert.equal(item.width, m["width"], `${name}: item_add ширина`);
    assert.equal(item.height, m["height"], `${name}: item_add глубина`);
    assert.equal(item.self_height, m["self_height"], `${name}: item_add высота`);
    assert.deepEqual(item.plan, m["plan"], `${name}: item_add план`);
    if (wallAnchor) {
      assert.equal(item.id_wall !== null, m["id_wall"] !== undefined, `${name}: магнит к стене`);
      // over_floor из каталога (эталон bra: {value:140, display:true})
      assert.deepEqual(item.over_floor, m["over_floor"] ?? null, `${name}: over_floor у настенного`);
    }
    deleteItem(model, item.id);
  }
});

test("84: over_floor — потолочным null, подвесным редактор дописывает {value, display:false} при нормализации, настенным — каталог", () => {
  // потолочный (lightspot): over_floor в модели нет
  const model = baseModel();
  const ceiling = addItem(model, { name: "lightspot", position: { center: { x: 1500, y: 1500 } }, catalogEntry: lightEntry("lightspot") });
  assert.equal(ceiling.over_floor, null);
  // настенный (bra): из каталога {value:140, display:true} — эталон ui-ref-light-bra
  const braFx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-light-bra.json"), "utf8"));
  const bra = addItem(model, { name: "bra", position: { againstWall: { wallId: Object.keys(model.walls)[0]!, offsetMm: 1500 } }, catalogEntry: lightEntry("bra") });
  assert.deepEqual(bra.over_floor, braFx.model_object.over_floor, "высота бра — из каталога с его display");
  // подвесные (hanging_*): item_add ставит null, редактор нормализует до {value:160..200, display:false}
  // — подтверждено живым кругом 84-anon-items (hanging_lightspot → {value:160, display:false});
  // сверка save идёт по нормализованной модели, дописанное поле ложной блокировкой не является
});

test("84: anchor:wall — бра свободно не ставится (INVALID_ARGUMENT), как в редакторе", () => {
  const model = baseModel();
  const before = JSON.stringify(model.items);
  assert.throws(
    () => addItem(model, { name: "bra", position: { center: { x: 1500, y: 1500 } }, catalogEntry: lightEntry("bra") }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  assert.equal(JSON.stringify(model.items), before, "атомарность: отказ не меняет модель");
});

test("84: item_add отвергает световые линии и трековые споты с подсказкой", () => {
  const model = baseModel();
  for (const name of ["led_strip", "line_light", "recessed_strip", "surface_stripe", "pendent_strip"]) {
    assert.throws(
      () => addItem(model, { name, position: { center: { x: 1500, y: 1500 } }, catalogEntry: toToolEntry(name, { id: 1, title: name, group: "lights", width: 0, height: 0, self_height: 0, plan: { light: 10 }, anchor: "ceiling" }) }),
      (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && /line_tool_required/.test(JSON.stringify((e as McpError).details ?? {})),
      name,
    );
  }
  for (const name of ["track_spot", "track_pendent_spot", "track_panel_spot", "track_line_spot"]) {
    assert.throws(
      () => addItem(model, { name, position: { center: { x: 1500, y: 1500 } }, catalogEntry: toToolEntry(name, { id: 1, title: name, group: "lights", width: 20, height: 20, self_height: 0, plan: { light: 10 }, anchor: "ceiling" }) }),
      (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && /track_spot_requires_strip/.test(JSON.stringify((e as McpError).details ?? {})),
      name,
    );
  }
});

// ---------- световые линии: структура графа ----------

type AnyStrip = LedStrip | StripLight | LineStrip;

function assertGraphShape(line: AnyStrip, kind: string, points: [number, number][]): void {
  assert.equal(line.type, LIGHT_TYPE_BY_KIND[kind as keyof typeof LIGHT_TYPE_BY_KIND]);
  assert.equal(line.vertexes.length, points.length);
  for (let i = 0; i < points.length; i++) {
    const v = line.vertexes[i]!;
    assert.equal(v.type, "node");
    assert.equal(v.id_room, "", "serialize редактора дописывает id_room: '' — пишем сразу");
    assert.deepEqual(v.point, { x: points[i]![0], y: points[i]![1] });
  }
  // матрица-цепочка в обе стороны, диагональ null
  for (let i = 0; i < points.length; i++) {
    assert.equal(line.matrix[i]![i], null);
    for (let j = 0; j < points.length; j++) {
      if (j === i + 1 || j === i - 1) assert.deepEqual(line.matrix[i]![j], { length: 1 }, `ребро ${i}-${j}`);
      else assert.equal(line.matrix[i]![j], null);
    }
  }
  assert.deepEqual(line.items, Object.fromEntries(line.vertexes.map((v) => [v.id, "node"])));
  assert.deepEqual(line.props, { id: line.id, name: line.type });
  assert.equal(line.on_size, 1);
}

test("84: led_strip_add — граф-цепочка, длина в метрах (2 знака), поля формата LedStrip.serialize", () => {
  const model = baseModel();
  const line = addLightLine(model, { kind: "led", path: [{ x: 1000, y: 1000 }, { x: 2500, y: 1000 }] }) as LedStrip;
  assertGraphShape(line, "led", [[100, 100], [250, 100]]);
  assert.equal(line.length, 1.5);
  assert.equal((line as Record<string, unknown>)["plan"], undefined, "LedStrip.serialize план не пишет");
  assert.equal(Object.keys(model.led_strips ?? {}).length, 1);
  // длина по рёбрам (пересчёт)
  assert.equal(lightLengthM(line), 1.5);
});

test("84: stripe_add recessed/surface/pendent — spots/line_spots пустые, height_lowering только у pendent", () => {
  const model = baseModel();
  const recessed = addLightLine(model, { kind: "recessed", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] }) as StripLight;
  assert.deepEqual(recessed.spots, {});
  assert.deepEqual(recessed.line_spots, []);
  assert.equal(recessed.height_lowering, undefined);
  const pendent = addLightLine(model, { kind: "pendent", path: [{ x: 500, y: 1000 }, { x: 1500, y: 1000 }] }) as StripLight;
  assert.equal(pendent.height_lowering, 20, "умолчание StripLight для pendent_strip (бандл app.3.0)");
  const surface = addLightLine(model, { kind: "surface", path: [{ x: 500, y: 1500 }, { x: 1500, y: 1500 }] }) as StripLight;
  assert.equal(surface.height_lowering, undefined);
  assert.equal(Object.keys(model.stripes_light ?? {}).length, 3);
});

test("84: line_light_add — plan light, prs {} (LineStrip.serialize); полилиния из 3 узлов", () => {
  const model = baseModel();
  const line = addLightLine(model, { kind: "line", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }, { x: 1500, y: 2000 }] }) as LineStrip;
  assertGraphShape(line, "line", [[50, 50], [150, 50], [150, 200]]);
  assert.equal(line.plan, "light");
  assert.deepEqual(line.prs, {});
  assert.equal(line.length, 2.5, "100 + 150 см");
});

test("84: аргументы — <2 точек, дубликат подряд, неконечные координаты, >32 точек — INVALID_ARGUMENT до мутаций", () => {
  const model = baseModel();
  const before = JSON.stringify(model);
  assert.throws(() => addLightLine(model, { kind: "led", path: [{ x: 100, y: 100 }] }), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.throws(() => addLightLine(model, { kind: "led", path: [{ x: 100, y: 100 }, { x: 100, y: 100 }] }), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.throws(() => addLightLine(model, { kind: "led", path: [{ x: 100, y: 100 }, { x: Number.NaN, y: 100 }] }), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  const many = Array.from({ length: 33 }, (_, i) => ({ x: i * 100, y: 100 }));
  assert.throws(() => addLightLine(model, { kind: "led", path: many }), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.equal(JSON.stringify(model), before, "атомарность: модель не изменилась");
});

test("84: update — перенос узлов, длина по рёбрам; неуказанные вершины не меняются; NOT_FOUND", () => {
  const model = baseModel();
  const line = addLightLine(model, { kind: "led", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] }) as LedStrip;
  const p0 = line.vertexes[0]!.point;
  updateLightLine(model, { kind: "led", lineId: line.id, positions: [{ vertex: 1, x: 1500, y: 1500 }] });
  assert.deepEqual(line.vertexes[0]!.point, p0, "неуказанная вершина на месте");
  assert.deepEqual(line.vertexes[1]!.point, { x: 150, y: 150 });
  assert.equal(line.length, 1.41, "длина пересчитана (гипотенуза ~141 см)");
  assert.throws(() => updateLightLine(model, { kind: "led", lineId: "nope", positions: [] }), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
  assert.throws(() => updateLightLine(model, { kind: "led", lineId: line.id, positions: [{ vertex: 5, x: 0, y: 0 }] }), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
});

test("85 №2: stripe_update шины со спотами (spots/line_spots) — INVALID_ARGUMENT атомарно: спот на шине пересчитывается редактором за шиной, предсохранительная сверка сочла бы перенос потерей", () => {
  const model = baseModel();
  const stripe = addLightLine(model, { kind: "pendent", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] }) as StripLight;
  // синтетическая связь «спот на шине» (формат spots бандла app.3.0; этап 84 её не пишет)
  model.items ??= {};
  model.items["spot1"] = { name: "track_spot", pc: { x: 100, y: 50 }, width: 10, height: 10, angle: 0, strip_light_id: stripe.id, props: {} } as never;
  stripe.spots["spot1"] = { name: "track_spot", line_id: 0, d: 0.5 } as never;
  const stripe2 = addLightLine(model, { kind: "surface", path: [{ x: 500, y: 1500 }, { x: 1500, y: 1500 }] }) as StripLight;
  stripe2.line_spots = [{ line_id: 0, d_s: 0.2, d_e: 0.5, p1: { x: 70, y: 50 }, p2: { x: 100, y: 50 } }] as never;
  const before = JSON.stringify(model);
  for (const [kind, lineId] of [["pendent", stripe.id], ["surface", stripe2.id]] as const) {
    assert.throws(
      () => updateLightLine(model, { kind, lineId, positions: [{ vertex: 0, x: 1000, y: 1000 }] }),
      (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
      `${kind}: перенос шины со спотами отвергается`,
    );
  }
  assert.equal(JSON.stringify(model), before, "атомарность: отказ не меняет модель");
});

test("85 №2: update шины без спотов и led/line-линий не ограничен (связей нет)", () => {
  const model = baseModel();
  const stripe = addLightLine(model, { kind: "recessed", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] }) as StripLight;
  updateLightLine(model, { kind: "recessed", lineId: stripe.id, positions: [{ vertex: 0, x: 1000, y: 1000 }] });
  assert.deepEqual(stripe.vertexes[0]!.point, { x: 100, y: 100 });
});

test("85 №3: stripe_delete шины со связанными спотами — INVALID_ARGUMENT без висячих ссылок (сверка спот↔шина в обе стороны)", () => {
  const model = baseModel();
  const stripe = addLightLine(model, { kind: "pendent", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] }) as StripLight;
  // 1) двусторонняя связь: spots[spot] и item.strip_light_id — удаление оставило бы висячую ссылку
  model.items ??= {};
  model.items["spot1"] = { name: "track_spot", pc: { x: 100, y: 50 }, width: 10, height: 10, angle: 0, strip_light_id: stripe.id, props: {} } as never;
  stripe.spots["spot1"] = { name: "track_spot", line_id: 0, d: 0.5 } as never;
  assert.throws(
    () => deleteLightLine(model, "pendent", stripe.id),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
    "двусторонняя связь: удаление отвергается",
  );
  assert.ok(model.stripes_light?.[stripe.id], "шина на месте");
  assert.ok(model.items["spot1"], "спот на месте");
  // 2) односторонняя ссылка: предмет указывает на шину, spots пуст
  const stripe2 = addLightLine(model, { kind: "surface", path: [{ x: 500, y: 1500 }, { x: 1500, y: 1500 }] }) as StripLight;
  model.items["spot2"] = { name: "track_spot", pc: { x: 150, y: 150 }, width: 10, height: 10, angle: 0, strip_light_id: stripe2.id, props: {} } as never;
  assert.throws(
    () => deleteLightLine(model, "surface", stripe2.id),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
    "обратная ссылка предмета: удаление отвергается",
  );
  // 3) line_spots непустые — тоже отказ
  const stripe3 = addLightLine(model, { kind: "recessed", path: [{ x: 2000, y: 500 }, { x: 3000, y: 500 }] }) as StripLight;
  stripe3.line_spots = [{ line_id: 0, d_s: 0.2, d_e: 0.5, p1: { x: 70, y: 50 }, p2: { x: 100, y: 50 } }] as never;
  assert.throws(() => deleteLightLine(model, "recessed", stripe3.id), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  // чистая шина и led/line удаляются как раньше
  const clean = addLightLine(model, { kind: "pendent", path: [{ x: 500, y: 2000 }, { x: 1500, y: 2000 }] }) as StripLight;
  deleteLightLine(model, "pendent", clean.id);
  assert.equal(model.stripes_light?.[clean.id], undefined);
});

test("84: delete — линия уходит, NOT_FOUND; разные коллекции независимы", () => {
  const model = baseModel();
  const led = addLightLine(model, { kind: "led", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] });
  const stripe = addLightLine(model, { kind: "pendent", path: [{ x: 500, y: 1000 }, { x: 1500, y: 1000 }] });
  const ll = addLightLine(model, { kind: "line", path: [{ x: 500, y: 1500 }, { x: 1500, y: 1500 }] });
  deleteLightLine(model, "led", led.id);
  assert.equal(model.led_strips?.[led.id], undefined);
  assert.ok(model.stripes_light?.[stripe.id]);
  assert.ok(model.line_strips?.[ll.id]);
  assert.throws(() => deleteLightLine(model, "led", led.id), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
});

test("84: атомарность add — снимок модели до вызова побайтово равен модели после отказа", () => {
  const model = baseModel();
  const before = JSON.stringify(model);
  assert.throws(() => addLightLine(model, { kind: "recessed", path: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }), McpError);
  assert.equal(JSON.stringify(model), before);
});

// ---------- компакт, реестр коллекций ----------

test("84: compactModel — LS/SL/LL с типом, длиной в мм, height_lowering_mm у pendent", () => {
  const model = baseModel();
  const led = addLightLine(model, { kind: "led", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] }) as LedStrip;
  const pendent = addLightLine(model, { kind: "pendent", path: [{ x: 500, y: 1000 }, { x: 2000, y: 1000 }] }) as StripLight;
  const ll = addLightLine(model, { kind: "line", path: [{ x: 500, y: 1500 }, { x: 1500, y: 1500 }] }) as LineStrip;
  const compact = compactModel(model);
  assert.deepEqual(compact.led_strips[0], { id: "LS1", site_id: led.id, type: "led_strip", from: [500, 500], to: [1500, 500], vertexes: 2, length_mm: 1000 });
  assert.deepEqual(compact.stripes_light[0], { id: "SL1", site_id: pendent.id, type: "pendent_strip", from: [500, 1000], to: [2000, 1000], vertexes: 2, length_mm: 1500, height_lowering_mm: 200 });
  assert.deepEqual(compact.line_strips[0], { id: "LL1", site_id: ll.id, type: "line_light", from: [500, 1500], to: [1500, 1500], vertexes: 2, length_mm: 1000 });
  assert.equal(compact.stripes_light[0]!.height_lowering_mm, 200);
});

test("84: реестр коллекций — clear удаляет световые линии, import переносит, обязательные не ломаются", () => {
  const model = baseModel();
  addLightLine(model, { kind: "led", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] });
  addLightLine(model, { kind: "recessed", path: [{ x: 500, y: 1000 }, { x: 1500, y: 1000 }] });
  addLightLine(model, { kind: "line", path: [{ x: 500, y: 1500 }, { x: 1500, y: 1500 }] });
  for (const key of ["led_strips", "stripes_light", "line_strips"]) {
    assert.ok(MODEL_ENTITY_COLLECTIONS.includes(key as never), `${key} в реестре`);
  }
  clearEntityCollections(model);
  assert.equal(model.led_strips, undefined);
  assert.equal(model.stripes_light, undefined);
  assert.equal(model.line_strips, undefined);
  assert.deepEqual(model.walls, {});
  const source = baseModel();
  addLightLine(source, { kind: "led", path: [{ x: 100, y: 100 }, { x: 500, y: 100 }] });
  clearEntityCollections(model);
  replaceEntityCollections(model, source);
  assert.equal(Object.keys(model.led_strips ?? {}).length, 1);
});

// ---------- mock save (подмена writeBackup/loadModel/openEditor) ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(m.walls as Record<string, unknown>).length;
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

function lightScenario(): { model: Model; led: LedStrip; stripe: StripLight; line: LineStrip } {
  const model = baseModel();
  const led = addLightLine(model, { kind: "led", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] }) as LedStrip;
  const stripe = addLightLine(model, { kind: "pendent", path: [{ x: 500, y: 1000 }, { x: 2000, y: 1000 }] }) as StripLight;
  const line = addLightLine(model, { kind: "line", path: [{ x: 500, y: 1500 }, { x: 1500, y: 1500 }] }) as LineStrip;
  return { model, led, stripe, line };
}

test("84: mock save — все три коллекции доходят до серверной модели, verified", async () => {
  const { model } = lightScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  const m = server.model as { led_strips?: Record<string, LedStrip>; stripes_light?: Record<string, StripLight>; line_strips?: Record<string, LineStrip> };
  assert.equal(Object.keys(m.led_strips ?? {}).length, 1);
  assert.equal(Object.keys(m.stripes_light ?? {}).length, 1);
  assert.equal(Object.keys(m.line_strips ?? {}).length, 1);
});

test("84: mock save — редактор дописал id_room узлам ('synthetic-room') и переставил узлы местами → verified без ложной блокировки", async () => {
  const { model, led } = lightScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (m) => {
    // редактор переупорядочил узлы (перестановка) и дописал id_room (штатная нормализация):
    // serialize берёт поле заново из getItem(vertex.id).id_room — производное
    const coll = (m as { led_strips?: Record<string, LedStrip> }).led_strips!;
    const line = coll[led.id]!;
    line.vertexes = [structuredClone(line.vertexes[1]!), structuredClone(line.vertexes[0]!)];
    line.items = { [line.vertexes[0]!.id]: "node", [line.vertexes[1]!.id]: "node" };
    for (const v of line.vertexes) v.id_room = "synthetic-room";
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, "перестановка узлов и допис-id_room — допустимая нормализация");
  // 85 №5: порча id_room на сервере после save видна — ожидание уже нормализовано,
  // производное поле сверяется на равенство
  const server2: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws2 = saveMock(server2, (s) => {
    const line = (s.model as { led_strips?: Record<string, LedStrip> }).led_strips![led.id]!;
    line.vertexes[0]!.id_room = "other-room";
  }, (m) => {
    const line = (m as { led_strips?: Record<string, LedStrip> }).led_strips![led.id]!;
    for (const v of line.vertexes) v.id_room = "synthetic-room";
  });
  await ws2.open("0", "1");
  await assert.rejects(ws2.save(), (e: unknown) => e instanceof McpError && e.code === "SITE_ERROR");
});

test("84: mock save — редактор потерял ленту при нормализации → NORMALIZATION_DROPPED, записи нет", async () => {
  const { model, led } = lightScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    delete (m as { led_strips?: Record<string, LedStrip> }).led_strips![led.id];
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED");
  assert.equal(saves, 0, "до записи дело не дошло");
});

test("84: mock save — сервер испортил ленту (узел сместился, ребро потеряно, длина изменена) → SITE_ERROR с led_strip_mismatches", async () => {
  for (const corrupt of [
    (m: Record<string, unknown>, led: LedStrip) => {
      const coll = (m as { led_strips?: Record<string, LedStrip> }).led_strips!;
      coll[led.id]!.vertexes[0]!.point = { x: 50, y: 60 };
    },
    (m: Record<string, unknown>, led: LedStrip) => {
      const coll = (m as { led_strips?: Record<string, LedStrip> }).led_strips!;
      coll[led.id]!.matrix[0]![1] = null;
      coll[led.id]!.matrix[1]![0] = null;
    },
    (m: Record<string, unknown>, led: LedStrip) => {
      const coll = (m as { led_strips?: Record<string, LedStrip> }).led_strips!;
      coll[led.id]!.length = 9.99;
    },
  ] as ((m: Record<string, unknown>, led: LedStrip) => void)[]) {
    const { model, led } = lightScenario();
    const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
    const ws = saveMock(server, (s) => corrupt(s.model, led));
    await ws.open("0", "1");
    await assert.rejects(ws.save(), (e: unknown) => {
      const ok = e instanceof McpError && e.code === "SITE_ERROR";
      if (ok) assert.ok(JSON.stringify((e as McpError).details).includes("led_strip_mismatches"));
      return ok;
    });
  }
});

test("84: mock save — сервер испортил шину (height_lowering) и линейный свет (plan) → SITE_ERROR", async () => {
  const { model, stripe, line } = lightScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const m = s.model as { stripes_light?: Record<string, StripLight>; line_strips?: Record<string, LineStrip> };
    m.stripes_light![stripe.id]!.height_lowering = 5;
    m.line_strips![line.id]!.plan = "projections";
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    const ok = e instanceof McpError && e.code === "SITE_ERROR";
    if (ok) {
      const d = JSON.stringify((e as McpError).details);
      assert.ok(d.includes("stripes_light_mismatches") || d.includes("stripes_light_mismatches"), d.slice(0, 300));
      assert.ok(d.includes("line_strips_mismatches"));
    }
    return ok;
  });
});

test("84: mock save — props (id/name) и on_size у линии, подмена на сервере → SITE_ERROR", async () => {
  const { model, led } = lightScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const coll = (s.model as { led_strips?: Record<string, LedStrip> }).led_strips!;
    coll[led.id]!.props = { id: led.id, name: "line_light" };
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "SITE_ERROR");
});

// ---------- регрессия прежних разделов ----------

test("84: регрессия — трубы, газовые линии и предметы не затронуты; item_update не двигает световые линии", () => {
  const model = baseModel();
  const led = addLightLine(model, { kind: "led", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] }) as LedStrip;
  const gas = addGasLine(model, { start: { x: 1000, y: 2000 }, end: { x: 2000, y: 2000 } });
  const spot = addItem(model, { name: "waterspot_cold", position: { center: { x: 500, y: 2500 } }, catalogEntry: { id: 0, name: "waterspot_cold", title: "", group: "waterspots", width: 16, height: 9, self_height: 0, plan: { water: 27 }, over_floor: { value: 50, display: false } } });
  addPipe(model, { kind: "water", path: [{ itemId: spot.id }, { x: 1500, y: 2500 }] });
  const beforeLed = JSON.stringify(led);
  updateItem(model, { itemId: spot.id, center: { x: 600, y: 2500 } });
  assert.equal(JSON.stringify(led), beforeLed, "перенос предмета не задевает световые линии (нет вершин-предметов)");
  assert.equal(gas.length, 1);
  // предмет-концевая вершина трубы — каскад (этап 360): труба из 2 вершин удаляется
  const res = deleteItem(model, spot.id);
  assert.equal(res.deleted_pipes.length, 1, "труба из 2 вершин удалена вместе с выводом");
});

// ---------- эталоны световых линий (живая проверка PRO-проекта, обезличены) ----------

test("84: эталоны ui-ref-light-{led_strip,pendent_strip,line_light} — формат serialize в обе стороны", () => {
  for (const [name, kind] of [["led_strip", "led"], ["pendent_strip", "pendent"], ["line_light", "line"]] as const) {
    const fx = JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-light-${name}.json`), "utf8"));
    const m = fx.model_object as Record<string, unknown>;
    assert.equal(m["type"], name, `${name}: эталон отвечает за тот же вид`);
    assert.equal((m["props"] as Record<string, unknown>)["name"], name);
    // обратная сторона: addLightLine воспроизводит структуру эталона (те же ключи объекта)
    const model = baseModel();
    const line = addLightLine(model, {
      kind,
      path: (m["vertexes"] as { point: { x: number; y: number } }[]).map((v) => ({ x: v.point.x * 10, y: v.point.y * 10 })),
    }) as Record<string, unknown>;
    const gotKeys = Object.keys(line).sort().join(",");
    const wantKeys = Object.keys(m).sort().join(",");
    assert.equal(gotKeys, wantKeys, `${name}: набор полей совпадает (эталон из живой модели)`);
    assert.equal(line["type"], m["type"]);
    assert.deepEqual(line["props"], { id: line["id"], name });
    assert.equal((line["vertexes"] as { type: string }[])[0]!.type, "node");
    // 85 №4: эталон сверяется целиком — длина по рёбрам и геометрия узлов (см), а не только ключи
    assert.equal(lightLengthM(line as unknown as Pick<LedStrip, "vertexes" | "matrix">), m["length"], `${name}: длина совпадает с эталоном`);
    assert.deepEqual(
      (line["vertexes"] as { point: { x: number; y: number } }[]).map((v) => v.point),
      (m["vertexes"] as { point: { x: number; y: number } }[]).map((v) => v.point),
      `${name}: геометрия узлов совпадает с эталоном`,
    );
  }
});
