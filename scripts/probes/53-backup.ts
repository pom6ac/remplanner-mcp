// 53-stairs: бэкап dev-проекта до изменений и снимок рабочего проекта (только GET, записей нет).
// Имена файлов — из ID из env (в git ID проектов не попадают, отчёты вне git).
// node scripts/probes/53-backup.ts  (ID только из env)
import { writeFileSync } from "node:fs";
import { loadModel } from "../../src/api.ts";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";

const DEV_OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const DEV_PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
const WORK_OBJECT_ID = process.env.REMPLANNER_PROBE_WORK_OBJECT_ID;
const WORK_PLAN_ID = process.env.REMPLANNER_PROBE_WORK_PLAN_ID;
if (!DEV_OBJECT_ID || !DEV_PLAN_ID || !WORK_OBJECT_ID || !WORK_PLAN_ID) {
  console.error("env?"); process.exit(1);
}

const session = loadSession(STATE_PATH);
const mode = process.argv[2] ?? "all";

if (mode === "dev" || mode === "all") {
  const dev = await loadModel(session, DEV_OBJECT_ID, DEV_PLAN_ID);
  writeFileSync(`../../.orca-reports/backup-${DEV_OBJECT_ID}-53.json`, JSON.stringify({ object_id: dev.object_id, plan_id: dev.plan_id, save_id: dev.save_id, data: JSON.stringify(dev.model) }, null, 1) + "\n");
  console.log("dev backup: save_id", dev.save_id, "data_len", JSON.stringify(dev.model).length);
}
if (mode === "work" || mode === "all") {
  const work = await loadModel(session, WORK_OBJECT_ID, WORK_PLAN_ID);
  const suffix = process.argv[3] ?? "";
  const path = `../../.orca-reports/snapshot-${WORK_OBJECT_ID}-53${suffix}.json`;
  writeFileSync(path, JSON.stringify({ object_id: work.object_id, plan_id: work.plan_id, save_id: work.save_id, data: JSON.stringify(work.model) }, null, 1) + "\n");
  console.log(`work snapshot ${suffix || "before"} -> ${path}: save_id ${work.save_id}, data_len ${JSON.stringify(work.model).length}`);
}
