// 88: проверка сессии и GET обоих проектов (только чтение). ID из env
// (REMPLANNER_PROBE_OBJECT_ID/PLAN, REMPLANNER_SNAPSHOT_OBJECT_ID/PLAN).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 300)}`);
  return JSON.parse(text(res as never));
}

async function main() {
  const ctx = new ServerContext();
  const server = buildServer(ctx);
  const client = new Client({ name: "88-check", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const auth = await call(client, "auth_status", {});
  console.log("auth:", JSON.stringify(auth).slice(0, 300));
  const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
  const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
  const SNAP_ID = process.env.REMPLANNER_SNAPSHOT_OBJECT_ID;
  const SNAP_PLAN = process.env.REMPLANNER_SNAPSHOT_PLAN_ID;
  for (const [label, obj, plan] of [["control", SNAP_ID, SNAP_PLAN], ["probe", OBJECT_ID, PLAN_ID]] as const) {
    if (!obj) continue;
    await call(client, "project_open", { object_id: obj, plan_id: plan ?? "1" });
    const m = await call(client, "model_get", { detail: "full" });
    console.log(label, "plan:", plan ?? "1", "counters:", JSON.stringify({
      walls: Object.keys(m.walls ?? {}).length,
      items: Object.keys(m.items ?? {}).length,
      rooms: Object.keys(m.rooms2 ?? {}).length,
      cables: Object.keys(m.cables ?? {}).length,
      sockets: Object.keys(m.sockets ?? {}).length ?? null,
      save_id: m.save_id,
    }), "model_keys:", Object.keys(m).sort().join(","));
  }
  await client.close();
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", String(e).slice(0, 600)); process.exit(1); });
