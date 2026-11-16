// 57-communications, проба 4: ventilation_hole и electric_shield_old (перебор позиций),
// панели свойств стояков (сдвиг правого клика). КЛИКИ ТОЛЬКО ЛОКАЛЬНО: save не вызывается.
// node scripts/probes/57-comm-ui4.ts
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, copyServer, diffModels } from "./phase2-lib.ts";
import type { P } from "./phase2-lib.ts";

const OUT = ".orca-reports/57-comm-ui";
const SHOTS = "../../screenshots";

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
    return { rooms, walls };
  });
  function inPoly(p: P, poly: P[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
      if (((yi > p.y) !== (yj > p.y)) && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function wallSpots(count: number): P[] {
    const out: P[] = [];
    for (let i = 0; i < geo.walls.length && out.length < count; i++) {
      const w = geo.walls[i]!;
      const dx = w.p2.x - w.p1.x, dy = w.p2.y - w.p1.y;
      const len = Math.hypot(dx, dy);
      if (len < 120) continue;
      const ux = dx / len, uy = dy / len;
      for (const t of [0.3, 0.7, 0.5]) {
        for (const inward of [w.depth / 2 + 8, w.depth / 2 + 20]) {
          out.push({ x: w.p1.x + ux * len * t + -uy * inward, y: w.p1.y + uy * len * t + ux * inward });
          if (out.length >= count) break;
        }
      }
    }
    return out;
  }

  async function tryClick(key: string, p: P): Promise<boolean> {
    const st = await pickTool(page, key);
    if (st !== "ok") return false;
    const b = await copyServer(page);
    await clickAt(page, p);
    const a = await copyServer(page);
    const diff = diffModels(b, a);
    let added = 0;
    for (const dv of Object.values<any>(diff)) added += Object.keys(dv.added ?? {}).length;
    return added > 0;
  }

  // 1. ventilation_hole: перебор точек у стен и в комнатах
  const vh: Record<string, unknown> = { tries: [] as unknown[] };
  await pickTool(page, "ventilation_hole");
  for (const p of wallSpots(10)) {
    const ok = await tryClick("ventilation_hole", p);
    (vh.tries as unknown[]).push({ p, ok });
    if (ok) break;
    await escape(page);
  }
  if (!(vh.tries as { ok: boolean }[]).some((t) => t.ok)) {
    // свободные точки внутри комнат
    for (const r of geo.rooms) {
      const xs = r.polygon.map((q: P) => q.x), ys = r.polygon.map((q: P) => q.y);
      const p = { x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2), y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2) };
      const ok = await tryClick("ventilation_hole", p);
      (vh.tries as unknown[]).push({ p, ok });
      if (ok) break;
      await escape(page);
    }
  }
  writeFileSync(`${OUT}/ventilation_hole-tries.json`, JSON.stringify(vh, null, 1) + "\n");
  console.log("ventilation_hole:", (vh.tries as { ok: boolean }[]).map((t) => t.ok).join(","));

  // 2. electric_shield_old: перебор точек у стен
  const es: Record<string, unknown> = { tries: [] as unknown[] };
  for (const p of wallSpots(14)) {
    const ok = await tryClick("electric_shield_old", p);
    (es.tries as unknown[]).push({ p, ok });
    if (ok) break;
    await escape(page);
  }
  writeFileSync(`${OUT}/electric_shield_old-tries.json`, JSON.stringify(es, null, 1) + "\n");
  console.log("electric_shield_old:", (es.tries as { ok: boolean }[]).map((t) => t.ok).join(","));

  // 3. панели стояков: поставить и правый клик с микросдвигами
  mkdirSync(SHOTS, { recursive: true });
  for (const key of ["water_column_cold", "heat_pipe", "gas_pipe", "radiator_old"]) {
    // свободная точка в самой большой комнате, но не в центре (там ригель)
    const r = [...geo.rooms].sort((a, b) => b.area - a.area)[0]!;
    const xs = r.polygon.map((q: P) => q.x), ys = r.polygon.map((q: P) => q.y);
    const p = { x: Math.round(Math.min(...xs) + 40), y: Math.round(Math.min(...ys) + 40) };
    await pickTool(page, key);
    const b = await copyServer(page);
    await clickAt(page, p);
    const a = await copyServer(page);
    const diff = diffModels(b, a);
    const added: Record<string, any> = {};
    for (const [coll, dv] of Object.entries(diff)) {
      for (const [id, o] of Object.entries<any>((dv as any).added ?? {})) added[`${coll}/${id}`] = o;
    }
    const first: any = Object.values(added)[0];
    const rec: Record<string, unknown> = { p, added };
    if (first?.pc) {
      for (const d of [0, 3, -3]) {
        await clickAt(page, { x: first.pc.x + d, y: first.pc.y + d }, "right");
        const cm = await dumpMenus(page);
        if (cm.some((m: any) => m.id === "cm-furniture")) { rec.cm = cm; rec.cmOffset = d; break; }
        await escape(page);
      }
    }
    writeFileSync(`${OUT}/${key}-panel2.json`, JSON.stringify(rec, null, 1) + "\n");
    console.log(key, "panel2 cm:", JSON.stringify(((rec.cm as any[]) ?? []).map((m) => m.id).slice(0, 8)));
    await escape(page);
  }
  console.log("done");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
