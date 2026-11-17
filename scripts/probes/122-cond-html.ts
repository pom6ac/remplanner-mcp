// 122: полный HTML панелей на листе conditioners (пункты предметов).
import {
  launch, newAnonProject, buildBase, switchSheet, writeOut,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "conditioners");

const html = await page.evaluate(() => {
  const left: any = document.querySelector(".left_panel, #left_panel, .tools_panel, #tools");
  const bar: any = document.querySelector(".footer_bar, .groups_navi");
  const all = Array.from(document.querySelectorAll("[id^='plannertool_']")).map((e: any) => ({
    id: e.id, vis: e.offsetParent !== null, title: e.title || "", cls: e.className,
  }));
  return { left: left ? left.outerHTML.slice(0, 6000) : null, bar: bar ? bar.outerHTML.slice(0, 1000) : null, all };
});
writeOut("122-cond-html", html);
console.log("ALL plannertool:", html.all.map((t: any) => `${t.id.replace("plannertool_", "")}${t.vis ? "" : "(hidden)"}`).join(", "));
console.log("LEFT:", (html.left || "null").replace(/></g, ">\n<").slice(0, 3000));
await browser.close();
process.exit(0);
