// 41-pillars: разведка меню «Несущая колонна» — ключи инструментов, defs, DOM панели, скриншоты.
// ID только из env, без env — выход до обращения к API.
import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, switchSheet } from "./phase2-lib.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(".orca-reports/41-pillars-ui", { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const scout = await page.evaluate(() => {
    const out: Record<string, unknown> = {};
    // все элементы панели инструментов с id, содержащим pillar/colonn/col/column
    const tools: Record<string, { id: string; text: string; cls: string; parent: string | null; pro: boolean }> = {};
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[id^='plannertool_']"))) {
      const id = el.id;
      if (!/pill|colon|column|col_/i.test(id)) continue;
      const box = (el.closest(".subtools_item") ?? el) as HTMLElement;
      const name = box.querySelector(".subtools_item_name, .tools_item_name, span, b, i");
      tools[id] = {
        id,
        text: (name?.textContent ?? box.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
        cls: el.className,
        parent: el.closest(".tools_item")?.id ?? null,
        pro: el.classList.contains("is_pro") || !!el.closest(".is_pro"),
      };
    }
    out.tools = tools;
    // defs — ключи про колонны
    const d: any = (window as any).defs ?? {};
    const defs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries<any>(d)) {
      if (/pill|colon|column/i.test(k)) defs[k] = v;
    }
    out.defs = defs;
    // все ключи defs (списком) — для поиска
    out.defs_keys = Object.keys(d);
    // глобальные конструкторы
    out.globals = Object.keys(window as any).filter((k) => /pillar|colon|column/i.test(k));
    return out;
  });
  writeFileSync(".orca-reports/41-pillars-ui/scout.json", JSON.stringify(scout, null, 1) + "\n");
  console.log(JSON.stringify(scout, null, 1));
  mkdirSync("../../screenshots", { recursive: true });
  await page.screenshot({ path: "../../screenshots/41-scout-menu.png" });
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
