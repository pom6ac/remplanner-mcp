// 41-pillars: влияние колонны на комнаты (rooms2 до/после) (ID из env, без env — выход).
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet } from "./phase2-lib.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

const copyServer = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));

async function freePoint(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const walls = Object.values<any>((window as any).project.copy("server").walls ?? {});
    if (!walls.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const w of walls) for (const p of [w.p1, w.p2]) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const dist = (p: any, a: any, b: any) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    };
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    for (let r = 0; r <= 500; r += 25) for (let a = 0; a < 360; a += 30) {
      const p = { x: cx + r * Math.cos(a * Math.PI / 180), y: cy + r * Math.sin(a * Math.PI / 180) };
      if (walls.every((w) => dist(p, w.p1, w.p2) > 60)) return p;
    }
    return null;
  });
}

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(".orca-reports/41-pillars-ui", { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const before = await copyServer(page);
  const pt = await freePoint(page);
  if (!pt) { console.error("нет точки"); process.exit(1); }
  const st = await pickTool(page, "pillar");
  await clickAt(page, pt);
  await clearFog(page);
  const after = await copyServer(page);
  const pid = Object.keys(after.pillars ?? {}).find((k) => !(k in (before.pillars ?? {})));
  const out: Record<string, unknown> = {
    point: pt,
    pillar_id: pid ?? null,
    pillar: pid ? (after.pillars as any)[pid] : null,
    rooms_before: Object.keys(before.rooms2 ?? {}).length,
    rooms_after: Object.keys(after.rooms2 ?? {}).length,
    rooms_added: Object.keys(after.rooms2 ?? {}).filter((k) => !(k in (before.rooms2 ?? {}))),
    rooms_removed: Object.keys(before.rooms2 ?? {}).filter((k) => !(k in (after.rooms2 ?? {}))),
  };
  // площадь комнаты с колонной: rooms2 changed
  const changed = Object.keys(after.rooms2 ?? {}).filter((k) => k in (before.rooms2 ?? {}) && JSON.stringify(before.rooms2![k]) !== JSON.stringify((after.rooms2 as any)[k]));
  out.rooms_changed = changed;
  await escape(page);
  writeFileSync(".orca-reports/41-pillars-ui/dbg-rooms.json", JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify(out, null, 1).slice(0, 3000));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
