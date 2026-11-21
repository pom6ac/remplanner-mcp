// 328 (разведка PRO-меток по листам, БЕЗ записи в аккаунт): анонимный проект,
// обход всех листов навигации, дамп ВИДИМЫХ #plannertool_* с is_pro по каждому
// листу — эталон реестра PRO-инструментов (coverage.md §3).
// node scripts/probes/328-pro-sheets.ts run
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

if (process.argv[2] !== "run") { console.error("запуск: run"); process.exit(0); }
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "328-pro-sheets", version: "0.0.0" });
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
  await page.waitForTimeout(2000);
  const nav = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".groups_navi_item"))
      .map((el) => ({ cls: String(el.className).replace("groups_navi_item", "").trim(), text: (el.textContent ?? "").trim() }))
      .filter((x) => x.cls && x.cls !== "add"),
  );
  const perSheet: Record<string, { pro: string[]; plain: string[] }> = {};
  for (const n of nav) {
    await page.evaluate((cls: string) => {
      const el: any = document.querySelector(`.groups_navi_item.${CSS.escape(cls)}`);
      if (el) el.click();
    }, n.cls);
    await page.waitForTimeout(1600);
    const dump = await page.evaluate(() => {
      const pro: string[] = [];
      const plain: string[] = [];
      for (const el of Array.from(document.querySelectorAll("[id^=plannertool_]"))) {
        if ((el as HTMLElement).offsetParent === null) continue;
        const key = String(el.id).replace("plannertool_", "");
        if (String(el.className).includes("is_pro")) pro.push(key); else plain.push(key);
      }
      return { pro, plain };
    });
    perSheet[n.cls] = dump;
    console.log(n.cls, n.text, "pro:", dump.pro.length, "plain:", dump.plain.length, JSON.stringify(dump.pro.slice(0, 12)));
  }
  writeFileSync(".orca-reports/tmp/328-pro-sheets.json", JSON.stringify({
    _source: "анонимный проект (project_create), обход листов редактора, scripts/probes/328-pro-sheets.ts; id не печатаются",
    perSheet,
  }, null, 1) + "\n");
  console.log("SAVED .orca-reports/tmp/328-pro-sheets.json");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 1200));
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
