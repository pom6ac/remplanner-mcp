// 250: очистка leftover пробы — только по захваченным при создании site_id
// (ревью 251 №4, 253 Н1, инцидент 240): список читается из .orca-reports/tmp/250-created.json,
// который пишет 250-live-check (site_id + тип коллекции). Никакой очистки по коллекции
// целиком, по имени или по позиции. Перед каждым удалением объект ищется в свежей
// модели по site_id, удаляется по свежеразрешённой метке; объекта с site_id нет —
// ничего не удаляется, пропуск сообщается.
// Гард READONLY: OBJECT_ID !== READONLY_ID проверяется до project_open.
// Бэкап для контрольной сверки — из того же env, что у 250-live-check
// (REMPLANNER_PROBE_BACKUP, ревью 253 Н4), по умолчанию бэкап этапа 250.
// node scripts/probes/250-cleanup.ts run
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel } from "../../src/api.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { assertNoReadonlyCollision, assertTargetPair, readonlyGuard } from "./probe-guard.ts";

if (process.argv[2] !== "run") { console.error("запуск по аргументу run"); process.exit(0); }
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
if (!OBJECT_ID || !PLAN_ID) { console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID"); process.exit(1); }
if (!READONLY_ID) { console.error("нужен REMPLANNER_PROBE_READONLY_ID (гард ревью 251 №4)"); process.exit(1); }
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, null);
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 8 * 60_000).unref();

// ревью 253 Н1: в 250-created.json — site_id (+ тип коллекции у труб)
type Created = { items: string[]; walls: string[]; warm_floors: string[]; pipes: { coll: string; site_id: string }[]; wiring: string[] };
const CREATED_FILE = ".orca-reports/tmp/250-created.json";
const created = JSON.parse(readFileSync(CREATED_FILE, "utf8")) as Created;

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "250-cleanup", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content?: { type: string; text?: string }[] };
  if (res.isError) throw new Error(`${name}: ${(res.content ?? []).map((c) => c.text ?? "").join("").slice(0, 400)}`);
  return JSON.parse((res.content ?? []).find((c) => typeof c.text === "string")?.text ?? "{}") as Record<string, unknown>;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ревью 319 №3/№4: пара объект/план из env; эталон контрольного проекта фиксированный
await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
const roGuard = await readonlyGuard(ctx.session(), READONLY_ID, "1", ".orca-reports/tmp/250-readonly-ref.json");
await roGuard.assertUnchanged("перед зачисткой");
await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });

/**
 * Удаление строго по захваченному списку site_id: перед удалением объект ищется
 * в свежей модели по site_id (инцидент 240), удаляется по свежеразрешённой метке.
 * created-пары: (список {coll, site_id}, инструмент, аргумент).
 */
const deleteBySiteId = async (entries: { coll: string; site_id: string }[], tool: string, arg: string): Promise<number> => {
  let n = 0;
  for (const { coll, site_id } of [...entries].reverse()) {
    if (coll === "items") {
      // в компактном model_get у items нет site_id — существование и метка
      // берутся из свежей сырой модели (ключ items = site_id)
      const raw = (await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)) as unknown as { model: Record<string, Record<string, unknown>> };
      const idx = Object.keys(raw.model.items ?? {}).indexOf(site_id);
      if (idx < 0) { console.log(`пропуск: item ${site_id} не найден в свежей модели — ничего не удалено`); continue; }
      await call(tool, { [arg]: `I${idx + 1}` });
    } else {
      const mgNow = (await call("model_get", {})) as unknown as Record<string, { id?: string; site_id?: string }[]>;
      const found = (mgNow[coll] ?? []).find((o) => o.site_id === site_id);
      if (!found?.id) { console.log(`пропуск: ${coll} ${site_id} не найден в свежей модели — ничего не удалено`); continue; }
      await call(tool, { [arg]: found.id });
    }
    n++;
    console.log(`deleted ${coll} ${site_id}`);
  }
  return n;
};

const PIPE_COLLS = ["pipes_ventilation", "pipes_warm_floor", "pipes_conditioner", "pipes_heat"] as const;
await deleteBySiteId((created.wiring ?? []).map((site_id) => ({ coll: "cables_conditioner", site_id })), "wiring_delete", "wiring_id");
for (const coll of PIPE_COLLS) {
  await deleteBySiteId((created.pipes ?? []).filter((p) => p.coll === coll), "pipe_delete", "pipe_id");
}
await deleteBySiteId((created.warm_floors ?? []).map((site_id) => ({ coll: "warm_floors", site_id })), "warm_floor_delete", "warm_floor_id");
await deleteBySiteId((created.items ?? []).map((site_id) => ({ coll: "items", site_id })), "item_delete", "item_id");
await deleteBySiteId((created.walls ?? []).map((site_id) => ({ coll: "walls", site_id })), "wall_delete", "wall_id");

await sleep(6000);
const s = await call("project_save", {});
console.log("save:", JSON.stringify(s).slice(0, 200));
if (s["verified"] !== true) { console.error("save не verified"); process.exit(1); }

// ревью 253 Н4: бэкап из того же env, что у 250-live-check
const backup = JSON.parse(readFileSync(process.env["REMPLANNER_PROBE_BACKUP"] ?? ".orca-reports/backup-dev-250.json", "utf8"));
const after = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
const strip = (m: unknown) => {
  const c = structuredClone(m as Record<string, unknown>);
  delete c.save_id; delete c.log_plan; delete c.session; delete c.version;
  return JSON.stringify(c);
};
console.log("data == бэкап:", strip(after.model) === strip(backup.model) ? "OK — восстановлен" : "РАСХОЖДЕНИЕ");
// ревью 319 №4: контрольный проект сверяется с фиксированным эталоном после зачистки
await roGuard.checkFinal("после зачистки");
process.exit(strip(after.model) === strip(backup.model) ? 0 : 2);
