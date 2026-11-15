import { chromium } from 'playwright-core';
const BASE = 'https://remplanner.ru';
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/planner/', { waitUntil: 'domcontentloaded' });
  await Promise.all([page.waitForNavigation({ timeout: 60000 }).catch(() => null), page.evaluate(() => (window as any).planner_create_object())]);
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null as any, { timeout: 60000 });
  for (let t = 1; t <= 6; t++) {
    await page.waitForTimeout(2000);
    const st = await page.evaluate(() => {
      const f: any = document.querySelector('#planner_ui_message_fog');
      const cs = getComputedStyle(f);
      return { cls: f.className, pe: cs.pointerEvents, z: cs.zIndex, disp: cs.display, op: cs.opacity, parentCls: f.parentElement ? f.parentElement.className : '' };
    });
    console.log('t+' + t * 2 + 's', JSON.stringify(st));
  }
  // кликнуть по фогу
  await page.mouse.click(800, 500);
  await page.waitForTimeout(1000);
  console.log('после клика:', await page.evaluate(() => document.querySelector('#planner_ui_message_fog').className));
  // попробовать drag
  await page.mouse.move(400, 500); await page.mouse.down(); await page.mouse.move(700, 500, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(800);
  console.log('walls:', await page.evaluate(() => Object.keys((window as any).WALLS).length));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
