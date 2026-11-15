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
  const fogState = () => page.evaluate(() => ({ fog: document.querySelector('#planner_ui_message_fog').className, html: document.querySelector('#planner_ui_message_fog').innerHTML.slice(0, 200) }));
  console.log('fog before:', JSON.stringify(await fogState()));
  // click в центр фога чтобы снять
  await page.mouse.click(800, 500);
  await page.waitForTimeout(500);
  console.log('fog after click:', JSON.stringify(await fogState()));
  console.log('hit:', JSON.stringify(await page.evaluate(() => { const el = document.elementFromPoint(600, 389); return el ? el.tagName + '#' + el.id : null; })));
  await page.mouse.move(600, 389); await page.mouse.down(); await page.mouse.move(1000, 389, { steps: 14 }); await page.mouse.up();
  await page.waitForTimeout(700);
  console.log('walls:', await page.evaluate(() => Object.keys((window as any).WALLS).length));
  console.log('fog после drag:', JSON.stringify(await fogState()));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
