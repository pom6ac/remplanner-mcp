// 255: разведка конструктора электрощитка (лист plan_shield): доступность на тарифе,
// каталог shield_* (global_tools, is_pro), формат коллекции shields при рисовании
// рейки/модулей/шин/проводов, связь щитка-предмета с содержимым, $ShieldBuilder.
// БЕЗ сохранения: откат перезагрузкой; бэкап GET до пробы.
// Запуск: node --experimental-strip-types scripts/probes/255-shield-scout.ts run
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run (REMPLANNER_PROBE_OBJECT_ID/REMPLANNER_PROBE_PLAN_ID/REMPLANNER_PROBE_READONLY_ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
const READONLY_ID = process.env.REMPLANNER_PROBE_READONLY_ID;
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID) { console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID"); process.exit(1); }
if (OBJECT_ID === READONLY_ID) { console.error("OBJECT_ID === READONLY_ID — отказ до любой записи"); process.exit(1); }
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

// гарды: план в редакторе == ожидаемый (id проекта и object_plan_id cookie)
const opened = await page.evaluate(() => ({
  id: document.body?.dataset.objectId ?? null,
  planId: document.body?.dataset.plan_id ?? null,
}));
if (String(opened.id) !== String(OBJECT_ID) || String(opened.planId ?? "") !== String(PLAN_ID)) {
  console.error(`редактор открыл чужой план: id=${JSON.stringify(opened.id)} plan=${JSON.stringify(opened.planId)} — стоп`);
  await browser.close();
  process.exit(1);
}
console.log("guard: открыт ожидаемый объект/план");

const clearFog = () => page.evaluate(() => {
  const f: any = document.querySelector("#planner_ui_message_fog");
  if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
  document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
});
const copyServer = () => page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
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
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(700);
}
async function switchSheet(sheet: string) {
  await clearFog();
  const ok = await page.evaluate((s: string) => {
    const nav: any = document.querySelector(`.groups_navi_item.plan_${s}`);
    if (!nav) return false;
    nav.click();
    return true;
  }, sheet);
  if (!ok) throw new Error(`лист ${sheet} не найден`);
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
const writeOut = (name: string, data: unknown) =>
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(data, null, 1) + "\n");

// 0. бэкап GET (только чтение)
const model = await loadModel(session, OBJECT_ID, PLAN_ID);
writeFileSync(`${OUT}/backup-${OBJECT_ID}-255.json`, JSON.stringify({
  _source: "GET через loadModel, dev-проект из env, scripts/probes/255-shield-scout.ts, только чтение; id не печатаются",
  model: model.model,
}, null, 1));
console.log("backup ok");

// 1. каталог shield_* и доступность листа на тарифе
const recon = await page.evaluate(() => {
  const w: any = window as any;
  const out: any = {};
  out.shieldTools = {};
  for (const [k, v] of Object.entries<any>(w.global_tools ?? {})) {
    if (/^shield_/i.test(k)) {
      const el = document.querySelector(`#plannertool_${k}`);
      out.shieldTools[k] = { ...v, is_pro_dom: el?.classList.contains("is_pro") ?? null };
    }
  }
  const navShield = document.querySelector(".groups_navi_item.plan_shield");
  out.sheetShield = navShield ? { exists: true, is_pro: navShield.classList.contains("is_pro"), classes: navShield.className } : { exists: false };
  out.shields = JSON.parse(JSON.stringify(w.project?.shields ?? {}));
  out.builderGlobal = w.$ShieldBuilder ? Object.getOwnPropertyNames(Object.getPrototypeOf(w.$ShieldBuilder)) : null;
  return out;
});
writeOut("255-shield-recon", recon);
console.log("sheet:", JSON.stringify(recon.sheetShield), "tools:", Object.keys(recon.shieldTools).length, "shields:", JSON.stringify(recon.shields).slice(0, 200));

// 2. щиток-предмет: точка в комнате у ребра (12 см внутрь), лист «Электропроводка»
const rooms = Object.values<any>(model.model.rooms2 ?? {});
const room = rooms[0]!;
const poly = (room.polygon ?? []).map((p: any) => ({ x: p.x, y: p.y }));
const cx = poly.reduce((s: number, p: any) => s + p.x, 0) / poly.length;
const cy = poly.reduce((s: number, p: any) => s + p.y, 0) / poly.length;
const a = poly[0]!, b = poly[1]!;
const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }
const placePt = { x: cx, y: cy };
await switchSheet("cables");
const b0 = await copyServer();
const pickShield = await pickTool("electric_shield");
console.log("pick electric_shield:", pickShield);
if (pickShield !== "ok") throw new Error("щиток недоступен");
await clickAt(placePt);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const a0 = await copyServer();
const items = Object.values<any>(a0.items ?? {});
const shieldItem = items.find((i: any) => i.name === "electric_shield");
if (!shieldItem) {
  const dbg = await page.evaluate(() => ({
    itemsTotal: Object.keys((window as any).project.copy("server").items ?? {}).length,
    dialogs: [...document.querySelectorAll(".planner_ui_message.active, .planner_ui_message_fog.active")].map((e: any) => (e.textContent ?? "").slice(0, 120)),
    bodyClasses: document.body.className,
  }));
  writeOut("255-shield-place-fail", { placePt, dbg, items: items.map((i: any) => i.name) });
  console.log("place fail:", JSON.stringify(dbg));
  throw new Error("щиток-предмет не появился");
}
writeOut("255-shield-item", shieldItem);
console.log("shield item:", shieldItem.id, "pc:", JSON.stringify(shieldItem.pc));

// 3. лист щитка: клик по щитку → конструктор
await switchSheet("shield");
await clickAt({ x: shieldItem.pc.x, y: shieldItem.pc.y });
const builder = await page.evaluate(() => {
  const w: any = window as any;
  const sel: any = document.querySelector("[class*='shield']");
  return {
    shields: JSON.parse(JSON.stringify(w.project?.shields ?? {})),
    builderDom: sel ? sel.className : null,
    activeTool: w.$Plan?.activeTool ?? w.activeTool ?? null,
  };
});
writeOut("255-shield-builder-open", builder);
console.log("builder open: shields:", JSON.stringify(builder.shields).slice(0, 400));

// 4. DIN-рейка
const b1 = await copyServer();
const pickDin = await pickTool("shield_din");
console.log("pick shield_din:", pickDin);
if (pickDin === "ok") {
  await clickAt({ x: shieldItem.pc.x, y: shieldItem.pc.y });
  await page.waitForTimeout(500);
}
const a1 = await copyServer();
const dinDiff = diffOf(b1.shields, a1.shields);
writeOut("255-shield-din", dinDiff);
console.log("after din:", JSON.stringify(dinDiff).slice(0, 1200));

// 5. пара модулей и шина (первые доступные ключи каталога)
const modKeys = Object.keys(recon.shieldTools).filter((k) => /^shield_module/i.test(k) && recon.shieldTools[k].is_pro_dom !== true);
const busKeys = Object.keys(recon.shieldTools).filter((k) => /bus/i.test(k) && recon.shieldTools[k].is_pro_dom !== true);
const wireKeys = Object.keys(recon.shieldTools).filter((k) => /^shield_wire/i.test(k) && recon.shieldTools[k].is_pro_dom !== true);
console.log("modules:", modKeys.length, "bus:", busKeys.length, "wires:", wireKeys.length);
const series: [string, { x: number; y: number }][] = [];
if (modKeys[0]) series.push([modKeys[0], { x: shieldItem.pc.x - 4, y: shieldItem.pc.y }]);
if (modKeys[1]) series.push([modKeys[1], { x: shieldItem.pc.x - 2, y: shieldItem.pc.y }]);
if (busKeys[0]) series.push([busKeys[0], { x: shieldItem.pc.x, y: shieldItem.pc.y + 6 }]);
if (wireKeys[0]) series.push([wireKeys[0], { x: shieldItem.pc.x - 4, y: shieldItem.pc.y }]);
for (const [key, pt] of series) {
  const st = await pickTool(key);
  console.log("pick", key, ":", st);
  if (st !== "ok") continue;
  await clickAt(pt);
  await page.waitForTimeout(400);
}
const a2 = await copyServer();
const full = a2.shields ?? {};
writeOut("255-shield-full", { keys: Object.keys(recon.shieldTools), shields: full, item: a2.items?.[shieldItem.id] });
console.log("shields keys:", Object.keys(full));
console.log("shields:", JSON.stringify(full).slice(0, 2500));

function diffOf(before: any, after: any) {
  const ids = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: any = { added: {}, changed: {} };
  for (const id of ids) {
    if (!(id in (before ?? {}))) out.added[id] = after?.[id];
    else if (JSON.stringify(before[id]) !== JSON.stringify(after?.[id])) out.changed[id] = after[id];
  }
  return out;
}

// 6. откат: перезагрузка без сохранения
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null, { timeout: 60000 });
await page.waitForTimeout(3000);
const after = await loadModel(session, OBJECT_ID, PLAN_ID);
const same = JSON.stringify(after.model) === JSON.stringify(model.model);
console.log("GET после перезагрузки:", same ? "не изменился (откат ОК)" : "ИЗМЕНИЛСЯ");
await browser.close();
process.exit(0);
