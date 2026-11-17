// T1 refs: эталоны UI мышью — комната, дверь, окно, диван, имя помещения. Headed Chrome.
// Запуск: node scripts/probe-normalize.ts refs
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { anonymizeEditorIds, anonymizeProjectIds, writeFixture } from './anonymize.ts';

const BASE = 'https://remplanner.ru';

async function snapSrc() {
  return `(function(){function snap(v,d){d=d||0;if(v===null||typeof v!=='object')return typeof v==='function'?'[fn]':v;if(d>6)return '[deep]';if(Array.isArray(v))return v.map(function(x){return snap(x,d+1);});var o={};var ks;try{ks=Object.keys(v);}catch(e){return '[err]';}for(var i=0;i<ks.length;i++){try{o[ks[i]]=snap(v[ks[i]],d+1);}catch(e){o[ks[i]]='[err]';}}return o;}window.__snap=snap;})()`;
}
async function injectSnap(page: Page) { await page.evaluate(await snapSrc()); }

// Кликает по точкам, пока условие не выполнится (или точки кончатся).
async function clickUntil(page: Page, ok: () => Promise<boolean>, pts: ReadonlyArray<readonly [number, number]>, label = '') {
  for (const pt of pts) {
    await clearFog(page);
    const s = await toScreen(page, pt[0], pt[1]);
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(900);
    const done = await ok();
    const tool = await page.evaluate(() => { const t: any = document.querySelector('.tools_item.active'); return t ? t.textContent.trim().slice(0, 25) : null; });
    console.log(`клик ${label} ${JSON.stringify(pt)} ok=${done} tool="${tool}"`);
    if (done) return;
  }
}

async function holesCount(page: Page) {
  return page.evaluate(() => {
    let n = 0;
    for (const w of Object.values((window as any).WALLS) as any[]) n += Object.keys(w.holes || {}).length;
    return n;
  });
}

// Экранные координаты точки плана через viewBox
async function toScreen(page: Page, px: number, py: number) {
  const v = await page.evaluate(() => {
    const svg: any = document.querySelector('#main_svg');
    const r = svg.getBoundingClientRect();
    const p = svg.getAttribute('viewBox').trim().split(/[\s,]+/).map(Number);
    return { rx: r.x, ry: r.y, rw: r.width, rh: r.height, mx: p[0], my: p[1], vw: p[2], vh: p[3] };
  });
  return { x: v.rx + ((px - v.mx) * v.rw) / v.vw, y: v.ry + ((py - v.my) * v.rh) / v.vh };
}

async function dumpState(page: Page, name: string) {
  const d = await page.evaluate(() => {
    const w: any = window as any;
    return {
      walls: w.__snap(w.WALLS),
      items: w.__snap(w.ITEMS),
      rooms2: w.__snap(w.ROOMS2),
      rooms1: w.__snap(w.ROOMS1),
      copy: w.__snap(w.project.copy('server')),
    };
  });
  // Аудит 65 A2: в эталон идёт только серверная модель copy, сразу в обезличенном
  // виде (общая санитизация scripts/anonymize.ts) и с _source. Runtime-дампы
  // walls/items/rooms1/rooms2 тесты не проверяют — в файл не пишутся.
  const { data } = anonymizeEditorIds(d.copy);
  await writeFixture(
    `tests/fixtures/ui-ref-${name}.json`,
    { copy: anonymizeProjectIds(data as Record<string, unknown>) },
    `Серверная модель project.copy("server") анонимного проекта remplanner.ru (создан кнопкой «Нарисовать чертежи своими руками» в чистом browser context, аккаунт не использовался), сценарий ${name} — scripts/probe-normalize.ts (режим refs), снято ${new Date().toISOString().slice(0, 10)}. ID проекта/плана и внутренние ID стен, комнат, проёмов, предметов заменены на синтетические детерминированно (scripts/anonymize.ts).`,
  );
  await page.screenshot({ path: `screenshots/t1-ref-${name}.png` });
  console.log('эталон', name, ': walls=', Object.keys(d.walls).length, 'items=', Object.keys(d.items).length, 'rooms2=', Object.keys(d.rooms2).length, '(copy обезличен)');
}

async function toolsList(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.tools_item')]
      .filter((e: any) => e.offsetParent !== null)
      .map((e: any) => ({ id: e.id, cls: String(e.className.baseVal ?? e.className).slice(0, 80), text: (e.textContent || '').trim().slice(0, 40) })),
  );
}

// Пустой startup-фог (#planner_ui_message_fog.active) иногда остаётся активным и глотает мышь; снимаем принудительно.
// Плюс обучающие попапы .planner_ui_message (подсказки «нарисуйте стену» и т.п.) перекрывают холст — снимаем.
async function clearFog(page: Page) {
  await page.evaluate(() => {
    const f: any = document.querySelector('#planner_ui_message_fog');
    if (f && f.classList.contains('active') && !f.innerHTML.trim()) f.classList.remove('active');
    document.querySelectorAll('.planner_ui_message.active').forEach((e: any) => e.classList.remove('active'));
  });
  await page.waitForTimeout(150);
}

async function main() {
  await mkdir('screenshots', { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/planner/', { waitUntil: 'domcontentloaded' });
  await Promise.all([page.waitForNavigation({ timeout: 60000 }).catch(() => null), page.evaluate(() => (window as any).planner_create_object())]);
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null as any, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#planner_ui_message_fog.active'), null as any, { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(2000);
  // пустой startup-фог непредсказуемо возвращается и глотает клики — прячет его на время прогона
  await page.addStyleTag({ content: '#planner_ui_message_fog:empty{display:none !important}' });
  await injectSnap(page);

  // --- комната 400x300 по оси четырьмя стенами (инструмент «Стена» активен по умолчанию) ---
  await clearFog(page);
  const A = { x: -200, y: -150 }, B = { x: 200, y: -150 }, C = { x: 200, y: 150 }, D = { x: -200, y: 150 };
  for (const [p, q] of [[A, B], [B, C], [C, D], [D, A]] as const) {
    const s1 = await toScreen(page, p.x, p.y), s2 = await toScreen(page, q.x, q.y);
    await page.mouse.move(s1.x, s1.y);
    await page.mouse.down();
    await page.mouse.move(s2.x, s2.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(800);
  await dumpState(page, 'room');
  console.log('walls angles:', await page.evaluate(() => Object.values((window as any).WALLS).map((w: any) => ({ a: Math.round(w.angle), p1: [Math.round(w.p1.x), Math.round(w.p1.y)], p2: [Math.round(w.p2.x), Math.round(w.p2.y)] }))));

  // --- дверь: «Двери и проемы» → subtool «Дверь стандартная» (#plannertool_door) → клик по нижней стене ---
  await page.click('.tools_item.toolid8');
  await page.waitForTimeout(500);
  await page.click('#plannertool_door');
  await page.waitForTimeout(400);
  await clickUntil(page, async () => (await holesCount(page)) > 0, [[0, 150], [0, 150], [-100, 150]], 'дверь');
  await dumpState(page, 'door');

  // --- окно: «Окна» → #plannertool_window → клик по верхней стене ---
  await page.click('.tools_item.toolid14');
  await page.waitForTimeout(500);
  console.log('window subtools:', JSON.stringify((await page.evaluate(() => [...document.querySelectorAll('.subtools_item')].filter((e: any) => e.offsetParent !== null).map((e: any) => ({ id: e.id, text: (e.textContent || '').trim().slice(0, 30) }))))));
  await page.click('#plannertool_window');
  await page.waitForTimeout(400);
  await clickUntil(page, async () => (await holesCount(page)) > 1, [[0, -150], [0, -150], [-100, -150]], 'окно');
  await dumpState(page, 'window');

  // --- диван: лист «Мебель» → «Гостиная и спальня» → subtool «Диван» → клик в комнате ---
  await clearFog(page);
  await page.click('.groups_navi_item.plan_furniture');
  await page.waitForTimeout(800);
  await page.click('.tools_item.toolid83'); // «Гостиная и спальня»
  await page.waitForTimeout(600);
  const ft = await page.evaluate(() => [...document.querySelectorAll('.subtools_item')].filter((e: any) => e.offsetParent !== null)
    .map((e: any) => ({ id: e.id, text: (e.textContent || '').trim().slice(0, 40) })));
  console.log('furniture subtools (первые 15):', JSON.stringify(ft.slice(0, 15)));
  // подгруппа «Диваны», затем конкретный диван
  await page.getByText('Диваны', { exact: true }).first().click();
  await page.waitForTimeout(600);
  const ft2 = await page.evaluate(() => [...document.querySelectorAll('.subtools_item')].filter((e: any) => e.offsetParent !== null)
    .map((e: any) => ({ id: e.id, text: (e.textContent || '').trim().slice(0, 40) })));
  console.log('после «Диваны»:', JSON.stringify(ft2.slice(0, 15)));
  const sofa = ft2.find((t) => t.id && /диван/i.test(t.text) && !/угл|модуль/i.test(t.text)) || ft2.find((t) => t.id && /диван/i.test(t.text));
  console.log('выбран диван:', JSON.stringify(sofa));
  if (sofa) {
    await page.click('#' + sofa.id);
    await page.waitForTimeout(700);
    console.log('active tool (furniture):', await page.evaluate(() => { const t: any = document.querySelector('.tools_item.active'); return t ? t.textContent.trim() : null; }));
    for (const pt of [[0, 60], [0, 0], [-50, 0], [50, 0], [0, -50]] as const) {
      await clearFog(page);
      const s = await toScreen(page, pt[0], pt[1]);
      await page.mouse.click(s.x, s.y);
      await page.waitForTimeout(900);
      const cnt = await page.evaluate(() => Object.keys((window as any).ITEMS).length);
      console.log('клик', JSON.stringify(pt), 'items=', cnt);
      if (cnt) break;
    }
  }
  await dumpState(page, 'sofa');

  // --- имя помещения: лист «Помещения», клик по маркеру площади (в pc комнаты) → инпут cm-room<id>--zone-name ---
  await page.click('.groups_navi_item.plan_rooms');
  await page.waitForTimeout(900);
  const rpc = await page.evaluate(() => { const r: any = Object.values((window as any).ROOMS2)[0]; return r ? [r.pc.x, r.pc.y] : [0, 0]; });
  await clickUntil(page, async () => !!(await page.evaluate(() => {
    const i: any = document.querySelector('input[id^="cm-room"][id$="-zone-name"]');
    return i && i.offsetParent !== null;
  })), [[rpc[0], rpc[1]], [rpc[0] + 10, rpc[1]], [rpc[0], rpc[1] + 10]]);
  const nameSel = 'input[id^="cm-room"][id$="-zone-name"]';
  console.log('inputs в контекстном меню помещения:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('input')].filter((e: any) => e.offsetParent !== null).map((e: any) => ({ id: e.id, val: e.value })))));
  try {
    await page.waitForSelector(nameSel, { state: 'visible', timeout: 4000 });
    await page.fill(nameSel, 'Гостиная');
    await page.waitForTimeout(300);
    // найти кнопку сохранения контекстного меню рядом
    const btns = await page.evaluate(() => [...document.querySelectorAll('[id^="cm-room"] button, .cm_button, [class*="context_menu"] button')].filter((e: any) => e.offsetParent !== null).map((e: any) => ({ tag: e.tagName, id: e.id, cls: String(e.className).slice(0, 40), text: (e.textContent || '').trim().slice(0, 30) })));
    console.log('кнопки меню помещения:', JSON.stringify(btns));
    const ok = btns.find((b: any) => /ok|save|примен|готов/i.test(b.id + b.cls + b.text));
    if (ok && ok.id) await page.click('#' + ok.id);
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  } catch (e: any) {
    console.log('имя помещения через UI не удалось:', e.message.split('\n')[0]);
  }
  await dumpState(page, 'roomname');

  // --- угол поворота предмета: повернуть диван через контекстное меню (ПКМ) → «Повернуть» ---
  // просто читаем angle у всех предметов после UI-установки (значения уже в ui-ref-sofa.json)
  console.log('items angles:', await page.evaluate(() => Object.values((window as any).ITEMS).map((i: any) => ({ name: i.props.name, angle: i.props.angle, pc: [Math.round(i.props.pc.x), Math.round(i.props.pc.y)] }))));

  await page.waitForTimeout(1500);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
