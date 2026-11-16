// 57-communications: где живут subtools «Коммуникаций» — цепочка предков plannertool_socket. КЛИКОВ ИНСТРУМЕНТОВ НЕТ.
// node scripts/probes/57-comm-dom.ts (ID из env)
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
  const dom = await page.evaluate(() => {
    const el = document.getElementById("plannertool_socket");
    if (!el) return { found: false };
    const chain: { tag: string; id: string; cls: string }[] = [];
    let cur: HTMLElement | null = el;
    for (let i = 0; cur && i < 12; i++, cur = cur.parentElement) {
      chain.push({ tag: cur.tagName.toLowerCase(), id: cur.id, cls: cur.className.replace(/\s+/g, " ").trim().slice(0, 140) });
    }
    const groups = Array.from(document.querySelectorAll<HTMLElement>('[id^="group"]')).slice(0, 50).map((g) => ({ id: g.id, cls: g.className.slice(0, 80), kids: g.children.length }));
    return { found: true, chain, groups };
  });
  console.log(JSON.stringify(dom, null, 1));
  writeFileSync("../../.orca-reports/57-comm-ui/dom-chain.json", JSON.stringify(dom, null, 1) + "\n");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
