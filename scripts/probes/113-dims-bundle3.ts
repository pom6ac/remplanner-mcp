// 113: разведка шаг 7b — бандл: p1_target/p2_target присвоения, checkTarget, Comment.serialize.
import { launch, newAnonProject, buildBase, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const found = await page.evaluate(async () => {
  const urls = (performance.getEntriesByType("resource") as any[]).map((r) => r.name).filter((u) => /\.js(\?|$)/.test(u));
  const out: any = { hits: [] as any[], commentSer: null as string | null, commentSerSrc: null as string | null };
  for (const url of urls) {
    try {
      const txt = await fetch(url).then((r) => r.text());
      // p1_target присвоения
      const re = /p1_target\s*=/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt)) !== null) {
        out.hits.push(txt.slice(Math.max(0, m.index - 300), m.index + 350));
        if (out.hits.length > 6) break;
      }
      // Comment serialize: ищем serialize(){ ... points ... text
      let i = 0;
      while (true) {
        i = txt.indexOf("serialize()", i);
        if (i < 0) break;
        const frag = txt.slice(i, i + 700);
        if (/text/.test(frag) && /points|pc/.test(frag)) { out.commentSerSrc = txt.slice(i, i + 2200); break; }
        i += 11;
      }
    } catch { /* */ }
  }
  return out;
});
writeOut("113-bundle-target", found);
for (const h of found.hits) console.log("----\n", h.replace(/\n/g, " ").slice(0, 600));
console.log("commentSerSrc:", found.commentSerSrc);
await browser.close();
process.exit(0);
