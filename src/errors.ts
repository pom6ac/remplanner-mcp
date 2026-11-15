export type ErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_FAILED"
  | "CAPTCHA_REQUIRED"
  | "SESSION_EXPIRED"
  | "SESSION_TAKEN_OVER"
  | "NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "INVALID_GEOMETRY"
  | "GEOMETRY_CONFLICT"
  | "UNSUPPORTED_JUNCTION"
  | "OUTSIDE_ROOM"
  | "NORMALIZATION_DROPPED"
  | "PLAN_LIMIT"
  | "NOT_AVAILABLE_ON_TARIFF"
  | "SAVE_CONFLICT"
  | "EDITOR_INCOMPATIBLE"
  | "EDITOR_PROJECT_MISMATCH"
  | "RATE_LIMITED"
  | "SITE_ERROR"
  | "TIMEOUT"
  | "INTERNAL";

export class McpError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options?: { hint?: string; details?: unknown }) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.hint = options?.hint;
    this.details = options?.details;
  }

  toJSON(): { code: ErrorCode; message: string; hint?: string; details?: unknown } {
    // ЕДИНОЕ место маскирования секретов (раунд 2, R2-1): всё, что уходит клиенту,
    // проходит через scrubSecrets — строки из внешних источников (тела ответов,
    // exception-сообщения) не должны раскрывать authkey/пароли/токены.
    const out: { code: ErrorCode; message: string; hint?: string; details?: unknown } = {
      code: this.code,
      message: scrubSecrets(this.message),
    };
    if (this.hint !== undefined) out.hint = scrubSecrets(this.hint);
    if (this.details !== undefined) out.details = scrubSecretsDeep(this.details);
    return out;
  }
}

/**
 * Маскирование значений секретных ключей в произвольном тексте (query, заголовки,
 * фрагменты тел). Ключи: authkey, password, login, token, secret, cookie, set-cookie,
 * authorization. Значение до конца «слова» (до &, пробела, кавычки, ;, }).
 */
export function scrubSecrets(text: string): string {
  return text.replace(
    /((?:authkey|password|passwd|login|token|secret|cookie|set-cookie|authorization)\s*[=:]\s*)([^\s&"',;})\]]+)/gi,
    "$1***",
  );
}

/** Рекурсивное маскирование в деталях ошибки (строки, массивы, объекты). */
export function scrubSecretsDeep(value: unknown): unknown {
  if (typeof value === "string") return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubSecretsDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubSecretsDeep(v);
    }
    return out;
  }
  return value;
}
