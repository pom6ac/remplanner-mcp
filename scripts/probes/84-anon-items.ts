// 84: живой круг item_add в АНОНИМНОМ проекте для светильников без UI-эталона
// (hanging_lightspot*, hanging_light_double/triple, armstrong_light): ставятся ли,
// переживают ли save/reopen. node scripts/probes/84-anon-items.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 400)}`);
  return JSON.parse(text(res as never));
}

const NAMES = [
  "hanging_lightspot", "hanging_lightspot_double", "hanging_lightspot_triple",
  "hanging_light_double", "hanging_light_triple", "armstrong_light", "lightspot", "bra",
];

async function main() {
  const ctx = new ServerContext();
  const server = buildServer(ctx);
  const client = new Client({ name: "84-anon", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  const created = await call(client, "project_create", {});
  console.log("project:", created.object_id ?? JSON.stringify(created).slice(0, 120));
  await call(client, "walls_add_polyline", {
    points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }],
    closed: true,
  });
  await call(client, "wall_add", { start: { x: 2000, y: 0 }, end: { x: 2000, y: 3000 } });

  const ws = ctx.workspace();
  const ids: Record<string, string> = {};
  for (const name of NAMES) {
    try {
      const pos = name === "bra"
        ? { against_wall: { wall_id: Object.keys(ws.model.walls)[0]!, offset_mm: 1000 } }
        : { center: { x: 1000 + (Object.keys(ids).length % 4) * 600, y: 600 + Math.floor(Object.keys(ids).length / 4) * 900 } };
      await call(client, "item_add", { name, position: pos });
      ids[name] = Object.keys(ws.model.items).slice(-1)[0]!;
      const it = ws.model.items[ids[name]!] as any;
      console.log(name, "OK", JSON.stringify({ w: it.width, h: it.height, sh: it.self_height, of: JSON.stringify(it.over_floor), plan: JSON.stringify(it.plan) }));
    } catch (e) {
      console.log(name, "FAIL:", String((e as Error).message).replace(/\s+/g, " ").slice(0, 160));
    }
  }
  // шаг 5 с между сохранениями не нужен до save
  await call(client, "model_validate", {});
  const saved = await ws.save();
  console.log("save:", `verified=${saved.verified}, rounds=${saved.rounds}, will_delete=${JSON.stringify(saved.will_delete)}`);
  if (!saved.verified) throw new Error("save не verified");

  await call(client, "project_open", { object_id: ws.project!.objectId, plan_id: ws.project!.planId });
  const after = await call(client, "model_get", { detail: "full" });
  for (const [name, id] of Object.entries(ids)) {
    const it = (after.items as any)[id];
    console.log(name, it ? `пережил reopen (${it.width}x${it.height}, over_floor=${JSON.stringify(it.over_floor)})` : "ПОТЕРЯН при reopen");
  }
  await client.close();
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", String(e).slice(0, 800)); process.exit(1); });
