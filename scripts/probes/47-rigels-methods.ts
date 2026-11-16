// 47-rigels: источники методов прототипа Rigel (mousedown, showContextmenu, serialize) + панель свойств.
// ID только из env. КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается.
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, pickTool, switchSheet, copyServer, type P } from "./phase2-lib.ts";

const OUT = ".orca-reports/47-rigels-ui";
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const pillarPt: P | null = await page.evaluate(() => {
    const p = Object.values<any>((window as any).project.copy("server").pillars ?? {})[0];
    return p ? { x: p.pc.x, y: p.pc.y - p.height / 2 } : null;
  });
  if (!pillarPt) throw new Error("нет колонны");
  const st = await pickTool(page, "rigel");
  if (st !== "ok") throw new Error(`pickTool: ${st}`);
  await clickAt(page, pillarPt);
  await clearFog(page);

  const methods = await page.evaluate(() => {
    const first = Object.values<any>((window as any).RIGELS ?? {})[0];
    if (!first) return null;
    const proto = Object.getPrototypeOf(first);
    const out: Record<string, string> = {};
    for (const name of ["mousedown", "showContextmenu", "serialize", "remove", "delete"]) {
      out[name] = (proto as any)[name]?.toString().slice(0, 5000) ?? "";
    }
    return out;
  });
  writeFileSync(`${OUT}/methods.json`, JSON.stringify(methods, null, 1) + "\n");
  console.log("mousedown:", methods?.mousedown?.slice(0, 600));
  console.log("showContextmenu:", methods?.showContextmenu?.slice(0, 600));
  console.log("serialize:", methods?.serialize?.slice(0, 900));

  // панель: пробуем правый клик по вершине полигона (угол) и по оси
  const rig = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    return Object.values<any>(m.rigels ?? {})[0] ?? null;
  });
  if (rig) {
    const poly = rig.polygon;
    const corner: P = { x: (poly[0].x + poly[3].x) / 2, y: (poly[0].y + poly[3].y) / 2 };
    await clickAt(page, corner, "right");
    await page.waitForTimeout(500);
    const menus1 = await page.evaluate(() => Array.from(document.querySelectorAll(".contextmenu")).filter((x: any) => x.offsetParent).length);
    console.log("right-click corner menus:", menus1);
    await page.screenshot({ path: "../../screenshots/47-rigel-props-corner.png" }).catch(() => {});
    const menu_html = await page.evaluate(() => {
      const m = Array.from(document.querySelectorAll(".contextmenu")).find((x: any) => x.offsetParent);
      return m ? m.outerHTML.slice(0, 30000) : null;
    });
    writeFileSync(`${OUT}/props-corner.html`, menu_html ?? "");
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
