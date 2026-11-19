// Сторож фикстур (аудит 65 A2; закрывает находки ревью 159): каждый
// tests/fixtures/*.json должен иметь _source; не содержать числовых ID
// проектов/планов/объектов сайта (≥ 6 цифр) — ни в id-подобных полях
// (id, plan_id, project_id, object_id, user_id — регистронезависимо, включая
// camelCase projectId/planId/objectId, и в роли ключа объекта), ни в свободном
// тексте файла (_source, комментарии, URL вида …/planner/?id=…); секретных
// значений в JSON-полях (список ключей — isSecretKey из src/errors.ts, единый
// источник с маскированием ошибок) и в форме ключ=значение; email (в том числе
// обфусцированного через [at]); абсолютных путей домашних каталогов.
// Для пяти эталонов ui-ref-{room,door,window,roomname,sofa} дополнительно
// запрещены внутренние ID сайта (EDITOR_ID_RE из scripts/anonymize.ts) — там
// обезличивание полное. Остальные фикстуры с внутренними ID анонимных проектов
// (editor-corridor-3rooms, ui-ref-rooms-save-*) — отдельная задача (m3 ревью 159).
// Исключения — только через allowlist ниже, с обоснованием.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isSecretKey } from "../../src/errors.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

// Фикстуры без _source. Пустой allowlist: любая запись требует обоснования в комментарии.
const ALLOW_NO_SOURCE = new Set<string>([]);

// Фикстура → список разрешённых числовых ID в полях id/plan_id/project_id/object_id.
// Формат: "файл:путь.к.полю" → обоснование.
const ALLOW_NUMERIC_IDS = new Map<string, string>([]);

// Фикстуры, для которых внутренние ID сайта (_xxxxx) запрещены полностью:
// обезличивание этих пяти эталонов сквозное (scripts/anonymize.ts).
const EDITOR_IDS_FORBIDDEN = new Set<string>([
  "ui-ref-room.json",
  "ui-ref-door.json",
  "ui-ref-window.json",
  "ui-ref-roomname.json",
  "ui-ref-sofa.json",
]);

// Внутренний ID сайта: подчёркивание + 5 символов, опционально суффикс _<число>.
// Копия EDITOR_ID_RE из scripts/anonymize.ts (импортировать из scripts нельзя:
// тесты не зависят от scripts).
export const EDITOR_ID_RE = /^_[a-z0-9]{5}(?:_\d+)?$/;

// Ключи, в которых числовое значение выглядит как ID проекта/плана/объекта
// сайта. Регистронезависимо и с camelCase-вариантами (projectId, planId,
// objectId, userId); user_id закрыт тоже (ревью 159, п.4).
const ID_KEYS = /^(id|plan_?id|project_?id|object_?id|user_?id)$/i;

// ID ≥ 6 цифр в роли ключа объекта: {"projects": {"123456": {…}}}.
const NUMERIC_KEY_RE = /^\d{6,}$/;

// Числовой ID ≥ 6 цифр в свободном тексте рядом со словом-маркером: «object_id
// 123456», «проект 123456», URL «/planner/?id=123456» (M1 ревью 159). Правило
// нарочито строгое (fail-closed): до 15 нецифровых символов между маркером и
// числом. На текущих фикстурах 0 срабатываний (проверено ревью 159 и тестами).
export const TEXT_ID_RE = /(?:\bid\b|object|plan|project|проект|объект)\D{0,15}\d{6,}/i;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
// Обфусцированный email: «user [at] gmail.com» (m4 ревью 159).
const EMAIL_OBFUSCATED_RE =
  /[a-zA-Z0-9._%+-]+\s*\[\s*at\s*\]\s*[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i;

// Запрещённые шаблоны в тексте файла: домашние каталоги трёх форм (m4 ревью 159)
// и секреты в форме ключ=значение. Регэксп ключ=значение собирается из частей,
// чтобы в этом файле не было литералов для grep-сканов.
const SECRET_KV_RE = (word: string): RegExp => new RegExp(`${word}\\s*${"="}`, "i");
const LEAK_RE = [
  /\/Users\//,
  /\/home\/[^/"\\]+/,
  /[A-Za-z]:\\+Users\\+/i,
  SECRET_KV_RE("authkey"),
  SECRET_KV_RE("password"),
];

export interface Violation {
  file: string;
  where: string;
  what: string;
}

/** Проблема с _source верхнего уровня (или null, если всё в порядке). */
export function sourceProblem(json: Record<string, unknown>): string | null {
  const source = json["_source"];
  return typeof source === "string" && source.trim().length > 20
    ? null
    : "нет _source (происхождение фикстуры не зафиксировано в артефакте)";
}

/** Обход JSON: id-поля, ключи-объекты, секреты в полях, внутренние ID сайта. */
export function scanFile(file: string, root: unknown): Violation[] {
  const out: Violation[] = [];
  const editorIdsForbidden = EDITOR_IDS_FORBIDDEN.has(file);
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const here = path ? `${path}.${k}` : k;
        if (ID_KEYS.test(k)) {
          const s = typeof v === "string" ? v : typeof v === "number" ? String(Math.trunc(v)) : "";
          if (/^\d{6,}$/.test(s)) {
            const allowKey = `${file}:${here}`;
            if (!ALLOW_NUMERIC_IDS.has(allowKey)) {
              out.push({ file, where: here, what: `числовой ID «${s}» (≥ 6 цифр) в поле ${k}` });
            }
          }
        }
        if (NUMERIC_KEY_RE.test(k)) {
          out.push({ file, where: here, what: `числовой ID «${k}» (≥ 6 цифр) в роли ключа объекта` });
        }
        // M2 ревью 159: секреты в JSON-полях. Только строковые значения —
        // числовой copy.session (счётчик редактора) секретом не считается.
        if (typeof v === "string" && v.trim() !== "" && isSecretKey(k)) {
          out.push({ file, where: here, what: `секретное значение в поле «${k}» — убрать` });
        }
        // m1 ревью 159: внутренние ID сайта в ключах и строковых значениях copy.
        if (
          editorIdsForbidden &&
          (EDITOR_ID_RE.test(k) || (typeof v === "string" && EDITOR_ID_RE.test(v)))
        ) {
          out.push({ file, where: here, what: `внутренний ID сайта «${k}» — заменить (scripts/anonymize.ts)` });
        }
        walk(v, here);
      }
    }
  };
  walk(root, "");
  return out;
}

// Текстовые правила одним списком для guardProblems и тестов.
const TEXT_RE: RegExp[] = [...LEAK_RE, EMAIL_RE, EMAIL_OBFUSCATED_RE, TEXT_ID_RE];

/** Все проблемы фикстуры (текст → JSON → обход). Для сторожа и синтетических тестов. */
export function guardProblems(file: string, text: string): string[] {
  const problems: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return [`файл не парсится как JSON: ${(e as Error).message}`];
  }
  const sp = sourceProblem(json as Record<string, unknown>);
  if (sp && !ALLOW_NO_SOURCE.has(file)) problems.push(sp);
  for (const v of scanFile(file, json)) problems.push(`${v.where}: ${v.what}`);
  for (const re of TEXT_RE) {
    if (re.test(text)) problems.push(`запрещённый шаблон ${re} в тексте файла`);
  }
  return problems;
}

for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort()) {
  test(`сторож фикстур: ${name}`, () => {
    const text = readFileSync(join(FIXTURES, name), "utf8");
    assert.deepEqual(
      guardProblems(name, text),
      [],
      "фикстура не проходит сторож: числовые ID/секреты/пути/email или нет _source",
    );
  });
}

// --- Ревью 185 №4: сторож покрывает и сгенерированные снимки в tests/unit ---
// (tests/unit/verify-golden.json, tests/unit/snapshots/*.json): те же правила
// утечек, но без требования _source — это артефакты тестов, а не фикстуры.
function collectJson(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (p === FIXTURES) continue;
    try {
      if (statSync(p).isDirectory()) collectJson(p, out);
      else if (e.endsWith(".json")) out.push(p);
    } catch { /* исчез между readdir и stat — не наша забота */ }
  }
  return out;
}

const UNIT_JSON_DIR = join(import.meta.dirname);

for (const path of collectJson(UNIT_JSON_DIR).sort()) {
  const name = relative(UNIT_JSON_DIR, path)!;
  test(`сторож снимков tests/unit: ${name}`, () => {
    const text = readFileSync(path, "utf8");
    const problems: string[] = [];
    let json: unknown;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      problems.push(`файл не парсится как JSON: ${(e as Error).message}`);
    }
    if (json !== undefined) for (const v of scanFile(name, json)) problems.push(`${v.where}: ${v.what}`);
    for (const re of TEXT_RE) if (re.test(text)) problems.push(`запрещённый шаблон ${re} в тексте файла`);
    assert.deepEqual(problems, [], "снимок tests/unit не проходит сторож: ID/секреты/пути/email");
  });
}

// ---------- Синтетические негативные тесты правил (формы из ревью 159) ----------
// Каждая форма — та, которую ревью 159 показало как пропущенную сторожом e18b824.
// Без соответствующего правила тест падает (форма уходит незамеченной).
// Значения ID и секретов синтетические.

const FILE = "synthetic.json";
const SRC = "снимок анонимного проекта в чистом browser context, без аккаунта";
const ID6 = "987654";
const ID7 = "9876543";

function assertCaught(text: string, label = "форма утечки", file: string = FILE): void {
  const problems = guardProblems(file, text);
  assert.ok(problems.length > 0, `${label}: правило не сработало, форма утечки пропущена`);
}

// --- M1: числовые ID в свободном тексте, URL, camelCase-ключах, ключах-объектах ---

test("ревью 159 M1: ID в свободном тексте _source", () => {
  assertCaught(JSON.stringify({ _source: `сценарий снятия, object_id ${ID6} упоминается в тексте` }));
  assertCaught(JSON.stringify({ _source: `анонимный проект ${ID6}, сценарий снятия` }));
});

test("ревью 159 M1: ID в URL с ?id=", () => {
  assertCaught(JSON.stringify({ _source: SRC, url: `/planner/?id=${ID6}` }));
});

test("ревью 159 M1: camelCase-ключи projectId/planId/objectId", () => {
  assertCaught(JSON.stringify({ _source: SRC, projectId: ID6 }));
  assertCaught(JSON.stringify({ _source: SRC, planId: ID6 }));
  assertCaught(JSON.stringify({ _source: SRC, objectId: ID6 }));
});

test("ревью 159 M1: ID в роли ключа объекта", () => {
  assertCaught(JSON.stringify({ _source: SRC, projects: { [ID6]: { name: "x" } } }));
});

test("ревью 159 M1: user_id с длинным числовым значением", () => {
  assertCaught(JSON.stringify({ _source: SRC, user_id: Number(ID7) }));
});

test("ревью 159 M1: регресс — id и plan_id ловятся как прежде", () => {
  assertCaught(JSON.stringify({ _source: SRC, id: ID6 }));
  assertCaught(JSON.stringify({ _source: SRC, plan_id: ID6 }));
});

test("ревью 159 M1: координаты, площади, хэши не дают ложных срабатываний", () => {
  assert.deepEqual(
    guardProblems(
      FILE,
      JSON.stringify({
        _source: SRC,
        copy: {
          walls: { w1: { p1: { x: -200, y: -150 }, p2: { x: 200, y: 150 }, area: 120000, hash: "ab12cd34ef" } },
        },
      }),
    ),
    [],
  );
});

// --- M2: секреты в JSON-полях (ключи — isSecretKey из src/errors.ts) ---

test("ревью 159 M2: секреты в JSON-полях", () => {
  for (const [k, v] of [
    ["authkey", "abcdef1234567890"],
    ["auth_key", "abcdef1234567890"],
    ["password", "p4ssw0rd-value"],
    ["token", "tok-1234567890"],
    ["access_token", "at-1234567890"],
    ["cookie", "PHPSESSID=abcdef123456"],
    ["set-cookie", "sid=abcdef123456"],
    ["sessionToken", "st-1234567890"],
    ["accessToken", "ac-1234567890"],
    ["sessionId", "se-1234567890"],
  ] as const) {
    assertCaught(JSON.stringify({ _source: SRC, [k]: v }), `секрет в поле ${k}`);
  }
});

test("ревью 159 M2: форма ключ=значение в строке ловится как прежде", () => {
  assertCaught(JSON.stringify({ _source: SRC, url: `/api/x?${"authkey"}${"="}${"abc"}` }));
});

test("ревью 159 M2: числовой счётчик session и tokenCount — не секреты", () => {
  assert.deepEqual(
    guardProblems(FILE, JSON.stringify({ _source: SRC, copy: { session: 39692, counter_saving_one_session: 0 }, meta: { tokenCount: 5 } })),
    [],
  );
});

// --- m1: внутренние ID сайта запрещены в пяти эталонах ui-ref-* ---

test("ревью 159 m1: внутренние ID сайта в ключах и значениях пяти эталонов", () => {
  assertCaught(
    JSON.stringify({ _source: SRC, copy: { walls: { _ab12c: { id: "_ab12c" } } } }),
    "ID в ключе и значении",
    "ui-ref-room.json",
  );
  assertCaught(
    JSON.stringify({ _source: SRC, copy: { link: { id_room: "_f00d0_2" } } }),
    "ID с числовым суффиксом",
    "ui-ref-door.json",
  );
});

test("ревью 159 m1: ключи вида p1_floor в пяти эталонах не срабатывают", () => {
  assert.deepEqual(
    guardProblems("ui-ref-room.json", JSON.stringify({ _source: SRC, copy: { walls: { w1: { p1_floor: 1, id: "id1" } } } })),
    [],
  );
});

// --- m4: пути /home/, C:\Users\ и обфусцированный email ---

test("ревью 159 m4: пути домашних каталогов трёх форм", () => {
  assertCaught(JSON.stringify({ _source: SRC, path: "/home/user/project/x" }));
  assertCaught(JSON.stringify({ _source: SRC, path: "C:\\Users\\me\\docs" }));
  assertCaught(JSON.stringify({ _source: SRC, path: `/${"Users"}/${"shared/x"}` }));
});

test("ревью 159 m4: обфусцированный email через [at]", () => {
  assertCaught(JSON.stringify({ _source: SRC, contact: "user [at] gmail.com" }));
  assertCaught(JSON.stringify({ _source: SRC, contact: "user[at]gmail.com" }));
});
