// 94: разведка раздела «Отделка» — шаг 1: листы навигации и состав инструментов.
// Анонимный проект. Запуск: node scripts/probes/94-finish-scout.ts
import { launch, newAnonProject, buildBase, switchSheet, writeOut, proKeys } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const sheets = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".groups_navi_item")).map((e: any) => ({
    cls: Array.from(e.classList).join(" "),
    title: (e.title || e.textContent?.trim() || "").slice(0, 40),
  })));
writeOut("94-sheets", sheets);
console.log("sheets:", sheets.map((s: any) => s.cls).join(" | "));

// по каждому листу — инструменты
const all: Record<string, any[]> = {};
for (const s of sheets) {
  const m = s.cls.match(/plan_[a-z0-9_]+/);
  if (!m) continue;
  const name = m[0];
  try {
    await switchSheet(page, name.replace(/^plan_/, ""));
  } catch (e) {
    console.log(name, "switch failed", String(e).slice(0, 80));
    continue;
  }
  const tools = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[id^="plannertool_"]')).map((e: any) => {
      const group = e.closest(".tools_item, .subtools_item");
      return {
        id: e.id.replace(/^plannertool_/, ""),
        pro: e.classList.contains("is_pro") || !!(group && group.classList.contains("is_pro")),
        title: (e.title || e.getAttribute("data-title") || "").slice(0, 60),
      };
    }));
  all[name] = tools;
  console.log(name, tools.length, "tools:", tools.map((t: any) => t.id + (t.pro ? "*" : "")).join(","));
}
writeOut("94-all-tools", all);
const pro = await proKeys(page);
writeOut("94-pro-keys", pro);
console.log("pro keys:", pro.join(","));
await browser.close();
process.exit(0);
