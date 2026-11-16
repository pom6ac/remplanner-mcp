// 47-rigels: магнит-радиус точки, свободный drag, панель свойств (showContextmenu), правки полей.
// ID только из env. КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается.
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, copyServer, diffModels, setMenuField, toScreen, type P } from "./phase2-lib.ts";

const OUT = ".orca-reports/47-rigels-ui";
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

function dump(name: string, data: unknown) {
  writeFileSync(`${OUT}/mag-${name}.json`, JSON.stringify(data, null, 1) + "\n");
  console.log(name, JSON.stringify(data).slice(0, 400));
}

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");

  // колоночная вершина: pillar pc и его верхняя грань
  const pillar = await page.evaluate(() => {
    const p = Object.values<any>((window as any).project.copy("server").pillars ?? {})[0];
    return p ? { id: p.id, pc: p.pc, w: p.width, h: p.height } : null;
  });
  if (!pillar) throw new Error("нет колонны");
  const edgeTop: P = { x: pillar.pc.x, y: pillar.pc.y - pillar.h / 2 };

  const st = await pickTool(page, "rigel");
  if (st !== "ok") throw new Error(`pickTool: ${st}`);
  const base = await copyServer(page);

  // магнит: клики на расстояниях 2,5,10,20,40 см от грани (перпендикулярно вверх)
  const magnet: Record<string, unknown>[] = [];
  for (const d of [2, 5, 10, 20, 40]) {
    const pt: P = { x: pillar.pc.x, y: pillar.pc.y - pillar.h / 2 - d };
    await clickAt(page, pt);
    await clearFog(page);
    const after = await copyServer(page);
    const added = Object.entries<any>(after.rigels ?? {}).find(([id]) => !(id in (base.rigels as object)));
    magnet.push({ dist: d, click: pt, created: added ? { p1: added[1].p1, p2: added[1].p2 } : null, id: added?.[0] ?? null });
    // удалить созданный ригель (локально): через редактор
    if (added) {
      await page.evaluate((id) => {
        const r = (window as any).RIGELS?.[id];
        if (r) { try { r.remove(); } catch { try { r.delete(); } catch { /* */ } } }
      }, added[0]);
      await page.waitForTimeout(300);
    }
  }
  dump("magnet", magnet);

  // свободный drag: от точки вдали от всего к другой точке
  const freeA: P = { x: 700, y: 300 }, freeB: P = { x: 760, y: 300 };
  await page.mouse.move((await toScreen(page, freeA)).x, (await toScreen(page, freeA)).y, { steps: 4 });
  await page.mouse.down();
  await page.mouse.move((await toScreen(page, freeB)).x, (await toScreen(page, freeB)).y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const afterDrag = await copyServer(page);
  const freeAdded = Object.entries<any>(afterDrag.rigels ?? {}).filter(([id]) => !(id in (base.rigels as object)));
  dump("free-drag", { count: freeAdded.length, first: freeAdded[0]?.[1] ?? null });
  await escape(page);

  // панель свойств: программный showContextmenu (модели не пишет), поля #cm-rigel--height/depth
  const rig = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    return Object.values<any>(m.rigels ?? {})[0] ?? null;
  });
  if (rig) {
    // создать ригель у колонны заново
    const pt: P = { x: pillar.pc.x, y: pillar.pc.y - pillar.h / 2 };
    await clickAt(page, pt);
    await clearFog(page);
    const now = await copyServer(page);
    const rid = Object.keys(now.rigels ?? {}).find((id) => !(id in (base.rigels as object)));
    if (rid) {
      // открыть контекстное меню через редакторный метод
      await page.evaluate((id) => {
        const r = (window as any).RIGELS[id];
        r.showContextmenu({ clientX: 700, clientY: 400 });
      }, rid);
      await page.waitForTimeout(400);
      const menu = await page.evaluate(() => {
        const out: Record<string, unknown>[] = [];
        for (const el of Array.from(document.querySelectorAll("[id^='cm-']")) as HTMLElement[]) {
          if (!el.offsetParent && (el as HTMLInputElement).type !== "hidden") continue;
          out.push({ id: el.id, tag: el.tagName.toLowerCase(), value: (el as HTMLInputElement).value ?? el.textContent?.trim() });
        }
        return out;
      });
      dump("menu", menu);
      await page.screenshot({ path: "../../screenshots/47-rigel-menu.png" }).catch(() => {});
      // правки: height 30→45, depth 30→20
      const edits: unknown[] = [];
      for (const [fid, val] of [["cm-rigel--height", "45"], ["cm-rigel--depth", "20"]] as const) {
        const beforeEdit = await copyServer(page);
        const okSet = await setMenuField(page, `#${fid}`, val);
        if (!okSet) { edits.push({ field: fid, error: "не найдено" }); continue; }
        await page.waitForTimeout(400);
        const afterEdit = await copyServer(page);
        edits.push({ field: fid, value: val, diff: diffModels(beforeEdit, afterEdit).rigels ?? diffModels(beforeEdit, afterEdit) });
        await escape(page);
        await page.evaluate((id) => { (window as any).RIGELS?.[id]?.showContextmenu({ clientX: 700, clientY: 400 }); }, rid);
        await page.waitForTimeout(300);
      }
      dump("edits", edits);
      await escape(page);
    }
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
