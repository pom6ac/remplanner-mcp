// 43-fix-pillars, №4: эталон отделки — plannertool_zone_floor → клик в комнату → панель
// материала → copy("server"). На сервер не пишем (project.save не вызываем).
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

const target = await page.evaluate((roomId) => {
  const map: Record<string, { x: number; y: number }> = {};
  for (const [id, r] of Object.entries<any>((window as any).ROOMS2 ?? {})) if (r.pc) map[id] = { x: r.pc.x, y: r.pc.y };
  return { id: roomId || Object.keys(map)[0], pc: map[roomId || Object.keys(map)[0]] };
}, ROOM_ID);
console.log("цель:", JSON.stringify(target));

const pick = await pickTool(page, "zone_floor");
console.log("pickTool zone_floor:", pick);

const st = await toScreen(page, target.pc);
await clickAt(page, target.pc, "left");
await page.waitForTimeout(1200);

const panel = await page.evaluate(() => {
  const out: Record<string, unknown>[] = [];
  for (const el of Array.from(document.querySelectorAll("[id^='cm-'], .panel_item, [class*='material']")) as HTMLElement[]) {
    if (!el.offsetParent) continue;
    out.push({ id: el.id, cls: String(el.className).slice(0, 60), text: el.textContent?.trim().slice(0, 60) });
  }
  return out.slice(0, 30);
});
console.log("панель после клика:", JSON.stringify(panel, null, 1).slice(0, 2500));

// выбрать первый материал в панели «Строительные материалы»
const mat = await page.evaluate(() => {
  const panel: any = document.querySelector(".planner_ui_function.materials");
  if (!panel) return { err: "нет панели материалов" };
  const container = panel.parentElement ?? panel;
  const imgs = [...container.querySelectorAll("img")].filter((e: any) => e.offsetParent);
  const clickable = [...container.querySelectorAll("[class*='material'], [class*='catalog'], li, a, button")].filter((e: any) => e.offsetParent);
  if (imgs.length > 0) { imgs[0].click(); return { clickedImg: imgs[0].src?.slice(-50), total: imgs.length }; }
  if (clickable.length > 0) { clickable[0].click(); return { clickedEl: String(clickable[0].className).slice(0, 60), text: clickable[0].textContent?.trim().slice(0, 40), total: clickable.length }; }
  return { err: "не нашли кликабельное", html: container.innerHTML.slice(0, 1500) };
});
console.log("материал:", JSON.stringify(mat));
await page.waitForTimeout(1500);

const copy = await page.evaluate(() => {
  const m: any = (window as any).project.copy("server");
  const out: Record<string, unknown> = {};
  for (const [id, r] of Object.entries<any>(m.rooms2 ?? {})) {
    out[id] = { name: r.name, floors: (r.floors ?? []).map((f: any) => ({ ...f, polygon: undefined })), floorsKeys: (r.floors ?? []).map((f: any) => Object.keys(f)) };
  }
  return out;
});
console.log("rooms2.floors:", JSON.stringify(copy, null, 1).slice(0, 2500));
await escape(page);
await editor.close();
process.exit(0);
