import { BASE_URL, HTTP_TIMEOUT_MS, MIN_REQUEST_INTERVAL_MS, RELOGIN_COOLDOWN_MS, SAVE_INTERVAL_MS, USER_AGENT } from "./config.ts";
import { cookieHeader, type SessionState, type SessionCookie } from "./session.ts";
import { isReloadResponse } from "./api.ts";
import { McpError } from "./errors.ts";

/** Ограничитель частоты: последовательная очередь, слот резервируется до завершения await. */
export class RateLimiter {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly intervalMs: number;
  constructor(intervalMs: number = MIN_REQUEST_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  async acquire(): Promise<void> {
    const run = this.chain.then(async () => {
      const now = Date.now();
      const wait = this.last + this.intervalMs - now;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
    });
    // следующий ждёт завершения этого слота, даже при ошибке
    this.chain = run.catch(() => {});
    return run;
  }
}

export const globalLimiter = new RateLimiter();
/** Отдельное окно для сохранений: не чаще одного в SAVE_INTERVAL_MS. */
export const saveLimiter = new RateLimiter(SAVE_INTERVAL_MS);

export type HttpOptions = {
  method?: "GET" | "POST";
  body?: BodyInit;
  headers?: Record<string, string>;
  session?: SessionState;
  /** Куда сохранить cookies из ответа (для анонимных проектов: visitor_id, object_id). */
  captureCookiesInto?: SessionState;
  /** Дополнительная строка запроса к BASE_URL (путь с query). */
  path: string;
  timeoutMs?: number;
  limiter?: RateLimiter;
  /** Обработка reload:101 по умолчанию — SESSION_EXPIRED. */
  onReload?: () => Promise<unknown>;
};

/** Разбор set-cookie в SessionCookie. */
export function parseSetCookie(raw: string, defaultDomain = "remplanner.ru"): SessionCookie {
  const parts = raw.split(";");
  const [nv] = parts;
  const eq = nv!.indexOf("=");
  const name = nv!.slice(0, eq).trim();
  const value = nv!.slice(eq + 1).trim();
  const cookie: SessionCookie = { name, value, domain: defaultDomain, path: "/", expires: -1 };
  for (const part of parts.slice(1)) {
    const [k, v] = part.split("=", 2);
    const key = k!.trim().toLowerCase();
    if (key === "expires" && v) {
      const t = Date.parse(v.trim());
      if (!Number.isNaN(t)) cookie.expires = Math.floor(t / 1000);
    } else if (key === "domain" && v) {
      cookie.domain = v.trim().replace(/^\./, "");
    } else if (key === "path" && v) {
      cookie.path = v.trim();
    }
  }
  return cookie;
}

function captureCookies(res: Response, session: SessionState): void {
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of setCookies) {
    const cookie = parseSetCookie(raw);
    const idx = session.cookies.findIndex((c) => c.name === cookie.name);
    if (idx >= 0) session.cookies[idx] = cookie;
    else session.cookies.push(cookie);
  }
}

/** Путь без query для сообщений об ошибках: query может содержать authkey (находка №1 ревью). */
export function safePath(path: string): string {
  const q = path.indexOf("?");
  const base = q === -1 ? path : path.slice(0, q);
  return base.length > 120 ? `${base.slice(0, 117)}…` : base;
}

function errorFromStatus(status: number, path: string): McpError {
  const where = safePath(path);
  if (status === 429) {
    return new McpError("RATE_LIMITED", `сайт ответил 429 на ${where}`);
  }
  if (status === 403) {
    return new McpError("CAPTCHA_REQUIRED", `сайт ответил 403 на ${where}`);
  }
  if (status >= 500) {
    return new McpError("SITE_ERROR", `сайт ответил ${status} на ${where}`);
  }
  return new McpError("SITE_ERROR", `неожиданный ответ ${status} на ${where}`);
}

export async function httpRequestRaw(options: HttpOptions): Promise<Response> {
  const { path, session, method = "GET", body, headers = {}, timeoutMs = HTTP_TIMEOUT_MS } = options;
  // единая очередь всех запросов к сайту (R2-10): сохранения не выпадают из общей
  // квоты 30/мин; saveLimiter — дополнительное окно 5 с поверх общей очереди
  await globalLimiter.acquire();
  if (options.limiter && options.limiter !== globalLimiter) {
    await options.limiter.acquire();
  }
  const url = `${BASE_URL}${path}`;
  const allHeaders: Record<string, string> = {
    "user-agent": USER_AGENT,
    referer: `${BASE_URL}/`,
    ...headers,
  };
  if (session) {
    const cookie = cookieHeader(session, "remplanner.ru");
    if (cookie !== "") allHeaders["cookie"] = cookie;
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: allHeaders,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new McpError("TIMEOUT", `таймаут запроса ${safePath(path)}`);
    }
    // текст внешнего исключения может содержать URL с authkey — наружу только имя (R2-1)
    const kind = e instanceof Error ? (e.name || "Error") : "Error";
    throw new McpError("SITE_ERROR", `сетевая ошибка (${kind}) при запросе ${safePath(path)}`);
  }
  if (res.status >= 400 || (res.status >= 300 && method === "GET" && !res.headers.get("location"))) {
    throw errorFromStatus(res.status, path);
  }
  if (options.captureCookiesInto) captureCookies(res, options.captureCookiesInto);
  return res;
}

/** HTTP-запрос с разбором JSON и детектом reload:101. */
export async function httpRequestJson<T = unknown>(options: HttpOptions): Promise<T> {
  const res = await httpRequestRaw(options);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // сырое тело не включаем в ошибку: может содержать секреты/персональные данные (№1)
    throw new McpError("SITE_ERROR", `не-JSON ответ на ${safePath(options.path)}`);
  }
  if (isReloadResponse(body)) {
    if (options.onReload) return (await options.onReload()) as T;
    throw new McpError("SESSION_EXPIRED", "сессия истекла (reload:101)", {
      hint: "выполните npm run login",
    });
  }
  return body as T;
}

/**
 * Один автоматический повтор после SESSION_EXPIRED через повторный вход.
 * Повторный вход — не чаще раза в RELOGIN_COOLDOWN_MS и в один поток (single-flight);
 * внутри кулдауна — SESSION_TAKEN_OVER (design §3, находка №11).
 */
export class ReloginManager {
  private lastAt = 0;
  private pending: Promise<void> | null = null;

  get lastReloginAt(): number {
    return this.lastAt;
  }

  async relogin(auto: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending;
    if (Date.now() - this.lastAt < RELOGIN_COOLDOWN_MS) {
      throw new McpError(
        "SESSION_TAKEN_OVER",
        "сессию выбил вход в другом месте (вероятно, аккаунт открыт в браузере); автоматический повторный вход уже был недавно",
        { hint: "закройте вкладку редактора на сайте или повторите позже" },
      );
    }
    // резервируем время попытки ДО входа: неудачная попытка тоже занимает cooldown —
    // сам факт повторного входа мог выбить пользовательскую сессию (R2-15)
    this.lastAt = Date.now();
    const run = (async () => {
      try {
        await auto();
      } finally {
        this.pending = null;
      }
    })();
    this.pending = run;
    return run;
  }
}

export const globalRelogin = new ReloginManager();

export async function withRelogin<T>(fn: () => Promise<T>, relogin?: () => Promise<void>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof McpError && e.code === "SESSION_EXPIRED") {
      await globalRelogin.relogin(relogin ?? (() => { throw new McpError("SESSION_EXPIRED", "автоматический повторный вход не настроен"); }));
      return fn();
    }
    throw e;
  }
}
