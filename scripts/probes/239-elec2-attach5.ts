// 239-5: кабель к выводу провода и к розетке (тип вершины, pp, обратные ссылки),
// повторная попытка связи выключатель → лента (drag в обе стороны, медленный конец).
import { chromium } from "playwright-core";
import { existsSync, writeFileSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

// Запуск только по явному аргументу (ID проекта/плана — из env):
// node --experimental-strip-types scripts/probes/239-elec2-attach5.ts run
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
  await page.waitForTimeout(500);
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
// предметы: коробка (free), вывод (wire на edge0), розетка (socket на edge1)
await switchSheet("cables");
await pickTool("electric_box");
await clickAt({ x: cx + 40, y: cy });
await page.keyboard.press("Escape");
await switchSheet("sockets");
await pickTool("wire");
await clickAt(edgePts[0]);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await pickTool("socket");
await clickAt(edgePts[1]);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
let snap = await copyServer();
const box = Object.values<any>(snap.items ?? {}).find((i: any) => i.name === "electric_box");
const wire = Object.values<any>(snap.items ?? {}).find((i: any) => i.name === "wire");
const socket = Object.values<any>(snap.items ?? {}).find((i: any) => i.name === "socket_group" && (i.socket_group ?? [])[0]?.name === "socket");
console.log("items:", !!box, !!wire, !!socket);

async function drawCable(coll: string, tool: string, a: any, b: any) {
  await switchSheet(coll);
  const pick = await pickTool(tool);
  if (pick !== "ok") return { pick };
  await slowDrag({ x: a.pc.x, y: a.pc.y }, { x: b.pc.x, y: b.pc.y });
  await page.keyboard.press("Escape");
  return await copyServer();
}
const b0 = await copyServer();
// кабель коробка → вывод
await switchSheet("cables");
await pickTool("wire_3_25");
await slowDrag({ x: box.pc.x, y: box.pc.y }, { x: wire.pc.x, y: wire.pc.y });
await page.keyboard.press("Escape");
let a0 = await copyServer();
res["box_to_wire"] = {
  added: Object.keys(a0.cables_socket ?? {}).filter((id) => !(id in (b0.cables_socket ?? {}))).map((id) => a0.cables_socket[id]),
  wire_item: a0.items[wire.id], box_item: a0.items[box.id],
};
console.log("box→wire:", JSON.stringify(res.box_to_wire).slice(0, 1400));

// кабель коробка → розетка (новый кабель)
const b1 = await copyServer();
await pickTool("wire_2_25");
await slowDrag({ x: box.pc.x, y: box.pc.y }, { x: socket.pc.x, y: socket.pc.y });
await page.keyboard.press("Escape");
let a1 = await copyServer();
res["box_to_socket"] = {
  added: Object.keys(a1.cables_socket ?? {}).filter((id) => !(id in (b1.cables_socket ?? {}))).map((id) => a1.cables_socket[id]),
  socket_item: a1.items[socket.id],
};
console.log("box→socket:", JSON.stringify(res.box_to_socket).slice(0, 1400));

// связь выключатель → лента: drag от ленты к выключателю
await switchSheet("light");
await pickTool("led_strip");
await slowDrag({ x: cx - 60, y: cy - 90 }, { x: cx + 60, y: cy - 90 });
await page.keyboard.press("Escape");
await switchSheet("light_connections");
await pickTool("light_switch");
await clickAt(edgePts[2]);
await page.keyboard.press("Escape");
snap = await copyServer();
const sw2 = Object.values<any>(snap.items ?? {}).find((i: any) => i.name === "socket_group" && (i.socket_group ?? [])[0]?.name === "light_switch");
const strips = Object.keys(snap.led_strips ?? {});
console.log("switch:", !!sw2, "strips:", strips.length);
const b2 = await copyServer();
if (sw2) {
  await pickTool("cable");
  await slowDrag({ x: sw2.pc.x, y: sw2.pc.y }, { x: cx, y: cy - 90 });
  await page.keyboard.press("Escape");
  const a2 = await copyServer();
  res["strip_link"] = {
    cables_added: Object.keys(a2.cables ?? {}).filter((id) => !(id in (b2.cables ?? {}))).map((id) => a2.cables[id]),
    strip: strips.map((id) => a2.led_strips[id]),
    switch_item: sw2 ? a2.items[sw2.id] : null,
  };
  console.log("strip link:", JSON.stringify(res.strip_link).slice(0, 1600));
}
writeOut("239-elec2-attach5", res);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null, { timeout: 60000 });
await page.waitForTimeout(3000);
const after = await loadModel(session, OBJECT_ID, PLAN_ID);
console.log("GET после перезагрузки:", JSON.stringify(after.model) === JSON.stringify(model.model) ? "не изменился (откат ОК)" : "ИЗМЕНИЛСЯ");
await browser.close();
process.exit(0);
