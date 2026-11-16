// 84: источники классов света в бандле — LedStrip, StripLight, LineStrip, PointLight и serialize.
// КЛИКОВ И ЗАПИСИ НЕТ. node scripts/probes/84-light-src.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { launch, newAnonProject } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
const urls: string[] = await page.evaluate(() =>
  Array.from(document.querySelectorAll("script[src]")).map((s: any) => s.src));
console.log("scripts:", urls.length);
mkdirSync(".orca-reports/84-light-ui", { recursive: true });
let i = 0;
for (const u of urls) {
  try {
    const r = await fetch(u);
    const t = await r.text();
    writeFileSync(`.orca-reports/84-light-ui/bundle-${i}.js`, t);
    i++;
  } catch (e) { console.error("fetch fail", u, String(e).slice(0, 80)); }
}
console.log("saved", i, "bundles");
await browser.close();
process.exit(0);
