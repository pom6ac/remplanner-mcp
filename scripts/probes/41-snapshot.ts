// 41-pillars: снимок проекта одним GET (бэкап/сверка). ID только из env, без env — выход до API.
// node scripts/probes/41-snapshot.ts <путь-вывода>
import { writeFileSync } from "node:fs";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { loadModel } from "../../src/api.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID.");
  process.exit(1);
}
const out = process.argv[2];
if (!out) { console.error("usage: 41-snapshot.ts <out.json>"); process.exit(1); }

const session = { ...loadSession(STATE_PATH), account: true } as const;
const loaded = await loadModel(session, OBJECT_ID, PLAN_ID);
writeFileSync(out, JSON.stringify(loaded, null, 1) + "\n");
console.log(JSON.stringify({
  object_id: loaded.object_id, plan_id: loaded.plan_id, save_id: loaded.save_id,
  data_empty: loaded.data_empty ?? false,
  pillars: Object.keys((loaded.model as any).pillars ?? {}).length,
  walls: Object.keys((loaded.model as any).walls ?? {}).length,
}));
