// 25-windows: эталонный прогон — для каждого из 7 типов: постановка кликом, скриншот плана,
// скриншот панели свойств (выделение) и контекстного меню (правый клик). Без save.
import type { Page } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet } from "./phase2-lib.ts";

const copyS = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
const OUT = ".orca-reports/25-windows-ui";
const SHOTS = "screenshots";
const DEF_W: Record<string, number> = { windowway: 120, window: 120, window_balcony: 180, window_door: 80, french_window: 120, french_window_coupe: 120, french_window_double: 180 };
const TYPES = ["windowway", "window", "window_balcony", "window_door", "french_window", "french_window_coupe", "french_window_double"];

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, "7887657", "1001798", 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  let before = await copyS(page);
  const WALLS = ["mum46g7h3k", "7kmwa9hpxx", "e83g72t0rs", "3d23j4gk9h"];
  for (const key of TYPES) {
    // свободная позиция на первой подходящей стене
    let wallKey: string | null = null, pt: { x: number; y: number } | null = null;
    const reserve = DEF_W[key] + 15;
    for (const wk of WALLS) {
      const w0 = before.walls[wk];
      const ax = { x: w0.p2.x - w0.p1.x, y: w0.p2.y - w0.p1.y };
      const ln = Math.hypot(ax.x, ax.y);
      let cur = w0.depth / 2 + 5;
      for (const h of Object.values<any>(w0.holes ?? {})) {
        const t = ((h.pc.x - w0.p1.x) * ax.x + (h.pc.y - w0.p1.y) * ax.y) / (ln * ln);
        cur = Math.max(cur, t * ln + h.width / 2 + 5);
      }
      if (cur + reserve <= ln - w0.depth / 2) {
        wallKey = wk;
        const center = cur + reserve / 2;
        pt = { x: w0.p1.x + (center / ln) * ax.x, y: w0.p1.y + (center / ln) * ax.y };
        break;
      }
    }
    if (!wallKey || !pt) throw new Error("нет места для " + key);
    const st = await pickTool(page, key);
    if (st !== "ok") throw new Error(`${key}: pickTool ${st}`);
    await clickAt(page, pt);
    await clearFog(page);
    const after = await copyS(page);
    const w2 = after.walls[wallKey];
    const hid = Object.keys(w2.holes ?? {}).find((k) => !(k in (before.walls[wallKey].holes ?? {})));
    if (!hid) throw new Error(`${key}: не добавился`);
    const hole = w2.holes[hid];
    before = after;
    await page.screenshot({ path: `${SHOTS}/25-win-${key}-plan.png` });
    // панель свойств
    await clickAt(page, hole.pc);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/25-win-${key}-panel.png` });
    await escape(page);
    // контекстное меню
    await clickAt(page, hole.pc, "right");
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/25-win-${key}-menu.png` });
    await escape(page);
    writeFileSync(`${OUT}/ref-${key}.json`, JSON.stringify({ key, wall: wallKey, hole }, null, 1) + "\n");
    console.log(key, "ok", hole.type, hole.width);
  }
  // общий скриншот плана со всеми семью
  await page.screenshot({ path: `${SHOTS}/25-win-all7-plan.png` });
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
