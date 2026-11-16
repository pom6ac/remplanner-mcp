// 43-fix-pillars, №4: покрытие пола полигоном — zone_floor: 4 клика + Enter, дамп floors.
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet } from "./phase2-lib.ts";

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

const info = await page.evaluate((roomId) => {
  const r: any = (window as any).ROOMS2[roomId || Object.keys((window as any).ROOMS2)[0]];
  const poly = (r?.zones?.[0]?.polygon ?? []).map((p: any) => ({ x: p.x, y: p.y }));
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  // прямоугольник внутри комнаты с отступом 30 см
  return {
    rect: [
      { x: minX + 30, y: minY + 30 },
      { x: maxX - 30, y: minY + 30 },
      { x: maxX - 30, y: maxY - 30 },
      { x: minX + 30, y: maxY - 30 },
    ],
    before: { name: r?.name, floors: r?.floors },
  };
}, ROOM_ID);
console.log("прямоугольник:", JSON.stringify(info.rect));

console.log("pickTool:", await pickTool(page, "zone_floor"));
for (const p of info.rect) {
  await clickAt(page, p, "left");
  await page.waitForTimeout(400);
}
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);

const after = await page.evaluate((roomId) => {
  const m: any = (window as any).project.copy("server");
  const id = roomId || Object.keys(m.rooms2 ?? {})[0];
  const r = m.rooms2[id];
  return { id, name: r?.name, floors: (r?.floors ?? []).map((f: any) => ({ ...f, polygon: undefined })), keys: (r?.floors ?? []).map((f: any) => Object.keys(f)) };
}, ROOM_ID);
console.log("после:", JSON.stringify(after, null, 1));
await escape(page);
await editor.close();
process.exit(0);
