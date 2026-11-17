// 113: разведка шаг 10 — судьба привязок при удалении предмета (unsetComment, rulers при delete).
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
      for (const pat of [/unsetComment\(e?\)?\{/, /deleteComment[s]?\(/, /COMMENTS\[.*\]\.delete\(\)/, /target_id===e\./, /p1_target=void 0/g]) {
        const re = new RegExp(pat.source, pat.flags);
        let m: RegExpExecArray | null;
        let n = 0;
        while ((m = re.exec(txt)) !== null && n < 4) {
          out.hits.push("PAT " + pat.source.slice(0, 28) + " :: " + txt.slice(Math.max(0, m.index - 250), m.index + 350));
          n++;
        }
      }
    } catch { /* */ }
  }
  return out;
});
writeOut("113-bundle-del", found);
for (const h of found.hits) console.log("----\n", h.replace(/\n/g, " ").slice(0, 600));
await browser.close();
process.exit(0);
