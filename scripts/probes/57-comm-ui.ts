// 57-communications: постановка каждого пункта меню «Коммуникации» кликом в проект <REMPLANNER_PROBE_OBJECT_ID> (аккаунт, dev).
// КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается, на сервер ничего не пишется.
// Вывод: .orca-reports/57-comm-ui/<ключ>.json (diff модели, полные новые объекты, панель cm-*).
// node scripts/probes/57-comm-ui.ts
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, copyServer, diffModels, dragAt, type P } from "./phase2-lib.ts";

const OUT = ".orca-reports/57-comm-ui";
const SHOTS = "../../screenshots";

// видимые пункты меню «Коммуникации» на листе init (57-comm-dom2)
const TOOLS = [
  "water", "water_column_hot", "water_column_cold", "drainage_column", "ceiling_water",
  "heat_pipe", "radiator_old", "air", "ventilation_hole", "gas_pipe", "gas_line",
  "gas_boiler", "gas_meter", "electric_shield_old", "fire_detector", "conditioner_cage",
];

function dumpMenus(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => {
    const out: Record<string, unknown>[] = [];
    for (const el of Array.from(document.querySelectorAll("[id^='cm-']")) as HTMLElement[]) {
      if (!el.offsetParent && (el as HTMLInputElement).type !== "hidden") continue;
      const tag = el.tagName.toLowerCase();
      const rec: Record<string, unknown> = { id: el.id, tag, value: (el as HTMLInputElement).value ?? el.textContent?.trim() };
      if (tag === "select") rec.options = Array.from((el as HTMLSelectElement).options).map((o) => ({ v: o.value, t: o.textContent?.trim() }));
      out.push(rec);
    }
    return out;
  });
}

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");

  // точки: центры комнат из rooms2 (или габарит модели), раскладка по сетке
  const spots = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    const rooms = Object.values<any>((m as any).rooms2 ?? {});
    const centers: P[] = rooms.map((r) => ({ x: Math.round(r.pc.x), y: Math.round(r.pc.y) }));
    if (!centers.length) {
      const walls = Object.values<any>(m.walls ?? {});
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const w of walls) {
        minX = Math.min(minX, w.p1.x, w.p2.x); maxX = Math.max(maxX, w.p1.x, w.p2.x);
        minY = Math.min(minY, w.p1.y, w.p2.y); maxY = Math.max(maxY, w.p1.y, w.p2.y);
      }
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
        centers.push({ x: Math.round((minX + maxX) / 2 + dx * 100), y: Math.round((minY + maxY) / 2 + dy * 100) });
    }
    return centers;
  });
  console.log("spots:", JSON.stringify(spots));
  if (!spots.length) { console.error("нет точек"); process.exit(1); }

  const before = await copyServer(page);
  const summary: Record<string, unknown> = {};

  for (let i = 0; i < TOOLS.length; i++) {
    const key = TOOLS[i]!;
    const spot = spots[i % spots.length]!;
    const p: P = { x: spot.x + (i % 3) * 10, y: spot.y + Math.floor(i / 3) * 8 };
    const st = await pickTool(page, key);
    const rec: Record<string, unknown> = { pick: st, spot: p };
    if (st === "ok") {
      const b = await copyServer(page);
      await clickAt(page, p);
      let a = await copyServer(page);
      let how = "click";
      if (JSON.stringify(b) === JSON.stringify(a)) {
        // возможно, тянется линия — drag
        await escape(page);
        await pickTool(page, key);
        const b2 = await copyServer(page);
        await dragAt(page, p, { x: p.x + 150, y: p.y + 50 });
        a = await copyServer(page);
        how = "drag";
        if (JSON.stringify(b2) === JSON.stringify(a)) how = "none";
      }
      rec.how = how;
      const diff = diffModels(b, a);
      rec.diff_keys = Object.keys(diff);
      rec.diff = diff;
      const added: Record<string, any> = {};
      for (const [coll, dv] of Object.entries(diff)) {
        for (const [id, o] of Object.entries<any>((dv as any).added ?? {})) added[`${coll}/${id}`] = o;
      }
      rec.added = added;
      // правый клик по центру добавленного объекта: панель свойств
      const first = Object.values(added)[0] as any;
      if (first) {
        const c: P = first.pc ? { x: first.pc.x, y: first.pc.y }
          : first.p1 && first.p2 ? { x: (first.p1.x + first.p2.x) / 2, y: (first.p1.y + first.p2.y) / 2 } : p;
        await clickAt(page, c, "right");
        rec.cm = await dumpMenus(page);
        await escape(page);
      }
      await page.screenshot({ path: `${SHOTS}/57-${key}.png` });
    }
    summary[key] = rec;
    writeFileSync(`${OUT}/${key}.json`, JSON.stringify(rec, null, 1) + "\n");
    console.log(key, st, rec.how ?? "", "diff_keys:", JSON.stringify(rec.diff_keys ?? []));
    await escape(page);
  }
  const after = await copyServer(page);
  writeFileSync(`${OUT}/_full-diff.json`, JSON.stringify(diffModels(before, after), null, 1) + "\n");
  console.log("done");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
