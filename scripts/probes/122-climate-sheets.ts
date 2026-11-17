// 122: разведка разделов климата — состав листов, меню, PRO. Анонимный проект.
import {
  launch, newAnonProject, buildBase, switchSheet, writeOut,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const candidates = ["warm_floor", "conditioners", "ventilation", "security", "radiators"];
const res: any = {};
for (const sheet of candidates) {
  await switchSheet(page, sheet);
  const tools = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[id^="plannertool_"]')).filter((e: any) => e.offsetParent !== null)
    .map((e: any) => {
      const group = e.closest(".tools_item, .subtools_item");
      return {
        id: e.id.replace(/^plannertool_/, ""),
        pro: e.classList.contains("is_pro") || !!(group && group.classList.contains("is_pro")),
        title: e.title || e.getAttribute("data-title") || "",
      };
    }));
  res[sheet] = tools;
  console.log(`sheet ${sheet}: ${tools.length} tools;`, tools.map((t: any) => `${t.id}${t.pro ? "*" : ""}`).join(", "));
}
writeOut("122-climate-sheets", res);
await browser.close();
process.exit(0);
