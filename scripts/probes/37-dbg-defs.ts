// 37-doors: отладка 8 — полные дефолты defs для дверей и окон.
import { writeFileSync } from "node:fs";
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
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const defs = await page.evaluate(() => {
    const d: any = (window as any).defs ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries<any>(d)) {
      if (/^door|^doorway|^doors_|^window|^windoor/.test(k)) out[k] = v;
    }
    return out;
  });
  writeFileSync(".orca-reports/37-doors-ui/defs-doors.json", JSON.stringify(defs, null, 1) + "\n");
  console.log(JSON.stringify(defs, null, 1));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
