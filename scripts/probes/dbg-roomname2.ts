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
  const menuVis = () => page.evaluate(() => { const m: any = document.querySelector('[id^="cm-room"]'); const i: any = document.querySelector('input[id$="-zone-name"]'); return { menu: m ? getComputedStyle(m).display : null, input: i ? !!i.offsetParent : false, id: m ? m.id : null }; });
  const s0 = await toScreen(0, 0);
  await page.mouse.click(s0.x, s0.y);
  await page.waitForTimeout(900);
  console.log('левый клик (0,0):', JSON.stringify(await menuVis()));
  await page.mouse.click(s0.x, s0.y, { button: 'right' });
  await page.waitForTimeout(900);
  console.log('правый клик (0,0):', JSON.stringify(await menuVis()));
  await page.mouse.dblclick(s0.x, s0.y);
  await page.waitForTimeout(900);
  console.log('двойной клик (0,0):', JSON.stringify(await menuVis()));
  if (await page.evaluate(() => { const i: any = document.querySelector('input[id$="-zone-name"]'); return i && !!i.offsetParent; })) {
    await page.fill('input[id$="-zone-name"]', 'Гостиная');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    console.log('rooms2 после ввода имени:', await page.evaluate(() => JSON.stringify(Object.values((window as any).ROOMS2).map((r: any) => ({ name: r.name, area: r.area })))));
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
