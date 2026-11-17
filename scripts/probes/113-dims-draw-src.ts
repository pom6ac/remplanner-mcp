// 113: вырезка исходника Ruler.draw вокруг точки падения.
import { launch, newAnonProject, buildBase, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
const res = await page.evaluate(async () => {
  const urls = (performance.getEntriesByType("resource") as any[]).map((r) => r.name).filter((u) => /app\.3\.0/.test(u));
  const out: any = {};
  for (const url of urls) {
    const txt = await fetch(url).then((r) => r.text());
    const i = txt.indexOf("getParentProjection()");
    if (i > 0) out.getParentProjection = txt.slice(i, i + 2200);
    const j = txt.indexOf("checkParentProjection()");
    if (j > 0) out.checkParentProjection = txt.slice(j, j + 2200);
  }
  return out;
});
writeOut("113-ruler-draw-src", res);
console.log("getParentProjection:", res.getParentProjection?.slice(0, 2000));
console.log("\ncheckParentProjection:", res.checkParentProjection?.slice(0, 2000));
await browser.close();
process.exit(0);
