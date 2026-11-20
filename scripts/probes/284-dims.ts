// 284: константы ShieldDimensions бандла app.3.0 (slot для reorder, bus defaults)
// — только чтение, без действий в модели.
// Запуск: node --experimental-strip-types scripts/probes/284-dims.ts run
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";

if (process.argv[2] !== "run") { console.error("запуск: … run"); process.exit(0); }
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
mkdirSync(".orca-reports/tmp", { recursive: true });
const session = loadSession(STATE_PATH);
const shell = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: existsSync(shell) ? shell : undefined, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "ru-RU" });
await ctx.addCookies(session.cookies.map((c: any) => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/",
  expires: c.expires === -1 ? undefined : c.expires, httpOnly: c.httpOnly ?? false, secure: c.secure ?? false,
})));
const page = await ctx.newPage();
await page.goto(`https://remplanner.ru/planner/?object_id=${OBJECT_ID}&plan_id=${PLAN_ID}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as any).WALLS && (window as any).ShieldDimensions, null, { timeout: 60000 });
await page.waitForTimeout(1500);
const dims = await page.evaluate(() => {
  const d: any = (window as any).ShieldDimensions;
  return {
    module_slot: d?.module?.slot,
    module_default_group: d?.module?.default_group_number,
    bus: { default_sockets: d?.bus?.default_sockets, slot_height: d?.bus?.slot_height, slot_margin_y: d?.bus?.slot_margin_y, bus_bar_margin_x: d?.shield?.bus_bar_margin_x },
    rail_max_length: d?.rail?.max_length,
    wire: d?.wire ?? null,
    keys: Object.keys(d ?? {}),
  };
});
writeFileSync(".orca-reports/tmp/284-dims.json", JSON.stringify(dims, null, 1));
console.log(JSON.stringify(dims));
await browser.close().catch(() => {});
