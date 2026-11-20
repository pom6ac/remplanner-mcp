// 260e: zone_ceiling drag между внутренними точками одной комнаты + полная трассировка.
// node scripts/probes/260-zone-ui5.ts run
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  // гард: план в редакторе == серверу (ревью 261 №13, как в 260-zone-ui)
  const planInEditor = await page.evaluate(() => String((window as any).project?.copy("server")?.plan_id ?? ""));
  if (planInEditor !== String(beforeModel.plan_id)) {
    console.log("FAIL: план в редакторе", planInEditor, "!= серверу", beforeModel.plan_id); process.exit(1);
  }
  const log = (...a: unknown[]) => console.log(...a);
  await page.evaluate(() => {
    const w: any = window as any;
    w.__trace = [];
    const t = (m: string) => w.__trace.push(m);
    const M: any = w.$ManagerLining;
    if (M) {
      const smut = M.svg_mouseup_tool.bind(M);
      M.svg_mouseup_tool = (e: any, room: any) => {
        const r = smut(e, room);
        t(`smut ${e.class_name} src=${e.source_id ?? null} tp=${e.target_point ? "yes" : "no"} cd=${(() => { try { return e.class_name === w.$ZoneDelimitering.class_name ? String(e.check_delimiter()) : "-"; } catch (er) { return "ERR"; } })()} →${r}`);
        return r;
      };
      const md = (w.$ZoneDelimitering as any).mousedown.bind(w.$ZoneDelimitering);
      (w.$ZoneDelimitering as any).mousedown = (...a: unknown[]) => { t("ZD.mousedown args=" + JSON.stringify(a.map((x) => (x ? "obj" : x)))); const r = md(...a); t("ZD.mousedown→" + JSON.stringify(r)); return r; };
      const un = (w.$ZoneDelimitering as any).unselect_source_item.bind(w.$ZoneDelimitering);
      (w.$ZoneDelimitering as any).unselect_source_item = () => { t("ZD.unselect_source_item"); return un(); };
      if (w.warning?.show) {
        const orig = w.warning.show.bind(w.warning);
        w.warning.show = (ty: string, m: string) => { t(`WARN ${ty}: ${m}`); return orig(ty, m); };
      }
    }
  });
  await page.evaluate(() => { const nav: any = document.querySelector(".groups_navi_item.plan_ceiling"); if (nav) nav.click(); });
  await page.waitForTimeout(1500);
  const model: any = await page.evaluate(() => (window as any).project.copy("server"));
  let best: [string, any] = ["", null];
  for (const [rid, r] of Object.entries<any>(model.rooms2 ?? {})) if (!best[1] || (r as any).area > best[1].area) best = [rid, r];
  const [rid, room] = best;
  const poly: Array<{ x: number; y: number }> = room.polygon;
  log("комната:", rid, "poly:", poly.length);
  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length, cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
  // две точки глубоко внутри комнаты (центроид и центр + смещение)
  const ptA = { x: cx - 40, y: cy - 30 }, ptB = { x: cx + 40, y: cy + 30 };
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
  const drag = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(a), e = await toScreen(b);
    await page.mouse.move(s.x, s.y, { steps: 5 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.waitForTimeout(200);
    await page.mouse.move(e.x, e.y, { steps: 15 });
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(900);
  };
  const trace = async (tag: string) => {
    const tr: string[] = await page.evaluate(() => (window as any).__trace.splice(0));
    log(tag, JSON.stringify(tr, null, 1));
  };
  const snap = async (tag: string) => {
    const data = await page.evaluate(() => {
      const w: any = window as any;
      const zd: any = w.$ZoneDelimitering ?? {};
      const m: any = w.project.copy("server");
      const out: any = { zd_keys: Object.keys(w.ZONE_DELIMITERS ?? {}), src: zd.source_id ?? null, rooms: {} };
      for (const [k, r] of Object.entries<any>(m.rooms2 ?? {})) if (r.delimiters && Object.keys(r.delimiters).length) out.rooms[k] = r.delimiters;
      return out;
    });
    writeFileSync(`.orca-reports/tmp/260e-${tag}.json`, JSON.stringify(data, null, 1));
    return data;
  };
  await page.evaluate(() => { const el: any = document.querySelector("#plannertool_zone_ceiling"); if (el) el.click(); });
  await page.waitForTimeout(600);
  await drag(ptA, ptB);
  await trace("после drag:");
  log("snap:", JSON.stringify(await snap("drag")).slice(0, 800));
  // двухкликовый вариант: узел-источник у ребра, затем клик внутрь
  await page.evaluate(() => { const el: any = document.querySelector("#plannertool_zone_ceiling"); if (el) el.click(); });
  await page.waitForTimeout(400);
  // клик 1 у ребра (10 см внутрь), клик 2 глубоко внутри
  const a = poly[0]!, b = poly[1]!;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
  const p1 = { x: mid.x + nx * 10, y: mid.y + ny * 10 }, p2 = { x: mid.x - nx * 10, y: mid.y - ny * 10 };
  const ptEdge = Math.hypot(p1.x - cx, p1.y - cy) < Math.hypot(p2.x - cx, p2.y - cy) ? p1 : p2;
  const click = async (p: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(p);
    await page.mouse.move(s.x - 6, s.y - 6);
    await page.mouse.move(s.x, s.y, { steps: 6 });
    await page.waitForTimeout(350);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(800);
  };
  await click(ptEdge);
  await trace("после клика 1 (ребро):");
  await click({ x: cx, y: cy });
  await trace("после клика 2 (центр):");
  log("snap2:", JSON.stringify(await snap("click")).slice(0, 1200));
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
