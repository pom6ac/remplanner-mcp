// 113: разведка раздела «Размеры и комментарии» — шаг 1: элементы UI и модель.
// Анонимный проект. Запуск: node scripts/probes/113-dims-scout.ts [--headed]
import { launch, newAnonProject, buildBase, writeOut, clearFog } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

// 1) нижняя панель: кнопки размеров/комментариев
const bottom = await page.evaluate(() =>
  Array.from(document.querySelectorAll("div,button,span")).filter((e: any) => {
    const t = (e.title || e.getAttribute("data-title") || "").toString();
    return /размер|замер|коммент/i.test(t) && e.children.length < 6;
  }).slice(0, 30).map((e: any) => ({
    tag: e.tagName,
    cls: Array.from(e.classList).join(" "),
    id: e.id,
    title: e.title || e.getAttribute("data-title"),
    html: e.outerHTML.slice(0, 200),
  })));
writeOut("113-bottom-panel", bottom);
console.log("bottom:", JSON.stringify(bottom.slice(0, 6), null, 1).slice(0, 2000));

// 2) все инструменты на всех листах с id plannertool_*, фильтр по размеру/комментарию
const toolIds = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[id^="plannertool_"]')).map((e: any) => e.id));
writeOut("113-all-tools", toolIds);
console.log("tools:", toolIds.join(","));

// 3) глобальные defs, связанные с rulers/comments
const defs = await page.evaluate(() => {
  const w: any = window as any;
  const out: Record<string, any> = {};
  for (const k of Object.keys(w.defs ?? {})) {
    if (/ruler|comment|dim|size|text|font/i.test(k)) out[k] = w.defs[k];
  }
  out._rulerTool = w.defs?.ruler ?? null;
  out._commentTool = w.defs?.comment ?? null;
  // классы редактора
  const classes: string[] = [];
  try { classes.push("Ruler=" + typeof Ruler); } catch { /* */ }
  try { classes.push("Comment=" + typeof Comment); } catch { /* */ }
  try { classes.push("Dimension=" + typeof Dimension); } catch { /* */ }
  out._classes = classes;
  out._globals = Object.keys(w).filter((k) => /ruler|comment/i.test(k));
  return out;
});
writeOut("113-defs", defs);
console.log("defs:", JSON.stringify(defs, null, 1).slice(0, 2500));

// 4) ключи глобальных инструментов (global_tools) с group ruler/comment
const gt = await page.evaluate(() => {
  const w: any = window as any;
  const gt = w.global_tools ?? w.tools ?? {};
  return Object.entries(gt).filter(([, t]: any) => /ruler|comment/i.test(t?.group ?? "") || /ruler|comment/i.test(t?.id ?? ""))
    .map(([k, t]: any) => ({ key: k, title: t.title, group: t.group, plan: t.plan, pro: t.pro ?? null }));
});
writeOut("113-global-tools", gt);
console.log("gt:", JSON.stringify(gt).slice(0, 1500));

await browser.close();
process.exit(0);
