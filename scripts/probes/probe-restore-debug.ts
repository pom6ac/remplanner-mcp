// Отладка $Project.restore: какие варианты модели он принимает.
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
  const raw = fixture.model;
  const ui = JSON.parse(await readFile('tests/fixtures/ui-one-wall.json', 'utf8'));

  const res = await page.evaluate(async ({ raw, ui }: any) => {
    const w: any = window as any;
    const out: any = {};
    // базовая модель сервера
    const oid = (document.body as any).dataset.objectId || (document.body as any).dataset.object_id;
    const pid = (document.body as any).dataset.plan_id || (document.body as any).dataset.planId;
    const r = await fetch('/setup/api/planner/?object_id=' + oid + '&plan_id=' + pid, { credentials: 'include' });
    const txt = await r.text();
    out.fetchStatus = r.status;
    out.fetchHead = txt.slice(0, 200);
    const base = JSON.parse(txt);
    out.baseKeys = Object.keys(base);
    out.baseWalls = JSON.stringify(base.walls);

    const tryRestore = (name: string, model: any) => {
      try { w.$Project.restore(JSON.parse(JSON.stringify(model))); out[name] = 'ok, walls=' + Object.keys(w.WALLS).length; }
      catch (e: any) { out[name] = 'ERR: ' + e.message + ' @ ' + String(e.stack).split('\n')[1]; }
    };
    tryRestore('A_base', base);
    // p1/p2 с role/demount/bak
    const uiform = JSON.parse(JSON.stringify(raw));
    for (const id of Object.keys(uiform.walls)) {
      const wl = uiform.walls[id];
      for (const p of ['p1', 'p2']) {
        wl[p] = Object.assign({ role: p, demount: 0, bak: { x: wl[p].x, y: wl[p].y } }, wl[p]);
      }
    }
    tryRestore('B_uiform_points', uiform);
    // полная модель UI-формата: все коллекции из ui-one-wall + наши стены
    const full = JSON.parse(JSON.stringify(ui.model));
    full.walls = uiform.walls;
    full.items = {};
    full.id = '0'; full.plan_id = '0';
    tryRestore('C_full_ui_shape', full);
    // эталон UI-модели как есть
    tryRestore('D_ui_fixture', ui.model);
    return out;
  }, { raw, ui });
  console.log(JSON.stringify(res, null, 2));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
