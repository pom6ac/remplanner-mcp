// 57-communications: после клика по «Коммуникации» — контейнеры, где живут subitems. КЛИКОВ ИНСТРУМЕНТОВ НЕТ.
// node scripts/probes/57-comm-dom2.ts (ID из env)
import { writeFileSync } from "node:fs";
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
try {
  const page = editor.page;
  await switchSheet(page, "init");
  await page.evaluate(() => {
    const root = Array.from(document.querySelectorAll<HTMLElement>(".tools_item"))
      .find((el) => el.classList.contains("santeh_node"));
    if (!root) throw new Error("нет корня santeh_node");
    (root.querySelector(".tools_item_name, [data-target]") ?? root).click();
  });
  await page.waitForTimeout(1500);
  const dom = await page.evaluate(() => {
    // найти элемент с текстом «Вывод холодной воды»
    const hits: Record<string, unknown>[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode.textContent ?? "";
      if (t.includes("Вывод холодной воды")) {
        const el = walker.currentNode.parentElement!;
        const chain: { tag: string; id: string; cls: string }[] = [];
        let cur: HTMLElement | null = el;
        for (let i = 0; cur && i < 10; i++, cur = cur.parentElement) {
          chain.push({ tag: cur.tagName.toLowerCase(), id: cur.id, cls: cur.className.replace(/\s+/g, " ").trim().slice(0, 120) });
        }
        hits.push({ text: t.replace(/\s+/g, " ").trim().slice(0, 80), chain, outer: el.outerHTML.slice(0, 400) });
        if (hits.length >= 4) break;
      }
    }
    // сколько plannertool_ элементов видно сейчас
    const vis = Array.from(document.querySelectorAll<HTMLElement>("[id^='plannertool_']"))
      .filter((e) => e.offsetParent !== null).map((e) => e.id.replace(/^plannertool_/, ""));
    return { hits, visibleCount: vis.length, visibleSample: vis.slice(0, 80) };
  });
  console.log(JSON.stringify(dom, null, 1));
  writeFileSync("../../.orca-reports/57-comm-ui/dom2.json", JSON.stringify(dom, null, 1) + "\n");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
