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
 * заголовки, cookie. Дополнение списка — здесь, в одном месте; текстовое
 * правило и isSecretKey строятся из одного источника (ревью 147, «упростить» №1).
 */
const SECRET_KEY_SOURCE =
  "authkey|auth_key|authorization|auth|password|passwd|pwd|pass|token|access_token|refresh_token|" +
  "id_token|jwt|secret|client_secret|api_key|api-key|apikey|x-api-key|access_key|cookie|set_cookie|" +
  "set-cookie|session|sessionid|phpsessid|sessid|sid|csrf|xsrf|login";

/**
 * true, если имя ключа/параметра — секретное. Совпадение «по вхождению с
 * границей слова»: access_token, x-auth-token, PHPSESSID, client_secret
 * ловятся так же, как точные имена (находка №2 ревью 147). Граница учитывает
 * и переход регистра: accessToken, authToken, clientSecret, sessionId —
 * camelCase-составные ключи (M1 ревью 150).
 */
const IS_SECRET_KEY_RE = new RegExp(`(?:^|[^a-z0-9])(?:${SECRET_KEY_SOURCE})(?:$|[^a-z0-9])`, "i");

/** true, если имя ключа/параметра — секретное. */
export function isSecretKey(name: string): boolean {
  // camelCase разбивается на слова до нижнего регистра (M1 ревью 150):
  // accessToken → access_token, authToken → auth_token, clientSecret → client_secret
  const norm = name.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return IS_SECRET_KEY_RE.test(norm);
}

// Левая граница слова: не буквенно-цифровая (ревью 147 №6 — иначе «relogin:» маскируется как «login»).
const LEFT = "(?<![A-Za-z0-9])";

// key=value / key: value (query, form-тела, заголовки, плоский текст).
// Значение — до разделителя (&, пробел, кавычка, ;, скобки); кавычкованное — целиком.
const KV_SECRETS_RE = new RegExp(
  `(${LEFT}(?:${SECRET_KEY_SOURCE})["']?\\s*[:=]\\s*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s&"',;})\\r\\n\\]]+)`,
  "gi",
);
// Authorization — любая схема (Bearer/Basic/Token/Digest/…): значение целиком до конца
// строки, включая свёрнутые продолжения (obs-fold: строки с отступа, m2 ревью 150).
// Стоит ДО kv-правила.
const AUTHZ_RE = new RegExp(
  `(${LEFT}authorization["']?\\s*[:=]\\s*)([^\\r\\n]+(?:\\r?\\n[ \\t][^\\r\\n]*)*)`,
  "gi",
);

// Cookie/Set-Cookie: значения всех пар маскируются, кроме безопасных атрибутов
// (находка №2 ревью 147: произвольные имена cookie вроде remember_me).
// Левая граница имени не даёт движку перебирать каждую позицию внутри длинного
// имени без «=» — иначе квадратичный рост (M2 ревью 150).
const COOKIE_LINE_RE = /((?:set-?cookie|cookie)["']?\s*[:=]\s*)([^\r\n]*)/gi;
const COOKIE_PAIR_RE = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)(\s*=\s*)([^;]*)/g;
const SAFE_COOKIE_ATTR_RE = /^(?:path|domain|expires|max-age|samesite|secure|httponly|priority|partitioned)$/i;
// JSON-поле с секретным ключом и строковым значением с экранированными кавычками
// ("password":"ab\"…") — значение матчится целиком с учётом экранирования
// (находка №2 ревью 147). Ключ матчится целиком и проверяется isSecretKey —
// единый источник с camelCase-поддержкой (M1 ревью 150). Стоит ДО kv-правила,
// иначе хвост после \" остаётся открытым.
const JSON_SECRET_RE = /"([A-Za-z0-9_-]+)"(\s*:\s*)("(?:\\.|[^"\\])*")/g;
// camelCase-ключи в тексте (M1 ревью 150): accessToken=…, userPassword=…, sessionId=…
// Регистрозависимо (граница camelCase — это сам переход регистра), поэтому
// whiskey/monkey/«sessions: 3» не задеваются (фикс №6 ревью 147 остаётся).
const CAMEL_TAIL_SOURCE = "Token|Password|Passwd|Secret|Key|Auth|Session|Cookie|Jwt";
const KV_CAMEL_RE = new RegExp(
  // левая граница ключа обязательна: без неё движок с каждой позиции длинной
  // буквенной последовательности заново сканирует хвост — квадратичный рост
  `(?<![A-Za-z0-9_-])([A-Za-z0-9_-]*(?:${CAMEL_TAIL_SOURCE})|(?:${SECRET_KEY_SOURCE})(?=[A-Z])[A-Za-z0-9]*)["']?(\\s*[:=]\\s*)` +
    `("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s&"',;})\\r\\n\\]]+)`,
  "g",
);
// [value="…"] в Playwright-селекторах (input[name=password][value="…"]).
const SELECTOR_VALUE_RE = /(\[\s*value\s*=\s*)("[^"]*"|'[^']*')(\s*\])/g;
// «token <значение>» — секрет после имени через пробел (токеноподобное значение,
// без двоеточий/скобок, чтобы не задевать обычный текст diagnostics).
const TOKEN_SPACE_RE = /\b(bearer|basic|token|jwt)(\s+)([A-Za-z0-9._~+/=-]{6,})/gi;

/**
 * Повтор найденного значения затирается во всём тексте только для
 * секретоподобных значений: достаточно длинных и не похожих на числа/булевы
 * (m6 ревью 150 — иначе «pass: 1000» стирало бы каждое «1000» в координатах).
 */
function repeatableSecretValue(v: string): boolean {
  return v.length >= 8 && !/^(?:\d+(?:\.\d+)?|true|false|null)$/i.test(v);
}

function collectSecretValues(text: string, into: Set<string>): void {
  // значения, найденные после секретных ключей, маскируются во всём тексте:
  // секрет часто встречается повторно без ключа (находка №2 ревью 147)
  for (const m of text.matchAll(KV_SECRETS_RE)) {
    const v = m[2] ?? "";
    const clean = v.length > 1 && (v.startsWith('"') || v.startsWith("'")) ? v.slice(1, -1) : v;
    if (repeatableSecretValue(clean)) into.add(clean);
  }
  for (const m of text.matchAll(JSON_SECRET_RE)) {
    if (!isSecretKey(m[1]!)) continue;
    const raw = m[3] ?? "";
    const v = raw.length > 1 && (raw.startsWith('"') || raw.startsWith("'")) ? raw.slice(1, -1) : raw;
    if (repeatableSecretValue(v)) into.add(v);
  }
}

function applySecretRules(text: string): string {
  const values = new Set<string>();
  collectSecretValues(text, values);
  let out = text.replace(AUTHZ_RE, "$1***");
  out = out.replace(COOKIE_LINE_RE, (_m, label: string, rest: string) => {
    const pairs = rest.replace(COOKIE_PAIR_RE, (pair, name: string) =>
      SAFE_COOKIE_ATTR_RE.test(name) ? pair : `${name}=***`);
    return label + pairs;
  });
  out = out.replace(JSON_SECRET_RE, (m, key: string, sep: string) =>
    isSecretKey(key) ? `"${key}"${sep}"***"` : m);
  out = out.replace(KV_CAMEL_RE, "$1$2***");
  out = out.replace(SELECTOR_VALUE_RE, "$1***$3");
  out = out.replace(TOKEN_SPACE_RE, "$1$2***");
  out = out.replace(KV_SECRETS_RE, "$1***");
  for (const v of values) out = out.split(v).join("***");
  return out;
}

/** Один уровень нормализации: URL-decode (%XX, %uXXXX, \uXXXX), HTML-entities и снятие JSON-экранирования. */
function normalizeOnce(s: string): string {
  return s
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%u([0-9A-Fa-f]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

/**
 * Маскирование значений секретных ключей в произвольном тексте: query, заголовки,
 * JSON-фрагменты (в том числе экранированные и URL-кодированные), cookie, плоский
 * текст. Перед правилами вход нормализуется (до 2 уровней URL-decode и снятия
 * JSON-экранирования, находка №2 ревью 147); нормализованный вид возвращается
 * только если на нём найден секрет, иначе текст уходит в исходном виде.
 */
export function maskSecrets(text: string): string {
  const direct = applySecretRules(text);
  let norm = direct;
  let deeper: string | null = null;
  // до неподвижной точки с потолком (m1 ревью 150): тройное URL-кодирование
  // не проходило при фиксированных 2 уровнях; потолок защищает от долгих циклов
  for (let level = 0; level < 4; level++) {
    const next = normalizeOnce(norm);
    if (next === norm) break;
    norm = next;
    const masked = applySecretRules(norm);
    if (masked !== norm) {
      deeper = masked;
      break;
    }
  }
  return deeper ?? direct;
}

/** Рекурсивное маскирование в деталях ошибки: по именам ключей, строки, массивы. */
export function maskSecretsDeep(value: unknown): unknown {
  if (typeof value === "string") return maskSecrets(value);
  if (Array.isArray(value)) {
    // пары [имя, значение] (списки заголовков) — значение маскируется по имени;
    // имя должно быть чистым идентификатором, а не строкой «ключ=значение»
    if (value.length === 2 && typeof value[0] === "string" && /^[A-Za-z0-9_-]+$/.test(value[0]) && isSecretKey(value[0])) {
      return [value[0], "***"];
    }
    return value.map(maskSecretsDeep);
  }
  if (value !== null && typeof value === "object") {
    if (value instanceof Error) {
      // Error-объект в details: только имя и диагностический код, message наружу не идёт
      // (находка №2 ревью 147: enumerable-свойства и message уводили секрет мимо правил).
      return { name: value.name, message: `*** (${diagnosticCode(value)})` };
    }
    if (value instanceof Date || value instanceof RegExp || value instanceof URL) {
      return maskSecrets(String(value));
    }
    const obj = value as Record<string, unknown>;
    // записи {name, value} (заголовки, cookie-джары) — значение маскируется по имени
    if (typeof obj["name"] === "string" && "value" in obj && isSecretKey(obj["name"])) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = k === "value" ? "***" : maskSecretsDeep(v);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      // секрет в ИМЕНИ ключа тоже маскируется (m3 ревью 150): {"/p?authkey=…": 1}
      const kk = typeof k === "string" ? maskSecrets(k) : k;
      // секретный ключ с объектным значением маскируется рекурсивно, а не целиком
      // (ревью 147 №6: {session:{object_id,plan_id}} не должен превращаться в "***")
      out[kk] = isSecretKey(k) && v !== null && typeof v === "object" && !Array.isArray(v)
        ? maskSecretsDeep(v)
        : isSecretKey(k)
          ? "***"
          : maskSecretsDeep(v);
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
 * (в stderr оно пишется замаскированным). Хешируется замаскированное
 * сообщение (ревью 147 №7) — код не становится оракулом для перебора секрета.
 */
export function diagnosticCode(e: unknown): string {
  const basis = e instanceof Error ? `${e.name}|${maskSecrets(e.message)}` : maskSecrets(String(e));
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
  // null/undefined и примитивы не должны ронять сериализацию (ревью 147 №5)
  const code = typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
  if (code === "NOT_FOUND" || code === "INVALID_ARGUMENT") {
    return { code, message: maskSecrets(e instanceof Error ? e.message : String(e)) };
  }
  const diag = diagnosticCode(e);
  const kind = e instanceof Error ? e.name : "Error";
  console.error(`[remplanner-mcp] необработанное исключение (${diag}): ${maskSecrets(e instanceof Error ? `${kind}: ${e.message}` : String(e))}`);
  return { code: "INTERNAL", message: `внутренняя ошибка: ${kind} (диагностический код ${diag})` };
}
