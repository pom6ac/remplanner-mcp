// 57-communications: разведка меню «Коммуникации» — ключи инструментов, global_tools,
// defs, листы. КЛИКОВ И ЗАПИСИ НЕТ. node scripts/probes/57-comm-scout.ts (ID из env)
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
mkdirSync("../../.orca-reports/57-comm-ui", { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const scout = await page.evaluate(() => {
    const out: Record<string, unknown> = {};
    // 1. Всё дерево левого меню: корневые .tools_item и вложенные .subtools_item
    const tree: Record<string, unknown>[] = [];
    for (const root of Array.from(document.querySelectorAll<HTMLElement>(".tools_item"))) {
      const nameEl = root.querySelector(".tools_item_name") ?? root;
      const rec: Record<string, unknown> = {
        id: root.id || null,
        cls: root.className.replace(/\s+/g, " ").trim().slice(0, 120),
        text: (nameEl.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
        pro: root.classList.contains("is_pro"),
        children: [] as string[],
      };
      const sub = root.querySelector(".subtools");
      if (sub) {
        const items: Record<string, unknown>[] = [];
        for (const it of Array.from(sub.querySelectorAll<HTMLElement>(".subtools_item"))) {
          const tool = it.querySelector("[id^='plannertool_']");
          const toolId = tool ? (tool as HTMLElement).id.replace(/^plannertool_/, "") : null;
          items.push({
            cls: it.className.replace(/\s+/g, " ").trim().slice(0, 120),
            text: (it.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
            tool: toolId,
            pro: it.classList.contains("is_pro"),
          });
        }
        rec.children = items;
      }
      tree.push(rec);
    }
    out.menu_tree = tree;
    // 2. plannertool_* без дерева (контроль полноты)
    const flat = Array.from(document.querySelectorAll<HTMLElement>("[id^='plannertool_']")).map((el) => ({
      id: el.id.replace(/^plannertool_/, ""),
      parent: el.closest(".tools_item")?.querySelector(".tools_item_name")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      pro: el.classList.contains("is_pro") || !!el.closest(".is_pro"),
    }));
    out.flat_tools = flat;
    // 3. global_tools: группы, похожие на коммуникации
    const gt: any = (window as any).global_tools ?? {};
    const comm: Record<string, unknown> = {};
    for (const [k, v] of Object.entries<any>(gt)) {
      const g = String(v?.group ?? "");
      if (["pipes", "waterspots", "sockets", "switches", "cables", "wires", "shield_cables", "shield_module"].includes(g)) {
        comm[k] = v;
      }
    }
    out.global_tools_comm = comm;
    // 4. defs
    const d: any = (window as any).defs ?? {};
    out.defs_keys = Object.keys(d);
    const defs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries<any>(d)) {
      if (/pipe|water|vent|gas|socket|switch|cable|wire|shield|smeta/i.test(k)) defs[k] = v;
    }
    out.defs_comm = defs;
    // 5. листы
    const sheetBtns: string[] = Array.from(document.querySelectorAll<HTMLElement>("[data-plan]")).map((e) => e.getAttribute("data-plan") ?? "");
    out.sheets = sheetBtns;
    // 6. глобалы по теме
    out.globals = Object.keys(window as any).filter((k) => /pipe|water|vent|gas|socket|switch|cable|wire|shield|smeta|comm/i.test(k));
    return out;
  });
  writeFileSync("../../.orca-reports/57-comm-ui/scout.json", JSON.stringify(scout, null, 1) + "\n");
  const groups = new Set<string>(Object.values<any>(scout.global_tools_comm ?? {}).map((v: any) => v.group));
  console.log("global_tools comm:", Object.keys(scout.global_tools_comm ?? {}).length, "items, groups:", [...groups].join(","));
  console.log("menu roots:", (scout.menu_tree as any[]).map((m) => m.text).join(" | "));
  console.log("sheets:", JSON.stringify(scout.sheets));
  console.log("defs keys:", JSON.stringify(scout.defs_keys));
  console.log("globals:", JSON.stringify(scout.globals));
  mkdirSync("../../screenshots", { recursive: true });
  await page.screenshot({ path: "../../screenshots/57-scout.png" });
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
