// Этап 25 «Окна»: структурное совпадение 7 типов с эталонами UI (ui-ref-window-*.json)
// и покрытие новых параметров opening_add/opening_update.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hole, Model } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addOpening, updateOpening, OPENING_KINDS } from "../../src/model/openings.ts";
import { compactModel } from "../../src/model/compact.ts";

const here = dirname(fileURLToPath(import.meta.url));

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {} };
}

function rect(model: Model) {
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  return { top: walls[0]!, bottom: walls[2]! };
}

type Ref = {
  catalog_key: string;
  model_type: string;
  defaults_model_cm: Record<string, unknown>;
};

const WINDOW_KEYS = [
  "windowway", "window", "window_balcony", "window_door",
  "french_window", "french_window_coupe", "french_window_double",
];

/** Сверка структурных полей проёма с эталоном UI (геометрию pc/p1/p2 не сравниваем). */
function expectStructural(hole: Hole, ref: Record<string, unknown>) {
  const et = ref.defaults_model_cm as Record<string, unknown>;
  const fields = ["type", "group", "width", "height", "depth", "floor_height", "opening",
    "casements", "slopes", "slope_angle", "casing", "sill", "window_width", "window_height",
    "door_width", "door_height", "door_position", "impost_offset"];
  for (const f of fields) {
    if (et[f] === undefined) {
      assert.ok(hole[f] === undefined, `${ref.catalog_key}: поле ${f} не должно задаваться (эталон без него)`);
    } else if (f === "sill" && hole.sill && et.sill) {
      // side — сторона помещения, редактор вычисляет её по контексту; сверяем числовые поля
      const a = hole.sill as Record<string, unknown>, b = et.sill as Record<string, unknown>;
      assert.equal(a.thinkness, b.thinkness, `${ref.catalog_key}: sill.thinkness`);
      assert.equal(a.overhang, b.overhang, `${ref.catalog_key}: sill.overhang`);
      assert.equal(a.overmeasure, b.overmeasure, `${ref.catalog_key}: sill.overmeasure`);
    } else {
      assert.deepEqual(hole[f], et[f], `${ref.catalog_key}: поле ${f}`);
    }
  }
}

for (const key of WINDOW_KEYS) {
  test(`тип ${key}: структура дефолтов совпадает с эталоном UI`, () => {
    const ref = JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-window-${key}.json`), "utf8"));
    assert.equal(OPENING_KINDS[key]!.type, ref.model_type);
    const model = emptyModel();
    const { top } = rect(model);
    const hole = addOpening(model, { wallId: top.id, type: key, centerMm: 2000 });
    expectStructural(hole as unknown as Record<string, unknown> extends never ? never : Hole, ref as unknown as Record<string, unknown>);
  });
}

test("windoor: window_width_mm/door_width_mm задают части, итог — сумма", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const hole = addOpening(model, {
    wallId: top.id, type: "window_balcony", centerMm: 2000,
    windowWidthMm: 1400, doorWidthMm: 1200,
  });
  assert.equal(hole.type, "windoor");
  assert.equal(hole.width, 260);
  assert.equal(hole.window_width, 140);
  assert.equal(hole.door_width, 120);
  assert.equal(hole.height, undefined);
  assert.equal(hole.door_position, "l");
});

test("windoor: door_position=right и door_width_mm без окна", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const hole = addOpening(model, { wallId: top.id, type: "window_balcony", centerMm: 2000, doorPosition: "right", doorWidthMm: 900 });
  assert.equal(hole.door_position, "r");
  assert.equal(hole.door_width, 90);
  assert.equal(hole.window_width, 90); // 1800 − 900
  assert.equal(hole.width, 180);
});

test("окно: новые параметры панели свойств попадают в модель", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const hole = addOpening(model, {
    wallId: top.id, type: "window", centerMm: 2000,
    casements: 2, slopeAngleDeg: 15,
    sillThicknessMm: 60, sillOverhangMm: 50, sillOvermeasureMm: 70,
  });
  assert.equal(hole.casements, 2);
  assert.equal(hole.slope_angle, 15);
  assert.deepEqual(hole.sill, { thinkness: 6, overhang: 5, overmeasure: 7, side: "l" });
});

test("балконная дверь: impost_height_mm → impost_offset = значение − подоконник", () => {
  const model = emptyModel();
  const { top } = rect(model);
  // дефолт: подоконник 10, импост 75 (=85 от пола, эталон UI)
  const h1 = addOpening(model, { wallId: top.id, type: "window_door", centerMm: 1000 });
  assert.equal(h1.impost_offset, 75);
  const h2 = addOpening(model, { wallId: top.id, type: "window_door", centerMm: 3000, impostHeightMm: 1400 });
  assert.equal(h2.impost_offset, 130);
});

test("opening_update: новые параметры меняют существующий проём", () => {
  const model = emptyModel();
  const { top, bottom } = rect(model);
  const w = addOpening(model, { wallId: top.id, type: "window", centerMm: 2000 });
  updateOpening(model, {
    wallId: top.id, holeId: w.id,
    casements: 3, slopeAngleDeg: 10, sillOverhangMm: 70, casing: false,
  });
  assert.equal(w.casements, 3);
  assert.equal(w.slope_angle, 10);
  assert.equal((w.sill as { overhang: number }).overhang, 7);
  assert.equal(w.casing, 0);
  // windoor: части через update
  const wd = addOpening(model, { wallId: bottom.id, type: "window_balcony", centerMm: 2000 });
  updateOpening(model, { wallId: bottom.id, holeId: wd.id, windowWidthMm: 1200, doorPosition: "right" });
  assert.equal(wd.window_width, 120);
  assert.equal(wd.door_width, 80); // дверь не задана — остаётся дефолтной, как в UI
  assert.equal(wd.width, 200);
  assert.equal(wd.door_position, "r");
});

test("регрессия: старый проект без новых полей — compact и update не падают и не добавляют лишнего", () => {
  const model = emptyModel();
  const { top } = rect(model);
  // проём «как в старом проекте»: только базовые поля
  const hole: Hole = {
    id: "old1", plan: "a", type: "window", group: "windows",
    pc: { x: 200, y: -10 }, width: 120, height: 150, depth: 6, at: 140,
  };
  top.holes[hole.id] = hole;
  const compact = compactModel(model);
  const co = compact.walls.find((w) => w.site_id === top.id)!.openings[0]!;
  assert.equal(co.type, "window");
  assert.equal(co.sill, undefined);
  assert.equal(co.casements, undefined);
  updateOpening(model, { wallId: top.id, holeId: hole.id, widthMm: 1400 });
  assert.equal(hole.width, 140);
  assert.equal(hole.casements, undefined); // ничего не добавлено
  assert.equal(hole.sill, undefined);
});

test("каждый пункт меню «Окна» имеет русское имя в эталоне и тип в OPENING_KINDS", () => {
  for (const key of WINDOW_KEYS) {
    const ref = JSON.parse(readFileSync(join(here, `../fixtures/ui-ref-window-${key}.json`), "utf8"));
    assert.ok(ref.menu_title && ref.menu_title.length > 3, key);
    assert.ok(OPENING_KINDS[key], key);
  }
});
