// 260b: разведка зонирования потолка кликами в dev-проекте (env) — на листе «Потолки».
// КЛИКИ БЕЗ СОХРАНЕНИЯ; откат — перезагрузкой; GET-сверка с бэкапом.
// node scripts/probes/260-zone-ui2.ts run
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
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
const OUT = ".orca-reports/tmp";
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 9 * 60_000).unref();

const session = { ...loadSession(STATE_PATH), account: true } as const;
const beforeModel = await loadModel(session, OBJECT_ID, PLAN_ID);
const backupPath = `.orca-reports/backup-${OBJECT_ID}-260.json`;
const strip = (m: unknown) => { const c = structuredClone(m as Record<string, unknown>); for (const k of ["save_id", "session", "log_plan", "version"]) delete c[k]; return JSON.stringify(c); };

const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
const page = editor.page;
try {
  const planInEditor = await page.evaluate(() => String((window as any).project?.copy("server")?.plan_id ?? ""));
  if (planInEditor !== String(beforeModel.plan_id)) { console.log("FAIL: план в редакторе", planInEditor, "!=", beforeModel.plan_id); process.exit(1); }

  const log = (...a: unknown[]) => console.log(...a);
  const snapRoom = async (tag: string) => {
    const data = await page.evaluate(() => {
      const w: any = window as any;
      const m: any = w.project.copy("server");
      const zds: any = w.ZONE_DELIMITERS ?? {};
      const res: any = {
        plan: w.plan,
        tool: w.tool,
        runtime_zone_delimiters: Object.fromEntries(Object.entries<any>(zds).map(([k, v]: any) => [k, v.serialize ? v.serialize() : v])),
        rooms: {},
      };
      for (const [rid, r] of Object.entries<any>(m.rooms2 ?? {})) {
        res.rooms[rid] = {
          delimiters: r.delimiters ?? null,
          rigels: r.rigels ?? null,
          ceilings: (r.ceilings ?? []).map((c: any) => ({ exist: c.exist, material: c.material, level: c.level, poly_n: (c.polygon ?? []).length })),
        };
      }
      return res;
    });
    writeFileSync(`${OUT}/260b-${tag}.json`, JSON.stringify(data, null, 1) + "\n");
    return data;
  };
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
    await page.mouse.move(s.x - 6, s.y - 6);
    await page.mouse.move(s.x, s.y, { steps: 6 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(700);
  };
  const warnings = () => page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll(".planner_ui_message.active").forEach((e) => out.push((e.textContent ?? "").trim().slice(0, 120)));
    const fog: any = document.querySelector("#planner_ui_message_fog");
    if (fog && fog.classList.contains("active") && fog.innerHTML.trim()) out.push("FOG: " + fog.innerHTML.trim().slice(0, 120));
    return out;
  });
  const pickTool = async (key: string) => {
    const r = await page.evaluate((k) => {
      const el: any = document.querySelector(`#plannertool_${k}`);
      if (!el) return "missing";
      el.click();
      return "ok:" + String((window as any).tool);
    }, key);
    await page.waitForTimeout(600);
    return r;
  };

  const model: any = await page.evaluate(() => (window as any).project.copy("server"));
  let best: [string, any] = ["", null];
  for (const [rid, r] of Object.entries<any>(model.rooms2 ?? {})) if (!best[1] || (r as any).area > best[1].area) best = [rid, r];
  const [rid, room] = best;
  const poly: Array<{ x: number; y: number }> = room.polygon;
  log("комната:", rid, "poly_n:", poly.length, "ceilings:", JSON.stringify((room.ceilings ?? []).map((c: any) => c.exist)));
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

  // список листов
  const navi = await page.evaluate(() => Array.from(document.querySelectorAll(".groups_navi_item")).map((e: any) => ({ cls: e.className, txt: (e.textContent ?? "").trim().slice(0, 30) })));
  log("navi:", JSON.stringify(navi));

  // на лист потолков
  await clearFog();
  await page.evaluate(() => { const nav: any = document.querySelector(".groups_navi_item.plan_ceiling"); if (nav) nav.click(); });
  await page.waitForTimeout(1500);
  await clearFog();
  log("план после переключения:", await page.evaluate(() => (window as any).plan));
  await snapRoom("ceiling-sheet");

  log("pick zone_ceiling:", await pickTool("zone_ceiling"));
  await clickAt(ptA);
  log("после клика 1, warnings:", JSON.stringify(await warnings()));
  await snapRoom("c1");
  await clickAt(ptB);
  log("после клика 2, warnings:", JSON.stringify(await warnings()));
  await snapRoom("c2");

  await page.keyboard.press("Escape");
  // откат без save
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
