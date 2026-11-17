// 113: полный исходник класса Ruler.
import { launch, newAnonProject, buildBase, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
const res = await page.evaluate(async () => {
  const urls = (performance.getEntriesByType("resource") as any[]).map((r) => r.name).filter((u) => /app\.3\.0/.test(u));
  for (const url of urls) {
    const txt = await fetch(url).then((r) => r.text());
    const i = txt.indexOf("class Ruler{");
    if (i > 0) {
      const end = txt.indexOf("class Rulers extends Storage", i);
      return { src: txt.slice(i, end > 0 ? end : i + 30000) };
    }
  }
  return { src: null };
});
writeOut("113-ruler-src-full", res.src ?? "");
const src = res.src ?? "";
// вырезка draw и getParentProjection
const di = src.indexOf("draw(o=!1){");
console.log("Ruler.draw:", src.slice(di, di + 3500));
const gi = src.indexOf("getParentProjection(");
console.log("\nRuler.getParentProjection:", src.slice(gi, gi + 1600));
await browser.close();
process.exit(0);
