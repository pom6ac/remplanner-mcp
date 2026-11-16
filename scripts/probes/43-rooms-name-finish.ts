// 43-fix-pillars, №4 шаг 2: задать комнате имя и отделку пола через объекты редактора
// (как это делает UI), затем проверить, что save редактора переносит это на сервер.
// Запуск: REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… node scripts/probes/43-rooms-name-finish.ts
import { openEditor } from "../../src/editor/adapter.ts";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID");
  process.exit(1);
}
const ROOM_ID = process.env.REMPLANNER_PROBE_ROOM_ID ?? "";

const session = loadSession(STATE_PATH);
const editor = await openEditor(session, OBJECT_ID, PLAN_ID);
const page = (editor as unknown as { page: import("playwright-core").Page }).page;

const res = await page.evaluate(async (roomId: string) => {
  const w = window as unknown as Record<string, any>;
  const rid = roomId || Object.keys(w.ROOMS2 ?? {})[0];
  if (!rid) return { err: "нет ROOMS2" };
  const r = w.ROOMS2[rid];
  const z = (r.zones ?? [])[0];
  if (!z) return { err: "нет зоны" };
  z.name = "Гостиная";
  z.zone_name = "Гостиная";
  if (r.floors?.[0]) {
    r.floors[0].exist = true;
  }
  try { z.draw?.(); } catch { /* ignore */ }
  try { r.drawFloors?.(); } catch { /* ignore */ }
  w.selected.room = r;
  w.selected.zone = z;
  w.project.localSave();
  await new Promise((res) => setTimeout(res, 1200));
  const snap = (w as any).__snap ? Object.values(w.__snap(w.project.copy("server")).rooms2 ?? {}) : [];
  return {
    roomId: rid,
    copyRooms: (snap as any[]).map((x) => ({ id: x.id, name: x.name, floorsExist: (x.floors ?? []).map((f: any) => f.exist) })),
  };
}, ROOM_ID);
console.log("результат в редакторе:", JSON.stringify(res, null, 1));

// дать автосейву редактора дойти до сервера, затем прочитать модель по HTTP
await new Promise((res) => setTimeout(res, 4000));
const m = await loadModel(session, OBJECT_ID, PLAN_ID);
const r2 = (m.model.rooms2 ?? {}) as Record<string, any>;
for (const [id, r] of Object.entries(r2)) {
  console.log("сервер:", id, "name:", r.name, "zones:", (r.zones ?? []).map((z: any) => z.name), "floorsExist:", (r.floors ?? []).map((f: any) => f.exist));
}
await editor.close();
process.exit(0);
