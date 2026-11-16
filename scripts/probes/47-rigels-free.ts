// 47-rigels: эталон свободного ригеля (drag между двумя свободными точками, link:0 у обоих концов).
// ID только из env. КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается.
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, pickTool, switchSheet, copyServer, toScreen, type P } from "./phase2-lib.ts";

const OUT = ".orca-reports/47-rigels-ui";
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  // свободная точка: вдали от стен и граней колонн
  const free = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    const walls = Object.values<any>(m.walls ?? {});
    const pillars = Object.values<any>(m.pillars ?? {});
    const distSeg = (p: P, a: P, b: P) => {
      const dx = b.x - a.x, dy = b.y - a.y; const l2 = dx * dx + dy * dy;
      let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    };
    const distPillarEdges = (p: P) => Math.min(...pillars.map((pi) => {
      const dx = Math.abs(p.x - pi.pc.x) - pi.width / 2;
      const dy = Math.abs(p.y - pi.pc.y) - pi.height / 2;
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    }));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const w of walls) {
      minX = Math.min(minX, w.p1.x, w.p2.x); maxX = Math.max(maxX, w.p1.x, w.p2.x);
      minY = Math.min(minY, w.p1.y, w.p2.y); maxY = Math.max(maxY, w.p1.y, w.p2.y);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    for (let r = 0; r <= 600; r += 20) {
      for (let ang = 0; ang < 360; ang += 8) {
        const p = { x: cx + r * Math.cos(ang * Math.PI / 180), y: cy + r * Math.sin(ang * Math.PI / 180) };
        if (walls.every((w) => distSeg(p, w.p1, w.p2) > 100) && distPillarEdges(p) > 100) return p;
      }
    }
    return null;
  });
  if (!free) throw new Error("нет свободной точки");
  const a: P = { x: free.x, y: free.y };
  const b: P = { x: free.x + 80, y: free.y + 20 };
  const st = await pickTool(page, "rigel");
  if (st !== "ok") throw new Error(`pickTool: ${st}`);
  const before = await copyServer(page);
  const sa = await toScreen(page, a), sb = await toScreen(page, b);
  await page.mouse.move(sa.x, sa.y, { steps: 4 });
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.mouse.move(sb.x, sb.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  await clearFog(page);
  const after = await copyServer(page);
  const added = Object.entries<any>(after.rigels ?? {}).find(([id]) => !(id in (before.rigels as object)));
  const res = { variant: "free", ok: !!added, added: added?.[1] ?? null, a, b };
  writeFileSync(`${OUT}/free.json`, JSON.stringify(res, null, 1) + "\n");
  console.log(JSON.stringify({ ok: res.ok, added: res.added }));
  await page.screenshot({ path: "../../screenshots/47-rigel-free-plan.png" }).catch(() => {});
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
