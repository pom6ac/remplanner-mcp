// 37-doors: отладка — почему клик по стене не ставит проём.
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, toScreen } from "./phase2-lib.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }
const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
const WALL = "8ybhmygz3z";
try {
  const page = editor.page;
  const model = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
  const w = model.walls[WALL];
  console.log("wall:", JSON.stringify({ p1: w.p1, p2: w.p2, depth: w.depth, holes: Object.keys(w.holes ?? {}).length }));
  const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
  const pt = { x: w.p1.x + (w.p2.x - w.p1.x) * 0.5, y: w.p1.y + (w.p2.y - w.p1.y) * 0.5 };
  console.log("click point:", pt);
  const screen = await toScreen(page, pt);
  console.log("screen:", screen);
  await page.screenshot({ path: "screenshots/37-dbg-before.png" });
  // центрирование плана: $Project.focus (как render_plan), чтобы стены не уходили под панели
  await page.evaluate(() => { const p = (window as any).$Project; try { p?.focus?.(); } catch {} });
  await page.waitForTimeout(800);
  await clearFog(page);
  const st = await pickTool(page, "doorway");
  console.log("pickTool:", st);
  const st2 = await page.evaluate(() => {
    const el: any = document.querySelector("#plannertool_doorway");
    return { active: el?.classList.contains("active"), cls: el?.className };
  });
  console.log("tool state:", st2);
  await clickAt(page, pt);
  await page.screenshot({ path: "screenshots/37-dbg-after.png" });
  const after = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
  console.log("holes after:", Object.keys(after.walls[WALL].holes ?? {}).length);
  const fog = await page.evaluate(() => ({
    fog: document.querySelector("#planner_ui_message_fog")?.className,
    msgs: Array.from(document.querySelectorAll(".planner_ui_message.active")).map((e: any) => e.textContent?.slice(0, 120)),
  }));
  console.log("fog:", JSON.stringify(fog));
  await escape(page);
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
