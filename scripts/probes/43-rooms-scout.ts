// 43-fix-pillars, №4: разведка в dev-проекте (id из env) — как редактор хранит имя комнаты
// и отделку (напольное покрытие). Ничего не сохраняет на сервер без явного localSave,
// ID проекта/плана — только из env (REMPLANNER_PROBE_OBJECT_ID/PLAN_ID).
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

const info = await page.evaluate(async () => {
  const w = window as unknown as Record<string, any>;
  const rid = Object.keys(w.ROOMS2 ?? {})[0];
  if (!rid) return { err: "нет ROOMS2" };
  const r = w.ROOMS2[rid];
  const z = (r.zones ?? [])[0];
  // методы room/zone, связанные с именем и полом
  const fns = (o: any) => {
    const out: string[] = [];
    let cur = o;
    for (let i = 0; i < 3 && cur; i++) {
      for (const k of Object.getOwnPropertyNames(cur)) {
        try { if (typeof cur[k] === "function" && /floor|finish|name|zone/i.test(k)) out.push(k); } catch { /* ignore */ }
      }
      cur = Object.getPrototypeOf(cur);
    }
    return [...new Set(out)];
  };
  // как выглядит floors при существующем покрытии: ищем признак в конструкторе/defs
  const floorDefs = w.DEFS?.floor ?? w.defs?.floor ?? null;
  return {
    roomId: rid,
    roomKeys: Object.keys(r),
    zoneKeys: z ? Object.keys(z) : null,
    zoneName: z?.name,
    floors: r.floors,
    roomFns: fns(r),
    zoneFns: z ? fns(z) : null,
    floorDefs: floorDefs ? Object.keys(floorDefs).slice(0, 20) : null,
    globalFloorFns: Object.keys(w).filter((k) => /floor|finish/i.test(k)).slice(0, 20),
  };
});
console.log(JSON.stringify(info, null, 1));
await editor.close();
process.exit(0);
