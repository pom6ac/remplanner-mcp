// 375 (разведка нижней панели и листов, БЕЗ записи в аккаунт): анонимный проект
// (project_create), дамп разметки нижней панели (#groups_navi, .footer_bar_tool,
// подменю «Нарисовать элемент», окно custom_plan_modal), is_pro у каждого
// элемента, сериализованные классы страницы (CUSTOM_PLANS/FREE_LINES/…).
// Аккаунт не используется. node scripts/probes/375-sheets-ui.ts run
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

if (process.argv[2] !== "run") { console.error("запуск: run"); process.exit(0); }
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 10 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "375-sheets-ui", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
};
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 900)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};

try {
  const created = await call("project_create", {});
  console.log("anon project created:", JSON.stringify(Object.keys(created)));
  await call("render_plan", {});
  const ed = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { page?: import("playwright-core").Page } | null;
  const page = ed?.page;
  if (!page) throw new Error("страница недоступна");
  await page.waitForTimeout(2500);

  // 1. нижняя панель: вкладки листов и кнопки инструментов
  const nav = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll("#groups_navi .groups_navi_item")).map((el) => ({
      plan: el.getAttribute("data-plan"),
      text: String(el.textContent ?? "").trim().slice(0, 40),
      cls: String(el.className),
    }));
    const tools = Array.from(document.querySelectorAll(".footer_bar_tool, .footer_bar .tool, [id^=plannertool_]")).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).map((el) => ({
      id: el.id,
      cls: String(el.className).slice(0, 120),
      dataText: el.getAttribute("data-text") ?? "",
      pro: String(el.className).includes("is_pro"),
    }));
    return { tabs, tools: tools.slice(0, 200) };
  });
  console.log("tabs:", JSON.stringify(nav.tabs));
  console.log("visible tools:", nav.tools.length);

  // 2. подменю «Нарисовать элемент»: ищем кнопку и раскрываем
  const drawBtn = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("[id^=plannertool_], .footer_bar_tool"));
    const el = all.find((e) => /нарисовать/i.test(e.getAttribute("data-text") ?? "") || /нарисовать/i.test(e.textContent ?? ""));
    if (!el) return null;
    return { id: el.id, cls: String(el.className), text: (el.getAttribute("data-text") ?? el.textContent ?? "").slice(0, 60) };
  });
  console.log("draw element button:", JSON.stringify(drawBtn));
  let figureMenu: unknown = null;
  if (drawBtn) {
    try {
      await page.click(`#${CSS.escape(drawBtn!.id)}`, { timeout: 5000 });
      await page.waitForTimeout(800);
      figureMenu = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll(".contextmenu .contextmenu_item, .submenu_item, .tools_submenu li, .contextmenu li")).map((el) => ({
          text: String(el.textContent ?? "").trim().slice(0, 60),
          cls: String(el.className).slice(0, 80),
          id: el.id,
          pro: String(el.className).includes("is_pro"),
        }));
        return items;
      });
      console.log("figure menu items:", JSON.stringify(figureMenu));
      await page.keyboard.press("Escape");
    } catch (e) { console.log("draw menu open failed:", String((e as Error).message).slice(0, 200)); }
  }

  // 3. окно пользовательского листа: клик по «+» в #groups_navi
  let customPlanModal: unknown = null;
  try {
    await page.click("#groups_navi .groups_navi_item.add", { timeout: 5000 });
    await page.waitForTimeout(1500);
    customPlanModal = await page.evaluate(() => {
      const m = document.querySelector("#custom_plan_modal");
      if (!m) return { found: false };
      const html = m.outerHTML.slice(0, 20000);
      const afterPlanOptions = Array.from(m.querySelectorAll('[name="after_plan"] option')).map((o) => ({ value: o.getAttribute("value"), text: String(o.textContent ?? "").trim() }));
      const contentInputs = Array.from(m.querySelectorAll(".custom_plan_content input")).map((i) => ({ value: i.getAttribute("value"), label: String((i.closest("label") ?? i.parentElement)?.textContent ?? "").trim().slice(0, 60), checked: (i as HTMLInputElement).checked }));
      return { found: true, afterPlanOptions, contentInputs, html };
    });
    console.log("custom plan modal:", JSON.stringify(customPlanModal, null, 1).slice(0, 3000));
  } catch (e) { console.log("custom plan modal failed:", String((e as Error).message).slice(0, 200)); }

  // 4. сериализованные классы страницы (пустые коллекции — форма умолчаний)
  const classes = await page.evaluate(() => {
    const snap = (name: string): unknown => {
      const o = (window as unknown as Record<string, unknown>)[name] as unknown;
      if (!o) return null;
      try { return JSON.parse(JSON.stringify(o)); } catch { return String(o); }
    };
    return {
      CUSTOM_PLANS: snap("CUSTOM_PLANS"),
      FREE_FIGURES_KEYS: Object.keys(snap("FREE_FIGURES") as object ?? {}),
      DEFS_FIGURE: (window as unknown as { defs?: { free_figure?: unknown; thick_line?: unknown } }).defs
        ? { free_figure: (window as unknown as { defs: { free_figure?: unknown } }).defs.free_figure, thick_line: (window as unknown as { defs: { thick_line?: unknown } }).defs.thick_line }
        : null,
    };
  });
  writeFileSync(".orca-reports/tmp/375-sheets-ui.json", JSON.stringify({
    _source: "анонимный проект (project_create), разметка редактора /planner/, scripts/probes/375-sheets-ui.ts; id не печатаются",
    tabs: nav.tabs, tools: nav.tools, drawBtn, figureMenu, customPlanModal, classes,
  }, null, 1) + "\n");
  console.log("saved .orca-reports/tmp/375-sheets-ui.json");
  console.log("classes:", JSON.stringify(classes).slice(0, 1500));
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 1200));
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
