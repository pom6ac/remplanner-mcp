// 37-doors: отладка 7 — где в бандле определён door_garage (глобалы страницы).
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
    const hits: Record<string, string> = {};
    for (const k of Object.keys(w)) {
      try {
        const v = w[k];
        if (!v || typeof v !== "object") continue;
        const s = JSON.stringify(v);
        if (s && s.length < 3_000_000 && s.includes("door_garage")) {
          const i = s.indexOf("door_garage");
          hits[k] = s.slice(Math.max(0, i - 600), i + 1200);
        }
      } catch { /* циклы */ }
    }
    return hits;
  });
  writeFileSync(".orca-reports/37-doors-ui/globals-hit.json", JSON.stringify(info, null, 1) + "\n");
  console.log("keys:", Object.keys(info));
  for (const [k, v] of Object.entries(info)) console.log(`--- ${k}: ${k === "project" || k === "WALLS" ? "(объект модели)" : info[k].slice(0, 1200)}`);
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
