// 113: разведка шаг 3 — рисование размера и комментария через UI, дамп модели.
import { launch, newAnonProject, buildBase, copyServer, writeOut, dragAt, clickAt, clearFog, escape, toScreen } from "./phase2-lib.ts";
import { writeFileSync } from "node:fs";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

// 1) найти кнопку «Добавить размер» в нижней панели (по DOM)
const panel = await page.evaluate(() => {
  const out: any[] = [];
  for (const e of Array.from(document.querySelectorAll("*"))) {
    const t = (e as any).title || (e as any).getAttribute?.("data-title") || "";
    if (typeof t === "string" && /размер|коммент/i.test(t) && !e.querySelector("[title]")) {
      out.push({ tag: e.tagName, id: e.id, cls: Array.from((e as any).classList).join(" "), title: t,
        parent: (e.parentElement?.id || e.parentElement?.className || "").toString().slice(0, 80) });
    }
  }
  return out;
});
writeOut("113-panel-buttons", panel);
console.log("panel buttons:", JSON.stringify(panel, null, 1));

// клик по кнопке размера
const clicked = await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll("[title*='размер' i], [data-title*='размер' i]"))
    .find((e: any) => !e.querySelector("[title]")) as any;
  if (!el) return false;
  el.click();
  return true;
});
console.log("ruler tool clicked:", clicked);
await clearFog(page);

// протяжка по пустому месту внутри комнаты
await dragAt(page, { x: 100, y: -150 }, { x: 500, y: -150 });
await escape(page);

const afterRuler = await copyServer(page);
writeOut("113-after-ruler-ui", afterRuler.rulers);
console.log("rulers after UI drag:", JSON.stringify(afterRuler.rulers, null, 1).slice(0, 2500));

// 2) комментарий: кнопка
const clickedC = await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll("[title*='коммент' i], [data-title*='коммент' i]"))
    .find((e: any) => !e.querySelector("[title]") && !/bug|chat/i.test(e.id)) as any;
  if (!el) return false;
  el.click();
  return true;
});
console.log("comment tool clicked:", clickedC);
await clearFog(page);
await clickAt(page, { x: 200, y: -60 });
// печатаем текст
await page.keyboard.type("Проба 113 комментарий");
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
await escape(page);
const afterComment = await copyServer(page);
writeOut("113-after-comment-ui", afterComment.comments);
console.log("comments after UI:", JSON.stringify(afterComment.comments, null, 1).slice(0, 2500));

// 3) полные классы: Ruler.serialize/checkTarget/update и Comment
const src = await page.evaluate(() => {
  const w: any = window as any;
  const pick = (obj: any, names: string[]) => {
    const o: Record<string, string> = {};
    for (const n of names) { try { o[n] = String(obj[n]).slice(0, 3000); } catch { /* */ } }
    return o;
  };
  const out: any = {};
  try { out.Ruler = pick((window as any).Ruler.prototype, ["serialize", "checkTarget", "update", "update_linked_ruler", "checkLinkedRulers", "is_allow_plan", "split"]); } catch { /* */ }
  try { out.Comment_ctor = String((window as any).Comment).slice(0, 4000); } catch { /* */ }
  // ищем класс Comment в скоупе страницы через COMMENTS (карта инстансов)
  out.COMMENTS_keys = Object.keys(w.COMMENTS ?? {});
  out.RULERS_keys = Object.keys(w.RULERS ?? {});
  return out;
});
writeOut("113-ruler-src", src);
console.log("Ruler.serialize:", src.Ruler?.serialize?.slice(0, 1200));
console.log("Comment ctor:", String(src.Comment_ctor).slice(0, 1200));

await browser.close();
process.exit(0);
