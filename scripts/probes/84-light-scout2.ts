// 84 (v2): пункты листа «Освещение» (видимые), клики по представителям с раздельным diff,
// панель свойств. Анонимный проект. node scripts/probes/84-light-scout2.ts
import {
  launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt, dragAt,
  diffModels, writeOut, escape, shot,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "light");

// видимые инструменты листа света
const tools = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[id^="plannertool_"]'))
    .filter((e: any) => e.offsetParent !== null)
    .map((e: any) => {
      const group = e.closest(".tools_item, .subtools_item");
      return {
        id: e.id.replace(/^plannertool_/, ""),
        pro: e.classList.contains("is_pro") || !!(group && group.classList.contains("is_pro")),
        title: e.title || e.getAttribute("data-title") || "",
      };
    }));
writeOut("84-light-tools2", tools);
console.log("visible tools:", tools.length);

const STRIPS = ["led_strip", "line_light", "recessed_strip", "surface_stripe", "pendent_strip", "track_line_spot"];
const samples = [
  "lightspot", "chandelier", "hanging_light", "bra", "lightspot_surface",
  "led_strip", "line_light", "recessed_strip", "pendent_strip",
];
const res: any = {};
let i = 0;
for (const name of samples) {
  const pick = await pickTool(page, name);
  if (pick !== "ok") { res[name] = { pick }; console.log(name, pick); continue; }
  const b = await copyServer(page);
  const p = { x: 100 + (i % 3) * 120, y: -260 + Math.floor(i / 3) * 90 };
  if (STRIPS.includes(name)) {
    await dragAt(page, p, { x: p.x + 120, y: p.y });
  } else {
    await clickAt(page, p);
  }
  await escape(page);
  const a = await copyServer(page);
  const diff = diffModels(b, a);
  res[name] = { pick, spot: p, diff };
  console.log(name, pick, "diff keys:", JSON.stringify(Object.keys(diff)));
  i++;
}
writeOut("84-light-samples2", res);

// панель свойств потолочного светильника (правый клик)
const spotItem = Object.values<any>(res["lightspot"]?.diff?.items?.added ?? {})[0];
if (spotItem) {
  await clickAt(page, { x: spotItem.pc.x, y: spotItem.pc.y }, "right");
  const menus = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[id^=cm-]"))
      .filter((e: any) => e.offsetParent !== null)
      .map((e: any) => ({ id: e.id, rows: Array.from(e.querySelectorAll("li, .cm_item, input, select")).slice(0, 15).map((r: any) => ({ id: r.id, t: (r.textContent || r.value || "").trim().slice(0, 40) })) })));
  writeOut("84-light-cm-item", menus);
  await escape(page);
}

await shot(page, "84-light-final");
await browser.close();
process.exit(0);
