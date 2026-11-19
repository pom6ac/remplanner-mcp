// 239-4: кабель между предметами (клик-клик), конструктор щитка (shields-формат),
// связь выключатель → лента (props.cables на led_strips). Dev-проект, без сохранения.
import { chromium } from "playwright-core";
import { existsSync, writeFileSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

// Запуск только по явному аргументу (ID проекта/плана — из env):
// node --experimental-strip-types scripts/probes/239-elec2-links.ts run
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
// центры рёбер комнаты со сдвигом внутрь 12 см (точки для wall-элементов)
const edgePts: { x: number; y: number }[] = [];
for (let i = 0; i < poly.length; i++) {
  const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }
  edgePts.push({ x: mx + nx * 12, y: my + ny * 12 });
}

const res: Record<string, any> = {};

// 1. предметы: щиток + коробка (для кабеля), выключатель + лента (для связи)
await switchSheet("cables");
const b0 = await copyServer();
for (const [name, pt] of [["electric_shield", edgePts[0]], ["electric_box", { x: cx + 40, y: cy + 20 }]] as const) {
  await pickTool(name);
  await clickAt(pt);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}
await switchSheet("light");
await pickTool("led_strip");
// лента: drag горизонтальный в комнате
await dragAt({ x: cx - 60, y: cy - 90 }, { x: cx + 60, y: cy - 90 });
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await switchSheet("light_connections");
await pickTool("light_switch");
await clickAt(edgePts[1] ?? { x: cx + 100, y: cy });
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
let snap = await copyServer();
const shieldItem = Object.values<any>(snap.items ?? {}).find((i: any) => i.name === "electric_shield");
const boxItem = Object.values<any>(snap.items ?? {}).find((i: any) => i.name === "electric_box");
const swItem = Object.values<any>(snap.items ?? {}).find((i: any) => i.name === "socket_group" && (i.socket_group ?? []).some((s: any) => s.name === "light_switch"));
const stripsBefore = Object.keys(snap.led_strips ?? {});
console.log("items:", !!shieldItem, !!boxItem, !!swItem, "strips:", stripsBefore.length);

// 2. кабель от щитка к коробке: клик-клик
const b1 = await copyServer();
await switchSheet("cables");
await pickTool("wire_3_25");
await clickAt({ x: boxItem.pc.x, y: boxItem.pc.y });
await page.waitForTimeout(400);
await clickAt({ x: shieldItem.pc.x, y: shieldItem.pc.y });
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
await page.keyboard.press("Escape");
let a1 = await copyServer();
const cableDiff: any = {};
for (const k of ["cables_socket", "cables_warm_floor", "cables_conditioner", "cables"]) {
  const ids = Object.keys(a1[k] ?? {}).filter((id) => !(id in (b1[k] ?? {})));
  if (ids.length) cableDiff[k] = ids.map((id) => a1[k][id]);
}
cableDiff["items"] = { shield: a1.items[shieldItem.id], box: a1.items[boxItem.id] };
if (!Object.keys(cableDiff).filter((k) => k !== "items").length) {
  // повтор: drag
  const b2 = await copyServer();
  await pickTool("wire_3_25");
  await dragAt({ x: boxItem.pc.x, y: boxItem.pc.y }, { x: shieldItem.pc.x, y: shieldItem.pc.y });
  await page.keyboard.press("Escape");
  a1 = await copyServer();
  for (const k of ["cables_socket", "cables_warm_floor", "cables_conditioner", "cables"]) {
    const ids = Object.keys(a1[k] ?? {}).filter((id) => !(id in (b2[k] ?? {})));
    if (ids.length) cableDiff[`${k}_drag`] = ids.map((id) => a1[k][id]);
  }
  cableDiff["items_drag"] = { shield: a1.items[shieldItem.id], box: a1.items[boxItem.id] };
}
res["cable_to_items"] = cableDiff;
writeOut("239-elec2-cable-attach", cableDiff);
console.log("cable attach:", JSON.stringify(cableDiff).slice(0, 2200));

// 3. связь выключатель → лента
const b3 = await copyServer();
await switchSheet("light_connections");
await pickTool("cable");
await dragAt({ x: swItem.pc.x, y: swItem.pc.y }, { x: cx, y: cy - 90 });
await page.keyboard.press("Escape");
const a3 = await copyServer();
const linkDiff: any = { cables_added: Object.keys(a3.cables ?? {}).filter((id) => !(id in (b3.cables ?? {}))).map((id) => a3.cables[id]) };
const stripId = Object.keys(a3.led_strips ?? {}).find((id) => !(id in (b3.led_strips ?? {}))) ?? stripsBefore[0];
linkDiff["strip_after"] = stripId ? a3.led_strips[stripId] : null;
linkDiff["switch_after"] = swItem ? a3.items[swItem.id] : null;
res["strip_link"] = linkDiff;
writeOut("239-elec2-strip-link2", linkDiff);
console.log("strip link:", JSON.stringify(linkDiff).slice(0, 2200));

// 4. конструктор щитка: лист plan_shield, клик по щитку
await switchSheet("shield");
await clickAt({ x: shieldItem.pc.x, y: shieldItem.pc.y });
await page.waitForTimeout(1500);
const shieldState = await page.evaluate(() => {
  const w: any = window as any;
  return {
    shields: w.project?.shields ? JSON.parse(JSON.stringify(w.project.shields)) : null,
    builderVisible: !!document.querySelector(".shield_builder, #shield_builder, [class*='shield']"),
    modals: Array.from(document.querySelectorAll(".planner_ui_message.active, .fog")).map((e: any) => e.id ?? e.className).slice(0, 5),
  };
});
res["shield_builder"] = shieldState;
// добавить DIN-рейку
const b4 = await copyServer();
await pickTool("shield_din");
await clickAt({ x: shieldItem.pc.x, y: shieldItem.pc.y });
await page.waitForTimeout(1000);
const a4 = await copyServer();
res["shield_after_din"] = {
  shields: a4.shields ?? null,
  changed: Object.keys(a4.shields ?? {}).length !== Object.keys((b4.shields ?? {})).length,
};
writeOut("239-elec2-shield2", res["shield_builder"], );
writeOut("239-elec2-shield-din", res["shield_after_din"]);
console.log("shield builder:", JSON.stringify(shieldState).slice(0, 800));
console.log("shield after din:", JSON.stringify(res.shield_after_din).slice(0, 1500));

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null, { timeout: 60000 });
await page.waitForTimeout(3000);
const after = await loadModel(session, OBJECT_ID, PLAN_ID);
console.log("GET после перезагрузки:", JSON.stringify(after.model) === JSON.stringify(model.model) ? "не изменился (откат ОК)" : "ИЗМЕНИЛСЯ");
await browser.close();
process.exit(0);
