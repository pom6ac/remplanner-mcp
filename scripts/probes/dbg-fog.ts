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
  const fog = await page.evaluate(() => {
    const f: any = document.querySelector('#planner_ui_message_fog');
    return { cls: f.className, html: f.innerHTML.slice(0, 1500), style: f.getAttribute('style') };
  });
  console.log(JSON.stringify(fog, null, 1));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
