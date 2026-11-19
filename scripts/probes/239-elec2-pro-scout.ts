// 239: разведка PRO-части электрики в dev-проекте (env): каталог electric_shield/lowcurrent/
// boxes, коробки и щиток как предметы (UI-клики), кабель cables_socket (drag), плоскость
// (пол/потолок), вершины-опуски, конструктор щитка (shields, $ShieldBuilder). БЕЗ сохранения:
// откат — перезагрузкой; бэкап модели до пробы.
import { chromium } from "playwright-core";
import { existsSync, writeFileSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

// Запуск только по явному аргументу (ID проекта/плана — из env):
// node --experimental-strip-types scripts/probes/239-elec2-pro-scout.ts run
if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run (RP_OID/RP_PLAN или REMPLANNER_PROBE_* из env)");
  process.exit(0);
}

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID"); process.exit(1); }
const OUT = ".orca-reports/phase2-ui-refs";

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
async function dragAt(a: { x: number; y: number }, b: { x: number; y: number }) {
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

// 0. бэкап GET
const model = await loadModel(session, OBJECT_ID, PLAN_ID);
writeFileSync(`.orca-reports/backup-${OBJECT_ID}-239.json`, JSON.stringify({
  _source: "GET через loadModel, dev-проект из env, scripts/probes/239-elec2-pro-scout.ts, только чтение; id не печатаются",
  model: model.model,
}, null, 1));
console.log("backup ok");

// 1. каталог PRO-проекта: электрика ч.2
const catalog = await page.evaluate(() => {
  const w: any = window as any;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries<any>(w.global_tools ?? {})) {
    if (/^electric_|^lowcurrent_|^electric_box|^wire_lowcurrent/.test(k) || (v && v.group === "cables" && !/^wire_|^electrospot|^warm_floor_wire|^conditioner_wire/.test(k))) {
      out[k] = { group: v.group, plan: v.plan, anchor: v.anchor ?? null, width: v.width, height: v.height,
        self_height: v.self_height, over_floor: v.over_floor ?? null, title: v.title ?? null, subgroup: v.subgroup ?? null };
    }
  }
  return out;
});
writeOut("239-elec2-pro-catalog", catalog);
console.log("pro catalog:", JSON.stringify(catalog));

// 2. точки пробы: комната побольше
const rooms = Object.values<any>(model.model.rooms2 ?? {});
const room = rooms[0]!;
const poly = (room.polygon ?? []).map((p: any) => ({ x: p.x, y: p.y }));
const center = { x: poly.reduce((s: number, p: any) => s + p.x, 0) / poly.length, y: poly.reduce((s: number, p: any) => s + p.y, 0) / poly.length };
console.log("room center:", center);

// 3. UI-клики: коробки и щиток (PRO) — в комнате, откат перезагрузкой
const res: Record<string, any> = {};
const b0 = await copyServer();
await switchSheet("cables");
for (const name of ["electric_box", "electric_box_wall", "electric_kup"]) {
  const pick = await pickTool(name);
  if (pick !== "ok") { res[name] = { pick }; continue; }
  await clickAt({ x: center.x + 20, y: center.y + 20 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const a = await copyServer();
  const added = Object.values<any>(a.items ?? {}).filter((it: any) => !Object.keys(b0.items ?? {}).includes(it.id));
  res[name] = added.length ? { item: added[0] } : { pick, added_names: added.map((x: any) => x.name) };
  console.log(name, added.length ? "OK" : "no item");
}
// щиток: electric_shield (накладной) и lowcurrent_shield
for (const name of ["electric_shield", "electric_shield_internal", "lowcurrent_shield", "lowcurrent_shield_internal"]) {
  const pick = await pickTool(name);
  if (pick !== "ok") { res[name] = { pick }; continue; }
  await clickAt({ x: center.x - 40, y: center.y - 30 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const a = await copyServer();
  const added = Object.values<any>(a.items ?? {}).filter((it: any) => !Object.keys(b0.items ?? {}).includes(it.id));
  res[name] = added.length ? { item: added[0] } : { pick, added_names: added.map((x: any) => x.name) };
  console.log(name, added.length ? "OK" : "no item");
}
writeOut("239-elec2-pro-items", res);

// 4. кабель cables_socket: drag между двумя точками комнаты
const b1 = await copyServer();
let pick = await pickTool("wire_3_25");
console.log("pick wire_3_25:", pick);
if (pick === "ok") {
  await dragAt({ x: center.x - 30, y: center.y }, { x: center.x + 30, y: center.y });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}
const a1 = await copyServer();
res["cable_drag"] = {
  cables_socket: diffOf(b1.cables_socket, a1.cables_socket),
  items_added: Object.values<any>(a1.items ?? {}).filter((it: any) => !Object.keys(b1.items ?? {}).includes(it.id)).map((x: any) => ({ id: x.id, name: x.name })),
};
writeOut("239-elec2-cable-drag", res["cable_drag"]);
console.log("cable_socket diff:", JSON.stringify(res["cable_drag"]).slice(0, 1200));

function diffOf(before: any, after: any) {
  const ids = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: any = { added: {}, changed: {} };
  for (const id of ids) {
    if (!(id in (before ?? {}))) out.added[id] = after?.[id];
    else if (JSON.stringify(before[id]) !== JSON.stringify(after?.[id])) out.changed[id] = after[id];
  }
  return out;
}

// 5. конструктор щитка: глобалы и сериализация shields
const shieldInfo = await page.evaluate(() => {
  const w: any = window as any;
  const out: any = { shields: JSON.parse(JSON.stringify(w.project?.shields ?? w.SHIELDS ?? {})) };
  out.shieldBuilderMethods = w.$ShieldBuilder ? Object.getOwnPropertyNames(Object.getPrototypeOf(w.$ShieldBuilder)) : null;
  out.shieldDims = w.ShieldDimensions ? String(w.ShieldDimensions).slice(0, 400) : null;
  const menu = document.querySelector("#plannertool_electric_shield");
  out.shieldToolExists = !!menu;
  return out;
});
writeOut("239-elec2-shield", shieldInfo);
console.log("shield:", JSON.stringify(shieldInfo).slice(0, 500));

// 6. откат: перезагрузка без сохранения
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null, { timeout: 60000 });
await page.waitForTimeout(3000);
const after = await loadModel(session, OBJECT_ID, PLAN_ID);
const same = JSON.stringify(after.model) === JSON.stringify(model.model);
console.log("GET после перезагрузки:", same ? "не изменился (откат ОК)" : "ИЗМЕНИЛСЯ");
await browser.close();
process.exit(0);
