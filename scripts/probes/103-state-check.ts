// 103-state: проверка состояния проектов (после прерывания запуска и т.п.). Только GET, без записи.
// dev-проект (REMPLANNER_PROBE_OBJECT_ID/PLAN) — сверка data с бэкапом (1-й аргумент, JSON {_source, model});
// контрольный (REMPLANNER_SNAPSHOT_OBJECT_ID/PLAN) — сверка со снимком (2-й аргумент, JSON {data}).
// Исключения: walls.*.eds2.*.*.id (служебные ID граней) — режим strict; и (режим reported, прецедент 94)
// session/log_plan и регенерируемые id комнат. Общий watchdog 8 минут → exit 90; таймаут вызова 150 с → exit 91.
// Запуск: node scripts/probes/103-state-check.ts <backup.json> <snapshot.json>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
const SNAP_ID = process.env.REMPLANNER_SNAPSHOT_OBJECT_ID;
const SNAP_PLAN = process.env.REMPLANNER_SNAPSHOT_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID || !SNAP_ID || !SNAP_PLAN) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID/PLAN и REMPLANNER_SNAPSHOT_OBJECT_ID/PLAN");
  process.exit(1);
}

const WATCHDOG = setTimeout(() => {
  console.error("TIMEOUT: общий watchdog 8 минут истёк");
  process.exit(90);
}, 8 * 60_000);
WATCHDOG.unref();

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const t = setTimeout(() => {
    console.error(`TIMEOUT: вызов ${name} не ответил за 150 с`);
    process.exit(91);
  }, 150_000);
  t.unref();
  const res = await client.callTool({ name, arguments: args });
  clearTimeout(t);
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 600)}`);
  return JSON.parse(text(res as never));
}

function diffPaths(a: any, b: any, path = "", out: string[] = []): string[] {
  if (out.length > 200) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { out.push(path || "<root>"); return out; }
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) diffPaths(a?.[k], b?.[k], path ? `${path}.${k}` : k, out);
  return out;
}

const EDS2_ID = /^walls\.[^.]+\.eds2\.(l|r)\.\d+\.id$/;
const VOLATILE = new Set(["session", "log_plan"]);
const ROOM_INNER_ID = /^(rooms[12]\.[^.]+\..*)\.id$/;

/** strict: исключение только walls.*.eds2.*.*.id. reported: + session/log_plan и id комнат (прецедент 94). */
function prepare(m: any, mode: "strict" | "reported"): string {
  const c = structuredClone(m);
  if (mode === "reported") for (const k of VOLATILE) delete c[k];
  const walk = (v: any, p: string): any => {
    if (Array.isArray(v)) return v.map((e, i) => walk(e, `${p}.${i}`));
    if (v === null || typeof v !== "object") return v;
    const o: any = {};
    for (const [k, val] of Object.entries(v)) {
      const kp = p ? `${p}.${k}` : k;
      if (EDS2_ID.test(kp)) continue;
      if (mode === "reported" && ROOM_INNER_ID.test(kp)) continue;
      o[k] = walk(val, kp);
    }
    return o;
  };
  const c2 = walk(c, "");
  if (mode === "reported") {
    for (const key of ["rooms1", "rooms2"]) {
      if (c2[key] && typeof c2[key] === "object") {
        const entries = Object.entries<any>(c2[key]).sort((u, v) => JSON.stringify(u[1]).localeCompare(JSON.stringify(v[1])));
        c2[key] = Object.fromEntries(entries.map(([, v], i) => [`ROOM${i + 1}`, v]));
      }
    }
  }
  return JSON.stringify(c2);
}

function compare(label: string, current: any, reference: any) {
  for (const mode of ["strict", "reported"] as const) {
    const same = prepare(current, mode) === prepare(reference, mode);
    console.log(`${label} [${mode}]:`, same ? "OK" : "РАСХОЖДЕНИЕ");
    if (!same) {
      const d = diffPaths(current, reference).filter((p) => !EDS2_ID.test(p) && (mode === "strict" || !VOLATILE.has(p.split(".")[0]!)));
      console.log(`  путей (без eds2): ${d.length}`);
      console.log("  примеры:", d.slice(0, 15).join(" | "));
    }
  }
}

const server = buildServer(new ServerContext());
const client = new Client({ name: "103-state", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

const backupPath = process.argv[2];
const snapPath = process.argv[3];
if (!backupPath || !snapPath) { console.error("usage: 103-state-check.ts <backup.json> <snapshot.json>"); process.exit(1); }
try {
  await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const dev = await call(client, "model_get", { detail: "full" });
  console.log("dev GET ok; counters:", JSON.stringify({
    walls: Object.keys(dev.walls ?? {}).length, pillars: Object.keys(dev.pillars ?? {}).length,
    items: Object.keys(dev.items ?? {}).length, rooms2: Object.keys(dev.rooms2 ?? {}).length,
  }));
  const backup = JSON.parse(readFileSync(backupPath, "utf8")).model;
  compare("dev vs backup", dev, backup);

  await call(client, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
  const ctrl = await call(client, "model_get", { detail: "full" });
  const snapRaw = JSON.parse(readFileSync(snapPath, "utf8"));
  const snap = typeof snapRaw.data === "string" ? JSON.parse(snapRaw.data) : (snapRaw.model ?? snapRaw.data);
  compare("контрольный vs snapshot", ctrl, snap);
  console.log("103-state done");
} finally {
  await client.close();
  process.exit(process.exitCode ?? 0);
}
