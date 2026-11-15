// Общие помощники проб фазы 2 (F2-01, F2-02). Только анонимные проекты, аккаунт не используется.
// Самодостаточно: зависит только от playwright-core, чтобы не ломаться от параллельных правок src/.
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

export const BASE = "https://remplanner.ru";
export const OUT_DIR = ".orca-reports/phase2-ui-refs";
export const D = 20; // толщина стен базы, см

export type P = { x: number; y: number };
export type Spec = { key: string; p1: P; p2: P };

/** База «коридор + 3 комнаты» из T24 (оси, см; Y вниз). T-концы перегородок — на гранях несущих. */
export function baseSpecs(): Spec[] {
  const h = D / 2;
  return [
    { key: "top", p1: { x: 0, y: -300 }, p2: { x: 600, y: -300 } },
    { key: "right", p1: { x: 600, y: -300 }, p2: { x: 600, y: 120 } },
    { key: "bottom", p1: { x: 600, y: 120 }, p2: { x: 0, y: 120 } },
    { key: "left", p1: { x: 0, y: 120 }, p2: { x: 0, y: -300 } },
    { key: "corridor", p1: { x: 0 + h, y: 0 }, p2: { x: 600 - h, y: 0 } },
    { key: "part1", p1: { x: 300, y: -300 + h }, p2: { x: 300, y: 0 - h } },
    { key: "part2", p1: { x: 500, y: -300 + h }, p2: { x: 500, y: 0 - h } },
  ];
}

export function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}
export const headed = process.argv.includes("--headed");

export async function launch(): Promise<Browser> {
  const shell = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";
  const exe = process.env.RP_BROWSER || (existsSync(shell) ? shell : undefined);
  if (exe && !headed) return chromium.launch({ executablePath: exe, headless: true });
  return chromium.launch({ channel: "chrome", headless: !headed });
}

export async function clearFog(page: Page) {
  await page.evaluate(() => {
    const f: any = document.querySelector("#planner_ui_message_fog");
    if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
    document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
  });
}

/** Новый анонимный проект в чистом контексте (без cookies аккаунта). */
export async function newAnonProject(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "ru-RU" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 300)));
  await page.goto(BASE + "/planner/", { waitUntil: "domcontentloaded" });
  await Promise.all([
    page.waitForNavigation({ timeout: 60000 }).catch(() => null),
    page.evaluate(() => (window as any).planner_create_object()),
  ]);
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project && (window as any).project, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  await clearFog(page);
  return page;
}

/** База штатным конструктором стен (сценарий A из T24): new Wall → draw({rooms:1}). */
export async function buildBase(page: Page): Promise<Record<string, string>> {
  const specs = baseSpecs();
  const ids = await page.evaluate(({ specs, D }) => {
    const w: any = window as any;
    const ids: Record<string, string> = {};
    for (const s of specs) {
      const id = w.LIB.id();
      ids[s.key] = id;
      // @ts-ignore Wall — лексический класс бандла
      w.WALLS[id] = new Wall({ id, p1: { ...s.p1 }, p2: { ...s.p2 }, depth: D, plan: "a", role: "wall",
        material: w.defs?.wall?.material || "a_block", color: w.defs?.wall?.color || 0 });
    }
    w.$Project.draw({ rooms: 1 });
    try { w.project.localSave(); } catch { /* */ }
    return ids;
  }, { specs, D });
  await page.waitForTimeout(1500);
  return ids;
}

export async function copyServer(page: Page): Promise<any> {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
}

export async function switchSheet(page: Page, sheet: string) {
  await clearFog(page);
  const ok = await page.evaluate((s) => {
    const nav: any = document.querySelector(`.groups_navi_item.plan_${s}`);
    if (!nav) return false;
    nav.click();
    return true;
  }, sheet);
  if (!ok) throw new Error(`лист ${sheet} не найден`);
  await page.waitForTimeout(1500);
  await clearFog(page);
}

/** Выбрать инструмент панели слева. PRO-инструмент не кликается: возвращает "pro". */
export async function pickTool(page: Page, key: string): Promise<"ok" | "pro" | "missing"> {
  const st = await page.evaluate((k) => {
    const el: any = document.querySelector(`#plannertool_${k}`);
    if (!el) return "missing";
    const group = el.closest(".tools_item, .subtools_item");
    if (el.classList.contains("is_pro") || (group && group.classList.contains("is_pro"))) return "pro";
    // раскрыть родительскую группу, если инструмент вложен
    const parent: any = el.closest(".subtools");
    if (parent && parent.id) {
      const opener: any = document.querySelector(`[data-target="${parent.id}"]`);
      opener?.click();
    }
    el.click();
    return "ok";
  }, key);
  await page.waitForTimeout(600);
  return st as "ok" | "pro" | "missing";
}

export async function escape(page: Page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

export async function toScreen(page: Page, p: P): Promise<P> {
  const v = await page.evaluate(() => {
    const svg: any = document.querySelector("#main_svg");
    const r = svg.getBoundingClientRect();
    const q = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    return { rx: r.x, ry: r.y, rw: r.width, rh: r.height, mx: q[0], my: q[1], vw: q[2], vh: q[3] };
  });
  return { x: v.rx + ((p.x - v.mx) * v.rw) / v.vw, y: v.ry + ((p.y - v.my) * v.rh) / v.vh };
}

export async function clickAt(page: Page, p: P, button: "left" | "right" = "left") {
  await clearFog(page);
  const s = await toScreen(page, p);
  await page.mouse.move(s.x - 6, s.y - 6);
  await page.mouse.move(s.x, s.y, { steps: 6 });
  await page.waitForTimeout(250);
  await page.mouse.down({ button });
  await page.mouse.up({ button });
  await page.waitForTimeout(700);
}

export async function dragAt(page: Page, a: P, b: P) {
  await clearFog(page);
  const s = await toScreen(page, a), e = await toScreen(page, b);
  await page.mouse.move(s.x, s.y, { steps: 4 });
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.mouse.move(e.x, e.y, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(800);
}

/** Поле контекстного меню: ввести значение и подтвердить Enter. Значение — в единицах интерфейса (см). */
export async function setMenuField(page: Page, selector: string, value: string): Promise<boolean> {
  const ok = await page.evaluate(({ selector, value }) => {
    const el: any = document.querySelector(selector);
    if (!el || el.offsetParent === null) return false;
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { selector, value });
  if (ok) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
  }
  return ok;
}

/** Разница двух копий модели по коллекциям: добавленные, удалённые, изменённые элементы (значения «после»). */
export function diffModels(before: any, after: any) {
  const skip = new Set(["logs", "log_plan", "signals", "session", "version", "drawing", "errors", "smeta_water_pipes", "final", "is_forced"]);
  const out: Record<string, any> = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (skip.has(k)) continue;
    const a = before?.[k], b = after?.[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (a && b && typeof a === "object" && typeof b === "object") {
      const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
      const added: Record<string, any> = {}, removed: string[] = [], changed: Record<string, any> = {};
      for (const id of ids) {
        if (!(id in a)) added[id] = b[id];
        else if (!(id in b)) removed.push(id);
        else if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) changed[id] = fieldDiff(a[id], b[id]);
      }
      out[k] = { added, removed, changed };
    } else {
      out[k] = { before: a, after: b };
    }
  }
  return out;
}

/** Поля объекта, которые изменились (значения «после»); вложенные массивы и объекты — целиком. */
function fieldDiff(a: any, b: any) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return { after: b };
  const res: Record<string, any> = {};
  for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) res[f] = b[f];
  }
  return res;
}

export function writeOut(name: string, data: unknown) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/${name}.json`, JSON.stringify(data, null, 1) + "\n");
}

export async function shot(page: Page, name: string) {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: `${OUT_DIR}/${name}.png` });
}

/** Сохранить (не чаще раза в 5 с) и перезагрузить страницу редактора. */
export async function saveAndReload(page: Page) {
  const resp = page.waitForResponse((r) => r.url().includes("/save/"), { timeout: 30000 }).catch(() => null);
  await page.evaluate(() => { const w: any = window as any; try { w.project.localSave(); } catch { /* */ } w.project.save(false, true); });
  const r = await resp;
  let saved: any = null;
  try { saved = r ? JSON.parse(await r.text()) : null; } catch { saved = "non-json"; }
  await page.waitForTimeout(5500);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null, { timeout: 60000 });
  await page.waitForTimeout(3000);
  await clearFog(page);
  return { result: saved?.result ?? saved };
}

/** Ключи PRO-инструментов текущей сессии (разметка редактора). */
export async function proKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('[id^="plannertool_"]'))
    .filter((el: any) => el.classList.contains("is_pro") || el.closest(".tools_item.is_pro, .subtools_item.is_pro"))
    .map((el: any) => el.id.replace(/^plannertool_/, "")));
}
