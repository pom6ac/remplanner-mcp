// 284: матрица живых эталонов щитка: провода фаза/ноль/земля (модуль-модуль,
// модуль-ввод, модуль-шина), шина (busbar), коллектор, каскад удаления модуля
// с проводом, перенос модуля на вторую рейку. Модель — copy("server") после
// действий обработчиками редактора (те же, что клики UI). БЕЗ сохранения
// (откат перезагрузкой).
// Запуск: node --experimental-strip-types scripts/probes/284-wire-matrix.ts run
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
async function pickTool(key: string): Promise<string> {
  const st = await page.evaluate((k: string) => {
    const el: any = document.querySelector(`#plannertool_${k}`);
    if (!el) return "missing";
    const parent: any = el.closest(".subtools");
    if (parent && parent.id) document.querySelector(`[data-target="${parent.id}"]`)?.click();
    el.click();
    return "ok";
  }, key);
  await page.waitForTimeout(600);
  return st;
}
const model = await loadModel(session, OBJECT_ID, PLAN_ID);
await switchSheet("cables");
await pickTool("electric_shield");
const rooms = Object.values<any>(model.model.rooms2 ?? {});
const poly = (rooms[0]!.polygon ?? []).map((p: any) => ({ x: p.x, y: p.y }));
const cx = poly.reduce((s: number, p: any) => s + p.x, 0) / poly.length;
const cy = poly.reduce((s: number, p: any) => s + p.y, 0) / poly.length;
await clickAt({ x: cx, y: cy });
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await switchSheet("shield");
await pickTool("shield_din");
const itemPc = await page.evaluate(() => {
  const items = (window as any).project.copy("server").items ?? {};
  const sh = Object.values<any>(items).find((i: any) => i.name === "electric_shield");
  return sh ? sh.pc : null;
});
await clickAt(itemPc);
await page.waitForTimeout(500);
// вторая рейка (клик инструментом ещё раз — add_rail по новому слоту)
await clickAt(itemPc);
await page.waitForTimeout(500);
// модули
await page.evaluate(() => {
  const w: any = window as any;
  const sh: any = Object.values(w.SHIELDS)[0];
  const rails = Object.keys(sh.rails);
  sh.add_module(rails[0]!, "shield_module");
  sh.add_module(rails[0]!, "shield_module_x2");
  sh.add_module(rails[1] ?? rails[0]!, "shield_module");
});
const base = await page.evaluate(() => (window as any).project.copy("server").shields ?? {});
writeFileSync(`${OUT}/284-matrix-base.json`, JSON.stringify(base, null, 1));
console.log("rails:", Object.values<any>(base)[0]!.rails.length ?? Object.keys(Object.values<any>(base)[0]!.rails).length);

// источники: module_port_click_collector и сборщик коллектора
const srcs2 = await page.evaluate(() => {
  const sh: any = Object.values((window as any).SHIELDS)[0];
  const p = Object.getPrototypeOf(sh);
  const out: any = {};
  for (const m of ["module_port_click_collector", "add_collector_start", "add_collector_end", "preview_line", "init_temp_line", "get_position_port", "add_bus_move", "get_rail_slot", "add_wire_start", "add_wire_end", "add_module_start", "get_module_slot"]) {
    out[m] = (p as any)[m]?.toString().slice(0, 2500) ?? null;
  }
  return out;
});
writeFileSync(`${OUT}/284-matrix-src.json`, JSON.stringify(srcs2, null, 1));

// провода: фаза модуль→модуль, ноль модуль→модуль, земля модуль→ввод
const step1 = await page.evaluate(() => {
  const w: any = window as any;
  const sh: any = Object.values(w.SHIELDS)[0];
  const mods = Object.values<any>(Object.values<any>(sh.rails)[0].modules);
  const mA = mods[0]!, mB = mods[1]!, mC = mods[2] ?? mods[0]!;
  const input = Object.values<any>(sh.inputs)[0]!;
  const log: any = {};
  const connect = (a: string, b: string, type: string) => {
    tool = type;
    sh.module_port_click(a);
    sh.module_port_click(b);
  };
  try {
    connect(mA.ports[0]!.id, mB.ports[0]!.id, "shield_wire_phase");
    connect(mB.ports[2]!.id, mC.ports[0]!.id, "shield_wire_null");
    connect(mC.ports[1]!.id, input.ports.find((p: any) => p.type === "shield_wire_earth")!.id, "shield_wire_earth");
  } catch (e) { log.error = String(e).slice(0, 300); }
  return log;
});
console.log("wires step1:", JSON.stringify(step1));
const model1 = await page.evaluate(() => (window as any).project.copy("server").shields ?? {});
writeFileSync(`${OUT}/284-matrix-wires.json`, JSON.stringify(model1, null, 1));
console.log("wires:", JSON.stringify(Object.values<any>(model1)[0]!.wires).slice(0, 1200));

// шина: add_bus_start с синтетическим событием (data-slot-type со слота)
const busStep = await page.evaluate(() => {
  const w: any = window as any;
  const sh: any = Object.values(w.SHIELDS)[0];
  const log: any = {};
  try {
    // busbar слоты появляются после активации инструмента; ищем слоты в DOM
    const slots = [...document.querySelectorAll("#main_svg [data-slot-type]")];
    log.slotTypes = slots.map((s: any) => s.getAttribute("data-slot-type"));
    let slotType = slots[0]?.getAttribute("data-slot-type") ?? null;
    if (!slotType) {
      // активируем инструмент busbar, чтобы слоты появились
      const el: any = document.querySelector("#plannertool_shield_busbar");
      el?.click();
      log.pickedBusbar = true;
    }
    const slots2 = [...document.querySelectorAll("#main_svg [data-slot-type]")];
    log.slotTypes2 = slots2.map((s: any) => ({ type: s.getAttribute("data-slot-type"), rect: s.getBoundingClientRect().toJSON() }));
    const target = slots2[0];
    if (!target) return { ...log, error: "no bus slots" };
    const r = target.getBoundingClientRect();
    const ev = { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, target, shiftKey: false };
    sh.add_bus_start(ev as any);
    sh.add_bus_end({ shiftKey: false } as any);
    tool = "shield_wire_null";
    const bus: any = Object.values<any>(sh.buses)[0];
    if (bus?.ports?.[0]) {
      const mod: any = Object.values<any>(Object.values<any>(sh.rails)[0].modules)[0]!;
      sh.module_port_click(mod.ports[0]!.id);
      sh.module_port_click(bus.ports[0]!.id);
    }
    return log;
  } catch (e) { return { ...log, error: String(e).slice(0, 300) }; }
});
console.log("bus step:", JSON.stringify(busStep));
const model2 = await page.evaluate(() => (window as any).project.copy("server").shields ?? {});
writeFileSync(`${OUT}/284-matrix-bus.json`, JSON.stringify(model2, null, 1));
console.log("buses:", JSON.stringify(Object.values<any>(model2)[0]!.buses).slice(0, 1200));

// коллектор: старт от порта модуля, конец с картой модулей
const colStep = await page.evaluate(() => {
  const w: any = window as any;
  const sh: any = Object.values(w.SHIELDS)[0];
  const mods = Object.values<any>(Object.values<any>(sh.rails)[0].modules);
  const log: any = {};
  try {
    if (mods.length >= 2) {
      sh.add_collector_start(mods[0]!.ports[0]!.id);
      const map: any = {};
      map[mods[1]!.id] = mods[1]!.id;
      sh.add_collector_end(mods[0]!.ports[0]!.id, map);
    }
    return log;
  } catch (e) { return { ...log, error: String(e).slice(0, 300) }; }
});
console.log("collector step:", JSON.stringify(colStep));
const model3 = await page.evaluate(() => (window as any).project.copy("server").shields ?? {});
writeFileSync(`${OUT}/284-matrix-collector.json`, JSON.stringify(model3, null, 1));
console.log("collectors:", JSON.stringify(Object.values<any>(model3)[0]!.collectors).slice(0, 1200));

// каскад: удалить модуль с проводами → какие провода пропали
const cascade = await page.evaluate(() => {
  const w: any = window as any;
  const sh: any = Object.values(w.SHIELDS)[0];
  const mods = Object.values<any>(Object.values<any>(sh.rails)[0].modules);
  const victim = mods[mods.length - 1]!;
  const wiresBefore = Object.keys(sh.wires);
  sh.delete_module(victim.id);
  const copy = w.project.copy("server").shields;
  const sh1: any = Object.values(copy)[0]!;
  return { victim: victim.id, wiresBefore, wiresAfter: Object.keys(sh1.wires), wires: sh1.wires };
});
console.log("cascade delete module:", JSON.stringify(cascade).slice(0, 900));

// перенос модуля на вторую рейку → провода живы?
const moveStep = await page.evaluate(() => {
  const w: any = window as any;
  const sh: any = Object.values(w.SHIELDS)[0];
  const rails = Object.values<any>(sh.rails).sort((a: any, b: any) => a.index - b.index);
  if (rails.length < 2) return { error: "only one rail", rails: rails.length };
  const mod = Object.values<any>(rails[0].modules)[0];
  if (!mod) return { error: "no module on rail 0" };
  const wiresBefore = JSON.parse(JSON.stringify(sh.wires, (k, v) => k === "shield" || k === "rail" ? undefined : v));
  sh.move_module_to_rail(mod, 1);
  const wiresAfter = JSON.parse(JSON.stringify(sh.wires, (k, v) => k === "shield" || k === "rail" ? undefined : v));
  return { moduleRail: mod.rail_id, wiresChanged: JSON.stringify(wiresBefore) !== JSON.stringify(wiresAfter), wiresAfter };
});
console.log("move to rail 2:", JSON.stringify(moveStep).slice(0, 600));
const model4 = await page.evaluate(() => (window as any).project.copy("server").shields ?? {});
writeFileSync(`${OUT}/284-matrix-final.json`, JSON.stringify(model4, null, 1));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await browser.close().catch(() => {});
