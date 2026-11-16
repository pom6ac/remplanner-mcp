// 57-communications: где в редакторе живут определения инструментов «Коммуникаций»
// (global_tools vs tools), кто переопределяет ceiling_water/water. КЛИКОВ И ЗАПИСИ НЕТ.
// node scripts/probes/57-comm-src.ts (ID из env)
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
  const out = await page.evaluate(() => {
    const w: any = window as any;
    const keys = ["water", "ceiling_water", "conditioner_cage", "gas_line", "radiator_old", "ventilation_hole"];
    const pick = (src: any, k: string) => {
      const v = src?.[k];
      return v ? { group: v.group, anchor: v.anchor, w: v.width, h: v.height, title: v.title, plan: v.plan } : null;
    };
    const res: Record<string, unknown> = {
      global_tools: Object.fromEntries(keys.map((k) => [k, pick(w.global_tools, k)])),
      tools: Object.fromEntries(keys.map((k) => [k, pick(w.tools, k)])),
      global_tools_version: w.global_tools_version ?? w.defs_version ?? null,
      toolsIsArray: Array.isArray(w.tools),
      toolsCount: w.tools ? Object.keys(w.tools).length : null,
      gtCount: w.global_tools ? Object.keys(w.global_tools).length : null,
      sources: Object.keys(w).filter((k) => /tools|global/i.test(k)),
    };
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
  writeFileSync("../../.orca-reports/57-comm-ui/tool-sources.json", JSON.stringify(out, null, 1) + "\n");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
