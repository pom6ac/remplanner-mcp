import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { BROWSER_IDLE_CLOSE_MS } from "./config.ts";
import { McpError } from "./errors.ts";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let launching: Promise<Browser> | null = null;
/** Режим запущенного общего браузера: headed игнорировать нельзя (R2-12). */
let browserMode: "headless" | "headed" | null = null;

/**
 * Нужен ли перезапуск общего браузера в headed-режиме: если headless-браузер уже
 * запущен, а запрошен headed — старый не годится (R2-12).
 */
export function needsHeadedRelaunch(current: "headless" | "headed" | null, headed?: boolean): boolean {
  return headed === true && current === "headless";
}

/** Пути к Chrome: переменная окружения, системный Chrome, кэш Playwright. */
export function chromeCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env["REMPLANNER_BROWSER"]) candidates.push(process.env["REMPLANNER_BROWSER"]);
  candidates.push(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  );
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache)) {
      if (dir.startsWith("chromium")) {
        candidates.push(join(cache, dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"));
        candidates.push(join(cache, dir, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"));
        candidates.push(join(cache, dir, "chrome-linux", "chrome"));
      }
    }
  }
  return candidates.filter((p) => existsSync(p));
}

async function launchBrowser(options?: { headed?: boolean }): Promise<Browser> {
  const headless = !options?.headed;
  const candidates = chromeCandidates();
  let lastError: unknown = null;
  for (const executablePath of candidates) {
    try {
      return await chromium.launch({ executablePath, headless });
    } catch (e) {
      lastError = e;
    }
  }
  // последний шанс — дефолтный канал playwright-core
  try {
    return await chromium.launch({ channel: "chrome", headless });
  } catch (e) {
    lastError = e;
  }
  throw new McpError("INTERNAL", "не найден Chrome (системный и кэш Playwright)", {
    hint: "укажите путь через REMPLANNER_BROWSER или выполните npx playwright install chromium",
    // сообщение исключения запуска содержит пути — наружу только сводка (этап 145, B2)
    details: { kind: "chrome_launch_failed", attempts: candidates.length + 1 },
  });
}

/** Общий экземпляр браузера (для контекстов с cookies — адаптер редактора). */
export async function getSharedBrowser(): Promise<Browser> {
  if (browser) return browser;
  if (!launching) launching = launchBrowser();
  browser = await launching;
  launching = null;
  browserMode = "headless";
  return browser;
}

export function scheduleIdleClose(onClose?: () => void): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void closeBrowser();
    onClose?.();
  }, BROWSER_IDLE_CLOSE_MS);
  idleTimer.unref();
}

/** Ленивый запуск общего контекста браузера. */
export async function getBrowserContext(): Promise<BrowserContext> {
  if (context) {
    scheduleIdleClose();
    return context;
  }
  if (!launching) launching = launchBrowser();
  browser = await launching;
  launching = null;
  context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  scheduleIdleClose();
  return context;
}

export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

/** Отдельный контекст (чистые cookies) — для изолированных проверок и входа. */
export async function withFreshContext<T>(options: { storageState?: string; headed?: boolean } | undefined, fn: (page: Page) => Promise<T>): Promise<T> {
  // headed передаётся на уровень запуска браузера (находка №16 ревью), не в newContext;
  // если общий браузер уже запущен headless, а нужен headed — перезапускаем (R2-12)
  if (needsHeadedRelaunch(browserMode, options?.headed)) {
    await closeBrowser();
  }
  const browserToUse = browser ?? (await launchBrowser({ headed: options?.headed }));
  browserMode = options?.headed ? "headed" : (browserMode ?? "headless");
  const ctx = await browserToUse.newContext({
    viewport: { width: 1600, height: 1000 },
    storageState: options?.storageState,
  });
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await ctx.close().catch(() => {});
    if (browser === null) await browserToUse.close().catch(() => {});
  }
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  browserMode = null;
}

export function userDataDir(): string {
  return join(tmpdir(), "remplanner-mcp-profile");
}
