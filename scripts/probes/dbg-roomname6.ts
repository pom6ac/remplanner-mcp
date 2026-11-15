import { chromium } from 'playwright-core';
const BASE = 'https://remplanner.ru';
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/planner/', { waitUntil: 'domcontentloaded' });
  await Promise.all([page.waitForNavigation({ timeout: 60000 }).catch(() => null), page.evaluate(() => (window as any).planner_create_object())]);
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null as any, { timeout: 60000 });
  await page.waitForTimeout(11000);
  await page.addStyleTag({ content: '#planner_ui_message_fog:empty{display:none !important}' });
  const toScreen = async (px: number, py: number) => page.evaluate(([x, y]: any) => {
    const svg: any = document.querySelector('#main_svg'); const r = svg.getBoundingClientRect();
    const p = svg.getAttribute('viewBox').trim().split(/[\s,]+/).map(Number);
    return { x: r.x + ((x - p[0]) * r.width) / p[2], y: r.y + ((y - p[1]) * r.height) / p[3] };
  }, [px, py]);
  const pts = { A: [-200, -150], B: [200, -150], C: [200, 150], D: [-200, 150] };
  for (const [p, q] of [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A']] as const) {
    const s1 = await toScreen(pts[p][0], pts[p][1]), s2 = await toScreen(pts[q][0], pts[q][1]);
    await page.mouse.move(s1.x, s1.y); await page.mouse.down(); await page.mouse.move(s2.x, s2.y, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(300);
  }
  await page.click('.groups_navi_item.plan_rooms');
  await page.waitForTimeout(1200);
  const res = await page.evaluate(`(function(){function snap(v,d){d=d||0;if(v===null||typeof v!=='object')return typeof v==='function'?'[fn]':v;if(d>6)return '[deep]';if(Array.isArray(v))return v.map(function(x){return snap(x,d+1);});var o={};var ks;try{ks=Object.keys(v);}catch(e){return '[err]';}for(var i=0;i<ks.length;i++){try{o[ks[i]]=snap(v[ks[i]],d+1);}catch(e){o[ks[i]]='[err]';}}return o;}window.__snap=snap;})()`);
  const res2 = await page.evaluate(async () => {
    const w: any = window as any;
    const rid = Object.keys(w.ROOMS2)[0];
    if (!rid) return { err: 'no rooms2' };
    const r = w.ROOMS2[rid];
    const z = (r.zones || [])[0];
    if (!z) return { err: 'no zone' };
    w.selected.room = r;
    w.selected.zone = z;
    z.name = 'Гостиная';
    z.draw();
    w.project.localSave();
    await new Promise((res2) => setTimeout(res2, 800));
    const copyRooms = Object.values(w.__snap(w.project.copy('server')).rooms2 || {}).map((x: any) => ({ name: x.name, zones: (x.zones || []).map((zz: any) => zz.name) }));
    return { copyRooms };
    const oid = (document.body as any).dataset.objectId || (document.body as any).dataset.object_id;
    const pid = (document.body as any).dataset.plan_id || (document.body as any).dataset.planId;
    let out2: any = { err: 'no data from server' };
    for (let i = 0; i < 5; i++) {
      await new Promise((res2) => setTimeout(res2, 1500));
      try {
        const j = await (await fetch('/setup/api/planner/?object_id=' + oid + '&plan_id=' + pid, { credentials: 'include' })).text();
        if (j.trim()) { const m = JSON.parse(j); if (m.data) { const mm = JSON.parse(m.data); out2 = { serverRooms2: Object.values(mm.rooms2 || {}).map((x: any) => ({ name: x.name, area: x.area })) }; break; } }
      } catch (e) {}
    }
    return { copyRooms2: undefined, ...out2 };
  });
  console.log('результат:', JSON.stringify(res2, null, 1));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
