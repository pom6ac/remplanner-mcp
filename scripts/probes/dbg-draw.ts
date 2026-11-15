import { chromium } from 'playwright-core';
const BASE = 'https://remplanner.ru';
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/planner/', { waitUntil: 'domcontentloaded' });
  await Promise.all([page.waitForNavigation({ timeout: 60000 }).catch(() => null), page.evaluate(() => (window as any).planner_create_object())]);
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null as any, { timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'screenshots/dbg-0-start.png' });
  const hit = await page.evaluate(() => {
    const el = document.elementFromPoint(400, 343); // примерно план (-200,-150) при viewBox -800,-413,1600x874 в 1600x1000
    return el ? { tag: el.tagName, id: el.id, cls: String(el.className.baseVal ?? el.className).slice(0, 80) } : null;
  });
  console.log('elementFromPoint(400,343):', JSON.stringify(hit));
  const svgBox = await page.evaluate(() => { const s: any = document.querySelector('#main_svg'); const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vb: s.getAttribute('viewBox') }; });
  console.log('svg box:', JSON.stringify(svgBox));
  // попытка: drag по документу
  await page.mouse.move(400, 343);
  await page.mouse.down();
  await page.mouse.move(700, 343, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'screenshots/dbg-1-after-drag.png' });
  console.log('walls:', await page.evaluate(() => Object.keys((window as any).WALLS).length));
  console.log('tool:', await page.evaluate(() => { const t: any = document.querySelector('.tools_item.active'); return t ? t.textContent : null; }));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
