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
  const info = await page.evaluate(() => {
    const svg: any = document.querySelector('#canvas_v2_wrapper svg');
    const gs = svg ? [...svg.querySelectorAll('g')].slice(0, 5).map((g: any) => ({ tag: g.tagName, transform: g.getAttribute('transform') })) : [];
    const root = svg ? { viewBox: svg.getAttribute('viewBox'), style: svg.getAttribute('style'), id: svg.id, cls: svg.className.baseVal } : null;
    const btns = [...document.querySelectorAll('button, .pre_button, [class*="tool"], [class*="btn"], a, div[class*="panel"]')]
      .map((e: any) => ({ tag: e.tagName, cls: String(e.className.baseVal ?? e.className).slice(0, 60), id: e.id, title: e.title, text: (e.textContent || '').trim().slice(0, 40) }))
      .filter((b) => b.title || (b.text && b.text.length < 30)).slice(0, 80);
    const bodyData = { ...document.body.dataset };
    return { root, gs, btns, bodyData };
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
}
// Ревью 159 m5 (инцидент 158): main() — только при прямом запуске файла;
// импорт модуля не должен запускать живой сценарий.
if (process.argv[1]?.endsWith("probe-ui-explore.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

