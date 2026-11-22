import { McpError } from "../errors.ts";
import type { Model } from "./types.ts";

/**
 * Строки, которые редактор вставляет в HTML/SVG без экранирования (этап 377,
 * major 376 №3 — stored-XSS через имя листа; фикс-2 379 — единая точка
 * проверки перед каждой передачей модели в Chromium). По бандлу 268-app.js
 * (обход ревью 378, скрипты 378-sinks*.mjs) строки модели попадают в стоки:
 *  - CustomPlan.addIconToPage — innerHTML вкладки нижней навигации:
 *    `data-plan="custom_${this.id}" data-id="${this.id}" data-date="${this.date}">${this.name} …`
 *    → `$("#groups_navi").prepend/after(t)` — name в позиции текстового узла,
 *    id/date — в позициях атрибутов;
 *  - CustomPlan.deleteIconHTML — id в кавычечном jQuery-селекторе
 *    `'#groups_navi .groups_navi_item.custom[data-id="'+this.id+'"]'`;
 *  - after_plan — три селектора: `.plan_${after_plan}` (без кавычек),
 *    `[data-plan='${after_plan}']` (change_group), `option[value="${after_plan}"]`
 *    (модалка правки листа);
 *  - date — атрибут data-date и арифметика (+data("date"), `<=`).
 * Подписи изображений и комментарии рисуются svg.js текстовым узлом (HTML-пути
 * нет), MCP консервативно отсекает в них < > &.
 *
 * Два уровня строгости (ревью 378 №14–16):
 *  - ВХОД (sheet_add/update/import, граница MCP): строгий белый список
 *    EDITOR_STRING_RE — символы stored-XSS (< > & " ' `) запрещены;
 *  - ОТКРЫТИЕ (чужие данные с сервера, findUnsafeEditorStrings): блокируется
 *    только РЕАЛЬНО ИСПОЛНИМОЕ в конкретном стоке (№16), чтобы имена листов,
 *    созданные в UI сайта (.val().trim() без фильтра), не блокировали
 *    сохранение/рендер: name — < (HTML-сущность в текстовом узле — не тег,
 *    №24); after_plan — кавычки, \ и ]; id/date — строго (атрибутные позиции,
 *    №14); не строковые значения полей и записи-не-объекты — fail-closed (№22).
 */

/** Белый список НА ВХОДЕ: буквы любых алфавитов Unicode (\p{L} — кириллица и ё,
 *  латиница с диакритикой, украинские/белорусские буквы), цифры, пробелы и
 *  базовая пунктуация, включая апостроф и «ёлочки»; < > & " ' ` запрещены. */
export const EDITOR_STRING_RE = /^[\p{L}\p{N}\s.,:;!?()№+\-—–*/=_%@#«»…°²³'’]+$/u;

/** id сущностей, попадающий в jQuery-селекторы редактора. */
export const EDITOR_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Подпись изображения: < > & запрещены и в видимом тексте (кавычки/апостроф
 *  канонизируются в server-форму — см. pictures.ts; svg-текст рисуется как
 *  текстовый узел). */
export function isSafePictureText(text: string): boolean {
  return !/[<>&]/.test(text);
}

/** Вход модельного слоя: отказ INVALID_ARGUMENT для строк вне белого списка. */
export function assertSafeEditorString(v: string, what: string): string {
  if (!isSafeEditorString(v)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `${what}: допустимы буквы/цифры/пробел и базовая пунктуация; символы < > & " ' \` запрещены ` +
        "(редактор вставляет эту строку в HTML без экранирования)",
      { details: { kind: "unsafe_string", field: what } },
    );
  }
  return v;
}

export function isSafeEditorString(v: string): boolean {
  return v.length > 0 && EDITOR_STRING_RE.test(v);
}

// ---------- Открытый путь (чужие данные с сервера): исполнимость в стоке ----------

/** name — текстовый узел innerHTML (addIconToPage): тег создаёт только
 *  буквальный `<`; HTML-сущность (&amp;, &#60;) декодируется в текст, а не в
 *  тег, поэтому блокировка сущностей снята как ложное срабатывание
 *  «&amp; как текст» (ревью 380 №24). Кавычки, апостроф, [ ] ~ — не исполнимы. */
export function isSafeSheetNameForOpen(name: string): boolean {
  return !name.includes("<");
}

/** after_plan — селекторы бандла: `.plan_${after_plan}` (без кавычек),
 *  `[data-plan='${after_plan}']` и `option[value="${after_plan}"]` —
 *  исполнимы кавычки (выход из кавычечного токена), \ и ]. */
export function isSafeSheetAfterPlanForOpen(v: string): boolean {
  return !/[<"'\\\]]/.test(v);
}

/** id — позиции атрибутов data-plan/data-id и кавычечного селектора
 *  deleteIconHTML: строго [A-Za-z0-9_-] (№14: бандл берёт ПОЛЕ id записи,
 *  а не ключ словаря — CustomPlans.restore: this[e[i].id]=new CustomPlan(e[i])). */
export function isSafeSheetIdForOpen(id: string): boolean {
  return EDITOR_ID_RE.test(id);
}

/** date — атрибут data-date="${date}" и арифметика порядка листов
 *  (+i.data("date"), this.date<=t): только конечное число. */
export function isSafeSheetDateForOpen(d: unknown): boolean {
  return typeof d === "number" && Number.isFinite(d);
}

export type UnsafeStringHit = { collection: string; id: string; field: string; value: string };

type SheetRec = { id?: unknown; name?: unknown; after_plan?: unknown; date?: unknown; content?: unknown };

/** Краткое представление не строкового значения для details (без данных модели). */
function jsonPreview(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/**
 * Поиск уже сохранённых опасных строк в модели (путь открытия проекта и ЕДИНАЯ
 * точка проверки перед передачей модели в Chromium — assertModelSafeForEditor).
 * Проверяются те поля, которые бандл реально вставляет в HTML/селекторы:
 * custom_plans — ключ и ПОЛЕ id (строго), date (число), name (innerHTML),
 * after_plan (селекторы), content (селектор `.custom_plan_content
 * input[value="…"]`, ревью 383 №34); pictures.text — < > & (консервативно,
 * svg-текст). Граница (ревью 383 №34, по бандлу): прочие поля ответа сервера
 * floors/switches/units HTML-стоков не имеют — switches приводится к boolean,
 * units идёт в селектор и l10n[...]→.text(), floors — геометрия и new Item.
 * Ревью 380 №22: fail-closed ПО ТИПУ — бандл берёт поля записи без приведения
 * (this.id=e.id||LIB.id(), this.name=e.name, this.after_plan=e.after_plan) и
 * вставляет в шаблон/конкатенацию, поэтому не строковое значение (массив,
 * объект с toString, число там, где ждётся строка) превращается в String(v)
 * и проходит в сток; такие значения — попадание. Запись custom_plans[k],
 * не являющаяся объектом, — тоже попадание (раньше молча пропускалась).
 * Вызывается в Workspace.open (warnings project_open) и в assertModelSafeForEditor.
 */
export function findUnsafeEditorStrings(model: Model): UnsafeStringHit[] {
  const out: UnsafeStringHit[] = [];
  const sheets = (model.custom_plans ?? {}) as Record<string, SheetRec>;
  for (const [key, s] of Object.entries(sheets)) {
    if (!EDITOR_ID_RE.test(key)) out.push({ collection: "custom_plans", id: key, field: "id", value: key });
    if (s === null || typeof s !== "object" || Array.isArray(s)) {
      out.push({ collection: "custom_plans", id: key, field: "record", value: jsonPreview(s) });
      continue;
    }
    const recId = typeof s.id === "string" ? s.id : key;
    const checkBundleField = (field: string, v: unknown, isBadString: (x: string) => boolean): void => {
      if (v === undefined || v === null) return;
      if (typeof v !== "string") {
        out.push({ collection: "custom_plans", id: recId, field, value: jsonPreview(v) });
        return;
      }
      if (isBadString(v)) out.push({ collection: "custom_plans", id: recId, field, value: v });
    };
    checkBundleField("id", s.id, (x) => !isSafeSheetIdForOpen(x));
    checkBundleField("name", s.name, (x) => !isSafeSheetNameForOpen(x));
    checkBundleField("after_plan", s.after_plan, (x) => !isSafeSheetAfterPlanForOpen(x));
    if (s.date !== undefined && !isSafeSheetDateForOpen(s.date)) {
      out.push({ collection: "custom_plans", id: key, field: "date", value: String(s.date) });
    }
    // ревью 383 №34: content бандл подставляет в кавычечный jQuery-селектор
    // '.custom_plan_content input[value="'+i.content[e]+'"]' (обработчик
    // .custom .edit) — тот же класс стока, что after_plan; проверяем ПО ТИПУ
    // (массив) и посимвольно тем же правилом, что after_plan. Ревью 385 №39:
    // пустой объект {} принимаем как пустой список (бандл создаёт content как
    // массив и читает через .length/in_array; иначе серверная форма {}
    // ложно отвергала бы модель), непустой объект — по-прежнему попадание
    if (s.content !== undefined && s.content !== null) {
      const content: unknown = typeof s.content === "object" && !Array.isArray(s.content) && Object.keys(s.content as object).length === 0
        ? []
        : s.content;
      if (!Array.isArray(content)) {
        out.push({ collection: "custom_plans", id: recId, field: "content", value: jsonPreview(content) });
      } else {
        for (const el of content as unknown[]) {
          if (typeof el !== "string" || !isSafeSheetAfterPlanForOpen(el)) {
            out.push({ collection: "custom_plans", id: recId, field: "content", value: typeof el === "string" ? el : jsonPreview(el) });
          }
        }
      }
    }
  }
  const pictures = (model.pictures ?? {}) as Record<string, { text?: unknown }>;
  for (const [id, p] of Object.entries(pictures)) {
    if (p === null || typeof p !== "object") {
      out.push({ collection: "pictures", id, field: "record", value: jsonPreview(p) });
      continue;
    }
    if (p.text !== undefined && p.text !== null && (typeof p.text !== "string" || !isSafePictureText(p.text))) {
      out.push({ collection: "pictures", id, field: "text", value: typeof p.text === "string" ? p.text : jsonPreview(p.text) });
    }
  }
  return out;
}

/**
 * ЕДИНАЯ точка проверки безопасности модели перед передачей в Chromium
 * (ревью 378 №14/№15): вызывается непосредственно перед каждой передачей —
 * перед запуском редактора (Workspace.ensureEditor → openEditor: страницу
 * загрузит и отрисует серверную модель сама) и перед каждым editor.normalize
 * (адаптер передаёт модель в page.evaluate → $Project.restore → addIconToPage).
 * Независимо от того, запущен ли уже редактор и каким путём пришла модель
 * (project_open, повторный open, import, undo/redo, reload после save).
 */
export function assertModelSafeForEditor(model: Model): void {
  const hits = findUnsafeEditorStrings(model);
  if (hits.length === 0) return;
  const u = hits[0]!;
  throw new McpError(
    "INVALID_ARGUMENT",
    `модель проекта содержит строку, которую редактор вставляет в HTML без экранирования (custom_plans/pictures: ${u.collection}[${u.id}].${u.field}) — передача модели в Chromium отменена (fail-closed)`,
    {
      hint: "переименуйте/удалите пользовательский лист на сайте в браузере или попросите пользователя это сделать; опасные строки в ответе не воспроизводятся",
      details: { unsafe_count: hits.length, first: { collection: u.collection, field: u.field, id: u.id } },
    },
  );
}
