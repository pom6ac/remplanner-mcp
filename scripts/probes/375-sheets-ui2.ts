// 375 (разведка нижней панели и листов, ч.2, БЕЗ записи в аккаунт): полный дамп
// кнопок панели инструментов с data-text, окно custom_plan_modal после ожидания
// загрузки, подменю «Нарисовать элемент». Аккаунт не используется.
// node scripts/probes/375-sheets-ui2.ts run
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
const client = new Client({ name: "375-sheets-ui2", version: "0.0.0" });
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

  // 1. ВСЕ кнопки инструментов с data-text (не только видимые)
  const all = await page.evaluate(() => {
    const out: Array<Record<string, unknown>> = [];
    for (const el of Array.from(document.querySelectorAll("[id^=plannertool_]"))) {
      out.push({
        id: el.id.replace("plannertool_", ""),
        text: (el.getAttribute("data-text") ?? el.textContent ?? "").trim().slice(0, 60),
        pro: String(el.className).includes("is_pro"),
        cls: String(el.className).slice(0, 100),
      });
    }
    return out;
  });
  console.log("all plannertool keys:", all.length);
  const interesting = all.filter((t) => {
    const s = JSON.stringify(t).toLowerCase();
    return /фигур|лини|рис|картин|изображен|draw|figure|picture|free|thick/.test(s);
  });
  console.log("interesting:", JSON.stringify(interesting, null, 1).slice(0, 4000));

  // 2. custom_plan_modal: открыть и дождаться загрузки
  await page.click("#groups_navi .groups_navi_item.add", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const modal = await page.evaluate(() => {
    const m = document.querySelector("#custom_plan_modal");
    if (!m) return { found: false };
    const afterPlanOptions = Array.from(m.querySelectorAll('[name="after_plan"] option')).map((o) => ({ value: o.getAttribute("value"), text: String(o.textContent ?? "").trim() }));
    const contentInputs = Array.from(m.querySelectorAll("input")).map((i) => ({ name: i.getAttribute("name"), value: i.getAttribute("value"), label: String((i.closest("label") ?? i.parentElement)?.textContent ?? "").trim().slice(0, 80), type: i.getAttribute("type") }));
    return { found: true, afterPlanOptions, contentInputs, html: m.outerHTML.slice(0, 20000) };
  });
  console.log("modal:", JSON.stringify(modal, null, 1).slice(0, 6000));
  writeFileSync(".orca-reports/tmp/375-sheets-ui2.json", JSON.stringify({
    _source: "анонимный проект (project_create), разметка редактора /planner/, scripts/probes/375-sheets-ui2.ts; id не печатаются",
    all, modal,
  }, null, 1) + "\n");
  console.log("saved .orca-reports/tmp/375-sheets-ui2.json");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 1200));
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
