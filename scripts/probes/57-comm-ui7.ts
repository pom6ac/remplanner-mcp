// 57-communications, проба 7: ventilation_hole на листе ventilation. КЛИКИ ТОЛЬКО ЛОКАЛЬНО: save не вызывается.
// node scripts/probes/57-comm-ui7.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clickAt, clearFog, escape, pickTool, switchSheet, copyServer, diffModels } from "./phase2-lib.ts";
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
  const air = await page.evaluate(() => Object.values<any>((window as any).project.copy("server").items ?? {}).find((i: any) => i.name === "air"));
  if (!air) { console.error("air не поставился"); process.exit(1); }

  // лист ventilation
  await switchSheet(page, "ventilation");
  const vis = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[id^='plannertool_']")).filter((e) => e.offsetParent !== null).map((e) => e.id.replace(/^plannertool_/, "")));
  console.log("лист ventilation, видимые инструменты:", JSON.stringify(vis));
  const st = await pickTool(page, "ventilation_hole");
  console.log("pick ventilation_hole:", st);
  const tries: unknown[] = [];
  const pc = air.pc as P;
  for (const [label, p] of [["центр короба", pc], ["рядом +40", { x: pc.x + 40, y: pc.y }], ["рядом -40", { x: pc.x - 40, y: pc.y }]] as const) {
    await pickTool(page, "ventilation_hole");
    const b = await copyServer(page);
    await clickAt(page, p);
    const a = await copyServer(page);
    const diff = diffModels(b, a);
    let added = 0;
    for (const dv of Object.values<any>(diff)) added += Object.keys(dv.added ?? {}).length;
    tries.push({ label, p, ok: added > 0, diffKeys: Object.keys(diff) });
    console.log("ventilation_hole (лист ventilation)", label, added > 0 ? "OK" : "нет", JSON.stringify(Object.keys(diff)));
    await escape(page);
  }
  writeFileSync(`${OUT}/ventilation_hole-tries4.json`, JSON.stringify(tries, null, 1) + "\n");
  await clearFog(page);
  await page.screenshot({ path: "screenshots/57-vent-sheet.png" });
  console.log("done");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
