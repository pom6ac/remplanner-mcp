// 37-doors: отладка 10 — как обрабатывается клик door_remote (tool_events, обработчик mousedown).
import { writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, pickTool, switchSheet, toScreen } from "./phase2-lib.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }
const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const res: Record<string, unknown> = {};
  // где определяется отрисовка remote-инструментов
  res.src = await page.evaluate(() => {
    const w: any = window as any;
    const out: Record<string, string> = {};
    for (const k of ["tool_events", "defs"]) {
      try { const s = JSON.stringify(w[k]); if (s && (s.includes("remote") || s.includes("doors_coupe"))) out[k] = s.slice(s.indexOf("remote") - 300, s.indexOf("remote") + 500); } catch {}
    }
    // обработчик кликов: ищем switch(tool) с door_remote в замыкании невозможно; смотрим обработчик svg
    const svg: any = document.querySelector("#main_svg");
    out.svg_events = svg ? Object.keys(svg).filter(k => /on|event|drag/i.test(k)).join(",") : "no svg";
    return out;
  });
  // Пробуем клик door_remote на стене с снятием сети: создаёт ли XHR/что-то
  const cur = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
  const wall = cur.walls["smmfs1i0hh"];
  const pt = { x: (wall.p1.x + wall.p2.x) / 2, y: (wall.p1.y + wall.p2.y) / 2 };
  const st = await pickTool(page, "door_remote");
  res.pick = st;
  await clickAt(page, pt);
  await clearFog(page);
  const after = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
  // диф: предметы
  const itemsB = Object.keys(cur.items ?? {}), itemsA = Object.keys(after.items ?? {});
  res.items_added = itemsA.filter(i => !itemsB.includes(i)).map(i => after.items[i]);
  res.msgs = await page.evaluate(() => Array.from(document.querySelectorAll(".planner_ui_message.active")).map((e: any) => e.textContent?.trim().slice(0, 200)));
  // Ищем обработчик tool в бандле: строку 'door_remote' в исходниках страницы
  res.scripts = await page.evaluate(() => Array.from(document.querySelectorAll("script[src]")).map((s: any) => s.getAttribute("src")).filter(Boolean));
  writeFileSync(".orca-reports/37-doors-ui/remote-dbg.json", JSON.stringify(res, null, 1) + "\n");
  console.log(JSON.stringify(res, null, 1).slice(0, 2500));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
