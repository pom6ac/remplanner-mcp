// 275: зачистка dev-проекта строго по захваченным site_id из 275-created.json.
// node scripts/probes/275-cleanup.ts run
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { assertNoReadonlyCollision, assertTargetPair, readonlyGuard, readonlyRefPath } from "./probe-guard.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу run");
  process.exit(0);
}
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
const READONLY_ID = process.env.REMPLANNER_PROBE_READONLY_ID;
const READONLY_PLAN_ID = process.env.REMPLANNER_PROBE_READONLY_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID и REMPLANNER_PROBE_READONLY_PLAN_ID (322 N3в)");
  process.exit(1);
}
// 322 N3в: коллизии env с контрольным проектом — отказ до любых запросов
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "275-cleanup", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = (await client.callTool({ name, arguments: args })) as ToolCallResult;
  if (res.isError) throw new Error(`${name}: ${(res.content ?? []).map((c) => c.text ?? "").join("").slice(0, 400)}`);
  return JSON.parse((res.content ?? []).find((c) => typeof c.text === "string")?.text ?? "{}") as Record<string, unknown>;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const created = JSON.parse(readFileSync(".orca-reports/tmp/275-created.json", "utf8")) as {
  items: string[]; walls: string[]; warm_walls: string[]; wiring: { coll: string; site_id: string }[];
};
console.log("created:", JSON.stringify(created));

// ревью 319 №3: пара объект/план из env до первой записи; 322 N3в: гард
// контрольного проекта (эталон общий на пару READONLY) перед записью
await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
const roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(OBJECT_ID, READONLY_ID, READONLY_PLAN_ID));
await roGuard.assertUnchanged("перед зачисткой");
await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
const mg = (await call("model_get", {})) as unknown as Record<string, Array<{ id?: string; site_id?: string }>>;
const present = (coll: string, siteId: string): boolean => (mg[coll] ?? []).some((o) => o.site_id === siteId);
for (const coll of ["walls", "items", "cables_warm_floor"]) {
  console.log(coll, "в рабочей модели:", (mg[coll] ?? []).length, "; из захваченных присутствуют:",
    (coll === "walls" ? created.walls : coll === "items" ? created.items : created.wiring.map((w) => w.site_id)).filter((s) => present(coll, s)).join(" ") || "—");
}

const deleteBySite = async (entries: (string | { coll: string; site_id: string })[], tool: string, arg: string): Promise<void> => {
  for (const entry of [...entries].reverse()) {
    const coll = typeof entry === "string" ? (tool === "wiring_delete" ? "cables_warm_floor" : tool === "item_delete" ? "items" : "walls") : entry.coll;
    const siteId = typeof entry === "string" ? entry : entry.site_id;
    const mgNow = (await call("model_get", {})) as unknown as Record<string, Array<{ id?: string; site_id?: string }>>;
    const found = (mgNow[coll] ?? []).find((o) => o.site_id === siteId);
    if (!found?.id) { console.log(`пропуск: ${coll} ${siteId} не найден`); continue; }
    await call(tool, { [arg]: found.id });
    console.log(`удалён ${coll} ${siteId} (${found.id})`);
  }
};
await deleteBySite(created.wiring, "wiring_delete", "wiring_id");
for (const siteId of [...created.warm_walls].reverse()) {
  const listRes = (await call("warm_wall_list", {})) as unknown as { warm_walls?: Array<{ id: string; label: string }> };
  const found = (listRes.warm_walls ?? []).find((x) => x.id === siteId);
  if (!found) { console.log(`пропуск: ww ${siteId}`); continue; }
  await call("warm_wall_delete", { warm_wall_id: found.label });
  console.log(`удалена ww ${siteId} (${found.label})`);
}
await deleteBySite(created.items, "item_delete", "item_id");
await deleteBySite(created.walls, "wall_delete", "wall_id");
await roGuard.assertUnchanged("перед save зачистки");
await new Promise((r) => setTimeout(r, 6000));
await roGuard.assertUnchanged("{tag}");
const s = await call("project_save", {});
console.log("save:", JSON.stringify(s).slice(0, 200));
if (s["verified"] !== true) throw new Error("save не verified");
await roGuard.checkFinal("после зачистки");

if (!process.env.REMPLANNER_PROBE_BACKUP) { console.error("нужен REMPLANNER_PROBE_BACKUP"); process.exit(1); }
const backup = JSON.parse(readFileSync(process.env.REMPLANNER_PROBE_BACKUP, "utf8")) as { model: Record<string, unknown> };
const strip = (m: unknown) => {
  const c = structuredClone(m as Record<string, unknown>);
  delete c.save_id; delete c.log_plan; delete c.session; delete c.version;
  return JSON.stringify(c);
};
const left = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
writeFileSync(".orca-reports/tmp/275-get-own-after.json", JSON.stringify(left, null, 1) + "\n");
console.log("data dev == бэкап:", strip(left.model) === strip(backup.model) ? "OK — восстановлен" : "РАСХОЖДЕНИЕ");
await closeBrowser().catch(() => {});
process.exit(0);
