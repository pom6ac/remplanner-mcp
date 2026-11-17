// 94: разведка «Отделка» — шаг 4: DOM панели после выбора инструмента отделки стен.
// Анонимный проект. Запуск: node scripts/probes/94-finish-panel.ts
import { launch, newAnonProject, buildBase, switchSheet, pickTool, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

await switchSheet(page, "walls");
console.log("pick:", await pickTool(page, "wallpaper"));
await page.waitForTimeout(1000);

const dom = await page.evaluate(() => {
  const out: any = {};
  // видимая панель инструментов
  out.visibleTools = Array.from(document.querySelectorAll('[id^="plannertool_"]'))
    .filter((e: any) => e.offsetParent !== null)
    .slice(0, 30)
    .map((e: any) => ({ id: e.id, cls: e.className, parentCls: e.parentElement?.className }));
  // любые панели материалов
  const panels = Array.from(document.querySelectorAll("div,section")).filter((e: any) => {
    const st = getComputedStyle(e);
    return st.position !== "static" && e.offsetParent !== null && /material|материал|wallpaper|finish|cladding/i.test(e.className + " " + e.id);
  }).map((e: any) => ({ id: e.id, cls: e.className, children: e.children.length, text: e.textContent?.trim()?.slice(0, 200) }));
  out.materialPanels = panels.slice(0, 20);
  // класс активного инструмента
  const act = document.querySelector(".tools_item.active, .tool.active, [class*=active][id^=plannertool]");
  out.activeTool = act ? { id: act.id, cls: act.className } : null;
  // левая панель целиком (структура)
  const left: any = document.querySelector("#tools_panel, .tools_panel, #planner_left_panel");
  out.leftPanelHtml = left ? left.outerHTML.slice(0, 4000) : null;
  return out;
});
writeOut("94-wall-panel-dom", dom);
console.log(JSON.stringify(dom, null, 1).slice(0, 3000));
await browser.close();
process.exit(0);
