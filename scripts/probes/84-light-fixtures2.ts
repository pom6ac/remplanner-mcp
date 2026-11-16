// 84 (round 2): дозатор эталонов — недостающие пункты (вложенные подгруппы, клик
// строго внутри комнаты A). node scripts/probes/84-light-fixtures2.ts
import { launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt,
  writeOut, escape } from "./phase2-lib.ts";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const MISSING = [
  "hanging_lightspot", "hanging_lightspot_double", "hanging_lightspot_triple",
  "hanging_light_double", "hanging_light_triple", "chandelier", "armstrong_light",
  "track_single", "track_double", "track_triple", "hanging_chandelier_long",
  "hanging_chandelier_shades_long", "hanging_chandelier_led_long",
  "hanging_chandelier_crystal_long", "ceiling_chandelier_long",
];

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "light");

// раскрыть все подгруппы листа (два уровня)
await page.evaluate(() => {
  document.querySelectorAll(".groups_navi_item.plan_light .subtools, #planner_ui_tools_wrapper .subtools").forEach(() => {});
  document.querySelectorAll('[data-target]').forEach((o: any) => {
    const t = document.getElementById(o.getAttribute("data-target"));
    if (t && t.closest("#planner_ui_tools_wrapper") && t.offsetParent === null) o.click();
  });
});
await page.waitForTimeout(800);

const catalog: Record<string, any> = await page.evaluate(() => {
  const gt: any = (window as any).global_tools ?? {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries<any>(gt)) {
    if (v && v.group === "lights") {
      out[k] = { id: v.id, width: v.width, height: v.height, self_height: v.self_height, plan: v.plan, anchor: v.anchor, over_floor: v.over_floor, title: v.title };
    }
  }
  return out;
});

// точки внутри комнаты A (оси 0..300 x -300..0), сетка 5×4 с шагом 55, старт (40,-255)
function spot(i: number): { x: number; y: number } {
  return { x: 40 + (i % 5) * 55, y: -255 + Math.floor(i / 5) * 55 };
}

let ok = 0, fail: string[] = [];
let i = 0;
for (const name of MISSING) {
  const pick = await pickTool(page, name);
  if (pick !== "ok") { console.log(name, pick); fail.push(`${name}:${pick}`); continue; }
  const b = await copyServer(page);
  await clickAt(page, spot(i));
  await escape(page);
  const a = await copyServer(page);
  const added = Object.values<any>(a.items ?? {}).filter((it) => !Object.keys(b.items ?? {}).includes(it.id));
  const item = added.find((it) => it.name === name);
  if (!item) { console.log(name, "NO ITEM; added:", added.map((x) => x.name).join(",")); fail.push(`${name}:no_item`); i++; continue; }
  const clean = JSON.parse(JSON.stringify(item));
  clean.id = "0";
  if (clean.id_wall !== undefined) clean.id_wall = typeof clean.id_wall === "string" && clean.id_wall ? "0" : clean.id_wall;
  if (clean.id_wall_old !== undefined) clean.id_wall_old = typeof clean.id_wall_old === "string" && clean.id_wall_old ? "0" : clean.id_wall_old;
  if (clean.wall_line) delete clean.wall_line;
  const entry = catalog[name] ?? {};
  const fixture = {
    _source: `клик по UI анонимного проекта (headless Chromium, ID проекта/плана обезличены), проба 84-light-fixtures2, model project.copy("server"), без сохранения; id предмета и id_wall/id_wall_old обезличены ("0"); wall_line удалён; координаты — реальные точки листа (не идентифицируют)`,
    menu_title: entry.title ?? name,
    tool_id: `plannertool_${name}`,
    catalog_defaults_cm: {
      id: entry.id, width: entry.width, height: entry.height, self_height: entry.self_height,
      plan: entry.plan, anchor: entry.anchor, over_floor: entry.over_floor,
    },
    model_object: clean,
  };
  const path = `tests/fixtures/ui-ref-light-${name}.json`;
  if (existsSync(path)) console.log(name, "уже есть — пропущен");
  else { writeFileSync(path, JSON.stringify(fixture, null, 1) + "\n"); ok++; console.log(name, "OK", JSON.stringify({ w: clean.width, of: JSON.stringify(clean.over_floor) })); }
  i++;
}
console.log(`done: ${ok} ok, fail: ${fail.join(", ") || "нет"}`);
writeOut("84-light-fixtures2-summary", { ok, fail });
await browser.close();
process.exit(0);
