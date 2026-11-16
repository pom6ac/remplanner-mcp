// 43-fix-pillars, №4: контекстное меню комнаты — где «отделка». Правый клик по центру
// комнаты на листе rooms, дамп меню. На сервер не пишем.
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { clickAt, escape, switchSheet } from "./phase2-lib.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
const ROOM_ID = process.env.REMPLANNER_PROBE_ROOM_ID ?? "";
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

const target = await page.evaluate((roomId) => {
  const map: Record<string, { x: number; y: number }> = {};
  for (const [id, r] of Object.entries<any>((window as any).ROOMS2 ?? {})) if (r.pc) map[id] = { x: r.pc.x, y: r.pc.y };
  const id = roomId || Object.keys(map)[0];
  return { id, pc: map[id] };
}, ROOM_ID);
console.log("цель:", JSON.stringify(target));

await clickAt(page, target.pc, "right");
await page.waitForTimeout(1200);
const menu = await page.evaluate(() => {
  const out: Record<string, unknown>[] = [];
  for (const el of Array.from(document.querySelectorAll("[id^='cm-'], .planner_ui_context_menu *, .context_menu *")) as HTMLElement[]) {
    if (!el.offsetParent) continue;
    if (el.children.length > 0) continue;
    out.push({ id: el.id, cls: String(el.className).slice(0, 50), text: el.textContent?.trim().slice(0, 60) });
  }
  return out.slice(0, 40);
});
console.log("контекстное меню комнаты:", JSON.stringify(menu, null, 1));
await escape(page);
await editor.close();
process.exit(0);
