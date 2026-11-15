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
  // диван: варианты клика
  await page.click('.groups_navi_item.plan_furniture');
  await page.waitForTimeout(800);
  await page.click('.tools_item.toolid83');
  await page.waitForTimeout(500);
  await page.getByText('Диваны', { exact: true }).first().click();
  await page.waitForTimeout(700);
  const sub = await page.evaluate(() => { const e: any = document.querySelector('#plannertool_sofa_double'); return e ? { cls: e.className, vis: !!e.offsetParent } : null; });
  console.log('sofa_double:', JSON.stringify(sub));
  await page.click('#plannertool_sofa_double');
  await page.waitForTimeout(700);
  const sS = await toScreen(0, 60);
  await clearFog();
  await page.mouse.move(sS.x, sS.y);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(1000);
  console.log('items try1:', await page.evaluate(() => Object.keys((window as any).ITEMS).length));
  if (!await page.evaluate(() => Object.keys((window as any).ITEMS).length)) {
    // второй вариант: клик по центру комнаты
    const sC = await toScreen(0, 0);
    await page.mouse.click(sC.x, sC.y);
    await page.waitForTimeout(1000);
    console.log('items try2:', await page.evaluate(() => Object.keys((window as any).ITEMS).length));
  }
  // rooms sheet: список видимых инструментов и элементы SVG в центре
  await page.click('.groups_navi_item.plan_rooms');
  await page.waitForTimeout(900);
  console.log('rooms tools:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.tools_item')].filter((e: any) => e.offsetParent !== null).map((e: any) => ({ id: e.id, text: (e.textContent || '').trim().slice(0, 35) })))));
  const sR = await toScreen(0, 0);
  const svgAt = await page.evaluate(([x, y]: any) => {
    const el = document.elementFromPoint(x, y);
    const chain: any[] = [];
    let cur: any = el;
    while (cur && chain.length < 5) { chain.push({ tag: cur.tagName, id: cur.id, cls: String(cur.className.baseVal ?? cur.className).slice(0, 50) }); cur = cur.parentElement; }
    return chain;
  }, [sR.x, sR.y]);
  console.log('элементы в точке маркера:', JSON.stringify(svgAt, null, 1));
  await page.mouse.click(sR.x, sR.y);
  await page.waitForTimeout(900);
  console.log('inputs:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('input, textarea')].filter((e: any) => e.offsetParent !== null).map((e: any) => ({ id: e.id, cls: String(e.className).slice(0, 40), val: String(e.value).slice(0, 20) })))));
  console.log('rooms2 name:', await page.evaluate(() => JSON.stringify((window as any).__snap((window as any).ROOMS2))));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
