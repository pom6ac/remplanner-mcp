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

  const norm = JSON.parse(await readFile('api-dump.normalize.json', 'utf8'));
  const saved = JSON.parse(await readFile('api-dump.normalize-reload.json', 'utf8'));
  const raw = JSON.parse(JSON.stringify(await readFile('tests/fixtures/anon-rect-4000x3000.json', 'utf8').then((j) => JSON.parse(j)).then((j) => j.model)));

  const holesOf = () => page.evaluate(() => {
    const w: any = window as any;
    const out: any = {};
    for (const id of Object.keys(w.WALLS)) out[id] = w.__snap(w.WALLS[id].holes);
    return { holes: out, errors: w.__snap(w.errors), level_holes: w.__snap(w.level_holes || {}) };
  });

  // 1. raw с гранями: holes после restore и после draw
  const withFaces = JSON.parse(JSON.stringify(raw));
  for (const id of Object.keys(withFaces.walls)) {
    const w = withFaces.walls[id];
    const dx = w.p2.x - w.p1.x, dy = w.p2.y - w.p1.y, len = Math.hypot(dx, dy) || 1;
    const nx = (dy / len) * (w.depth / 2), ny = (-dx / len) * (w.depth / 2);
    w.l1 = { x: w.p1.x + nx, y: w.p1.y + ny }; w.l2 = { x: w.p2.x + nx, y: w.p2.y + ny };
    w.r1 = { x: w.p1.x - nx, y: w.p1.y - ny }; w.r2 = { x: w.p2.x - nx, y: w.p2.y - ny };
  }
  await page.evaluate((m: any) => { (window as any).$Project.restore(m); }, withFaces);
  console.log('raw+faces after restore:', JSON.stringify(await holesOf()));
  await page.evaluate(() => (window as any).$Project.draw({ rooms: 1 }));
  await page.waitForTimeout(1000);
  console.log('raw+faces after draw:', JSON.stringify((await holesOf()).holes));

  // 2. нормализованная модель + проём, добавленный обратно
  const withHole = JSON.parse(JSON.stringify(saved));
  const hid = 'probeaaaaaa';
  withHole.walls.gxugmdrasv.holes[hid] = { id: hid, plan: 'a', type: 'window', group: 'windows', pc: { x: 200, y: 0 }, width: 120, height: 150, depth: 10, floor_height: 80 };
  await page.evaluate((m: any) => { (window as any).$Project.restore(m); }, withHole);
  const afterRestore = await holesOf();
  console.log('normalized+hole after restore:', JSON.stringify(afterRestore.holes));
  await page.evaluate(() => (window as any).$Project.draw({ rooms: 1 }));
  await page.waitForTimeout(1000);
  const afterDraw = await holesOf();
  console.log('normalized+hole after draw:', JSON.stringify(afterDraw.holes));
  console.log('errors:', JSON.stringify(afterDraw.errors));
  await browser.close();
}
// Ревью 159 m5 (инцидент 158): main() — только при прямом запуске файла;
// импорт модуля не должен запускать живой сценарий.
if (process.argv[1]?.endsWith("probe-restore-debug5.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

