// 375 (разведка, ч.4, БЕЗ записи): откуда load_v2_modal_from_id берёт HTML окна
// custom_plan_modal — дамп соседних узлов, шаблонов и fetch-ответов.
// node scripts/probes/375-sheets-ui4.ts run
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
const client = new Client({ name: "375-sheets-ui4", version: "0.0.0" });
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
  const responses: string[] = [];
  page.on("response", (r) => { responses.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 140)}`); });
  await page.waitForTimeout(1500);
  // открыть окно и логировать ВСЕ ответы сети
  await page.click("#groups_navi .groups_navi_item.add", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(5000);
  console.log("responses after click add:", responses.slice(-15).join("\n"));
  const html = await page.evaluate(() => {
    const m = document.querySelector("#custom_plan_modal");
    const tmpl = Array.from(document.querySelectorAll("template, script[type^='text/html'], script[type^='text/x-template']"))
      .map((t) => `${t.tagName}#${t.id ?? ""}:${t.innerHTML.length}`).join(" | ");
    const windows = (window as unknown as { modals?: unknown; MODALS?: unknown; v2_modals?: unknown });
    return {
      modalHtml: m ? m.outerHTML.slice(0, 20000) : null,
      templates: tmpl,
      hasWindowsModals: [!!windows.modals, !!windows.MODALS, !!windows.v2_modals],
    };
  });
  console.log("modal outerHTML len:", html.modalHtml?.length);
  console.log("templates:", html.templates.slice(0, 500));
  writeFileSync(".orca-reports/tmp/375-sheets-ui4.json", JSON.stringify({
    _source: "анонимный проект (project_create), scripts/probes/375-sheets-ui4.ts; id не печатаются",
    html,
    responses: responses.slice(-40),
  }, null, 1) + "\n");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 1200));
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
