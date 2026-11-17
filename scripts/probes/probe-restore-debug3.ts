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
  const fixture = JSON.parse(await readFile('tests/fixtures/anon-rect-4000x3000.json', 'utf8'));
  const raw: any = JSON.parse(JSON.stringify(fixture.model));
  const uim: any = JSON.parse(JSON.stringify(await readFile('tests/fixtures/ui-one-wall.json', 'utf8').then(JSON.parse))).model;

  const tryRestore = async (name: string, model: any) => {
    try {
      const r = await page.evaluate((m: any) => {
        const w: any = window as any;
        try { w.$Project.restore(m); return 'ok, walls=' + Object.keys(w.WALLS).length + ' holes=' + Object.values(w.WALLS).reduce((a: number, x: any) => a + Object.keys(x.holes || {}).length, 0); }
        catch (e: any) { return 'ERR: ' + e.message; }
      }, model);
      console.log(name, '->', r);
    } catch (e: any) { console.log(name, '-> PAGE-ERR:', e.message.split('\n')[0]); }
  };

  const addBak = (m: any) => { const c = JSON.parse(JSON.stringify(m)); for (const id of Object.keys(c.walls)) for (const p of ['p1','p2']) { const pt = c.walls[id][p]; pt.bak = { x: pt.x, y: pt.y }; pt.role = p; pt.demount = 0; } return c; };
  const strip = (m: any, fields: string[]) => { const c = JSON.parse(JSON.stringify(m)); for (const id of Object.keys(c.walls)) for (const f of fields) delete c.walls[id][f]; return c; };

  await tryRestore('7_bare_plus_bak', addBak((() => { const c = JSON.parse(JSON.stringify(raw)); for (const id of Object.keys(c.walls)) { delete c.walls[id].p1.link; delete c.walls[id].p2.link; c.walls[id].holes = {}; } return c; })()));
  await tryRestore('8_full_raw_plus_bak', addBak(raw));
  await tryRestore('9_uibare_no_bak', strip(uim, ['bak']));
  await tryRestore('10_uibare_no_role', (() => { const c = JSON.parse(JSON.stringify(uim)); for (const id of Object.keys(c.walls)) { delete c.walls[id].p1.role; delete c.walls[id].p2.role; } return c; })());
  await tryRestore('11_uibare_no_demount', (() => { const c = JSON.parse(JSON.stringify(uim)); for (const id of Object.keys(c.walls)) { delete c.walls[id].p1.demount; delete c.walls[id].p2.demount; } return c; })());
  await tryRestore('12_bare_plus_bak_only', (() => { const c = JSON.parse(JSON.stringify(raw)); for (const id of Object.keys(c.walls)) { delete c.walls[id].p1.link; delete c.walls[id].p2.link; c.walls[id].holes = {}; for (const p of ['p1','p2']) { c.walls[id][p].bak = { x: c.walls[id][p].x, y: c.walls[id][p].y }; } } return c; })());
  await tryRestore('13_bare_bak_no_link_keep_holes', (() => { const c = JSON.parse(JSON.stringify(raw)); for (const id of Object.keys(c.walls)) { delete c.walls[id].p1.link; delete c.walls[id].p2.link; for (const p of ['p1','p2']) c.walls[id][p].bak = { x: c.walls[id][p].x, y: c.walls[id][p].y }; } return c; })());
  await browser.close();
}
// Ревью 159 m5 (инцидент 158): main() — только при прямом запуске файла;
// импорт модуля не должен запускать живой сценарий.
if (process.argv[1]?.endsWith("probe-restore-debug3.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

