// 25-windows: проба 5 — «глаз» у французских окон, переключатель arc, поворот, door_position у балконного блока.
import type { Page } from "playwright-core";
import { writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet } from "./phase2-lib.ts";

const copyS = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
const OUT = ".orca-reports/25-windows-ui";
const WALL = "7kmwa9hpxx"; // горизонтальная стена с запасом длины

async function place(page: Page, tool: string): Promise<{ hid: string; pc: { x: number; y: number } } | null> {
  const before = await copyS(page);
  const wall = before.walls[WALL];
  const axis = { x: wall.p2.x - wall.p1.x, y: wall.p2.y - wall.p1.y };
  const len = Math.hypot(axis.x, axis.y);
  let cursor = wall.depth / 2 + 5;
  for (const h of Object.values<any>(wall.holes ?? {})) {
    const t = ((h.pc.x - wall.p1.x) * axis.x + (h.pc.y - wall.p1.y) * axis.y) / (len * len);
    cursor = Math.max(cursor, t * len + h.width / 2 + 5);
  }
  const center = cursor + 100;
  if (center + 100 > len - wall.depth / 2) return null;
  const pt = { x: wall.p1.x + (center / len) * axis.x, y: wall.p1.y + (center / len) * axis.y };
  const st = await pickTool(page, tool);
  if (st !== "ok") return null;
  await clickAt(page, pt);
  await clearFog(page);
  const after = await copyS(page);
  const w2 = after.walls[WALL];
  const hid = Object.keys(w2.holes ?? {}).find((k) => !(k in (wall.holes ?? {})));
  await escape(page);
  return hid ? { hid, pc: w2.holes[hid].pc } : null;
}

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, "7887657", "1001798", 60_000, { anonymous: false });
const res: Record<string, unknown> = {};
try {
  const page = editor.page;
  await switchSheet(page, "init");
  // 1) DOM группы «Окна»: ищем «глаз»
  res.group_html = await page.evaluate(() => {
    const el: any = document.querySelector("#plannertool_french_window");
    const box = el?.closest(".tools_item") ?? el?.parentElement?.parentElement;
    return box ? box.outerHTML.slice(0, 12000) : null;
  });
  // 2) arc у французского окна: открыть меню, кликнуть switcher, диф
  const fw = await place(page, "french_window");
  if (fw) {
    const before = (await copyS(page)).walls[WALL].holes[fw.hid];
    await clickAt(page, fw.pc, "right");
    await page.waitForTimeout(500);
    const arcClicked = await page.evaluate(() => {
      const m = Array.from(document.querySelectorAll(".contextmenu")).find((x: any) => x.offsetParent) as HTMLElement | undefined;
      const sw = m?.querySelector("[data-switcher='arc']") as HTMLElement | null;
      if (!sw) return false;
      sw.click();
      return true;
    });
    await page.waitForTimeout(500);
    const mid = (await copyS(page)).walls[WALL].holes[fw.hid];
    await escape(page);
    res.arc = { clicked: arcClicked, before_arched: before["arched"] ?? null, after: mid ? { arched: mid["arched"] ?? null } : "deleted" };
    // 3) поворот: снова меню → data-button="rotate"
    await clickAt(page, fw.pc, "right");
    await page.waitForTimeout(500);
    const beforeRot = (await copyS(page)).walls[WALL].holes[fw.hid];
    const rotClicked = await page.evaluate(() => {
      const m = Array.from(document.querySelectorAll(".contextmenu")).find((x: any) => x.offsetParent) as HTMLElement | undefined;
      const b = m?.querySelector("[data-button='rotate']") as HTMLElement | null;
      if (!b) return false;
      b.click();
      return true;
    });
    await page.waitForTimeout(500);
    const afterRot = (await copyS(page)).walls[WALL].holes[fw.hid];
    await escape(page);
    res.rotate = { clicked: rotClicked, before_opening: beforeRot.opening, after_opening: afterRot?.opening };
  }
  // 3) балконный блок: door_position через пресет выделения
  const wb = await place(page, "window_balcony");
  if (wb) {
    await clickAt(page, wb.pc);
    await page.waitForTimeout(500);
    const before = (await copyS(page)).walls[WALL].holes[wb.hid];
    const okSel = await page.evaluate(() => {
      const el = document.querySelector("#set_windoor_door_position") as HTMLSelectElement | null;
      if (!el || !el.offsetParent) return false;
      el.value = "right";
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
    await page.waitForTimeout(600);
    const after = (await copyS(page)).walls[WALL].holes[wb.hid];
    await escape(page);
    res.door_position = { selected: okSel, before: before.door_position, after: after?.door_position };
  }
  writeFileSync(`${OUT}/props-extra.json`, JSON.stringify(res, null, 1) + "\n");
  console.log(JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 120) : v])), null, 1).slice(0, 1200));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
