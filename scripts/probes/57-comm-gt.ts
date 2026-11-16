// 57-communications: global_tools записи 16 пунктов меню «Коммуникации» + defs (трубы/вентиляция). КЛИКОВ И ЗАПИСИ НЕТ.
// node scripts/probes/57-comm-gt.ts (ID из env)
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
  const out = await page.evaluate(() => {
    const keys = ["water", "water_column_hot", "water_column_cold", "drainage_column", "ceiling_water",
      "heat_pipe", "radiator_old", "air", "ventilation_hole", "gas_pipe", "gas_line",
      "gas_boiler", "gas_meter", "electric_shield_old", "fire_detector", "conditioner_cage"];
    const gt: any = (window as any).global_tools ?? {};
    const entries: Record<string, unknown> = {};
    for (const k of keys) entries[k] = gt[k] ?? null;
    // также группы каталога, чтобы видеть карту group -> список ключей
    const groups: Record<string, string[]> = {};
    for (const [k, v] of Object.entries<any>(gt)) {
      const g = String(v?.group ?? "?");
      (groups[g] ??= []).push(k);
    }
    const defs: any = (window as any).defs ?? {};
    return {
      entries,
      groups,
      defs_pipe: defs.pipe ?? null,
      defs_ventilation_pipe: defs.ventilation_pipe ?? null,
      defs_socket: defs.socket ?? null,
      defs_cable: defs.cable ?? null,
      model_keys: Object.keys((window as any).project?.copy("server") ?? {}),
    };
  });
  writeFileSync("../../.orca-reports/57-comm-ui/global-tools.json", JSON.stringify(out, null, 1) + "\n");
  for (const [k, v] of Object.entries<any>(out.entries)) {
    console.log(k, v ? `group=${v.group} title=${JSON.stringify(v.title)} w=${v.width} h=${v.height} anchor=${v.anchor} plan=${JSON.stringify(v.plan)}` : "NULL");
  }
  console.log("model keys:", JSON.stringify(out.model_keys));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
