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
  "set-cookie|session|sessionid|phpsessid|sessid|sid|csrf|xsrf|login|private_key|privatekey";

/**
 * true, если имя ключа/параметра — секретное. Совпадение «по вхождению с
 * границей слова»: access_token, x-auth-token, PHPSESSID, client_secret
 * ловятся так же, как точные имена (находка №2 ревью 147). Границы: слева —
 * не цифра и не буква (иначе «relogin:» маскируется как «login»); справа —
 * не строчная буква, т.е. цифра тоже граница: token2, password1, authkey2,
 * accessToken1 (M4 ревью 152).
 */
const IS_SECRET_KEY_RE = new RegExp(`(?:^|[^a-z0-9])(?:${SECRET_KEY_SOURCE})(?:$|[^a-z])`, "i");

/**
 * Явный короткий список НЕсекретных продолжений после секретного слова в
 * camelCase-ключе (m11 ревью 154, инверсия логики m8 ревью 152): продолжение
 * после секретного слова секретно по умолчанию (fail-closed), несекретное —
 * только если следующий после «_» шаг — одно из этих слов до границы
 * (конец или «_»): tokenCount, authMode, loginAttempts, passCount,
 * isSessionValid. Всё остальное (passwordHash, tokenValue, authHeader,
 * privateKey) — секрет.
 */
const NON_SECRET_CONTINUATION =
  "count|type|mode|attempts|status|expires|required|url|taken|name|enabled|valid|len|length|ttl|at|point";

/**
 * То же для camelCase-ключей после разбиения на слова. Отличие: «_», появившийся
 * от разбиения camelCase, — не граница справа, если продолжение — слово из
 * явного несекретного списка (m11 ревью 154: tokenCount, authMode,
 * loginAttempts — не секреты; passwordHash, tokenValue, authHeader — секреты).
 * Настоящий «_» из snake_case проверяется IS_SECRET_KEY_RE по сырому имени
 * (password_confirmation — секрет).
 */
const IS_SECRET_KEY_CAMEL_RE = new RegExp(
  `(?:^|[^a-z0-9])(?:${SECRET_KEY_SOURCE})(?:$|[^a-z_]|_(?!(?:${NON_SECRET_CONTINUATION})(?:$|[^a-z_])))`,
  "i",
);

/** true, если имя ключа/параметра — секретное. */
export function isSecretKey(name: string): boolean {
  const raw = name.trim();
  if (!raw) return false;
  // 1) по сырому имени (без разбиения): настоящие разделители (_ - .), цифры,
  //    начало/конец — границы; составные из этих же слов ловятся по конечному
  //    слову (accessToken → …token, APIKey → apikey, SessionID → sessionid).
  if (IS_SECRET_KEY_RE.test(raw.toLowerCase())) return true;
  // 2) camelCase (M1 ревью 150): разбиение на слова с границами из п.1;
  //    аббревиатуры разбиваются lookahead'ом — однобуквенное совпадение без
  //    отката, серия заглавных обрабатывается линейно (M5 ревью 154);
  //    «_» от перехода регистра — граница справа, только если продолжение не
  //    из несекретного списка (m11 ревью 154: fail-closed).
  const norm = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])(?=[A-Z][a-z])/g, "$1_")
    .toLowerCase();
  return IS_SECRET_KEY_CAMEL_RE.test(norm);
}

// Левая граница слова: не буквенно-цифровая (ревью 147 №6 — иначе «relogin:» маскируется как «login»).
const LEFT = "(?<![A-Za-z0-9])";

// key=value / key: value (query, form-тела, заголовки, плоский текст).
// Кандидат пары: ключ целиком + разделитель; секретность ключа проверяется
// isSecretKey (единый источник с JSON-правилом и details, M4 ревью 152):
// ключи с суффиксом после секретного слова (session_id=, SECRET_KEY=,
// x-session-id:) и с цифрой (token2=) маскируются так же, как ключи с
// секретным словом прямо перед «=». Значение — до разделителя (&, пробел,
// кавычка, ;, скобки); кавычкованное — целиком; у секретного ключа значение
// жадное (включая «=» и «:» — как до M4).
const KV_KEY_SEP_RE = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(["']?)(\s*[:=]\s*)/g;
const KV_VALUE_RE = /"[^"\r\n]*"|'[^'\r\n]*'|[^\s&"',;})\r\n\]]+/y;
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

/**
 * Секретные kv-пары (M4 ревью 152): ключ матчится целиком и проверяется
 * isSecretKey. Кандидат с не-секретным ключом не «съедает» своё значение:
 * сканирование продолжается со значения, чтобы вложенная секретная пара
 * (например «details: password<равно>…» или «{"error":"authkey<равно>…"}») была найдена.
 * Значение читается только после проверки ключа: не-секретные пары не стоят
 * жадного сканирования значения, поэтому цепочки «a=a=a=…» обрабатываются
 * за линейное время.
 */
function* kvSecretPairs(text: string): Generator<{ index: number; valueStart: number; end: number; value: string }> {
  const keys = new RegExp(KV_KEY_SEP_RE.source, "g");
  const valueRe = new RegExp(KV_VALUE_RE.source, "y");
  for (let m = keys.exec(text); m !== null; ) {
    const key = m[1]!;
    // секретность решает только isSecretKey: предфильтра по сырому ключу нет
    // (M6 ревью 154 — accessKey= и подобные после camel-разбиения); после
    // фикса M5 isSecretKey линеен, полной проверки не страшно звать на
    // каждого кандидата
    if (!isSecretKey(key)) {
      m = keys.exec(text); // продолжаем со значения: вложенные пары не должны «съедаться»
      continue;
    }
    valueRe.lastIndex = m.index + m[0].length;
    const vm = valueRe.exec(text);
    if (vm === null) {
      m = keys.exec(text); // разделитель без значения — не пара
      continue;
    }
    const valueStart = m.index + m[0].length;
    yield { index: m.index, valueStart, end: valueStart + vm[0].length, value: vm[0] };
    keys.lastIndex = valueStart + vm[0].length; // перепрыгиваем замаскированное значение
    m = keys.exec(text);
  }
}

function collectSecretValues(text: string, into: Set<string>): void {
  // значения, найденные после секретных ключей, маскируются во всём тексте:
  // секрет часто встречается повторно без ключа (находка №2 ревью 147);
  // одно kv-правило на все формы ключей — значения camelCase-ключей собираются
  // тоже (m9 ревью 152)
  for (const p of kvSecretPairs(text)) {
    const raw = p.value;
    const clean = raw.length > 1 && (raw.startsWith('"') || raw.startsWith("'")) ? raw.slice(1, -1) : raw;
    if (repeatableSecretValue(clean)) into.add(clean);
  }
  for (const m of text.matchAll(JSON_SECRET_RE)) {
    if (!isSecretKey(m[1]!)) continue;
    const raw = m[3] ?? "";
    const v = raw.length > 1 && (raw.startsWith('"') || raw.startsWith("'")) ? raw.slice(1, -1) : raw;
    if (repeatableSecretValue(v)) into.add(v);
  }
}

function replaceKvSecrets(text: string): string {
  let out = "";
  let last = 0;
  for (const p of kvSecretPairs(text)) {
    out += text.slice(last, p.valueStart) + "***";
    last = p.end;
  }
  return out + text.slice(last);
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
  out = replaceKvSecrets(out);
  out = out.replace(SELECTOR_VALUE_RE, "$1***$3");
  out = out.replace(TOKEN_SPACE_RE, "$1$2***");
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
