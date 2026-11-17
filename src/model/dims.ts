import type { Model, RulerEntity, RulerTarget, CommentEntity, Point, ItemProps } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, cmToMm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { McpError } from "../errors.ts";

/**
 * Размеры и комментарии (этап 113, 2026-11-17): ручные размеры (model.rulers,
 * кнопка «Добавить размер») и текстовые комментарии (model.comments, кнопка
 * «Текстовый комментарий», PRO в UI). Форматы — по эталонам
 * tests/fixtures/ui-ref-dims-*.json (пробы 113-dims-*, раздел docs
 * «remplanner-features.md §7.8»):
 * - линейка: p1/p2 (см), offset {val, side} (отступ размерной линии, side
 *   "a"|"l"|"r"), plan — лист ("a" — исходный, "furniture" — мебель), prs
 *   {room:0, mode:1}, color (палитра UI, дефолт #ed143d), show_everywhere;
 * - привязка конца к предмету: p1_target/p2_target {target_id, target_name,
 *   target_plan, target_angle, point_delta_x/y} — пересчитывается при переносе
 *   предмета (формула редактора Ruler.update: поворот delta на разницу углов);
 *   привязки к стенам/проёмам в редакторе нет (магнит только координатный);
 * - длина размера («Задать длину» в меню): 5..5000 см (LIB.correctValue);
 * - комментарий: points[], pc, text ≤ 600 символов, font_size 8..30 (дефолт 10),
 *   framed (по умолчанию true), color (палитра, дефолт #000000), url,
 *   label "free" (свободный) / "item" (привязан к предмету, один на предмет);
 * - цепочка размеров: p2_target {target_name:"ruler"} — при переносе p1
 *   источника конец цепочки следует (Ruler.checkLinkedRulers).
 */

/** Лимиты длины ручного размера (меню «Задать длину», LIB.correctValue(e,5,5e3)), см. */
export const RULER_LENGTH_MIN_CM = 5;
export const RULER_LENGTH_MAX_CM = 5000;

/** Лимиты текста комментария (textarea #cm-comment--input maxlength="600"). */
export const COMMENT_TEXT_MAX = 600;
/** Лимиты размера шрифта комментария (defs.comments: min 8, max 30, default 10). */
export const COMMENT_FONT_MIN = 8;
export const COMMENT_FONT_MAX = 30;
export const COMMENT_FONT_DEFAULT = 10;

/** Палитра цветов размера (контекстное меню #cm-ruler). */
export const RULER_COLORS = ["#000000", "#b51fc7", "#2fd498", "#148515", "#ed143d", "#219ce3", "#1f4fc7"] as const;
export const RULER_COLOR_DEFAULT = "#ed143d";
/** Палитра цветов комментария (контекстное меню #cm-comment). */
export const COMMENT_COLORS = ["#000000", "#148515", "#dc143c", "#1f4fc7", "#b51fc7", "#2fd498"] as const;
export const COMMENT_COLOR_DEFAULT = "#000000";

/** Листы, на которых пишутся размеры/комментарии (план "a" — исходный, "furniture" — мебель). */
export const DIM_SHEETS = ["a", "furniture"] as const;
export type DimSheet = (typeof DIM_SHEETS)[number];

/** Допуск сверки точек/смещений (см) — округления fixPoint редактора. */
export const DIM_POINT_TOL_CM = 0.11;
/** Допуск сверки угла привязки (градусы). */
export const DIM_ANGLE_TOL = 1;

/**
 * Отступ размерной линии: val > 0 допустим только со стороной "l"/"r" — с "a"
 * (авто, val 0) отрисовка редактора падает (LIB.parallel не знает сторону "a";
 * живая проба 113-live-check: NORMALIZATION_DROPPED на restore).
 */
function checkOffset(offsetMm: number | undefined, offsetSide: "a" | "l" | "r" | undefined): void {
  const val = offsetMm ?? 0;
  const side = offsetSide ?? "a";
  if (val > 0 && side === "a") {
    throw new McpError("INVALID_ARGUMENT", "offset_side: при отступе больше нуля нужна сторона l или r (side «a» — только при нулевом отступе, как в редакторе)", {
      details: { kind: "offset_side_required", offset_mm: val },
    });
  }
}

function cmPoint(p: MmPoint): Point {
  return { x: r2(mmToCm(p.x)), y: r2(mmToCm(p.y)) };
}

function requireFinitePoint(name: string, p: MmPoint): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new McpError("INVALID_ARGUMENT", `${name}: координаты должны быть конечными числами`);
  }
}

function rulerCollection(model: Model): Record<string, RulerEntity> {
  if (!model.rulers || typeof model.rulers !== "object") model.rulers = {};
  return model.rulers as Record<string, RulerEntity>;
}

function commentCollection(model: Model): Record<string, CommentEntity> {
  if (!model.comments || typeof model.comments !== "object") model.comments = {};
  return model.comments as Record<string, CommentEntity>;
}

/** Привязка конца размера к предмету (Ruler.target_temp, бандл app.3.0). */
function itemTarget(item: ItemProps, point: Point): RulerTarget {
  return {
    target_id: item.id,
    target_name: item.name,
    target_plan: structuredClone((item.plan ?? {}) as Record<string, number>),
    target_angle: item.angle ?? 0,
    point_delta_x: r2(item.pc.x - point.x),
    point_delta_y: r2(item.pc.y - point.y),
  };
}

export type AddRulerParams = {
  p1: MmPoint;
  p2: MmPoint;
  attach1?: string;
  attach2?: string;
  offsetMm?: number;
  offsetSide?: "a" | "l" | "r";
  sheet?: DimSheet;
  showEverywhere?: boolean;
  color?: string;
};

/**
 * dim_add: ручной размер по двум концам (мм). Неизвестный предмет привязки —
 * NOT_FOUND; вырожденный размер (нулевая длина) и длина вне 5..5000 см —
 * INVALID_ARGUMENT. Кандидат меняет только коллекцию rulers (apply — атомарность).
 */
export function addRuler(model: Model, params: AddRulerParams): RulerEntity {
  requireFinitePoint("p1", params.p1);
  requireFinitePoint("p2", params.p2);
  checkOffset(params.offsetMm, params.offsetSide);
  const sheet = params.sheet ?? "a";
  const p1 = cmPoint(params.p1);
  const p2 = cmPoint(params.p2);
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (len < RULER_LENGTH_MIN_CM || len > RULER_LENGTH_MAX_CM) {
    throw new McpError("INVALID_ARGUMENT", `длина размера ${Math.round(len * 10)} мм вне допустимого диапазона 50..50000 мм (лимит меню «Задать длину» редактора)`, {
      details: { kind: "length_out_of_range", length_mm: Math.round(len * 10) },
    });
  }
  const color = (params.color ?? RULER_COLOR_DEFAULT).toLowerCase();
  // каноническая форма редактора после протяжки (эталоны ui-ref-dims-*.json):
  // p1_target пишется только при привязке, p2_target — null после магнита без цели
  const entity: RulerEntity = {
    id: `_${newId(5)}`,
    p1,
    p2,
    offset: { val: params.offsetMm !== undefined ? r2(mmToCm(params.offsetMm)) : 0, side: params.offsetSide ?? "a" },
    plan: sheet,
    plan_: 0,
    prs: { room: 0, mode: 1 },
    p2_target: null,
    color,
  };
  if (params.showEverywhere) entity.show_everywhere = 1;
  if (params.attach1) {
    const item = model.items[params.attach1];
    if (!item) throw new McpError("NOT_FOUND", `предмет ${params.attach1} не найден (привязка начала размера)`);
    entity.p1_target = itemTarget(item, p1);
  }
  if (params.attach2) {
    const item = model.items[params.attach2];
    if (!item) throw new McpError("NOT_FOUND", `предмет ${params.attach2} не найден (привязка конца размера)`);
    entity.p2_target = itemTarget(item, p2);
  }
  rulerCollection(model)[entity.id] = entity;
  return entity;
}

export type UpdateRulerParams = {
  rulerId: string;
  p1?: MmPoint;
  p2?: MmPoint;
  attach1?: string | null;
  attach2?: string | null;
  offsetMm?: number;
  offsetSide?: "a" | "l" | "r";
  showEverywhere?: boolean;
  color?: string;
};

/** Длина оси размера, см. */
export function rulerLengthCm(r: { p1: Point; p2: Point }): number {
  return Math.hypot(r.p2.x - r.p1.x, r.p2.y - r.p1.y);
}

/**
 * Транзитивный пересчёт цепочек размеров (Ruler.checkLinkedRulers, проба
 * 113-ruler-src-full): конец прицепленного (p2_target.target_name "ruler")
 * следует за p1 источника; перенос p2 звена с привязкой p2_target→ruler двигает
 * p1 источника (общий конец цепочки «Разделить на участки»). Распространение —
 * до неподвижной точки с лимитом итераций (откат при несходимости — как у
 * транзитивных пересчётов этапа 47).
 */
function propagateLinkedRulers(model: Model, dirty: Array<{ rulerId: string; end: "p1" | "p2" }>): void {
  const rulers = rulerCollection(model);
  const queue = [...dirty];
  let guard = 0;
  while (queue.length > 0) {
    if (++guard > 1000) {
      throw new McpError("INVALID_GEOMETRY", "цепочка размеров не сходится (цикл привязок ruler→ruler) — мутация отменена");
    }
    const d = queue.shift()!;
    const x = rulers[d.rulerId];
    if (!x) continue;
    if (d.end === "p1") {
      for (const o of Object.values(rulers)) {
        if (o.p2_target && o.p2_target.target_name === "ruler" && o.p2_target.target_id === d.rulerId) {
          const np = { ...x.p1 };
          if (!pointEq(o.p2, np, 0)) {
            o.p2 = np;
            queue.push({ rulerId: o.id, end: "p2" });
          }
        }
      }
    } else {
      const t = x.p2_target;
      const y = t && t.target_name === "ruler" ? rulers[t.target_id] : undefined;
      if (y) {
        const np = { ...x.p2 };
        if (!pointEq(y.p1, np, 0)) {
          y.p1 = np;
          queue.push({ rulerId: y.id, end: "p1" });
        }
      }
    }
  }
}

/**
 * dim_update: перенос концов, привязки, отступ, цвет, «показать на всех листах».
 * attach1/attach2: null — отвязать конец, id — привязать к предмету. Как в
 * редакторе, перенос конца с сохранённой привязкой к предмету обновляет её
 * смещение (point_delta/target_angle — от текущего центра предмета). Перенос
 * концов транзитивно пересчитывает цепочку размеров (p2_target→ruler).
 */
export function updateRuler(model: Model, params: UpdateRulerParams): RulerEntity {
  const ruler = rulerCollection(model)[params.rulerId];
  if (!ruler) throw new McpError("NOT_FOUND", `размер ${params.rulerId} не найден в rulers`);
  const dirty: Array<{ rulerId: string; end: "p1" | "p2" }> = [];
  if (params.p1) {
    requireFinitePoint("p1", params.p1);
    ruler.p1 = cmPoint(params.p1);
    dirty.push({ rulerId: ruler.id, end: "p1" });
  }
  if (params.p2) {
    requireFinitePoint("p2", params.p2);
    ruler.p2 = cmPoint(params.p2);
    dirty.push({ rulerId: ruler.id, end: "p2" });
  }
  propagateLinkedRulers(model, dirty);
  for (const [key, attach] of [["p1_target", params.attach1], ["p2_target", params.attach2]] as const) {
    if (attach === undefined) {
      // перенос конца с сохранённой привязкой к предмету — смещение привязки обновляется
      const t = ruler[key];
      if (t && t.target_name !== "ruler") {
        const item = model.items[t.target_id];
        if (item) {
          const point = key === "p1_target" ? ruler.p1 : ruler.p2;
          t.target_angle = item.angle ?? 0;
          t.point_delta_x = r2(item.pc.x - point.x);
          t.point_delta_y = r2(item.pc.y - point.y);
          t.target_plan = structuredClone((item.plan ?? {}) as Record<string, number>);
        } else {
          ruler[key] = null;
        }
      }
      continue;
    }
    if (attach === null) {
      ruler[key] = null;
      continue;
    }
    const item = model.items[attach];
    if (!item) throw new McpError("NOT_FOUND", `предмет ${attach} не найден (привязка размера)`);
    ruler[key] = itemTarget(item, key === "p1_target" ? ruler.p1 : ruler.p2);
  }
  const len = rulerLengthCm(ruler);
  if (len < RULER_LENGTH_MIN_CM || len > RULER_LENGTH_MAX_CM) {
    throw new McpError("INVALID_ARGUMENT", `длина размера после изменения ${Math.round(len * 10)} мм вне допустимого диапазона 50..50000 мм`, {
      details: { kind: "length_out_of_range", length_mm: Math.round(len * 10) },
    });
  }
  const finalOffsetMm = params.offsetMm ?? (ruler.offset ? Math.round(ruler.offset.val * 10) : 0);
  const finalOffsetSide = (params.offsetSide ?? (ruler.offset?.side as "a" | "l" | "r" | undefined) ?? "a");
  checkOffset(finalOffsetMm, finalOffsetSide);
  if (params.offsetMm !== undefined || params.offsetSide !== undefined) {
    ruler.offset = { val: r2(mmToCm(finalOffsetMm)), side: finalOffsetSide };
  }
  if (params.showEverywhere !== undefined) {
    if (params.showEverywhere) ruler.show_everywhere = 1;
    else delete ruler.show_everywhere;
  }
  if (params.color !== undefined) ruler.color = params.color.toLowerCase();
  return ruler;
}

/**
 * dim_delete: размер удаляется; у других размеров, прицепленных к нему цепочкой
 * (p2_target.target_name "ruler"), привязка снимается — висячих ссылок нет
 * (в редакторе цепочка следует за p1, после удаления источника связь теряется).
 */
export function deleteRuler(model: Model, rulerId: string): void {
  const rulers = rulerCollection(model);
  if (!rulers[rulerId]) throw new McpError("NOT_FOUND", `размер ${rulerId} не найден в rulers`);
  for (const other of Object.values(rulers)) {
    if (other.id === rulerId) continue;
    if (other.p1_target?.target_id === rulerId && other.p1_target.target_name === "ruler") other.p1_target = null;
    if (other.p2_target?.target_id === rulerId && other.p2_target.target_name === "ruler") other.p2_target = null;
  }
  delete rulers[rulerId];
}

/** Снимает привязки размера к предмету (при удалении предмета, item_delete). */
export function detachRulerItemTargets(model: Model, itemId: string): string[] {
  const touched: string[] = [];
  for (const ruler of Object.values(rulerCollection(model))) {
    let changed = false;
    if (ruler.p1_target && ruler.p1_target.target_id === itemId && ruler.p1_target.target_name !== "ruler") {
      ruler.p1_target = null;
      changed = true;
    }
    if (ruler.p2_target && ruler.p2_target.target_id === itemId && ruler.p2_target.target_name !== "ruler") {
      ruler.p2_target = null;
      changed = true;
    }
    if (changed) touched.push(ruler.id);
  }
  return touched;
}

/**
 * Пересчёт привязанных размеров при переносе/повороте предмета (транзитивный
 * пересчёт затронутых привязок; формула Ruler.update бандла app.3.0): конец =
 * pc − R(target_angle − angle)·point_delta; привязка обновляется (новые delta и
 * угол). Цепочки размеров (target_name "ruler") следуют за p1 источника.
 */
export function refreshRulersForItem(model: Model, itemId: string): void {
  const item = model.items[itemId];
  if (!item) return;
  const dirty: Array<{ rulerId: string; end: "p1" | "p2" }> = [];
  for (const ruler of Object.values(rulerCollection(model))) {
    for (const key of ["p1_target", "p2_target"] as const) {
      const t = ruler[key];
      if (!t || t.target_id !== itemId || t.target_name === "ruler") continue;
      const dAngle = (((t.target_angle ?? 0) - (item.angle ?? 0)) * Math.PI) / 180;
      const cos = Math.cos(dAngle);
      const sin = Math.sin(dAngle);
      const s = (t.point_delta_x ?? 0) * cos + (t.point_delta_y ?? 0) * sin;
      const t2 = -(t.point_delta_x ?? 0) * sin + (t.point_delta_y ?? 0) * cos;
      const np: Point = { x: r2(item.pc.x - s), y: r2(item.pc.y - t2) };
      ruler[key === "p1_target" ? "p1" : "p2"] = np;
      t.target_angle = item.angle ?? 0;
      t.point_delta_x = r2(item.pc.x - np.x);
      t.point_delta_y = r2(item.pc.y - np.y);
      t.target_plan = structuredClone((item.plan ?? {}) as Record<string, number>);
      dirty.push({ rulerId: ruler.id, end: key === "p1_target" ? "p1" : "p2" });
    }
  }
  // Ruler.update_linked_ruler / checkLinkedRulers: цепочки следуют за перенесёнными концами
  propagateLinkedRulers(model, dirty);
}

export type AddCommentParams = {
  point: MmPoint;
  text: string;
  attachItem?: string;
  pc?: MmPoint;
  fontSize?: number;
  framed?: boolean;
  color?: string;
  url?: string;
  showEverywhere?: boolean;
  sheet?: DimSheet;
};

/** Текст комментария к канонической форме модели: ' → `, " → `` (Comments.copy("server")). */
export function escapeCommentText(text: string): string {
  return text.replace(/'/g, "`").replace(/"/g, "``");
}

/** Обратное преобразование к канонической форме — точно как Comments.restore редактора:
 *  ` → ' (проверено живой пробой 113-dims-escape: `` тоже сводится к '', то есть
 *  двойные кавычки редактор восстанавливает с потерей — факт раздела). */
export function unescapeCommentText(text: string): string {
  return text.replace(/`/g, "'");
}

/**
 * Канонизация входного текста (этап 116, ревью 115 R1): редактор при restore
 * сводит обратный апостроф к апострофу, а двойные кавычки (он же ``) — к двум
 * апострофам (проба 113-dims-escape). Вход канонизируется к виду, который
 * редактор покажет после restore: ` → ', " → ''. Записанный текст совпадает с
 * отображаемым, остаётся стабильным при copy/restore и не меняется сервером;
 * несовпадение с вводом инструмент возвращает warning'ом.
 */
export function canonicalCommentText(text: string): string {
  return text.replace(/`/g, "'").replace(/"/g, "''");
}

/**
 * comment_add: текстовый комментарий (PRO в UI — тарифный гейт кнопки нижней
 * панели; в модель на бесплатном тарифе комментарий также не проверен, см.
 * отчёт 113). Текст 1..600 символов, шрифт 8..30, framed по умолчанию true.
 * attachItem — привязать к предмету (label "item"): комментарий перемещается
 * вместе с предметом; в редакторе у предмета один такой комментарий.
 */
export function addComment(model: Model, params: AddCommentParams): CommentEntity {
  requireFinitePoint("point", params.point);
  const text = params.text;
  if (text.length === 0 || text.length > COMMENT_TEXT_MAX) {
    throw new McpError("INVALID_ARGUMENT", `текст комментария должен быть от 1 до ${COMMENT_TEXT_MAX} символов (лимит редактора)`, {
      details: { kind: "text_length", length: text.length },
    });
  }
  const fontSize = params.fontSize ?? COMMENT_FONT_DEFAULT;
  if (fontSize < COMMENT_FONT_MIN || fontSize > COMMENT_FONT_MAX) {
    throw new McpError("INVALID_ARGUMENT", `размер шрифта ${fontSize} вне допустимого диапазона ${COMMENT_FONT_MIN}..${COMMENT_FONT_MAX}`, {
      details: { kind: "font_size_out_of_range" },
    });
  }
  const sheet = params.sheet ?? "a";
  const point = cmPoint(params.point);
  const pc = params.pc ? cmPoint(params.pc) : point;
  const entity: CommentEntity = {
    id: `_${newId(5)}`,
    pc,
    points: [point],
    text: escapeCommentText(canonicalCommentText(text)),
    label: "free",
    plan: sheet,
    plan_: 0,
    prs: { room: 0, mode: 1 },
    name_item: "",
    color: params.color ?? COMMENT_COLOR_DEFAULT,
    font_size: fontSize,
    framed: params.framed ?? true,
  };
  if (params.url !== undefined) {
    if (!/^https?:\/\//i.test(params.url)) {
      throw new McpError("INVALID_ARGUMENT", "url комментария должен начинаться с http:// или https://", { details: { kind: "bad_url" } });
    }
    entity.url = params.url;
  }
  if (params.showEverywhere) entity.show_everywhere = 1;
  if (params.attachItem) {
    const item = model.items[params.attachItem];
    if (!item) throw new McpError("NOT_FOUND", `предмет ${params.attachItem} не найден (привязка комментария)`);
    const existing = Object.values(commentCollection(model)).find((c) => c.id_item === item.id);
    if (existing) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `у предмета ${item.id} уже есть комментарий ${existing.id} — в редакторе предмет несёт один комментарий; измените его comment_update или удалите comment_delete`,
        { details: { kind: "comment_already_exist", comment: existing.id } },
      );
    }
    entity.label = "item";
    entity.id_item = item.id;
    entity.name_item = item.name;
    // обратная ссылка предмета (props.comment.id) — как Comments.create редактора
    item.comment = { id: entity.id };
  }
  commentCollection(model)[entity.id] = entity;
  return entity;
}

/**
 * Комментарии предмета (label "item", id_item) следуют за предметом: точка-
 * указатель = центр предмета (как Comments.restore редактора — points=[pc]).
 */
export function refreshItemComments(model: Model, itemId: string): void {
  const item = model.items[itemId];
  if (!item) return;
  for (const c of Object.values(commentCollection(model))) {
    if (c.id_item === itemId) c.points = [{ x: item.pc.x, y: item.pc.y }];
  }
}

export type UpdateCommentParams = {
  commentId: string;
  text?: string;
  point?: MmPoint;
  pc?: MmPoint;
  fontSize?: number;
  framed?: boolean;
  color?: string;
  url?: string | null;
  showEverywhere?: boolean;
};

/** comment_update: текст, точка-указатель, пузырь, шрифт, рамка, цвет, ссылка. */
export function updateComment(model: Model, params: UpdateCommentParams): CommentEntity {
  const comment = commentCollection(model)[params.commentId];
  if (!comment) throw new McpError("NOT_FOUND", `комментарий ${params.commentId} не найден в comments`);
  if (params.text !== undefined) {
    if (params.text.length === 0 || params.text.length > COMMENT_TEXT_MAX) {
      throw new McpError("INVALID_ARGUMENT", `текст комментария должен быть от 1 до ${COMMENT_TEXT_MAX} символов`, { details: { kind: "text_length" } });
    }
    comment.text = escapeCommentText(canonicalCommentText(params.text));
  }
  if (params.point) {
    requireFinitePoint("point", params.point);
    comment.points = [cmPoint(params.point)];
  }
  if (params.pc) {
    requireFinitePoint("pc", params.pc);
    comment.pc = cmPoint(params.pc);
  }
  if (params.fontSize !== undefined) {
    if (params.fontSize < COMMENT_FONT_MIN || params.fontSize > COMMENT_FONT_MAX) {
      throw new McpError("INVALID_ARGUMENT", `размер шрифта ${params.fontSize} вне допустимого диапазона ${COMMENT_FONT_MIN}..${COMMENT_FONT_MAX}`, {
        details: { kind: "font_size_out_of_range" },
      });
    }
    comment.font_size = params.fontSize;
  }
  if (params.framed !== undefined) comment.framed = params.framed;
  if (params.color !== undefined) comment.color = params.color;
  if (params.url === null) delete comment.url;
  else if (params.url !== undefined) {
    if (!/^https?:\/\//i.test(params.url)) {
      throw new McpError("INVALID_ARGUMENT", "url комментария должен начинаться с http:// или https://", { details: { kind: "bad_url" } });
    }
    comment.url = params.url;
  }
  if (params.showEverywhere !== undefined) {
    if (params.showEverywhere) comment.show_everywhere = 1;
    else delete comment.show_everywhere;
  }
  return comment;
}

/** comment_delete: комментарий удаляется, обратная ссылка предмета снимается. */
export function deleteComment(model: Model, commentId: string): void {
  const comments = commentCollection(model);
  const comment = comments[commentId];
  if (!comment) throw new McpError("NOT_FOUND", `комментарий ${commentId} не найден в comments`);
  const item = comment.id_item ? (model.items[comment.id_item] as ItemProps | undefined) : undefined;
  if (item && item.comment && typeof item.comment === "object" && (item.comment as { id?: string }).id === commentId) {
    item.comment = { id: "" };
  }
  delete comments[commentId];
}

/**
 * Комментарии, привязанные к предмету (label "item") — item_delete удаляет их
 * каскадно (в редакторе unsetComment чистит ссылку предмета, сам комментарий
 * остаётся висячим; MCP снимает ссылку и удаляет комментарий — консервативнее).
 */
export function itemComments(model: Model, itemId: string): CommentEntity[] {
  return Object.values(commentCollection(model)).filter((c) => c.id_item === itemId);
}

/**
 * Список ссылок размеров на предмет (для запретов/снятия привязок при удалении).
 * item_delete: привязки снимаются (геометрия размеров сохраняется) — висячих
 * ссылок нет, в отличие от поведения редактора (проба 113-fixtures-after-item-delete).
 */
export function rulersReferencingItem(model: Model, itemId: string): RulerEntity[] {
  return Object.values(rulerCollection(model)).filter((r) =>
    (r.p1_target && r.p1_target.target_id === itemId && r.p1_target.target_name !== "ruler") ||
    (r.p2_target && r.p2_target.target_id === itemId && r.p2_target.target_name !== "ruler"));
}

/** Размер по site-id (id сайта; меток в model_get у размеров нет). */
export function resolveRuler(model: Model, ref: string): RulerEntity {
  const ruler = (model.rulers ?? {} as Record<string, RulerEntity>)[ref];
  if (!ruler) throw new McpError("NOT_FOUND", `размер ${ref} не найден (id из dims_list)`);
  return ruler;
}

/** Комментарий по site-id. */
export function resolveComment(model: Model, ref: string): CommentEntity {
  const comment = (model.comments ?? {} as Record<string, CommentEntity>)[ref];
  if (!comment) throw new McpError("NOT_FOUND", `комментарий ${ref} не найден (id из comments_list)`);
  return comment;
}

/** Список размеров (dims_list): entity + длины/отступ в мм. */
export function dimsList(model: Model): Array<RulerEntity & { length_mm: number; offset_mm: number }> {
  return Object.values(rulerCollection(model)).map((r) => ({
    ...structuredClone(r),
    length_mm: cmToMm(rulerLengthCm(r)),
    offset_mm: Math.round((r.offset?.val ?? 0) * 10),
  }));
}

/** Список комментариев (comments_list), текст в человеческой форме. */
export function commentsList(model: Model): CommentEntity[] {
  return Object.values(commentCollection(model)).map((c) => ({ ...structuredClone(c), text: unescapeCommentText(c.text) }));
}

// ---------- сверка (двухрежимная: normalize до save, save после GET) ----------

function pointEq(a: Point | undefined, b: Point | undefined, tol = DIM_POINT_TOL_CM): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}

/**
 * Сверка одной привязки (ревью 117 R2, уточнено ревью 119 R2): различаются две
 * формы — ruler-target (target_name "ruler", штатная форма Ruler.split() без
 * point_delta/target_plan/target_angle, эталон 113-ruler-src-full.json) и
 * item-target (привязка к предмету, с delta). Ruler-target сверяется по
 * target_id/target_name. У item-target наличие каждой компоненты point_delta_x/y
 * сравнивается отдельно: потеря или появление компоненты — расхождение
 * (серверная потеря поля пользовательских данных не должна проходить как
 * verified), присутствующие числа — с допуском DIM_POINT_TOL_CM; отсутствие
 * delta на обеих сторонах — не расхождение.
 * target_plan/target_angle — производные, не блокируют.
 */
function targetMismatches(label: string, expected: RulerTarget | null | undefined, got: RulerTarget | null | undefined, out: string[]): void {
  if (!expected && !got) return;
  if (!expected || !got) {
    out.push(`${label}: привязка ${expected ? "потеряна" : "появилась"} (${expected?.target_id ?? "—"} → ${got?.target_id ?? "—"})`);
    return;
  }
  if (expected.target_id !== got.target_id) {
    out.push(`${label}: привязка сменилась (${expected.target_id} → ${got.target_id})`);
    return;
  }
  if (expected.target_name !== got.target_name) out.push(`${label}: target_name привязки сменился (${expected.target_name} → ${got.target_name})`);
  if (expected.target_name === "ruler") return;
  const deltaAxisChanged = (axis: "x" | "y"): boolean => {
    const e = expected[`point_delta_${axis}`] as number | undefined;
    const g = got[`point_delta_${axis}`] as number | undefined;
    if (e === undefined && g === undefined) return false;
    if (e === undefined || g === undefined) return true;
    return Math.abs(e - g) > DIM_POINT_TOL_CM;
  };
  if (deltaAxisChanged("x") || deltaAxisChanged("y")) {
    out.push(`${label}: смещение привязки изменилось (delta ${expected.point_delta_x},${expected.point_delta_y} → ${got.point_delta_x},${got.point_delta_y})`);
  }
}

/**
 * Сверка ручных размеров: идентичности в обе стороны (потеря/лишний), по каждому
 * — концы, отступ, лист, цвет, show_everywhere и привязки (id и имя цели —
 * пользовательские; target_plan/target_angle — производные, не блокируют).
 */
export function rulerMismatches(expected: Record<string, RulerEntity>, got: Record<string, unknown>, label = "размер"): string[] {
  const out: string[] = [];
  const expIds = new Set(Object.keys(expected ?? {}));
  const gotIds = new Set(Object.keys(got ?? {}));
  for (const id of expIds) if (!gotIds.has(id)) out.push(`${label} ${id}: потерян`);
  for (const id of gotIds) if (!expIds.has(id)) out.push(`${label} ${id}: лишний на сервере`);
  for (const id of expIds) {
    if (!gotIds.has(id)) continue;
    const e = expected[id]!;
    const g = got[id] as RulerEntity;
    if (!pointEq(e.p1, g.p1) || !pointEq(e.p2, g.p2)) {
      out.push(`${label} ${id}: концы изменились (${JSON.stringify(e.p1)}–${JSON.stringify(e.p2)} → ${JSON.stringify(g.p1)}–${JSON.stringify(g.p2)})`);
    }
    const eo = e.offset ?? { val: 0, side: "a" };
    const go = g.offset ?? { val: 0, side: "a" };
    if (Math.abs((eo.val ?? 0) - (go.val ?? 0)) > DIM_POINT_TOL_CM || (eo.side ?? "a") !== (go.side ?? "a")) {
      out.push(`${label} ${id}: отступ изменился (${JSON.stringify(eo)} → ${JSON.stringify(go)})`);
    }
    if ((e.plan ?? "") !== (g.plan ?? "")) out.push(`${label} ${id}: лист изменился (${e.plan} → ${g.plan})`);
    if ((e.color ?? "") !== (g.color ?? "")) out.push(`${label} ${id}: цвет изменился (${e.color} → ${g.color})`);
    if (!!e.show_everywhere !== !!g.show_everywhere) out.push(`${label} ${id}: «показать на всех листах» изменилось`);
    targetMismatches(`${label} ${id} p1`, e.p1_target, (g as RulerEntity).p1_target, out);
    targetMismatches(`${label} ${id} p2`, e.p2_target, (g as RulerEntity).p2_target, out);
  }
  return out;
}

/**
 * Сверка комментариев: идентичности в обе стороны, по каждому — points, pc,
 * текст (в канонической форме с экранированием), label, шрифт, рамка, цвет,
 * ссылка, привязка к предмету, show_everywhere.
 */
export function commentMismatches(expected: Record<string, CommentEntity>, got: Record<string, unknown>, label = "комментарий"): string[] {
  const out: string[] = [];
  const expIds = new Set(Object.keys(expected ?? {}));
  const gotIds = new Set(Object.keys(got ?? {}));
  for (const id of expIds) if (!gotIds.has(id)) out.push(`${label} ${id}: потерян`);
  for (const id of gotIds) if (!expIds.has(id)) out.push(`${label} ${id}: лишний на сервере`);
  for (const id of expIds) {
    if (!gotIds.has(id)) continue;
    const e = expected[id]!;
    const g = got[id] as CommentEntity;
    const ePoints = Array.isArray(e.points) ? e.points : [];
    const gPoints = Array.isArray(g.points) ? g.points : [];
    if (ePoints.length !== gPoints.length || ePoints.some((p, i) => !pointEq(p, gPoints[i]))) {
      out.push(`${label} ${id}: точки-указатели изменились (${JSON.stringify(ePoints)} → ${JSON.stringify(gPoints)})`);
    }
    if (!pointEq(e.pc, g.pc)) out.push(`${label} ${id}: центр пузыря изменился (${JSON.stringify(e.pc)} → ${JSON.stringify(g.pc)})`);
    // сверка текста — по отображаемой (unescape) форме (этап 116, ревью 115 R1):
    // изменение текста сервером → расхождение, вариация байтов канонического
    // кодирования (' vs `) штатный save не блокирует
    if (unescapeCommentText(e.text ?? "") !== unescapeCommentText(g.text ?? "")) out.push(`${label} ${id}: текст изменился («${e.text}» → «${g.text}»)`);
    if ((e.label ?? "") !== (g.label ?? "")) out.push(`${label} ${id}: label изменился (${e.label} → ${g.label})`);
    if ((e.plan ?? "") !== (g.plan ?? "")) out.push(`${label} ${id}: лист изменился (${e.plan} → ${g.plan})`);
    if (Math.abs((e.font_size ?? COMMENT_FONT_DEFAULT) - (g.font_size ?? COMMENT_FONT_DEFAULT)) > 0.01) {
      out.push(`${label} ${id}: размер шрифта изменился (${e.font_size} → ${g.font_size})`);
    }
    if (!!e.framed !== !!g.framed) out.push(`${label} ${id}: рамка изменилась`);
    if ((e.color ?? "") !== (g.color ?? "")) out.push(`${label} ${id}: цвет изменился (${e.color} → ${g.color})`);
    if ((e.url ?? "") !== (g.url ?? "")) out.push(`${label} ${id}: ссылка изменилась`);
    if ((e.id_item ?? "") !== (g.id_item ?? "")) out.push(`${label} ${id}: привязка к предмету изменилась (${e.id_item ?? "—"} → ${g.id_item ?? "—"})`);
    if (!!e.show_everywhere !== !!g.show_everywhere) out.push(`${label} ${id}: «показать на всех листах» изменилось`);
  }
  return out;
}

/** Общая сверка раздела для слоя сохранения (workspace): got — коллекции {rulers, comments}. */
export function dimsMismatches(model: Model, got: Record<string, unknown>): string[] {
  return [
    ...rulerMismatches((model.rulers ?? {}) as Record<string, RulerEntity>, (got["rulers"] as Record<string, unknown> | undefined) ?? {}),
    ...commentMismatches((model.comments ?? {}) as Record<string, CommentEntity>, (got["comments"] as Record<string, unknown> | undefined) ?? {}),
  ];
}
