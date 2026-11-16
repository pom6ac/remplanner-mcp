// 53-stairs, проба 2: виды, не поставившиеся одиночным кликом (drag, у стены),
// и панели свойств (cm-*) точным правым кликом по pc предмета.
// КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается. node scripts/probes/53-stairs-ui2.ts
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, dragAt, escape, pickTool, switchSheet, copyServer, diffModels } from "./phase2-lib.ts";
import type { P } from "./phase2-lib.ts";

const OUT = ".orca-reports/53-stairs-ui";
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

  // геометрия: центры комнат и ближайшая к центру стена (для anchor:wall)
  const geo = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    const rooms = Object.values<any>((m as any).rooms2 ?? {});
    const centers: P[] = rooms.map((r) => ({ x: Math.round(r.pc.x), y: Math.round(r.pc.y) }));
    const walls = Object.values<any>(m.walls ?? {}).map((w) => ({ p1: w.p1, p2: w.p2, depth: w.depth }));
    return { centers, walls };
  });
  const centers = geo.centers as P[];
  if (!centers.length) { console.error("нет комнат"); process.exit(1); }
  const big = centers[0]!; // самая большая комната (rooms2 отсортированы по площади? берём первую)
  const wall = geo.walls[0]!;

  async function place(key: string, act: (spot: P) => Promise<void>, label: string, spot: P) {
    const st = await pickTool(page, key);
    const rec: Record<string, unknown> = { pick: st, spot };
    if (st === "ok") {
      const b = await copyServer(page);
      await act(spot);
      const a = await copyServer(page);
      const diff = diffModels(b, a);
      const added: Record<string, any> = {};
      for (const [coll, dv] of Object.entries(diff)) {
        for (const [id, o] of Object.entries<any>((dv as any).added ?? {})) added[`${coll}/${id}`] = o;
      }
      rec.diff_keys = Object.keys(diff);
      rec.added = added;
      const first = Object.values(added)[0] as any;
      if (first) {
        const c: P = first.pc ? { x: first.pc.x, y: first.pc.y } : spot;
        await clickAt(page, c, "right");
        rec.cm = await dumpMenus(page);
        await escape(page);
      }
      await page.screenshot({ path: `${SHOTS}/53-${key}-${label}.png` });
    }
    writeFileSync(`${OUT}/${key}-${label}.json`, JSON.stringify(rec, null, 1) + "\n");
    console.log(key, label, st, "diff:", JSON.stringify(rec.diff_keys ?? []));
    await escape(page);
  }

  // точки у стены: на грани стены внутри комнаты (для anchor:wall)
  const dx = wall.p2.x - wall.p1.x, dy = wall.p2.y - wall.p1.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  const wallPt = (t: number, inward: number): P => ({ x: wall.p1.x + ux * len * t + -uy * inward, y: wall.p1.y + uy * len * t + ux * inward });

  // 1. upper_march — drag внутри комнаты (и одиночный клик как контроль)
  await place("upper_march", async (s) => { await clickAt(page, s); }, "click", big);
  await place("upper_march", async (s) => { await dragAt(page, s, { x: s.x + 150, y: s.y }); }, "drag", big);
  // 2. porch — клик у стены и drag вдоль стены
  await place("porch", async (s) => { await clickAt(page, s); }, "wall-click", wallPt(0.5, 15));
  await place("porch", async (s) => { await dragAt(page, s, wallPt(0.8, 15)); }, "wall-drag", wallPt(0.5, 15));
  // 3. stair_spot — клик у стены
  await place("stair_spot", async (s) => { await clickAt(page, s); }, "wall-click", wallPt(0.3, 15));
  // 4. ladder_march_double — клик в большой комнате (может, не влез в маленькую)
  await place("ladder_march_double", async (s) => { await clickAt(page, s); }, "click", big);
  // 5. панели свойств точным правым кликом: ladder_march, spiral_staircase, stair_machine, attic_staircase, step_ladder
  for (const key of ["ladder_march", "spiral_staircase", "stair_machine", "attic_staircase", "step_ladder", "ladder_circle", "rounded_staircase"]) {
    const spot = centers[1] ?? big;
    const st = await pickTool(page, key);
    const rec: Record<string, unknown> = { pick: st };
    if (st === "ok") {
      const b = await copyServer(page);
      await clickAt(page, spot);
      const a = await copyServer(page);
      const diff = diffModels(b, a);
      const added: Record<string, any> = {};
      for (const [coll, dv] of Object.entries(diff)) {
        for (const [id, o] of Object.entries<any>((dv as any).added ?? {})) added[`${coll}/${id}`] = o;
      }
      rec.added = added;
      rec.diff_keys = Object.keys(diff);
      const first = Object.values(added)[0] as any;
      if (first) {
        const c: P = { x: first.pc.x, y: first.pc.y };
        await clickAt(page, c, "right");
        rec.cm = await dumpMenus(page);
        await escape(page);
      }
    }
    writeFileSync(`${OUT}/${key}-panel.json`, JSON.stringify(rec, null, 1) + "\n");
    console.log(key, "panel", st, "cm ids:", JSON.stringify((rec.cm ?? []).map((m: any) => m.id)));
    await escape(page);
  }
  console.log("done");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
