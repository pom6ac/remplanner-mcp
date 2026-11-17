// 113: разведка шаг 4c — DOM кнопки линейки и меню.
import { launch, newAnonProject, buildBase, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const dump = await page.evaluate(() => {
  const out: any = {};
  const ruler = document.querySelector(".footer_bar_tool.ruler");
  out.rulerHtml = ruler?.outerHTML?.slice(0, 2000) ?? null;
  out.rulerParent = ruler?.parentElement?.outerHTML?.slice(0, 4000) ?? null;
  // все footer_bar_tool
  out.tools = Array.from(document.querySelectorAll(".footer_bar_tool")).map((e: any) => ({
    cls: Array.from(e.classList).join(" "),
    parent: e.parentElement?.id || e.parentElement?.className?.toString().slice(0, 60) || "",
    html: e.outerHTML.slice(0, 300),
  }));
  const a = document.querySelector("#rulers");
  out.aRulers = a?.outerHTML?.slice(0, 1000) ?? null;
  out.aRulersParent = a?.parentElement?.outerHTML?.slice(0, 2500) ?? null;
  return out;
});
writeOut("113-ruler-dom", dump);
console.log("rulerHtml:", dump.rulerHtml);
console.log("aRulers:", dump.aRulers);
console.log("aRulersParent:", dump.aRulersParent);
for (const t of dump.tools) console.log("tool:", t.cls, "|", t.parent, "|", t.html.slice(0, 150));

await browser.close();
process.exit(0);
