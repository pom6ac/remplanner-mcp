import type { Page } from "playwright-core";
import { BASE_URL, CREDENTIALS_PATH, STATE_PATH } from "./config.ts";
import { readCredentials, type Credentials } from "./credentials.ts";
import { saveSession, loadSession, type SessionState } from "./session.ts";
import { McpError } from "./errors.ts";
import { withFreshContext } from "./browser.ts";

const CLIENT_URL = `${BASE_URL}/client/`;

export type LoginOptions = {
  headed?: boolean;
  timeoutMs?: number;
};

/** Признак капчи на странице входа. */
export function detectCaptcha(html: string): boolean {
  return (
    /id="captcha"|class="[^"]*captcha|g-recaptcha|h-captcha|Я не робот/i.test(html)
  );
}

/** Заполняет форму /client/ и ждёт #clientline.is_logged. */
export async function loginViaPage(page: Page, credentials: Credentials, timeoutMs = 25_000): Promise<void> {
  await page.goto(CLIENT_URL, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  let html = await page.content();
  if (detectCaptcha(html)) {
    throw new McpError("CAPTCHA_REQUIRED", "на /client/ обнаружена капча", {
      hint: "выполните npm run login --headed и войдите вручную",
    });
  }
  if (/id="clientline"[^>]*is_logged/.test(html)) return; // уже вошли

  const emailInput = page.locator("form.pre_form input[name=email]");
  const passwordInput = page.locator("form.pre_form input[name=password]");
  if ((await emailInput.count()) === 0 || (await passwordInput.count()) === 0) {
    throw new McpError("AUTH_FAILED", "на /client/ не найдена форма входа (изменилась страница сайта)");
  }
  await emailInput.fill(credentials.login);
  await passwordInput.fill(credentials.password);
  await page.locator("form.pre_form input[name=auth_trigger]").evaluate((el) => {
    (el as HTMLInputElement).value = "1";
  });
  await page.locator("form.pre_form a.pre_button").first().click();

  try {
    await page.waitForSelector("#clientline.is_logged", { timeout: timeoutMs });
  } catch {
    html = await page.content();
    if (detectCaptcha(html)) {
      throw new McpError("CAPTCHA_REQUIRED", "после входа сайт требует капчу");
    }
    if (/class="pre_error"/.test(html)) {
      throw new McpError("AUTH_FAILED", "вход не принят: неверный логин или пароль", {
        hint: "проверьте ~/.remplanner-mcp/credentials.env",
      });
    }
    throw new McpError("AUTH_FAILED", "вход не подтвердился (#clientline.is_logged не появился)");
  }
}

/** Вход в аккаунт и сохранение сессии в state.json (0600). */
export async function login(options: LoginOptions = {}): Promise<SessionState> {
  const credentials = readCredentials(CREDENTIALS_PATH);
  const storage = await withFreshContext({ headed: options.headed }, async (page) => {
    await loginViaPage(page, credentials, options.timeoutMs);
    return page.context().storageState();
  });
  const state: SessionState = { cookies: storage.cookies as SessionState["cookies"] };
  saveSession(STATE_PATH, state);
  return state;
}
