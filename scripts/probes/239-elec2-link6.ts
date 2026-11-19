// 239-6: связь выключатель → лента (2 способа), cables_warm_floor (терморегулятор),
// настройки конструктора щитка. Dev-проект, без сохранения.
import { chromium } from "playwright-core";
import { existsSync, writeFileSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

// Запуск только по явному аргументу (ID проекта/плана — из env):
// node --experimental-strip-types scripts/probes/239-elec2-link6.ts run
if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run (RP_OID/RP_PLAN или REMPLANNER_PROBE_* из env)");
  process.exit(0);
}

const OBJECT_ID = process.env.RP_OID;
const PLAN_ID = process.env.RP_PLAN;
const OUT = ".orca-reports/phase2-ui-refs";
const session = loadSession(STATE_PATH);
const shell = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: existsSync(shell) ? shell : undefined, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "ru-RU" });
await ctx.addCookies(session.cookies.map((c: any) => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/", httpOnly: c.httpOnly ?? false, secure: c.secure ?? false,
})));
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 120)));
await page.goto(`https://remplanner.ru/planner/?object_id=${OBJECT_ID}&plan_id=${PLAN_ID}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project && (window as any).project, null, { timeout: 60000 });
await page.waitForTimeout(3000);

const clearFog = () => page.evaluate(() => {
  const f: any = document.querySelector("#planner_ui_message_fog");
  if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
  document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
});
const copyServer = () => page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
const toScreen = (p: any) => page.evaluate((pp: any) => {
  const svg: any = document.querySelector("#main_svg");
  const r = svg.getBoundingClientRect();
  const q = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
  return { x: r.x + ((pp.x - q[0]) * r.width) / q[2], y: r.y + ((pp.y - q[1]) * r.height) / q[3] };
}, p);
async function clickAt(p: any) {
  await clearFog();
  const s = await toScreen(p);
  await page.mouse.move(s.x - 6, s.y - 6);
  await page.mouse.move(s.x, s.y, { steps: 6 });
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(700);
}
async function slowDrag(a: any, b: any) {
  await clearFog();
  const s = await toScreen(a), e = await toScreen(b);
  await page.mouse.move(s.x, s.y, { steps: 4 });
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.mouse.move(e.x, e.y, { steps: 30 });
  await page.waitForTimeout(600);
  await page.mouse.up();
  await page.waitForTimeout(900);
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
    const group = el.closest(".tools_item, .subtools_item");
    if (el.classList.contains("is_pro") || (group && group.classList.contains("is_pro"))) return "pro";
    const parent: any = el.closest(".subtools");
    if (parent && parent.id) {
      const opener: any = document.querySelector(`[data-target="${parent.id}"]`);
      opener?.click();
    }
    el.click();
    return "ok";
  }, key);
  await page.waitForTimeout(600);
  return st;
}
const writeOut = (name: string, data: unknown) => writeFileSync(`${OUT}/${name}.json`, JSON.stringify(data, null, 1) + "\n");

const model = await loadModel(session, OBJECT_ID, PLAN_ID);
const rooms = Object.values<any>((model.model as any).rooms2 ?? {});
const room = rooms[0]!;
const poly = (room.polygon ?? []).map((p: any) => ({ x: p.x, y: p.y }));
const cx = poly.reduce((s: number, p: any) => s + p.x, 0) / poly.length;
const cy = poly.reduce((s: number, p: any) => s + p.y, 0) / poly.length;
const edgePts: any[] = [];
for (let i = 0; i < poly.length; i++) {
  const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }
  edgePts.push({ x: mx + nx * 12, y: my + ny * 12 });
}
const res: Record<string, any> = {};

// лента + выключатель
await switchSheet("light");
await pickTool("led_strip");
await slowDrag({ x: cx - 60, y: cy - 90 }, { x: cx + 60, y: cy - 90 });
await page.keyboard.press("Escape");
await switchSheet("light_connections");
await pickTool("light_switch");
await clickAt(edgePts[2]);
await page.keyboard.press("Escape");
let snap = await copyServer();
const sw = Object.values<any>(snap.items ?? {}).find((i: any) => i.name === "socket_group" && (i.socket_group ?? [])[0]?.name === "light_switch");
const stripId = Object.keys(snap.led_strips ?? {})[0];
const strip = snap.led_strips?.[stripId];
const stripEnds = (strip?.vertexes ?? []).map((v: any) => v.point);
console.log("switch:", !!sw, "strip ends:", JSON.stringify(stripEnds));

// попытка A: drag от выключателя к КОНЦУ ленты
const bA = await copyServer();
await pickTool("cable");
await slowDrag({ x: sw.pc.x, y: sw.pc.y }, { x: stripEnds[1].x, y: stripEnds[1].y });
await page.keyboard.press("Escape");
let aA = await copyServer();
res["link_end"] = {
  cables: Object.keys(aA.cables ?? {}).filter((id) => !(id in (bA.cables ?? {}))).map((id) => aA.cables[id]),
  strip: aA.led_strips?.[stripId],
};
console.log("link end:", JSON.stringify(res.link_end).slice(0, 900));

// попытка B: drag от ленты (центр) к выключателю
const bB = await copyServer();
await pickTool("cable");
await slowDrag({ x: cx, y: cy - 90 }, { x: sw.pc.x, y: sw.pc.y });
await page.keyboard.press("Escape");
let aB = await copyServer();
res["link_from_strip"] = {
  cables: Object.keys(aB.cables ?? {}).filter((id) => !(id in (bB.cables ?? {}))).map((id) => aB.cables[id]),
  strip: aB.led_strips?.[stripId],
  switch: aB.items[sw.id],
};
console.log("link from strip:", JSON.stringify(res.link_from_strip).slice(0, 900));

// warm floor: терморегулятор + кабель
await switchSheet("warm_floor");
const bW = await copyServer();
const pickThermo = await pickTool("socket_thermo");
if (pickThermo === "ok") {
  await clickAt(edgePts[3]);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}
snap = await copyServer();
const thermo = Object.values<any>(snap.items ?? {}).find((i: any) => i.name === "socket_group" && (i.socket_group ?? [])[0]?.name === "socket_thermo");
console.log("thermo:", pickThermo, !!thermoAny(snap));
function thermoAny(s: any) { return Object.values<any>(s.items ?? {}).find((i: any) => JSON.stringify(i).includes("thermo")); }
const bW2 = await copyServer();
await switchSheet("warm_floor");
const pickW = await pickTool("warm_floor_wire");
if (pickW === "ok") {
  const thermo = thermoAny(snap);
  if (thermo) await slowDrag({ x: thermo.pc.x, y: thermo.pc.y }, { x: cx, y: cy + 40 });
  await page.keyboard.press("Escape");
}
const aW = await copyServer();
res["warm_floor"] = {
  pickThermo, pickW, thermo: thermoAny(aW),
  cables_added: Object.keys(aW.cables_warm_floor ?? {}).filter((id) => !(id in ((bW2.cables_warm_floor ?? {})))).map((id) => aW.cables_warm_floor[id]),
};
console.log("warm floor:", JSON.stringify(res.warm_floor).slice(0, 1600));

// настройки конструктора щитка
res["shield_settings"] = await page.evaluate(() => {
  const w: any = window as any;
  const out: any = {};
  try { out.init_settings = w.$ShieldBuilder?.init_settings ? JSON.parse(JSON.stringify(w.$ShieldBuilder.init_settings())) : null; } catch (e) { out.init_settings_err = String(e).slice(0, 200); }
  out.shieldToolPro = !!document.querySelector("#plannertool_shield_din")?.classList.contains("is_pro");
  return out;
});
writeOut("239-elec2-link6", res);
console.log("shield settings:", JSON.stringify(res.shield_settings).slice(0, 600));

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null, { timeout: 60000 });
await page.waitForTimeout(3000);
const after = await loadModel(session, OBJECT_ID, PLAN_ID);
console.log("GET после перезагрузки:", JSON.stringify(after.model) === JSON.stringify(model.model) ? "не изменился (откат ОК)" : "ИЗМЕНИЛСЯ");
await browser.close();
process.exit(0);
