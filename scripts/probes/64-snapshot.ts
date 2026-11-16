// GET-снимок модели проекта (только чтение): project_open + model_get full → файл.
// ID из env REMPLANNER_PROBE_OBJECT_ID / REMPLANNER_PROBE_PLAN_ID; вывод в argv[2].
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFileSync } from "node:fs";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID!;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID!;
const OUT = process.argv[2]!;

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 500)}`);
  return JSON.parse(text(res as never));
}

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "snapshot", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
const model = await call(client, "model_get", { detail: "full" });
writeFileSync(OUT, JSON.stringify({
  _source: "GET через project_open + model_get (только чтение), проект из env, scripts/probes/64-snapshot.ts",
  model,
}, null, 1));
console.log("snapshot ok:", OUT, "walls:", Object.keys(model.walls ?? {}).length,
  "terr:", Object.keys(model.terrace_borders ?? {}).length,
  "holes:", Object.keys(model.level_holes ?? {}).length,
  "save_id:", model.save_id);
await client.close();
