// 25-windows: проба 2 — как открыть и прочитать панель свойств окна.
// Ставим окно, кликаем/право-кликаем, дампим видимые поля (input/select) вне тулбара.
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, escape, pickTool, switchSheet, toScreen } from "./phase2-lib.ts";

async function visibleFields(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const out: Record<string, unknown>[] = [];
    for (const el of Array.from(document.querySelectorAll("input, select, textarea")) as (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[]) {
      if (!el.offsetParent && el.type !== "hidden") continue;
      out.push({ id: el.id, tag: el.tagName.toLowerCase(), type: (el as HTMLInputElement).type, value: el.value, cls: el.className.slice(0, 60) });
    }
    return out;
  });
}

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
  await switchSheet(page, "init");
  // выбрать стену и поставить окно
  const cur = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
  const wall = cur.walls["mum46g7h3k"]; // та же стена, что в 25-windows-ui.ts
  const axis = { x: wall.p2.x - wall.p1.x, y: wall.p2.y - wall.p1.y };
  const len = Math.hypot(axis.x, axis.y);
  // свободный центр: дальше всех существующих проёмов
  let cursor = wall.depth / 2 + 5;
  for (const h of Object.values<any>(wall.holes ?? {})) {
    const t = ((h.pc.x - wall.p1.x) * axis.x + (h.pc.y - wall.p1.y) * axis.y) / (len * len);
    cursor = Math.max(cursor, t * len + h.width / 2 + 5);
  }
  const center = cursor + 60;
  const pt = { x: wall.p1.x + (center / len) * axis.x, y: wall.p1.y + (center / len) * axis.y };
  console.log("click at", JSON.stringify(pt));
  await pickTool(page, "window");
  await clickAt(page, pt);
  await clearFog(page);
  const after = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
  // где добавился проём (по всем стенам)
  for (const [wk, w] of Object.entries<any>(after.walls)) {
    for (const hid of Object.keys(w.holes ?? {})) {
      if (!(hid in (cur.walls[wk]?.holes ?? {}))) console.log("NEW HOLE on", wk, "pc=", JSON.stringify(w.holes[hid].pc), "type=", w.holes[hid].type);
    }
  }
  const w2 = after.walls["mum46g7h3k"];
  if (!w2) throw new Error("стена 7kmwa9hpxx не найдена после клика; walls=" + Object.keys(after.walls ?? {}).length);
  const hid = Object.keys(w2.holes ?? {}).find((k) => !(k in (wall.holes ?? {})));
  if (!hid) throw new Error("проём не найден");
  console.log("hole:", hid, JSON.stringify(w2.holes[hid]?.pc));
  // 1) левый клик по проёму (выделение)
  await clickAt(page, w2.holes[hid].pc);
  await page.waitForTimeout(600);
  console.log("AFTER LEFT CLICK:", JSON.stringify(await visibleFields(page)));
  const panel = await page.evaluate(() => {
    const el: any = document.querySelector("#set-window-width");
    const cont = el?.closest("div[id]");
    const root = cont?.parentElement ?? cont;
    return { contId: cont?.id, cls: cont?.className, html: (root ?? cont)?.outerHTML?.slice(0, 6000) };
  });
  console.log("PANEL:", panel.contId, panel.cls);
  console.log(panel.html);
  // 2) правый клик
  await clickAt(page, w2.holes[hid].pc, "right");
  await page.waitForTimeout(600);
  console.log("AFTER RIGHT CLICK:", JSON.stringify(await visibleFields(page)));
  // видимые активные меню-контейнеры
  const menus = await page.evaluate(() => Array.from(document.querySelectorAll(".planner_ui_message, .context_menu, [class*='menu']"))
    .filter((e: any) => e.offsetParent)
    .map((e: any) => ({ id: e.id, cls: String(e.className).slice(0, 80) })).slice(0, 30));
  console.log("MENU CONTAINERS:", JSON.stringify(menus));
  await page.screenshot({ path: "screenshots/25-win-props-probe.png" });
  await escape(page);
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
