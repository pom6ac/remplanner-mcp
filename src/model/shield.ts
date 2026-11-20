// Конструктор электрощитка (лист «Электрощиток», план shield, часть 3, 2026-11-20).
// Модель model.shields[shield.id] — рейки с модулями, ввод, шины/провода (провода
// и шины — следующий PR: MCP их не пишет, операции с ними отклоняет). Формат —
// эталоны tests/fixtures/ui-ref-shield-*.json (пробы 255-shield-scout,
// 255-shield-classes, бандл app.3.0: классы Shield/Rail/RailModule/ShieldInput).
// Связь с предметом-щитком — shields[].shield_id = items[].id; предмет без записи
// редактор дополняет записью по умолчанию при restore (SHIELDS.restore) — модельный
// слой делает то же (ensureShield), чтобы сверка save не видела ложную потерю.
import type { Model, ItemProps, Shield, ShieldRail, ShieldModule, ShieldInput, ShieldPort } from "./types.ts";
import { newId } from "./types.ts";
import { McpError } from "../errors.ts";
import { MAX_SERVICE_COMMENT_CHARS } from "../limits.ts";

/**
 * Предметы-щитки, к которым привязан конструктор (Item.isElectricShield("power"),
 * бандл app.3.0). lowcurrent-щитки в конструктор не входят.
 */
export const SHIELD_ITEM_NAMES = new Set(["electric_shield", "electric_shield_internal", "electric_shield_old"]);

/** Умолчания конструктора (ShieldDimensions.rail, бандл app.3.0). */
export const SHIELD_RAIL_MIN_DIN = 12;
export const SHIELD_RAIL_MAX_DIN = 48;

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
  return {
    id: newId(10),
    shield_id: itemId,
    on_auto_length_rails: 1,
    length_rails: SHIELD_RAIL_MIN_DIN,
    rails: { [rail.id]: rail },
    buses: {},
    collectors: {},
    inputs: { [newId(10)]: newShieldInput() },
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

function railWidthMm(rail: ShieldRail): number {
  return Object.values(rail.modules).reduce((n, mod) => n + mod.width, 0);
}

/** Длина щитка в DIN при авто-режиме: максимум ширин рейки и минимума (редактор,
 *  переключение auto_length_rails: Math.max(...widths, min_length)). */
function autoLengthRails(shield: Shield): number {
  const widths = Object.values(shield.rails).map((r) => railWidthMm(r));
  return Math.max(...widths, SHIELD_RAIL_MIN_DIN);
}

function refreshAutoLength(shield: Shield): void {
  if (shield.on_auto_length_rails === 1) shield.length_rails = autoLengthRails(shield);
}

/** Максимальная длина рейки в DIN (Shield.get_rail_max_length). */
function railMaxLength(shield: Shield): number {
  return shield.on_auto_length_rails === 1 ? SHIELD_RAIL_MAX_DIN : (shield.length_rails ?? SHIELD_RAIL_MIN_DIN);
}

/** Есть ли у щитка провода/шины/коллекторы — их формат вне ядра этапа 255
 *  (следующий PR), операции с рейками/модулями при них отклоняются. */
function hasWiresOrBuses(shield: Shield): boolean {
  return Object.keys(shield.wires ?? {}).length > 0 || Object.keys(shield.buses ?? {}).length > 0
    || Object.keys(shield.collectors ?? {}).length > 0;
}

function assertNoWiresOrBuses(shield: Shield): void {
  if (hasWiresOrBuses(shield)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      "в щитке есть провода или шины — их изменение пока не поддерживается (следующий этап); сначала удалите их в редакторе",
      { details: { kind: "wires_not_supported", shield_id: shield.id } },
    );
  }
}

function commentClean(comment: string | undefined): string {
  if (comment === undefined) return "";
  const s = comment.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (s.length > MAX_SERVICE_COMMENT_CHARS) {
    throw new McpError("INVALID_ARGUMENT", `комментарий модуля длиннее ${MAX_SERVICE_COMMENT_CHARS} символов`);
  }
  return s;
}

function subtypeOf(type: string, subtype: string | undefined): string {
  const def = SHIELD_MODULE_TYPES[type]!;
  if (subtype === undefined) return def.default_subtype ?? "";
  if (def.subtypes && !def.subtypes.includes(subtype)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `номинал «${subtype}» не из списка типа ${type} (${def.subtypes.join(", ")})`,
      { details: { kind: "bad_subtype", type, allowed: def.subtypes } },
    );
  }
  return subtype;
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
  assertNoWiresOrBuses(shield);
  const rail: ShieldRail = { id: newId(10), index: Object.keys(shield.rails).length, modules: {} };
  shield.rails[rail.id] = rail;
  return shield;
}

/**
 * shield_rail_delete: удалить рейку (Shield.delete_rail: модули рейки удаляются,
 * индексы последующих рейк уменьшаются). Последнюю рейку удалить нельзя
 * (редактор игнорирует удаление единственной рейки — get_count_rails() === 1).
 */
export function deleteShieldRail(model: Model, itemId: string, railRef: number | string): { shield: Shield; deleted_modules: string[] } {
  const { shield } = shieldOfItem(model, itemId);
  assertNoWiresOrBuses(shield);
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
  refreshAutoLength(shield);
  return { shield, deleted_modules: deletedModules };
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
  assertNoWiresOrBuses(shield);
  const railIndex = params.rail ?? 0;
  const rail = railByIndex(shield, railIndex);
  const width = railWidthMm(rail);
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
    module.subtype = params.subtype ?? CUSTOM_MODULE_DEFAULTS.subtype;
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
};

/**
 * shield_module_update: номинал, номер группы, подпись (контекстное меню модуля
 * «#cm-rail-module»). Перенос между рейками — следующий этап (в редакторе это
 * drag модуля; формат переходного состояния in_transition вне ядра).
 */
export function updateShieldModule(model: Model, itemId: string, moduleId: string, params: ShieldModuleUpdateParams): { shield: Shield; module: ShieldModule } {
  const { shield } = shieldOfItem(model, itemId);
  assertNoWiresOrBuses(shield);
  const mod = findShieldModule(shield, moduleId);
  if (!mod) throw new McpError("NOT_FOUND", `модуль ${moduleId} не найден в щитке предмета ${itemId}`);
  const def = SHIELD_MODULE_TYPES[mod.type];
  if (params.subtype !== undefined) {
    if (def?.subtypes && !def.subtypes.includes(params.subtype)) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `номинал «${params.subtype}» не из списка типа ${mod.type} (${def.subtypes.join(", ")})`,
        { details: { kind: "bad_subtype", type: mod.type, allowed: def.subtypes } },
      );
    }
    mod.subtype = params.subtype;
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
  return { shield, module: mod };
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
 * пересчитывается. Провода/шины, привязанные к портам модуля, запрещают удаление
 * (validate_wires редактора; формат проводов — следующий этап).
 */
export function deleteShieldModule(model: Model, itemId: string, moduleId: string): void {
  const { shield } = shieldOfItem(model, itemId);
  assertNoWiresOrBuses(shield);
  const mod = findShieldModule(shield, moduleId);
  if (!mod) throw new McpError("NOT_FOUND", `модуль ${moduleId} не найден в щитке предмета ${itemId}`);
  const rail = shield.rails[mod.rail_id];
  if (rail) {
    delete rail.modules[mod.id];
    for (const other of Object.values(rail.modules)) {
      if (other.index > mod.index) other.index -= mod.width;
    }
  }
  refreshAutoLength(shield);
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
    // buses/collectors/wires вне ядра этапа 255 — сверка целиком (потеря чужого
    // содержимого не должна проходить молча)
    buses: shield.buses ?? {},
    collectors: shield.collectors ?? {},
    wires: shield.wires ?? {},
  };
}
