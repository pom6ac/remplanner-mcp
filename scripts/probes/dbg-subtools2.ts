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
  const info = await page.evaluate(() => {
    const subs = [...document.querySelectorAll('[class*="subtool"], .submenu, [class*="sub_menu"], [class*="subitems"]')]
      .map((e: any) => ({ cls: String(e.className.baseVal ?? e.className).slice(0, 80), visible: !!e.offsetParent, html: e.innerHTML.slice(0, 400) }));
    // элементы, ставшие видимыми рядом с панелью инструментов
    const panel: any = document.querySelector('.tools_item.toolid8');
    const panelParent = panel ? panel.parentElement : null;
    const siblings = panelParent ? [...panelParent.children].map((c: any) => ({ cls: String(c.className).slice(0, 60), text: (c.textContent || '').trim().slice(0, 30), vis: !!c.offsetParent })) : [];
    return { subs, siblings: siblings.slice(0, 30) };
  });
  console.log(JSON.stringify(info, null, 1).slice(0, 3000));
  await page.screenshot({ path: 'screenshots/dbg-door-menu.png' });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
