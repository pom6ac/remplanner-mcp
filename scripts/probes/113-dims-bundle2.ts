// 113: разведка шаг 4e — как кнопка линейки активирует tool="ruler"; serialize Ruler; mm-формат.
import { launch, newAnonProject, buildBase, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const found = await page.evaluate(async () => {
  const urls = (performance.getEntriesByType("resource") as any[]).map((r) => r.name).filter((u) => /\.js(\?|$)/.test(u));
  const out: any = { hits: {} as Record<string, string[]>, rulerSer: null as string | null, commentsSer: null as string | null };
  const patterns = [/rulers["'\]]/g, /set_tool|setTool/g, /"ruler"/g, /footer_bar/g];
  for (const url of urls) {
    try {
      const txt = await fetch(url).then((r) => r.text());
      for (const p of patterns) {
        let m: RegExpExecArray | null;
        p.lastIndex = 0;
        while ((m = p.exec(txt)) !== null) {
          const key = p.source;
          if (!out.hits[key]) out.hits[key] = [];
          const ctx = txt.slice(Math.max(0, m.index - 150), m.index + 250);
          if (out.hits[key].length < 8 && !out.hits[key].some((c: string) => c === ctx)) out.hits[key].push(url.split("/").pop()!.slice(0, 40) + " :: " + ctx);
        }
      }
      if (!out.rulerSer) {
        const i = txt.indexOf("serialize(){");
        if (i > 0) {
          // найти serialize именно Ruler: перед ним id=..., offset
          const k = txt.indexOf('serialize(){var e={id:this.id,');
          if (k > 0) out.rulerSer = txt.slice(k, k + 900);
        }
      }
      const j = txt.indexOf('class Comment{');
      if (j > 0 && !out.commentSrc) out.commentSrc = txt.slice(j, j + 9000);
    } catch { /* */ }
  }
  return out;
});
writeOut("113-bundle-search2", found);
for (const [k, v] of Object.entries(found.hits ?? {})) {
  console.log("==", k);
  for (const c of (v as string[]).slice(0, 8)) console.log("  ", c.replace(/\n/g, " ").slice(0, 220));
}
console.log("rulerSer:", (found as any).rulerSer);
console.log("commentSrc:", (found as any).commentSrc?.slice(0, 6000));
await browser.close();
process.exit(0);
