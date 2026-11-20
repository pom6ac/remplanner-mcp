// 284: шина (busbar) — init_bus_slots + событие слота, формат ShieldBus.
// БЕЗ сохранения (откат перезагрузкой).
// Запуск: node --experimental-strip-types scripts/probes/284-bus2.ts run
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

if (process.argv[2] !== "run") { console.error("запуск: … run"); process.exit(0); }
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
const session = loadSession(STATE_PATH);
const shell = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: existsSync(shell) ? shell : undefined, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "ru-RU" });
await ctx.addCookies(session.cookies.map((c: any) => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/",
  expires: c.expires === -1 ? undefined : c.expires, httpOnly: c.httpOnly ?? false, secure: c.secure ?? false,
})));
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 200)));
await page.goto(`https://remplanner.ru/planner/?object_id=${OBJECT_ID}&plan_id=${PLAN_ID}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project && (window as any).project, null, { timeout: 60000 });
await page.waitForTimeout(3000);
const clearFog = () => page.evaluate(() => {
  const f: any = document.querySelector("#planner_ui_message_fog");
  if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
  document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
});
const toScreen = (p: { x: number; y: number }) => page.evaluate((pp: any) => {
  const svg: any = document.querySelector("#main_svg");
  const r = svg.getBoundingClientRect();
  const q = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
  return { x: r.x + ((pp.x - q[0]) * r.width) / q[2], y: r.y + ((pp.y - q[1]) * r.height) / q[3] };
}, p);
async function clickAt(p: { x: number; y: number }) {
  await clearFog();
  const s = await toScreen(p);
  await page.mouse.move(s.x - 6, s.y - 6);
  await page.mouse.move(s.x, s.y, { steps: 6 });
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(700);
}
async function switchSheet(sheet: string) {
  await clearFog();
  await page.evaluate((s: string) => { (document.querySelector(`.groups_navi_item.plan_${s}`) as any)?.click(); }, sheet);
  await page.waitForTimeout(1500);
  await clearFog();
}
const model = await loadModel(session, OBJECT_ID, PLAN_ID);
await switchSheet("cables");
await page.evaluate(() => {
  const el: any = document.querySelector("#plannertool_electric_shield");
  const parent: any = el?.closest(".subtools");
  if (parent?.id) document.querySelector(`[data-target="${parent.id}"]`)?.click();
  el?.click();
});
await page.waitForTimeout(600);
const rooms = Object.values<any>(model.model.rooms2 ?? {});
const poly = (rooms[0]!.polygon ?? []).map((p: any) => ({ x: p.x, y: p.y }));
const cx = poly.reduce((s: number, p: any) => s + p.x, 0) / poly.length;
const cy = poly.reduce((s: number, p: any) => s + p.y, 0) / poly.length;
await clickAt({ x: cx, y: cy });
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await switchSheet("shield");
await page.evaluate(() => {
  const el: any = document.querySelector("#plannertool_shield_din");
  el?.click();
});
await page.waitForTimeout(400);
const itemPc = await page.evaluate(() => {
  const items = (window as any).project.copy("server").items ?? {};
  const sh = Object.values<any>(items).find((i: any) => i.name === "electric_shield");
  return sh ? sh.pc : null;
});
await clickAt(itemPc);
await page.waitForTimeout(500);
await page.evaluate(() => {
  const sh: any = Object.values((window as any).SHIELDS)[0];
  sh.add_module(Object.keys(sh.rails)[0]!, "shield_module");
  sh.add_module(Object.keys(sh.rails)[0]!, "shield_module");
});

// bus: init slots + событие
const busRes = await page.evaluate(() => {
  const w: any = window as any;
  const sh: any = Object.values(w.SHIELDS)[0];
  const log: any = {};
  try {
    tool = "shield_busbar";
    sh.init_bus_slots();
    const slots = [...document.querySelectorAll("#main_svg .bus-slot")];
    log.slotCount = slots.length;
    log.slotAttrs = slots.map((s: any) => ({ attrs: [...s.attributes].map((a: any) => `${a.name}=${a.value}`).slice(0, 6), rect: s.getBoundingClientRect().toJSON() }));
    if (!slots.length) return log;
    // события: mouseover → start, mousemove → move, mousedown+up → end
    const slot = slots[0];
    const r = slot.getBoundingClientRect();
    const cx = r.x + 30, cy2 = r.y + r.height / 2;
    log.point = { cx, cy: cy2, svgPoint: (window as any).LIB.point(cx, cy2, "svg") };
    sh.bus_slot_mouseover({ clientX: cx, clientY: cy2, target: slot } as any);
    sh.bus_slot_mousemove({ clientX: cx + 20, clientY: cy2, target: slot } as any);
    sh.bus_slot_mousedown({ clientX: cx + 20, clientY: cy2, target: slot, which: 1, shiftKey: false } as any);
    const copy = w.project.copy("server").shields;
    log.bus = Object.values<any>(Object.values<any>(copy)[0].buses)[0] ?? null;
    log.busLive = (() => { const b: any = Object.values<any>(sh.buses)[0]; return b ? { id: b.id, type: b.type, connection: b.connection, distance: b.distance, in_transition: b.in_transition, ports: b.ports } : null; })();
    return log;
  } catch (e) { return { ...log, error: String(e).slice(0, 300) }; }
});
writeFileSync(`${OUT}/284-bus2.json`, JSON.stringify(busRes, null, 1));
console.log(JSON.stringify(busRes, null, 1).slice(0, 1800));

// провод модуль → порт шины
if (busRes.busLive) {
  const wireRes = await page.evaluate(() => {
    const w: any = window as any;
    const sh: any = Object.values(w.SHIELDS)[0];
    const bus: any = Object.values<any>(sh.buses)[0];
    const mod: any = Object.values<any>(Object.values<any>(sh.rails)[0].modules)[0];
    tool = "shield_wire_phase";
    sh.module_port_click(mod.ports[0]!.id);
    sh.module_port_click(bus.ports[0]!.id);
    const copy = w.project.copy("server").shields;
    const sh1: any = Object.values(copy)[0]!;
    return { wires: sh1.wires, busPorts: Object.values<any>(sh1.buses)[0]?.ports, busConnection: Object.values<any>(sh1.buses)[0]?.connection };
  });
  console.log("wire to bus:", JSON.stringify(wireRes).slice(0, 800));
  const final = await page.evaluate(() => (window as any).project.copy("server").shields ?? {});
  writeFileSync(`${OUT}/284-bus2-final.json`, JSON.stringify(final, null, 1));
}
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await browser.close().catch(() => {});
