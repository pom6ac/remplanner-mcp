// 250: разведка подключений климата ч.2 в dev-проекте (env). КЛИКИ БЕЗ СОХРАНЕНИЯ:
// радиатор + магистрали отопления (hot/cold), кондиционер + дренаж + трасса,
// водяной контур + магистраль тёплого пола, вентилятор + воздуховод.
// Откат — перезагрузкой; GET-сверка с бэкапом .orca-reports/backup-dev-250.json.
// node scripts/probes/250-climate2-connect.ts run
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { loadModel } from "../../src/api.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу run (ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID"); process.exit(1); }
mkdirSync(".orca-reports/tmp", { recursive: true });
const OUT = ".orca-reports/tmp";
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 9 * 60_000).unref();

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
const page = editor.page;
try {
  const snap = async (tag: string) => {
    const data = await page.evaluate(() => {
      const m: any = (window as any).project.copy("server");
      const keep = ["warm_floors", "cables_warm_floor", "cables_conditioner", "pipes_warm_floor", "pipes_conditioner", "pipes_heat", "pipes_ventilation"];
      const res: any = {};
      for (const k of keep) res[k] = m[k] ?? null;
      res.items = Object.fromEntries(Object.entries<any>(m.items ?? {}).map(([k, v]: any) => [k, {
        name: v.name,
        pc: v.pc,
        props_pipes: v.pipes ?? null,
        props_pipes_heat: v.pipes_heat ?? null,
        props_pipes_conditioner: v.pipes_conditioner ?? null,
        props_pipes_warm_floor: v.pipes_warm_floor ?? null,
        props_pipes_ventilation: v.pipes_ventilation ?? null,
        props_cables_conditioner: v.cables_conditioner ?? null,
        props_cables_warm_floor: v.cables_warm_floor ?? null,
      }]));
      return res;
    });
    writeFileSync(`${OUT}/250-connect-${tag}.json`, JSON.stringify(data, null, 1) + "\n");
    return data;
  };
  const log = (...a: unknown[]) => console.log(...a);

  // геометрия: первая комната из модели
  const model: any = (await page.evaluate(() => (window as any).project.copy("server")));
  const rooms = Object.values<any>(model.rooms2 ?? {});
  const room = rooms[0]!;
  const poly = (room.polygon ?? []).map((p: any) => ({ x: p.x, y: p.y }));
  if (poly.length < 3) { console.log("FAIL: нет полигона комнаты"); process.exit(1); }
  const center = { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length };
  const e0 = { p1: poly[0]!, p2: poly[1]! };
  const mid = { x: (e0.p1.x + e0.p2.x) / 2, y: (e0.p1.y + e0.p2.y) / 2 };
  const len0 = Math.hypot(e0.p2.x - e0.p1.x, e0.p2.y - e0.p1.y);
  const nx = (e0.p2.y - e0.p1.y) / len0, ny = -(e0.p2.x - e0.p1.x) / len0;
  const wallPt = { x: mid.x + nx * 15, y: mid.y + ny * 15 };
  const room2: any = rooms[1] ?? room;
  const c2 = { x: room2.polygon.reduce((s: number, p: any) => s + p.x, 0) / room2.polygon.length, y: room2.polygon.reduce((s: number, p: any) => s + p.y, 0) / room2.polygon.length };

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
  const pickTool = async (key: string) => {
    const r = await page.evaluate((k) => {
      const el: any = document.querySelector(`#plannertool_${k}`);
      if (!el) return "missing";
      const group = el.closest(".tools_item, .subtools_item");
      if (el.classList.contains("is_pro") || (group && group.classList.contains("is_pro"))) return "pro-gate";
      const parent: any = el.closest(".subtools");
      if (parent && parent.id) { const op: any = document.querySelector(`[data-target="${parent.id}"]`); op?.click(); }
      el.click();
      return "ok";
    }, key);
    // PRO-гейт: dev-проект на платном тарифе — окно не должно открываться; на всякий случай закроем
    await page.evaluate(() => {
      const b: any = document.querySelector(".planner_ui_message.active .close, #planner_ui_message_close");
      if (b && document.querySelector(".planner_ui_message.active")?.textContent?.includes("PRO")) b.click();
    });
    return r;
  };
  const sheet = async (s: string) => {
    await clearFog();
    await page.evaluate((ss) => { const nav: any = document.querySelector(`.groups_navi_item.plan_${ss}`); if (nav) nav.click(); }, s);
    await page.waitForTimeout(1200);
    await clearFog();
  };
  const esc = () => page.keyboard.press("Escape");

  // 1. радиатор + подача + обратка
  await sheet("radiators");
  log("pick radiator_bimetal:", await pickTool("radiator_bimetal"));
  await clickAt(wallPt);
  await esc();
  log("pick heat_pipe_hot:", await pickTool("heat_pipe_hot"));
  await dragAt({ x: wallPt.x + 5, y: wallPt.y + 3 }, { x: wallPt.x + 90, y: wallPt.y + 3 });
  await esc();
  log("pick heat_pipe_cold:", await pickTool("heat_pipe_cold"));
  await dragAt({ x: wallPt.x + 5, y: wallPt.y + 8 }, { x: wallPt.x + 90, y: wallPt.y + 8 });
  await esc();
  await snap("heat");

  // 2. кондиционер + дренаж + трасса
  await sheet("conditioners");
  log("pick conditioner:", await pickTool("conditioner"));
  await clickAt({ x: wallPt.x + 30, y: wallPt.y });
  await esc();
  log("pick conditioner_engine:", await pickTool("conditioner_engine"));
  await clickAt({ x: wallPt.x - 30, y: wallPt.y });
  await esc();
  await snap("cond-items");
  log("pick conditioner_wire:", await pickTool("conditioner_wire"));
  await dragAt({ x: wallPt.x + 30, y: wallPt.y }, { x: wallPt.x - 30, y: wallPt.y });
  await esc();
  await snap("cond-wire");
  log("pick conditioner_drainage:", await pickTool("conditioner_drainage"));
  await dragAt({ x: wallPt.x + 30, y: wallPt.y + 4 }, { x: wallPt.x - 30, y: wallPt.y + 4 });
  await esc();
  await snap("cond-drainage");

  // 3. водяной контур + магистраль тёплого пола (вторая комната)
  await sheet("warm_floor");
  log("pick warm_floor_water:", await pickTool("warm_floor_water"));
  await dragAt({ x: c2.x - 50, y: c2.y - 50 }, { x: c2.x + 50, y: c2.y + 50 });
  await esc();
  await snap("wf-water");
  log("pick warm_floor_pipe:", await pickTool("warm_floor_pipe"));
  await dragAt({ x: c2.x + 55, y: c2.y }, { x: c2.x + 155, y: c2.y });
  await esc();
  await snap("wf-pipe");

  // 4. вентилятор + воздуховод
  await sheet("ventilation");
  log("pick fan:", await pickTool("fan"));
  await clickAt({ x: center.x, y: center.y });
  await esc();
  log("pick ventpipe_out:", await pickTool("ventpipe_out"));
  await dragAt({ x: center.x + 10, y: center.y + 5 }, { x: center.x + 110, y: center.y + 5 });
  await esc();
  await snap("vent");

  // откат без save
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
// GET-сверка с бэкапом
const after = await loadModel(session, OBJECT_ID, PLAN_ID);
const backup = JSON.parse(readFileSync(".orca-reports/backup-dev-250.json", "utf8"));
const strip = (m: any) => { const c = { ...m }; delete c.save_id; delete c.log_plan; delete c.session; return JSON.stringify(c); };
console.log("GET после пробы == бэкап:", strip(after.model) === strip(backup.model) ? "OK — не изменился" : "РАСХОЖДЕНИЕ");
process.exit(0);
