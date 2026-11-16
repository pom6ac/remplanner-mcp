// 43-fix-pillars, №4 шаг 1: комната в dev-проекте (id из env) → save → reopen → rooms2.
// ID только из env (REMPLANNER_PROBE_OBJECT_ID/PLAN_ID). Проект dev, запись разрешена.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ServerContext } from "../../src/server/context.ts";
import { buildServer } from "../../src/server.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID");
  process.exit(1);
}

type Res = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as Res).content as { text: string }[])[0]!.text;
const json = (r: unknown): any => JSON.parse(text(r));

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "43-rooms-setup", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

console.log("open:", text(await client.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } })));
console.log("room_add_rect:", text(await client.callTool({ name: "room_add_rect", arguments: { origin: { x: 0, y: 0 }, width: 4000, depth: 3000, wall_thickness: 200 } })));
console.log("save:", text(await client.callTool({ name: "project_save", arguments: {} })));
await client.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } });
const full = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
const rooms2 = full.rooms2 ?? {};
console.log("rooms2 после reopen:", Object.keys(rooms2).length);
for (const [id, r] of Object.entries<any>(rooms2)) {
  console.log(" room", id, "zones:", (r.zones ?? []).map((z: any) => ({ name: z.name, area: z.area })), "floorsExist:", (r.floors ?? []).map((f: any) => f.exist));
}
console.log("rooms_list:", text(await client.callTool({ name: "rooms_list", arguments: {} })));
await ctx.workspaceOrNull?.close().catch(() => {});
process.exit(0);
