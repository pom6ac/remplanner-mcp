// 126-restore: разовый откат имени комнаты в dev-проекте после пробы 126
// (REMPLANNER_PROBE_OBJECT_ID/PLAN из env). Переименование как в UI (проба 43) + editor.save.
// Ревью 127 N1: общий watchdog, close в finally при любом исходе, явный closeBrowser.
import { openEditor } from "../../src/editor/adapter.ts";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID");
  process.exit(1);
}

const WATCHDOG_MS = 5 * 60_000;
const watchdog = setTimeout(() => {
  console.error(`WATCHDOG: ${WATCHDOG_MS / 1000} с — принудительный выход`);
  process.exit(9);
}, WATCHDOG_MS);

let exitCode = 0;
let editor: Awaited<ReturnType<typeof openEditor>> | null = null;
try {
  const session = loadSession(STATE_PATH);
  const before = await loadModel(session, OBJECT_ID, PLAN_ID);
  const rooms = (before.model.rooms2 ?? {}) as Record<string, any>;
  const probeRooms = Object.entries(rooms).filter(([, r]) => String(r?.zones?.[0]?.name ?? "").startsWith("Проба 126"));
  console.log("комнат с именем пробы:", probeRooms.map(([id]) => id));
  if (probeRooms.length === 0) {
    console.log("откат не нужен");
  } else {
    editor = await openEditor(session, OBJECT_ID, PLAN_ID);
    const page = (editor as unknown as { page: import("playwright-core").Page }).page;
    for (const [rid, room] of probeRooms) {
      let original = String(room.zones[0].name);
      while (original.startsWith("Проба 126 (")) original = original.slice("Проба 126 (".length, -1);
      const res = await page.evaluate(({ roomId, newName }: { roomId: string; newName: string }) => {
        const w = window as unknown as Record<string, any>;
        const r = w.ROOMS2?.[roomId];
        const z = (r?.zones ?? [])[0];
        if (!z) return { err: "нет зоны" };
        z.name = newName;
        z.zone_name = newName;
        try { z.draw?.(); } catch { /* ignore */ }
        w.selected.room = r;
        w.selected.zone = z;
        w.project.localSave();
        return { roomId, name: z.name };
      }, { roomId: rid, newName: original });
      console.log("откат в редакторе:", JSON.stringify(res));
    }
    const saveRes = await editor.save();
    console.log("editor.save:", JSON.stringify({ ok: saveRes.ok, conflict: saveRes.conflict }));
  }
} catch (e) {
  exitCode = 1;
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 400));
} finally {
  await editor?.close().catch(() => {});
  editor = null;
  await closeBrowser().catch(() => {});
  clearTimeout(watchdog);
  if (exitCode === 0) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const session = loadSession(STATE_PATH);
      const after = await loadModel(session, OBJECT_ID, PLAN_ID);
      const rooms2 = (after.model.rooms2 ?? {}) as Record<string, any>;
      console.log("имена после отката:", Object.entries(rooms2).map(([id, r]) => `${id}=${r?.zones?.[0]?.name}`));
    } catch (e) {
      console.error("FAIL (после отката):", String((e as Error).message ?? e).slice(0, 400));
      exitCode = 1;
    }
  }
  process.exit(exitCode);
}
