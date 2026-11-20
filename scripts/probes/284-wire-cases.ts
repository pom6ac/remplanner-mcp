// 284: граничные случаи проводов: два провода с одного порта, input→input,
// удаление провода (delete_wire), типы phase2/phase3, обновление connected.
// БЕЗ сохранения (откат перезагрузкой).
// Запуск: node --experimental-strip-types scripts/probes/284-wire-cases.ts run
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
await page.evaluate(() => { (document.querySelector("#plannertool_shield_din") as any)?.click(); });
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

const cases = await page.evaluate(() => {
  const w: any = window as any;
  const sh: any = Object.values(w.SHIELDS)[0];
  const mods = Object.values<any>(Object.values<any>(sh.rails)[0].modules);
  const mA = mods[0]!, mB = mods[1]!;
  const input = Object.values<any>(sh.inputs)[0]!;
  const out: any = {};
  const snap = () => {
    const copy = w.project.copy("server").shields;
    const s1: any = Object.values(copy)[0]!;
    return { wires: s1.wires, connected: Object.values<any>(s1.rails).flatMap((r: any) => Object.values<any>(r.modules).flatMap((m: any) => m.ports.map((p: any) => p.connected))) };
  };
  // 1. два провода с одного порта
  try {
    tool = "shield_wire_phase";
    sh.module_port_click(mA.ports[0]!.id);
    sh.module_port_click(mB.ports[0]!.id);
    sh.module_port_click(mA.ports[0]!.id);
    sh.module_port_click(mB.ports[1]!.id);
    out.twoWiresSameSource = snap();
  } catch (e) { out.twoWiresSameSource = "ERR " + String(e).slice(0, 150); }
  // 2. input → input
  try {
    const p1 = input.ports.find((p: any) => p.type === "shield_wire_null")!;
    const p2 = input.ports.find((p: any) => p.type === "shield_wire_phase")!;
    tool = "shield_wire_null";
    sh.module_port_click(p1.id);
    sh.module_port_click(p2.id);
    out.inputToInput = snap();
  } catch (e) { out.inputToInput = "ERR " + String(e).slice(0, 150); }
  // 3. тип phase2 (трёхфазный)
  try {
    tool = "shield_wire_phase2";
    sh.module_port_click(mB.ports[2]!.id);
    sh.module_port_click(input.ports[2]!.id);
    out.phase2 = snap();
  } catch (e) { out.phase2 = "ERR " + String(e).slice(0, 150); }
  // 4. удаление провода
  try {
    const wid = Object.keys(sh.wires)[0]!;
    sh.delete_wire(wid);
    out.afterDelete = snap();
  } catch (e) { out.afterDelete = "ERR " + String(e).slice(0, 150); }
  // 5. is_broken/thickness: исходники ShieldWire
  out.wireProto = (() => {
    const wire: any = Object.values(sh.wires)[0];
    if (!wire) return null;
    const p = Object.getPrototypeOf(wire);
    return { methods: Object.getOwnPropertyNames(p), serialize: p.serializeForWires?.toString().slice(0, 800) ?? null, serialize2: p.serialize?.toString().slice(0, 800) ?? null };
  })();
  return out;
});
writeFileSync(`${OUT}/284-wire-cases.json`, JSON.stringify(cases, null, 1));
console.log(JSON.stringify(cases, null, 1).slice(0, 3000));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await browser.close().catch(() => {});
