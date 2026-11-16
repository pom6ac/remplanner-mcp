// 49: список инструментов группы ceiling_elements из window.tools живой страницы (только чтение).
import { writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
try {
  const page = editor.page;
  const out = await page.evaluate(() => {
    const t: any = (window as any).tools ?? {};
    const res: Record<string, { id: number; title: string; plan: unknown }> = {};
    for (const [k, v] of Object.entries<any>(t)) {
      if (v && v.group === "ceiling_elements") res[k] = { id: v.id, title: v.title, plan: v.plan };
    }
    return { ceiling_elements: res, toolGroupNow: (window as any).tool_group ?? null };
  });
  writeFileSync(".orca-reports/49-rigels-types/ceiling-elements-tools.json", JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify(out, null, 1));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
