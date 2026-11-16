// 41-pillars: отладка — класс Pillar, defs, поля модели (ID из env, без env — выход).
import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { switchSheet } from "./phase2-lib.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }
const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(".orca-reports/41-pillars-ui", { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const dbg = await page.evaluate(() => {
    const w = window as any;
    const out: Record<string, unknown> = {};
    out.pillarClass = typeof w.Pillar !== "undefined" ? String(w.Pillar).slice(0, 6000) : null;
    out.globals = Object.keys(w).filter((k) => /^pill/i.test(k));
    out.defs_pillar = w.defs?.pillar ?? null;
    out.project_pillars = w.project?.pillars ? Object.keys(w.project.pillars) : null;
    out.copyPillars = w.project?.copy ? (() => { try { return w.project.copy("server").pillars; } catch (e) { return String(e); } })() : null;
    return out;
  });
  writeFileSync(".orca-reports/41-pillars-ui/dbg-class.json", JSON.stringify(dbg, null, 1) + "\n");
  console.log(JSON.stringify(dbg, null, 1).slice(0, 8000));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
