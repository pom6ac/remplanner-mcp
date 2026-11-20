// 260c: диагностика кликов zone_ceiling — состояние $ZoneDelimitering/mouse.over до/после.
// КЛИКИ БЕЗ СОХРАНЕНИЯ; откат — перезагрузкой; GET-сверка с бэкапом.
// node scripts/probes/260-zone-ui3.ts run
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
  // патч warning.show
  await page.evaluate(() => {
    const w: any = window as any;
    w.__warns = [];
    if (w.warning && w.warning.show) {
      const orig = w.warning.show.bind(w.warning);
      w.warning.show = (t: string, m: string, ...r: unknown[]) => { w.__warns.push(`${t}: ${m}`); return orig(t, m, ...r); };
    } else w.__warns.push("warning.show недоступен: " + typeof w.warning);
  });
  // на лист потолков
  await page.evaluate(() => { const nav: any = document.querySelector(".groups_navi_item.plan_ceiling"); if (nav) nav.click(); });
  await page.waitForTimeout(1500);
  const state = (tag: string) => page.evaluate((t) => {
    const w: any = window as any;
    const zd: any = w.$ZoneDelimitering ?? {};
    return {
      tag: t,
      tool: w.tool, plan: w.plan,
      mouse_over_room: w.mouse?.over?.room ?? null,
      mouse_end: w.mouse?.end ? { x: Math.round(w.mouse.end.x * 10) / 10, y: Math.round(w.mouse.end.y * 10) / 10 } : null,
      source_id: zd.source_id ?? null, source_point: zd.source_point ?? null,
      source_zone: zd.source_zone ?? null, target_zone: zd.target_zone ?? null, target_point: zd.target_point ?? null,
      warns: (w.__warns ?? []).splice(0),
      zd_keys: Object.keys(w.ZONE_DELIMITERS ?? {}),
    };
  }, tag);
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
  log("ptA:", JSON.stringify(ptA), "ptB:", JSON.stringify(ptB));
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
  const moveAt = async (p: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(p);
    await page.mouse.move(s.x - 10, s.y - 10);
    await page.mouse.move(s.x, s.y, { steps: 8 });
    await page.waitForTimeout(400);
  };
  const clickAt = async (p: { x: number; y: number }) => {
    await moveAt(p);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(800);
  };

  // pick tool
  await page.evaluate(() => { const el: any = document.querySelector("#plannertool_zone_ceiling"); if (el) el.click(); });
  await page.waitForTimeout(600);
  log("после pick:", JSON.stringify(await state("picked")));
  log("mousemove к ptA:");
  await moveAt(ptA);
  log(JSON.stringify(await state("move-A")));
  await clickAt(ptA);
  log("после клика 1:", JSON.stringify(await state("click-A")));
  await moveAt(ptB);
  log("mousemove к ptB:");
  log(JSON.stringify(await state("move-B")));
  await clickAt(ptB);
  log("после клика 2:", JSON.stringify(await state("click-B")));
  writeFileSync(".orca-reports/tmp/260c-final.json", JSON.stringify(await state("final"), null, 1));

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
