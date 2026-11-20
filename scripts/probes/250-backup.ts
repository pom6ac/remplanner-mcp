// 250: бэкап dev-проекта и контрольного проекта до работ. GET only.
// node scripts/probes/250-backup.ts run
import { writeFileSync, existsSync, statSync } from "node:fs";
import { loadModel } from "../../src/api.ts";
import { ServerContext } from "../../src/server/context.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу run (ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
const READONLY_ID = process.env.REMPLANNER_PROBE_READONLY_ID || process.env.REMPLANNER_SNAPSHOT_OBJECT_ID;
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID");
  process.exit(1);
}
if (OBJECT_ID === READONLY_ID) {
  console.error("OBJECT_ID === READONLY_ID — отказ до любой записи");
  process.exit(1);
}
const ctx = new ServerContext();
const session = ctx.session();
mkdirSafe(".orca-reports");
function mkdirSafe(_p: string) {}
const own = await loadModel(session, OBJECT_ID, PLAN_ID);
const ownPath = ".orca-reports/backup-dev-250.json";
if (!existsSync(ownPath)) {
  writeFileSync(ownPath, JSON.stringify(own, null, 1) + "\n");
  console.log("бэкап dev:", ownPath, statSync(ownPath).size, "байт; стен:", Object.keys(own.model.walls ?? {}).length, "предметов:", Object.keys(own.model.items ?? {}).length, "rooms2:", Object.keys(own.model.rooms2 ?? {}).length);
} else {
  console.log("бэкап dev уже есть:", ownPath);
}
const ro = await loadModel(session, READONLY_ID, "1");
const roPath = `.orca-reports/tmp/250-get-readonly-before.json`;
writeFileSync(roPath, JSON.stringify(ro, null, 1) + "\n");
console.log("контрольный GET:", roPath, statSync(roPath).size, "байт");
process.exit(0);
