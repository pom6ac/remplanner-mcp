// 375 (разведка нижней панели, ч.3, БЕЗ записи в аккаунт): подменю
// freelines_opener («Нарисовать элемент»), addimage_opener (изображения),
// custom_plan_modal с ожиданием загрузки HTML, список окон модалок.
// Аккаунт не используется. node scripts/probes/375-sheets-ui3.ts run
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
const client = new Client({ name: "375-sheets-ui3", version: "0.0.0" });
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
  await call("project_create", {});
  await call("render_plan", {});
  const ed = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { page?: import("playwright-core").Page } | null;
  const page = ed?.page;
  if (!page) throw new Error("страница недоступна");
  await page.waitForTimeout(2500);

  const dumpMenus = async (label: string): Promise<void> => {
    const menus = await page.evaluate(() => {
      const out: Array<Record<string, unknown>> = [];
      for (const el of Array.from(document.querySelectorAll(".contextmenu, .footer_bar_menu, .submenu, [class*=menu]"))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const items = Array.from(el.querySelectorAll("a, li, .item, button")).map((it) => ({
          text: String(it.textContent ?? "").trim().slice(0, 60),
          id: it.id,
          cls: String(it.className).slice(0, 80),
          pro: String(it.className).includes("is_pro"),
        })).filter((x) => x.text || x.id);
        if (items.length) out.push({ cls: String(el.className).slice(0, 80), id: el.id, items: items.slice(0, 40) });
      }
      return out;
    });
    console.log(label, JSON.stringify(menus, null, 1).slice(0, 5000));
  };

  // 1. «Нарисовать элемент» (freelines_opener)
  await page.click("#freelines_opener", { timeout: 5000 }).catch((e) => console.log("click freelines failed", String(e).slice(0, 100)));
  await page.waitForTimeout(1200);
  await dumpMenus("after freelines_opener:");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // 2. Изображения (addimage_opener)
  await page.click("#addimage_opener", { timeout: 5000 }).catch((e) => console.log("click addimage failed", String(e).slice(0, 100)));
  await page.waitForTimeout(1200);
  await dumpMenus("after addimage_opener:");
  const modalHtml = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll(".v2_modal, .modal, [id$=_modal]"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) out.push(`${el.id}:${String(el.className).slice(0, 60)}:${el.outerHTML.slice(0, 3000)}`);
    }
    return out;
  });
  console.log("open modals after addimage:", JSON.stringify(modalHtml).slice(0, 4000));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // 3. custom_plan_modal: открыть и ждать подольше; наблюдать network
  const modalResponses: string[] = [];
  page.on("response", (r) => { if (r.url().includes("modal") || r.url().includes("custom")) modalResponses.push(`${r.status()} ${r.url().slice(0, 120)}`); });
  await page.click("#groups_navi .groups_navi_item.add", { timeout: 5000 }).catch((e) => console.log("click add failed", String(e).slice(0, 100)));
  await page.waitForTimeout(6000);
  console.log("modal-related responses:", JSON.stringify(modalResponses.slice(0, 20)));
  const modal = await page.evaluate(() => {
    const m = document.querySelector("#custom_plan_modal");
    if (!m) return { found: false };
    const afterPlanOptions = Array.from(m.querySelectorAll('[name="after_plan"] option')).map((o) => ({ value: o.getAttribute("value"), text: String(o.textContent ?? "").trim() }));
    const contentInputs = Array.from(m.querySelectorAll("input")).map((i) => ({ name: i.getAttribute("name"), value: i.getAttribute("value"), label: String((i.closest("label") ?? i.parentElement)?.textContent ?? "").trim().slice(0, 80), type: i.getAttribute("type") }));
    return { found: true, afterPlanOptions, contentInputs, html: m.outerHTML.slice(0, 20000) };
  });
  console.log("custom plan modal:", JSON.stringify(modal, null, 1).slice(0, 8000));
  writeFileSync(".orca-reports/tmp/375-sheets-ui3.json", JSON.stringify({
    _source: "анонимный проект (project_create), разметка редактора /planner/, scripts/probes/375-sheets-ui3.ts; id не печатаются",
    modal,
  }, null, 1) + "\n");
  console.log("saved .orca-reports/tmp/375-sheets-ui3.json");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 1200));
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
