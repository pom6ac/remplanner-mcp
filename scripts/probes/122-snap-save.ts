// 122: снимок контрольного проекта (GET-only) — для сверки «до/после» всей работы.
import { writeFileSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

const SNAP_ID = process.env.REMPLANNER_SNAPSHOT_OBJECT_ID;
const SNAP_PLAN = process.env.REMPLANNER_SNAPSHOT_PLAN_ID;
if (!SNAP_ID || !SNAP_PLAN) { console.error("env?"); process.exit(1); }
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 5 * 60_000).unref();
const session = loadSession(STATE_PATH);
const m = await loadModel(session, SNAP_ID, SNAP_PLAN);
writeFileSync(".orca-reports/tmp-snap-122.json", JSON.stringify({ _source: "GET-only снимок контрольного проекта, 122", model: m.model }, null, 1));
console.log("snapshot ok; walls:", Object.keys(m.model.walls ?? {}).length, "items:", Object.keys(m.model.items ?? {}).length);
process.exit(0);
