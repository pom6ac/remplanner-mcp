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
  await page.click('.groups_navi_item.plan_furniture');
  await page.waitForTimeout(800);
  await page.click('.tools_item.toolid83');
  await page.waitForTimeout(500);
  await page.getByText('Диваны', { exact: true }).first().click();
  await page.waitForTimeout(700);
  await page.click('#plannertool_sofa_double');
  await page.waitForTimeout(700);
  const s = await toScreen(0, 60);
  const probe = await page.evaluate(([x, y]: any) => {
    const el = document.elementFromPoint(x, y);
    const f: any = document.querySelector('#planner_ui_message_fog');
    const chain: any[] = [];
    let cur: any = el;
    while (cur && chain.length < 4) { chain.push(cur.tagName + '#' + cur.id + '.' + String(cur.className.baseVal ?? cur.className).slice(0, 40)); cur = cur.parentElement; }
    return { chain, fog: f ? { cls: f.className, html: f.innerHTML.slice(0, 120), disp: getComputedStyle(f).display } : null };
  }, [s.x, s.y]);
  console.log('probe:', JSON.stringify(probe, null, 1));
  await page.mouse.click(s.x, s.y);
  await page.waitForTimeout(1000);
  console.log('items:', await page.evaluate(() => Object.keys((window as any).ITEMS).length));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
