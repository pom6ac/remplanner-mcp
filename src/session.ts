import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { McpError } from "./errors.ts";

export type SessionCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix-время истечения в секундах; -1 — сессионная. */
  expires: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

export type SessionState = {
  cookies: SessionCookie[];
  localStorage?: { origin: string; items: Record<string, string> }[];
  /**
   * Сессия аккаунта (state.json). Анонимные потоки (создание/открытие анонимных
   * проектов, редактор) с такой сессией запрещены: аккаунтные cookies в контексте
   * редактора открывают текущий проект аккаунта (инцидент 2026-11-15, запись в проект пользователя).
   */
  account?: boolean;
};

/** Читает state.json и проверяет срок cookies. */
export function loadSession(filePath: string): SessionState {
  if (!existsSync(filePath)) {
    throw new McpError("AUTH_REQUIRED", `нет сессии ${filePath}`, { hint: "выполните npm run login" });
  }
  let state: SessionState;
  try {
    state = JSON.parse(readFileSync(filePath, "utf8")) as SessionState;
  } catch {
    throw new McpError("AUTH_REQUIRED", `файл сессии ${filePath} повреждён`, { hint: "выполните npm run login заново" });
  }
  if (!Array.isArray(state.cookies)) {
    throw new McpError("AUTH_REQUIRED", `файл сессии ${filePath} не содержит cookies`, { hint: "выполните npm run login заново" });
  }
  return state;
}

/** Есть ли среди cookies незаведомо протухших; сессионные (-1) считаются живыми. */
export function hasLiveCookies(state: SessionState, now: Date = new Date()): boolean {
  const nowSec = Math.floor(now.getTime() / 1000);
  return state.cookies.some((c) => c.expires === -1 || c.expires > nowSec);
}

/** Все cookies истекли? */
export function isExpired(state: SessionState, now: Date = new Date()): boolean {
  return !hasLiveCookies(state, now);
}

export function saveSession(filePath: string, state: SessionState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

/** Cookie для Cookie-заголовка по домену (суффикс-совпадение). */
export function cookieHeader(state: SessionState, domain: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return state.cookies
    .filter((c) => domain.endsWith(c.domain.replace(/^\./, "")))
    .filter((c) => c.expires === -1 || c.expires > nowSec)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}
