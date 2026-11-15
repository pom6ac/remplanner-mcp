import { chromium } from 'playwright-core';
const BASE = 'https://remplanner.ru';
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/planner/', { waitUntil: 'domcontentloaded' });
  await Promise.all([page.waitForNavigation({ timeout: 60000 }).catch(() => null), page.evaluate(() => (window as any).planner_create_object())]);
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null as any, { timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.evaluate(`(function(){function snap(v,d){d=d||0;if(v===null||typeof v!=='object')return typeof v==='function'?'[fn]':v;if(d>6)return '[deep]';if(Array.isArray(v))return v.map(function(x){return snap(x,d+1);});var o={};var ks;try{ks=Object.keys(v);}catch(e){return '[err]';}for(var i=0;i<ks.length;i++){try{o[ks[i]]=snap(v[ks[i]],d+1);}catch(e){o[ks[i]]='[err]';}}return o;}window.__snap=snap;})()`);
  // комната через restore (фабрика из core)
  const fixture = JSON.parse(await readFile('tests/fixtures/anon-rect-4000x3000.json', 'utf8'));
  const model = JSON.parse(JSON.stringify(fixture.model));
  for (const id of Object.keys(model.walls)) {
    const w: any = model.walls[id];
    const dx = w.p2.x - w.p1.x, dy = w.p2.y - w.p1.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, nx = (dy / len) * (w.depth / 2), ny = (-dx / len) * (w.depth / 2);
    w.l1 = { x: w.p1.x + nx, y: w.p1.y + ny }; w.l2 = { x: w.p2.x + nx, y: w.p2.y + ny };
    w.r1 = { x: w.p1.x - nx, y: w.p1.y - ny }; w.r2 = { x: w.p2.x - nx, y: w.p2.y - ny };
    for (const hid of Object.keys(w.holes || {})) {
      const h: any = w.holes[hid]; const half = h.width / 2;
      h.p1 = { x: h.pc.x - ux * half, y: h.pc.y - uy * half };
      h.p2 = { x: h.pc.x + ux * half, y: h.pc.y + uy * half };
    }
  }
  const out = await page.evaluate(async (m: any) => {
    const w: any = window as any;
    w.$Project.restore(m);
    await new Promise((r) => setTimeout(r, 500));
    w.$Project.draw({ rooms: 1 });
    await new Promise((r) => setTimeout(r, 1200));
    // имя: сначала переключиться на лист rooms (нужно ли?) — пробуем просто записать name в ROOMS2
    const rid = Object.keys(w.ROOMS2)[0];
    const before = rid ? w.ROOMS2[rid].name : null;
    let zoneInfo = null;
    if (rid) {
      const rr = w.ROOMS2[rid];
      zoneInfo = { zones: rr.zones ? rr.zones.length : 0, zoneName: rr.zones && rr.zones[0] ? rr.zones[0].name : null, keys: Object.keys(rr).slice(0, 40) };
      if (rr.zones && rr.zones[0]) rr.zones[0].name = 'Гостиная';
      rr.name = 'Гостиная';
    }
    const respPromise = new Promise((res) => {
      // перехват ответа save не нужен — просто ждём
      setTimeout(res, 2500);
    });
    const saveRet = w.project.save(false, true);
    await respPromise;
    const copy = w.__snap(w.project.copy('server'));
    return { rid, before, zoneInfo, saveRet: String(saveRet).slice(0, 80), rooms2: copy.rooms2 ? Object.values(copy.rooms2).map((r: any) => ({ name: r.name, area: r.area })) : null };
  }, model);
  console.log(JSON.stringify(out, null, 1));
  // перечитать с сервера
  await page.waitForTimeout(1000);
  const data = await page.evaluate(async () => {
    const oid = (document.body as any).dataset.objectId || (document.body as any).dataset.object_id;
    const pid = (document.body as any).dataset.plan_id || (document.body as any).dataset.planId;
    const j = await (await fetch('/setup/api/planner/?object_id=' + oid + '&plan_id=' + pid, { credentials: 'include' })).json();
    const m = JSON.parse(j.data);
    return { rooms2: Object.values(m.rooms2 || {}).map((r: any) => ({ name: r.name, area: r.area })), rooms1: Object.values(m.rooms1 || {}).map((r: any) => ({ name: r.name, area: r.area })) };
  });
  console.log('с сервера:', JSON.stringify(data));
  await browser.close();
}
import { readFile } from 'node:fs/promises';
main().catch((e) => { console.error(e); process.exit(1); });
