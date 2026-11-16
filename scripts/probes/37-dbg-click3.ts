// 37-doors: отладка 3 — типы, у которых клик не добавил проём; снимаем сообщения редактора.
import type { Page } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, toScreen } from "./phase2-lib.ts";

const KEYS = (process.argv[2] ?? "door_garage,door_system_x3,door_system_x4,door_system_penal_x3,door_system_penal_x4,doors_coupe_2x,doors_coupe_3x,doors_coupe_4x,door_remote,door_videoremote").split(",");
const OUT = ".orca-reports/37-doors-ui";
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }
const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
const copyS = (p: Page) => p.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
try {
  const page = editor.page;
  await switchSheet(page, "init");
  for (const key of KEYS) {
    const res: Record<string, unknown> = { key };
    const cur = await copyS(page);
    // стены с максимумом свободного места, видимые на экране
    const cands = ["zrslo37ysb", "smmfs1i0hh", "88wyg3rhy5", "o1kqv7m7ih", "3d23j4gk9h", "7kmwa9hpxx", "e83g72t0rs", "mum46g7h3k"];
    let wallKey: string | null = null;
    let pt: { x: number; y: number } | null = null;
    for (const wk of cands) {
      const wall = cur.walls[wk];
      if (!wall) continue;
      const len = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
      const margin = wall.depth / 2 + 5;
      if (len - 2 * margin < 60) continue;
      const t = 0.5;
      const p = { x: wall.p1.x + (wall.p2.x - wall.p1.x) * t, y: wall.p1.y + (wall.p2.y - wall.p1.y) * t };
      const s = await toScreen(page, p);
      if (s.x > 250 && s.x < 1350 && s.y > 150 && s.y < 850) { wallKey = wk; pt = p; break; }
    }
    if (!wallKey || !pt) { console.log(key, "нет видимой стены"); continue; }
    const before = structuredClone(cur.walls[wallKey]);
    const st = await pickTool(page, key);
    res.pickTool = st;
    if (st === "ok") {
      await clickAt(page, pt);
      await clearFog(page);
      const after = await copyS(page);
      const wa = after.walls[wallKey];
      let added: any = null;
      for (const [hid, h] of Object.entries<any>(wa?.holes ?? {})) if (!(hid in (before?.holes ?? {}))) added = { ...h, _wall: wallKey };
      res.hole = added ? (({ l1, r1, l2, r2, l1b, r1b, l2b, r2b, l1c, l2c, r1c, r2c, p1fact, p2fact, pcfact, bg_polygon, eds, polygon, pcb, p1b, p2b, p1corner, p2corner, pc1h, f0offset, room_l, room_r, parent, parent_depth, dls_prs, position, offset, ...rest }) => rest)(added) : null;
      if (added) await escape(page);
      res.removed = added ? null : undefined;
    }
    // сообщения редактора после клика
    res.msgs = await page.evaluate((key) => ({
      fog: document.querySelector("#planner_ui_message_fog")?.className ?? null,
      active: Array.from(document.querySelectorAll(".planner_ui_message.active")).map((e: any) => e.textContent?.trim().slice(0, 200)),
      dialogs: Array.from(document.querySelectorAll(".ui_dialog, .modal, [class*='dialog']")).filter((e: any) => e.offsetParent).map((e: any) => e.textContent?.trim().slice(0, 200)),
      toolActive: document.querySelector(`#plannertool_${key}`)?.className ?? null,
    }), key);
    await page.screenshot({ path: `screenshots/37-dbg3-${key}.png` });
    await escape(page).catch(() => {});
    await page.waitForTimeout(300);
    writeFileSync(`${OUT}/dbg3-${key}.json`, JSON.stringify(res, null, 1) + "\n");
    console.log(key, JSON.stringify({ pick: res.pick, ok: !!res.hole, msgs: res.msgs }).slice(0, 400));
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
