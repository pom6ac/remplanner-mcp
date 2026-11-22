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
 *    сохранение/рендер: name — < и & в позиции сущности; after_plan — кавычки,
 *    \ и ]; id/date — строго (атрибутные позиции, №14).
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

/** Сущность HTML (&amp;, &#39;, &#x27; — разбор innerHTML текстового узла).
 *  Одиночный & перед пробелом/пунктуацией («Кухня & гостиная») не сущность. */
const HTML_ENTITY_RE = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,10}|#x[0-9a-fA-F]{1,8});/;

/** name — текстовый узел innerHTML (addIconToPage): исполнимы < (начало тега)
 *  и & в позиции сущности. Кавычки, апостроф, [ ] ~ — не исполнимы. */
export function isSafeSheetNameForOpen(name: string): boolean {
  return !name.includes("<") && !HTML_ENTITY_RE.test(name);
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

type SheetRec = { id?: unknown; name?: unknown; after_plan?: unknown; date?: unknown };

/**
 * Поиск уже сохранённых опасных строк в модели (путь открытия проекта и ЕДИНАЯ
 * точка проверки перед передачей модели в Chromium — assertModelSafeForEditor).
 * Проверяются те поля, которые бандл реально вставляет в HTML/селекторы:
 * custom_plans — ключ и ПОЛЕ id (строго), date (число), name (innerHTML),
 * after_plan (селекторы); pictures.text — < > & (консервативно, svg-текст).
 * Вызывается в Workspace.open (warnings project_open) и в assertModelSafeForEditor.
 */
export function findUnsafeEditorStrings(model: Model): UnsafeStringHit[] {
  const out: UnsafeStringHit[] = [];
  const sheets = (model.custom_plans ?? {}) as Record<string, SheetRec>;
  for (const [key, s] of Object.entries(sheets)) {
    if (!EDITOR_ID_RE.test(key)) out.push({ collection: "custom_plans", id: key, field: "id", value: key });
    if (s === null || typeof s !== "object") continue;
    if (s.id !== undefined && typeof s.id === "string" && !isSafeSheetIdForOpen(s.id)) {
      out.push({ collection: "custom_plans", id: s.id, field: "id", value: s.id });
    }
    if (s.date !== undefined && !isSafeSheetDateForOpen(s.date)) {
      out.push({ collection: "custom_plans", id: key, field: "date", value: String(s.date) });
    }
    if (s.name !== undefined && typeof s.name === "string" && !isSafeSheetNameForOpen(s.name)) {
      out.push({ collection: "custom_plans", id: key, field: "name", value: s.name });
    }
    if (s.after_plan !== undefined && typeof s.after_plan === "string" && !isSafeSheetAfterPlanForOpen(s.after_plan)) {
      out.push({ collection: "custom_plans", id: key, field: "after_plan", value: s.after_plan });
    }
  }
  const pictures = (model.pictures ?? {}) as Record<string, { text?: string }>;
  for (const [id, p] of Object.entries(pictures)) {
    if (p?.text !== undefined && !isSafePictureText(p.text)) out.push({ collection: "pictures", id, field: "text", value: p.text });
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
