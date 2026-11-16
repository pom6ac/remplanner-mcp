// 25-windows: проба 1 — открыть редактор проекта 7887657, снять summary стен и DOM инструментов окон.
// Без сохранений. node scripts/probes/25-windows-ui-scout.ts
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, "7887657", "1001798", 60_000, { anonymous: false });
try {
  const page = editor.page;
  const model = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
  const walls = Object.values<any>(model.walls ?? {});
  console.log("walls:", walls.length, "items:", Object.keys(model.items ?? {}).length);
  for (const w of walls) {
    const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
    console.log(`wall ${w.id}: len=${len.toFixed(1)} depth=${w.depth} holes=${Object.keys(w.holes ?? {}).length} p1=(${w.p1.x.toFixed(0)},${w.p1.y.toFixed(0)}) p2=(${w.p2.x.toFixed(0)},${w.p2.y.toFixed(0)})`);
  }
  const tools = await page.evaluate(() => {
    const keys = ["windowway", "window", "window_balcony", "window_door", "french_window", "french_window_coupe", "french_window_double"];
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const el: any = document.querySelector(`#plannertool_${k}`);
      if (!el) { out[k] = null; continue; }
      const group = el.closest(".tools_item, .subtools_item");
      out[k] = {
        exists: true,
        pro: el.classList.contains("is_pro") || !!(group && group.classList.contains("is_pro")),
        classes: el.className,
        title: el.getAttribute("title") ?? el.getAttribute("data-title"),
        parentHTML: el.parentElement ? el.parentElement.outerHTML.slice(0, 1200) : null,
      };
    }
    return out;
  });
  console.log("TOOLS:", JSON.stringify(tools, null, 1));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
