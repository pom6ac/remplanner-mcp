// 260d: трассировка svg_mousedown → svg_mousedown_tool → set_source_new_node.
// node scripts/probes/260-zone-ui4.ts run
import { mkdirSync, readFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { loadModel } from "../../src/api.ts";

if (process.argv[2] !== "run") { console.error("запуск: run (ID из env)"); process.exit(0); }
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID!;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID!;
const READONLY_ID = process.env.REMPLANNER_PROBE_READONLY_ID!;
if (OBJECT_ID === READONLY_ID) { console.error("OBJECT_ID == READONLY_ID — стоп"); process.exit(1); }
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 9 * 60_000).unref();

const session = { ...loadSession(STATE_PATH), account: true } as const;
const beforeModel = await loadModel(session, OBJECT_ID, PLAN_ID);
const backupPath = `.orca-reports/backup-${OBJECT_ID}-260.json`;
const strip = (m: unknown) => { const c = structuredClone(m as Record<string, unknown>); for (const k of ["save_id", "session", "log_plan", "version"]) delete c[k]; return JSON.stringify(c); };

const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
const page = editor.page;
try {
  const log = (...a: unknown[]) => console.log(...a);
  await page.evaluate(() => {
    const w: any = window as any;
    w.__trace = [];
    const M: any = w.$ManagerLining;
    const t = (m: string) => w.__trace.push(m);
    if (M) {
      const smd = M.svg_mousedown.bind(M);
      M.svg_mousedown = (...a: unknown[]) => { t("svg_mousedown tool=" + w.tool + " plan=" + w.plan); const r = smd(...a); t("svg_mousedown→" + r); return r; };
      const smdt = M.svg_mousedown_tool.bind(M);
      M.svg_mousedown_tool = (e: any) => {
        const hit = Array.isArray(e.tools) && e.tools.includes(w.tool);
        t(`smdt ${e.class_name} hit=${hit} source_id=${e.source_id ?? null} search_item=${(() => { try { return String(e.search_item()); } catch { return "ERR"; } })()}`);
        const r = smdt(e);
        t(`smdt→${r}`);
        return r;
      };
      const ssnn = (w.$ZoneDelimitering as any).set_source_new_node.bind(w.$ZoneDelimitering);
      (w.$ZoneDelimitering as any).set_source_new_node = (...a: unknown[]) => { t("set_source_new_node called"); const r = ssnn(...a); t("ssnn→ source_id=" + (w.$ZoneDelimitering as any).source_id); return r; };
      if (w.warning?.show) {
        const orig = w.warning.show.bind(w.warning);
        w.warning.show = (ty: string, m: string) => { t(`WARN ${ty}: ${m}`); return orig(ty, m); };
      }
    } else t("$ManagerLining недоступен");
  });
  await page.evaluate(() => { const nav: any = document.querySelector(".groups_navi_item.plan_ceiling"); if (nav) nav.click(); });
  await page.waitForTimeout(1500);
  const model: any = await page.evaluate(() => (window as any).project.copy("server"));
  let best: [string, any] = ["", null];
  for (const [rid, r] of Object.entries<any>(model.rooms2 ?? {})) if (!best[1] || (r as any).area > best[1].area) best = [rid, r];
  const [, room] = best;
  const poly: Array<{ x: number; y: number }> = room.polygon;
  const inward = (i: number, d: number) => {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length, cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
    const p1 = { x: mx + nx * d, y: my + ny * d }, p2 = { x: mx - nx * d, y: my - ny * d };
    return Math.hypot(p1.x - cx, p1.y - cy) < Math.hypot(p2.x - cx, p2.y - cy) ? p1 : p2;
  };
  const ptA = inward(0, 8), ptB = inward(2 % poly.length, 8);
  const clearFog = () => page.evaluate(() => {
    const f: any = document.querySelector("#planner_ui_message_fog");
    if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
    document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
  });
  const toScreen = (p: { x: number; y: number }) => page.evaluate((pp) => {
    const svg: any = document.querySelector("#main_svg");
    const r = svg.getBoundingClientRect();
    const q = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    return { x: r.x + ((pp.x - q[0]) * r.width) / q[2], y: r.y + ((pp.y - q[1]) * r.height) / q[3] };
  }, p);
  const clickAt = async (p: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(p);
    await page.mouse.move(s.x - 8, s.y - 8);
    await page.mouse.move(s.x, s.y, { steps: 8 });
    await page.waitForTimeout(400);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(800);
  };
  const trace = async (tag: string) => {
    const tr: string[] = await page.evaluate(() => (window as any).__trace.splice(0));
    log(tag, JSON.stringify(tr, null, 1));
  };
  await page.evaluate(() => { const el: any = document.querySelector("#plannertool_zone_ceiling"); if (el) el.click(); });
  await page.waitForTimeout(600);
  await clickAt(ptA);
  await trace("после клика 1:");
  await clickAt(ptB);
  await trace("после клика 2:");
  const st: any = await page.evaluate(() => {
    const w: any = window as any;
    const zd: any = w.$ZoneDelimitering ?? {};
    return { source_id: zd.source_id ?? null, source_point: zd.source_point ?? null, zd_keys: Object.keys(w.ZONE_DELIMITERS ?? {}), allow_magnet: w.allow?.magnet };
  });
  log("state:", JSON.stringify(st));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
const after = await loadModel(session, OBJECT_ID, PLAN_ID);
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
console.log("GET после пробы == бэкап:", strip(after.model) === strip(backup.model) ? "OK — не изменился" : "РАСХОЖДЕНИЕ");
process.exit(0);
