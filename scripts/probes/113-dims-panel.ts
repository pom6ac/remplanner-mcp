// 113: разведка шаг 3b — DOM нижней панели, поиск кнопок размера и комментария.
import { launch, newAnonProject, buildBase, writeOut, clearFog, dragAt, clickAt, escape, copyServer } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

const dump = await page.evaluate(() => {
  const out: any = {};
  // все svg/div в нижней части страницы
  const panels = Array.from(document.querySelectorAll("div,nav,ul")).filter((e: any) => {
    const r = e.getBoundingClientRect();
    return r.top > window.innerHeight - 120 && r.width > 100;
  });
  out.bottomHtml = panels.slice(0, 6).map((e: any) => e.outerHTML.slice(0, 4000));
  // ищем элементы с id/классами ruler/comment
  out.candidates = Array.from(document.querySelectorAll('[id*="ruler" i], [class*="ruler" i], [id*="comment" i], [class*="comment" i], [id*="dimens" i]'))
    .slice(0, 40).map((e: any) => ({ tag: e.tagName, id: e.id, cls: Array.from(e.classList).join(" "), title: e.title || e.getAttribute("data-title"), parent: e.parentElement?.id || "" }));
  return out;
});
writeOut("113-panel-dom", dump);
console.log("ids:", JSON.stringify(dump.ids ?? null));
console.log("ruler/comment elems:", JSON.stringify(dump.rulerCommentElems ?? null, null, 1).slice(0, 3000));
console.log("bottomHtml sample:", (dump.bottomHtml?.[0] ?? "").slice(0, 3000));

await browser.close();
process.exit(0);
