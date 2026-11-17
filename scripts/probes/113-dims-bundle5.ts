// 113: разведка шаг 7d — все контексты p1_target/p2_target (пересчёт при переносе предмета/стены).
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
      const re = /p[12]_target/g;
      let m: RegExpExecArray | null;
      let n = 0;
      while ((m = re.exec(txt)) !== null) {
        n++;
        const ctx = txt.slice(Math.max(0, m.index - 160), m.index + 200);
        if (!out.hits.some((h: string) => h.includes(ctx.slice(60, 140)))) out.hits.push(ctx);
      }
      out.total = n;
    } catch { /* */ }
  }
  return out;
});
writeOut("113-bundle-target3", found);
for (const h of found.hits) console.log("----\n", h.replace(/\n/g, " "));
await browser.close();
process.exit(0);
