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
  await page.click('.tools_item.toolid8');
  await page.waitForTimeout(800);
  const res = await page.evaluate(() => {
    // элементы каталога дверей: global_tools двери на текущем листе отображаются в панели
    const w: any = window as any;
    const doors = Object.values(w.global_tools).filter((t: any) => t.group === 'doors').map((t: any) => ({ id: t.id, title: t.title, toolid: t.tool_id || t.plan }));
    // панель каталога: найдём видимые элементы с data-атрибутами
    const catalogItems = [...document.querySelectorAll('[data-tool_id], [data-toolid], [data-name]')].filter((e: any) => e.offsetParent !== null)
      .map((e: any) => ({ tag: e.tagName, attrs: { ...e.dataset }, text: (e.textContent || '').trim().slice(0, 30) })).slice(0, 40);
    return { doors, catalogItems };
  });
  console.log('global_tools doors:', JSON.stringify(res.doors, null, 1));
  console.log('catalog items:', JSON.stringify(res.catalogItems, null, 1).slice(0, 2000));
  await page.screenshot({ path: 'screenshots/dbg-door-menu2.png' });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
