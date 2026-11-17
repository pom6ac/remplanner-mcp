// 122: скриншоты листов furniture и conditioners для сравнения левой панели.
import { launch, newAnonProject, buildBase, switchSheet } from "./phase2-lib.ts";
import { mkdirSync } from "node:fs";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
mkdirSync(".orca-reports/phase2-ui-refs", { recursive: true });
for (const sheet of ["furniture", "conditioners", "ventilation", "warm_floor"]) {
  await switchSheet(page, sheet);
  await page.screenshot({ path: `.orca-reports/phase2-ui-refs/122-sheet-${sheet}.png` });
  const left = await page.evaluate(() => {
    const el: any = document.querySelector(".tools, .planner_ui_tools, #tools, .planner_ui_left");
    const pc: any = document.querySelector(".planner_container");
    return {
      toolsFound: !!el,
      pcChildren: pc ? Array.from(pc.children).map((c: any) => ({ id: c.id, cls: String(c.className).slice(0, 50), vis: c.offsetParent !== null })) : null,
    };
  });
  console.log(sheet, JSON.stringify(left));
}
await browser.close();
process.exit(0);
