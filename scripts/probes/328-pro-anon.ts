// 328 (разведка PRO-меток, БЕЗ записи в аккаунт): анонимный проект (project_create),
// дамп ВСЕХ #plannertool_* с классами is_pro из разметки редактора — эталон
// реестра PRO-инструментов (coverage.md §3). Аккаунт не используется.
// node scripts/probes/328-pro-anon.ts run
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
const client = new Client({ name: "328-pro-anon", version: "0.0.0" });
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
  const pro = await page.evaluate(() => {
    const pro: string[] = [];
    const plain: string[] = [];
    const titles: Record<string, string> = {};
    for (const el of Array.from(document.querySelectorAll("[id^=plannertool_]"))) {
      const key = String(el.id).replace("plannertool_", "");
      const t = el.getAttribute("data-text") ?? el.textContent ?? "";
      titles[key] = String(t).slice(0, 80);
      if (String(el.className).includes("is_pro")) pro.push(key); else plain.push(key);
    }
    // группы инструментов с is_pro
    const groupPro: string[] = [];
    for (const el of Array.from(document.querySelectorAll(".tools_group, [id^=toolgroup_], .tools_item_group"))) {
      const cls = String(el.className);
      const id = el.id || (el.querySelector("[id^=plannertool_]")?.id ?? "");
      if (cls.includes("is_pro") && id) groupPro.push(id.replace("plannertool_", ""));
    }
    return { pro: pro.sort(), plain: plain.sort(), groupPro: [...new Set(groupPro)].sort(), titles, total: pro.length + plain.length };
  });
  writeFileSync(".orca-reports/tmp/328-pro-anon.json", JSON.stringify({
    _source: "анонимный проект (project_create), разметка редактора /planner/, scripts/probes/328-pro-anon.ts; id не печатаются",
    pro: pro.pro, groupPro: pro.groupPro, total: pro.total, titles: pro.titles,
  }, null, 1) + "\n");
  console.log("PRO:", pro.pro.length, "из", pro.total, "groupPro:", pro.groupPro.length, "— .orca-reports/tmp/328-pro-anon.json");
  console.log("sample pro:", JSON.stringify(pro.pro.slice(0, 30)));
  console.log("ceiling keys:", JSON.stringify(["ceiling_hole", "floor_hole", "complex_ceiling", "ceiling_rigel", "zone_ceiling", "zone_floor", "zone_c", "molding", "ceiling_niche", "stretch_ceiling"].map((k) => ({ k, pro: pro.pro.includes(k) }))));
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 1200));
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
