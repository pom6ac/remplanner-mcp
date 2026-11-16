// 43-fix-pillars, №4: как редактор хранит включённую отделку пола (floors) — структура
// DATA_FLOORS и следы на комнате. Ничего не пишет на сервер.
import { openEditor } from "../../src/editor/adapter.ts";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID");
  process.exit(1);
}

const session = loadSession(STATE_PATH);
const editor = await openEditor(session, OBJECT_ID, PLAN_ID);
const page = (editor as unknown as { page: import("playwright-core").Page }).page;

const info = await page.evaluate(() => {
  const w = window as unknown as Record<string, any>;
  const df = w.DATA_FLOORS;
  const sample = (o: any, d = 0): any => {
    if (o === null || typeof o !== "object") return typeof o === "function" ? "[fn]" : o;
    if (d > 3) return "[deep]";
    if (Array.isArray(o)) return o.slice(0, 3).map((x) => sample(x, d + 1));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).slice(0, 25)) out[k] = sample(o[k], d + 1);
    return out;
  };
  const fl = w.$FloorLining;
  return {
    dataFloors: sample(df),
    floorLining: fl ? { keys: Object.keys(fl).slice(0, 30), proto: Object.getOwnPropertyNames(Object.getPrototypeOf(fl) ?? {}).slice(0, 30) } : null,
    warmFloors: sample(w.WARM_FLOORS),
  };
});
console.log(JSON.stringify(info, null, 1).slice(0, 6000));
await editor.close();
process.exit(0);
