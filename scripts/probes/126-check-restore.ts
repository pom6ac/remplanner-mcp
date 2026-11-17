// 126-check-restore: сверка текущего GET dev-проекта с бэкапом (strip как в пробе 122/126)
import { readFileSync } from "node:fs";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { loadModel } from "../../src/api.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("нужны env"); process.exit(1); }

function strip(m: any): string {
  const c = structuredClone(m);
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "final", "signals", "smeta_water_pipes", "save_id", "is_forced"]) delete c[k];
  for (const k of ["borders", "drawings"]) {
    if (Array.isArray(c[k])) c[k] = [...c[k]].map((e: any) => JSON.stringify(e)).sort().map((s: string) => JSON.parse(s));
  }
  const stripIds = (v: any): any => {
    if (Array.isArray(v)) return v.map(stripIds);
    if (v !== null && typeof v === "object") {
      const o: any = {};
      for (const [k, val] of Object.entries(v)) o[k] = k === "id" && typeof val === "string" ? "<regen>" : stripIds(val);
      return o;
    }
    return v;
  };
  const norm = (v: any): any => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      const out: any = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  if (c.walls && typeof c.walls === "object") {
    for (const [wid, wall] of Object.entries<any>(c.walls)) {
      if (wall?.eds2) c.walls[wid].eds2 = stripIds(wall.eds2);
      // пустой контейнер проёмов: нативный save редактора поле не пишет; непустой
      // holes остаётся в сверке (потеря проёмов не маскируется)
      if (wall?.holes && typeof wall.holes === "object" && !Array.isArray(wall.holes) && Object.keys(wall.holes).length === 0) delete c.walls[wid].holes;
    }
  }
  for (const key of ["rooms1", "rooms2"]) {
    if (c[key] && typeof c[key] === "object") {
      const entries = Object.entries<any>(c[key]).map(([rid, r]) => [rid, stripIds(r)] as const)
        .sort((u, v) => JSON.stringify(u[1]).localeCompare(JSON.stringify(v[1])));
      c[key] = Object.fromEntries(entries.map(([, v], i) => [`ROOM${i + 1}`, v]));
    }
  }
  const emptyWarmsWalls = (v: unknown): boolean =>
    Array.isArray(v) && v.every((e) => e !== null && typeof e === "object" && Object.keys(e).length === 1 && (e as { exist?: unknown }).exist === false);
  for (const r of Object.values<any>(c.rooms2 ?? {})) {
    if (emptyWarmsWalls(r.warms_walls)) delete r.warms_walls;
    for (const z of r.zones ?? []) delete z.number_by_area;
  }
  return JSON.stringify(norm(c));
}

function diffKeysOf(a: any, b: any, path = "", out: string[] = []): string[] {
  if (out.length > 50) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { out.push(path || "<root>"); return out; }
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) diffKeysOf(a?.[k], b?.[k], path ? `${path}.${k}` : k, out);
  return out;
}

const backup = (JSON.parse(readFileSync(".orca-reports/tmp/backup-dev-126.json", "utf8")) as { model: any }).model;
const now = await loadModel(loadSession(STATE_PATH), OBJECT_ID, PLAN_ID);
const same = strip(now.model) === strip(backup);
console.log(same ? "OK — модель совпала с бэкапом" : "РАСХОЖДЕНИЕ");
if (!same) {
  const b = JSON.parse(strip(backup));
  const n = JSON.parse(strip(now.model));
  console.log("пути:", diffKeysOf(b, n).slice(0, 20).join(" | "));
}
process.exit(same ? 0 : 1);
