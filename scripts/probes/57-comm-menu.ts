// 57-communications: дерево подменю «Коммуникации» (раскрытие вложенных subtools). КЛИКОВ ИНСТРУМЕНТОВ НЕТ.
// node scripts/probes/57-comm-menu.ts (ID из env)
import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { switchSheet, clearFog } from "./phase2-lib.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync("../../.orca-reports/57-comm-ui", { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");

  // Раскрыть «Коммуникации» кликом по корневой группе; DOM подменю создаётся динамически
  await page.evaluate(() => {
    const root = Array.from(document.querySelectorAll<HTMLElement>(".tools_item"))
      .find((el) => el.classList.contains("santeh_node"));
    if (!root) throw new Error("нет корня santeh_node");
    (root.querySelector(".tools_item_name, [data-target]") ?? root).click();
  });
  await page.waitForTimeout(1500);

  type Node = { text: string; cls: string; tool: string | null; pro: boolean; children?: Node[] };
  const tree = await page.evaluate(() => {
    const dump = (el: HTMLElement): Node => {
      const tool = el.querySelector("[id^='plannertool_']");
      const node: Node = {
        text: (el.querySelector(".subtools_item_name, .tools_item_name")?.textContent ?? el.textContent ?? "")
          .replace(/\s+/g, " ").trim().slice(0, 100),
        cls: el.className.replace(/\s+/g, " ").trim().slice(0, 140),
        tool: tool ? (tool as HTMLElement).id.replace(/^plannertool_/, "") : null,
        pro: el.classList.contains("is_pro") || !!el.closest(".is_pro"),
      };
      const sub = el.querySelector<HTMLElement>(".subtools");
      if (sub) {
        const kids: Node[] = [];
        for (const it of Array.from(sub.querySelectorAll<HTMLElement>(":scope > .subtools_item"))) kids.push(dump(it));
        node.children = kids;
      }
      return node;
    };
    const root = Array.from(document.querySelectorAll<HTMLElement>(".tools_item"))
      .find((el) => el.classList.contains("santeh_node"))!;
    const rootNode = dump(root);
    // все subtools документа (после раскрытия)
    const subs = Array.from(document.querySelectorAll<HTMLElement>(".subtools")).map((s) => ({
      id: s.id || null,
      cls: s.className.replace(/\s+/g, " ").trim().slice(0, 120),
      itemIds: Array.from(s.querySelectorAll<HTMLElement>(":scope > .subtools_item")).map((it) => {
        const t = it.querySelector("[id^='plannertool_']");
        return {
          text: (it.querySelector(".subtools_item_name")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
          cls: it.className.replace(/\s+/g, " ").trim().slice(0, 140),
          tool: t ? (t as HTMLElement).id.replace(/^plannertool_/, "") : null,
          hasSubtools: !!it.querySelector(".subtools"),
        };
      }),
    }));
    const groupEls = Array.from(document.querySelectorAll<HTMLElement>('[id^="group"]')).map((g) => ({
      id: g.id, cls: g.className.replace(/\s+/g, " ").trim().slice(0, 100), kids: g.children.length,
    }));
    return { rootNode, subs, groupEls, rootHtml: root.outerHTML.slice(0, 300) };
  });
  writeFileSync("../../.orca-reports/57-comm-ui/menu-comm-tree.json", JSON.stringify(tree, null, 1) + "\n");

  const walk = (n: Node, depth: number, out: string[]) => {
    out.push("  ".repeat(depth) + (n.tool ? n.tool : "(group)") + " — " + n.text + (n.pro ? " [PRO]" : ""));
    for (const c of n.children ?? []) walk(c, depth + 1, out);
  };
  const lines: string[] = [];
  walk(tree.rootNode, 0, lines);
  console.log("ROOT TREE:", lines.join("\n") || "(empty)");
  console.log("SUBTOOLS GROUPS:", tree.subs.map((s) => `${s.id ?? "?"}(${s.itemIds.length})`).join(", "));
  console.log("GROUP ELS:", tree.groupEls.map((g) => `${g.id}(${g.kids})`).join(", "));
  await clearFog(page);
  await page.screenshot({ path: "../../screenshots/57-menu.png" });
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
