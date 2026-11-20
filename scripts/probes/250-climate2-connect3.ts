// 250: добор разведки 2 — предметы создаются в этой же пробе (клики без сохранения):
// conditioner/conditioner_engine → conditioner_wire и conditioner_drainage от точного pc;
// водяной контур → warm_floor_pipe от угла контура. Откат перезагрузкой.
// node scripts/probes/250-climate2-connect3.ts run
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { loadModel } from "../../src/api.ts";

if (process.argv[2] !== "run") { console.error("запуск по аргументу run"); process.exit(0); }
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("нужны env"); process.exit(1); }
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 8 * 60_000).unref();

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
const page = editor.page;
try {
  const snap = async (tag: string) => {
    const data = await page.evaluate(() => {
      const m: any = (window as any).project.copy("server");
      const keep = ["warm_floors", "cables_conditioner", "pipes_conditioner", "pipes_warm_floor"];
      const res: any = {};
      for (const k of keep) res[k] = m[k] ?? null;
      res.items = Object.fromEntries(Object.entries<any>(m.items ?? {}).map(([k, v]: any) => [k, {
        name: v.name, pc: v.pc, angle: v.angle, width: v.width, height: v.height,
        props_pipes_conditioner: v.pipes_conditioner ?? null,
        props_cables_conditioner: v.cables_conditioner ?? null,
        props_pipes_warm_floor: v.pipes_warm_floor ?? null,
      }]));
      return res;
    });
    writeFileSync(`.orca-reports/tmp/250-connect3-${tag}.json`, JSON.stringify(data, null, 1) + "\n");
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
    await page.waitForTimeout(250);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(700);
  };
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
  const pickTool = async (key: string, groupTitle?: string) => page.evaluate(({ k, groupTitle }) => {
    const el: any = document.querySelector(`#plannertool_${k}`);
    if (!el) return "missing";
    if (groupTitle) {
      const tops = Array.from(document.querySelectorAll(".tools .tools_item, #planner_ui_tools .tools_item")) as any[];
      const g = tops.find((t) => (t.textContent || "").includes(groupTitle));
      g?.click();
    }
    el.click();
    return "ok";
  }, { k: key, groupTitle });
  const sheet = async (s: string) => {
    await clearFog();
    await page.evaluate((ss) => { const nav: any = document.querySelector(`.groups_navi_item.plan_${ss}`); if (nav) nav.click(); }, s);
    await page.waitForTimeout(1200);
    await clearFog();
  };
  const esc = () => page.keyboard.press("Escape");

  const model: any = await page.evaluate(() => (window as any).project.copy("server"));
  const rooms = Object.values<any>(model.rooms2 ?? {});
  const room = rooms[0]!;
  const poly = (room.polygon ?? []).map((p: any) => ({ x: p.x, y: p.y }));
  const center = { x: poly.reduce((s: number, p: any) => s + p.x, 0) / poly.length, y: poly.reduce((s: number, p: any) => s + p.y, 0) / poly.length };
  const e0 = { p1: poly[0]!, p2: poly[1]! };
  const mid = { x: (e0.p1.x + e0.p2.x) / 2, y: (e0.p1.y + e0.p2.y) / 2 };
  const len0 = Math.hypot(e0.p2.x - e0.p1.x, e0.p2.y - e0.p1.y);
  const dx = (e0.p2.x - e0.p1.x) / len0, dy = (e0.p2.y - e0.p1.y) / len0;
  const nx = (e0.p2.y - e0.p1.y) / len0, ny = -(e0.p2.x - e0.p1.x) / len0;
  const wallPt = { x: mid.x + nx * 15, y: mid.y + ny * 15 };
  const room2: any = rooms[1] ?? room;
  const c2 = { x: room2.polygon.reduce((s: number, p: any) => s + p.x, 0) / room2.polygon.length, y: room2.polygon.reduce((s: number, p: any) => s + p.y, 0) / room2.polygon.length };

  const itemsNow = async () => page.evaluate(() => {
    const m: any = (window as any).project.copy("server");
    return Object.values<any>(m.items ?? {}).map((v: any) => v.name);
  });
  await sheet("conditioners");
  console.log("pick conditioner:", await pickTool("conditioner", "Внутренние блоки"));
  await clickAt({ x: wallPt.x, y: wallPt.y });
  console.log("items after conditioner click:", (await itemsNow()).filter((n: string) => n.includes("conditioner")));
  await esc();
  console.log("pick conditioner_engine:", await pickTool("conditioner_engine", "Внешние блоки"));
  await clickAt({ x: wallPt.x + dx * 90, y: wallPt.y + dy * 90 });
  console.log("items after engine click:", (await itemsNow()).filter((n: string) => n.includes("conditioner")));
  await esc();
  const m1: any = await page.evaluate(() => (window as any).project.copy("server"));
  let cond = Object.values<any>(m1.items).find((i: any) => i.name === "conditioner");
  let eng = Object.values<any>(m1.items).find((i: any) => i.name === "conditioner_engine");
  for (let attempt = 0; (!cond || !eng) && attempt < 3; attempt++) {
    console.log(`retry ${attempt}: conditioner=${!!cond} engine=${!!eng}`);
    await sheet("conditioners");
    if (!cond) { await clickAt({ x: wallPt.x, y: wallPt.y }); await esc(); }
    if (!eng) { await clickAt({ x: wallPt.x + dx * (90 + attempt * 30), y: wallPt.y + dy * (90 + attempt * 30) }); await esc(); }
    const mm: any = await page.evaluate(() => (window as any).project.copy("server"));
    cond = Object.values<any>(mm.items).find((i: any) => i.name === "conditioner");
    eng = Object.values<any>(mm.items).find((i: any) => i.name === "conditioner_engine");
  }
  if (!cond || !eng) { console.log("FAIL: кондиционеры не созданы"); process.exit(1); }
  console.log("cond pc:", JSON.stringify(cond.pc), "angle:", cond.angle, "eng pc:", JSON.stringify(eng.pc));
  console.log("pick conditioner_wire:", await pickTool("conditioner_wire"));
  await dragAt({ x: cond.pc.x, y: cond.pc.y }, { x: eng.pc.x, y: eng.pc.y });
  await esc();
  await snap("wire-from-item");
  console.log("pick conditioner_drainage:", await pickTool("conditioner_drainage"));
  await dragAt({ x: cond.pc.x, y: cond.pc.y }, { x: cond.pc.x - 100, y: cond.pc.y });
  await esc();
  await snap("drainage-from-item");

  await sheet("warm_floor");
  console.log("pick warm_floor_water:", await pickTool("warm_floor_water"));
  await dragAt({ x: c2.x - 50, y: c2.y - 50 }, { x: c2.x + 50, y: c2.y + 50 });
  await esc();
  const m2: any = await page.evaluate(() => (window as any).project.copy("server"));
  const wf: any = Object.values<any>(m2.warm_floors ?? {}).find((w: any) => w.type === "warm_floor_water");
  if (wf) {
    console.log("wf polygon[0]:", JSON.stringify(wf.polygon[0]), "props:", JSON.stringify(wf.props));
    console.log("pick warm_floor_pipe:", await pickTool("warm_floor_pipe"));
    const p0 = wf.polygon[0]!;
    await dragAt({ x: p0.x, y: p0.y }, { x: p0.x - 60, y: p0.y - 40 });
    await esc();
    await snap("wfpipe-from-contour");
  } else {
    console.log("warm_floor_water не создан");
  }
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
