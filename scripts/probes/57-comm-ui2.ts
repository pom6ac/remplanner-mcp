// 57-communications, проба 2: виды, не поставившиеся одиночным кликом (у стены / свободные точки),
// и панели свойств (cm-*) точным правым кликом по pc объекта.
// КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается. node scripts/probes/57-comm-ui2.ts
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
    const rooms = Object.values<any>((m as any).rooms2 ?? {}).map((r: any) => ({ pc: { x: r.pc.x, y: r.pc.y }, polygon: r.polygon, area: r.area }));
    const walls = Object.values<any>(m.walls ?? {}).map((w: any) => ({ p1: w.p1, p2: w.p2, depth: w.depth }));
    const items = Object.values<any>(m.items ?? {}).map((it: any) => ({ pc: it.pc, width: it.width, height: it.height }));
    return { rooms, walls, items };
  });

  async function tryPlace(key: string, act: (spot: P) => Promise<void>, label: string, spot: P, rightClickAt?: P) {
    const st = await pickTool(page, key);
    const rec: Record<string, unknown> = { pick: st, spot, label };
    if (st === "ok") {
      const b = await copyServer(page);
      await act(spot);
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
        const c: P = rightClickAt ?? (first.pc ? { x: first.pc.x, y: first.pc.y }
          : first.p1 && first.p2 ? { x: (first.p1.x + first.p2.x) / 2, y: (first.p1.y + first.p2.y) / 2 } : spot);
        await clickAt(page, c, "right");
        rec.cm = await dumpMenus(page);
        await escape(page);
      }
      await page.screenshot({ path: `${SHOTS}/57-${key}-${label}.png` });
    }
    writeFileSync(`${OUT}/${key}-${label}.json`, JSON.stringify(rec, null, 1) + "\n");
    console.log(key, label, st, "added:", JSON.stringify(Object.keys(rec.added ?? {})));
    await escape(page);
  }

  // точки у стены: на грани стены внутри комнаты
  const wall = geo.walls[0]!;
  const dx = wall.p2.x - wall.p1.x, dy = wall.p2.y - wall.p1.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  const wallPt = (t: number, inward: number): P => ({ x: wall.p1.x + ux * len * t + -uy * inward, y: wall.p1.y + uy * len * t + ux * inward });

  // 1. anchor:wall — клик у стены
  await tryPlace("ceiling_water", async (s) => { await clickAt(page, s); }, "wall-click", wallPt(0.35, 12));
  await tryPlace("electric_shield_old", async (s) => { await clickAt(page, s); }, "wall-click", wallPt(0.55, 12));
  await tryPlace("conditioner_cage", async (s) => { await clickAt(page, s); }, "wall-click", wallPt(0.75, 35));
  // 2. свободные мелкие — клик в центры комнат (перебор точек: 3 комнаты)
  const centers = geo.rooms.map((r) => ({ x: Math.round(r.pc.x), y: Math.round(r.pc.y) }));
  const t2 = centers[1] ?? centers[0]!;
  await tryPlace("water_column_hot", async (s) => { await clickAt(page, s); }, "click", { x: t2.x + 40, y: t2.y + 40 });
  await tryPlace("heat_pipe", async (s) => { await clickAt(page, s); }, "click", { x: t2.x - 40, y: t2.y + 40 });
  await tryPlace("ventilation_hole", async (s) => { await clickAt(page, s); }, "click", { x: t2.x + 40, y: t2.y - 40 });
  // 3. панели свойств точным правым кликом для видов из пробы 1 (cm-rigel был чужой)
  for (const key of ["water", "water_column_cold", "drainage_column", "radiator_old", "air", "gas_pipe", "gas_boiler", "gas_meter", "fire_detector"]) {
    // предмет уже стоит (проба 1 без сохранения); найдём его в модели
    const target = await page.evaluate((k) => {
      const m = (window as any).project.copy("server");
      const it = Object.values<any>(m.items ?? {}).find((i: any) => i.name === k);
      return it ? { x: it.pc.x, y: it.pc.y } : null;
    }, key);
    if (!target) { console.log(key, "panel: предмет не найден"); continue; }
    await clickAt(page, target, "right");
    const cm = await dumpMenus(page);
    const rec = { key, target, cm };
    writeFileSync(`${OUT}/${key}-panel.json`, JSON.stringify(rec, null, 1) + "\n");
    console.log(key, "panel cm ids:", JSON.stringify(cm.map((m: any) => m.id)));
    await escape(page);
  }
  // 4. панель gas_line: правый клик по середине линии
  const gl = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    const p = Object.values<any>(m.pipes_gas ?? {})[0];
    if (!p) return null;
    const v = p.vertexes as any[];
    return { x: (v[0].point.x + v[1].point.x) / 2, y: (v[0].point.y + v[1].point.y) / 2 };
  });
  if (gl) {
    await clickAt(page, gl, "right");
    const cm = await dumpMenus(page);
    writeFileSync(`${OUT}/gas_line-panel.json`, JSON.stringify({ key: "gas_line", target: gl, cm }, null, 1) + "\n");
    console.log("gas_line panel cm ids:", JSON.stringify(cm.map((m: any) => m.id)));
    await escape(page);
  } else {
    // газовая линия могла не дожить до пробы 2 (проба 1 не сохранялась) — нарисуем и снимем панель
    const p1 = { x: t2.x + 20, y: t2.y - 60 }, p2 = { x: t2.x + 170, y: t2.y - 10 };
    await tryPlace("gas_line", async () => { await dragAt(page, p1, p2); }, "drag-panel", p1, { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 });
  }
  console.log("done");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
