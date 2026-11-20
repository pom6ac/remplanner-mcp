// 250: очистка leftover пробы — только по захваченным при создании ID
// (ревью 251 №4, инцидент 240): список читается из .orca-reports/tmp/250-created.json,
// который пишет 250-live-check. Никакой очистки по коллекции целиком, по имени
// или по позиции. Перед каждым удалением ID ищется в свежем model_get
// (метки позиционные и пересчитываются после каждого удаления).
// Гард READONLY: OBJECT_ID !== READONLY_ID проверяется до project_open.
// node scripts/probes/250-cleanup.ts run
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel } from "../../src/api.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

if (process.argv[2] !== "run") { console.error("запуск по аргументу run"); process.exit(0); }
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
if (!OBJECT_ID || !PLAN_ID) { console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID"); process.exit(1); }
if (!READONLY_ID) { console.error("нужен REMPLANNER_PROBE_READONLY_ID (гард ревью 251 №4)"); process.exit(1); }
if (OBJECT_ID === READONLY_ID) {
  console.error("OBJECT_ID === READONLY_ID — отказ до любой записи");
  process.exit(1);
}
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 8 * 60_000).unref();

type Created = { items: string[]; walls: string[]; warm_floors: string[]; pipes: string[]; wiring: string[] };
const CREATED_FILE = ".orca-reports/tmp/250-created.json";
const created = JSON.parse(readFileSync(CREATED_FILE, "utf8")) as Created;

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "250-cleanup", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${res.content?.map((c) => ("text" in c ? c.text : "")).join("")?.slice(0, 400)}`);
  return JSON.parse(res.content?.find((c) => "text" in c)?.text ?? "{}") as Record<string, unknown>;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type C = { id?: string; name?: string };
const mg = async (): Promise<Record<string, C[]>> => (await call("model_get", {})) as unknown as Record<string, C[]>;

await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });

/**
 * Удаление строго по захваченному списку ID: перед удалением ID ищется в свежем
 * model_get (метки позиционные, инцидент 240); объект вне списка не удаляется.
 * created-пары: (коллекция model_get, список ID, инструмент, аргумент).
 */
const PAIRS: [string, string[], string, string][] = [
  ["cables_conditioner", created.wiring ?? [], "wiring_delete", "wiring_id"],
  ["pipes_ventilation", created.pipes ?? [], "pipe_delete", "pipe_id"],
  ["pipes_heat", created.pipes ?? [], "pipe_delete", "pipe_id"],
  ["pipes_conditioner", created.pipes ?? [], "pipe_delete", "pipe_id"],
  ["pipes_warm_floor", created.pipes ?? [], "pipe_delete", "pipe_id"],
  ["warm_floors", created.warm_floors ?? [], "warm_floor_delete", "warm_floor_id"],
  ["items", created.items ?? [], "item_delete", "item_id"],
  ["walls", created.walls ?? [], "wall_delete", "wall_id"],
];
for (const [coll, ids, tool, arg] of PAIRS) {
  for (const id of [...ids].reverse()) {
    const present = ((await mg())[coll] ?? []).some((o) => o.id === id);
    if (!present) continue; // уже удалён каскадом/прежним прогоном
    await call(tool, { [arg]: id });
    console.log(`deleted ${coll} ${id}`);
  }
}

await sleep(6000);
const s = await call("project_save", {});
console.log("save:", JSON.stringify(s).slice(0, 200));
if (s["verified"] !== true) { console.error("save не verified"); process.exit(1); }

const backup = JSON.parse(readFileSync(".orca-reports/backup-dev-250.json", "utf8"));
const after = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
const strip = (m: unknown) => {
  const c = structuredClone(m as Record<string, unknown>);
  delete c.save_id; delete c.log_plan; delete c.session;
  return JSON.stringify(c);
};
console.log("data == бэкап:", strip(after.model) === strip(backup.model) ? "OK — восстановлен" : "РАСХОЖДЕНИЕ");
process.exit(strip(after.model) === strip(backup.model) ? 0 : 2);
