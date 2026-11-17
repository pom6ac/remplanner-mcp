// 113: разведка шаг 9 — cm-comment DOM, updateComment предмета, label варианты.
import { launch, newAnonProject, buildBase, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const found = await page.evaluate(async () => {
  const urls = (performance.getEntriesByType("resource") as any[]).map((r) => r.name).filter((u) => /\.js(\?|$)/.test(u));
  const out: any = { hits: [] as string[] };
  for (const url of urls) {
    try {
      const txt = await fetch(url).then((r) => r.text());
      for (const pat of [/updateComment\(\)\{/, /label:"(?!free)[a-z_]+"/g, /\.label=/g, /comment_decoration=/g, /setStyle\(/]) {
        const re = new RegExp(pat.source, pat.flags);
        let m: RegExpExecArray | null;
        let n = 0;
        while ((m = re.exec(txt)) !== null && n < 5) {
          out.hits.push("PAT " + pat.source.slice(0, 30) + " :: " + txt.slice(Math.max(0, m.index - 200), m.index + 320));
          n++;
        }
      }
    } catch { /* */ }
  }
  return out;
});
writeOut("113-bundle-comment", found);
for (const h of found.hits) console.log("----\n", h.replace(/\n/g, " ").slice(0, 500));

const cm = await page.evaluate(() => document.querySelector("#cm-comment")?.outerHTML?.slice(0, 5000) ?? null);
writeOut("113-cm-comment", cm);
console.log("cm-comment:", cm);
await browser.close();
process.exit(0);
