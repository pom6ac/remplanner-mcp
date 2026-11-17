// 113: разведка шаг 7c — бандл: target_name варианты, Comment.serialize (font_size/framed).
import { launch, newAnonProject, buildBase, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const found = await page.evaluate(async () => {
  const urls = (performance.getEntriesByType("resource") as any[]).map((r) => r.name).filter((u) => /\.js(\?|$)/.test(u));
  const out: any = { targetNames: [] as string[], commentSer: null as string | null, targetTemp: [] as string[] };
  for (const url of urls) {
    try {
      const txt = await fetch(url).then((r) => r.text());
      const re = /target_name[":=\s]*"([a-z_]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt)) !== null) if (!out.targetNames.includes(m[1])) out.targetNames.push(m[1]);
      const re2 = /target_name:/g;
      while ((m = re2.exec(txt)) !== null) out.targetNames.push("CTX2: " + txt.slice(Math.max(0, m.index - 150), m.index + 200));
      // target_temp присвоения
      const re3 = /target_temp\s*=/g;
      let n = 0;
      while ((m = re3.exec(txt)) !== null) {
        out.targetNames.push("CTX: " + txt.slice(Math.max(0, m.index - 200), m.index + 250));
        if (++n > 5) break;
      }
      // Comment.serialize — ищем по font_size
      const i = txt.indexOf("font_size:this.font_size");
      if (i > 0) {
        const s = txt.lastIndexOf("serialize()", i);
        if (s > 0 && i - s < 400) out.commentSer = txt.slice(s, i + 800);
        out.commentSerCtx = txt.slice(i - 300, i + 600);
      }
      // save/restore формат комментариев из project.copy
      const k = txt.indexOf('Comments extends Storage');
      if (k > 0) out.commentsClass = txt.slice(k, k + 6000);
      const r = txt.indexOf("class Rulers extends Storage");
      if (r > 0) out.rulersClass = txt.slice(r, r + 5000);
    } catch { /* */ }
  }
  return out;
});
writeOut("113-bundle-target2", found);
console.log("targetNames:", JSON.stringify(found.targetNames, null, 1).slice(0, 3000));
console.log("commentSer:", found.commentSer ?? found.commentSerCtx);
console.log("commentsClass:", String(found.commentsClass).slice(0, 4000));
await browser.close();
process.exit(0);
