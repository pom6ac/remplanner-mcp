// Живая проверка T7 без входа в аккаунт: анонимный проект создаётся по HTTP, модель читается.
// Запуск: node scripts/check-live-anon.ts
import { createAnonProject, loadModel } from "../src/api.ts";
import type { SessionState } from "../src/session.ts";

const session: SessionState = { cookies: [] };
const created = await createAnonProject(session);
console.log("anon project created:", JSON.stringify(created));
console.log("cookies:", session.cookies.map((c) => c.name).join(", "));
const loaded = await loadModel(session, created.object_id, created.plan_id || "1");
const walls = Object.keys((loaded.model["walls"] as Record<string, unknown>) ?? {}).length;
console.log("model loaded:", { object_id: loaded.object_id, save_id: loaded.save_id, units: loaded.units, walls });
if (walls !== 0) {
  console.error("FAIL: у нового проекта должны быть пустые стены");
  process.exit(1);
}
console.log("OK: живой цикл create → load по HTTP работает (анонимно)");
