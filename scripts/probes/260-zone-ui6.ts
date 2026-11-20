// 260f: zone_ceiling drag между ВНЕШНИМИ рёбрами одной комнаты.
// Внешнее ребро = ребро стены, по другую сторону которого нет другой комнаты.
// node scripts/probes/260-zone-ui6.ts run
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
  const log = (...a: unknown[]) => console.log(...a);
  await page.evaluate(() => {
    const w: any = window as any;
    w.__trace = [];
    const t = (m: string) => w.__trace.push(m);
    if (w.warning?.show) {
      const orig = w.warning.show.bind(w.warning);
      w.warning.show = (ty: string, m: string) => { t(`WARN ${ty}: ${m}`); return orig(ty, m); };
    }
    const M: any = w.$ManagerLining;
    if (M) {
      const smut = M.svg_mouseup_tool.bind(M);
      M.svg_mouseup_tool = (e: any, room: any) => {
        const r = smut(e, room);
        if (e.class_name === w.$ZoneDelimitering.class_name) t(`smut ZD src=${e.source_id ?? null} tp=${e.target_point ? "yes" : "no"} →${r}`);
        return r;
      };
    }
  });
  await page.evaluate(() => { const nav: any = document.querySelector(".groups_navi_item.plan_ceiling"); if (nav) nav.click(); });
  await page.waitForTimeout(1500);
  const model: any = await page.evaluate(() => (window as any).project.copy("server"));
  const rooms = Object.entries<any>(model.rooms2 ?? {});
  // ищем прямоугольную комнату с внешними стенами: у которой минимум 2 непараллельных внешних ребра
  const isOverPoly = (pt: { x: number; y: number }, poly: Array<{ x: number; y: number }>) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
      if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  const candidates: Array<{ rid: string; edges: Array<{ i: number; mid: { x: number; y: number }; inPt: { x: number; y: number } }>; poly: Array<{ x: number; y: number }> }> = [];
  for (const [rid, r] of rooms) {
    const poly: Array<{ x: number; y: number }> = r.polygon;
    if (poly.length < 3) continue;
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length, cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
    const external: Array<{ i: number; mid: { x: number; y: number }; inPt: { x: number; y: number } }> = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 60) continue;
      const nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
      const o1 = { x: mx + nx * 5, y: my + ny * 5 }, o2 = { x: mx - nx * 5, y: my - ny * 5 };
      const inPt = isOverPoly(o1, poly) ? o1 : o2;
      const outPt = inPt === o1 ? o2 : o1;
      let neighbor = false;
      for (const [, other] of rooms) {
        if (other === r) continue;
        if (isOverPoly(outPt, other.polygon)) { neighbor = true; break; }
      }
      if (!neighbor) external.push({ i, mid: { x: mx, y: my }, inPt });
    }
    if (external.length >= 2) candidates.push({ rid, edges: external, poly });
  }
  log("кандидаты:", candidates.map((c) => `${c.rid} внешних рёбер ${c.edges.length}`).join("; "));
  // полигоны ригелей комнаты (глобальные + закладные) — прямая между рёбрами не должна их пересекать
  const segCrossPoly = (a: { x: number; y: number }, b: { x: number; y: number }, poly: Array<{ x: number; y: number }>) => {
    const cross = (o: { x: number; y: number }, p: { x: number; y: number }, q: { x: number; y: number }) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
    for (let i = 0; i < poly.length; i++) {
      const c = poly[i]!, d = poly[(i + 1) % poly.length]!;
      const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    }
    return false;
  };
  const rigelPolys: Array<Array<{ x: number; y: number }>> = [];
  for (const [rid2, r2] of Object.entries<any>(model.rooms2 ?? {})) {
    for (const rg of Object.values<any>(r2.rigels ?? {})) if (rg.polygon) rigelPolys.push(rg.polygon);
  }
  for (const rg of Object.values<any>(model.rigels ?? {})) if (rg.polygon) rigelPolys.push(rg.polygon);
  // оси стен и полигоны колонн
  const wallSegs: Array<[{ x: number; y: number }, { x: number; y: number }]> = Object.values<any>(model.walls ?? {}).map((w) => [{ x: w.p1.x, y: w.p1.y }, { x: w.p2.x, y: w.p2.y }]);
  const pillarPolys: Array<Array<{ x: number; y: number }>> = Object.values<any>(model.pillars ?? {}).filter((p) => p.polygon).map((p) => p.polygon);
  const cand = candidates.sort((a, b) => b.edges.length - a.edges.length)[0]!;
  let pick: [{ i: number; mid: { x: number; y: number }; inPt: { x: number; y: number } }, { i: number; mid: { x: number; y: number }; inPt: { x: number; y: number } }, number] | null = null;
  const distToSeg = (pt: { x: number; y: number }, s: [{ x: number; y: number }, { x: number; y: number }]) => {
    const vx = s[1].x - s[0].x, vy = s[1].y - s[0].y;
    const t = Math.max(0, Math.min(1, ((pt.x - s[0].x) * vx + (pt.y - s[0].y) * vy) / (vx * vx + vy * vy)));
    return Math.hypot(pt.x - (s[0].x + t * vx), pt.y - (s[0].y + t * vy));
  };
  for (const e1 of cand.edges) {
    for (const e2 of cand.edges) {
      if (e1.i === e2.i) continue;
      const d = Math.hypot(e1.inPt.x - e2.inPt.x, e1.inPt.y - e2.inPt.y);
      if (d < 100) continue;
      if (rigelPolys.some((p) => segCrossPoly(e1.inPt, e2.inPt, p))) continue;
      if (pillarPolys.some((p) => segCrossPoly(e1.inPt, e2.inPt, p))) continue;
      // оси стен: пропускаем стены, которым принадлежат сами рёбра (pid совпадает — проверяем дистанцию до середины > 6)
      if (wallSegs.some((s) => distToSeg(e1.inPt, s) > 6 && distToSeg(e2.inPt, s) > 6 && segCrossPoly(e1.inPt, e2.inPt, [s[0], s[1]]))) continue;
      // отрезок целиком внутри комнаты: середины третей в полигоне
      const third1 = { x: e1.inPt.x + (e2.inPt.x - e1.inPt.x) / 3, y: e1.inPt.y + (e2.inPt.y - e1.inPt.y) / 3 };
      const third2 = { x: e1.inPt.x + (2 * (e2.inPt.x - e1.inPt.x)) / 3, y: e1.inPt.y + (2 * (e2.inPt.y - e1.inPt.y)) / 3 };
      if (!isOverPoly(third1, cand.poly) || !isOverPoly(third2, cand.poly)) continue;
      if (!pick || d > pick[2]) pick = [e1, e2, d];
    }
  }
  if (!pick) { log("FAIL: нет пары внешних рёбер без пересечения ригелей"); process.exit(1); }
  const [e1, e2, bestD] = pick;
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
    log(tag, JSON.stringify(tr));
  };
  const snap = async (tag: string) => {
    const data = await page.evaluate(() => {
      const w: any = window as any;
      const m: any = w.project.copy("server");
      const zds: any = w.ZONE_DELIMITERS ?? {};
      return {
        runtime: Object.fromEntries(Object.entries<any>(zds).map(([k, v]: any) => [k, v.serialize ? v.serialize() : v])),
        rooms: Object.fromEntries(Object.entries<any>(m.rooms2 ?? {}).filter(([, r]: any) => r.delimiters && Object.keys(r.delimiters).length).map(([k, r]: any) => [k, r.delimiters])),
        ceilings: Object.fromEntries(Object.entries<any>(m.rooms2 ?? {}).map(([k, r]: any) => [k, (r.ceilings ?? []).length])),
      };
    });
    writeFileSync(`.orca-reports/tmp/260f-${tag}.json`, JSON.stringify(data, null, 1));
    return data;
  };
  await page.evaluate(() => { const el: any = document.querySelector("#plannertool_zone_ceiling"); if (el) el.click(); });
  await page.waitForTimeout(600);
  await drag(e1.inPt, e2.inPt);
  await trace("после drag:");
  const s1 = await snap("drag");
  log("snap:", JSON.stringify(s1).slice(0, 1500));
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
