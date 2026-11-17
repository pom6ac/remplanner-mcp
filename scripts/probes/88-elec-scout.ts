// 88: разведка электрики — состав листов, меню, PRO. Анонимный проект.
import {
  launch, newAnonProject, buildBase, switchSheet, pickTool, writeOut, proKeys,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const sheets = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".groups_navi_item")).map((e: any) => ({
    cls: Array.from(e.classList).join(" "),
    title: e.title || e.textContent?.trim()?.slice(0, 40),
  })));
writeOut("88-elec-sheets", sheets);
console.log("sheets:", sheets.map((s: any) => `${s.title}=>${s.cls.replace("groups_navi_item ", "")}`).join(" | "));

const candidates = ["sockets", "light_connections", "light", "cables", "shield", "warm_floor"];
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
await browser.close();
process.exit(0);
