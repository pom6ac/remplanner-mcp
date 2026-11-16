// 25-windows: проба 6 — поиск иконки «глаз» в панели инструментов (весь DOM панели).
import type { Page } from "playwright-core";
import { writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, switchSheet } from "./phase2-lib.ts";

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, "7887657", "1001798", 60_000, { anonymous: false });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const res = await page.evaluate(() => {
    const out: string[] = [];
    // всё, что похоже на глаз: класс/фон/svg
    for (const el of Array.from(document.querySelectorAll("[class*='eye'], [id*='eye']")) as HTMLElement[]) {
      out.push(`cls-match: #${el.id}.${el.className} vis=${!!el.offsetParent}`);
    }
    const fr = document.querySelector("#plannertool_french_window");
    const panel = fr?.closest(".tools_panel, #planner_ui_tools, .tools_group") ?? fr?.parentElement?.parentElement;
    // hover-эффекты: daы все подэлементы пункта
    for (const c of Array.from(fr?.querySelectorAll("*") ?? [])) out.push(`child: ${c.tagName}#${c.id}.${c.className}`);
    return out;
  });
  writeFileSync(".orca-reports/25-windows-ui/eye-search.json", JSON.stringify(res, null, 1) + "\n");
  console.log(res.slice(0, 30).join("\n"));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
