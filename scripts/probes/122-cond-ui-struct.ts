// 122: структура UI листа conditioners — где пункты предметов кондиционеров.
import { launch, newAnonProject, buildBase, switchSheet, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "conditioners");

const info = await page.evaluate(() => {
  // top-level блоки
  const tops = Array.from(document.body.children).map((e: any) => ({ id: e.id, cls: e.className, vis: e.offsetParent !== null }));
  // элементы, ссылающиеся на кондиционеры
  const hits: any[] = [];
  for (const el of Array.from(document.querySelectorAll("*")) as any[]) {
    const t = (el.title || "") + " " + (el.getAttribute("data-title") || "");
    if (/кондиц/i.test(t) && el.offsetParent !== null) {
      hits.push({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 80), title: (el.title || "").slice(0, 60) });
    }
  }
  // подсказки: видимые пункты левой панели
  const leftCand = Array.from(document.querySelectorAll("div")).filter((e: any) => e.offsetParent !== null && /catalog|left|search/i.test(String(e.className) + " " + e.id)).slice(0, 20).map((e: any) => ({ id: e.id, cls: String(e.className).slice(0, 80) }));
  return { tops, hits: hits.slice(0, 40), leftCand };
});
writeOut("122-cond-ui-struct", info);
console.log(JSON.stringify(info, null, 1).slice(0, 5000));
await browser.close();
process.exit(0);
