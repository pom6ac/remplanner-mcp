// 37-doors: отладка 5 — каталог инструментов дверей из глобала страницы.
import { writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { switchSheet } from "./phase2-lib.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }
const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
try {
  const page = editor.page;
  await switchSheet(page, "init");
  const info = await page.evaluate(() => {
    const w: any = window as any;
    const out: Record<string, unknown> = {};
    // ищем каталог инструментов: global_tools / planner.tools
    const candidates = ["global_tools", "planner_tools", "TOOLS", "tools_data"];
    for (const k of candidates) if (w[k]) out["global_" + k] = String(typeof w[k]).slice(0, 60);
    // DOM: data-атрибуты инструментов
    const keys = ["door_garage", "door_system_x4", "door_remote", "door_videoremote", "doors_coupe_4x", "door", "doors_coupe_2x"];
    out.dom = {};
    for (const k of keys) {
      const el: any = document.querySelector(`#plannertool_${k}`);
      if (!el) { out.dom[k] = null; continue; }
      const attrs: Record<string, string> = {};
      for (const a of Array.from(el.attributes)) attrs[a.name] = a.value.slice(0, 200);
      out.dom[k] = attrs;
    }
    // группы каталога в JS
    try {
      const gt = w.global_tools;
      if (gt) {
        const flat = Array.isArray(gt) ? gt : Object.values(gt).flat();
        const doors = flat.filter((t: any) => t && /^doors?_/.test(String(t.id ?? t.name ?? "")));
        out.catalog = doors.map((t: any) => ({ id: t.id, title: t.title, group: t.group, plan: t.plan, width: t.width, height: t.height, self_height: t.self_height }));
      }
    } catch (e: any) { out.catalog_err = String(e).slice(0, 200); }
    return out;
  });
  writeFileSync(".orca-reports/37-doors-ui/catalog.json", JSON.stringify(info, null, 1) + "\n");
  console.log(JSON.stringify(info, null, 1).slice(0, 3000));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
