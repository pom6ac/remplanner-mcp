import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
const BASE = 'https://remplanner.ru';
async function main() {
  const shell = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
  const browser = await chromium.launch({ executablePath: shell, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/planner/', { waitUntil: 'domcontentloaded' });
  await Promise.all([page.waitForNavigation({ timeout: 60000 }).catch(() => null), page.evaluate(() => (window as any).planner_create_object())]);
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null as any, { timeout: 60000 });
  await page.waitForTimeout(2000);
  const uim: any = JSON.parse(JSON.stringify(await readFile('tests/fixtures/ui-one-wall.json', 'utf8').then(JSON.parse))).model;
  const raw: any = JSON.parse(JSON.stringify(await readFile('tests/fixtures/anon-rect-4000x3000.json', 'utf8').then(JSON.parse))).model;

  const tryRestore = async (name: string, model: any) => {
    try {
      const r = await page.evaluate((m: any) => {
        const w: any = window as any;
        try { w.$Project.restore(m); return 'ok, walls=' + Object.keys(w.WALLS).length; }
        catch (e: any) { return 'ERR: ' + e.message; }
      }, model);
      console.log(name, '->', r);
    } catch (e: any) { console.log(name, '-> PAGE-ERR:', e.message.split('\n')[0]); }
  };

  const FIELDS = ['l1','l2','r1','r2','l1f','l2f','r1f','r2f','angle','area','eds2','neighbors','inRoom','room_on_left','room_on_right'];
  // удалять по одному: если с удалением одного поля падает — поле обязательно
  for (const f of FIELDS) {
    const c = JSON.parse(JSON.stringify(uim));
    delete c.walls._kh76n[f];
    await tryRestore('del_' + f, c);
  }
  // наша стена с добавленными l1/l2/r1/r2 по минимальному правилу (l = p + (0,-depth/2))
  const withFaces = JSON.parse(JSON.stringify(raw));
  for (const id of Object.keys(withFaces.walls)) {
    const w = withFaces.walls[id];
    delete w.p1.link; delete w.p2.link;
    const d = w.depth / 2;
    for (const [ln, pn] of [['l1','p1'],['l2','p2'],['r1','p1'],['r2','p2']]) {
      const sgn = ln[0] === 'l' ? -1 : 1;
      w[ln] = { x: w[pn].x, y: w[pn].y + sgn * d };
      w[ln + 'f'] = { x: w[pn].x, y: w[pn].y + sgn * d };
    }
    w.angle = 0;
  }
  await tryRestore('14_our_with_faces', withFaces);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
