import type { ServerContext } from "./context.ts";
import { McpError } from "../errors.ts";
import { PRO_EDITOR_KEYS } from "./pro-editor-keys.generated.ts";
import { OPENING_KINDS } from "../model/openings.ts";
import { WS_SINGLE_SPOTS } from "../model/waterspots.ts";

/**
 * Единый реестр PRO-инструментов и один тарифный гейт (этап 328, пункт 3):
 * инструмент, помеченный is_pro в разметке редактора, на тарифе без PRO
 * возвращает NOT_AVAILABLE_ON_TARIFF (coverage.md §3, AGENTS.md правило 5).
 *
 * Эталон разметки: .orca-reports/tmp/328-pro-anon.json (анонимный проект =
 * бесплатный тариф, design §4; 792 из 1699 plannertool_* с классом is_pro) и
 * .orca-reports/tmp/328-pro-sheets.json (обход листов). Ключи — plannertool_<key>.
 *
 * Правило гейта: анонимный проект равен бесплатному тарифу (design §4),
 * неизвестный тариф трактуется как бесплатный. Удаление (_delete/remove) не
 * гейтится: ластик и контекстное меню «Удалить» в редакторе НЕ помечены is_pro
 * (удаление не открывает PRO-функциональность).
 *
 * До этапа 328 гейты были копиями (assertProMaterialAllowed для glass/bar,
 * assertShieldAllowed для shield_*), а zone_floor/zone_ceiling/led/stripe/
 * line_light/cable/wiring/pipe/warm_floor/finish-PRO-инструменты не гейтились
 * вовсе. Ревью 329 №1/№2: копии удалены — весь NOT_AVAILABLE_ON_TARIFF живёт
 * только здесь (проверяется тестом), инструментов реестра — через proGate,
 * частичных (PRO_PARTIAL_TOOLS) — через assertProPartialAllowed. Ревью 331
 * Н1/Н2: ключи частичных гейтов — из ЕДИНОГО сгенерированного списка
 * PRO_EDITOR_KEYS (эталон .orca-reports/tmp/328-pro-anon.json, анонимная
 * разметка без ПДн; генератор scripts/gen-pro-editor-keys.ts): item_add гейтит
 * весь список, opening_add — производные PRO_OPENING_KINDS (13 PRO-типов
 * дверей), wall_add переводит c_glass/c_bar в wall_create_glass/bar. Ключи
 * листов (waterplan/sockets/light_connections/security/cables; PRO-покрытия
 * «Полы» и «Отделка стен») входят в тот же список.
 * comment_add/update — PRO по coverage §3/§4 (кнопка «Текстовый комментарий»
 * закрыта за PRO; в анонимной разметке 328 ключ comment не встречается, гейт
 * консервативный по решению координатора). Каждому инструменту реестра — тест
 * с моком тарифа free (tests/unit/pro-gate.test.ts).
 */

export type ProToolGroup = {
  /** MCP-инструменты группы, которые гейтятся (add/update); _delete/_remove
   *  не гейтятся — ластик и «Удалить» в редакторе НЕ помечены is_pro. */
  tools: readonly string[];
  /** Ключи plannertool_* редактора с is_pro (эталон 328-pro-anon.json). */
  editorKeys: readonly string[];
  /** «Старшие тарифы PRO» (анонс 24.12.2025, щиток) — анонс, не разметка. */
  seniorOnly?: boolean;
  label: string;
};

/** Все shield_* — конструктор электрощитка (этап 255). */
const SHIELD_TOOLS = [
  "shield_rail_add", "shield_rail_delete",
  "shield_module_add", "shield_module_update", "shield_module_delete",
  "shield_wire_add", "shield_wire_delete",
  "shield_bus_add", "shield_bus_update", "shield_bus_delete",
  "shield_collector_add", "shield_collector_update", "shield_collector_delete",
] as const;

/**
 * Реестр по наземной разведке 328 (анонимный редактор, класс is_pro):
 * zone_floor/zone_ceiling/zone_hydroisolation/zone_floor_cap — PRO (ключ
 * plannertool_zone_floor/zone_ceiling; на листах «Гидроизоляция» и «Стяжка»
 * делитель тоже ключ zone_floor — эталон 328-pro-sheets.json); zone_c — НЕ PRO.
 * ceiling_rigel, ceiling_hole, floor_hole, complex_ceiling — НЕ PRO.
 */
export const PRO_TOOL_GROUPS: readonly ProToolGroup[] = [
  { tools: ["zone_floor_add"], editorKeys: ["zone_floor"], label: "зонирование пола" },
  { tools: ["zone_ceiling_add"], editorKeys: ["zone_ceiling"], label: "зонирование потолка" },
  { tools: ["zone_hydroisolation_add"], editorKeys: ["zone_floor (лист «Гидроизоляция»)"], label: "зонирование гидроизоляции" },
  { tools: ["zone_floor_cap_add"], editorKeys: ["zone_floor (лист «Стяжка»)"], label: "зонирование стяжки" },
  { tools: ["led_strip_add", "led_strip_update"], editorKeys: ["led_strip"], label: "светодиодная подсветка" },
  { tools: ["stripe_add", "stripe_update"], editorKeys: ["surface_stripe", "recessed_strip", "pendent_strip"], label: "трековые шины" },
  { tools: ["line_light_add", "line_light_update"], editorKeys: ["line_light"], label: "линейное освещение" },
  { tools: ["cable_add"], editorKeys: ["cable"], label: "соединительная линия выключатель → светильник" },
  { tools: ["wiring_add", "wiring_update"], editorKeys: ["wire_2_15", "wire_3_25", "… (34 типа кабелей)"], label: "электропроводка" },
  { tools: ["pipe_add", "pipe_update"], editorKeys: ["water_pipe", "water_hot_pipe", "drainage_pipe", "warm_floor_pipe", "conditioner_drainage", "heat_pipe_hot", "heat_pipe_cold", "ventpipe_out", "ventpipe_in"], label: "трубы" },
  { tools: ["warm_floor_add", "warm_floor_update"], editorKeys: ["warm_floor_wire", "warm_floor_water"], label: "тёплый пол" },
  { tools: ["finish_ceiling_niche_add"], editorKeys: ["ceiling_niche"], label: "закарнизная ниша" },
  { tools: ["finish_ceiling_molding_set"], editorKeys: ["molding"], label: "потолочный плинтус" },
  { tools: ["comment_add", "comment_update"], editorKeys: ["comment (кнопка «Текстовый комментарий»; coverage §3/§4)"], label: "текстовые комментарии" },
  { tools: ["finish_floor_molding_set"], editorKeys: ["floor_molding_plastic", "floor_molding_polyurethane", "floor_molding_mdf", "floor_molding_wood", "floor_molding_tile", "floor_molding_with_light", "floor_molding_hidden"], label: "плинтусы" },
  // «Нарисовать элемент» (этап 375): кнопка #freelines_opener нижней панели —
  // класс is_pro (проба 375-sheets-ui, не plannertool_* — в эталон
  // 328-pro-anon.json ключи нижней панели не входят); сводные линии
  // (freelines/thick_lines/free_figures) — всё подменю этой кнопки
  { tools: ["freeline_add", "freeline_update", "thick_line_add", "thick_line_update", "figure_add", "figure_update"], editorKeys: ["freelines_opener (кнопка «Нарисовать элемент», класс is_pro; проба 375-sheets-ui)"], label: "«Нарисовать элемент» (свободные линии, толстые линии, фигуры)" },
  { tools: [...SHIELD_TOOLS], editorKeys: ["shield"], seniorOnly: true, label: "конструктор электрощитка" },
] as const;

/**
 * ЕДИНЫЙ источник is_pro-ключей (ревью 331 Н1/Н2, решение координатора):
 * сгенерированный полный список из эталона разметки .orca-reports/tmp/
 * 328-pro-anon.json (файл src/server/pro-editor-keys.generated.ts, генератор
 * scripts/gen-pro-editor-keys.ts). Частичные гейты НЕ ведут своих списков —
 * ключ инструмента сверяется с этим одним списком (assertProPartialAllowed).
 */
export { PRO_EDITOR_KEYS };

/** PRO-типы проёмов (ревью 331 Н1): пересечение типов opening_add с эталоном —
 *  13 PRO-типов дверей (рото, книжка, гармошка, стеклянная, гаражные, каскадные
 *  и раздвижные системы). Производится от единого списка, не пишется руками. */
export const PRO_OPENING_KINDS: readonly string[] = Object.keys(OPENING_KINDS)
  .filter((k) => PRO_EDITOR_KEYS.includes(k))
  .sort();

/**
 * Одиночные выводы воды — PRO-ключи объединения waterspot_merge (этап 360):
 * merge делается в редакторе кликом ПРО-инструмента одиночного вывода на цель,
 * поэтому гейтится ключ part (waterspot_cold/hot/drainage — все PRO в эталоне
 * 328-pro-anon); разделение (unset) — контекстное меню комбинированного вывода
 * (free) и не гейтится. Производится от единого списка, не пишется руками.
 */
export const PRO_WATER_SPOT_SINGLES: readonly string[] = [...WS_SINGLE_SPOTS]
  .filter((k) => PRO_EDITOR_KEYS.includes(k))
  .sort();

/** Гейт item_add — по полному единому списку (ревью 331 Н2): любой is_pro-ключ
 *  каталога недоступен на free. Ключи, обслуживаемые другими инструментами
 *  (трубы, проводка, световые линии, зоны, плинтусы, покрытия), до item_add не
 *  доходят по смыслу (в реальном каталоге их не существует — NOT_FOUND до
 *  гейта), а ключи без частичного гейта инструмента (cap_*, isolation_*,
 *  plaster_* — отчёт 331; anchor_floor обслуживается finish_floor_anchor_set
 *  с этапа 347) в списке оставлены: они никогда не попадают в гейт item_add,
 *  но сторож-тест (pro-keys.test.ts) проверяет весь эталон целиком. */
export const PRO_ITEM_KEYS: readonly string[] = PRO_EDITOR_KEYS;

/** PRO-покрытия пола (лист «Напольные покрытия», разметка 328-pro-anon.json). */
export const PRO_FLOOR_COVERS: readonly string[] = ["stoneware_wood", "stoneware_marble", "metlah", "mosaic", "hex_tile"] as const;

/** PRO-отделки стен (лист «Отделка стен», разметка 328-pro-anon.json). */
export const PRO_WALL_COVERS: readonly string[] = [
  "wall_chalk_paint", "wall_clinker", "wall_stone", "wall_woodbatten", "wall_sheet_panels", "wall_tile_panels",
  "painting_tile", "wallpaper_tiles", "wall_apron",
] as const;

/**
 * Инструменты-исключения с частичным гейтом внутри инструмента (по ключу):
 * гейтится только обращение к is_pro-ключу, остальное — как у бесплатного
 * тарифа. Ревью 331 Н1/Н2: списки ключей НЕ ведутся вручную — item_add гейтит
 * по всему PRO_EDITOR_KEYS, opening_add по PRO_OPENING_KINDS (оба выведены из
 * единого эталона); покрытия floor/wall — подмножества того же эталона
 * (проверяется сторожем pro-keys.test.ts). wall_add: ключ модели c_glass/c_bar
 * переводится в ключ редактора wall_create_glass/bar.
 */
type ProPartial = { editorKeys: readonly string[]; label: string; toEditorKey?: (key: string) => string };
export const PRO_PARTIAL_TOOLS: Record<string, ProPartial> = {
  // wall_add kind=partition material=glass|bar — ключи редактора wall_create_glass/bar
  // (PRO, эталон 328); в гейт передаётся код модели c_glass/c_bar
  // (resolveWallMaterial, src/dto/walls.ts)
  wall_add: {
    editorKeys: ["wall_create_glass", "wall_create_bar"],
    label: "стеклянная и реечная перегородки",
    toEditorKey: (key) => (key === "c_glass" ? "wall_create_glass" : key === "c_bar" ? "wall_create_bar" : key),
  },
  // item_add по полному единому списку is_pro-ключей каталога (эталон 328)
  item_add: { editorKeys: PRO_ITEM_KEYS, label: "PRO-предметы каталога (полный список is_pro-ключей, src/server/pro-editor-keys.generated.ts)" },
  // PRO-типы дверей opening_add (13 типов, ревью 331 Н1)
  opening_add: { editorKeys: PRO_OPENING_KINDS, label: "PRO-типы дверей (рото, книжка, гармошка, стеклянная, гаражные, каскадные и раздвижные системы)" },
  // PRO-покрытия пола
  finish_floor_set: { editorKeys: PRO_FLOOR_COVERS, label: "PRO-покрытия пола (керамогранит, метлах, мозаика, шестигранная плитка)" },
  // PRO-отделки стен (включая двухслойные и фартук)
  finish_wall_set: { editorKeys: PRO_WALL_COVERS, label: "PRO-отделки стен" },
  // точка укладки пола — инструмент anchor_floor листа «Напольные покрытия» (этап 347).
  // Удаление якоря (at_mm=null) не гейтится — ластик в редакторе не помечен is_pro
  finish_floor_anchor_set: { editorKeys: ["anchor_floor"], label: "точка начала укладки покрытия пола" },
  // объединение выводов воды (этап 360): гейтится ключ part — одиночные выводы
  // (PRO-инструменты, клик на цель); разделение unset — не гейтится (контекстное меню)
  waterspot_merge: { editorKeys: PRO_WATER_SPOT_SINGLES, label: "одиночные выводы воды (объединение в комбинированный)" },
};

/** Все инструменты реестра, которые гейтятся (add/update). */
export function proGatedTools(): string[] {
  return PRO_TOOL_GROUPS.flatMap((g) => g.tools);
}

export type ProGateContext = Pick<ServerContext, "authStatus">;
export type ProGateProject = { anon: boolean } | null | undefined;

/** Ядро правила (для юнит-тестов): тариф без PRO — отказ. */
export function proGateError(label: string, tool: string, tariff: string): McpError {
  return new McpError(
    "NOT_AVAILABLE_ON_TARIFF",
    `${label} — PRO-инструмент редактора (is_pro); на тарифе без PRO он недоступен (тариф: ${tariff})`,
    { details: { tool, tariff, registry: "pro_tool_groups" } },
  );
}

/**
 * Единый тарифный гейт (этап 328): анонимный проект равен бесплатному тарифу
 * (design §4), неизвестный тариф трактуется как бесплатный. Бросает
 * NOT_AVAILABLE_ON_TARIFF; для shield (seniorOnly) — то же правило
 * («Расширенный» и старшие PARSE-ятся как tariff=pro, api.ts).
 */
export async function assertProToolAllowed(ctx: ProGateContext, project: { anon: boolean } | null | undefined, tool: string, label: string): Promise<void> {
  if (project?.anon) {
    throw new McpError(
      "NOT_AVAILABLE_ON_TARIFF",
      `${label} — PRO-инструмент редактора (is_pro); в анонимном проекте он недоступен`,
      { hint: "откройте проект PRO-аккаунта (project_open после входа)", details: { tool, tariff: "anon" } },
    );
  }
  const st = await ctx.authStatus();
  if (st.tariff !== "pro") throw proGateError(label, tool, st.tariff);
}

/**
 * Частичный гейт (ревью 329 №1/№2): инструмент гейтится только по is_pro-ключу.
 * Ревью 331 Н1/Н2: ключ (после перевода в ключ редактора, если инструмент
 * оперирует кодом модели — wall_add) сверяется с ЕДИНЫМ списком
 * PRO_EDITOR_KEYS (эталон 328-pro-anon.json, src/server/pro-editor-keys.generated.ts).
 * Если ключ не PRO — ничего не делает (как у бесплатного тарифа). Для
 * is_pro-ключа — то же правило, что у полного гейта: анонимный проект =
 * бесплатный тариф, неизвестный тариф трактуется как бесплатный.
 */
export async function assertProPartialAllowed(
  ctx: ProGateContext,
  project: { anon: boolean } | null | undefined,
  tool: string,
  key: string,
  hint?: string,
): Promise<void> {
  const partial = PRO_PARTIAL_TOOLS[tool];
  if (!partial) throw new McpError("INTERNAL", `инструмент ${tool} отсутствует в реестре частичных PRO-гейтов (src/server/pro.ts)`);
  const editorKey = partial.toEditorKey ? partial.toEditorKey(key) : key;
  if (!PRO_EDITOR_KEYS.includes(editorKey)) return;
  if (project?.anon) {
    throw new McpError(
      "NOT_AVAILABLE_ON_TARIFF",
      `«${key}» — PRO (${partial.label}); в анонимном проекте недоступно`,
      { hint: hint ?? "откройте проект PRO-аккаунта (project_open после входа)", details: { tool, key, tariff: "anon" } },
    );
  }
  const st = await ctx.authStatus();
  if (st.tariff !== "pro") {
    throw new McpError(
      "NOT_AVAILABLE_ON_TARIFF",
      `«${key}» — PRO (${partial.label}); на тарифе без PRO недоступно (тариф: ${st.tariff})`,
      { hint, details: { tool, key, tariff: st.tariff } },
    );
  }
}
