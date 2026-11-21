import type { ServerContext } from "./context.ts";
import { McpError } from "../errors.ts";

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
 * частичных (PRO_PARTIAL_TOOLS) — через assertProPartialAllowed. Ключи
 * частичных гейтов item_add/finish_floor_set/finish_wall_set — из эталонов
 * .orca-reports/tmp/328-pro-anon.json и 328-pro-sheets.json (листы waterplan/
 * sockets/light_connections/security/cables; PRO-покрытия «Полы» и «Отделка
 * стен» — разметка анонимного проекта, plannertool-ключи с is_pro).
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
  { tools: [...SHIELD_TOOLS], editorKeys: ["shield"], seniorOnly: true, label: "конструктор электрощитка" },
] as const;

/** Ключи каталога предметов (plannertool_* с is_pro, эталоны 328-pro-anon/
 *  328-pro-sheets.json — листы waterplan/sockets/light_connections/security/
 *  cables), которые ставятся item_add. */
export const PRO_ITEM_KEYS: readonly string[] = [
  // лист «Водоснабжение» (waterplan)
  "waterspot_cold", "waterspot_hot", "waterspot_drainage", "waterspot_collector",
  // лист «Розетки» (sockets)
  "floor_socket", "ceiling_socket", "furniture_socket",
  // лист «Выключатели» (light_connections)
  "light_switch_triple", "light_dimmer", "light_switch_through", "light_switch_through_double",
  "light_switch_cross", "light_switch_cross_double", "light_switch_master",
  // лист «Электропроводка» (cables)
  "electric_box", "electric_box_wall", "electric_kup",
  // лист «Безопасность» (security)
  "motion_sensor", "light_sensor", "water_leakage_panel", "water_leakage_sensor", "alarm_panel",
] as const;

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
 * тарифа. Ключи — из эталонов 328-pro-anon/328-pro-sheets.json.
 */
export const PRO_PARTIAL_TOOLS: Record<string, { editorKeys: readonly string[]; label: string }> = {
  // wall_add kind=partition material=glass|bar — ключи wall_create_glass/bar (PRO,
  // лист «Перегородки», эталон 328-pro-sheets.json); в гейт передаётся код модели
  // c_glass/c_bar (resolveWallMaterial, src/dto/walls.ts)
  wall_add: { editorKeys: ["c_glass", "c_bar"], label: "стеклянная и реечная перегородки" },
  // item_add по is_pro-ключам каталога (эталоны 328)
  item_add: { editorKeys: PRO_ITEM_KEYS, label: "PRO-предметы каталога (точки воды, розетки, выключатели, коробки, датчики)" },
  // PRO-покрытия пола
  finish_floor_set: { editorKeys: PRO_FLOOR_COVERS, label: "PRO-покрытия пола (керамогранит, метлах, мозаика, шестигранная плитка)" },
  // PRO-отделки стен (включая двухслойные и фартук)
  finish_wall_set: { editorKeys: PRO_WALL_COVERS, label: "PRO-отделки стен" },
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
 * Частичный гейт (ревью 329 №1/№2): инструмент гейтится только по is_pro-ключу
 * (материал/покрытие/позиция каталога из PRO_PARTIAL_TOOLS). Если ключ не PRO —
 * ничего не делает (как у бесплатного тарифа). Для is_pro-ключа — то же правило,
 * что у полного гейта: анонимный проект = бесплатный тариф, неизвестный тариф
 * трактуется как бесплатный.
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
  if (!partial.editorKeys.includes(key)) return;
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
