import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
const BASE = 'https://remplanner.ru';
async function main() {
  const shell = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
  const browser = await chromium.launch({ executablePath: shell, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/planner/', { waitUntil: 'domcontentloaded' });
  await Promise.all([page.waitForNavigation({ timeout: 60000 }).catch(() => null), page.evaluate(() => (window as any).planner_create_object())]);
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null as any, { timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.evaluate(`(function(){function snap(v,d){d=d||0;if(v===null||typeof v!=='object')return typeof v==='function'?'[fn]':v;if(d>6)return '[deep]';if(Array.isArray(v))return v.map(function(x){return snap(x,d+1);});var o={};var ks;try{ks=Object.keys(v);}catch(e){return '[err]';}for(var i=0;i<ks.length;i++){try{o[ks[i]]=snap(v[ks[i]],d+1);}catch(e){o[ks[i]]='[err]';}}return o;}window.__snap=snap;})()`);

  const raw = JSON.parse(JSON.stringify(await readFile('tests/fixtures/anon-rect-4000x3000.json', 'utf8').then((j) => JSON.parse(j)).then((j) => j.model)));
  // стены: p1/p2 + грани; проёмы: p1/p2 по оси (pc ± width/2)
  for (const id of Object.keys(raw.walls)) {
    const w: any = raw.walls[id];
    const dx = w.p2.x - w.p1.x, dy = w.p2.y - w.p1.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const nx = (dy / len) * (w.depth / 2), ny = (-dx / len) * (w.depth / 2);
    w.l1 = { x: w.p1.x + nx, y: w.p1.y + ny }; w.l2 = { x: w.p2.x + nx, y: w.p2.y + ny };
    w.r1 = { x: w.p1.x - nx, y: w.p1.y - ny }; w.r2 = { x: w.p2.x - nx, y: w.p2.y - ny };
    for (const hid of Object.keys(w.holes || {})) {
      const h: any = w.holes[hid];
      const half = h.width / 2;
      h.p1 = { x: h.pc.x - ux * half, y: h.pc.y - uy * half };
      h.p2 = { x: h.pc.x + ux * half, y: h.pc.y + uy * half };
    }
  }
  const res = await page.evaluate((m: any) => {
    const w: any = window as any;
    const out: any = {};
    w.$Project.restore(m);
    const holesAfterRestore: any = {};
    for (const id of Object.keys(w.WALLS)) holesAfterRestore[id] = w.__snap(w.WALLS[id].holes);
    out.afterRestore = holesAfterRestore;
    w.$Project.draw({ rooms: 1 });
    return new Promise((r) => setTimeout(() => {
      const holesAfterDraw: any = {};
      for (const id of Object.keys(w.WALLS)) holesAfterDraw[id] = w.__snap(w.WALLS[id].holes);
      out.afterDraw = holesAfterDraw;
      out.rooms2 = w.__snap(w.ROOMS2);
      out.copy = w.__snap(w.project.copy('server'));
      r(out);
    }, 1200));
  }, raw);
  for (const id of Object.keys(res.afterDraw)) {
    const hs = res.afterDraw[id];
    for (const hid of Object.keys(hs)) console.log('survived hole', id, hid, JSON.stringify(hs[hid]).slice(0, 400));
  }
  console.log('rooms2 count:', Object.keys(res.rooms2).length, 'areas:', Object.values(res.rooms2).map((r: any) => r.area));
  const copy = res.copy;
  console.log('copy holes:', Object.values(copy.walls).flatMap((w: any) => Object.keys(w.holes || {})).length);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
