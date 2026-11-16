// 53-stairs: разведка меню «Лестницы» — ключи инструментов, global_tools группы stairs,
// defs, листы. КЛИКОВ И ЗАПИСИ НЕТ. node scripts/probes/53-stairs-scout.ts (ID из env)
import { mkdirSync, writeFileSync } from "node:fs";
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
mkdirSync("../../.orca-reports/53-stairs-ui", { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const scout = await page.evaluate(() => {
    const out: Record<string, unknown> = {};
    // 1. global_tools: вся группа stairs
    const gt: any = (window as any).global_tools ?? {};
    const stairs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries<any>(gt)) {
      if (v?.group === "stairs" || /stair|ladder/i.test(k) || /лестниц/i.test(String(v?.title ?? ""))) {
        stairs[k] = v;
      }
    }
    out.global_tools_stairs = stairs;
    out.global_tools_stairs_count = Object.keys(stairs).length;
    // 2. DOM: пункты меню с «лестниц» и plannertool_ id
    const tools: Record<string, { id: string; text: string; parent: string | null; pro: boolean }> = {};
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[id^='plannertool_']"))) {
      const box = (el.closest(".subtools_item") ?? el) as HTMLElement;
      const name = box.querySelector(".subtools_item_name, .tools_item_name, span, b, i");
      tools[el.id] = {
        id: el.id,
        text: (name?.textContent ?? box.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
        parent: el.closest(".tools_item")?.id ?? null,
        pro: el.classList.contains("is_pro") || !!el.closest(".is_pro"),
      };
    }
    const stairTools: Record<string, { id: string; text: string; parent: string | null; pro: boolean }> = {};
    for (const [id, t] of Object.entries(tools)) {
      if (/лестниц|stair/i.test(id) || /лестниц/i.test(t.text)) stairTools[id] = t;
    }
    out.dom_tools_all_count = Object.keys(tools).length;
    out.dom_stair_tools = stairTools;
    // 3. defs
    const d: any = (window as any).defs ?? {};
    const defs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries<any>(d)) {
      if (/stair|ladder|stage|step/i.test(k)) defs[k] = v;
    }
    out.defs = defs;
    out.defs_keys = Object.keys(d);
    // 4. глобалы и классы
    out.globals = Object.keys(window as any).filter((k) => /stair|ladder/i.test(k));
    // 5. листы, где есть лестничные пункты меню (обход переключателей листов)
    const sheetBtns: string[] = Array.from(document.querySelectorAll<HTMLElement>("[data-plan]")).map((e) => e.getAttribute("data-plan") ?? "");
    out.sheets = sheetBtns;
    return out;
  });
  writeFileSync("../../.orca-reports/53-stairs-ui/scout.json", JSON.stringify(scout, null, 1) + "\n");
  console.log("stairs in global_tools:", scout.global_tools_stairs_count);
  console.log("dom stair tools:", JSON.stringify(scout.dom_stair_tools, null, 1).slice(0, 3000));
  console.log("defs keys:", JSON.stringify(scout.defs_keys));
  console.log("globals:", JSON.stringify(scout.globals));
  mkdirSync("../../screenshots", { recursive: true });
  await page.screenshot({ path: "../../screenshots/53-scout.png" });
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
