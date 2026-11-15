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
  await page.addStyleTag({ content: '#planner_ui_message_fog:empty{display:none !important}' });
  const toScreen = async (px: number, py: number) => page.evaluate(([x, y]: any) => {
    const svg: any = document.querySelector('#main_svg'); const r = svg.getBoundingClientRect();
    const p = svg.getAttribute('viewBox').trim().split(/[\s,]+/).map(Number);
    return { x: r.x + ((x - p[0]) * r.width) / p[2], y: r.y + ((y - p[1]) * r.height) / p[3] };
  }, [px, py]);
  const pts = { A: [-200, -150], B: [200, -150], C: [200, 150], D: [-200, 150] };
  for (const [p, q] of [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A']] as const) {
    const s1 = await toScreen(pts[p][0], pts[p][1]), s2 = await toScreen(pts[q][0], pts[q][1]);
    await page.mouse.move(s1.x, s1.y); await page.mouse.down(); await page.mouse.move(s2.x, s2.y, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(300);
  }
  await page.click('.groups_navi_item.plan_rooms');
  await page.waitForTimeout(1000);
  // список видимых элементов контекстных меню
  const cmInfo = await page.evaluate(() => [...document.querySelectorAll('[id^="cm-"], [class*="context_menu"], [class*="cm-"]')].slice(0, 30).map((e: any) => ({ id: e.id, cls: String(e.className).slice(0, 60), vis: !!e.offsetParent, tag: e.tagName })));
  console.log('cm-элементы до клика:', JSON.stringify(cmInfo.slice(0, 15), null, 1));
  const rpc = await page.evaluate(() => { const r: any = Object.values((window as any).ROOMS2)[0]; return r ? [r.pc.x, r.pc.y] : [0, 0]; });
  const s = await toScreen(rpc[0], rpc[1]);
  await page.mouse.click(s.x, s.y, { button: 'right' });
  await page.waitForTimeout(1000);
  const cmInfo2 = await page.evaluate(() => [...document.querySelectorAll('[id^="cm-room"], [id^="cm"]')].slice(0, 40).map((e: any) => ({ id: e.id, tag: e.tagName, vis: !!e.offsetParent, type: e.type || '', cls: String(e.className).slice(0, 40) })));
  console.log('cm-элементы после клика:', JSON.stringify(cmInfo2, null, 1));
  // input name: путь до видимого контейнера
  const path = await page.evaluate(() => {
    const i: any = document.querySelector('input[id$="-zone-name"]');
    if (!i) return null;
    const chain: any[] = [];
    let cur: any = i;
    while (cur && cur !== document.body) { chain.push({ tag: cur.tagName, id: cur.id, cls: String(cur.className).slice(0, 50), vis: !!cur.offsetParent, disp: getComputedStyle(cur).display }); cur = cur.parentElement; }
    return chain;
  });
  console.log('путь input zone-name:', JSON.stringify(path, null, 1));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
