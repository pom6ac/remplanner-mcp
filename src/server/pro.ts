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
 * вовсе. Теперь один реестр + одна функция; каждому инструменту реестра — тест
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
  { tools: ["finish_floor_molding_set"], editorKeys: ["floor_molding_plastic", "floor_molding_polyurethane", "floor_molding_mdf", "floor_molding_wood", "floor_molding_tile", "floor_molding_with_light", "floor_molding_hidden"], label: "плинтусы" },
  { tools: [...SHIELD_TOOLS], editorKeys: ["shield"], seniorOnly: true, label: "конструктор электрощитка" },
] as const;

/** Инструменты-исключения с частичным гейтом внутри инструмента (kind/material). */
export const PRO_PARTIAL_TOOLS: Record<string, { editorKeys: readonly string[]; label: string }> = {
  // wall_add kind=partition material=glass|bar — ключи wall_create_glass/bar (PRO)
  wall_add: { editorKeys: ["wall_create_glass", "wall_create_bar"], label: "стеклянная и реечная перегородки" },
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
