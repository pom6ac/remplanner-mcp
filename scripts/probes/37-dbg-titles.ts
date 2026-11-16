// 37-doors: русские названия пунктов меню дверей из DOM.
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
  const titles = await page.evaluate(() => {
    const out: Record<string, string | null> = {};
    const keys = ["doorway","door","door_double","door_coupe","door_coupe_double","door_penal","door_penal_double","door_roto","door_roto_double","door_book","door_book_double","door_bellows","door_glass","door_garage","door_system_x2","door_system_x3","door_system_x4","door_system_penal_x2","door_system_penal_x3","door_system_penal_x4","doors_coupe_2x","doors_coupe_3x","doors_coupe_4x","door_remote","door_videoremote"];
    for (const k of keys) {
      const el: any = document.querySelector(`#plannertool_${k}`);
      if (!el) { out[k] = null; continue; }
      const box = el.closest(".subtools_item") ?? el;
      const name = box.querySelector(".subtools_item_name, .tools_item_name, span, b, i");
      out[k] = (name?.textContent ?? box.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || null;
    }
    // название группы дверей
    const doorTool: any = document.querySelector("#plannertool_door");
    const group = doorTool?.closest(".tools_item");
    const groupName = group?.querySelector(".tools_item_name, span");
    out["__group__"] = (groupName?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || null;
    return out;
  });
  writeFileSync(".orca-reports/37-doors-ui/titles.json", JSON.stringify(titles, null, 1) + "\n");
  console.log(JSON.stringify(titles, null, 1));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
