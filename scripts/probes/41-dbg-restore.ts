// 41-pillars: проба restore — какие поля колонны редактор пересчитывает сам (ID из env, без env — выход).
// Эксперименты: полная копия, без p1..p4/edges/eds, минимальная {id,pc,width,height,angle,plan,role},
// изменение размеров/угла/позиции, на стене с eds.
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
  // ставим колонну кликом
  const pt = await freePoint(page);
  if (!pt) { console.error("нет точки"); process.exit(1); }
  const st = await pickTool(page, "pillar");
  if (st !== "ok") { console.error("pickTool:", st); process.exit(1); }
  await clickAt(page, pt);
  await clearFog(page);
  const full = await copyServer(page);
  const pid = Object.keys(full.pillars ?? {})[0];
  if (!pid) { console.error("колонна не поставилась"); process.exit(1); }
  const pillarFull = structuredClone(full.pillars[pid]);
  await escape(page);
  console.log("поставлена колонна:", pid, JSON.stringify(pillarFull).slice(0, 400));

  const restoreAndCopy = async (model: any) => {
    return page.evaluate((payload) => {
      const w = window as any;
      try {
        w.$Project.restore(JSON.parse(JSON.stringify(payload)));
        const copy = JSON.parse(JSON.stringify(w.project.copy("server")));
        return { ok: true, pillars: copy.pillars };
      } catch (e: any) {
        return { ok: false, err: String(e?.stack || e).slice(0, 400) };
      }
    }, model);
  };

  const results: Record<string, unknown> = { pillar_full: pillarFull };

  // A: без производных полей p1..p4/edges/eds/inRoom/total_height/show_dls
  const m1 = structuredClone(full);
  m1.pillars[pid] = Object.fromEntries(Object.entries(pillarFull).filter(([k]) =>
    !["p1", "p2", "p3", "p4", "edges", "eds", "inRoom", "total_height", "show_dls"].includes(k)));
  const a = await restoreAndCopy(m1);
  results.A_minimal = { ok: a.ok, err: a.err, pillar: (a.pillars as any)?.[pid] ?? null };

  // B: только {id, pc, width, height, angle, plan, role}
  const m2 = structuredClone(full);
  m2.pillars[pid] = { id: pid, pc: pillarFull.pc, width: pillarFull.width, height: pillarFull.height, angle: 45, plan: "a", role: "pillar" };
  const b = await restoreAndCopy(m2);
  results.B_angle45 = { ok: b.ok, err: b.err, pillar: (b.pillars as any)?.[pid] ?? null };

  // C: изменение размеров (width 40, height 30) без производных полей
  const m3 = structuredClone(full);
  m3.pillars[pid] = { ...m1.pillars[pid], width: 40, height: 30 };
  const c = await restoreAndCopy(m3);
  results.C_resize = { ok: c.ok, err: c.err, pillar: (c.pillars as any)?.[pid] ?? null };

  // D: снять колонну совсем (модель без неё) — restore без pillars
  const m4 = structuredClone(full);
  delete m4.pillars[pid];
  const d = await restoreAndCopy(m4);
  results.D_removed = { ok: d.ok, pillars_after: Object.keys((d.pillars ?? {}) as any) };

  // вернём эталон и убедимся, что повторный restore работает
  const m5 = structuredClone(full);
  m5.pillars[pid] = pillarFull;
  const e5 = await restoreAndCopy(m5);
  results.E_back = { ok: e5.ok, pillar_count: Object.keys((e5.pillars ?? {}) as any).length };

  writeFileSync(".orca-reports/41-pillars-ui/dbg-restore.json", JSON.stringify(results, null, 1) + "\n");
  console.log(JSON.stringify(results, null, 1).slice(0, 4000));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
