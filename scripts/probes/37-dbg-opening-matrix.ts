// 37-doors: матрица restore — для каждого типа двери: без opening / "r" / "r-l".
import { readFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { loadModel } from "../../src/api.ts";
import { addOpening, prepareHolePoints } from "../../src/model/openings.ts";
import type { Model } from "../../src/model/types.ts";

const session = { ...loadSession(STATE_PATH), account: true } as const;
const loaded = await loadModel(session, "7887657", "1001798");
const TYPES = ["doorway","door","door_double","door_coupe","door_coupe_double","door_penal","door_penal_double","door_roto","door_roto_double","door_book","door_book_double","door_bellows","door_glass","door_garage","door_system_x2","door_system_x3","door_system_x4","door_system_penal_x2","door_system_penal_x3","door_system_penal_x4"];
// одна длинная пустая стена под все варианты
const WALL = "_nyxb3";
const results: Record<string, unknown> = {};
for (const t of TYPES) {
  results[t] = {};
  for (const opening of [undefined, "r", "l", "r-l", "l-r", "r-r", "l-l"] as const) {
    const model = structuredClone(loaded.model) as any;
    model.walls[WALL].holes ??= {};
    const hole = addOpening(model as Model, { wallId: WALL, type: t, centerMm: 1500, widthMm: ({ door_double: 1200, door_garage: 2000 } as Record<string, number>)[t] ?? 800 });
    if (opening !== undefined) hole.opening = opening; else delete hole.opening;
    prepareHolePoints(model as Model);
    results[t][String(opening)] = "pending";
  }
}
const editor = await openEditor(session, "7887657", "1001798", 60_000, { anonymous: false });
const tryRestore = (m: any) => editor.page.evaluate((mm) => {
  try { (window as any).$Project.restore(mm); return "ok"; } catch (e: any) { return "FAIL"; }
}, JSON.parse(JSON.stringify(m)));
try {
  for (const t of TYPES) {
    for (const opening of [undefined, "r", "l", "r-l", "l-r", "r-r", "l-l"] as const) {
      const model = structuredClone(loaded.model) as any;
      model.walls[WALL].holes ??= {};
      const hole = addOpening(model as Model, { wallId: WALL, type: t, centerMm: 1500, widthMm: ({ door_double: 1200, door_garage: 2000 } as Record<string, number>)[t] ?? 800 });
      if (opening !== undefined) hole.opening = opening; else delete hole.opening;
      prepareHolePoints(model as Model);
      results[t][String(opening)] = await tryRestore(model);
    }
  }
  console.log(JSON.stringify(results, null, 1));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
