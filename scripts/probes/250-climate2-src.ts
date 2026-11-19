// 250: разведка источников редактора для климата ч.2. КЛИКОВ И ЗАПИСИ НЕТ:
// в странице fetch бандла app.*.js, текст — в .orca-reports/tmp/app-bundle-250.js;
// плюс снимок defs/лимитов и ключей global_tools климата.
// node scripts/probes/250-climate2-src.ts run
import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу run (ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID"); process.exit(1); }
mkdirSync(".orca-reports/tmp", { recursive: true });

setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 6 * 60_000).unref();

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
try {
  const page = editor.page;
  const res = await page.evaluate(async () => {
    const w: any = window as any;
    const urls = (performance.getEntriesByType("resource") as any[])
      .map((r) => r.name)
      .filter((u) => /app\..*\.min\.js/.test(u));
    const out: any = { urls, toolKeys: {}, defs: null };
    const keys = [
      "radiator_bimetal", "radiator_steel", "radiator_iron", "radiator_tubular_300", "radiator_tubular_500",
      "vertical_radiator", "floor_convector", "convector_on_floor", "electro_convector", "radiator_old",
      "heat_pipe_hot", "heat_pipe_cold", "heat_pipe", "conditioner", "conditioner_engine",
      "floor_conditioner", "air_curtain", "conditioner_drainage", "warm_floor_pipe", "warm_wall_cable",
      "warm_floor", "warm_floor_water", "warm_floor_ir", "ventpipe_out", "ventpipe_in",
      "ventilation_gate", "ventilation_system", "fan", "fan_wall",
    ];
    const pick = (src: any, k: string) => {
      const v = src?.[k];
      return v ? { group: v.group, anchor: v.anchor, w: v.width, h: v.height, title: v.title, plan: v.plan, is_pro: v.is_pro ?? v.pro ?? null } : null;
    };
    out.toolKeys.global_tools = Object.fromEntries(keys.map((k) => [k, pick(w.global_tools, k)]));
    // defs — лимиты/константы редактора
    try { out.defs = JSON.parse(JSON.stringify(w.defs ?? null)); } catch { out.defs = "unserializable"; }
    return out;
  });
  writeFileSync(".orca-reports/tmp/250-src-meta.json", JSON.stringify(res, null, 1) + "\n");
  console.log("urls:", res.urls);
  // бандл в Node: fetch из страницы (та же сессия)
  const bundleUrl = res.urls[0];
  if (bundleUrl) {
    const bundle = await page.evaluate(async (u) => await (await fetch(u)).text(), bundleUrl);
    writeFileSync(".orca-reports/tmp/app-bundle-250.js", bundle);
    console.log("bundle bytes:", bundle.length);
  }
  // второй бандл — planner.tools (global_tools)
  const toolsUrls = await page.evaluate(() => (performance.getEntriesByType("resource") as any[]).map((r) => r.name).filter((u) => /planner\.tools.*\.js/.test(u)));
  if (toolsUrls[0]) {
    const t = await page.evaluate(async (u) => await (await fetch(u)).text(), toolsUrls[0]);
    writeFileSync(".orca-reports/tmp/planner-tools-250.js", t);
    console.log("tools bytes:", t.length);
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
console.log("DONE");
process.exit(0);
