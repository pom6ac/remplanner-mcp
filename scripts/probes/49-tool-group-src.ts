// 49: где задаётся tool_group «ceiling_elements» — чтение исходников скриптов страницы (без записи).
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
  const found = await page.evaluate(async () => {
    const urls = performance.getEntriesByType("resource").map((r) => r.name).filter((u) => /\.js(\?|$)/.test(u));
    urls.push(...Array.from(document.querySelectorAll("script[src]")).map((s) => (s as HTMLScriptElement).src));
    const hits: { url: string; context: string }[] = [];
    for (const u of [...new Set(urls)]) {
      try {
        const text = await (await fetch(u)).text();
        for (const m of text.matchAll(/ceiling_elements/g)) {
          hits.push({ url: u, context: text.slice(Math.max(0, m.index - 400), m.index + 400) });
        }
        for (const m of text.matchAll(/tool_group\s*=/g)) {
          hits.push({ url: u, context: text.slice(Math.max(0, m.index - 400), m.index + 400) });
        }
      } catch { /* ignore */ }
    }
    return hits.slice(0, 40);
  });
  writeFileSync(".orca-reports/49-rigels-types/tool-group-src.json", JSON.stringify(found, null, 1) + "\n");
  for (const h of found) console.log("=== " + h.url + "\n" + h.context + "\n");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
