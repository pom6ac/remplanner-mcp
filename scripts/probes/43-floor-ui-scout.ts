// 43-fix-pillars, №4: эталон «отделка» из UI — клик по инструменту напольного покрытия,
// клик в комнату, выбор материала в панели; структура room.floors в copy("server").
// На сервер не пишем. Запуск: REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=…
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, toScreen } from "./phase2-lib.ts";

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

// центры комнат для клика
const rooms = await page.evaluate(() => {
  const out: { id: string; pc: { x: number; y: number } }[] = [];
  for (const [id, r] of Object.entries<any>((window as any).ROOMS2 ?? {})) {
    if (r.pc) out.push({ id, pc: { x: r.pc.x, y: r.pc.y } });
  }
  return out;
});
const target = rooms.find((r) => r.id === ROOM_ID) ?? rooms[0]!;
console.log("комнат:", rooms.length, "цель:", JSON.stringify(target));

// список инструментов пола из панели листа rooms (subtools)
const floorTools = await page.evaluate(() => {
  const ids = [...document.querySelectorAll("[id^='plannertool_']")].map((e: any) => e.id);
  return ids.filter((id) => /floor|lining|cover/i.test(id));
});
console.log("инструменты пола на листе:", JSON.stringify(floorTools));

// пробуем клик по группе floor в навигации и по первому инструменту покрытия
const navRes = await page.evaluate(() => {
  const nav: any = [...document.querySelectorAll(".groups_navi_item")].find((e: any) => /floor/i.test(e.className) || /апольн/i.test(e.textContent ?? ""));
  if (!nav) return { nav: null };
  const cls = String(nav.className);
  nav.click();
  return { nav: cls, text: nav.textContent?.trim().slice(0, 40) };
});
console.log("навигация:", JSON.stringify(navRes));
await page.waitForTimeout(800);

const afterNav = await page.evaluate(() => {
  const ids = [...document.querySelectorAll("[id^='plannertool_']")].map((e: any) => e.id);
  const visible = ids.filter((id) => {
    const el: any = document.getElementById(id);
    return el && !!el.offsetParent;
  });
  return { visibleCount: visible.length, floorish: visible.filter((id) => /floor|lining|cover|laminate|tile/i.test(id)) };
});
console.log("после клика по группе:", JSON.stringify(afterNav, null, 1));

await escape(page);
await editor.close();
process.exit(0);
