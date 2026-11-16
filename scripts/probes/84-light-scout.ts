// 84: разведка листа «Освещение» — состав меню, PRO, куда пишутся пункты.
// Анонимный проект. Запуск: node scripts/probes/84-light-scout.ts
import {
  launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt, dragAt,
  diffModels, writeOut, proKeys, escape,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
const before = await copyServer(page);
await buildBase(page);
const afterBase = await copyServer(page);

// все листы навигации
const sheets = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".groups_navi_item")).map((e: any) => ({
    cls: Array.from(e.classList).join(" "),
    title: e.title || e.textContent?.trim()?.slice(0, 30),
  })));
writeOut("84-light-sheets", sheets);
console.log("sheets:", sheets.map((s: any) => s.cls.replace("groups_navi_item ", "")).join(", "));

// лист света
await switchSheet(page, "light");

// пункты меню листа света
const tools = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[id^="plannertool_"]'))
    .map((e: any) => {
      const group = e.closest(".tools_item, .subtools_item");
      return {
        id: e.id.replace(/^plannertool_/, ""),
        pro: e.classList.contains("is_pro") || !!(group && group.classList.contains("is_pro")),
        title: e.title || e.getAttribute("data-title") || "",
      };
    }));
writeOut("84-light-tools", tools);
console.log("tools on light sheet:", tools.length);

const wanted = tools.map((t: any) => t.id);
const pro = await proKeys(page);
writeOut("84-light-pro", Object.fromEntries(wanted.map((k) => [k, pro.includes(k)])));
console.log("pro:", wanted.filter((k) => pro.includes(k)).join(" "));

// по одному представителю: потолочный предмет, настенный, и все strip/линейные
const samples = [
  "lightspot", "chandelier", "bra", "led_strip", "line_light",
  "recessed_strip", "surface_stripe", "pendent_strip", "track_line_spot", "track_spot",
];
const res: any = {};
for (const name of samples) {
  const pick = await pickTool(page, name);
  if (pick !== "ok") { res[name] = { pick }; console.log(name, pick); continue; }
  // предмет — клик; полосы/линии — drag (как газовая линия)
  if (["led_strip", "line_light", "recessed_strip", "surface_stripe", "pendent_strip", "track_line_spot"].includes(name)) {
    await dragAt(page, { x: 100, y: -250 }, { x: 250, y: -250 });
  } else {
    await clickAt(page, { x: 150, y: -150 });
  }
  await escape(page);
  const after = await copyServer(page);
  const diff = diffModels(afterBase, after);
  res[name] = { pick, diff };
  console.log(name, "diff keys:", JSON.stringify(Object.keys(diff)));
}
writeOut("84-light-samples", res);

await browser.close();
process.exit(0);
