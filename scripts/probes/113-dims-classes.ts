// 113: разведка шаг 2 — классы Ruler/Comment/Dimension, формат serialize, коллекции RULERS/COMMENTS.
import { launch, newAnonProject, buildBase, writeOut } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const info = await page.evaluate(() => {
  const w: any = window as any;
  const out: Record<string, any> = {};
  for (const name of ["Ruler", "Comment", "Dimension"]) {
    const C: any = (w as any)[name] ?? (eval(name) as any);
    if (typeof C !== "function") { out[name] = "missing"; continue; }
    out[name] = {
      statics: Object.keys(C),
      proto: Object.getOwnPropertyNames(C.prototype),
      ctor: String(C).slice(0, 1500),
    };
  }
  out.RULERS = w.RULERS ?? null;
  out.COMMENTS = w.COMMENTS ?? null;
  out.project_rulers = Object.keys(w.project?.rulers ?? {});
  out.project_comments = Object.keys(w.project?.comments ?? {});
  // методы рисования
  out.start_draw_ruler = String(w.start_draw_ruler).slice(0, 800);
  return out;
});
writeOut("113-classes", info);
console.log(JSON.stringify(info, null, 1).slice(0, 6000));
await browser.close();
process.exit(0);
