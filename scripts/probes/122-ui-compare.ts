// 122: сравнение UI листа furniture (есть каталог слева) и conditioners.
import { launch, newAnonProject, buildBase, switchSheet, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const res: any = {};
for (const sheet of ["furniture", "conditioners", "ventilation"]) {
  await switchSheet(page, sheet);
  const info = await page.evaluate(() => {
    const tops = Array.from(document.querySelectorAll("#container > *")).map((e: any) => ({ id: e.id, cls: String(e.className).slice(0, 60), vis: e.offsetParent !== null }));
    const search = Array.from(document.querySelectorAll("input[type=text], input:not([type])")).filter((e: any) => e.offsetParent !== null).map((e: any) => ({ id: e.id, cls: String(e.className).slice(0, 60), ph: e.placeholder }));
    return { tops, search };
  });
  res[sheet] = info;
  console.log(`--- ${sheet}: tops=${info.tops.map((t: any) => t.id || t.cls).join(",")}`);
  console.log(`    inputs:`, info.search.map((s: any) => `${s.id}|${s.ph}`).join(";"));
}
writeOut("122-ui-compare", res);
await browser.close();
process.exit(0);
