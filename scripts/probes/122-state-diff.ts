// 122: диагностика расхождения dev-GET с бэкапом (GET-only).
import { readFileSync, writeFileSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 5 * 60_000).unref();

const session = loadSession(STATE_PATH);
const now = await loadModel(session, OBJECT_ID, PLAN_ID);
writeFileSync(".orca-reports/tmp-dev-now.json", JSON.stringify(now, null, 1));
const backup = JSON.parse(readFileSync(".orca-reports/backup-dev-122.json", "utf8"));

const strip = (m: any): any => {
  const c = structuredClone(m);
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "final", "signals", "smeta_water_pipes", "save_id", "is_forced"]) delete c[k];
  for (const k of ["borders", "drawings"]) if (Array.isArray(c[k])) c[k] = [...c[k]].map((e: any) => JSON.stringify(e)).sort().map((s: string) => JSON.parse(s));
  const si = (v: any): any => {
    if (Array.isArray(v)) return v.map(si);
    if (v !== null && typeof v === "object") { const o: any = {}; for (const [k, val] of Object.entries(v)) o[k] = k === "id" && typeof val === "string" ? "<regen>" : si(val); return o; }
    return v;
  };
  const nm = (v: any): any => {
    if (Array.isArray(v)) return v.map(nm);
    if (v !== null && typeof v === "object") { const o: any = {}; for (const k of Object.keys(v).sort()) o[k] = nm(v[k]); return o; }
    return v;
  };
  if (c.walls) for (const [wid, wall] of Object.entries<any>(c.walls)) {
    if (wall?.eds2) c.walls[wid].eds2 = si(wall.eds2);
    // пустой holes редактор после save не пишет (отсутствие ключа == пустой объект)
    if (wall && wall.holes !== undefined && Object.keys(wall.holes).length === 0) delete wall.holes;
  }
  for (const key of ["rooms1", "rooms2"]) if (c[key]) {
    const e = Object.entries<any>(c[key]).map(([rid, r]: any) => [rid, si(r)] as const).sort((u: any, v: any) => JSON.stringify(u[1]).localeCompare(JSON.stringify(v[1])));
    c[key] = Object.fromEntries(e.map(([, v]: any, i: number) => [`R${i}`, v]));
  }
  for (const r of Object.values<any>(c.rooms2 ?? {})) { delete r.warms_walls; for (const z of r.zones ?? []) delete z.number_by_area; }
  return nm(c);
};
const A = strip(backup.model);
const B = strip(now.model);
console.log("equal:", JSON.stringify(A) === JSON.stringify(B));
const diffs: string[] = [];
function walk(x: any, y: any, p: string): void {
  if (diffs.length > 25) return;
  if (x === y) return;
  if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) { diffs.push(`${p}: ${JSON.stringify(x)?.slice(0, 100)} != ${JSON.stringify(y)?.slice(0, 100)}`); return; }
  const ks = new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})]);
  for (const k of ks) walk(x?.[k], y?.[k], `${p}.${k}`);
}
walk(A, B, "");
console.log(diffs.slice(0, 25).join("\n"));
process.exit(0);
