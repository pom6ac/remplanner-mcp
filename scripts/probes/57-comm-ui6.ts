// 57-communications, проба 6: ventilation_hole — клик по краям air-короба + чтение errors после попыток.
// КЛИКИ ТОЛЬКО ЛОКАЛЬНО: save не вызывается. node scripts/probes/57-comm-ui6.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clickAt, escape, pickTool, switchSheet, copyServer, diffModels } from "./phase2-lib.ts";
import type { P } from "./phase2-lib.ts";

const OUT = ".orca-reports/57-comm-ui";
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
    return { rooms };
  });
  const r = [...geo.rooms].sort((a, b) => b.area - a.area)[0]!;
  const xs = r.polygon.map((q: P) => q.x), ys = r.polygon.map((q: P) => q.y);
  const c = { x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2), y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2) };

  await pickTool(page, "air");
  await clickAt(page, c);
  const air = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    return Object.values<any>(m.items ?? {}).find((i: any) => i.name === "air");
  });
  if (!air) { console.error("air не поставился"); process.exit(1); }
  console.log("air:", JSON.stringify({ pc: air.pc, width: air.width, height: air.height, angle: air.angle }));

  // края короба (angle 0): pc ± width/2, pc ± height/2 и углы
  const hw = air.width / 2, hh = air.height / 2;
  const pc = air.pc as P;
  const edges: [string, P][] = [
    ["левый край", { x: pc.x - hw + 2, y: pc.y }],
    ["правый край", { x: pc.x + hw - 2, y: pc.y }],
    ["верхний край", { x: pc.x, y: pc.y - hh + 2 }],
    ["нижний край", { x: pc.x, y: pc.y + hh - 2 }],
    ["угол -+", { x: pc.x - hw + 2, y: pc.y + hh - 2 }],
    ["угол ++", { x: pc.x + hw - 2, y: pc.y + hh - 2 }],
  ];
  const tries: unknown[] = [];
  for (const [label, p] of edges) {
    await pickTool(page, "ventilation_hole");
    const b = await copyServer(page);
    await clickAt(page, p);
    const a = await copyServer(page);
    const diff = diffModels(b, a);
    let added = 0;
    for (const dv of Object.values<any>(diff)) added += Object.keys(dv.added ?? {}).length;
    const errs = await page.evaluate(() => (window as any).project.copy("server").errors ?? null);
    tries.push({ label, p, ok: added > 0, diffKeys: Object.keys(diff), errors: errs });
    console.log("ventilation_hole", label, added > 0 ? "OK" : "нет", "errors:", JSON.stringify(errs)?.slice(0, 200));
    await escape(page);
  }
  writeFileSync(`${OUT}/ventilation_hole-tries3.json`, JSON.stringify(tries, null, 1) + "\n");
  console.log("done");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
