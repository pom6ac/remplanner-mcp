// Конструктор электрощитка (лист «Электрощиток», план shield, часть 3, 2026-11-20).
// Модель model.shields[shield.id] — рейки с модулями, ввод, провода (284), шины
// и коллекторы (291, живые эталоны ui-ref-shield-bus/collector). Формат —
// эталоны tests/fixtures/ui-ref-shield-*.json; исходники классов Shield/Rail/
// RailModule/ShieldInput — дампы разведки 255 (.orca-reports/tmp/255-*.json,
// вне git: 255-shield-scout/255-live-check в репозитории, 255-shield-classes —
// офлайн-дамп бандла app.3.0).
// Связь с предметом-щитком — shields[].shield_id = items[].id; предмет без записи
// редактор дополняет записью по умолчанию при restore (SHIELDS.restore) — модельный
// слой делает то же (ensureShield), чтобы сверка save не видела ложную потерю.
import type { Model, ItemProps, Shield, ShieldRail, ShieldModule, ShieldInput, ShieldPort, ShieldWire, ShieldBus, ShieldCollector } from "./types.ts";
import { newId } from "./types.ts";
import { McpError } from "../errors.ts";
import { MAX_SERVICE_COMMENT_CHARS, SHIELD_MAX_WIRES as SHIELD_MAX_WIRES_LIMIT, SHIELD_MAX_BUSES, SHIELD_MAX_COLLECTORS } from "../limits.ts";

/**
 * Предметы-щитки, к которым привязан конструктор (Item.isElectricShield("power"),
 * бандл app.3.0). lowcurrent-щитки в конструктор не входят.
 */
export const SHIELD_ITEM_NAMES = new Set(["electric_shield", "electric_shield_internal", "electric_shield_old"]);

/** Умолчания конструктора (ShieldDimensions.rail, бандл app.3.0). */
export const SHIELD_RAIL_MIN_DIN = 12;
export const SHIELD_RAIL_MAX_DIN = 48;

/**
 * Минимальный слот модуля в DIN (ShieldDimensions.module.slot, бандл app.3.0,
 * живая проба 284-dims: 0.5): порог reorder_modules — модуль шире слота ставится
 * только к началу соседа (вправо — только на позицию «конец соседа − слот»).
 */
export const SHIELD_MODULE_SLOT_DIN = 0.5;

/**
 * Типы проводов (инструменты shield_wire_* каталога UI; эталон 284):
 * тип провода = активный инструмент при add_wire_end.
 */
export const SHIELD_WIRE_TYPES = ["shield_wire_phase", "shield_wire_phase2", "shield_wire_phase3", "shield_wire_null", "shield_wire_earth"] as const;

/**
 * Типы модулей (ShieldDimensions.module_types, проба 255-shield-classes):
 * width — ширина в DIN, ports — число портов, group — у типа есть «номер группы»,
 * subtypes — номиналы, default_subtype — умолчание. 35 типов (все shield_module_*
 * каталога UI + shield_custom_module); shield_din — инструмент рейки, шины и
 * провода — вне ядра этого PR.
 */
export const SHIELD_MODULE_TYPES: Record<
  string,
  { width: number; ports: number; group?: boolean; subtypes?: readonly string[]; default_subtype?: string }
> = {
  shield_module: { width: 1, ports: 2, group: true, subtypes: ["6A", "10A", "16A", "20A", "25A", "32A", "40A", "50A", "63A"], default_subtype: "16A" },
  shield_module_x2_simple: { width: 2, ports: 4, group: true, subtypes: ["10A", "16A", "20A", "25A", "32A", "40A", "50A", "63A"], default_subtype: "16A" },
  shield_module_x3: { width: 3, ports: 6, group: true, subtypes: ["10A", "16A", "20A", "25A", "32A", "50A", "63A"], default_subtype: "16A" },
  shield_module_x4_simple: { width: 4, ports: 8, group: true, subtypes: ["10A", "16A", "20A", "25A", "32A", "50A", "63A"], default_subtype: "16A" },
  shield_module_x2: { width: 2, ports: 4, group: true, subtypes: ["10A/10mA", "16A/10mA", "16A/30mA", "20A/30mA", "25A/30mA", "32A/30mA", "40A/30mA", "40A/300mA", "50A/100mA", "63A/100mA", "63A/300mA"], default_subtype: "16A/30mA" },
  shield_module_x4: { width: 4, ports: 8, group: true, subtypes: ["10A/10mA", "16A/10mA", "16A/30mA", "20A/30mA", "25A/30mA", "32A/30mA", "40A/30mA", "40A/300mA", "50A/100mA", "63A/100mA", "63A/300mA"], default_subtype: "16A/30mA" },
  shield_module_input: { width: 2, ports: 4, subtypes: ["25A", "32A", "40A", "50A", "63A"], default_subtype: "50A" },
  shield_module_input_x4: { width: 4, ports: 8, subtypes: ["25A", "32A", "40A", "50A", "63A"], default_subtype: "50A" },
  shield_module_off_switch: { width: 1, ports: 2, subtypes: ["25A", "32A", "40A", "50A", "63A"], default_subtype: "32A" },
  shield_module_off_switch_double: { width: 2, ports: 4, subtypes: ["16A", "25A", "32A", "40A", "50A", "63A"], default_subtype: "32A" },
  shield_module_off_switch_x3: { width: 3, ports: 6, subtypes: ["16A", "20A", "25A", "32A", "40A", "50A", "63A"], default_subtype: "32A" },
  shield_module_off_switch_x4: { width: 4, ports: 8, subtypes: ["16A", "20A", "25A", "32A", "40A", "50A", "63A"], default_subtype: "32A" },
  shield_module_uzo: { width: 2, ports: 4, group: true, subtypes: ["16A/10mA", "16A/30mA", "25A/10mA", "25A/30mA", "40A/30mA", "63A/30mA"], default_subtype: "25A/30mA" },
  shield_module_uzo_x4: { width: 4, ports: 8, group: true, subtypes: ["25A/30mA", "40A/30mA", "63A/30mA"], default_subtype: "25A/30mA" },
  shield_module_uzo_fire: { width: 2, ports: 4, group: true, subtypes: ["40A/100mA", "63A/100mA", "63A/300mA"], default_subtype: "63A/300mA" },
  shield_module_uzo_fire_x4: { width: 4, ports: 8, group: true, subtypes: ["40A/100mA", "63A/100mA"], default_subtype: "63A/100mA" },
  shield_module_uzip: { width: 1, ports: 2 },
  shield_module_uzip_2x: { width: 2, ports: 3 },
  shield_module_uzip_4x: { width: 4, ports: 5 },
  shield_module_voltage: { width: 2, ports: 4, subtypes: ["32A", "40A", "50A", "63A"], default_subtype: "50A" },
  shield_module_voltage_x4: { width: 4, ports: 8, subtypes: ["63A"], default_subtype: "63A" },
  shield_module_impulse: { width: 1, ports: 6, group: true, subtypes: ["16A"], default_subtype: "16A" },
  shield_module_terminal: { width: 0.5, ports: 2 },
  shield_module_terminal_x2: { width: 1, ports: 4 },
  shield_module_din_bus: { width: 0.5, ports: 8 },
  shield_module_cross: { width: 4, ports: 14 },
  shield_module_cross_4x: { width: 4, ports: 28 },
  shield_module_contactor: { width: 1, ports: 6, subtypes: ["16A", "20A", "25A"], default_subtype: "20A" },
  shield_module_contactor_2din: { width: 2, ports: 6, subtypes: ["16A", "20A", "32A", "40A", "50A", "63A"], default_subtype: "20A" },
  shield_module_contactor_4din: { width: 4, ports: 10, subtypes: ["16A", "20A", "32A", "40A", "50A", "63A"], default_subtype: "20A" },
  shield_module_socket: { width: 3, ports: 3 },
  shield_module_counter: { width: 4, ports: 6 },
  shield_module_splitter: { width: 4, ports: 0 },
  shield_module_uvr: { width: 5, ports: 16, subtypes: ["63A"] },
  shield_custom_module: { width: 1, ports: 2, default_subtype: "16A" },
};

/** defs.shield.custom_module (бандл app.3.0): микроконструктор модуля. */
const CUSTOM_MODULE_DEFAULTS = { width: 1, ports: 1, type: "switch", subtype: "16A", label: "" };

const INPUT_PORT_TYPES = ["shield_wire_earth", "shield_wire_null", "shield_wire_phase"] as const;

/** Щиток без содержимого (Shield ctor + init_inputs): одна рейка, ввод с 3 портами. */
export function defaultShieldPorts(inputId: string): ShieldPort[] {
  return INPUT_PORT_TYPES.map((type) => ({
    id: newId(10),
    parent_type: "input",
    parent_id: inputId,
    type,
    connected: 0,
  }));
}

function newShieldInput(index = 0): ShieldInput {
  const input: ShieldInput = { id: newId(10), ports: [], index, phase: 1 };
  input.ports = defaultShieldPorts(input.id);
  return input;
}

/** Запись щитка по умолчанию для предмета (SHIELDS.restore: new Shield({shield_id})). */
export function defaultShieldForItem(itemId: string): Shield {
  const rail: ShieldRail = { id: newId(10), index: 0, modules: {} };
  // 284: ключ словаря inputs = id записи ввода (как сериализует редактор — эталон
  // ui-ref-shield-*: ключ == id); прежний код 255 создавал ключ новым newId,
  // из-за чего lookup порта по parent_id не находил ввод
  const input = newShieldInput();
  return {
    id: newId(10),
    shield_id: itemId,
    on_auto_length_rails: 1,
    length_rails: SHIELD_RAIL_MIN_DIN,
    rails: { [rail.id]: rail },
    buses: {},
    collectors: {},
    inputs: { [input.id]: input },
    wires: {},
  };
}

export function isShieldItem(item: ItemProps | undefined): boolean {
  return !!item && SHIELD_ITEM_NAMES.has(item.name);
}

/** Запись щитка предмета или null (связь по shield_id, как isElectricShield в редакторе). */
export function findShieldByItem(model: Model, itemId: string): Shield | null {
  for (const shield of Object.values(model.shields ?? {})) {
    if (shield.shield_id === itemId) return shield;
  }
  return null;
}

/** Запись щитка по id (или null). */
export function findShield(model: Model, shieldId: string): Shield | null {
  return (model.shields ?? {})[shieldId] ?? null;
}

/**
 * Гарантировать запись щитка для предмета-щитка: как редактор при restore
 * (SHIELDS.restore дополняет щитки без записи записью по умолчанию), чтобы
 * сверка save не объявляла штатную нормализацию потерей. Возвращает запись.
 */
export function ensureShieldForItem(model: Model, item: ItemProps): Shield {
  const existing = findShieldByItem(model, item.id);
  if (existing) return existing;
  if (!isShieldItem(item)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `предмет «${item.name}» не электрощиток (конструктор связан с предметами: ${[...SHIELD_ITEM_NAMES].join(", ")})`,
      { details: { kind: "not_shield_item", item: item.name } },
    );
  }
  const shield = defaultShieldForItem(item.id);
  (model.shields ??= {})[shield.id] = shield;
  return shield;
}

/** Запись щитка для предмета (ensure + проверка, что предмет существует). */
function shieldOfItem(model: Model, itemId: string): { shield: Shield; item: ItemProps } {
  const item = model.items?.[itemId];
  if (!item) throw new McpError("NOT_FOUND", `предмет ${itemId} не найден`);
  return { shield: ensureShieldForItem(model, item), item };
}

/** Ширина рейки в DIN (сумма ширин модулей; поле хранится в DIN — Shield.calc_rail_width). */
function railWidthDin(rail: ShieldRail): number {
  return Object.values(rail.modules).reduce((n, mod) => n + mod.width, 0);
}

/** Длина щитка в DIN при авто-режиме: максимум ширин рейки и минимума (редактор,
 *  переключение auto_length_rails: Math.max(...widths, min_length)). */
function autoLengthRails(shield: Shield): number {
  const widths = Object.values(shield.rails).map((r) => railWidthDin(r));
  return Math.max(...widths, SHIELD_RAIL_MIN_DIN);
}

function refreshAutoLength(shield: Shield): void {
  if (shield.on_auto_length_rails === 1) shield.length_rails = autoLengthRails(shield);
}

/** Максимальная длина рейки в DIN (Shield.get_rail_max_length). */
function railMaxLength(shield: Shield): number {
  return shield.on_auto_length_rails === 1 ? SHIELD_RAIL_MAX_DIN : (shield.length_rails ?? SHIELD_RAIL_MIN_DIN);
}

function commentClean(comment: string | undefined): string {
  if (comment === undefined) return "";
  const s = comment.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (s.length > MAX_SERVICE_COMMENT_CHARS) {
    throw new McpError("INVALID_ARGUMENT", `комментарий модуля длиннее ${MAX_SERVICE_COMMENT_CHARS} символов`);
  }
  return s;
}

/** Умолчание номинала без списка (RailModule ctor: e.subtype || dims.module.default_subtype,
 *  бандл app.3.0) — ревью 256 №1. */
export const SHIELD_MODULE_DEFAULT_SUBTYPE = "5A";

/** Типы модулей, из которых редактор собирает коллектор (ShieldDimensions.collector.types,
 *  живая проба 291-shield3-ui3/ui4). */
export const SHIELD_COLLECTOR_MODULE_TYPES: ReadonlySet<string> = new Set([
  "shield_module", "shield_module_x2_simple", "shield_module_x2", "shield_module_uzo",
  "shield_module_uzo_fire", "shield_module_x3", "shield_module_off_switch_x3",
]);

/** Номинал по правилам редактора (add_new_module + RailModule ctor):
 *  default_subtype ?? subtypes[0] ?? "5A". */
function defaultSubtypeOf(type: string): string {
  const def = SHIELD_MODULE_TYPES[type]!;
  return def.default_subtype ?? def.subtypes?.[0] ?? SHIELD_MODULE_DEFAULT_SUBTYPE;
}

/** Чистка номинала от управляющих символов (как у comment; редактор сериализует
 *  subtype строкой без переводов строк — ревью 256 №10). */
function subtypeClean(subtype: string): string {
  return subtype.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

function subtypeOf(type: string, subtype: string | undefined): string {
  const def = SHIELD_MODULE_TYPES[type]!;
  if (subtype === undefined) return defaultSubtypeOf(type);
  const clean = subtypeClean(subtype);
  // пустой/пробельный номинал — умолчание типа по цепочке редактора (258 №6):
  // RailModule ctor при restore делает e.subtype || default_subtype, «» в модель не попадает
  if (clean === "") return defaultSubtypeOf(type);
  if (def.subtypes && !def.subtypes.includes(clean)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `номинал «${subtype}» не из списка типа ${type} (${def.subtypes.join(", ")})`,
      { details: { kind: "bad_subtype", type, allowed: def.subtypes } },
    );
  }
  return clean;
}

/** railId по индексу (0-based, сортировка по полю index). */
function railByIndex(shield: Shield, railIndex: number): ShieldRail {
  const rails = Object.values(shield.rails).sort((a, b) => a.index - b.index);
  const rail = rails[railIndex];
  if (!rail) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `рейка ${railIndex} не найдена (в щитке ${rails.length} реек, индексы 0..${rails.length - 1})`,
    );
  }
  return rail;
}

/**
 * shield_rail_add: добавить DIN-рейку в конец (Shield.add_rail_to_shield:
 * index = число рейок). Щиток создаётся при отсутствии (предмет-щиток обязателен).
 */
export function addShieldRail(model: Model, itemId: string): Shield {
  const { shield } = shieldOfItem(model, itemId);
  const rail: ShieldRail = { id: newId(10), index: Object.keys(shield.rails).length, modules: {} };
  shield.rails[rail.id] = rail;
  return shield;
}

/**
 * shield_rail_delete: удалить рейку (Shield.delete_rail: модули рейки удаляются,
 * индексы последующих рейк уменьшаются). Последнюю рейку удалить нельзя
 * (редактор игнорирует удаление единственной рейки — get_count_rails() === 1).
 */
export function deleteShieldRail(model: Model, itemId: string, railRef: number | string): { shield: Shield; deleted_modules: string[]; deleted_wires: string[]; deleted_collectors: string[] } {
  const { shield } = shieldOfItem(model, itemId);
  const rail = typeof railRef === "number"
    ? railByIndex(shield, railRef)
    : (Object.values(shield.rails).find((r) => r.id === railRef) ?? (() => {
      throw new McpError("NOT_FOUND", `рейка ${railRef} не найдена`);
    })());
  if (Object.keys(shield.rails).length === 1) {
    throw new McpError(
      "INVALID_ARGUMENT",
      "последнюю DIN-рейку удалить нельзя (в редакторе удаление единственной рейки недоступно) — удалите щиток-предмет item_delete",
      { details: { kind: "last_rail" } },
    );
  }
  const deletedModules = Object.keys(rail.modules);
  delete shield.rails[rail.id];
  let i = 0;
  for (const r of Object.values(shield.rails).sort((a, b) => a.index - b.index)) r.index = i++;
  const cascade = validateShieldDerived(shield);
  refreshAutoLength(shield);
  return { shield, deleted_modules: deletedModules, deleted_wires: cascade.deleted_wires, deleted_collectors: cascade.deleted_collectors };
}

export type ShieldModuleAddParams = {
  /** Ключ модуля каталога UI (shield_module, shield_module_uzo, …). */
  type: string;
  /** Индекс рейки (0-based, по умолчанию 0). */
  rail?: number;
  /** Номинал (по умолчанию — default_subtype типа). */
  subtype?: string;
  /** Номер группы (только у типов с group). */
  group_number?: number;
  /** Подпись модуля. */
  comment?: string;
};

/**
 * shield_module_add: модуль на рейку (Shield.add_module + RailModule): позиция —
 * конец рейки (index = текущая ширина рейки), порты по типу, ширина рейки не
 * больше 48 DIN (при on_auto_length_rails=0 — length_rails). У shield_custom_module
 * умолчания микроконструктора — defs.shield.custom_module (width 1, ports ×2,
 * subtype "16A", custom {ports: 1, type: "switch", label: ""}).
 */
export function addShieldModule(model: Model, itemId: string, params: ShieldModuleAddParams): { shield: Shield; module: ShieldModule } {
  const def = SHIELD_MODULE_TYPES[params.type];
  if (!def) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `неизвестный тип модуля «${params.type}» (типы каталога: shield_module, shield_module_x2_simple, …, shield_custom_module — 35 типов; shield_din — рейка,shield_rail_add)`,
      { details: { kind: "unknown_module_type", allowed: Object.keys(SHIELD_MODULE_TYPES) } },
    );
  }
  const { shield } = shieldOfItem(model, itemId);
  const railIndex = params.rail ?? 0;
  const rail = railByIndex(shield, railIndex);
  const width = railWidthDin(rail);
  if (width + def.width > railMaxLength(shield)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `рейка ${railIndex} заполнена: ${width} + ${def.width} DIN больше лимита ${railMaxLength(shield)} — добавьте рейку (shield_rail_add)`,
      { details: { kind: "rail_full", rail: railIndex, width, module_width: def.width, max: railMaxLength(shield) } },
    );
  }
  if (params.group_number !== undefined) {
    if (!def.group) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `у типа ${params.type} нет «номера группы» (он есть у автоматов, УЗО и дифавтоматов)`,
        { details: { kind: "no_group_field", type: params.type } },
      );
    }
    if (!Number.isInteger(params.group_number) || params.group_number < 0 || params.group_number > 9999) {
      throw new McpError("INVALID_ARGUMENT", "group_number — целое 0..9999");
    }
  }
  const module: ShieldModule = {
    id: newId(10),
    rail_id: rail.id,
    index: width,
    width: def.width,
    type: params.type,
    group_number: params.group_number ?? 0,
    subtype: subtypeOf(params.type, params.subtype),
    comment: commentClean(params.comment),
    ports: Array.from({ length: def.ports }, () => ({} as ShieldPort)),
    custom: {},
  };
  for (const port of module.ports) {
    port.id = newId(10);
    port.parent_id = module.id;
    port.parent_type = "module";
    port.connected = 0;
  }
  if (params.type === "shield_custom_module") {
    module.width = CUSTOM_MODULE_DEFAULTS.width;
    module.subtype = params.subtype !== undefined ? (subtypeClean(params.subtype) || CUSTOM_MODULE_DEFAULTS.subtype) : CUSTOM_MODULE_DEFAULTS.subtype;
    module.custom = { ports: CUSTOM_MODULE_DEFAULTS.ports, type: CUSTOM_MODULE_DEFAULTS.type, label: CUSTOM_MODULE_DEFAULTS.label };
  }
  rail.modules[module.id] = module;
  refreshAutoLength(shield);
  return { shield, module };
}

export type ShieldModuleUpdateParams = {
  subtype?: string;
  group_number?: number;
  comment?: string;
  /** Перенос модуля на другую рейку (индекс 0-based; модуль ставится в конец
   *  рейки, как move_module_to_rail редактора). */
  rail?: number;
  /** Изменение порядка на рейке: целевая DIN-позиция (reorder_modules редактора). */
  index?: number;
};

/**
 * shield_module_update: номинал, номер группы, подпись (контекстное меню модуля
 * «#cm-rail-module»), перенос между рейками и изменение порядка (drag модуля:
 * move_module_to_rail / reorder_modules). Провода модуля не трогаются — порты
 * переезжают вместе с модулем (как в редакторе), in_transition в модели не
 * остаётся (флаг только на время drag).
 */
export function updateShieldModule(model: Model, itemId: string, moduleId: string, params: ShieldModuleUpdateParams): { shield: Shield; module: ShieldModule } {
  const { shield } = shieldOfItem(model, itemId);
  const mod = findShieldModule(shield, moduleId);
  if (!mod) throw new McpError("NOT_FOUND", `модуль ${moduleId} не найден в щитке предмета ${itemId}`);
  const def = SHIELD_MODULE_TYPES[mod.type];
  if (params.subtype !== undefined) {
    const clean = subtypeClean(params.subtype);
    // пустой/пробельный номинал — умолчание типа (258 №6, как в add)
    const next = clean === "" ? defaultSubtypeOf(mod.type) : clean;
    if (def?.subtypes && !def.subtypes.includes(next)) {
      throw new McpError(
        "INVALID_ARGUMENT",
      `номинал «${params.subtype}» не из списка типа ${mod.type} (${def.subtypes.join(", ")})`,
      { details: { kind: "bad_subtype", type: mod.type, allowed: def.subtypes } },
    );
  }
  mod.subtype = next;
}
  if (params.group_number !== undefined) {
    if (!def?.group) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `у типа ${mod.type} нет «номера группы» (он есть у автоматов, УЗО и дифавтоматов)`,
        { details: { kind: "no_group_field", type: mod.type } },
      );
    }
    if (!Number.isInteger(params.group_number) || params.group_number < 0 || params.group_number > 9999) {
      throw new McpError("INVALID_ARGUMENT", "group_number — целое 0..9999");
    }
    mod.group_number = params.group_number;
  }
  if (params.comment !== undefined) mod.comment = commentClean(params.comment);
  const railChanged = params.rail !== undefined && railIndexOf(shield, mod.rail_id) !== params.rail;
  if (railChanged) moveShieldModuleToRail(shield, mod, params.rail!);
  if (params.index !== undefined) reorderShieldModule(shield, mod, params.index, railChanged);
  // ревью 285 №8: перенос/порядок меняют распределение модулей по рейкам —
  // авто-длина щитка пересчитывается (delete/add её обновляют, update — нет)
  if (railChanged || params.index !== undefined) refreshAutoLength(shield);
  return { shield, module: mod };
}

/** Индекс рейки по её id (-1, если рейки нет — модуль без рейки). */
function railIndexOf(shield: Shield, railId: string): number {
  return Object.values(shield.rails).find((r) => r.id === railId)?.index ?? -1;
}

/** Принадлежит ли модуль коллектору (формат — живой эталон ui-ref-shield-collector,
 *  проба 291-shield3-ui3: modules — {moduleId: 1} на одной рейке). */
function moduleInCollector(shield: Shield, moduleId: string): boolean {
  return Object.values(shield.collectors ?? {}).some((c) => moduleId in (c.modules ?? {}));
}

/**
 * Перенос модуля на другую рейку (move_module_to_rail редактора): модуль ставится
 * в конец целевой рейки, позиции модулей старой рейки правее сдвигаются. MCP
 * строже редактора: редактор молча пропускает перенос, если модуль не влезает,
 * здесь — INVALID_ARGUMENT. Провода сохраняются (порты переезжают с модулем).
 */
export function moveShieldModuleToRail(shield: Shield, mod: ShieldModule, railIndex: number): void {
  if (moduleInCollector(shield, mod.id)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      "модуль входит в коллектор — сначала shield_collector_delete (перенос модулей коллектора редактором не поддержан)",
      { details: { kind: "module_in_collector" } },
    );
  }
  const target = railByIndex(shield, railIndex);
  const source = shield.rails[mod.rail_id];
  if (!source) throw new McpError("NOT_FOUND", `рейка модуля ${mod.rail_id} не найдена`);
  if (target.id === source.id) return;
  if (railWidthDin(target) + mod.width > railMaxLength(shield)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `рейка ${railIndex} заполнена: ${railWidthDin(target)} + ${mod.width} DIN больше лимита ${railMaxLength(shield)}`,
      { details: { kind: "rail_full", rail: railIndex } },
    );
  }
  const oldIndex = mod.index;
  delete source.modules[mod.id];
  for (const other of Object.values(source.modules)) {
    if (other.index > oldIndex) other.index -= mod.width;
  }
  mod.rail_id = target.id;
  mod.index = railWidthDin(target);
  target.modules[mod.id] = mod;
}

/**
 * Изменение порядка модуля на рейке (reorder_modules редактора): модуль ставится
 * в DIN-позицию index, модули между старой и новой позицией сдвигаются. MCP
 * строже редактора в двух случаях (редактор молча прерывает drag): позиция не
 * совпадает с началом модуля-соседа при ширине > 1 DIN и позиция за концом рейки.
 */
export function reorderShieldModule(shield: Shield, mod: ShieldModule, index: number, skipRailCheck = false): void {
  // слоты редактора — сетка 0.5 DIN (ShieldDimensions.module.slot, проба 284-dims)
  if (!Number.isFinite(index) || index < 0 || Math.abs(index * 2 - Math.round(index * 2)) > 1e-9) {
    throw new McpError("INVALID_ARGUMENT", `index — позиция на сетке 0.5 DIN ≥ 0, получено ${index}`);
  }
  if (moduleInCollector(shield, mod.id)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      "модуль входит в коллектор — сначала shield_collector_delete (порядок внутри коллектора редактор не меняет)",
      { details: { kind: "module_in_collector" } },
    );
  }
  const rail = shield.rails[mod.rail_id];
  if (!rail) throw new McpError("NOT_FOUND", `рейка модуля ${mod.rail_id} не найдена`);
  if (index === mod.index) return;
  if (!skipRailCheck && index > railWidthDin(rail) - SHIELD_MODULE_SLOT_DIN) {
    // как клэмп слота в get_module_slot редактора: курсор ограничен «заполнено − 0.5»,
    // поэтому последний доступный слот = конец заполненной части − 0.5 (модуль встанет последним)
    throw new McpError(
      "INVALID_ARGUMENT",
      `позиция ${index} за концом рейки (заполнено ${railWidthDin(rail)} DIN)`,
      { details: { kind: "index_out_of_rail", index, rail_width: railWidthDin(rail) } },
    );
  }
  const neighbor = Object.values(rail.modules).find((m) => index >= m.index && index < m.index + m.width);
  if (!neighbor) {
    // редактор ставит модуль только к началу другого модуля (слоты по DIN);
    // позиция «внутри» соседа недоступна
    throw new McpError(
      "INVALID_ARGUMENT",
      `позиция ${index} не начало модуля на рейке (перетаскивание в редакторе ставит модуль в слот соседа)`,
      { details: { kind: "no_module_at_slot", index } },
    );
  }
  if (neighbor.id === mod.id) return; // позиция внутри самого модуля — no-op (как reorder_modules редактора)
  if (moduleInCollector(shield, neighbor.id)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      "целевая позиция занята модулем из коллектора — сначала shield_collector_delete",
      { details: { kind: "module_in_collector" } },
    );
  }
  const e = neighbor.index;
  const w = neighbor.width;
  if (index < mod.index) {
    if (w > SHIELD_MODULE_SLOT_DIN && e !== index) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `модуль шире ${SHIELD_MODULE_SLOT_DIN} DIN нельзя поставить в позицию ${index} (начало соседа в ${e}) — как в редакторе`,
        { details: { kind: "bad_slot", index, neighbor_index: e } },
      );
    }
    for (const other of Object.values(rail.modules)) {
      if (other.id !== mod.id && other.index >= index && other.index <= mod.index) other.index += mod.width;
    }
  } else {
    if (w > SHIELD_MODULE_SLOT_DIN && e + w - SHIELD_MODULE_SLOT_DIN !== index) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `модуль шире ${SHIELD_MODULE_SLOT_DIN} DIN нельзя поставить в позицию ${index} (сосед занимает ${e}..${e + w}) — как в редакторе`,
        { details: { kind: "bad_slot", index, neighbor_index: e, neighbor_width: w, expected_index: e + w - SHIELD_MODULE_SLOT_DIN } },
      );
    }
    for (const other of Object.values(rail.modules)) {
      if (other.id !== mod.id && other.index <= index && other.index >= mod.index) other.index -= mod.width;
    }
    if (mod.width > SHIELD_MODULE_SLOT_DIN) index -= mod.width - SHIELD_MODULE_SLOT_DIN;
  }
  mod.index = index;
}

/** Модуль щитка по id (по всем рейкам). */
export function findShieldModule(shield: Shield, moduleId: string): ShieldModule | null {
  for (const rail of Object.values(shield.rails)) {
    const mod = rail.modules[moduleId];
    if (mod) return mod;
  }
  return null;
}

/**
 * shield_module_delete: удалить модуль (Shield.delete_module): индексы модулей
 * правее уменьшаются на ширину удалённого, длина щитка при авто-режиме
 * пересчитывается. Провода к портам модуля и коллекторы с <2 модулями удаляются
 * каскадом (validate_wires/validate_collectors редактора — удаление молча).
 */
export function deleteShieldModule(model: Model, itemId: string, moduleId: string): { shield: Shield; deleted_wires: string[]; deleted_collectors: string[] } {
  const { shield } = shieldOfItem(model, itemId);
  const mod = findShieldModule(shield, moduleId);
  if (!mod) throw new McpError("NOT_FOUND", `модуль ${moduleId} не найден в щитке предмета ${itemId}`);
  const rail = shield.rails[mod.rail_id];
  if (rail) {
    delete rail.modules[mod.id];
    for (const other of Object.values(rail.modules)) {
      if (other.index > mod.index) other.index -= mod.width;
    }
  }
  const cascade = validateShieldDerived(shield);
  refreshAutoLength(shield);
  return { shield, deleted_wires: cascade.deleted_wires, deleted_collectors: cascade.deleted_collectors };
}

// ---------- Провода (этап 284) ----------

export type ShieldPortRef = {
  /** Модуль: id модуля + номер порта (0-based, порядок ports модуля). */
  module_id?: string;
  /** Номер порта модуля. */
  port?: number;
  /** Порт ввода: phase | null | earth. */
  input?: "phase" | "null" | "earth";
  /** Порт шины: id шины + номер порта (0-based, порядок ports шины). */
  bus?: string;
};

const INPUT_PORT_TYPE_BY_KEY: Record<string, string> = {
  phase: "shield_wire_phase",
  null: "shield_wire_null",
  earth: "shield_wire_earth",
};

/** Все порты щитка (модули, вводы, шины) → карта id → {parent_type, parent_id}. */
function shieldPorts(shield: Shield): Map<string, { parent_type: string; parent_id: string }> {
  const out = new Map<string, { parent_type: string; parent_id: string }>();
  for (const rail of Object.values(shield.rails)) {
    for (const mod of Object.values(rail.modules)) {
      for (const p of mod.ports ?? []) out.set(p.id, { parent_type: "module", parent_id: mod.id });
    }
  }
  for (const input of Object.values(shield.inputs)) {
    for (const p of input.ports ?? []) out.set(p.id, { parent_type: "input", parent_id: input.id });
  }
  for (const bus of Object.values(shield.buses ?? {}) as Array<{ id: string; ports?: ShieldPort[] }>) {
    for (const p of bus.ports ?? []) out.set(p.id, { parent_type: "bus", parent_id: bus.id });
  }
  return out;
}

/**
 * Пересчёт производных щитка после операций с модулями/рейками/вводами — как
 * validate_wires/validate_ports/validate_buses/validate_collectors редактора:
 * провода с исчезнувшими портами удаляются молча, connected портов
 * пересчитывается по проводам, connection шины — по первому подключённому
 * порту, коллекторы с <2 модулями или потерянным модулем удаляются.
 */
export function validateShieldDerived(shield: Shield): { deleted_wires: string[]; deleted_collectors: string[] } {
  const ports = shieldPorts(shield);
  const deletedWires: string[] = [];
  for (const [id, wire] of Object.entries(shield.wires ?? {})) {
    if (!ports.has(wire.id_source) || !ports.has(wire.id_target)) {
      delete shield.wires![id];
      deletedWires.push(id);
    }
  }
  refreshShieldConnections(shield, ports);
  // validate_collectors: коллектор с <2 модулями или потерянным модулем удаляется
  const deletedCollectors: string[] = [];
  for (const [id, col] of Object.entries(shield.collectors ?? {})) {
    const known = Object.keys(col.modules ?? {}).filter((mid) => findShieldModule(shield, mid));
    if (known.length < 2) {
      delete shield.collectors![id];
      deletedCollectors.push(id);
    }
  }
  return { deleted_wires: deletedWires, deleted_collectors: deletedCollectors };
}

/**
 * validate_ports + validate_buses редактора (ревью 285 №6): connected портов по
 * живым проводам и connection шины — без удаления висячих проводов и коллекторов
 * (их пересчитывает только validate_wires/validate_collectors при операциях с
 * модулями/рейками). Разорванные провода (is_broken 1) не считаются — как
 * get_wire_by_port/get_count_wires_by_port_id редактора (ревью 285 №5).
 */
function refreshShieldConnections(shield: Shield, ports: Map<string, { parent_type: string; parent_id: string }>): void {
  // validate_ports: connected по живым (не разорванным) проводам
  const connectedIds = new Set<string>();
  for (const wire of Object.values(shield.wires ?? {})) {
    if (wire.is_broken) continue;
    connectedIds.add(wire.id_source);
    connectedIds.add(wire.id_target);
  }
  for (const [portId, info] of ports) {
    const connected = connectedIds.has(portId) ? 1 : 0;
    if (info.parent_type === "module") {
      const mod = findShieldModule(shield, info.parent_id);
      const p = mod?.ports?.find((x) => x.id === portId);
      if (p) p.connected = connected;
    } else if (info.parent_type === "input") {
      const inp = shield.inputs[info.parent_id];
      const p = inp?.ports?.find((x) => x.id === portId);
      if (p) p.connected = connected;
    } else {
      const bus = (shield.buses ?? {})[info.parent_id] as { ports?: ShieldPort[] } | undefined;
      const p = bus?.ports?.find((x) => x.id === portId);
      if (p) p.connected = connected;
    }
  }
  // validate_buses: connection шины — тип провода первого подключённого порта
  for (const bus of Object.values(shield.buses ?? {}) as Array<{ id: string; ports?: ShieldPort[]; connection?: string }>) {
    const first = (bus.ports ?? []).find((p) => connectedIds.has(p.id));
    if (!first) {
      bus.connection = "";
      continue;
    }
    const wire = Object.values(shield.wires ?? {}).find((w) => !w.is_broken && (w.id_source === first.id || w.id_target === first.id));
    bus.connection = wire ? wire.type : "";
  }
}

/** Разрешение ссылки на порт (shield_wire_add): id порта или отказ. */
function resolveShieldPort(shield: Shield, ref: ShieldPortRef, side: string): { portId: string; parentType: string; parentId: string } {
  const choices = [ref.module_id !== undefined, ref.input !== undefined, ref.bus !== undefined].filter(Boolean).length;
  if (hasCount(ref) !== 1) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `${side}: укажите ровно один порт — {module_id, port}, {input: "phase"|"null"|"earth"} или {bus, port}`,
      { details: { kind: "bad_port_ref", side } },
    );
  }
  if (ref.module_id !== undefined) {
    const mod = findShieldModule(shield, ref.module_id!);
    if (!mod) throw new McpError("NOT_FOUND", `${side}: модуль ${ref.module_id} не найден в щитке`);
    // ревью 285 №9: без port агенты молча попадали в порт 0 — обязательный
    if (ref.port === undefined) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `${side}: не указан port модуля ${mod.id} (${mod.type}, портов ${mod.ports?.length ?? 0}) — укажите {module_id, port}`,
        { details: { kind: "no_port_specified", side, module: mod.id } },
      );
    }
    const idx = ref.port;
    const port = mod.ports?.[idx];
    if (!port) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `${side}: у модуля ${mod.id} (${mod.type}) нет порта ${idx} (портов ${mod.ports?.length ?? 0})`,
        { details: { kind: "no_port", module: mod.id, port: idx, ports: mod.ports?.length ?? 0 } },
      );
    }
    return { portId: port.id, parentType: "module", parentId: mod.id };
  }
  if (ref.bus !== undefined) {
    const bus = (shield.buses ?? {})[ref.bus];
    if (!bus) throw new McpError("NOT_FOUND", `${side}: шина ${ref.bus} не найдена в щитке`);
    if (ref.port === undefined) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `${side}: не указан port шины ${bus.id} (гнёзд ${bus.ports?.length ?? 0}) — укажите {bus, port}`,
        { details: { kind: "no_port_specified", side, bus: bus.id } },
      );
    }
    const port = bus.ports?.[ref.port];
    if (!port) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `${side}: у шины ${bus.id} нет гнезда ${ref.port} (гнёзд ${bus.ports?.length ?? 0})`,
        { details: { kind: "no_port", bus: bus.id, port: ref.port, ports: bus.ports?.length ?? 0 } },
      );
    }
    return { portId: port.id, parentType: "bus", parentId: bus.id };
  }
  const wantType = INPUT_PORT_TYPE_BY_KEY[ref.input!];
  for (const input of Object.values(shield.inputs)) {
    const port = (input.ports ?? []).find((p) => p.type === wantType);
    if (port) return { portId: port.id, parentType: "input", parentId: input.id };
  }
  throw new McpError("NOT_FOUND", `${side}: порт ввода «${ref.input}» не найден`);
}

function hasCount(ref: ShieldPortRef): number {
  return (ref.module_id !== undefined ? 1 : 0) + (ref.input !== undefined ? 1 : 0) + (ref.bus !== undefined ? 1 : 0);
}

export type ShieldWireAddParams = {
  /** Тип провода = инструмент shield_wire_* (фаза/фаза2/фаза3/ноль/земля). */
  type: string;
  source: ShieldPortRef;
  target: ShieldPortRef;
};

/**
 * shield_wire_add: провод между портами (module_port_click ×2 → add_wire_end
 * редактора: new ShieldWire({id, id_source, id_target, type: tool})).
 * Порты любых родителей (модуль, ввод, шина). same source==target отклоняем
 * (петля); повторный идентичный провод (те же порты в любом направлении и тот же
 * тип) — INVALID_ARGUMENT (ревью 285 №4). Больше одного провода с одного порта
 * разрешено (эталон 284-wire-cases). После добавления пересчитываются только
 * connected/connection (validate_ports/validate_buses редактора, ревью 285 №6).
 */
export function addShieldWire(model: Model, itemId: string, params: ShieldWireAddParams): { shield: Shield; wire: ShieldWire } {
  if (!SHIELD_WIRE_TYPES.includes(params.type as never)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `неизвестный тип провода «${params.type}» (инструменты редактора: ${SHIELD_WIRE_TYPES.join(", ")})`,
      { details: { kind: "bad_wire_type", allowed: SHIELD_WIRE_TYPES } },
    );
  }
  const { shield } = shieldOfItem(model, itemId);
  const source = resolveShieldPort(shield, params.source, "source");
  const target = resolveShieldPort(shield, params.target, "target");
  // ревью 293 №1: провод между гнёздами шин (разных и одной) редактор не даёт
  // начать — ShieldBus.port_mousedown/port_mouseover отклоняют клик, если
  // temp_wire_source_type === "bus"
  if (source.parentType === "bus" && target.parentType === "bus") {
    throw new McpError(
      "INVALID_ARGUMENT",
      "провод между гнёздами шин не ставится (шина→шина, в том числе два гнезда одной шины) — в редакторе провод с порта шины начать нельзя (ShieldBus.port_mousedown)",
      { details: { kind: "bus_to_bus" } },
    );
  }
  // шина: как в редакторе (ShieldBus.port_mousedown/port_mouseover) — к шине с
  // connection можно подключать только провод того же типа; голая шина ("")
  // принимает любой тип и запоминает его (connection = тип провода)
  for (const end of [source, target]) {
    if (end.parentType !== "bus") continue;
    const bus = shield.buses[end.parentId];
    if (bus && bus.connection && bus.connection !== params.type) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `шина ${bus.id} уже соединена проводом «${bus.connection}» — провод «${params.type}» не ставится (как в редакторе), сначала shield_wire_delete`,
        { details: { kind: "bus_connection_conflict", bus: bus.id, connection: bus.connection, type: params.type } },
      );
    }
  }
  if (source.portId === target.portId) {
    throw new McpError("INVALID_ARGUMENT", "source и target — один порт (петля)", { details: { kind: "self_wire" } });
  }
  const duplicate = Object.values(shield.wires ?? {}).some(
    (w) => w.type === params.type
      && ((w.id_source === source.portId && w.id_target === target.portId) || (w.id_source === target.portId && w.id_target === source.portId)),
  );
  if (duplicate) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `провод ${params.type} между этими портами уже есть (повторный идентичный провод — отказ; несколько разных проводов на порт разрешено)`,
      { details: { kind: "duplicate_wire" } },
    );
  }
  if (Object.keys(shield.wires ?? {}).length >= SHIELD_MAX_WIRES_LIMIT) {
    throw new McpError("INVALID_ARGUMENT", `проводов в щитке уже ${SHIELD_MAX_WIRES_LIMIT} (лимит)`, { details: { kind: "wires_limit" } });
  }
  const wire: ShieldWire = { id: newId(10), id_source: source.portId, id_target: target.portId, type: params.type, thickness: 0, is_broken: 0 };
  (shield.wires ??= {})[wire.id] = wire;
  refreshShieldConnections(shield, shieldPorts(shield));
  return { shield, wire };
}

/**
 * shield_wire_delete: удалить провод (delete_wire редактора); connected портов
 * и connection шин пересчитываются (validate_ports/validate_buses редактора,
 * ревью 285 №6 — висячие провода/коллекторы при этом не трогаются).
 */
export function deleteShieldWire(model: Model, itemId: string, wireId: string): { shield: Shield } {
  const { shield } = shieldOfItem(model, itemId);
  if (!shield.wires?.[wireId]) throw new McpError("NOT_FOUND", `провод ${wireId} не найден в щитке предмета ${itemId}`);
  delete shield.wires[wireId];
  refreshShieldConnections(shield, shieldPorts(shield));
  return { shield };
}

/**
 * Каскад удаления предмета-щитка (item_delete): записи конструктора, привязанные
 * по shield_id, удаляются вместе с предметом — иначе висячая ссылка (редактор
 * удаляет щитки демонтированных предметов: e.props.demount → e.delete()).
 */
export function deleteShieldsForItem(model: Model, itemId: string): string[] {
  const deleted: string[] = [];
  for (const [id, shield] of Object.entries(model.shields ?? {})) {
    if (shield.shield_id === itemId) {
      delete model.shields![id];
      deleted.push(id);
    }
  }
  return deleted;
}

// ---------- Шины (этап 291, живой эталон ui-ref-shield-bus) ----------

/** Умолчания шины (ShieldDimensions.bus, живые пробы 291-shield3-ui3/ui6). */
export const SHIELD_BUS_DEFAULT_SOCKETS = 6;
export const SHIELD_BUS_MIN_SOCKETS = 4;
export const SHIELD_BUS_MAX_SOCKETS = 25;

/** Геометрия схемы щитка (ShieldDimensions, проба 291-shield3-ui4/ui7):
 *  module.width 21 px на 1 DIN, rail.margin_x() 120 px, шинная полоса —
 *  bus_bar_margin_x 15 px. Все значения в px svg листа щитка (не мм). */
const SHIELD_MODULE_WIDTH_PX = 21;
const SHIELD_RAIL_MARGIN_X_PX = 120;
const SHIELD_BUS_BAR_MARGIN_X_PX = 15;

/** Ширина шины в px (ShieldBusFactory: живая проба 291-shield3-ui6 —
 *  width_bus = 6×гнёзд + 12, проверено для 4..25 гнёзд). */
export function shieldBusWidthPx(sockets: number): number {
  return 6 * sockets + 12;
}

/** Ширина щитка в px (Shield.get_shield_width редактора; авто-режим:
 *  module.width × (min_length | max ширина рейки + 1) + rail.margin_x). */
export function shieldWidthPx(shield: Shield): number {
  if (shield.on_auto_length_rails === 1) {
    const widths = Object.values(shield.rails).map((r) => railWidthDin(r));
    const max = Math.max(...widths, 0);
    return max <= SHIELD_RAIL_MIN_DIN
      ? SHIELD_MODULE_WIDTH_PX * SHIELD_RAIL_MIN_DIN + SHIELD_MODULE_WIDTH_PX + SHIELD_RAIL_MARGIN_X_PX
      : SHIELD_MODULE_WIDTH_PX * (max + 1) + SHIELD_RAIL_MARGIN_X_PX;
  }
  return SHIELD_MODULE_WIDTH_PX * ((shield.length_rails ?? SHIELD_RAIL_MIN_DIN) + 1) + SHIELD_RAIL_MARGIN_X_PX;
}

export type ShieldBusAddParams = {
  /** Ряд щитка: T (над) | B (под). */
  position: "T" | "B";
  /** Привязка по горизонтали: L (левый край, distance 0) | C (центр, по
   *  умолчанию) | R (правый край). */
  align?: "L" | "C" | "R";
  /** Число гнёзд шины (по умолчанию 6, ShieldDimensions.bus.default_sockets). */
  sockets?: number;
};

/**
 * shield_bus_add: шина над/под щитком (init_bus_slots → bus_slot_mouseover/
 * mousemove/mousedown → add_bus_start/add_bus_move/add_bus_end редактора):
 * 6 портов {parent_type: "bus", connected: 0}, connection "", type —
 * позиция + привязка («TL», «BC», …), distance по привязке (L → 0, C →
 * центр, R → правый край) — формулы add_bus_move, проверены вживую
 * (291-shield3-ui3: TC distance 157.5; ui7: TL 0, TR 315).
 */
export function addShieldBus(model: Model, itemId: string, params: ShieldBusAddParams): { shield: Shield; bus: ShieldBus } {
  if (params.position !== "T" && params.position !== "B") {
    throw new McpError("INVALID_ARGUMENT", `position — «T» (над щитком) или «B» (под), получено «${params.position}»`, { details: { kind: "bad_position" } });
  }
  const sockets = params.sockets ?? SHIELD_BUS_DEFAULT_SOCKETS;
  if (!Number.isInteger(sockets) || sockets < SHIELD_BUS_MIN_SOCKETS || sockets > SHIELD_BUS_MAX_SOCKETS) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `sockets — целое ${SHIELD_BUS_MIN_SOCKETS}..${SHIELD_BUS_MAX_SOCKETS} (ShieldDimensions.bus), получено ${sockets}`,
      { details: { kind: "bad_sockets", min: SHIELD_BUS_MIN_SOCKETS, max: SHIELD_BUS_MAX_SOCKETS } },
    );
  }
  const align = params.align ?? "C";
  const { shield } = shieldOfItem(model, itemId);
  if (Object.keys(shield.buses ?? {}).length >= SHIELD_MAX_BUSES) {
    throw new McpError("INVALID_ARGUMENT", `шин в щитке уже ${SHIELD_MAX_BUSES} (лимит)`, { details: { kind: "buses_limit" } });
  }
  const width = shieldBusWidthPx(sockets);
  const maxDistance = shieldWidthPx(shield) - 2 * SHIELD_BUS_BAR_MARGIN_X_PX - width;
  let distance: number;
  if (align === "L") distance = 0;
  else if (align === "R") distance = maxDistance;
  else distance = shieldWidthPx(shield) / 2 - width / 2 - SHIELD_BUS_BAR_MARGIN_X_PX;
  const bus: ShieldBus = {
    id: newId(10),
    type: `${params.position}${align}`,
    ports: Array.from({ length: sockets }, () => ({
      id: newId(10),
      parent_id: "",
      parent_type: "bus",
      connected: 0,
    })),
    connection: "",
    distance,
  };
  for (const p of bus.ports) p.parent_id = bus.id;
  (shield.buses ??= {})[bus.id] = bus;
  return { shield, bus };
}

export type ShieldBusUpdateParams = {
  /** Ряд щитка: T | B. */
  position?: "T" | "B";
  /** Привязка: L | C | R (distance пересчитывается). */
  align?: "L" | "C" | "R";
  /** Число гнёзд (bus_enter_ports редактора: добавление в конец,
   *  удаление с конца; провода удалённых гнёзд чистятся каскадом). */
  sockets?: number;
};

/**
 * shield_bus_update: привязка/ряд и число гнёзд. Смена гнёзд — bus_enter_ports
 * редактора: добавить в конец, удалить с конца; провода к удалённым гнёздам
 * удаляются (bus_remove_port → validate_wires/validate_ports/validate_buses).
 */
export function updateShieldBus(model: Model, itemId: string, busId: string, params: ShieldBusUpdateParams): { shield: Shield; bus: ShieldBus; deleted_wires: string[] } {
  const { shield } = shieldOfItem(model, itemId);
  const bus = shield.buses?.[busId];
  if (!bus) throw new McpError("NOT_FOUND", `шина ${busId} не найдена в щитке предмета ${itemId}`);
  if (params.position !== undefined || params.align !== undefined) {
    const position = params.position ?? (bus.type.startsWith("B") ? "B" : "T");
    const align = params.align ?? (bus.type.slice(1) as "L" | "C" | "R");
    bus.type = `${position}${align}`;
    const sockets = bus.ports.length;
    const maxDistance = shieldWidthPx(shield) - 2 * SHIELD_BUS_BAR_MARGIN_X_PX - shieldBusWidthPx(sockets);
    bus.distance = align === "L" ? 0 : align === "R" ? maxDistance : shieldWidthPx(shield) / 2 - shieldBusWidthPx(sockets) / 2 - SHIELD_BUS_BAR_MARGIN_X_PX;
  }
  let deletedWires: string[] = [];
  if (params.sockets !== undefined && params.sockets !== bus.ports.length) {
    if (!Number.isInteger(params.sockets) || params.sockets < SHIELD_BUS_MIN_SOCKETS || params.sockets > SHIELD_BUS_MAX_SOCKETS) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `sockets — целое ${SHIELD_BUS_MIN_SOCKETS}..${SHIELD_BUS_MAX_SOCKETS} (ShieldDimensions.bus)`,
        { details: { kind: "bad_sockets", min: SHIELD_BUS_MIN_SOCKETS, max: SHIELD_BUS_MAX_SOCKETS } },
      );
    }
    if (params.sockets > bus.ports.length) {
      const add = params.sockets - bus.ports.length;
      for (let i = 0; i < add; i++) {
        bus.ports.push({ id: newId(10), parent_id: bus.id, parent_type: "bus", connected: 0 });
      }
    } else {
      const removed = bus.ports.splice(params.sockets);
      const gone = new Set(removed.map((p) => p.id));
      for (const [id, wire] of Object.entries(shield.wires ?? {})) {
        if (gone.has(wire.id_source) || gone.has(wire.id_target)) {
          delete shield.wires![id];
          deletedWires.push(id);
        }
      }
      refreshShieldConnections(shield, shieldPorts(shield));
    }
  }
  return { shield, bus, deleted_wires: deletedWires };
}

/**
 * shield_bus_delete: удалить шину (delete_bus редактора: провода к её гнёздам
 * чистятся каскадом — validate_wires/validate_ports).
 */
export function deleteShieldBus(model: Model, itemId: string, busId: string): { shield: Shield; deleted_wires: string[] } {
  const { shield } = shieldOfItem(model, itemId);
  if (!shield.buses?.[busId]) throw new McpError("NOT_FOUND", `шина ${busId} не найдена в щитке предмета ${itemId}`);
  delete shield.buses[busId];
  const cascade = validateShieldDerived(shield);
  return { shield, deleted_wires: cascade.deleted_wires };
}

// ---------- Коллекторы (этап 291, живой эталон ui-ref-shield-collector) ----------

export type ShieldCollectorAddParams = {
  /** Модули коллектора (id из model_get) в порядке следования на рейке. */
  modules: string[];
};

/**
 * Общая валидация набора модулей коллектора (ревью 293 №2 — одно правило для
 * add и update): дубликаты, существование, коллекторный тип, одна рейка, одна
 * ширина, чужой коллектор; «модули подряд» — диапазон по min/max ВСЕХ модулей
 * (Math.min(...mods.map(m=>m.index))), а не по первому и последнему элементу
 * списка: иначе неупорядоченный список проходит с разрывом, а calc() редактора
 * забрал бы в коллектор все модули диапазона, включая чужие.
 */
function validateCollectorModules(shield: Shield, ids: string[], itemId: string, exceptCollectorId?: string): ShieldModule[] {
  if (new Set(ids).size !== ids.length) {
    throw new McpError("INVALID_ARGUMENT", "в списке модулей коллектора есть дубликаты", { details: { kind: "collector_duplicate_module" } });
  }
  const mods = ids.map((mid) => {
    const mod = findShieldModule(shield, mid);
    if (!mod) throw new McpError("NOT_FOUND", `модуль ${mid} не найден в щитке`);
    return mod;
  });
  const railId = mods[0]!.rail_id;
  for (const mod of mods) {
    if (!SHIELD_COLLECTOR_MODULE_TYPES.has(mod.type)) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `модуль ${mod.id} (${mod.type}) не коллекторный (в редакторе коллектор ставится на модули типов: ${[...SHIELD_COLLECTOR_MODULE_TYPES].join(", ")})`,
        { details: { kind: "not_collector_module", module: mod.id, type: mod.type, allowed: [...SHIELD_COLLECTOR_MODULE_TYPES] } },
      );
    }
    if (mod.rail_id !== railId) {
      throw new McpError("INVALID_ARGUMENT", "модули коллектора должны быть на одной рейке", { details: { kind: "collector_rail_mismatch" } });
    }
    if (mod.width !== mods[0]!.width) {
      throw new McpError("INVALID_ARGUMENT", "модули коллектора должны быть одной ширины", { details: { kind: "collector_width_mismatch", module_width: mods[0]!.width } });
    }
    const inAnother = Object.entries(shield.collectors ?? {}).some(([cid, c]) => cid !== exceptCollectorId && mod.id in (c.modules ?? {}));
    if (inAnother) {
      throw new McpError("INVALID_ARGUMENT", `модуль ${mod.id} уже входит в другой коллектор`, { details: { kind: "module_in_collector" } });
    }
  }
  const min = Math.min(...mods.map((m) => m.index));
  const max = Math.max(...mods.map((m) => m.index));
  const rail = shield.rails[railId]!;
  // в диапазоне [min..max] не должно быть чужих модулей (calc() редактора
  // собирает только подряд идущие модули одной ширины)
  const wanted = new Set(mods.map((m) => m.id));
  for (const m of Object.values(rail.modules)) {
    if (m.index >= min && m.index <= max && !wanted.has(m.id)) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `модули коллектора должны идти подряд: в диапазоне ${min}..${max} DIN есть чужой модуль ${m.id}`,
        { details: { kind: "collector_gap", module: m.id } },
      );
    }
  }
  return mods;
}

/**
 * shield_collector_add: коллектор через карту модулей (add_collector_start +
 * add_collector_end редактора — тот же путь, что drag по портам; проба
 * 291-shield3-ui3): модули — подряд на одной рейке, одной ширины; position —
 * ряд щитка первого модуля (is_lower_row). Коллектор на одном модуле
 * редактор удаляет (validate_collectors) — MCP отказывает. Разрыв (чужой
 * модуль внутри диапазона) и разные ширины — отказ (calc() редактора не дал
 * бы такую карту).
 */
export function addShieldCollector(model: Model, itemId: string, params: ShieldCollectorAddParams): { shield: Shield; collector: ShieldCollector } {
  const ids = params.modules;
  if (!Array.isArray(ids) || ids.length < 2) {
    throw new McpError(
      "INVALID_ARGUMENT",
      "коллектор — минимум два модуля (коллектор на одном модуле редактор удаляет: validate_collectors)",
      { details: { kind: "collector_too_small", modules: ids?.length ?? 0 } },
    );
  }
  const { shield } = shieldOfItem(model, itemId);
  if (Object.keys(shield.collectors ?? {}).length >= SHIELD_MAX_COLLECTORS) {
    throw new McpError("INVALID_ARGUMENT", `коллекторов в щитке уже ${SHIELD_MAX_COLLECTORS} (лимит)`, { details: { kind: "collectors_limit" } });
  }
  const mods = validateCollectorModules(shield, ids, itemId);
  const first = mods[0]!;
  const collector: ShieldCollector = {
    id: newId(10),
    rail_id: first.rail_id,
    module_width: first.width,
    modules: Object.fromEntries(mods.map((m) => [m.id, 1])),
    position: railIsLowerRow(shield, first) ? "B" : "T",
  };
  (shield.collectors ??= {})[collector.id] = collector;
  return { shield, collector };
}

/**
 * Ряд порта/модуля (Shield.is_lower_row редактора): в модели щитка координат
 * портов нет — ряд определяется по положению модуля на рейке относительно
 * ввода: модуль ниже ввода (index ввода... в конструкторе один ввод сверху,
 * ряд B у модулей нижней половины). Редактор считает по y центра порта;
 * для карты модулей одной ширины на одной рейке ряд один и тот же у всех —
 * консервативно T (верхний ряд), пока живой эталон B-коллектора не снят.
 */
function railIsLowerRow(_shield: Shield, _mod: ShieldModule): boolean {
  return false;
}

export type ShieldCollectorUpdateParams = {
  /** Новый набор модулей (подряд, одна рейка, одна ширина, ≥2). */
  modules?: string[];
};

/**
 * shield_collector_update: замена набора модулей (переснятие drag — тот же
 * путь, что add). position не меняется (перенос коллектора между рядами
 * редактором не поддержан; живого эталона нет).
 */
export function updateShieldCollector(model: Model, itemId: string, collectorId: string, params: ShieldCollectorUpdateParams): { shield: Shield; collector: ShieldCollector } {
  const { shield } = shieldOfItem(model, itemId);
  const collector = shield.collectors?.[collectorId];
  if (!collector) throw new McpError("NOT_FOUND", `коллектор ${collectorId} не найден в щитке предмета ${itemId}`);
  if (params.modules !== undefined) {
    const ids = params.modules;
    if (!Array.isArray(ids) || ids.length < 2) {
      throw new McpError(
        "INVALID_ARGUMENT",
        "коллектор — минимум два модуля (validate_collectors редактора удаляет коллектор на одном модуле)",
        { details: { kind: "collector_too_small", modules: ids?.length ?? 0 } },
      );
    }
    const mods = validateCollectorModules(shield, ids, itemId, collectorId);
    const width = mods[0]!.width;
    collector.rail_id = mods[0]!.rail_id;
    collector.module_width = width;
    collector.modules = Object.fromEntries(mods.map((m) => [m.id, 1]));
  }
  return { shield, collector };
}

/**
 * shield_collector_delete: удалить коллектор (delete_collector редактора) —
 * провода и модули не трогаются.
 */
export function deleteShieldCollector(model: Model, itemId: string, collectorId: string): { shield: Shield } {
  const { shield } = shieldOfItem(model, itemId);
  if (!shield.collectors?.[collectorId]) throw new McpError("NOT_FOUND", `коллектор ${collectorId} не найден в щитке предмета ${itemId}`);
  delete shield.collectors[collectorId];
  return { shield };
}


/** Каноническая форма значения с сортировкой ключей на всех уровнях — сверка
 *  словарей (wires/buses/collectors), порядок ключей которых после нормализации
 *  редактора не гарантирован. */
function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortedDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Семантическая проекция щитка для сверок (полная, а не по выбранным полям). */
export function shieldProjection(shield: Shield): Record<string, unknown> {
  const rails = Object.values(shield.rails)
    .sort((a, b) => a.index - b.index)
    .map((rail) => ({
      id: rail.id,
      index: rail.index,
      modules: Object.values(rail.modules)
        .sort((a, b) => a.index - b.index)
        .map((m) => ({
          id: m.id,
          rail_id: m.rail_id,
          index: m.index,
          width: m.width,
          type: m.type,
          group_number: m.group_number,
          subtype: m.subtype,
          comment: m.comment,
          ports: (m.ports ?? []).map((p) => ({ id: p.id, parent_id: p.parent_id, parent_type: p.parent_type, connected: p.connected })),
          custom: m.custom ?? {},
        })),
    }));
  const inputs = Object.values(shield.inputs)
    .sort((a, b) => a.index - b.index)
    .map((inp) => ({
      id: inp.id,
      index: inp.index,
      phase: inp.phase,
      ports: (inp.ports ?? []).map((p) => ({ id: p.id, parent_id: p.parent_id, parent_type: p.parent_type, type: p.type, connected: p.connected })),
    }));
  return {
    id: shield.id,
    shield_id: shield.shield_id,
    on_auto_length_rails: shield.on_auto_length_rails,
    // length_rails при авто-режиме — производная редактора (пересчёт при
    // переключении auto_length_rails/изменении рейк), в сверку не входит
    ...(shield.on_auto_length_rails !== 1 ? { length_rails: shield.length_rails } : {}),
    rails,
    inputs,
    // buses/collectors — с 291, wires — с 284: сверка канонической формы
    // целиком (потеря чужого содержимого не проходит молча)
    buses: sortedDeep(shield.buses ?? {}),
    collectors: sortedDeep(shield.collectors ?? {}),
    wires: sortedDeep(shield.wires ?? {}),
  };
}
