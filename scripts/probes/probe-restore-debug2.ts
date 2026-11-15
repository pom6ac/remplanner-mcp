// Отладка 2: что именно в нашей стене ломает restore (метод исключений от работающего эталона D).
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';

const BASE = 'https://remplanner.ru';

async function main() {
  const shell = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
  const browser = await chromium.launch({ executablePath: shell, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/planner/', { waitUntil: 'domcontentloaded' });
  await Promise.all([
    page.waitForNavigation({ timeout: 60000 }).catch(() => null),
    page.evaluate(() => (window as any).planner_create_object()),
  ]);
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null as any, { timeout: 60000 });
  await page.waitForTimeout(2000);

  const fixture = JSON.parse(await readFile('tests/fixtures/anon-rect-4000x3000.json', 'utf8'));
  const ui = JSON.parse(await readFile('tests/fixtures/ui-one-wall.json', 'utf8'));
  const raw: any = JSON.parse(JSON.stringify(fixture.model));
  const uim: any = JSON.parse(JSON.stringify(ui.model));

  const tryRestore = async (name: string, model: any) => {
    try {
      const r = await page.evaluate((m: any) => {
        const w: any = window as any;
        try { w.$Project.restore(m); return 'ok, walls=' + Object.keys(w.WALLS).length; }
        catch (e: any) { return 'ERR: ' + e.message; }
      }, model);
      console.log(name, '->', r);
    } catch (e: any) {
      console.log(name, '-> PAGE-ERR:', e.message.split('\n')[0]);
    }
  };

  const noLink = JSON.parse(JSON.stringify(raw));
  for (const id of Object.keys(noLink.walls)) { delete noLink.walls[id].p1.link; delete noLink.walls[id].p2.link; }
  const bare = JSON.parse(JSON.stringify(noLink));
  for (const id of Object.keys(bare.walls)) bare.walls[id].holes = {};

  await tryRestore('1_no_links', noLink);
  await tryRestore('2_no_holes', JSON.parse(JSON.stringify(Object.assign({}, raw, { walls: Object.fromEntries(Object.entries(raw.walls).map(([k, v]: any) => [k, { ...v, holes: {} }])) }))));
  await tryRestore('3_bare', bare);
  await tryRestore('4_ui_plus_link', (() => { const m = JSON.parse(JSON.stringify(uim)); m.walls._kh76n.p2.link = { ct: 'node', ot: 'wall', id: '_kh76n', z0: 'p1', z1: 'p2' }; return m; })());
  await tryRestore('5_ui_bare', (() => { const m = JSON.parse(JSON.stringify(uim)); const wl = m.walls._kh76n; for (const k of ['l1','l2','r1','r2','l1f','l2f','r1f','r2f','angle','area','eds2','neighbors','inRoom','room_on_left','room_on_right']) delete wl[k]; return m; })());
  for (const keep of Object.keys(bare.walls)) {
    const one = JSON.parse(JSON.stringify(bare));
    one.walls = { [keep]: bare.walls[keep] };
    await tryRestore('6_one_' + keep, one);
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
