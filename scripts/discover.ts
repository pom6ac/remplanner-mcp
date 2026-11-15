// Разведка редактора remplanner.ru: перехват сети, глобальные объекты, скриншоты.
// Запуск: node scripts/discover.ts [--anon] [--headed]
// Секреты не печатаются; в дамп не попадают cookie и тела запросов авторизации.
import { chromium } from 'playwright-core';
import type { Page, Request } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';

const headed = process.argv.includes('--headed');
const BASE = 'https://remplanner.ru';

const SENSITIVE = /pass|login|auth|token|session|email|phone/i;

type NetRec = { method: string; url: string; type: string; status?: number; reqBody?: string; resType?: string; resSize?: number; resSample?: string };

function scrub(s: string | null | undefined, max = 2000): string | undefined {
  if (!s) return undefined;
  if (SENSITIVE.test(s.slice(0, 300))) return '[скрыто: похоже на данные авторизации]';
  return s.length > max ? s.slice(0, max) + `…[+${s.length - max}]` : s;
}

async function main() {
  await mkdir('screenshots', { recursive: true });
  const shell = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
  const browser = headed
    ? await chromium.launch({ channel: 'chrome', headless: false })
    : await chromium.launch({ executablePath: process.env.RP_BROWSER || shell, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  const net: NetRec[] = [];
  const ws: { url: string; frames: string[] }[] = [];

  page.on('websocket', (w) => {
    const rec = { url: w.url(), frames: [] as string[] };
    ws.push(rec);
    w.on('framesent', (f) => rec.frames.length < 50 && rec.frames.push('> ' + String(f.payload).slice(0, 500)));
    w.on('framereceived', (f) => rec.frames.length < 50 && rec.frames.push('< ' + String(f.payload).slice(0, 500)));
  });
  page.on('requestfinished', async (req: Request) => {
    const t = req.resourceType();
    if (!['xhr', 'fetch', 'document', 'script', 'other'].includes(t)) return;
    const res = await req.response();
    const rec: NetRec = { method: req.method(), url: req.url().slice(0, 400), type: t, status: res?.status() };
    if (req.method() !== 'GET') rec.reqBody = scrub(req.postData());
    if (res && (t === 'xhr' || t === 'fetch')) {
      try {
        const body = await res.body();
        rec.resType = res.headers()['content-type'];
        rec.resSize = body.length;
        rec.resSample = scrub(body.toString('utf8'), 3000);
      } catch {}
    }
    if (t === 'script') {
      try { rec.resSize = (await res!.body()).length; } catch {}
    }
    net.push(rec);
  });

  // Базовый набор глобалов пустой страницы
  await page.goto('about:blank');
  const baseKeys: string[] = await page.evaluate(() => Object.keys(window));

  await page.goto(BASE + '/planner/', { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: 'screenshots/01-landing.png' });
  // Анонимное создание проекта (кнопка «Нарисовать чертежи своими руками»)
  await Promise.all([
    page.waitForNavigation({ timeout: 60000 }).catch(() => null),
    page.evaluate(() => (window as any).planner_create_object()),
  ]);
  await page.waitForTimeout(15000);
  console.log('URL после создания:', page.url());
  await page.screenshot({ path: 'screenshots/02-editor-anon.png' });

  const info = await inspect(page, baseKeys);
  await writeFile('api-dump.anon.json', JSON.stringify({ url: page.url(), info, net, ws }, null, 2));
  console.log('globals:', info.globals.length, 'net:', net.length, 'ws:', ws.length);
  if (headed) await page.waitForTimeout(600000);
  await browser.close();
}

async function inspect(page: Page, baseKeys: string[]) {
  return page.evaluate((base) => {
    const set = new Set(base);
    const globals = Object.keys(window).filter((k) => !set.has(k));
    const describe = (v: any) => {
      const t = typeof v;
      if (v === null) return 'null';
      if (t === 'function') return 'fn/' + v.length;
      if (Array.isArray(v)) return 'array[' + v.length + ']';
      if (t === 'object') {
        const keys = Object.keys(v);
        return 'object{' + keys.slice(0, 25).join(',') + (keys.length > 25 ? ',…' + keys.length : '') + '}';
      }
      return t + ':' + String(v).slice(0, 80);
    };
    const g: Record<string, string> = {};
    for (const k of globals) {
      try { g[k] = describe((window as any)[k]); } catch { g[k] = 'err'; }
    }
    const canvases = [...document.querySelectorAll('canvas')].map((c) => ({ id: c.id, cls: c.className, w: c.width, h: c.height }));
    const svgs = document.querySelectorAll('svg').length;
    const scripts = [...document.scripts].map((s) => s.src || '[inline ' + s.text.length + ']');
    const body = document.body ? { cls: document.body.className, data: { ...document.body.dataset } } : null;
    // data-authkey и подобное не сохраняем
    if (body) for (const k of Object.keys(body.data)) if (/auth|key|token/i.test(k)) body.data[k] = '[скрыто]';
    return { globals: Object.entries(g).map(([k, v]) => k + ' = ' + v), canvases, svgs, scripts, body, title: document.title };
  }, baseKeys);
}

main().catch((e) => { console.error(e); process.exit(1); });
