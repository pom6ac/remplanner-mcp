// 122: левая панель каталога на листах conditioners/ventilation/warm_floor/security.
import {
  launch, newAnonProject, buildBase, switchSheet, writeOut,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const res: any = {};
for (const sheet of ["conditioners", "ventilation", "warm_floor", "security", "radiators"]) {
  await switchSheet(page, sheet);
  const panel = await page.evaluate(() => {
    const tools = Array.from(document.querySelectorAll('[id^="plannertool_"]'))
      .filter((e: any) => e.offsetParent !== null)
      .map((e: any) => ({
        id: e.id.replace(/^plannertool_/, ""),
        pro: e.classList.contains("is_pro") || !!e.closest(".tools_item.is_pro, .subtools_item.is_pro"),
        title: e.title || "",
      }));
    // все элементы каталога, которые редактор показывает на этом листе (global_tools в памяти)
    const w: any = window as any;
    const gt = w.global_tools || {};
    const cur = w.$Project?.plan_current ?? w.project?.plan_current ?? "?";
    const onSheet = Object.entries(gt)
      .filter(([k, v]: any) => v && typeof v.plan === "object" && Object.keys(v.plan).some((p) => p === cur || (p === "init" && cur === "a")))
      .map(([k, v]: any) => ({ id: k, group: v.group, anchor: v.anchor, plan: v.plan }));
    return { tools, planCurrent: cur, onSheetCount: onSheet.length, onSheet: onSheet.map((x: any) => `${x.id}(${x.group})`) };
  });
  res[sheet] = panel;
  console.log(`sheet ${sheet}: panel tools:`, panel.tools.map((t: any) => `${t.id}${t.pro ? "*" : ""}`).join(", "));
  console.log(`  plan_current=${panel.planCurrent}; global_tools on sheet: ${panel.onSheetCount}`);
  console.log("  ", panel.onSheet.slice(0, 40).join(", "));
}
writeOut("122-climate-panel", res);
await browser.close();
process.exit(0);
