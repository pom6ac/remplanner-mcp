import { homedir } from "node:os";
import { join } from "node:path";

export const BASE_URL = "https://remplanner.ru";

// Каталог состояния. REMPLANNER_HOME — переопределение для тестов: снимки/рендеры
// и состояние пишутся во временный каталог, а не в домашний (EPERM в песочницах).
const homeOverride = process.env["REMPLANNER_HOME"];
export const HOME_DIR =
  homeOverride && homeOverride.trim() !== "" ? homeOverride : join(homedir(), ".remplanner-mcp");
export const CREDENTIALS_PATH = join(HOME_DIR, "credentials.env");
export const STATE_PATH = join(HOME_DIR, "state.json");
export const STATE_ANON_PATH = join(HOME_DIR, "state.anon.json");
export const CACHE_DIR = join(HOME_DIR, "cache");
export const RENDERS_DIR = join(HOME_DIR, "renders");
export const BACKUPS_DIR = join(HOME_DIR, "backups");

/** Пауза между запросами к сайту, мс (≤ 30 запросов в минуту). */
export const MIN_REQUEST_INTERVAL_MS = 2100;
/** Минимальный интервал между сохранениями, мс (design §3: ≤ 1 сохранения в 5 с). */
export const SAVE_INTERVAL_MS = 5100;
/** Таймауты HTTP-запросов, мс. */
export const HTTP_TIMEOUT_MS = 30_000;
/** Таймауты браузерных операций, мс. */
export const BROWSER_TIMEOUT_MS = 30_000;
/** Закрытие браузера после простоя, мс. */
export const BROWSER_IDLE_CLOSE_MS = 10 * 60_000;
/** Повторный вход не чаще, чем раз в 10 минут. */
export const RELOGIN_COOLDOWN_MS = 10 * 60_000;

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
