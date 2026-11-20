// 64: разовая зачистка сущностей пробы 64 в dev-проекте (ID из env).
// wall_delete идёт через applyWalls и блокируется заранее существующими свободными узлами
// стен dev-проекта, поэтому удаление делается прямым apply + save (та же верификация save).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { refuseLegacyProbe } from "./probe-guard.ts";
refuseLegacyProbe(); // 322 N3г: старая пишущая проба без гардов — запуск запрещён

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID!;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID!;
function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 400)}`);
  return JSON.parse(text(res as never));
}
async function main() {
  const ctx = new ServerContext();
  const server = buildServer(ctx);
  const client = new Client({ name: "64-cleanup", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const ws = ctx.workspace();
  const removed = ws.apply("64-cleanup", (m) => {
    const out = { borders: 0, holes: 0, columns: 0, fences: 0 };
    for (const key of ["terrace_borders", "territory_borders"] as const) {
      out.borders += Object.keys(m[key] ?? {}).length;
      delete m[key];
    }
    out.holes = Object.keys(m.level_holes ?? {}).length;
    delete m.level_holes;
    for (const [id, p] of Object.entries(m.pillars)) {
      if ((p as { role?: string }).role === "terrace_column") { delete m.pillars[id]; out.columns++; }
    }
    for (const [id, w] of Object.entries(m.walls)) {
      if ((w as { role?: string }).role === "terrace_fence") { delete m.walls[id]; out.fences++; }
    }
    return out;
  });
  console.log("removed:", JSON.stringify(removed));
  const saved = await ws.save();
  console.log("cleanup save verified:", saved.verified, "rounds:", saved.rounds);
  await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after = await call(client, "model_get", { detail: "full" });
  console.log("after:", JSON.stringify({
    walls: Object.keys(after.walls ?? {}).length,
    terr: Object.keys(after.terrace_borders ?? {}).length,
    holes: Object.keys(after.level_holes ?? {}).length,
    tcols: Object.values(after.pillars ?? {}).filter((p: any) => p.role === "terrace_column").length,
  }));
  await client.close();
}
main().catch((e) => { console.error("FAIL:", String(e).slice(0, 600)); process.exit(1); });
