// 37-doors: отладка 4 — door_garage/x4 (не добавился) и remote (что ставят) — полный диф модели.
import type { Page } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, toScreen, dragAt, diffModels } from "./phase2-lib.ts";

const KEYS = (process.argv[2] ?? "door_garage,door_system_x4,door_remote,door_videoremote").split(",");
const OUT = ".orca-reports/37-doors-ui";
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }
const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
const copyS = (p: Page) => p.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
const visible = (s: { x: number; y: number }) => s.x > 250 && s.x < 1350 && s.y > 150 && s.y < 850;
try {
  const page = editor.page;
  await switchSheet(page, "init");
  for (const key of KEYS) {
    const res: Record<string, unknown> = { key };
    const cur = await copyS(page);
    // zrslo37ysb len 454, свободно ~343; garage 300
    const wall = cur.walls["zrslo37ysb"];
    const len = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
    // центр свободного диапазона: справа от всех проёмов
    let cursor = wall.depth / 2 + 5;
    for (const h of Object.values<any>(wall.holes ?? {})) {
      const t = ((h.pc.x - wall.p1.x) * (wall.p2.x - wall.p1.x) + (h.pc.y - wall.p1.y) * (wall.p2.y - wall.p1.y)) / (len * len);
      cursor = Math.max(cursor, t * len + h.width / 2 + 5);
    }
    let pt = null as null | { x: number; y: number };
    for (const dt of [0, -20, 20, -40, 40]) {
      const t = Math.max(0.03, Math.min(0.97, (cursor + 150 + dt) / len));
      const cand = { x: wall.p1.x + (wall.p2.x - wall.p1.x) * t, y: wall.p1.y + (wall.p2.y - wall.p1.y) * t };
      let s = await toScreen(page, cand);
      if (!visible(s)) {
        await dragAt(page, { x: 800, y: 480 }, { x: 800 - (s.x - 800), y: 480 - (s.y - 500) });
        await clearFog(page);
        s = await toScreen(page, cand);
      }
      if (visible(s)) { pt = cand; break; }
    }
    if (!pt) { console.log(key, "нет точки"); continue; }
    const before = await copyS(page);
    const st = await pickTool(page, key);
    await clickAt(page, pt);
    await clearFog(page);
    const after = await copyS(page);
    res.diff = diffModels(before, after);
    res.msgs = await page.evaluate(() => ({
      active: Array.from(document.querySelectorAll(".planner_ui_message.active")).map((e: any) => e.textContent?.trim().slice(0, 300)),
      menus: Array.from(document.querySelectorAll(".contextmenu")).filter((m: any) => m.offsetParent).map((m: any) => m.textContent?.trim().slice(0, 300)),
    }));
    await page.screenshot({ path: `screenshots/37-dbg4-${key}.png` });
    await escape(page).catch(() => {});
    writeFileSync(`${OUT}/dbg4-${key}.json`, JSON.stringify(res, null, 1) + "\n");
    const d = res.diff as any;
    console.log(key, "walls+", Object.keys(d.walls?.added ?? {}).length ? "holes:" + JSON.stringify(Object.entries(d.walls.added).flatMap(([, w]: any) => Object.keys(w.holes ?? {}))) : "0", "items+", Object.keys(d.items?.added ?? {}).length, JSON.stringify(res.msgs).slice(0, 200));
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
