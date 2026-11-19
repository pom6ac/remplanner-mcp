// 250: очистка leftover пробы — пошагово, с model_get перед КАЖДЫМ удалением
// (метки позиционные и пересчитываются после каждого удаления — инцидент 240):
// трубы климата удаляются по меткам из свежего снимка, предметы — по имени,
// стены пробы — по позиции после 22 пользовательских стен. Save, сверка с бэкапом.
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
if (!OBJECT_ID || !PLAN_ID) { console.error("нужны env"); process.exit(1); }
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 8 * 60_000).unref();

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

const deleteFirst = async (key: string, kind: string, tool: string, arg: string): Promise<boolean> => {
  const mg0 = await mg();
  const first = (mg0[key] ?? [])[0];
  if (!first?.id) return false;
  await call(tool, { [arg]: first.id });
  console.log(`deleted ${kind} ${first.id}`);
  return true;
};
while (await deleteFirst("cables_conditioner", "CC", "wiring_delete", "wiring_id")) {}
while (await deleteFirst("cables_socket", "CS", "wiring_delete", "wiring_id")) {} // в исходной модели слаботочных нет
while (await deleteFirst("pipes_heat", "PH", "pipe_delete", "pipe_id")) {}
while (await deleteFirst("pipes_conditioner", "PC", "pipe_delete", "pipe_id")) {}
while (await deleteFirst("pipes_warm_floor", "PW", "pipe_delete", "pipe_id")) {}
while (await deleteFirst("warm_floors", "WF", "warm_floor_delete", "warm_floor_id")) {}

// предметы пробы — по имени (radiator_bimetal/conditioner/conditioner_engine
// в этом плане только у пробы; пользовательских таких нет)
const SCRATCH_ITEMS = ["radiator_bimetal", "conditioner", "conditioner_engine"];
for (const name of SCRATCH_ITEMS) {
  for (;;) {
    const mg0 = await mg();
    const found = (mg0.items ?? []).find((it) => it.name === name);
    if (!found?.id) break;
    await call("item_delete", { item_id: found.id });
    console.log(`deleted item ${found.id} (${name})`);
  }
}

// стены пробы — позиции после 22 пользовательских стен (проба добавила 4, комнаты было 5)
for (;;) {
  const mg0 = await mg();
  const walls = mg0.walls ?? [];
  if (walls.length <= 22) break;
  if (walls.length > 30) throw new Error(`число стен ${walls.length} > 30 — структура не та, отмена`);
  await call("wall_delete", { wall_id: walls[22]!.id });
  console.log(`deleted wall ${walls[22]!.id}`);
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
