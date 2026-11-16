// 37-doors: отладка 2 — куда каждая стена проецируется на экране, и клик по стене в центре экрана.
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, toScreen } from "./phase2-lib.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }
const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
try {
  const page = editor.page;
  const model = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
  const ranked: { id: string; sx: number; sy: number; len: number }[] = [];
  for (const [id, w] of Object.entries<any>(model.walls)) {
    const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
    if (len < 40) continue;
    const pt = { x: (w.p1.x + w.p2.x) / 2, y: (w.p1.y + w.p2.y) / 2 };
    const s = await toScreen(page, pt);
    ranked.push({ id, sx: Math.round(s.x), sy: Math.round(s.y), len: Math.round(len) });
  }
  console.table(ranked);
  // стена ближе всего к центру экрана
  const best = ranked.filter(r => r.sx > 200 && r.sx < 1400 && r.sy > 150 && r.sy < 850).sort((a, b) => (a.sx - 800) ** 2 + (a.sy - 500) ** 2 - ((b.sx - 800) ** 2 + (b.sy - 500) ** 2))[0];
  console.log("best:", best);
  if (best) {
    const w = model.walls[best.id];
    const pt = { x: (w.p1.x + w.p2.x) / 2, y: (w.p1.y + w.p2.y) / 2 };
    const st = await pickTool(page, "doorway");
    console.log("pickTool:", st);
    await clickAt(page, pt);
    const after = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
    const holes = Object.keys(after.walls[best.id].holes ?? {});
    console.log("holes after:", holes.length, JSON.stringify(holes.map(h => after.walls[best.id].holes[h])));
    await escape(page);
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
