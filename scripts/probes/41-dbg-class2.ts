// 41-pillars: отладка 2 — исходники Pillar/PILLARS из бандла (ID из env, без env — выход).
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
    out.PILLARS = typeof w.PILLARS !== "undefined" ? { type: typeof w.PILLARS, proto: w.PILLARS?.prototype ? Object.getOwnPropertyNames(w.PILLARS.prototype) : null, src: String(w.PILLARS).slice(0, 12000) } : null;
    out.pillars = { type: typeof w.pillars, sample: w.pillars instanceof Object ? Object.keys(w.pillars).slice(0, 5) : String(w.pillars).slice(0, 200) };
    out.guidlines = String(w.pillarGuidlines).slice(0, 3000);
    return out;
  });
  writeFileSync(".orca-reports/41-pillars-ui/dbg-class2.json", JSON.stringify(dbg, null, 1) + "\n");
  console.log(JSON.stringify(dbg).slice(0, 2000));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
