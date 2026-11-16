// 84: UI-эталоны светильников — клики по всем бесплатным пунктам группы lights в анонимном
// проекте (эталоны ui-ref-light-*.json). PRO-пункты не кликаются (тариф) — их умолчания
// покрываются каталогом и юнит-тестами. node scripts/probes/84-light-fixtures.ts
import { launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt,
  writeOut, escape, D } from "./phase2-lib.ts";
import { writeFileSync, mkdirSync } from "node:fs";

const CEILING = [
  "lightspot", "lightspot_surface", "hanging_lightspot", "hanging_lightspot_double", "hanging_lightspot_triple",
  "chandelier", "hanging_light", "hanging_light_double", "hanging_light_triple",
  "ceiling_chandelier_shades", "ceiling_chandelier_led", "hanging_chandelier_shades", "hanging_chandelier_led",
  "cascading_chandelier", "crystal_chandelier", "chandelier_fan", "chandelier", "armstrong_light",
  "track_single", "track_double", "track_triple",
  "hanging_chandelier_long", "hanging_chandelier_shades_long", "hanging_chandelier_led_long",
  "hanging_chandelier_crystal_long", "ceiling_chandelier_long",
];
const WALL = ["bra", "bra_shades", "led_lamp", "light_stick", "wall_spot", "wall_lamp", "painting_lighting"];

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "light");

// координаты комнаты A (верхняя левая в базе «коридор + 3 комнаты»): оси 0..300 x -300..0
const center = { x: 150, y: -150 };
// внутренняя грань стены top: y = -300 + D/2 = -290; клик на 3 см внутрь
const wallSpot = { x: 150, y: -290 + 3 };

const catalog: Record<string, any> = await page.evaluate(() => {
  const gt: any = (window as any).global_tools ?? {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries<any>(gt)) {
    if (v && v.group === "lights") {
      out[k] = { id: v.id, width: v.width, height: v.height, self_height: v.self_height, plan: v.plan, anchor: v.anchor, over_floor: v.over_floor };
    }
  }
  return out;
});
writeOut("84-light-catalog-lights", catalog);
console.log("lights in catalog:", Object.keys(catalog).length);

mkdirSync("tests/fixtures", { recursive: true });
let ok = 0, fail: string[] = [];
let i = 0;
for (const name of [...CEILING, ...WALL]) {
  const pick = await pickTool(page, name);
  if (pick !== "ok") { console.log(name, pick); fail.push(`${name}:${pick}`); continue; }
  const b = await copyServer(page);
  const wallItem = WALL.includes(name);
  const p = wallItem ? { x: center.x + (i % 3) * 40, y: wallSpot.y } : { x: center.x + (i % 3) * 60, y: center.y + Math.floor(i / 3) * 30 };
  await clickAt(page, p);
  await escape(page);
  const a = await copyServer(page);
  const added = Object.values<any>(a.items ?? {}).filter((it) => !Object.keys(b.items ?? {}).includes(it.id));
  const item = added.find((it) => it.name === name);
  if (!item) { console.log(name, "NO ITEM; added:", added.map((x) => x.name).join(",")); fail.push(`${name}:no_item`); continue; }
  // обезличивание: id предмета и стены → "0" (как ui-ref-comm-*)
  const clean = JSON.parse(JSON.stringify(item));
  clean.id = "0";
  if (clean.id_wall !== undefined) clean.id_wall = typeof clean.id_wall === "string" && clean.id_wall ? "0" : clean.id_wall;
  if (clean.id_wall_old !== undefined) clean.id_wall_old = typeof clean.id_wall_old === "string" && clean.id_wall_old ? "0" : clean.id_wall_old;
  if (clean.wall_line) delete clean.wall_line;
  const entry = catalog[name] ?? {};
  const fixture = {
    _source: `клик по UI анонимного проекта (headless Chromium, ID проекта/плана обезличены), проба 84-light-fixtures, model project.copy("server"), без сохранения; id предмета и id_wall/id_wall_old обезличены ("0"); wall_line удалён; координаты — реальные точки листа (не идентифицируют)`,
    menu_title: entry.title ?? name,
    tool_id: `plannertool_${name}`,
    catalog_defaults_cm: {
      id: entry.id, width: entry.width, height: entry.height, self_height: entry.self_height,
      plan: entry.plan, anchor: entry.anchor, over_floor: entry.over_floor,
    },
    model_object: clean,
  };
  writeFileSync(`tests/fixtures/ui-ref-light-${name}.json`, JSON.stringify(fixture, null, 1) + "\n");
  ok++;
  console.log(name, "OK", JSON.stringify({ w: clean.width, h: clean.height, sh: clean.self_height, of: JSON.stringify(clean.over_floor) }));
  i++;
}
console.log(`done: ${ok} ok, fail: ${fail.join(", ") || "нет"}`);
writeOut("84-light-fixtures-summary", { ok, fail });
await browser.close();
process.exit(0);
