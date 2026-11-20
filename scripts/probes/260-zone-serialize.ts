// 260g: точная сериализация room с zone-delimiter (без записи на сервер).
// Создаём delimiter кликами (как 260f), затем ROOMS2[rid].serialize("ceiling") в файл.
// node scripts/probes/260-zone-serialize.ts run
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
  await page.evaluate(() => { const nav: any = document.querySelector(".groups_navi_item.plan_ceiling"); if (nav) nav.click(); });
  await page.waitForTimeout(1500);
  const model: any = await page.evaluate(() => (window as any).project.copy("server"));
  const rooms = Object.entries<any>(model.rooms2 ?? {});
  const isOverPoly = (pt: { x: number; y: number }, poly: Array<{ x: number; y: number }>) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
      if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  const segCrossPoly = (a: { x: number; y: number }, b: { x: number; y: number }, poly: Array<{ x: number; y: number }>) => {
    const cross = (o: { x: number; y: number }, p: { x: number; y: number }, q: { x: number; y: number }) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
    for (let i = 0; i < poly.length; i++) {
      const c = poly[i]!, d = poly[(i + 1) % poly.length]!;
      const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    }
    return false;
  };
  let best: [string, any] = ["", null];
  for (const [rid, r] of rooms) if (!best[1] || (r as any).area > best[1].area) best = [rid, r];
  const [rid, room] = best;
  const poly: Array<{ x: number; y: number }> = room.polygon;
  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length, cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
  const external: Array<{ i: number; inPt: { x: number; y: number } }> = [];
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
    for (const [, other] of rooms) { if (other === room) continue; if (isOverPoly(outPt, other.polygon)) { neighbor = true; break; } }
    if (!neighbor) external.push({ i, inPt });
  }
  const rigelPolys: Array<Array<{ x: number; y: number }>> = [];
  for (const [rid2, r2] of Object.entries<any>(model.rooms2 ?? {})) for (const rg of Object.values<any>(r2.rigels ?? {})) if (rg.polygon) rigelPolys.push(rg.polygon);
  for (const rg of Object.values<any>(model.rigels ?? {})) if (rg.polygon) rigelPolys.push(rg.polygon);
  const wallSegs: Array<[{ x: number; y: number }, { x: number; y: number }]> = Object.values<any>(model.walls ?? {}).map((w) => [{ x: w.p1.x, y: w.p1.y }, { x: w.p2.x, y: w.p2.y }]);
  const pillarPolys: Array<Array<{ x: number; y: number }>> = Object.values<any>(model.pillars ?? {}).filter((p) => p.polygon).map((p) => p.polygon);
  const distToSeg = (pt: { x: number; y: number }, s: [{ x: number; y: number }, { x: number; y: number }]) => {
    const vx = s[1].x - s[0].x, vy = s[1].y - s[0].y;
    const t = Math.max(0, Math.min(1, ((pt.x - s[0].x) * vx + (pt.y - s[0].y) * vy) / (vx * vx + vy * vy)));
    return Math.hypot(pt.x - (s[0].x + t * vx), pt.y - (s[0].y + t * vy));
  };
  let pick: [{ i: number; inPt: { x: number; y: number } }, { i: number; inPt: { x: number; y: number } }, number] | null = null;
  for (const e1 of external) for (const e2 of external) {
    if (e1.i === e2.i) continue;
    const d = Math.hypot(e1.inPt.x - e2.inPt.x, e1.inPt.y - e2.inPt.y);
    if (d < 100) continue;
    if (rigelPolys.some((p) => segCrossPoly(e1.inPt, e2.inPt, p))) continue;
    if (pillarPolys.some((p) => segCrossPoly(e1.inPt, e2.inPt, p))) continue;
    if (wallSegs.some((s) => distToSeg(e1.inPt, s) > 6 && distToSeg(e2.inPt, s) > 6 && segCrossPoly(e1.inPt, e2.inPt, [s[0], s[1]]))) continue;
    const t1 = { x: e1.inPt.x + (e2.inPt.x - e1.inPt.x) / 3, y: e1.inPt.y + (e2.inPt.y - e1.inPt.y) / 3 };
    const t2 = { x: e1.inPt.x + (2 * (e2.inPt.x - e1.inPt.x)) / 3, y: e1.inPt.y + (2 * (e2.inPt.y - e1.inPt.y)) / 3 };
    if (!isOverPoly(t1, poly) || !isOverPoly(t2, poly)) continue;
    if (!pick || d > pick[2]) pick = [e1, e2, d];
  }
  if (!pick) { log("FAIL: нет пары"); process.exit(1); }
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
  await page.evaluate(() => { const el: any = document.querySelector("#plannertool_zone_ceiling"); if (el) el.click(); });
  await page.waitForTimeout(600);
  await clearFog();
  const s1 = await toScreen(pick[0].inPt), s2 = await toScreen(pick[1].inPt);
  await page.mouse.move(s1.x, s1.y, { steps: 5 });
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.move(s2.x, s2.y, { steps: 15 });
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(900);
  // serialize комнаты
  const ser = await page.evaluate((rid) => {
    const w: any = window as any;
    const room: any = w.ROOMS2[rid];
    const out: any = {};
    try { out.ceiling = room.serialize("ceiling"); } catch (e) { out.ceilingErr = String(e); }
    try { out.zdRuntime = Object.fromEntries(Object.entries<any>(w.ZONE_DELIMITERS ?? {}).map(([k, v]: any) => [k, v.serialize ? v.serialize() : v])); } catch (e) { out.zdErr = String(e); }
    return out;
  }, rid);
  writeFileSync(".orca-reports/tmp/260g-room-serialize.json", JSON.stringify(ser, null, 1));
  log("serialize: delimiters keys:", Object.keys(ser.ceiling?.delimiters ?? {}), "ceilings:", (ser.ceiling?.ceilings ?? []).length);
  log("zd vertexes zone present:", JSON.stringify(Object.values<any>(ser.zdRuntime ?? {})[0]?.vertexes?.[0]?.zone ?? null).slice(0, 300));
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
