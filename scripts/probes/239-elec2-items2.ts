// 239-2: предметы электрики ч.2 в dev-проекте (UI-клики, без сохранения, откат перезагрузкой):
// щитки/коробки (свои имена), выводы проводов (wires), кабель между предметами (опуски,
// обратные ссылки), shields при постановке щитка.
import { chromium } from "playwright-core";
import { existsSync, writeFileSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

// Запуск только по явному аргументу (ID проекта/плана — из env):
// node --experimental-strip-types scripts/probes/239-elec2-items2.ts run
if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run (RP_OID/RP_PLAN или REMPLANNER_PROBE_* из env)");
  process.exit(0);
}

const OBJECT_ID = process.env.RP_OID;
const PLAN_ID = process.env.RP_PLAN;
// ревью 241 №11: без env ID — отказ до запуска браузера (URL и loadModel не получают undefined)
if (!OBJECT_ID || !PLAN_ID) { console.error("нужны RP_OID и RP_PLAN"); process.exit(1); }
const OUT = ".orca-reports/phase2-ui-refs";
const session = loadSession(STATE_PATH);
const shell = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: existsSync(shell) ? shell : undefined, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "ru-RU" });
await ctx.addCookies(session.cookies.map((c: any) => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/", httpOnly: c.httpOnly ?? false, secure: c.secure ?? false,
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
async function dragAt(a: any, b: any) {
  await clearFog();
  const s = await toScreen(a), e = await toScreen(b);
  await page.mouse.move(s.x, s.y, { steps: 4 });
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.mouse.move(e.x, e.y, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(800);
}
async function switchSheet(sheet: string) {
  await clearFog();
  await page.evaluate((s: string) => {
    const nav: any = document.querySelector(`.groups_navi_item.plan_${s}`);
    nav?.click();
  }, sheet);
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

const res: Record<string, any> = {};
const b0 = await copyServer();
// 1. щитки и коробки: каждый — свой клик, свой item
await switchSheet("cables");
let n = 0;
for (const name of ["electric_box", "electric_box_wall", "electric_kup", "electric_shield", "electric_shield_internal", "lowcurrent_shield", "lowcurrent_shield_internal"]) {
  const pick = await pickTool(name);
  if (pick !== "ok") { res[name] = { pick }; continue; }
  await clickAt({ x: cx - 120 + (n % 4) * 60, y: cy - 60 + Math.floor(n / 4) * 60 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const a = await copyServer();
  const added = Object.values<any>(a.items ?? {}).filter((it: any) => !Object.keys(b0.items ?? {}).includes(it.id) && it.name === name);
  res[name] = added.length ? { item: added[0] } : { pick, added_names: Object.values<any>(a.items ?? {}).filter((it: any) => !Object.keys(b0.items ?? {}).includes(it.id)).map((x: any) => x.name) };
  console.log(name, added.length ? `OK id=${added[0].id}` : JSON.stringify(res[name]).slice(0, 200));
  n++;
}
// shields при постановке щитка
res["shields_after_items"] = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).project?.shields ?? {})));
res["shield_item_shield_link"] = await page.evaluate(() => {
  const w: any = window as any;
  const it = Object.values<any>(w.project.items).find((i: any) => /^electric_shield$|^lowcurrent_shield$/.test(i.name));
  return it ? { id: it.id, name: it.name, id_shield: it.id_shield ?? null, keys: Object.keys(it) } : null;
});
writeOut("239-elec2-items2", res);
console.log("shields:", JSON.stringify(res.shields_after_items).slice(0, 300));
console.log("shield link:", JSON.stringify(res.shield_item_shield_link));

// 2. выводы проводов: лист sockets
const b1 = await copyServer();
await switchSheet("sockets");
const wires: Record<string, any> = {};
let m = 0;
for (const name of ["wire", "wire_light", "wire_oven", "wire_stove", "wire_conditioner", "wire_lowcurrent", "floor_wire", "ceiling_wire"]) {
  const pick = await pickTool(name);
  if (pick !== "ok") { wires[name] = { pick }; continue; }
  if (name === "floor_wire") await clickAt({ x: cx - 40 + m * 25, y: cy + 60 });
  else if (name === "ceiling_wire") await clickAt({ x: cx - 40 + m * 25, y: cy + 90 });
  else await clickAt({ x: cx - 40 + m * 25, y: cy });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const a = await copyServer();
  const added = Object.values<any>(a.items ?? {}).filter((it: any) => !Object.keys(b1.items ?? {}).includes(it.id) && (it.name === name || it.name === "wires" || it.name === "socket_group"));
  wires[name] = added.length ? { item: added[added.length - 1] } : { pick, added_names: Object.values<any>(a.items ?? {}).filter((it: any) => !Object.keys(b1.items ?? {}).includes(it.id)).map((x: any) => x.name) };
  console.log(name, added.length ? `OK name=${added[added.length - 1].name}` : JSON.stringify(wires[name]).slice(0, 200));
  m++;
}
writeOut("239-elec2-wires", wires);

// 3. кабель от щитка к коробке (прикрепление к предметам): drag от щитка к electric_box
const shieldItem = Object.values<any>((await copyServer()).items ?? {}).find((i: any) => i.name === "electric_shield");
const boxItem = Object.values<any>((await copyServer()).items ?? {}).find((i: any) => i.name === "electric_box");
const b2 = await copyServer();
await switchSheet("cables");
const pickCable = await pickTool("wire_3_25");
if (pickCable === "ok" && shieldItem && boxItem) {
  await dragAt({ x: shieldItem.pc.x, y: shieldItem.pc.y }, { x: boxItem.pc.x, y: boxItem.pc.y });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}
const a2 = await copyServer();
const cableAdded: any = {};
for (const k of ["cables_socket", "cables_warm_floor", "cables_conditioner", "cables"]) {
  const before = b2[k] ?? {}, after = a2[k] ?? {};
  const ids = Object.keys(after).filter((id) => !(id in before));
  if (ids.length) cableAdded[k] = ids.map((id) => after[id]);
}
cableAdded["items_after"] = shieldItem && boxItem ? [a2.items[shieldItem.id], a2.items[boxItem.id]] : null;
writeOut("239-elec2-cable-items", cableAdded);
console.log("cable attached:", JSON.stringify(cableAdded).slice(0, 1600));

// 4. откат
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null, { timeout: 60000 });
await page.waitForTimeout(3000);
const after = await loadModel(session, OBJECT_ID, PLAN_ID);
console.log("GET после перезагрузки:", JSON.stringify(after.model) === JSON.stringify(model.model) ? "не изменился (откат ОК)" : "ИЗМЕНИЛСЯ");
await browser.close();
process.exit(0);
