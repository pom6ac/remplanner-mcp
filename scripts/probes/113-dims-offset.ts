// 113: разведка шаг 8 — cm-ruler меню (offset/side), updateComment предмета, лимиты ширины размера.
import { launch, newAnonProject, buildBase, writeOut, toScreen } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const found = await page.evaluate(async () => {
  const urls = (performance.getEntriesByType("resource") as any[]).map((r) => r.name).filter((u) => /\.js(\?|$)/.test(u));
  const out: any = { hits: [] as string[] };
  for (const url of urls) {
    try {
      const txt = await fetch(url).then((r) => r.text());
      for (const pat of [/offset\.side/g, /offset\.val/g, /updateComment\(\)\{[\s\S]{0,600}/, /cm-ruler--width/g, /ruler_offset/g]) {
        const re = new RegExp(pat.source, "g");
        let m: RegExpExecArray | null;
        let n = 0;
        while ((m = re.exec(txt)) !== null && n < 4) {
          out.hits.push("PAT " + pat.source.slice(0, 24) + " :: " + txt.slice(Math.max(0, m.index - 180), m.index + 260));
          n++;
        }
      }
    } catch { /* */ }
  }
  return out;
});
writeOut("113-bundle-offset", found);
for (const h of found.hits) console.log("----\n", h.replace(/\n/g, " ").slice(0, 480));

// DOM контекстного меню размера
const cm = await page.evaluate(() => {
  const el: any = document.querySelector("#cm-ruler");
  return el ? el.outerHTML.slice(0, 4000) : null;
});
console.log("cm-ruler html:", cmHtml(cm));
function cmHtml(s: string | null) { return s; }
writeOut("113-cm-ruler", cm);
await browser.close();
process.exit(0);
