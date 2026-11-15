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
  // нарисовать комнату быстро (как в refs)
  await page.evaluate(() => { const f: any = document.querySelector('#planner_ui_message_fog'); if (f.classList.contains('active') && !f.innerHTML.trim()) f.classList.remove('active'); });
  const toScreen = async (px: number, py: number) => page.evaluate(([x, y]: any) => {
    const svg: any = document.querySelector('#main_svg');
    const r = svg.getBoundingClientRect();
    const p = svg.getAttribute('viewBox').trim().split(/[\s,]+/).map(Number);
    return { x: r.x + ((x - p[0]) * r.width) / p[2], y: r.y + ((y - p[1]) * r.height) / p[3] };
  }, [px, py]);
  const pts = { A: [-200, -150], B: [200, -150], C: [200, 150], D: [-200, 150] };
  for (const [p, q] of [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A']] as const) {
    const s1 = await toScreen(pts[p][0], pts[p][1]), s2 = await toScreen(pts[q][0], pts[q][1]);
    await page.mouse.move(s1.x, s1.y); await page.mouse.down(); await page.mouse.move(s2.x, s2.y, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(300);
  }
  console.log('walls:', await page.evaluate(() => Object.keys((window as any).WALLS).length));
  // двери
  await page.click('.tools_item.toolid8');
  await page.waitForTimeout(700);
  const tools = await page.evaluate(() => [...document.querySelectorAll('.tools_item')].map((e: any) => ({
    cls: String(e.className.baseVal ?? e.className), text: (e.textContent || '').trim().slice(0, 40),
    visible: !!e.offsetParent, parent: e.parentElement ? (e.parentElement.className + '').slice(0, 40) : '',
  })));
  console.log('ВСЕ tools_item после клика «Двери и проемы»:');
  for (const t of tools.filter((t) => /door/i.test(t.cls))) console.log(JSON.stringify(t));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
