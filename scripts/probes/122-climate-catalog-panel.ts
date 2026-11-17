// 122: панель каталога на листах conditioners/ventilation — где пункты предметов.
import {
  launch, newAnonProject, buildBase, switchSheet, writeOut,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const res: any = {};
for (const sheet of ["conditioners", "ventilation", "warm_floor"]) {
  await switchSheet(page, sheet);
  const info = await page.evaluate(() => {
    const w: any = window as any;
    const cur = (w.$ManagerSheets && w.$ManagerSheets.current?.code) ?? (w.$Project?.plan) ?? (w.plan_current) ?? null;
    // подсказки листов в разметке
    const navs = Array.from(document.querySelectorAll(".groups_navi_item")).map((e: any) => ({
      cls: e.className, act: e.classList.contains("active"), t: (e.title || e.textContent || "").trim().slice(0, 20),
    })).filter((x) => x.act);
    // любые кликабельные каталог-элементы
    const items = Array.from(document.querySelectorAll(".catalog_item, .tools_catalog_item, [class*=catalog] [class*=item]"))
      .filter((e: any) => e.offsetParent !== null).slice(0, 40)
      .map((e: any) => ({ cls: e.className, id: e.id || "", title: e.title || e.textContent?.trim()?.slice(0, 30) }));
    return { cur, active: navs, items };
  });
  res[sheet] = info;
  console.log(`--- ${sheet}: cur=${JSON.stringify(info.cur)} active=${info.active.map((x: any) => x.cls).join(";")}`);
  console.log("   catalog-ish items:", info.items.map((x: any) => `${x.id}|${x.title}`).join(" ; ").slice(0, 1500));
}
writeOut("122-climate-catalog-panel", res);
await browser.close();
process.exit(0);
