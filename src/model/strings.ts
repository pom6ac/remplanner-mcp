import { McpError } from "../errors.ts";
import type { Model } from "./types.ts";

/**
 * Строгий белый список строк, которые редактор вставляет в HTML/SVG без
 * экранирования (этап 377, major 376 №3 — stored-XSS через имя листа).
 * По бандлу 268-app.js:
 *  - CustomPlan.addIconToPage вставляет name в innerHTML вкладки нижней
 *    навигации БЕЗ экранирования (`<a …>${this.name} <span…`) →
 *    `$("#groups_navi").prepend/after(t)`;
 *  - CustomPlan.deleteIconHTML подставляет id в jQuery-селектор
 *    `'#groups_navi .groups_navi_item.custom[data-id="'+this.id+'"]'`,
 *    после_plan — в селектор `#groups_navi .groups_navi_item.plan_${after_plan}`;
 *  - подпись изображения (Picture.draw → IMAGE_LEGEND.text) и текст
 *    комментария (Comment.draw → .text) рисуются svg.js как SVG-текстовый
 *    узел (не innerHTML), но MCP консервативно отсекает в них < > &.
 * Правило: буквы (латиница/кириллица), цифры, пробельные символы и базовая
 * пунктуация БЕЗ < > & " ' ` — иначе INVALID_ARGUMENT на входе, а при
 * открытии уже сохранённого проекта с такими строками MCP не запускает
 * редактор в своём Chromium и предупреждает в ответе project_open.
 */

/** Белый список: буквы/цифры/пробел/пунктуация; < > & " ' ` запрещены. */
export const EDITOR_STRING_RE = /^[0-9A-Za-zА-Яа-яЁё\s.,:;!?()№+\-—–*/=_%@#«»…°²³]+$/u;

/** id сущностей, попадающий в jQuery-селекторы редактора. */
export const EDITOR_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Подпись изображения: < > & запрещены и в видимом тексте (кавычки/апостроф
 *  канонизируются в server-форму — см. pictures.ts; svg-текст рисуется как
 *  текстовый узел). */
export function isSafePictureText(text: string): boolean {
  return !/[<>&]/.test(text);
}

export function isSafeEditorString(v: string): boolean {
  return v.length > 0 && EDITOR_STRING_RE.test(v);
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

export type UnsafeStringHit = { collection: string; id: string; field: string; value: string };

/**
 * Поиск уже сохранённых опасных строк в модели (major 376 №3, путь открытия
 * проекта): имя/after_plan/id пользовательских листов — против белого списка,
 * подписи изображений — против < > &. Вызывается в Workspace.open; непустой
 * результат блокирует запуск редактора (ensureEditor) и попадает в warnings
 * ответа project_open.
 */
export function findUnsafeEditorStrings(model: Model): UnsafeStringHit[] {
  const out: UnsafeStringHit[] = [];
  const sheets = (model.custom_plans ?? {}) as Record<string, { name?: string; after_plan?: string }>;
  for (const [id, s] of Object.entries(sheets)) {
    if (!EDITOR_ID_RE.test(id)) out.push({ collection: "custom_plans", id, field: "id", value: id });
    if (s?.name !== undefined && !isSafeEditorString(s.name)) out.push({ collection: "custom_plans", id, field: "name", value: s.name });
    if (s?.after_plan !== undefined && !isSafeEditorString(s.after_plan)) out.push({ collection: "custom_plans", id, field: "after_plan", value: s.after_plan });
  }
  const pictures = (model.pictures ?? {}) as Record<string, { text?: string }>;
  for (const [id, p] of Object.entries(pictures)) {
    if (p?.text !== undefined && !isSafePictureText(p.text)) out.push({ collection: "pictures", id, field: "text", value: p.text });
  }
  return out;
}
