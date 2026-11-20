// 25-windows: проба 6 — поиск иконки «глаз» в панели инструментов (весь DOM панели).
import type { Page } from "playwright-core";
import { writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, switchSheet } from "./phase2-lib.ts";
import { refuseLegacyProbe } from "./probe-guard.ts";
refuseLegacyProbe(); // 322 N3г: старая пишущая проба без гардов — запуск запрещён

// Проект для пробы задаётся env: проба открывает указанный проект, а 25-live-check
// ещё и сохраняет в него (project_save). Без env — отказ (ревью 26, №5).
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID: проба открывает (25-live-check — и сохраняет в) указанный проект.");
  process.exit(1);
}

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
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
