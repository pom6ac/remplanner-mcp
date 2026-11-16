// 37-doors: отладка 6 — структура global_tools (группа doors) и дефолты инструментов.
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
    const gt = w.global_tools;
    const res: Record<string, unknown> = { topKeys: Object.keys(gt ?? {}).slice(0, 40) };
    // ищем ключи, где лежат двери
    const found: Record<string, unknown> = {};
    for (const [k, v] of Object.entries<any>(gt ?? {})) {
      const s = JSON.stringify(v);
      if (s && s.includes("door_garage")) found[k] = s.slice(0, 4000);
    }
    res.found = found;
    // select_tool / параметры инструментов
    res.select_tool_src = String(w.select_tool).slice(0, 1500);
    return res;
  });
  writeFileSync(".orca-reports/37-doors-ui/catalog2.json", JSON.stringify(info, null, 1) + "\n");
  console.log(JSON.stringify(info, null, 1).slice(0, 4000));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
