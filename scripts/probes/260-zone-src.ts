// 260: разведка источников редактора для зонирования потолка. КЛИКОВ И ЗАПИСИ НЕТ:
// в странице fetch бандлов app.*.min.js и planner.tools*.js — в .orca-reports/tmp/;
// снимок global_tools для zone_ceiling/zone_floor/ceiling_rigel, defs, классов ZONE_DELIMITERS.
// node scripts/probes/260-zone-src.ts run
import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_ANON_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { createAnonProject } from "../../src/api.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу run");
  process.exit(0);
}
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 6 * 60_000).unref();

const session = loadSession(STATE_ANON_PATH);
const proj = await createAnonProject(session);
console.log("anon:", proj.object_id, proj.plan_id);
const editor = await openEditor(session, proj.object_id, proj.plan_id || "1", 60_000, { anonymous: true });
try {
  const page = editor.page;
  const res = await page.evaluate(() => {
    const w: any = window as any;
    const out: any = { toolKeys: {}, globals: {} };
    const keys = ["zone_ceiling", "zone_floor", "ceiling_rigel", "rigel", "zone_delimiters"];
    const pick = (src: any, k: string) => {
      const v = src?.[k];
      return v ? { group: v.group, anchor: v.anchor, title: v.title, plan: v.plan, is_pro: v.is_pro ?? v.pro ?? null } : null;
    };
    out.toolKeys.global_tools = Object.fromEntries(keys.map((k) => [k, pick(w.global_tools, k)]));
    for (const g of ["ZONE_DELIMITERS", "DELIMITERS", "RIGELS", "CEILING"]) out.globals[g] = typeof w[g];
    // классы-прототипы с методами serialize/restore — поищем в глобалах
    out.defsKeys = w.defs ? Object.keys(w.defs).filter((k) => /zone|delimiter|rigel|ceiling/i.test(k)) : [];
    try { out.defsZone = JSON.parse(JSON.stringify({ zone: (w.defs ?? {}).zone ?? null, delimiter: (w.defs ?? {}).delimiter ?? null })); } catch { out.defsZone = null; }
    return out;
  });
  writeFileSync(".orca-reports/tmp/260-src-meta.json", JSON.stringify(res, null, 1) + "\n");
  console.log("meta:", JSON.stringify(res, null, 1).slice(0, 1500));
  const urls = await page.evaluate(() => (performance.getEntriesByType("resource") as any[]).map((r: any) => r.name).filter((u: string) => /app\..*\.min\.js|planner\.tools.*\.js/.test(u)));
  console.log("urls:", urls);
  for (const [i, u] of urls.entries()) {
    const bundle = await page.evaluate(async (url) => await (await fetch(url)).text(), u);
    const name = u.includes("tools") ? `planner-tools-260-${i}.js` : `app-bundle-260-${i}.js`;
    writeFileSync(`.orca-reports/tmp/${name}`, bundle);
    console.log(name, bundle.length);
  }
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
process.exit(0);
