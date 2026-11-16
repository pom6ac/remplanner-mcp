// 37-doors: проба 1 — открыть редактор проекта <REMPLANNER_PROBE_OBJECT_ID>,
// снять DOM меню «Двери и проемы» (все ключи, подменю, «глаза») и скриншоты.
// Без сохранений. node scripts/probes/37-doors-ui-scout.ts
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, switchSheet } from "./phase2-lib.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID.");
  process.exit(1);
}

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  await clearFog(page);
  // Все инструменты групп doors на листе init: ключи, заголовки, подменю, PRO
  const dom = await page.evaluate(() => {
    const w: any = window as any;
    const tools = Array.from(document.querySelectorAll('[id^="plannertool_"]'))
      .filter((el: any) => /^door/.test(el.id.replace(/^plannertool_/, "")) || el.id.replace(/^plannertool_/, "") === "doorway");
    const info = tools.map((el: any) => {
      const key = el.id.replace(/^plannertool_/, "");
      const group = el.closest(".tools_item, .subtools_item");
      return {
        key,
        pro: el.classList.contains("is_pro") || !!(group && group.classList.contains("is_pro")),
        title: el.getAttribute("title") ?? el.getAttribute("data-title"),
        about: !!el.closest(".tools_item")?.querySelector(".tools_item_about, [class*='about']"),
        parentSubtools: el.closest(".subtools")?.id ?? null,
      };
    });
    // верхнеуровневая группа дверей: открыть все подменю
    const subtools = Array.from(document.querySelectorAll(".tools_item .subtools")).map((s: any) => s.id);
    return { info, subtools, count: tools.length };
  });
  console.log("DOOR TOOLS:", JSON.stringify(dom, null, 1));
  // скриншот панели с раскрытым подменю дверей
  const opened = await page.evaluate(() => {
    const el: any = document.querySelector("#plannertool_door") ?? document.querySelector("#plannertool_doorway");
    if (!el) return false;
    const group = el.closest(".tools_item");
    const opener = group?.querySelector(".tools_item_name, .tools_item_arrow, [data-target]");
    (opener ?? el).click();
    return true;
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    // раскрыть все подменю группы дверей
    document.querySelectorAll(".tools_item .subtools_opener, .subtools_opener").forEach((o: any) => {
      const sub = document.getElementById(o.getAttribute("data-target") ?? "");
      if (sub && sub.querySelector('[id^="plannertool_door"]')) o.click();
    });
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "screenshots/37-doors-menu.png" });
  console.log("menu opened:", opened, "→ screenshots/37-doors-menu.png");
  // стена проекта: сводка для расстановки
  const model = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
  for (const w of Object.values<any>(model.walls ?? {})) {
    const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
    console.log(`wall ${w.id}: len=${len.toFixed(1)} depth=${w.depth} holes=${Object.keys(w.holes ?? {}).length}`);
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
