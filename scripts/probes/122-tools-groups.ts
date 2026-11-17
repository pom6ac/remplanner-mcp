// 122: tools_item верхнего уровня на листах furniture/conditioners/ventilation и раскрытие групп.
import { launch, newAnonProject, buildBase, switchSheet } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

for (const sheet of ["furniture", "conditioners", "ventilation", "warm_floor"] as const) {
  await switchSheet(page, sheet);
  const info = await page.evaluate(() => {
    const wrapper: any = document.querySelector("#planner_ui_tools_wrapper");
    if (!wrapper) return null;
    const tops = Array.from(wrapper.querySelectorAll(":scope > *")).map((e: any) => {
      const name = e.querySelector?.(".tools_item_name, .subtools_item_name, span, b, i");
      const firstTool = e.querySelector?.("[id^=plannertool_]");
      return {
        tag: e.tagName, id: e.id, cls: String(e.className).slice(0, 70), vis: e.offsetParent !== null,
        name: (name?.textContent || e.title || "").trim().slice(0, 40),
        firstTool: firstTool?.id?.replace("plannertool_", ""),
      };
    });
    // все tools_item (родители групп) с видимостью
    const groups = Array.from(wrapper.querySelectorAll(".tools_item")).map((e: any) => ({
      id: e.id, vis: e.offsetParent !== null, title: (e.title || e.textContent || "").trim().slice(0, 40),
      tools: Array.from(e.querySelectorAll("[id^=plannertool_]")).slice(0, 30).map((t: any) => t.id.replace("plannertool_", "")),
    }));
    return { tops, groups };
  });
  console.log(`--- ${sheet}:`);
  console.log("  tops:", JSON.stringify(info?.tops, null, 0));
  console.log("  groups:", JSON.stringify(info?.groups.filter((g: any) => g.vis || g.tools.length), null, 0).slice(0, 2000));
}
await browser.close();
process.exit(0);
