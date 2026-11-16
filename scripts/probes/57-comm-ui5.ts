// 57-communications, проба 5: ventilation_hole — рядом с air-коробом, у стояков, drag; классы инструмента.
// КЛИКИ ТОЛЬКО ЛОКАЛЬНО: save не вызывается. node scripts/probes/57-comm-ui5.ts
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
    const tool = document.getElementById("plannertool_ventilation_hole");
    return { rooms, toolCls: tool?.className ?? null, toolOuter: tool?.outerHTML ?? null };
  });
  console.log("tool:", geo.toolCls, "|", geo.toolOuter?.slice(0, 200));

  const r = [...geo.rooms].sort((a, b) => b.area - a.area)[0]!;
  const xs = r.polygon.map((q: P) => q.x), ys = r.polygon.map((q: P) => q.y);
  const c = { x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2), y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2) };

  // поставить air (вентиляционный короб), затем ventilation_hole рядом и НА него
  await pickTool(page, "air");
  const b0 = await copyServer(page);
  await clickAt(page, c);
  let a0 = await copyServer(page);
  console.log("air поставлен:", JSON.stringify(Object.keys(diffModels(b0, a0))));

  const airPc = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    const it = Object.values<any>(m.items ?? {}).find((i: any) => i.name === "air");
    return it ? { x: it.pc.x, y: it.pc.y } : null;
  });
  console.log("air pc:", JSON.stringify(airPc));

  const tries: unknown[] = [];
  if (airPc) {
    for (const [label, p] of [
      ["на воздуховод", airPc],
      ["рядом +25", { x: airPc.x + 25, y: airPc.y + 25 }],
      ["рядом -25", { x: airPc.x - 25, y: airPc.y - 25 }],
      ["центр комнаты", c],
    ] as const) {
      await pickTool(page, "ventilation_hole");
      const b = await copyServer(page);
      await clickAt(page, p);
      const a = await copyServer(page);
      const diff = diffModels(b, a);
      let added = 0;
      for (const dv of Object.values<any>(diff)) added += Object.keys(dv.added ?? {}).length;
      tries.push({ label, p, ok: added > 0, diffKeys: Object.keys(diff) });
      console.log("ventilation_hole", label, added > 0 ? "OK" : "нет");
      await escape(page);
    }
    // drag
    await pickTool(page, "ventilation_hole");
    const b = await copyServer(page);
    await dragAt(page, { x: airPc.x + 60, y: airPc.y }, { x: airPc.x + 120, y: airPc.y + 40 });
    const a = await copyServer(page);
    const diff = diffModels(b, a);
    let added = 0;
    for (const dv of Object.values<any>(diff)) added += Object.keys(dv.added ?? {}).length;
    tries.push({ label: "drag", ok: added > 0, diffKeys: Object.keys(diff) });
    console.log("ventilation_hole drag:", added > 0 ? "OK" : "нет");
  }
  writeFileSync(`${OUT}/ventilation_hole-tries2.json`, JSON.stringify(tries, null, 1) + "\n");
  await page.screenshot({ path: `${SHOTS}/57-ventilation_hole.png` });
  console.log("done");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
