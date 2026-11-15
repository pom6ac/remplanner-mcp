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
  // ищем SVG-элементы маркера: тексты с м² и их bbox
  const markers = await page.evaluate(() => {
    const out: any[] = [];
    for (const t of document.querySelectorAll('#main_svg text, #main_svg div, #main_svg foreignObject')) {
      const txt = (t.textContent || '').trim();
      if (/м²|м2/.test(txt) && txt.length < 30) {
        const b: any = t.getBoundingClientRect();
        out.push({ txt, x: b.x + b.width / 2, y: b.y + b.height / 2, tag: t.tagName, cls: String(t.className.baseVal ?? t.className).slice(0, 40) });
      }
    }
    return out;
  });
  console.log('маркеры площади:', JSON.stringify(markers, null, 1));
  const m = markers[0];
  if (m) {
    for (const kind of ['click', 'dblclick', 'rclick'] as const) {
      if (kind === 'click') await page.mouse.click(m.x, m.y);
      else if (kind === 'dblclick') await page.mouse.dblclick(m.x, m.y);
      else await page.mouse.click(m.x, m.y, { button: 'right' });
      await page.waitForTimeout(900);
      const vis = await page.evaluate(() => { const i: any = document.querySelector('input[id$="-zone-name"]'); return i ? !!i.offsetParent : false; });
      console.log(kind, '→ input visible:', vis);
      if (vis) {
        await page.fill('input[id$="-zone-name"]', 'Гостиная');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(800);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        console.log('rooms2 после ввода:', await page.evaluate(() => JSON.stringify(Object.values((window as any).ROOMS2).map((r: any) => ({ name: r.name, area: r.area })))));
        break;
      }
    }
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
