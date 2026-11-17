// 113: разведка шаг 4d — поиск в бандлах: привязка кнопки линейки, Comment.
import { launch, newAnonProject, buildBase, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const found = await page.evaluate(async () => {
  const urls = (performance.getEntriesByType("resource") as any[])
    .map((r) => r.name).filter((u) => /\.js(\?|$)/.test(u));
  const out: any = { urlsCount: urls.length, hits: {} as Record<string, string> };
  const patterns = [/start_draw_ruler/g, /\.footer_bar_tool\.ruler/g, /RULERS\[/g, /new Ruler/g, /class Comment/g, /Comments?\s*extends/g, /"ruler"/g];
  for (const url of urls) {
    try {
      const txt = await fetch(url).then((r) => r.text());
      const lines = txt.split("\n");
      for (const p of patterns) {
        let m: RegExpExecArray | null;
        p.lastIndex = 0;
        while ((m = p.exec(txt)) !== null) {
          const key = p.source;
          if (!out.hits[key]) out.hits[key] = [];
          if (out.hits[key].length < 4) {
            const pos = m.index;
            out.hits[key].push({ url: url.split("/").pop()?.slice(0, 60), ctx: txt.slice(Math.max(0, pos - 200), pos + 300) });
          }
        }
      }
      if (/class Comment/.test(txt)) {
        const i = txt.search(/class Comment/);
        out.commentSrc = txt.slice(i, i + 3000);
        out.commentUrl = url;
      }
    } catch { /* */ }
  }
  return out;
});
writeOut("113-bundle-search", found);
console.log("hits keys:", Object.keys(found.hits ?? {}));
for (const [k, v] of Object.entries(found.hits ?? {})) {
  console.log("==", k, "=>", (v as any[]).slice(0, 2).map((x) => x.ctx).join("\n---\n").slice(0, 1200));
}
console.log("Comment src:", (found as any).commentSrc?.slice(0, 2500));
await browser.close();
process.exit(0);
