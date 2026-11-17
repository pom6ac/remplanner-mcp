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
  | "RENDER_OUT_OF_SYNC"
  | "MODEL_PARSE_EMPTY"
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
    // ЕДИНОЕ место маскирования секретов: всё, что уходит клиенту, проходит через
    // maskSecrets/maskSecretsDeep — строки из внешних источников (тела ответов,
    // exception-сообщения) не должны раскрывать authkey/пароли/токены (этап 145, B1).
    const out: { code: ErrorCode; message: string; hint?: string; details?: unknown } = {
      code: this.code,
      message: maskSecrets(this.message),
    };
    if (this.hint !== undefined) out.hint = maskSecrets(this.hint);
    if (this.details !== undefined) out.details = maskSecretsDeep(this.details);
    return out;
  }
}

// ---------- Маскирование секретов (этап 145, B1) ----------

/**
 * Имена секретных ключей (регистронезависимо): query-параметры, JSON-поля,
 * заголовки, cookie. Дополнение списка — здесь, в одном месте.
 */
const SECRET_KEY_SOURCE =
  "authkey|authorization|auth|password|passwd|pwd|token|jwt|secret|api_key|apikey|access_key|" +
  "cookie|set_cookie|set-cookie|session|sessionid|sessid|login";

const IS_SECRET_KEY_RE = new RegExp(`^(?:${SECRET_KEY_SOURCE})$`, "i");

/** true, если имя ключа/параметра — секретное. */
export function isSecretKey(name: string): boolean {
  return IS_SECRET_KEY_RE.test(name.trim().toLowerCase());
}

// key=value / key: value (query, form-тела, заголовки, плоский текст).
// Значение — до разделителя (&, пробел, кавычка, ;, скобки); кавычкованное — целиком.
const KV_SECRETS_RE = new RegExp(
  `((?:${SECRET_KEY_SOURCE})["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s&"',;})\\]]+)`,
  "gi",
);
// Authorization Bearer/Basic — значение целиком (до него: kv-правило скрыло бы слово Bearer).
const BEARER_RE = /\b(bearer|basic)(\s+)([A-Za-z0-9._~+/=-]{6,})/gi;

/**
 * Маскирование значений секретных ключей в произвольном тексте: query, заголовки,
 * JSON-фрагменты, плоский текст. JSON-поля (секретный ключ в кавычках) и ключ-значение
 * в кавычках покрываются одним kv-правилом (значение в кавычках матчится целиком).
 */
export function maskSecrets(text: string): string {
  return text.replace(BEARER_RE, "$1$2***").replace(KV_SECRETS_RE, "$1***");
}

/** Рекурсивное маскирование в деталях ошибки: по именам ключей, строки, массивы. */
export function maskSecretsDeep(value: unknown): unknown {
  if (typeof value === "string") return maskSecrets(value);
  if (Array.isArray(value)) return value.map(maskSecretsDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? "***" : maskSecretsDeep(v);
    }
    return out;
  }
  return value;
}

// ---------- Единая сериализация ошибок (этап 145, B2) ----------

export type ErrorPayload = { code: ErrorCode; message: string; hint?: string; details?: unknown };

/**
 * Безопасный диагностический код неожиданного исключения: стабильный хеш
 * имени и сообщения. Клиенту код отдаётся, исходное сообщение — нет
 * (в stderr оно пишется замаскированным).
 */
export function diagnosticCode(e: unknown): string {
  const basis = e instanceof Error ? `${e.name}|${e.message}` : String(e);
  let h = 5381;
  for (let i = 0; i < basis.length; i++) {
    h = ((h * 33) ^ basis.charCodeAt(i)) >>> 0;
  }
  return `ERR-${h.toString(16).padStart(8, "0")}`;
}

/**
 * Единая безопасная сериализация любой ошибки для выдачи клиенту:
 * - McpError — код, замаскированное сообщение, hint, маскированные details;
 * - внутренние ошибки с code NOT_FOUND/INVALID_ARGUMENT — код + замаскированное сообщение;
 * - неожиданные исключения (fs, Playwright, fetch…) — нейтральное сообщение с
 *   диагностическим кодом, БЕЗ e.message наружу; замаскированный оригинал — в stderr.
 */
export function errorToPayload(e: unknown): ErrorPayload {
  if (e instanceof McpError) return e.toJSON();
  const code = (e as { code?: string }).code;
  if (code === "NOT_FOUND" || code === "INVALID_ARGUMENT") {
    return { code, message: maskSecrets((e as Error).message) };
  }
  const diag = diagnosticCode(e);
  const kind = e instanceof Error ? e.name : "Error";
  console.error(`[remplanner-mcp] необработанное исключение (${diag}): ${maskSecrets(e instanceof Error ? `${kind}: ${e.message}` : String(e))}`);
  return { code: "INTERNAL", message: `внутренняя ошибка: ${kind} (диагностический код ${diag})` };
}
