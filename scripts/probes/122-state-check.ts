// 122: сверка состояния после пробы (GET-only): dev-проект против бэкапа, контрольный проект.
import { chromium } from "playwright-core";
import { existsSync, readFileSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
const SNAP_ID = process.env.REMPLANNER_SNAPSHOT_OBJECT_ID;
const SNAP_PLAN = process.env.REMPLANNER_SNAPSHOT_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 5 * 60_000).unref();

const session = loadSession(STATE_PATH);
const shell = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: existsSync(shell) ? shell : undefined, headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, locale: "ru-RU" });
  await ctx.addCookies(session.cookies.map((c: any) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/",
    expires: c.expires === -1 ? undefined : c.expires, httpOnly: c.httpOnly ?? false, secure: c.secure ?? false,
  })));
  void ctx;
} finally {
  await browser.close().catch(() => {});
}

const strip = (m: any): string => {
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
    const e = Object.entries<any>(c[key]).map(([rid, r]) => [rid, si(r)] as const).sort((u, v) => JSON.stringify(u[1]).localeCompare(JSON.stringify(v[1])));
    c[key] = Object.fromEntries(e.map(([, v], i) => [`R${i}`, v]));
  }
  // R7 (ревью 123): warms_walls исключается только если это доказанно пустые
  // заглушки {exist:false}; реальное содержимое тёплой стены сверяется строго
  const emptyWarmsWalls = (v: any): boolean =>
    Array.isArray(v) && v.every((e) => e !== null && typeof e === "object" && Object.keys(e).length === 1 && e.exist === false);
  for (const r of Object.values<any>(c.rooms2 ?? {})) { if (emptyWarmsWalls(r.warms_walls)) delete r.warms_walls; for (const z of r.zones ?? []) delete z.number_by_area; }
  return JSON.stringify(nm(c));
};

const backup = JSON.parse(readFileSync(".orca-reports/backup-dev-122.json", "utf8"));
const devNow = await loadModel(session, OBJECT_ID, PLAN_ID);
console.log("dev-проект после пробы == бэкап (с исключениями этапа 122):", strip(devNow.model) === strip(backup.model) ? "OK" : "РАСХОЖДЕНИЕ");
if (SNAP_ID && SNAP_PLAN) {
  const snapNow = await loadModel(session, SNAP_ID, SNAP_PLAN);
  console.log("контрольный проект: GET выполнен, счётчики:", JSON.stringify({
    walls: Object.keys(snapNow.model.walls ?? {}).length,
    items: Object.keys(snapNow.model.items ?? {}).length,
    rooms: Object.keys(snapNow.model.rooms2 ?? {}).length,
  }));
}
process.exit(0);
