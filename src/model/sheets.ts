import type { Model, CustomPlanEntity } from "./types.ts";
export type { CustomPlanEntity };
import { newId } from "./types.ts";
import { McpError } from "../errors.ts";
import { assertSafeEditorString } from "./strings.ts";

/**
 * Пользовательские листы (этап 375, бандл app.3.0 — класс CustomPlan):
 * model.custom_plans[id] = {id, name, after_plan, content, date}. Лист виден
 * в нижней навигации как план `custom_<id>`; объекты (comments, free_figures,
 * pictures, freelines, thick_lines, rulers) привязываются к нему полем
 * `plan: "custom_<id>"`. after_plan — встроенный лист, ПОСЛЕ которого
 * вставляется вкладка (addIconToPage: "first" — в начало, иначе
 * #groups_navi .groups_navi_item.plan_<after_plan>; несуществующий ключ —
 * вкладка не показывается вовсе), content — какие содержимого редактора
 * видны на листе (hasContent; бандл: "plan" — стены/комнаты, "furniture_santeh",
 * "light", "electro_points"; чекбокс «plan» обязателен при любом другом
 * отмеченном — редактор не сохраняет content без plan).
 * date (с, floor(Date.now()/1000)) — порядок среди листов после одного
 * after_plan (addIconToPage идёт по убыванию date). Удаление листа редактором
 * каскадно удаляет объекты его плана (CustomPlan.delete).
 */

/** Встроенные листы (data-plan вкладок #groups_navi, разметка редактора,
 *  проба 375-sheets-ui); after_plan — "first" или один из них. */
export const SHEET_AFTER_PLANS: readonly string[] = [
  "init", "break_walls", "create_walls", "rooms", "radiators", "furniture",
  "santeh", "waterplan", "sockets", "light_connections", "light", "cables",
  "shield", "warm_floor", "conditioners", "ventilation", "security", "floor",
  "walls", "ceiling", "hydroisolation", "isolation", "shtukaturka",
  "projections", "styazhka",
];

/** Умолчание редактора в окне создания листа (select after_plan). */
export const SHEET_DEFAULT_AFTER_PLAN = "create_walls";

/** Что видно на пользовательском листе (CustomPlan.hasContent в бандле:
 *  "plan", "furniture_santeh", "light", "electro_points"). */
export const SHEET_CONTENT_KEYS: readonly string[] = [
  "plan", "furniture_santeh", "light", "electro_points",
];

export function sheetPlanKey(sheetId: string): string {
  return `custom_${sheetId}`;
}

function sheetMap(model: Model): Record<string, CustomPlanEntity> {
  model.custom_plans ??= {};
  return model.custom_plans as Record<string, CustomPlanEntity>;
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 60) {
    throw new McpError("INVALID_ARGUMENT", "имя листа — непустая строка до 60 символов", {
      details: { kind: "bad_name" },
    });
  }
  // major 376 №3 (ИБ): имя листа редактор вставляет в HTML вкладки без
  // экранирования (CustomPlan.addIconToPage → innerHTML) — строгий белый список
  return assertSafeEditorString(trimmed, "имя листа");
}

function validateAfterPlan(afterPlan: string): string {
  if (afterPlan !== "first" && !SHEET_AFTER_PLANS.includes(afterPlan)) {
    throw new McpError("INVALID_ARGUMENT", `after_plan должен быть «first» или встроенным листом (${SHEET_AFTER_PLANS.join(", ")})`, {
      details: { kind: "bad_after_plan", after_plan: afterPlan },
    });
  }
  return afterPlan;
}

function validateContent(content: string[]): string[] {
  const bad = content.filter((c) => !SHEET_CONTENT_KEYS.includes(c));
  if (bad.length > 0) {
    throw new McpError("INVALID_ARGUMENT", `content — список из ${SHEET_CONTENT_KEYS.join(", ")} (неизвестные ключи: ${bad.join(", ")})`, {
      details: { kind: "bad_content", unknown: bad },
    });
  }
  // бандл: «plan» особый — отмеченный другой пункт принудительно включает
  // «plan» (клик по чекбоксу), пустой список редактор сохраняет как []
  const out = [...new Set(content)];
  return out;
}

export function addSheet(
  model: Model,
  params: { name: string; afterPlan?: string; content?: string[] },
): CustomPlanEntity {
  const rec: CustomPlanEntity = {
    id: newId(10),
    name: validateName(params.name),
    after_plan: validateAfterPlan(params.afterPlan ?? SHEET_DEFAULT_AFTER_PLAN),
    content: validateContent(params.content ?? ["plan"]),
    date: Math.floor(Date.now() / 1000),
  };
  sheetMap(model)[rec.id] = rec;
  return rec;
}

export function updateSheet(
  model: Model,
  sheetId: string,
  params: { name?: string; afterPlan?: string; content?: string[] },
): CustomPlanEntity {
  const rec = sheetMap(model)[sheetId];
  if (!rec) throw new McpError("NOT_FOUND", `лист ${sheetId} не найден`);
  if (params.name !== undefined) rec.name = validateName(params.name);
  if (params.afterPlan !== undefined) rec.after_plan = validateAfterPlan(params.afterPlan);
  if (params.content !== undefined) rec.content = validateContent(params.content);
  return rec;
}

export type DeleteSheetResult = {
  deleted: Record<string, number>;
};

/** Коллекции объектов, привязанные к листу полем plan (CustomPlan.delete). */
const SHEET_PLAN_COLLECTIONS = [
  "comments", "free_figures", "pictures", "freelines", "thick_lines", "rulers",
] as const;

export function sheetObjectsOnPlan(model: Model, planKey: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const coll of SHEET_PLAN_COLLECTIONS) {
    const map = model[coll] as Record<string, { plan?: unknown }> | undefined;
    if (!map) continue;
    const ids = Object.entries(map).filter(([, v]) => v?.plan === planKey).map(([id]) => id);
    if (ids.length > 0) out[coll] = ids;
  }
  return out;
}

export function deleteSheet(model: Model, sheetId: string): DeleteSheetResult {
  const map = sheetMap(model);
  if (!map[sheetId]) throw new McpError("NOT_FOUND", `лист ${sheetId} не найден`);
  const planKey = sheetPlanKey(sheetId);
  const deleted: Record<string, number> = {};
  for (const coll of SHEET_PLAN_COLLECTIONS) {
    const m = model[coll] as Record<string, { plan?: unknown }> | undefined;
    if (!m) continue;
    let n = 0;
    for (const [id, v] of Object.entries(m)) {
      if (v?.plan === planKey) {
        delete m[id];
        n++;
      }
    }
    if (n > 0) deleted[coll] = n;
  }
  delete map[sheetId];
  return { deleted };
}

/** Лист по имени (для меток; сравнение без регистра и внешних пробелов). */
export function sheetByName(model: Model, name: string): CustomPlanEntity | undefined {
  const q = name.trim().toLowerCase();
  return Object.values(sheetMap(model)).find((s) => s.name.toLowerCase() === q);
}
