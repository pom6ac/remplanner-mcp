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
  await page.evaluate(() => { const f: any = document.querySelector('#planner_ui_message_fog'); if (f.classList.contains('active') && !f.innerHTML.trim()) f.classList.remove('active'); });
  const findDoorEls = () => page.evaluate(() => {
    const els = [...document.querySelectorAll('*')].filter((e: any) => e.children.length === 0 && /Дверь стандартная|Проем без двери/i.test(e.textContent || ''));
    return els.map((e: any) => ({ tag: e.tagName, id: e.id, cls: String(e.className.baseVal ?? e.className).slice(0, 70), vis: !!e.offsetParent, parentCls: e.parentElement ? String(e.parentElement.className.baseVal ?? e.parentElement.className).slice(0, 50) : '', parentVis: e.parentElement ? !!e.parentElement.offsetParent : false }));
  });
  console.log('до клика:', JSON.stringify(await findDoorEls()));
  await page.click('.tools_item.toolid8');
  await page.waitForTimeout(800);
  console.log('после клика:', JSON.stringify(await findDoorEls()));
  // также list all elements with id plannertool_*
  const pt = await page.evaluate(() => [...document.querySelectorAll('[id^="plannertool"]')].map((e: any) => ({ id: e.id, vis: !!e.offsetParent, text: (e.textContent || '').trim().slice(0, 30) })));
  console.log('plannertool*:', JSON.stringify(pt, null, 1));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
