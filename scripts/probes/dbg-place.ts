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
  const clearFog = () => page.evaluate(() => { const f: any = document.querySelector('#planner_ui_message_fog'); if (f && f.classList.contains('active') && !f.innerHTML.trim()) f.classList.remove('active'); });
  await clearFog();
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
  const holes = () => page.evaluate(() => { const out: any[] = []; for (const w of Object.values((window as any).WALLS) as any[]) for (const h of Object.values(w.holes || {})) out.push(h.type); return out; });
  console.log('walls:', await page.evaluate(() => Object.keys((window as any).WALLS).length));
  // окно: активировать и проверить active
  await page.click('.tools_item.toolid14');
  await page.waitForTimeout(400);
  await page.click('#plannertool_window');
  await page.waitForTimeout(500);
  console.log('active tool:', await page.evaluate(() => { const t: any = document.querySelector('.tools_item.active'); return t ? t.textContent.trim() : null; }));
  const sW = await toScreen(0, -150);
  await clearFog();
  await page.mouse.click(sW.x, sW.y);
  await page.waitForTimeout(800);
  console.log('holes после окна:', await holes());
  // диван
  await page.click('.groups_navi_item.plan_furniture');
  await page.waitForTimeout(800);
  await page.click('.tools_item.toolid83');
  await page.waitForTimeout(500);
  await page.getByText('Диваны', { exact: true }).first().click();
  await page.waitForTimeout(600);
  await page.click('#plannertool_sofa_double');
  await page.waitForTimeout(600);
  console.log('active tool (furniture):', await page.evaluate(() => { const t: any = document.querySelector('.tools_item.active'); return t ? t.textContent.trim() : null; }));
  const sS = await toScreen(0, 60);
  await clearFog();
  await page.mouse.click(sS.x, sS.y);
  await page.waitForTimeout(900);
  console.log('items:', await page.evaluate(() => Object.values((window as any).ITEMS).map((i: any) => ({ name: i.props.name, angle: i.props.angle, pc: [Math.round(i.props.pc.x), Math.round(i.props.pc.y)], w: i.props.width, h: i.props.height, id_room: i.props.id_room, over_floor: i.props.over_floor }))));
  // имя помещения
  await page.click('.groups_navi_item.plan_rooms');
  await page.waitForTimeout(900);
  const sR = await toScreen(0, 0);
  await clearFog();
  await page.mouse.click(sR.x, sR.y);
  await page.waitForTimeout(900);
  const inputs = await page.evaluate(() => [...document.querySelectorAll('input, textarea')].filter((e: any) => e.offsetParent !== null).map((e: any) => ({ tag: e.tagName, id: e.id, cls: String(e.className).slice(0, 40), val: String(e.value).slice(0, 30), ph: e.placeholder })));
  console.log('inputs после клика по маркеру:', JSON.stringify(inputs, null, 1));
  await page.screenshot({ path: 'screenshots/dbg-roomname.png' });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
