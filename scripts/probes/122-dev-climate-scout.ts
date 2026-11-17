// 122: разведка PRO-инструментов климата в dev-проекте (env). КЛИКИ БЕЗ СОХРАНЕНИЯ:
// трасса кондиционера, соединительный провод тёплого пола, магистрали, воздуховоды,
// водяной тёплый пол, решётки. Откат — перезагрузкой; после пробы GET-сверка с бэкапом.
// Сначала пишет бэкап .orca-reports/backup-dev-122.json (если его ещё нет).
import { chromium } from "playwright-core";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID"); process.exit(1); }
const OUT = ".orca-reports/phase2-ui-refs";
mkdirSync(OUT, { recursive: true });

// watchdog 8 минут
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 8 * 60_000).unref();

const backupPath = `.orca-reports/backup-dev-122.json`;
const session = loadSession(STATE_PATH);
const beforeModel = await loadModel(session, OBJECT_ID, PLAN_ID);
if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(beforeModel, null, 1) + "\n");

const shell = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: existsSync(shell) ? shell : undefined, headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "ru-RU" });
  await ctx.addCookies(session.cookies.map((c: any) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/",
    expires: c.expires === -1 ? undefined : c.expires, httpOnly: c.httpOnly ?? false, secure: c.secure ?? false,
  })));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 200)));
  await page.goto(`https://remplanner.ru/planner/?object_id=${OBJECT_ID}&plan_id=${PLAN_ID}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project && (window as any).project, null, { timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const f: any = document.querySelector("#planner_ui_message_fog");
    if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
    document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
  });

  const model: any = beforeModel.model;
  const rooms = Object.values<any>(model.rooms2 ?? {});
  const room = rooms[0]!;
  const poly = (room.polygon ?? []).map((p: any) => ({ x: p.x, y: p.y }));
  if (poly.length < 3) { console.log("FAIL: нет полигона комнаты"); await browser.close(); process.exit(1); }
  const center = { x: poly.reduce((s: number, p: any) => s + p.x, 0) / poly.length, y: poly.reduce((s: number, p: any) => s + p.y, 0) / poly.length };
  const e0 = { p1: poly[0]!, p2: poly[1]! };
  const mid = { x: (e0.p1.x + e0.p2.x) / 2, y: (e0.p1.y + e0.p2.y) / 2 };
  const len0 = Math.hypot(e0.p2.x - e0.p1.x, e0.p2.y - e0.p1.y);
  const nx = (e0.p2.y - e0.p1.y) / len0, ny = -(e0.p2.x - e0.p1.x) / len0;
  const wallPt = { x: mid.x + nx * 10, y: mid.y + ny * 10 };

  const toScreen = async (p: { x: number; y: number }) => page.evaluate((pp) => {
    const svg: any = document.querySelector("#main_svg");
    const r = svg.getBoundingClientRect();
    const q = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    return { x: r.x + ((pp.x - q[0]) * r.width) / q[2], y: r.y + ((pp.y - q[1]) * r.height) / q[3] };
  }, p);
  const clearFog = () => page.evaluate(() => {
    const f: any = document.querySelector("#planner_ui_message_fog");
    if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
    document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
  });
  const clickAt = async (p: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(p);
    await page.mouse.move(s.x - 6, s.y - 6);
    await page.mouse.move(s.x, s.y, { steps: 6 });
    await page.waitForTimeout(250);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(700);
  };
  const dragAt = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(a), e = await toScreen(b);
    await page.mouse.move(s.x, s.y, { steps: 4 });
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.mouse.move(e.x, e.y, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(800);
  };
  const pickTool = async (key: string) => page.evaluate((k) => {
    const el: any = document.querySelector(`#plannertool_${k}`);
    if (!el) return "missing";
    const group = el.closest(".tools_item, .subtools_item");
    if (el.classList.contains("is_pro") || (group && group.classList.contains("is_pro"))) return "pro-gate";
    const parent: any = el.closest(".subtools");
    if (parent && parent.id) { const op: any = document.querySelector(`[data-target="${parent.id}"]`); op?.click(); }
    el.click();
    return "ok";
  }, key);
  const sheet = async (s: string) => {
    await clearFog();
    await page.evaluate((ss) => { const nav: any = document.querySelector(`.groups_navi_item.plan_${ss}`); if (nav) nav.click(); }, s);
    await page.waitForTimeout(1200);
    await clearFog();
  };
  const dumpGraphs = async (tag: string) => {
    const snap = await page.evaluate(() => {
      const m = (window as any).project.copy("server");
      const keep = ["warm_floors", "cables_warm_floor", "cables_conditioner", "pipes_warm_floor", "pipes_conditioner", "pipes_heat", "pipes_ventilation"];
      const res: any = {};
      for (const k of keep) res[k] = m[k] ?? null;
      res.items = Object.fromEntries(Object.entries<any>(m.items ?? {}).map(([k, v]: any) => [k, {
        name: v.name,
        props_pipes: v.pipes ?? null,
        props_cables: v.cables ?? null,
        props_cables_warm_floor: v.cables_warm_floor ?? null,
        props_cables_conditioner: v.cables_conditioner ?? null,
      }]));
      return res;
    });
    writeFileSync(`${OUT}/122-dev-${tag}.json`, JSON.stringify(snap, null, 1) + "\n");
    return snap;
  };

  // 1. тёплый пол: кабельный (free, drag) + терморегулятор (free, клик у стены)
  await sheet("warm_floor");
  console.log("pick warm_floor:", await pickTool("warm_floor"));
  await dragAt({ x: center.x - 60, y: center.y - 60 }, { x: center.x + 60, y: center.y + 60 });
  await page.keyboard.press("Escape");
  console.log("pick socket_thermo:", await pickTool("socket_thermo"));
  await clickAt(wallPt);
  await page.keyboard.press("Escape");
  await dumpGraphs("wf-thermo");

  // 2. соединительный провод (PRO): drag от терморегулятора к центру контура
  console.log("pick warm_floor_wire:", await pickTool("warm_floor_wire"));
  const thermo = await page.evaluate(() => {
    const w = window as any;
    const it = Object.values<any>(w.ITEMS).find((x: any) => (x.props?.socket_group ?? []).some((s: any) => s.name === "socket_thermo"));
    return it ? it.props : null;
  });
  if (thermo) await dragAt({ x: thermo.pc.x, y: thermo.pc.y }, { x: center.x, y: center.y });
  await page.keyboard.press("Escape");
  await dumpGraphs("wf-wire");

  // 3. водяной тёплый пол (PRO) и магистрали (PRO) — вторая комната, если есть
  const room2: any = rooms[1];
  const c2 = room2
    ? { x: room2.polygon.reduce((s: number, p: any) => s + p.x, 0) / room2.polygon.length, y: room2.polygon.reduce((s: number, p: any) => s + p.y, 0) / room2.polygon.length }
    : { x: center.x + 150, y: center.y };
  await sheet("warm_floor");
  console.log("pick warm_floor_water:", await pickTool("warm_floor_water"));
  await dragAt({ x: c2.x - 50, y: c2.y - 50 }, { x: c2.x + 50, y: c2.y + 50 });
  await page.keyboard.press("Escape");
  console.log("pick warm_floor_pipe:", await pickTool("warm_floor_pipe"));
  await dragAt({ x: c2.x + 55, y: c2.y }, { x: c2.x + 155, y: c2.y });
  await page.keyboard.press("Escape");
  await dumpGraphs("wf-water-pipe");

  // 4. кондиционеры: внутренний + внешний блок (free), трасса (PRO), дренаж (PRO)
  await sheet("conditioners");
  console.log("pick conditioner:", await pickTool("conditioner"));
  await clickAt({ x: wallPt.x - 40, y: wallPt.y });
  await page.keyboard.press("Escape");
  console.log("pick conditioner_engine:", await pickTool("conditioner_engine"));
  await clickAt({ x: wallPt.x + 60, y: wallPt.y });
  await page.keyboard.press("Escape");
  await dumpGraphs("cond-items");
  console.log("pick conditioner_wire:", await pickTool("conditioner_wire"));
  await dragAt({ x: wallPt.x - 40, y: wallPt.y }, { x: wallPt.x + 60, y: wallPt.y + 10 });
  await page.keyboard.press("Escape");
  await dumpGraphs("cond-wire");
  console.log("pick conditioner_drainage:", await pickTool("conditioner_drainage"));
  await dragAt({ x: wallPt.x - 40, y: wallPt.y + 5 }, { x: wallPt.x + 120, y: wallPt.y + 5 });
  await page.keyboard.press("Escape");
  await dumpGraphs("cond-drainage");

  // 5. вентиляция: решётки, оборудование, воздуховоды
  await sheet("ventilation");
  const ventProbe = async (tool: string, a: { x: number; y: number }, b?: { x: number; y: number }) => {
    console.log(`pick ${tool}:`, await pickTool(tool));
    if (b) await dragAt(a, b); else await clickAt(a);
    await page.keyboard.press("Escape");
    await dumpGraphs(`vent-${tool}`);
  };
  await ventProbe("ventilation_gate", { x: center.x, y: center.y });
  await ventProbe("ventilation_gate_long", { x: center.x + 40, y: center.y });
  await ventProbe("ventilation_system", { x: wallPt.x + 20, y: wallPt.y });
  await ventProbe("ventpipe_out", { x: center.x, y: center.y + 20 }, { x: center.x + 120, y: center.y + 20 });
  await ventProbe("ventpipe_in", { x: center.x - 120, y: center.y - 20 }, { x: center.x, y: center.y - 20 });

  // 6. радиатор + магистрали отопления (PRO)
  await sheet("radiators");
  console.log("pick radiator_bimetal:", await pickTool("radiator_bimetal"));
  await clickAt(wallPt);
  await page.keyboard.press("Escape");
  console.log("pick heat_pipe_hot:", await pickTool("heat_pipe_hot"));
  await dragAt({ x: wallPt.x + 10, y: wallPt.y + 4 }, { x: wallPt.x + 90, y: wallPt.y + 4 });
  await page.keyboard.press("Escape");
  await dumpGraphs("heat");

  // откат: перезагрузка без save
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
} finally {
  await browser.close().catch(() => {});
}

// GET-сверка с бэкапом
const afterModel = await loadModel(session, OBJECT_ID, PLAN_ID);
const strip = (m: any) => { const c = { ...m }; delete c.save_id; delete c.log_plan; delete c.session; return JSON.stringify(c); };
console.log("GET после пробы == бэкап:", strip(afterModel.model) === strip(JSON.parse(readFileSync(backupPath, "utf8")).model) ? "OK — не изменился" : "РАСХОЖДЕНИЕ");
console.log("DONE");
process.exit(0);
