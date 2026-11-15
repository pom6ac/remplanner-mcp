import { chromium } from 'playwright-core';
const BASE = 'https://remplanner.ru';
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/planner/', { waitUntil: 'domcontentloaded' });
  await Promise.all([page.waitForNavigation({ timeout: 60000 }).catch(() => null), page.evaluate(() => (window as any).planner_create_object())]);
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null as any, { timeout: 60000 });
  const fogGone = await page.waitForFunction(() => !document.querySelector('#planner_ui_message_fog.active'), null as any, { timeout: 30000 }).then(() => true).catch(() => false);
  console.log('fog gone:', fogGone);
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => {
    const el = document.elementFromPoint(600, 389);
    const t: any = document.querySelector('.tools_item.active');
    const svg: any = document.querySelector('#main_svg');
    const r = svg.getBoundingClientRect();
    return { hit: el ? el.tagName + '#' + el.id + '.' + String(el.className.baseVal ?? el.className).slice(0, 50) : null, tool: t ? t.textContent.trim() : null, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, vb: svg.getAttribute('viewBox') };
  });
  console.log(JSON.stringify(st));
  // первый отрезок
  await page.mouse.move(600, 389);
  await page.mouse.down();
  await page.mouse.move(1000, 389, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  console.log('walls after seg1:', await page.evaluate(() => Object.keys((window as any).WALLS).length));
  await page.screenshot({ path: 'screenshots/dbg2-seg1.png' });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
