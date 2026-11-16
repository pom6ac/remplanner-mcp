// 41-pillars: отладка 3 — скрипты страницы, поиск кода Pillar (ID из env, без env — выход).
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
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
  const urls: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll("script[src]")).map((s) => (s as HTMLScriptElement).src));
  console.log("scripts:", urls.length);
  let i = 0;
  for (const u of urls) {
    try {
      const resp = await page.evaluate(async (url) => {
        const r = await fetch(url);
        return { text: await r.text() };
      }, u);
      if (/pillar/i.test(resp.text)) {
        const f = createWriteStream(`.orca-reports/41-pillars-ui/src-${i}.js`);
        f.write(resp.text);
        f.end();
        console.log("has pillar:", u.slice(0, 120), resp.text.length);
      }
      i++;
    } catch (e) { console.log("skip", u.slice(0, 80), String(e).slice(0, 80)); }
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
