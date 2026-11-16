// 37-doors: отладка — какой тип нашей двери ломает $Project.restore в редакторе.
// Офлайн собираем модель (серверная + addOpening), в редакторе restore с бисекцией по типам.
import { readFileSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { addOpening } from "../../src/model/openings.ts";
import { prepareHolePoints } from "../../src/model/openings.ts";
import type { Model } from "../../src/model/types.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }
const session = { ...loadSession(STATE_PATH), account: true } as const;

// серверная модель одним GET
const { loadModel } = await import("../../src/api.ts");
const loaded = await loadModel(session, OBJECT_ID, PLAN_ID);
const base = loaded.model as any;

// собираем модель с 20 дверями через наш же модельный слой
const DOOR_KEYS = ["doorway","door","door_double","door_coupe","door_coupe_double","door_penal","door_penal_double","door_roto","door_roto_double","door_book","door_book_double","door_bellows","door_glass","door_garage","door_system_x2","door_system_x3","door_system_x4","door_system_penal_x2","door_system_penal_x3","door_system_penal_x4"];
const model = structuredClone(base) as any;
prepareHolePoints(model as any);
const JOBS: Record<string, any> = {
  doorway: { width_mm: 1000 }, door: { width_mm: 900, height_mm: 2200, swing: { hinge: "start", into: "left" } },
  door_double: { width_mm: 1400, swing: { hinge: "end", into: "right" } }, door_coupe: { width_mm: 1000, casing: false },
  door_coupe_double: { width_mm: 1700 }, door_penal: { width_mm: 900 }, door_penal_double: { width_mm: 1700, casing: false },
  door_roto: { width_mm: 1000 }, door_roto_double: { width_mm: 1700 }, door_book: { width_mm: 900, casing: false },
  door_book_double: { width_mm: 1700 }, door_bellows: { width_mm: 1300 }, door_glass: { width_mm: 1000, swing: { hinge: "end", into: "left" } },
  door_garage: { width_mm: 2500, height_mm: 2400 }, door_system_x2: { width_mm: 1800 }, door_system_x3: { width_mm: 2600, casing: false },
  door_system_x4: { width_mm: 3400 }, door_system_penal_x2: { width_mm: 1800 }, door_system_penal_x3: { width_mm: 1200, swing: { hinge: "start", into: "right" } },
  door_system_penal_x4: { width_mm: 1200 },
};
// ставим все двери на стену _nyxb3 (8000, почти пустая) или ndikcxe1sj
const targets = ["_nyxb3", "ndikcxe1sj", "li1umzwbk6", "lj04sk1h9w", "r7h8kkzli8", "eojq173ecf"];
const placedIds = new Map<string, string>(); // type -> hole id
for (const t of DOOR_KEYS) {
  const args = JOBS[t]!;
  let ok = false;
  for (const wid of targets) {
    const wall = model.walls[wid];
    if (!wall) continue;
    const len = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
    // ищем свободный центр
    const ax = { x: wall.p2.x - wall.p1.x, y: wall.p2.y - wall.p1.y };
    let cursor = wall.depth / 2 + 10;
    const rs = Object.values<any>(wall.holes ?? {}).map((h) => {
      const tt = ((h.pc.x - wall.p1.x) * ax.x + (h.pc.y - wall.p1.y) * ax.y) / (len * len);
      return [tt * len - h.width / 2, tt * len + h.width / 2] as [number, number];
    }).sort((a, b) => a[0] - b[0]);
    let center: number | null = null;
    for (const [s, e] of rs) {
      const need = (args.width_mm ?? 800) / 10;
      if (cursor + need + 10 <= s - 10) { center = cursor + need / 2; break; }
      cursor = Math.max(cursor, e + 10);
    }
    if (center === null && cursor + (args.width_mm ?? 800) / 10 <= len - wall.depth / 2 - 10) center = cursor + (args.width_mm ?? 800) / 20;
    if (center === null) continue;
    try {
      const hole = addOpening(model as any, {
        wallId: wid, type: t, centerMm: Math.round(center * 10),
        widthMm: args.width_mm, heightMm: args.height_mm, swing: args.swing,
        casing: args.casing,
      });
      placedIds.set(t, hole.id);
      ok = true;
      break;
    } catch { /* коллизия — следующая стена */ }
  }
  if (!ok) console.error("не размещён", t);
}
console.log("размещено:", placedIds.size);
const full = JSON.parse(JSON.stringify(model));

const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
try {
  const page = editor.page;
  const tryRestore = async (keep: string[]) => {
    return page.evaluate((payload) => {
      const w: any = window as any;
      const keepSet = new Set<string>(payload.keep);
      const m = JSON.parse(JSON.stringify(payload.model));
      for (const wall of Object.values<any>(m.walls)) {
        for (const hid of Object.keys(wall.holes ?? {})) {
          if (!keepSet.has(hid)) delete wall.holes[hid];
        }
      }
      try {
        w.$Project.restore(m);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, err: String(e?.stack || e).slice(0, 500) };
      }
    }, { model: full, keep } as any);
  };
  console.log("все 20:", JSON.stringify(await tryRestore([...placedIds.values()])));
  for (const [t, hid] of placedIds) {
    const r = await tryRestore([hid]);
    console.log(t, JSON.stringify(r).slice(0, 300));
    if (!(r as any).ok) {
      const wallId = Object.keys(full.walls).find((wid) => full.walls[wid].holes?.[hid]);
      writeFileSync(`.orca-reports/37-doors-ui/broken-hole-${t}.json`, JSON.stringify({ wall: wallId, hole: full.walls[wallId!].holes[hid] }, null, 1));
    }
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
