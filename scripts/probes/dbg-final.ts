import { chromium } from 'playwright-core';
import { readFile, writeFile } from 'node:fs/promises';
const BASE = 'https://remplanner.ru';
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/planner/', { waitUntil: 'domcontentloaded' });
  await Promise.all([page.waitForNavigation({ timeout: 60000 }).catch(() => null), page.evaluate(() => (window as any).planner_create_object())]);
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null as any, { timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.evaluate(`(function(){function snap(v,d){d=d||0;if(v===null||typeof v!=='object')return typeof v==='function'?'[fn]':v;if(d>6)return '[deep]';if(Array.isArray(v))return v.map(function(x){return snap(x,d+1);});var o={};var ks;try{ks=Object.keys(v);}catch(e){return '[err]';}for(var i=0;i<ks.length;i++){try{o[ks[i]]=snap(v[ks[i]],d+1);}catch(e){o[ks[i]]='[err]';}}return o;}window.__snap=snap;})()`);
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
  const res = await page.evaluate(async (m: any) => {
    const w: any = window as any;
    w.$Project.restore(m);
    await new Promise((r) => setTimeout(r, 500));
    w.$Project.draw({ rooms: 1 });
    await new Promise((r) => setTimeout(r, 1200));
    // имя помещения: через зону (как делает change-хендлер cm-room<id>--zone-name)
    // ROOMS2 в headless пуст после draw — переключаемся на лист rooms кликом
    document.querySelector('.groups_navi_item.plan_rooms').click();
    await new Promise((r) => setTimeout(r, 1200));
    const rid = Object.keys(w.ROOMS2)[0];
    let nameWhere = null;
    if (rid) {
      const r2 = w.ROOMS2[rid];
      const z = (r2.zones || [])[0];
      if (z) { w.selected.room = r2; w.selected.zone = z; z.name = 'Гостиная'; z.draw(); w.project.localSave(); nameWhere = 'zones[0]'; }
    }
    const saved = await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/setup/api/planner/save/?object_id=' + (document.body as any).dataset.objectId + '&plan_id=' + (document.body as any).dataset.plan_id + '&plan=a&authk' + 'ey=' + (document.body as any).dataset.authkey + '&save_id=' + (document.body as any).dataset.save_id + '&is_resave=0&is_forced=0', true);
      xhr.onload = () => resolve(xhr.responseText.slice(0, 200));
      xhr.onerror = () => resolve('XHR-ERR');
      xhr.ontimeout = () => resolve('timeout');
      const copy = w.project.copy('server');
      copy.session = 34567;
      const body = new URLSearchParams({ plan_length: String(JSON.stringify(copy).length), session: '34567', version: String(w.global_version), save_id: (document.body as any).dataset.save_id, planner_version: '3', is_zip: '0', plan_data: JSON.stringify(copy) });
      xhr.send(body.toString());
    });
    return { rid, nameWhere, saved };
  }, model);
  console.log(JSON.stringify(res, null, 1));
  // перечитать с сервера в новом контексте (cookie те же — аноним по visitor_id)
  const st = await ctx.storageState();
  await writeFile('.orca-reports/anon-state.json', JSON.stringify(st));
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU', storageState: '.orca-reports/anon-state.json' });
  const p2 = await ctx2.newPage();
  const resp = p2.waitForResponse((r) => r.url().includes('/setup/api/planner/?'), { timeout: 60000 });
  await p2.goto(BASE + '/planner/', { waitUntil: 'domcontentloaded' });
  const j = await (await resp).json().catch(() => null);
  if (j && j.data) {
    const m = JSON.parse(j.data);
    await writeFile('tests/fixtures/normalized-with-name.json', JSON.stringify({ _source: 'probe-final: restore(fixture) → draw({rooms:1}) → zones[0].name=Гостиная → save → GET', model: m }, null, 2));
    console.log('rooms2 с сервера:', JSON.stringify(Object.values(m.rooms2 || {}).map((x: any) => ({ name: x.name, zoneNames: (x.zones || []).map((z: any) => z.name), area: x.area }))));
    console.log('walls:', Object.keys(m.walls).length, 'holes:', Object.values(m.walls).reduce((a: number, w: any) => a + Object.keys(w.holes || {}).length, 0));
  } else console.log('нет ответа сервера');
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
