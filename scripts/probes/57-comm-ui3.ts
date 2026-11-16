// 57-communications, проба 3: все 16 пунктов в ОДНОЙ сессии, панель свойств (cm-*) точным правым
// кликом по фактическому pc сразу после постановки. КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается.
// node scripts/probes/57-comm-ui3.ts
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, copyServer, diffModels, dragAt } from "./phase2-lib.ts";
import type { P } from "./phase2-lib.ts";

const OUT = ".orca-reports/57-comm-ui";
const SHOTS = "../../screenshots";

const TOOLS = [
  "water", "water_column_hot", "water_column_cold", "drainage_column", "ceiling_water",
  "heat_pipe", "radiator_old", "air", "ventilation_hole", "gas_pipe", "gas_line",
  "gas_boiler", "gas_meter", "electric_shield_old", "fire_detector", "conditioner_cage",
];
const WALL_ANCHORED = new Set(["ceiling_water", "electric_shield_old", "conditioner_cage"]);

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

  const geo = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    const rooms = Object.values<any>((m as any).rooms2 ?? {}).map((r: any) => ({ polygon: r.polygon, area: r.area }));
    const walls = Object.values<any>(m.walls ?? {}).map((w: any) => ({ p1: w.p1, p2: w.p2, depth: w.depth, holes: w.holes ?? {} }));
    const items = Object.values<any>(m.items ?? {}).map((it: any) => ({ pc: it.pc }));
    return { rooms, walls, items };
  });
  const placed: P[] = [];
  let usedWallIdx = 0;

  function inPoly(p: P, poly: P[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
      if (((yi > p.y) !== (yj > p.y)) && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function freeSpot(): P {
    for (const r of geo.rooms) {
      const xs = r.polygon.map((q: P) => q.x), ys = r.polygon.map((q: P) => q.y);
      for (let x = Math.ceil(Math.min(...xs)); x <= Math.max(...xs); x += 25) {
        for (let y = Math.ceil(Math.min(...ys)); y <= Math.max(...ys); y += 25) {
          const p = { x, y };
          if (!inPoly(p, r.polygon)) continue;
          if (!placed.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 150)) continue;
          return p;
        }
      }
    }
    throw new Error("нет свободных точек");
  }
  function wallSpot(): P {
    const w = geo.walls[usedWallIdx++ % geo.walls.length]!;
    const dx = w.p2.x - w.p1.x, dy = w.p2.y - w.p1.y;
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    const face = w.depth / 2 + 8;
    return { x: w.p1.x + ux * len * 0.5 + -uy * face, y: w.p1.y + uy * len * 0.5 + ux * face };
  }

  for (const key of TOOLS) {
    const st = await pickTool(page, key);
    const rec: Record<string, unknown> = { pick: st };
    if (st === "ok") {
      const b = await copyServer(page);
      const isLine = key === "gas_line";
      if (isLine) {
        const p1 = freeSpot(), p2 = { x: p1.x + 150, y: p1.y + 50 };
        await dragAt(page, p1, p2);
        placed.push(p1);
      } else {
        const p = WALL_ANCHORED.has(key) ? wallSpot() : freeSpot();
        await clickAt(page, p);
        placed.push(p);
      }
      const a = await copyServer(page);
      const diff = diffModels(b, a);
      const added: Record<string, any> = {};
      for (const [coll, dv] of Object.entries(diff)) {
        for (const [id, o] of Object.entries<any>((dv as any).added ?? {})) added[`${coll}/${id}`] = o;
      }
      rec.added = added;
      const first = Object.values(added)[0] as any;
      if (first) {
        const c: P = first.pc ? { x: first.pc.x, y: first.pc.y }
          : first.vertexes ? { x: (first.vertexes[0].point.x + first.vertexes[1].point.x) / 2, y: (first.vertexes[0].point.y + first.vertexes[1].point.y) / 2 } : null;
        if (c) {
          // что под точкой правого клика
          rec.under = await page.evaluate(async (pt) => {
            const svg: any = document.querySelector("#main_svg");
            const r = svg.getBoundingClientRect();
            const q = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
            const sx = r.x + ((pt.x - q[0]) * r.width) / q[2], sy = r.y + ((pt.y - q[1]) * r.height) / q[3];
            const el = document.elementFromPoint(sx, sy) as HTMLElement | null;
            return { sx, sy, tag: el?.tagName ?? null, cls: el?.getAttribute("class")?.slice(0, 120) ?? null };
          }, c);
          await clickAt(page, c, "right");
          rec.cm = await dumpMenus(page);
          await escape(page);
        }
      }
      await page.screenshot({ path: `${SHOTS}/57-${key}.png` });
    }
    writeFileSync(`${OUT}/${key}.json`, JSON.stringify(rec, null, 1) + "\n");
    console.log(key, st, "added:", JSON.stringify(Object.keys(rec.added ?? {})), "cm:", JSON.stringify((rec.cm as any[] ?? []).map((m) => m.id).slice(0, 8)));
    await escape(page);
  }
  console.log("done");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
