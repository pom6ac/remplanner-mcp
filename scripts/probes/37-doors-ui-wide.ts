// 37-doors: съём эталонов ШИРОКИХ типов дверей (garage 300, x4/penal_x4 320) на временной стене.
// КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается, временная стена удаляется в конце.
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, toScreen, dragAt } from "./phase2-lib.ts";

const OUT = ".orca-reports/37-doors-ui";
const SHOTS = "screenshots";
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

async function copyServer(page: Page) {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
}
async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
const visible = (s: { x: number; y: number }) => s.x > 250 && s.x < 1350 && s.y > 150 && s.y < 850;

async function removeHole(page: Page, pc: { x: number; y: number }): Promise<boolean> {
  await clickAt(page, pc, "right");
  await page.waitForTimeout(400);
  const ok = await page.evaluate(() => {
    const m = Array.from(document.querySelectorAll(".contextmenu")).find((x: any) => x.offsetParent);
    if (!m) return false;
    const items = Array.from(m.querySelectorAll("[data-button], .contextmenu_item, li, div")) as HTMLElement[];
    const b = items.find((e) =>
      ["remove", "delete", "del"].includes(e.getAttribute("data-button") ?? "") ||
      /^Удалить/.test((e.textContent ?? "").trim()));
    if (!b) return false;
    b.click();
    return true;
  });
  await page.waitForTimeout(600);
  await escape(page);
  return ok;
}

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  // временная стена: горизонтальная, 800 см, толщина 20, ниже основного плана (свободное место)
  const wallId = await page.evaluate(() => {
    const w: any = window as any;
    const id = w.LIB.id();
    const model = w.project.copy("server");
    const ys = Object.values<any>(model.walls).map((x) => Math.max(x.p1.y, x.p2.y));
    const y = Math.max(...ys) + 200;
    // @ts-ignore Wall — лексический класс бандла
    w.WALLS[id] = new Wall({ id, p1: { x: 0, y }, p2: { x: 800, y }, depth: 20, plan: "a", role: "wall",
      material: w.defs?.wall?.material || "a_block", color: w.defs?.wall?.color || 0 });
    w.$Project.draw({ rooms: 1 });
    return { id, y };
  });
  console.log("tmp wall:", JSON.stringify(wallId));
  const TYPES = ["door_garage", "door_system_x4", "door_system_penal_x4"] as const;
  const NEED: Record<string, number> = { door_garage: 300, door_system_x4: 320, door_system_penal_x4: 320 };
  try {
    for (const key of TYPES) {
      const res: Record<string, unknown> = { key };
      const cur = await copyServer(page);
      const wall = cur.walls[wallId.id];
      const len = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
      const pt = { x: wall.p1.x + len / 2, y: wall.p1.y };
      let s = await toScreen(page, pt);
      if (!visible(s)) {
        await dragAt(page, { x: 800, y: 480 }, { x: 800 - (s.x - 800), y: 480 - (s.y - 500) });
        await clearFog(page);
        s = await toScreen(page, pt);
        if (!visible(s)) throw new Error("временная стена не видна");
      }
      const before = await copyServer(page);
      const st = await pickTool(page, key);
      if (st !== "ok") throw new Error(`pickTool: ${st}`);
      await clickAt(page, pt);
      await clearFog(page);
      const after = await copyServer(page);
      let added: Record<string, unknown> | null = null;
      for (const [hid, h] of Object.entries<any>(after.walls[wallId.id]?.holes ?? {})) {
        if (!(hid in (cur.walls[wallId.id]?.holes ?? {}))) added = { ...h, _wall: wallId.id };
      }
      res.hole = added;
      res.ok = !!added;
      await shot(page, `37-door-${key}-plan`);
      if (added) {
        const hp = { x: added.pc.x as number, y: added.pc.y as number };
        await clickAt(page, hp, "right");
        await page.waitForTimeout(500);
        res.menu = await page.evaluate(() => {
          const out: Record<string, unknown>[] = [];
          for (const el of Array.from(document.querySelectorAll("[id^='cm-']")) as HTMLElement[]) {
            if (!el.offsetParent && el.type !== "hidden") continue;
            const tag = el.tagName.toLowerCase();
            const rec: Record<string, unknown> = { id: el.id, tag, value: (el as HTMLInputElement).value ?? el.textContent?.trim() };
            if (tag === "select") rec.options = Array.from((el as HTMLSelectElement).options).map((o) => ({ v: o.value, t: o.textContent?.trim() }));
            out.push(rec);
          }
          return out;
        });
        res.menu_html = await page.evaluate(() => {
          const m = Array.from(document.querySelectorAll(".contextmenu")).find((x: any) => x.offsetParent);
          return m ? m.outerHTML.slice(0, 20000) : null;
        });
        await shot(page, `37-door-${key}-props`);
        await escape(page);
        res.removed = await removeHole(page, hp);
      }
      writeFileSync(`${OUT}/${key}.json`, JSON.stringify(res, null, 1) + "\n");
      console.log(key, JSON.stringify({ ok: res.ok, type: (added as any)?.type, width: (added as any)?.width, removed: res.removed }));
    }
  } finally {
    // удалить временную стену
    const cur = await copyServer(page);
    if (cur.walls[wallId.id]) {
      await page.evaluate((wid) => {
        const w: any = window as any;
        delete w.WALLS[wid];
        w.$Project.draw({ rooms: 1 });
      }, wallId.id);
      const after = await copyServer(page);
      console.log("tmp wall removed:", !after.walls[wallId.id]);
    }
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
