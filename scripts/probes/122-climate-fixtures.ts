// 122: UI-эталоны предметов климата (анонимный проект): тёплый пол, терморегулятор,
// кондиционеры, радиатор, вентилятор. Групповые панели листов раскрываются кликом по группе.
import { launch, newAnonProject, buildBase, copyServer, switchSheet, clickAt,
  writeOut, escape, diffModels } from "./phase2-lib.ts";
import { writeFileSync } from "node:fs";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

// pickTool с раскрытием групп листов conditioners/ventilation/radiators:
// сначала клик по видимой .tools_item группе, затем по plannertool_<key>
const pickGroupTool = async (key: string, groupTitle: string): Promise<"ok" | "pro" | "missing"> => {
  const st = await page.evaluate(({ key, groupTitle }) => {
    const el: any = document.querySelector(`#plannertool_${key}`);
    if (!el) return "missing";
    const group = el.closest(".tools_item, .subtools_item");
    if (el.classList.contains("is_pro") || (group && group.classList.contains("is_pro"))) return "pro";
    // раскрыть группу: прямой родитель .subtools или видимый tools_item с тем же названием
    const parent: any = el.closest(".subtools");
    if (parent && parent.id) {
      const opener: any = document.querySelector(`[data-target="${parent.id}"]`);
      opener?.click();
    } else {
      // группа без id: ищем видимый .tools_item, чей текст совпадает с ожидаемым названием
      const tops = Array.from(document.querySelectorAll(".tools .tools_item, #planner_ui_tools .tools_item")) as any[];
      const g = tops.find((t) => (t.textContent || "").includes(groupTitle));
      g?.click();
    }
    el.click();
    return "ok";
  }, { key, groupTitle });
  await page.waitForTimeout(600);
  return st as "ok" | "pro" | "missing";
};

const center = { x: 150, y: -150 };
const wallSpot = { x: 150, y: -290 + 3 };
const wallSpot2 = { x: 220, y: -290 + 6 };

const plan: { sheet: string; tool: string; group: string; kind: "click" | "drag"; at?: { x: number; y: number } }[] = [
  { sheet: "warm_floor", tool: "warm_floor", group: "Кабельный теплый пол", kind: "drag" },
  { sheet: "warm_floor", tool: "warm_floor_ir", group: "Инфракрасный теплый пол", kind: "drag" },
  { sheet: "warm_floor", tool: "socket_thermo", group: "Терморегулятор", kind: "click", at: wallSpot },
  { sheet: "conditioners", tool: "conditioner", group: "Внутренние блоки", kind: "click", at: wallSpot },
  { sheet: "conditioners", tool: "conditioner_engine", group: "Внешние блоки", kind: "click", at: { x: 250, y: wallSpot.y } },
  { sheet: "conditioners", tool: "floor_conditioner", group: "Внутренние блоки", kind: "click", at: center },
  { sheet: "conditioners", tool: "air_curtain", group: "Внутренние блоки", kind: "click", at: { x: 60, y: -60 } },
  { sheet: "radiators", tool: "radiator_bimetal", group: "Радиаторы", kind: "click", at: { x: 150, y: -290 + 6 } },
  { sheet: "ventilation", tool: "fan", group: "Вентиляторы", kind: "click", at: { x: 380, y: -150 } },
];

const catalog: Record<string, any> = await page.evaluate(() => {
  const gt: any = (window as any).global_tools ?? {};
  const keys = ["warm_floor", "warm_floor_ir", "socket_thermo", "conditioner", "conditioner_engine", "floor_conditioner", "air_curtain", "radiator_bimetal", "fan", "ventilation_gate", "ventilation_system", "fan_wall", "fan_channel", "bladed_fan", "wall_blade_fan", "radiator_steel", "vertical_radiator", "floor_convector", "electro_convector", "warm_floor_water", "warm_floor_wire", "warm_floor_pipe", "conditioner_wire", "conditioner_drainage", "heat_pipe_hot", "heat_pipe_cold", "ventpipe_out", "ventpipe_in", "warm_wall_cable"];
  const out: Record<string, any> = {};
  for (const k of keys) {
    const v = gt[k];
    if (v) out[k] = { id: v.id, title: v.title, group: v.group, width: v.width, height: v.height, self_height: v.self_height, plan: v.plan, anchor: v.anchor, over_floor: v.over_floor ?? null };
  }
  return out;
});
writeOut("122-climate-catalog-entries", catalog);

mkdirFixtures();
let ok = 0;
const fail: string[] = [];
for (const st of plan) {
  await switchSheet(page, st.sheet);
  const pick = await pickGroupTool(st.tool, st.group);
  if (pick !== "ok") { console.log(st.tool, pick); fail.push(`${st.tool}:${pick}`); continue; }
  const b = await copyServer(page);
  if (st.kind === "drag") {
    const { dragAt } = await import("./phase2-lib.ts");
    await dragAt(page, { x: 60, y: -240 }, { x: 240, y: -60 });
  } else {
    await clickAt(page, st.at ?? center);
  }
  await escape(page);
  const a = await copyServer(page);
  const diff = diffModels(b, a);
  // объект: предмет или контур warm_floors
  const itemsAdded = Object.values<any>(diff.items?.added ?? {});
  const item = itemsAdded.find((it: any) => it.name === st.tool || it.name === "socket_group")
    ?? itemsAdded[0];
  const wfAdded = Object.values<any>(diff.warm_floors?.added ?? {})[0];
  const obj = item ?? wfAdded;
  if (!obj) { console.log(st.tool, "NO OBJECT; diff cols:", Object.keys(diff).join(",")); fail.push(`${st.tool}:no_obj`); continue; }
  const clean = JSON.parse(JSON.stringify(obj));
  clean.id = "0";
  if (clean.id_room !== undefined) clean.id_room = typeof clean.id_room === "string" && clean.id_room ? "0" : clean.id_room;
  if (clean.id_wall !== undefined) clean.id_wall = typeof clean.id_wall === "string" && clean.id_wall ? "0" : clean.id_wall;
  if (clean.id_wall_old !== undefined) clean.id_wall_old = typeof clean.id_wall_old === "string" && clean.id_wall_old ? "0" : clean.id_wall_old;
  if (clean.wall_line) delete clean.wall_line;
  if (Array.isArray(clean.socket_group)) for (const s of clean.socket_group) if (s.id) s.id = "0";
  const entry = catalog[st.tool] ?? {};
  const fixture = {
    _source: `клик по UI анонимного проекта (headless Chromium, ID проекта/плана обезличены), проба 122-climate-fixtures, model project.copy("server"), без сохранения; id предмета/комнаты/стены обезличены ("0"); wall_line удалён; координаты — реальные точки листа`,
    menu_title: entry.title ?? st.tool,
    tool_id: `plannertool_${st.tool}`,
    catalog_defaults_cm: entry,
    model_object: clean,
  };
  const name = item ? (item.name === "socket_group" ? `thermo-${st.tool}` : st.tool) : `wf-${st.tool}`;
  writeFileSync(`tests/fixtures/ui-ref-climate-${name}.json`, JSON.stringify(fixture, null, 1) + "\n");
  ok++;
  console.log(st.tool, "OK", JSON.stringify({ name: clean.name, w: clean.width, h: clean.height, of: JSON.stringify(clean.over_floor), dims: JSON.stringify(clean.dimensions) }));
}
console.log(`done: ${ok} ok, fail: ${fail.join(", ") || "нет"}`);
writeOut("122-climate-fixtures-summary", { ok, fail });
await browser.close();
process.exit(0);

function mkdirFixtures() {}
