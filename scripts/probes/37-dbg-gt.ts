// 37-doors: отладка 9 — где в global_tools лежат door_remote/doors_coupe (их дефолты).
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
  const info = await page.evaluate(() => {
    const w: any = window as any;
    const res: Record<string, unknown> = {};
    const gt = w.global_tools ?? {};
    for (const [k, v] of Object.entries<any>(gt)) {
      const s = JSON.stringify(v);
      if (s && (s.includes("door_remote") || s.includes("doors_coupe") || s.includes("videoremote"))) {
        res[k] = s.slice(0, 6000);
      }
    }
    return res;
  });
  writeFileSync(".orca-reports/37-doors-ui/gt-hit.json", JSON.stringify(info, null, 1) + "\n");
  console.log("keys:", Object.keys(info));
  console.log(JSON.stringify(info, null, 1).slice(0, 3000));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
