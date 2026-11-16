// 71-balcony: разведка меню «Нарисовать балкон» — ключи инструментов, defs, DOM, глобалы.
// Анонимный проект, клики только локально: save не вызывается. Без env — анонимный проект создаётся сам.
import { mkdirSync, writeFileSync } from "node:fs";
import { newAnonProject, clearFog, switchSheet } from "./phase2-lib.ts";
import type { Browser } from "playwright-core";
import { launch } from "./phase2-lib.ts";

const OUT = ".orca-reports/71-balcony-ui";
mkdirSync(OUT, { recursive: true });
const browser: Browser = await launch();
try {
  const page = await newAnonProject(browser);
  await switchSheet(page, "init");
  const scout = await page.evaluate(() => {
    const out: Record<string, unknown> = {};
    // инструменты панели, связанные с балконом
    const tools: Record<string, { id: string; text: string; parent: string | null; pro: boolean }> = {};
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[id^='plannertool_']"))) {
      const id = el.id;
      if (!/balcon/i.test(id)) continue;
      const box = (el.closest(".subtools_item") ?? el) as HTMLElement;
      const name = box.querySelector(".subtools_item_name, .tools_item_name, span, b, i");
      tools[id] = {
        id,
        text: (name?.textContent ?? box.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
        parent: el.closest(".tools_item")?.id ?? null,
        pro: el.classList.contains("is_pro") || !!el.closest(".is_pro"),
      };
    }
    out.tools = tools;
    // все инструменты группы walls (по тексту «Балкон» тоже)
    const byText: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[id^='plannertool_']"))) {
      const t = (el.textContent ?? "").trim();
      if (/балкон/i.test(t)) byText.push(`${el.id} :: ${t.slice(0, 60)}`);
    }
    out.byText = byText;
    // defs, связанные с балконом/стеной
    const d: any = (window as any).defs ?? {};
    const defs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries<any>(d)) {
      if (/balcon|wall|fence/i.test(k)) defs[k] = v;
    }
    out.defs = defs;
    out.defs_keys = Object.keys(d);
    out.globals = Object.keys(window as any).filter((k) => /balcon/i.test(k));
    // l10n с балконом
    const l10n: Record<string, string> = {};
    const L: any = (window as any).l10n ?? {};
    for (const [k, v] of Object.entries<any>(L)) {
      if (/балкон/i.test(String(v)) || /balcon/i.test(k)) l10n[k] = String(v).slice(0, 120);
    }
    out.l10n = l10n;
    return out;
  });
  writeFileSync(`${OUT}/scout.json`, JSON.stringify(scout, null, 1) + "\n");
  console.log(JSON.stringify(scout, null, 1).slice(0, 6000));
} finally {
  await browser.close();
}
