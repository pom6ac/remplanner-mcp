// 37-doors: отладка — door_coupe без opening ломает restore; с opening — ок?
//
// Проект для пробы задаётся env; без env — выход до обращения к API (как в пробах 25-*).
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID: проба открывает указанный проект.");
  process.exit(1);
}
import { readFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { loadModel } from "../../src/api.ts";

const session = { ...loadSession(STATE_PATH), account: true } as const;
const loaded = await loadModel(session, OBJECT_ID, PLAN_ID);
const broken = JSON.parse(readFileSync(".orca-reports/37-doors-ui/broken-hole-door_coupe.json", "utf8"));
const model = loaded.model as any;
model.walls[broken.wall].holes ??= {}; model.walls[broken.wall].holes[broken.hole.id] = { ...broken.hole, opening: "r-l" };
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
const tryRestore = (m: any) => editor.page.evaluate((mm) => {
  try { (window as any).$Project.restore(mm); return { ok: true }; } catch (e: any) { return { ok: false, err: String(e).slice(0, 200) }; }
}, JSON.parse(JSON.stringify(m)));
try {
  console.log("coupe + opening r-l:", JSON.stringify(await tryRestore(model)));
  delete model.walls[broken.wall].holes[broken.hole.id].opening;
  console.log("coupe без opening:", JSON.stringify(await tryRestore(model)));
  model.walls[broken.wall].holes[broken.hole.id].opening = "r";
  console.log("coupe + opening r:", JSON.stringify(await tryRestore(model)));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
