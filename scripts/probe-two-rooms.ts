// Эталон: две соседние комнаты, нарисованные мышью в UI (как T1). Анонимный проект.
// Запуск: node scripts/probe-two-rooms.ts
import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = "https://remplanner.ru";

async function toScreen(page: any, px: number, py: number) {
  const v = await page.evaluate(() => {
    const svg: any = document.querySelector("#main_svg");
    const r = svg.getBoundingClientRect();
    const p = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    return { rx: r.x, ry: r.y, rw: r.width, rh: r.height, mx: p[0], my: p[1], vw: p[2], vh: p[3] };
  });
  return { x: v.rx + ((px - v.mx) * v.rw) / v.vw, y: v.ry + ((py - v.my) * v.rh) / v.vh };
}

async function clearFog(page: any) {
  await page.evaluate(() => {
    const f: any = document.querySelector("#planner_ui_message_fog");
    if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
    document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
  });
  await page.waitForTimeout(150);
}

async function main() {
  mkdirSync("screenshots", { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "ru-RU" });
  const page = await ctx.newPage();
  await page.goto(BASE + "/planner/", { waitUntil: "domcontentloaded" });
  await Promise.all([page.waitForNavigation({ timeout: 60000 }).catch(() => null), page.evaluate(() => (window as any).planner_create_object())]);
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null as any, { timeout: 60000 });
  await page.waitForTimeout(2500);
  await clearFog(page);

  // комната 1: 400x300 (ось), стены: верх, право, низ, лево
  const A = { x: -200, y: -150 }, B = { x: 200, y: -150 }, C = { x: 200, y: 150 }, D = { x: -200, y: 150 };
  for (const [p, q] of [[A, B], [B, C], [C, D], [D, A]] as const) {
    await clearFog(page);
    const s1 = await toScreen(page, p.x, p.y), s2 = await toScreen(page, q.x, q.y);
    await page.mouse.move(s1.x, s1.y);
    await page.mouse.down();
    await page.mouse.move(s2.x, s2.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(800);
  // комната 2 справа: общая стена = правая стена комнаты 1 (B-C); рисуем верх, право, низ
  const E = { x: 200, y: -150 }, F = { x: 320, y: -150 }, G = { x: 320, y: 150 }, H = { x: 200, y: 150 };
  for (const [p, q] of [[E, F], [F, G], [G, H]] as const) {
    await clearFog(page);
    const s1 = await toScreen(page, p.x, p.y), s2 = await toScreen(page, q.x, q.y);
    await page.mouse.move(s1.x, s1.y);
    await page.mouse.down();
    await page.mouse.move(s2.x, s2.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(1200);
  const dump: any = await page.evaluate(() => {
    const w: any = window as any;
    const walls: any = {};
    for (const [id, x] of Object.entries<any>(w.WALLS)) {
      walls[id] = {
        p1: [x.p1.x, x.p1.y], p2: [x.p2.x, x.p2.y], depth: x.depth,
        l1: x.l1 && [Math.round(x.l1.x * 10) / 10, Math.round(x.l1.y * 10) / 10],
        l2: x.l2 && [Math.round(x.l2.x * 10) / 10, Math.round(x.l2.y * 10) / 10],
        r1: x.r1 && [Math.round(x.r1.x * 10) / 10, Math.round(x.r1.y * 10) / 10],
        r2: x.r2 && [Math.round(x.r2.x * 10) / 10, Math.round(x.r2.y * 10) / 10],
        linkP1: x.p1.link, linkP2: x.p2.link,
      };
    }
    return {
      walls,
      rooms1: Object.entries<any>(w.ROOMS1 || {}).map(([id, r]) => ({ id, area: r.area, points: (r.points || []).map((p: any) => [Math.round(p.x), Math.round(p.y)]) })),
      rooms2areas: Object.values<any>(w.ROOMS2 || {}).map((r) => r.area),
    };
  });
  console.log("rooms1:", JSON.stringify(dump.rooms1));
  console.log("rooms2 areas:", JSON.stringify(dump.rooms2areas));
  for (const [id, x] of Object.entries<any>(dump.walls)) {
    console.log(id, `p1=(${x.p1[0]},${x.p1[1]}) p2=(${x.p2[0]},${x.p2[1]}) d=${x.depth}`,
      "l1=", JSON.stringify(x.l1), "l2=", JSON.stringify(x.l2), "r1=", JSON.stringify(x.r1), "r2=", JSON.stringify(x.r2));
  }
  for (const [id, x] of Object.entries<any>(dump.walls)) {
    console.log(id, "linkP1:", JSON.stringify(x.linkP1), "linkP2:", JSON.stringify(x.linkP2));
  }
  writeFileSync("tests/fixtures/ui-ref-mouse-drawing.json", JSON.stringify({ _source: "проба scripts/probe-two-rooms.ts (мышью в UI, анонимно)", walls: dump.walls, rooms1: dump.rooms1 }, null, 2));
  await page.screenshot({ path: "screenshots/probe-two-rooms.png" });
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
