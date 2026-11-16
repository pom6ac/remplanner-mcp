// 25-windows: снимок проектов аккаунта только чтением (GET /setup/api/planner/).
// Без записи и без сохранения. Вывод: JSON {object_id, plan_id, save_id, model}.
// Запуск: node scripts/probes/25-snapshot.ts <object_id> <out.json> [plan_id]
import { writeFileSync } from "node:fs";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { loadModel } from "../../src/api.ts";

const [oid, outPath, planId = "1"] = process.argv.slice(2);
if (!oid || !outPath) {
  console.error("usage: node scripts/probes/25-snapshot.ts <object_id> <out.json> [plan_id]");
  process.exit(1);
}
const session = loadSession(STATE_PATH);
const res = await loadModel(session, oid, planId);
writeFileSync(outPath, JSON.stringify({
  _source: `GET /setup/api/planner/ object_id=${oid} plan_id=${res.plan_id}, scripts/probes/25-snapshot.ts, только чтение`,
  object_id: oid,
  plan_id: res.plan_id,
  save_id: res.save_id,
  model: res.model,
}, null, 1) + "\n");
console.log(JSON.stringify({ object_id: oid, plan_id: res.plan_id, save_id: res.save_id,
  model_bytes: JSON.stringify(res.model).length }));
