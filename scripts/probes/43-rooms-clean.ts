// 43-fix-pillars, №4 вспомогательный: очистить dev-проект (по бэкапу он был пуст)
// и сохранить. ID только из env. Запуск: node scripts/probes/43-rooms-clean.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ServerContext } from "../../src/server/context.ts";
import { buildServer } from "../../src/server.ts";
import { refuseLegacyProbe } from "./probe-guard.ts";
refuseLegacyProbe(); // 322 N3г: старая пишущая проба без гардов — запуск запрещён

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID");
  process.exit(1);
}

type Res = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as Res).content as { text: string }[])[0]!.text;

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "43-rooms-clean", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

console.log("open:", text(await client.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } })));
console.log("clear:", text(await client.callTool({ name: "project_clear", arguments: { confirm: true } })));
console.log("save:", text(await client.callTool({ name: "project_save", arguments: {} })));
await ctx.workspaceOrNull?.close().catch(() => {});
process.exit(0);
