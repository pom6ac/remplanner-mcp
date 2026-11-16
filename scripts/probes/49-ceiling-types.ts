// 49: набор допустимых ceiling_type ригеля — только ЧТЕНИЕ панели «Потолок» (ID из env).
// КЛИКОВ ПО ИНСТРУМЕНТАМ, РИСОВАНИЯ И ЗАПИСИ НЕТ: переключение листа + разбор DOM/defs.
import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { switchSheet } from "./phase2-lib.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(".orca-reports/49-rigels-types", { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "ceiling");
  const out = await page.evaluate(() => {
    const res: Record<string, unknown> = {};
    // все инструменты панели: id, подпись, data-атрибуты, pro
    const tools: Record<string, { text: string; dataTool: string | null; dataParams: string | null; group: string | null; pro: boolean }> = {};
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[id^='plannertool_']"))) {
      const box = (el.closest(".subtools_item") ?? el) as HTMLElement;
      const name = box.querySelector(".subtools_item_name, .tools_item_name, span, b, i");
      tools[el.id] = {
        text: (name?.textContent ?? box.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
        dataTool: box.getAttribute("data-tool"),
        dataParams: box.getAttribute("data-params"),
        group: (el.closest(".tools_item")?.id ?? null),
        pro: el.classList.contains("is_pro") || !!el.closest(".is_pro"),
      };
    }
    res.tools = tools;
    // контекстное меню раскраски ригеля (если есть в DOM)
    const cm = document.querySelector("#cm-rigel--coloring");
    res.cm_rigel_coloring = cm ? (cm.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 500) : null;
    const cmHtml = document.querySelector("#cm-rigel--coloring");
    res.cm_rigel_coloring_html = cmHtml ? cmHtml.outerHTML.slice(0, 3000) : null;
    // defs/global_tools про потолок и ригели
    const d: any = (window as any).defs ?? {};
    const defs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries<any>(d)) if (/rigel|ceil|color/i.test(k)) defs[k] = v;
    res.defs = defs;
    const gt: any = (window as any).global_tools ?? {};
    res.global_tools = Object.fromEntries(Object.entries<any>(gt).filter(([k, v]) => /ceil|rigel|color/i.test(k) || (v && typeof v === "object" && /ceil/i.test(JSON.stringify(v).slice(0, 200)))));
    // активный инструмент/группа и функция select_tool — откуда берётся tool_group
    res.select_tool_src = String((window as any).select_tool ?? "").slice(0, 2000);
    res.plan_now = (window as any).plan ?? null;
    return res;
  });
  writeFileSync(".orca-reports/49-rigels-types/ceiling-tools.json", JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify(out, null, 1).slice(0, 4000));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
