// 43-fix-pillars, №4: точный заход в группу «Напольные покрытия» (plan_floor), дамп
// подинструментов и структуры после клика. На сервер не пишем.
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { escape, switchSheet } from "./phase2-lib.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID");
  process.exit(1);
}

const session = loadSession(STATE_PATH);
const editor = await openEditor(session, OBJECT_ID, PLAN_ID);
const page = (editor as unknown as { page: Page }).page;
await page.addStyleTag({ content: "#planner_ui_message_fog:empty{display:none !important}" });
await switchSheet(page, "rooms");
await escape(page);

const res = await page.evaluate(() => {
  const w: any = window as any;
  const nav: any = document.querySelector(".groups_navi_item.plan_floor");
  if (!nav) {
    const all = [...document.querySelectorAll(".groups_navi_item")].map((e: any) => ({ cls: e.className, text: e.textContent?.trim() }));
    return { err: "нет plan_floor", all: all.map((x) => x.cls) };
  }
  nav.click();
  return { clicked: nav.textContent?.trim() };
});
console.log("нав:", JSON.stringify(res));
await page.waitForTimeout(1000);

const tools = await page.evaluate(() => {
  const vis = [...document.querySelectorAll("[id^='plannertool_']") as HTMLElement[]].filter((e) => e.offsetParent);
  return vis.map((e) => ({ id: e.id, pro: e.classList.contains("is_pro") || !!e.closest(".is_pro"), text: e.textContent?.trim().slice(0, 40) }));
});
console.log("видимые инструменты:", JSON.stringify(tools, null, 1));
await escape(page);
await editor.close();
process.exit(0);
