// 88: живой формат связи «выключатель → светильник» (PRO-проект из env).
// БЕЗ сохранения: связь строится методами редактора (как UI), откат — перезагрузкой;
// после пробы GET-сверка с бэкапом. Проба также снимает умолчания PRO-пунктов.
import { chromium } from "playwright-core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID"); process.exit(1); }
const OUT = ".orca-reports/phase2-ui-refs";

const session = loadSession(STATE_PATH);
const shell = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: existsSync(shell) ? shell : undefined, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "ru-RU" });
await ctx.addCookies(session.cookies.map((c) => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/",
  expires: c.expires === -1 ? undefined : c.expires, httpOnly: c.httpOnly ?? false, secure: c.secure ?? false,
})));
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("[console." + m.type() + "]", m.text().slice(0, 300)); });
await page.goto(`https://remplanner.ru/planner/?object_id=${OBJECT_ID}&plan_id=${PLAN_ID}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project && (window as any).project, null, { timeout: 60000 });
await page.waitForTimeout(3000);

const clearFog = () => page.evaluate(() => {
  const f: any = document.querySelector("#planner_ui_message_fog");
  if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
  document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
});
const copyServer = () => page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));

const model = await loadModel(session, OBJECT_ID, PLAN_ID);
const rooms = Object.values<any>(model.model.rooms2 ?? {});
const room = rooms[0]!;
const poly = (room.polygon ?? room.points ?? []).map((p: any) => ({ x: p.x, y: p.y })); // см
if (poly.length < 3) { console.log("FAIL: нет полигона комнаты"); await browser.close(); process.exit(1); }
const e0 = { p1: poly[0]!, p2: poly[1]! };
const mid = { x: (e0.p1.x + e0.p2.x) / 2, y: (e0.p1.y + e0.p2.y) / 2 };
const len = Math.hypot(e0.p2.x - e0.p1.x, e0.p2.y - e0.p1.y);
const nx = (e0.p2.y - e0.p1.y) / len, ny = -(e0.p2.x - e0.p1.x) / len;
const roomCenter = { x: poly.reduce((s: number, p: any) => s + p.x, 0) / poly.length, y: poly.reduce((s: number, p: any) => s + p.y, 0) / poly.length };
const wallPt = { x: mid.x + nx * 7, y: mid.y + ny * 7 };
const centerPt = { x: roomCenter.x, y: roomCenter.y };
console.log("wallPt:", wallPt, "centerPt:", centerPt);

const toScreen = async (p: { x: number; y: number }) => page.evaluate((pp) => {
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
const pickTool = async (key: string) => page.evaluate((k) => {
  const el: any = document.querySelector(`#plannertool_${k}`);
  if (!el) return "missing";
  const group = el.closest(".tools_item, .subtools_item");
  if (el.classList.contains("is_pro") || (group && group.classList.contains("is_pro"))) return "pro";
  const parent: any = el.closest(".subtools");
  if (parent && parent.id) { const op: any = document.querySelector(`[data-target="${parent.id}"]`); op?.click(); }
  el.click();
  return "ok";
}, key);
const sheet = (s: string) => page.evaluate((ss) => {
  const nav: any = document.querySelector(`.groups_navi_item.plan_${ss}`);
  if (!nav) return false;
  nav.click(); return true;
}, s);

const base = await copyServer();
function added(b: any, a: any) {
  const bIds = new Set(Object.keys(b.items ?? {}));
  return Object.values<any>(a.items ?? {}).filter((it: any) => !bIds.has(it.id));
}

// 1. выключатель + люстра
await sheet("light_connections");
console.log("pick light_switch:", await pickTool("light_switch"));
await clickAt(wallPt);
await page.keyboard.press("Escape");
let cur = await copyServer();
const swAdded = added(base, cur);
console.log("switch:", JSON.stringify(swAdded.map((i: any) => ({ name: i.name, subs: (i.socket_group ?? []).map((s: any) => s.name) }))));
await sheet("light");
console.log("pick chandelier:", await pickTool("chandelier"));
await clickAt(centerPt);
await page.keyboard.press("Escape");
cur = await copyServer();
const ch = added(base, cur).find((i: any) => i.name === "chandelier");
console.log("chandelier:", ch ? ch.id : "NO");

// 2. связь методами редактора (как UI: source — под-розетка выключателя, target — клик у люстры)
await sheet("light_connections");
console.log("pick cable:", await pickTool("cable"));
const linkRes = await page.evaluate((pp) => {
  const w = window as any;
  const sw = Object.values<any>(w.ITEMS).find((it: any) => it.props?.name === "socket_group" && (it.props.socket_group ?? []).some((s: any) => s.name === "light_switch"));
  const chI = Object.values<any>(w.ITEMS).find((it: any) => it.props?.name === "chandelier");
  if (!sw || !chI) return { error: "нет предметов", items: Object.keys(w.ITEMS ?? {}).length };
  const sub = sw.props.socket_group.find((s: any) => s.name === "light_switch");
  sw.selected_socket_group = w.$SocketsGroup.generateIdSocket(sw, sub.id);
  const r1 = w.$ManagerLining.item_mousedown(sw);
  const c = w.$CablingSwitcher;
  const afterSource = { source_item: c.source_item ? c.source_item.props?.name : null, source_id: c.source_id };
  return { r1, afterSource, sourcePoint: c.source_point, switchItem: sw.serialize(), chandelier: chI.serialize() };
}, null);
console.log("link:", JSON.stringify(linkRes).slice(0, 800));
const chPt = { x: (linkRes as any).chandelier.pc.x, y: (linkRes as any).chandelier.pc.y };
await clickAt(chPt);
await page.waitForTimeout(500);
const cableDump2 = await page.evaluate(() => {
  const w = window as any;
  const out: any = {};
  for (const [k, v] of Object.entries<any>(w.CABLES ?? {})) out[k] = v.serialize ? v.serialize() : v;
  const chI = Object.values<any>(w.ITEMS).find((it: any) => it.props?.name === "chandelier");
  const sw = Object.values<any>(w.ITEMS).find((it: any) => it.props?.name === "socket_group" && (it.props.socket_group ?? []).some((s: any) => s.name === "light_switch"));
  return { cables: out, ch: chI ? chI.serialize() : null, sw: sw ? sw.serialize() : null, src: { si: w.$CablingSwitcher.source_item ? 1 : null } };
});
console.log("cableDump2:", JSON.stringify(cableDump2).slice(0, 2200));
writeFileSync(`${OUT}/88-live-link2.json`, JSON.stringify(cableDump2, null, 1));
await page.keyboard.press("Escape");

// 3. PRO-умолчания розеток/выключателей (клики вдоль стены, без save)
const curAfterLink = await copyServer();
const wallDirs: { x: number; y: number }[] = [];
// вторая грань полигона для разнообразия
const e1 = { p1: poly[1]!, p2: poly[2]! };
const mid1 = { x: (e1.p1.x + e1.p2.x) / 2, y: (e1.p1.y + e1.p2.y) / 2 };
const len1 = Math.hypot(e1.p2.x - e1.p1.x, e1.p2.y - e1.p1.y);
const nx1 = (e1.p2.y - e1.p1.y) / len1, ny1 = -(e1.p2.x - e1.p1.x) / len1;
const wallPt1 = { x: mid1.x + nx1 * 7, y: mid1.y + ny1 * 7 };
const dir = { x: (e1.p2.x - e1.p1.x) / len1, y: (e1.p2.y - e1.p1.y) / len1 };
const samples: Record<string, { sheet: string; p: { x: number; y: number } }> = {
  ceiling_socket: { sheet: "sockets", p: centerPt },
  floor_socket: { sheet: "sockets", p: { x: centerPt.x + 40, y: centerPt.y } },
  furniture_socket: { sheet: "sockets", p: { x: wallPt1.x + dir.x * 20, y: wallPt1.y + dir.y * 20 } },
  socket_tv: { sheet: "sockets", p: { x: wallPt1.x + dir.x * 45, y: wallPt1.y + dir.y * 45 } },
  socket_usb: { sheet: "sockets", p: { x: wallPt1.x + dir.x * 70, y: wallPt1.y + dir.y * 70 } },
  socket_hdmi: { sheet: "sockets", p: { x: wallPt1.x + dir.x * 95, y: wallPt1.y + dir.y * 95 } },
  socket_phone: { sheet: "sockets", p: { x: wallPt1.x + dir.x * 120, y: wallPt1.y + dir.y * 120 } },
  socket_audio: { sheet: "sockets", p: { x: wallPt1.x + dir.x * 145, y: wallPt1.y + dir.y * 145 } },
  socket_ip: { sheet: "sockets", p: { x: wallPt1.x + dir.x * 170, y: wallPt1.y + dir.y * 170 } },
  socket_group: { sheet: "sockets", p: { x: wallPt1.x + dir.x * 195, y: wallPt1.y + dir.y * 195 } },
  light_switch_triple: { sheet: "light_connections", p: { x: wallPt.x + 25, y: wallPt.y } },
  light_dimmer: { sheet: "light_connections", p: { x: wallPt.x + 50, y: wallPt.y } },
  light_switch_through: { sheet: "light_connections", p: { x: wallPt.x + 75, y: wallPt.y } },
  light_switch_through_double: { sheet: "light_connections", p: { x: wallPt.x + 100, y: wallPt.y } },
  light_switch_cross: { sheet: "light_connections", p: { x: wallPt.x + 125, y: wallPt.y } },
  light_switch_cross_double: { sheet: "light_connections", p: { x: wallPt.x + 150, y: wallPt.y } },
  light_switch_master: { sheet: "light_connections", p: { x: wallPt.x + 175, y: wallPt.y } },
};
const pro: Record<string, any> = {};
for (const [name, cfg] of Object.entries(samples)) {
  await sheet(cfg.sheet);
  const st = await pickTool(name);
  if (st !== "ok") { pro[name] = { pick: st }; console.log(name, st); continue; }
  const b = await copyServer();
  await clickAt(cfg.p);
  await page.keyboard.press("Escape");
  const a = await copyServer();
  const bIds = new Set(Object.keys(b.items ?? {}));
  const it = Object.values<any>(a.items ?? {}).filter((x: any) => !bIds.has(x.id));
  const item = it.find((x: any) => x.name === name) ?? it.find((x: any) => x.name === "socket_group");
  pro[name] = item ? { item } : { pick: st, added: it.map((x: any) => x.name) };
  console.log(name, item ? "OK " + item.name : "NO ITEM " + JSON.stringify(it.map((x: any) => x.name)));
}
writeFileSync(`${OUT}/88-live-pro-items.json`, JSON.stringify(pro, null, 1));

// 4. откат: перезагрузка без save + GET-сверка с бэкапом
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const afterModel = await loadModel(session, OBJECT_ID, PLAN_ID);
const beforeModel = JSON.parse(readFileSync(new URL(`../../../../remplanner-mcp/.orca-reports/backup-${OBJECT_ID}-88.json`, import.meta.url), "utf8"));
const strip = (m: any) => { const c = { ...m }; delete c.save_id; return JSON.stringify(c); };
console.log("GET после пробы == бэкап (без save_id):", strip(afterModel.model) === strip(beforeModel.model) ? "OK — не изменился" : "РАСХОЖДЕНИЕ");
await browser.close();
process.exit(0);
