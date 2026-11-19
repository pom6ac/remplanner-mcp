// 250: добор 4 — кондиционер: провод и дренаж от ГРАНИ габарита (клики без сохранения).
// node scripts/probes/250-climate2-connect4.ts run
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { loadModel } from "../../src/api.ts";

if (process.argv[2] !== "run") { console.error("запуск по аргументу run"); process.exit(0); }
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 8 * 60_000).unref();

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
const page = editor.page;
try {
  const snap = async (tag: string) => {
    const data = await page.evaluate(() => {
      const m: any = (window as any).project.copy("server");
      const res: any = {};
      for (const k of ["cables_conditioner", "pipes_conditioner"]) res[k] = m[k] ?? null;
      res.items = Object.fromEntries(Object.entries<any>(m.items ?? {}).map(([k, v]: any) => [k, {
        name: v.name, pc: v.pc, angle: v.angle, width: v.width, height: v.height,
        props_pipes_conditioner: v.pipes_conditioner ?? null,
        props_cables_conditioner: v.cables_conditioner ?? null,
      }]));
      return res;
    });
    writeFileSync(`.orca-reports/tmp/250-connect4-${tag}.json`, JSON.stringify(data, null, 1) + "\n");
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
  const dragAt = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(a), e = await toScreen(b);
    await page.mouse.move(s.x, s.y, { steps: 4 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.mouse.move(e.x, e.y, { steps: 16 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(900);
  };
  const pickTool = async (key: string) => page.evaluate((k) => {
    const el: any = document.querySelector(`#plannertool_${k}`);
    if (!el) return "missing";
    el.click();
    return "ok";
  }, key);
  const sheet = async (s: string) => {
    await clearFog();
    await page.evaluate((ss) => { const nav: any = document.querySelector(`.groups_navi_item.plan_${ss}`); if (nav) nav.click(); }, s);
    await page.waitForTimeout(1200);
    await clearFog();
  };
  const esc = () => page.keyboard.press("Escape");

  const model0: any = await page.evaluate(() => (window as any).project.copy("server"));
  let cond = Object.values<any>(model0.items).find((i: any) => i.name === "conditioner");
  let eng = Object.values<any>(model0.items).find((i: any) => i.name === "conditioner_engine");
  const rooms = Object.values<any>(model0.rooms2 ?? {});
  const room = rooms[0]!;
  const poly = (room.polygon ?? []).map((p: any) => ({ x: p.x, y: p.y }));
  const e0 = { p1: poly[0]!, p2: poly[1]! };
  const lenW = Math.hypot(e0.p2.x - e0.p1.x, e0.p2.y - e0.p1.y);
  const midW = { x: (e0.p1.x + e0.p2.x) / 2, y: (e0.p1.y + e0.p2.y) / 2 };
  const nxW = (e0.p2.y - e0.p1.y) / lenW, nyW = -(e0.p2.x - e0.p1.x) / lenW;
  const wallPt = { x: midW.x + nxW * 15, y: midW.y + nyW * 15 };
  const dxW = (e0.p2.x - e0.p1.x) / lenW, dyW = (e0.p2.y - e0.p1.y) / lenW;
  const clickAt = async (p: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(p);
    await page.mouse.move(s.x - 6, s.y - 6);
    await page.mouse.move(s.x, s.y, { steps: 6 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(800);
  };
  const itemsOf = async () => page.evaluate(() => (window as any).project.copy("server").items);
  const pickItemTool = async (key: string, groupTitle: string) => page.evaluate(({ k, g }) => {
    const el: any = document.querySelector(`#plannertool_${k}`);
    if (!el) return "missing";
    const tops = Array.from(document.querySelectorAll(".tools .tools_item, #planner_ui_tools .tools_item")) as any[];
    const gr = tops.find((t) => (t.textContent || "").includes(g));
    gr?.click();
    el.click();
    return "ok";
  }, { k: key, g: groupTitle });
  if (!cond) {
    await sheet("conditioners");
    console.log("pick conditioner:", await pickItemTool("conditioner", "Внутренние блоки"));
    await clickAt({ x: wallPt.x, y: wallPt.y });
    await esc();
    cond = Object.values<any>(await itemsOf()).find((i: any) => i.name === "conditioner");
  }
  if (!eng) {
    await sheet("conditioners");
    console.log("pick conditioner_engine:", await pickItemTool("conditioner_engine", "Внешние блоки"));
    await clickAt({ x: wallPt.x + dxW * 90, y: wallPt.y + dyW * 90 });
    await esc();
    eng = Object.values<any>(await itemsOf()).find((i: any) => i.name === "conditioner_engine");
  }
  const model: any = await page.evaluate(() => (window as any).project.copy("server"));
  cond = Object.values<any>(model.items).find((i: any) => i.name === "conditioner");
  eng = Object.values<any>(model.items).find((i: any) => i.name === "conditioner_engine");
  if (!cond || !eng) { console.log("FAIL: нет кондиционеров"); process.exit(1); }
  await sheet("conditioners");
  console.log("pick conditioner_wire:", await pickTool("conditioner_wire"));
  await dragAt({ x: cond.pc.x - 10, y: cond.pc.y }, { x: eng.pc.x + 10, y: eng.pc.y });
  await esc();
  await snap("wire-edge");
  console.log("pick conditioner_drainage:", await pickTool("conditioner_drainage"));
  await dragAt({ x: cond.pc.x - 10, y: cond.pc.y }, { x: cond.pc.x - 100, y: cond.pc.y });
  await esc();
  await snap("drainage-edge");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
const after = await loadModel(session, OBJECT_ID, PLAN_ID);
const backup = JSON.parse(readFileSync(".orca-reports/backup-dev-250.json", "utf8"));
const strip = (m: any) => { const c = { ...m }; delete c.save_id; delete c.log_plan; delete c.session; return JSON.stringify(c); };
console.log("GET после пробы == бэкап:", strip(after.model) === strip(backup.model) ? "OK — не изменился" : "РАСХОЖДЕНИЕ");
process.exit(0);
