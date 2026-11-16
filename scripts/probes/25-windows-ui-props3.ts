// 25-windows: проба 4 — что показывает UI при выделенном окне: вся панель опций, левый тулбар,
// elementFromPoint при правом клике, поиск контейнеров cm-*/contextmenu.
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, toScreen } from "./phase2-lib.ts";

const copyS = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));

// Проект для пробы задаётся env: проба открывает указанный проект, а 25-live-check
// ещё и сохраняет в него (project_save). Без env — отказ (ревью 26, №5).
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID: проба открывает (25-live-check — и сохраняет в) указанный проект.");
  process.exit(1);
}

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
try {
  const page = editor.page;
  await page.evaluate(() => (window as any).project && undefined);
  // ставим окно на mum46g7h3k
  const before = await copyS(page);
  const wall = before.walls["mum46g7h3k"];
  const axis = { x: wall.p2.x - wall.p1.x, y: wall.p2.y - wall.p1.y };
  const len = Math.hypot(axis.x, axis.y);
  let cursor = wall.depth / 2 + 5;
  for (const h of Object.values<any>(wall.holes ?? {})) {
    const t = ((h.pc.x - wall.p1.x) * axis.x + (h.pc.y - wall.p1.y) * axis.y) / (len * len);
    cursor = Math.max(cursor, t * len + h.width / 2 + 5);
  }
  const center = cursor + 100;
  const pt = { x: wall.p1.x + (center / len) * axis.x, y: wall.p1.y + (center / len) * axis.y };
  await page.evaluate(() => { (document.querySelector("#plannertool_window") as HTMLElement)?.click(); });
  await page.waitForTimeout(600);
  await clickAt(page, pt);
  await clearFog(page);
  const after = await copyS(page);
  const w2 = after.walls["mum46g7h3k"];
  const hid = Object.keys(w2.holes ?? {}).find((k) => !(k in (wall.holes ?? {})));
  if (!hid) throw new Error("проём не добавился");
  await clickAt(page, w2.holes[hid].pc);
  await page.waitForTimeout(700);
  // 1) вся панель опций
  const options = await page.evaluate(() => {
    const el = document.querySelector("#planner_ui_options");
    return el ? el.outerHTML : null;
  });
  console.log("=== OPTIONS PANEL LENGTH:", options?.length);
  // 2) левый тулбар: активные группы
  const left = await page.evaluate(() => {
    const act = Array.from(document.querySelectorAll(".tools_item.active, .subtools_item.active, .groups_navi_item.active")) as HTMLElement[];
    return act.map((e) => ({ id: e.id, cls: e.className.slice(0, 80), text: e.textContent?.trim().slice(0, 40) }));
  });
  console.log("=== ACTIVE LEFT:", JSON.stringify(left));
  // 3) body class + выбранный объект
  const sel = await page.evaluate(() => ({
    bodyCls: document.body.className,
    holesSel: Object.values<any>((window as any).WALLS).flatMap((w: any) => Object.values<any>(w.holes ?? {})).filter((h: any) => h.selected).map((h: any) => h.id),
  }));
  console.log("=== SELECTED:", JSON.stringify(sel));
  // 4) правый клик: что под курсором и какие меню есть в DOM
  const s = await toScreen(page, w2.holes[hid].pc);
  await page.mouse.move(s.x, s.y, { steps: 4 });
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(700);
  const probe = await page.evaluate(({ sx, sy }) => {
    const under = document.elementFromPoint(sx, sy);
    const chain: string[] = [];
    let e: Element | null = under;
    while (e && chain.length < 6) { chain.push(`${e.tagName.toLowerCase()}#${e.id}.${String(e.className).slice(0, 40)}`); e = e.parentElement; }
    const menus = Array.from(document.querySelectorAll("[class*='contextmenu'], [id^='cm-'], .planner_ui_menu"))
      .map((m: any) => ({ id: m.id, cls: String(m.className).slice(0, 60), visible: !!m.offsetParent }))
      .filter((x: any) => x.visible || /window|hole|door/.test(x.id + x.cls));
    return { chain, menus: menus.slice(0, 40) };
  }, { sx: s.x, sy: s.y });
  console.log("=== UNDER RIGHT CLICK:", JSON.stringify(probe.chain));
  console.log("=== MENUS:", JSON.stringify(probe.menus, null, 1));
  await page.screenshot({ path: "screenshots/25-win-props-probe2.png" });
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
