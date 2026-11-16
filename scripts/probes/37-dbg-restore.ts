// 37-doors: отладка — редактор отверг модель после save. Бисекция по проёмам: какой тип ломает restore.
import { readFileSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }
const session = { ...loadSession(STATE_PATH), account: true } as const;

// серверная модель (как сохранилась)
const res = await fetch(`https://remplanner.ru/setup/api/planner/?object_id=${OBJECT_ID}&plan_id=${PLAN_ID}`, {
  headers: { cookie: Object.entries(loadSession(STATE_PATH).cookies ?? {}).map(([k, v]) => `${k}=${v}`).join("; ") },
}).catch(() => null);
const raw = res ? await res.text() : null;
if (!res || !raw) { console.error("GET не удался"); process.exit(1); }
const data = JSON.parse(raw);
const model = typeof data.data === "string" ? JSON.parse(data.data) : data.data;
console.log("save_id:", data.save_id, "стен:", Object.keys(model.walls ?? {}).length);
const holes: { wall: string; id: string; type: string }[] = [];
for (const [wid, w] of Object.entries<any>(model.walls ?? {})) {
  for (const [hid, h] of Object.entries<any>(w.holes ?? {})) holes.push({ wall: wid, id: hid, type: h.type });
}
console.log("проёмов:", holes.length, JSON.stringify(holes.map((h) => h.type)));
writeFileSync(".orca-reports/37-doors-ui/saved-model.json", JSON.stringify(model, null, 1));

// восстановление в редакторе с бисекцией
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
try {
  const page = editor.page;
  const tryRestore = async (holesToKeep: string[]) => {
    return page.evaluate((payload) => {
      const w: any = window as any;
      const keep = new Set<string>(payload.keep);
      const model = JSON.parse(JSON.stringify(payload.model));
      for (const wall of Object.values<any>(model.walls)) {
        for (const hid of Object.keys(wall.holes ?? {})) {
          if (!keep.has(hid)) delete wall.holes[hid];
        }
      }
      try {
        w.$Project.restore(model);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, err: String(e?.stack || e).slice(0, 400) };
      }
    }, { model, keep: [...holesToKeep] } as any);
  };
  // все проёмы
  const all = holes.map((h) => h.id);
  console.log("все:", JSON.stringify(await tryRestore(all)));
  // по одному типу: только pre-existing (не наши 20) — Baseline
  const doorTypes = ["doorway","door","door_double","door_coupe","door_coupe_double","door_penal","door_penal_double","door_roto","door_roto_double","door_book","door_book_double","door_bellows","door_glass","door_garage","door_system_x2","door_system_x3","door_system_x4","door_system_penal_x2","door_system_penal_x3","door_system_penal_x4"];
  for (const t of doorTypes) {
    const sel = holes.filter((h) => h.type === t);
    if (sel.length === 0) continue;
    const r = await tryRestore(sel.map((h) => h.id));
    console.log(t, JSON.stringify(r).slice(0, 250));
    if (!(r as any).ok) { writeFileSync(`.orca-reports/37-doors-ui/broken-${t}.json`, JSON.stringify(sel, null, 1)); }
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
