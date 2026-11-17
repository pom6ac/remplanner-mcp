import type { Model, Cable, CableVertex, ItemProps, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { McpError } from "../errors.ts";
import { add, leftNormal, scale, sub } from "./geometry.ts";
import { gasLineLengthM } from "./pipes.ts";
import { roomPolygons } from "./items.ts";

/**
 * Электрика (этап 88, 2026-11-17): розетки и выключатели листов «Розетки» и
 * «Выключатели» — предметы-группы socket_group (одиночная пристенная розетка или
 * выключатель редактор тоже пишет как item name="socket_group" с массивом
 * socket_group из одного под-элемента — эталоны ui-ref-elec-*), и связи
 * «выключатель → светильник» — модель.cables (класс Cable, см. types.ts).
 *
 * Формы записи (пробы 88-elec-formats*, 88-elec-live):
 * - розетка/выключатель у стены: item name="socket_group", plan под-элемента
 *   ({sockets: 9} у розеток, {light_connections: 29} у выключателей), over_floor
 *   {value, display: true, vd: value} (display редактор включает, vd — производное);
 * - потолочная розетка ceiling_socket и напольная floor_socket (anchor "ceiling") —
 *   свободные предметы с собственным именем, over_floor в модели нет;
 * - под-элемент группы: {name, id, center, center_prs, real_center} — center
 *   на 7 см внутрь от оси стены (половина ширины пластины 14 см), real_center = pc;
 * - связь cable: вершины-предметы "<itemId>|s|<subId>" (switch) и "<itemId>" (lamp),
 *   промежуточные узлы "node", длина в метрах, on_arc 1, color_custom "";
 *   обратные ссылки: cables.cable_id — массив у под-розетки, скаляр у светильника.
 *
 * Кабели-коллекции (cables_socket, cables_warm_floor, cables_conditioner — лист
 * «Электропроводка») и электрощит (shields, shield_module_*) — отдельный PR.
 */

/** Лимит точек пути связи (матрица квадратична; достаточно с запасом). */
export const MAX_CABLE_PATH_NODES = 32;

/** Допустимое расхождение длины связи (м) при сверке. */
export const CABLE_LENGTH_TOL_M = 0.02;

/**
 * Число клавиш выключателя (класс Cabling редактора, бандл app.3.0:
 * switches_list) — столько соединительных проводов можно подключить к одной
 * под-розетке (is_max_count_keys_on_switch). light_dimmer — 1000 (без гейта).
 */
export const SWITCH_MAX_KEYS: Record<string, number> = {
  light_switch: 1,
  light_switch_double: 2,
  light_switch_triple: 3,
  light_switch_through: 1,
  light_switch_through_double: 2,
  light_switch_cross: 1,
  light_switch_cross_double: 2,
  light_dimmer: 1000,
};

/**
 * Светильники, подключаемые к выключателю (класс Cabling редактора: lamps +
 * source_items.cable); вершина связи — тип по предмету (Cable.getTypeItem):
 * led_strip → "led_strip", line_light → "line_strip", трековые шины → "strip_light",
 * остальные → "lamp".
 */
export const CABLE_LAMP_ITEMS = new Set([
  "chandelier", "ceiling_chandelier_shades", "ceiling_chandelier_led",
  "hanging_chandelier_shades", "hanging_chandelier_led", "cascading_chandelier",
  "crystal_chandelier", "hanging_chandelier_shades_long", "hanging_chandelier_crystal_long",
  "hanging_chandelier_led_long", "ceiling_chandelier_long", "hanging_chandelier_long",
  "chandelier_fan", "hanging_light", "track_single", "track_double", "track_triple",
  "wall_spot", "bra", "bra_shades", "led_lamp", "light_stick", "painting_lighting",
  "sauna_bra_corner", "sauna_bra", "outdoor_wall_lamp", "stair_spot", "wall_lamp",
  "lightspot", "lightspot_double", "lightspot_triple", "lightspot_surface",
  "lightspot_surface_double", "lightspot_surface_triple", "armstrong_light",
  "fan", "fan_wall", "fan_channel", "backlit_mirror", "round_mirror_led",
  "floor_molding_with_light",
  // led_strip/line_light/recessed_strip/surface_stripe/pendent_strip подключаются
  // к выключателю тем же классом Cabling (lamps), но обратная ссылка на полосе
  // (props LED_STRIPS/STRIPES_LIGHT/LINE_STRIPS) пробой 88-strip-link не снята —
  // подключение к шинам/лентам — следующий PR (отчёт 88)
]);

/** Тип вершины светильника в связи (Cable.getTypeItem). */
export function cableLampVertexType(itemName: string): "lamp" {
  return "lamp";
}

/**
 * Коллекция-цель вершины связи по типу вершины (Cable.getTypeItem, бандл app.3.0):
 * "lamp" — предметы model.items; вершины световых линий ищутся в своей коллекции
 * (ревью 90 R2 — уже существующие связи с лентами/шинами/линейным светом не
 * блокируют save, cable_delete снимает ссылку и у линии; новые подключения к
 * линиям cable_add по-прежнему не ставит).
 */
export const CABLE_VERTEX_COLLECTION: Record<string, "led_strips" | "stripes_light" | "line_strips"> = {
  led_strip: "led_strips",
  strip_light: "stripes_light",
  line_strip: "line_strips",
};

/** Под-розетки группы socket_group ($SocketsGroup.types, бандл app.3.0). */
export const SOCKET_GROUP_SUBS = new Set([
  "socket", "socket_ip44", "socket_tv", "socket_ip", "socket_usb", "socket_hdmi",
  "socket_audio", "socket_phone", "furniture_socket",
]);

/** Самостоятельные предметы (не группы): силовые 380/мощность (anchor wall) и
 *  потолочная/напольная розетки (anchor ceiling, PRO). */
export const STANDALONE_SOCKETS = new Set(["socket_power", "socket_380", "ceiling_socket", "floor_socket"]);

/** Выключатели (лист «Выключатели») — группы с под-элементом. */
export const SWITCH_ITEMS = new Set(Object.keys(SWITCH_MAX_KEYS));

/** Под-розетка группы (ItemProps.socket_group[i]). */
export type SocketGroupSub = {
  name: string;
  id: string;
  real_center: Point;
  center: Point;
  center_prs: Point;
  cables?: { cable_id: string[] } | { cable_id: string };
  [key: string]: unknown;
};

/** Полный id вершины выключателя в связи (SocketsGroup.generateIdSocket). */
export function switchVertexId(groupId: string, subId: string): string {
  return `${groupId}|s|${subId}`;
}

/** Разбор полного id вершины выключателя → [id группы, id под-розетки]. */
export function parseSwitchVertexId(vertexId: string): [string, string] | null {
  const idx = vertexId.indexOf("|s|");
  if (idx < 0) return null;
  return [vertexId.slice(0, idx), vertexId.slice(idx + 3)];
}

function cmPoint(pt: MmPoint): Point {
  return { x: r2(mmToCm(pt.x)), y: r2(mmToCm(pt.y)) };
}

function finitePoint(name: string, p: MmPoint): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new McpError("INVALID_ARGUMENT", `${name}: координаты должны быть конечными числами`);
  }
}

/**
 * Пересчитать точки под-розетки после постановки/переноса группы (транзитивный
 * пересчёт затронутых привязок): real_center = pc группы, center/center_prs —
 * на 7 см внутрь помещения от оси стены (пробы 88: у розетки pc в 7 см от оси —
 * center совпадает; у выключателя высотой 18 pc в 9 см — center в 7 см).
 * Направление внутрь — по нормали стены к центру комнаты (как у addItem).
 */
export function refreshSocketGroupSubs(model: Model, item: ItemProps, oldPc?: Point, oldAngle?: number): void {
  const subs = item.socket_group as SocketGroupSub[] | undefined;
  if (!Array.isArray(subs)) return;
  if (oldPc) {
    // перенос: смещения под-розеток относительно pc переносятся (с доворотом на изменение угла)
    const dAngle = ((item.angle - (oldAngle ?? item.angle)) * Math.PI) / 180;
    const cos = Math.cos(dAngle);
    const sin = Math.sin(dAngle);
    const rotate = (p: Point): Point => {
      const dx = p.x - oldPc.x;
      const dy = p.y - oldPc.y;
      return { x: item.pc.x + dx * cos - dy * sin, y: item.pc.y + dx * sin + dy * cos };
    };
    for (const s of subs) {
      if (s.real_center) s.real_center = rotate(s.real_center);
      if (s.center) s.center = rotate(s.center);
      if (s.center_prs) s.center_prs = { ...s.center };
    }
    return;
  }
  const wall = item.id_wall ? model.walls[item.id_wall] : undefined;
  let inward: Point | null = null;
  if (wall) {
    const nl = leftNormal(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
    const wallMid = { x: (wall.p1.x + wall.p2.x) / 2, y: (wall.p1.y + wall.p2.y) / 2 };
    const rooms = roomPolygons(model);
    const room = rooms.find((r) => r.roomId === item.id_room) ?? rooms[0];
    const target = room ? { x: room.polygon.reduce((s, p) => s + p.x, 0) / room.polygon.length, y: room.polygon.reduce((s, p) => s + p.y, 0) / room.polygon.length } : null;
    const toRoom = target ? sub(target, wallMid) : sub(item.pc, wallMid);
    inward = nl.x * toRoom.x + nl.y * toRoom.y > 0 ? nl : scale(nl, -1);
  }
  for (const s of subs) {
    s.real_center = { ...item.pc };
    // center — на 7 см внутрь от лица стены: pc стоит на height/2 внутрь,
    // center БЛИЖЕ к стене на (height/2 − 7) (розетка h=14 — совпадает с pc;
    // выключатель h=18 — center на 2 см ближе к стене)
    s.center = inward ? add(item.pc, scale(inward, 7 - item.height / 2)) : { ...item.pc };
    s.center_prs = { ...s.center };
  }
}

/**
 * Связь (model.cables) по id и под-розетки, которые она занимает:
 * для проверок «занят ли ключ выключателя» и удаления обратных ссылок.
 */
export function cableSwitchSlots(cable: Cable): { itemId: string; subId: string }[] {
  const out: { itemId: string; subId: string }[] = [];
  for (const v of cable.vertexes) {
    if (v.type !== "switch") continue;
    const parsed = parseSwitchVertexId(v.id);
    if (parsed) out.push({ itemId: parsed[0], subId: parsed[1] });
  }
  return out;
}

/** Занятые ключи под-розетки (cables.cable_id массив): cables выключателя. */
function subCableIds(sub: SocketGroupSub): string[] {
  const c = sub.cables?.cable_id;
  if (Array.isArray(c)) return c.filter((x): x is string => typeof x === "string");
  if (typeof c === "string" && c !== "") return [c];
  return [];
}

/**
 * cable_add: связь «выключатель → светильник» (мм): switch_item_id — предмет-группа
 * с под-розеткой-выключателем, lamp_item_id — светильник из CABLE_LAMP_ITEMS,
 * path — промежуточные узлы (мм, опционально). У под-розетки должен быть свободный
 * ключ (число подключённых связей < SWITCH_MAX_KEYS), у светильника — занятый слот
 * cables.cable_id отвергается (скалярная ссылка). Вершина выключателя —
 * "<itemId>|s|<subId>" с точкой center под-розетки; вершина светильника — id
 * предмета с точкой pc. Кандидат-копия; при ошибке модель не меняется.
 */
export function addCable(
  model: Model,
  params: { switchItemId: string; switchSubId?: string; lampItemId: string; path?: MmPoint[] },
): Cable {
  const swItem = model.items[params.switchItemId] as ItemProps | undefined;
  if (!swItem) throw new McpError("NOT_FOUND", `выключатель ${params.switchItemId} не найден`);
  const subs = swItem.socket_group as SocketGroupSub[] | undefined;
  if (swItem.name !== "socket_group" || !Array.isArray(subs)) {
    throw new McpError("INVALID_ARGUMENT", `предмет ${params.switchItemId} («${swItem.name}») — не группа розеток/выключателей: связь ставится на под-розетку-выключатель (light_switch*)`, {
      details: { kind: "not_a_switch" },
    });
  }
  const lamp = model.items[params.lampItemId] as ItemProps | undefined;
  if (!lamp) throw new McpError("NOT_FOUND", `светильник ${params.lampItemId} не найден`);
  if (!CABLE_LAMP_ITEMS.has(lamp.name)) {
    throw new McpError("INVALID_ARGUMENT", `предмет «${lamp.name}» не подключается к выключателю (в редакторе у связи другой список светильников)`, {
      details: { kind: "not_connectable", item: lamp.name },
    });
  }
  const lampLinked = (lamp as ItemProps & { cables?: { cable_id?: unknown } }).cables?.cable_id;
  if (typeof lampLinked === "string" ? lampLinked !== "" : Array.isArray(lampLinked) ? lampLinked.length > 0 : lampLinked !== undefined && lampLinked !== null) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `светильник ${lamp.id} уже подключён к связи ${JSON.stringify(lampLinked)} — у светильника одно подключение; сначала удалите связь cable_delete`,
      { details: { kind: "already_connected", item: lamp.id } },
    );
  }
  const candidates = subs.filter((s) => SWITCH_MAX_KEYS[s.name] !== undefined);
  if (candidates.length === 0) {
    throw new McpError("INVALID_ARGUMENT", `в группе ${params.switchItemId} нет выключателя (light_switch*) — связь ставится с выключателя`, {
      details: { kind: "no_switch_sub" },
    });
  }
  let sub: SocketGroupSub | undefined;
  if (params.switchSubId !== undefined) {
    sub = candidates.find((s) => s.id === params.switchSubId);
    if (!sub) {
      throw new McpError("NOT_FOUND", `под-розетка-выключатель ${params.switchSubId} в группе ${params.switchItemId} не найдена`);
    }
  } else {
    sub = candidates.find((s) => subCableIds(s).length < (SWITCH_MAX_KEYS[s.name] ?? 1));
    if (!sub) {
      // свободного ключа нет — сообщение с числом клавиш (как в редакторе)
      sub = candidates[0]!;
      const maxKeys = SWITCH_MAX_KEYS[sub.name] ?? 1;
      const used = subCableIds(sub);
      throw new McpError(
        "INVALID_ARGUMENT",
        `у выключателя «${sub.name}» все ${maxKeys} ключей заняты (${used.join(", ")}) — для большего числа связей поставьте выключатель с нужным числом клавиш`,
        { details: { kind: "switch_keys_exhausted", sub: sub.id, used } },
      );
    }
  }
  const maxKeys = SWITCH_MAX_KEYS[sub.name] ?? 1;
  const used = subCableIds(sub);
  if (used.length >= maxKeys) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `у выключателя «${sub.name}» все ${maxKeys} ключей заняты (${used.join(", ")}) — для большего числа связей поставьте выключатель с нужным числом клавиш`,
      { details: { kind: "switch_keys_exhausted", sub: sub.id, used } },
    );
  }
  const path = params.path ?? [];
  if (path.length > MAX_CABLE_PATH_NODES) {
    throw new McpError("INVALID_ARGUMENT", `путь связи слишком длинный: ${path.length} точек (лимит ${MAX_CABLE_PATH_NODES})`);
  }
  for (const p of path) finitePoint("точка пути", p);

  const switchVertex: CableVertex = { id: switchVertexId(swItem.id, sub.id), point: { ...(sub.center ?? swItem.pc) }, type: "switch" };
  const lampVertex: CableVertex = { id: lamp.id, point: { ...lamp.pc }, type: cableLampVertexType(lamp.name) };
  const nodeVertexes: CableVertex[] = path.map((p) => ({ id: `_${newId(5)}`, point: cmPoint(p), type: "node" }));
  const vertexes = [switchVertex, ...nodeVertexes, lampVertex];
  const n = vertexes.length;
  const matrix: ({ length: number } | null)[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
  for (let i = 0; i + 1 < n; i++) {
    matrix[i]![i + 1] = { length: 1 };
    matrix[i + 1]![i] = { length: 1 };
  }
  const items: Record<string, string> = {};
  for (const v of vertexes) items[v.id] = v.type;
  const candidate: Cable = {
    id: newId(10),
    matrix,
    vertexes,
    items,
    type: "cable",
    color_custom: "",
    length: gasLineLengthM({ vertexes, matrix }),
    on_arc: 1,
  };

  // атомарная запись: кабель + обе обратные ссылки (откат при ошибке)
  const backupCables = model.cables !== undefined ? structuredClone(model.cables) : undefined;
  const backupItems = structuredClone(model.items);
  model.cables ??= {};
  try {
    model.cables[candidate.id] = candidate;
    const arr = subCableIds(sub);
    arr.push(candidate.id);
    sub.cables = { cable_id: arr };
    (lamp as ItemProps & { cables?: { cable_id: string } }).cables = { cable_id: candidate.id };
  } catch (e) {
    if (backupCables) model.cables = backupCables;
    else delete model.cables;
    model.items = backupItems;
    throw e;
  }
  return candidate;
}

/**
 * Снимает обратные ссылки связи у ВСЕХ держателей (ревью 90 R3): вершины связи
 * (под-розетка — массив, светильник — скаляр) плюс держатели вне вершин испорченной
 * модели — лишние ссылки не остаются висячими после cable_delete. Световые линии
 * (led_strips/stripes_light/line_strips) держат ссылку в props.cables (ревью 90 R2).
 */
function unlinkCable(model: Model, cable: Cable): void {
  // под-розетки групп: массив cable_id — чистим у всех групп, где есть ссылка на этот кабель
  for (const item of Object.values(model.items)) {
    const subs = item.socket_group as SocketGroupSub[] | undefined;
    if (!Array.isArray(subs)) continue;
    for (const s of subs) {
      const cur = subCableIds(s);
      if (!cur.includes(cable.id)) continue;
      const arr = cur.filter((x) => x !== cable.id);
      if (arr.length > 0) s.cables = { cable_id: arr };
      else delete s.cables;
    }
  }
  // предметы (светильники): скаляр или массив
  for (const item of Object.values(model.items) as (ItemProps & { cables?: { cable_id?: unknown } })[]) {
    const cur = item.cables?.cable_id;
    if (cur === undefined || cur === null) continue;
    if (Array.isArray(cur)) {
      const arr = cur.filter((x) => x !== cable.id);
      if (arr.length !== cur.length) {
        if (arr.length > 0) item.cables = { cable_id: arr };
        else delete item.cables;
      }
    } else if (cur === cable.id) {
      delete item.cables;
    }
  }
  // световые линии: props.cables (формат обратной ссылки на линии — ревью 90 R2)
  for (const key of ["led_strips", "stripes_light", "line_strips"] as const) {
    for (const line of Object.values(model[key] ?? {}) as { props?: { cables?: { cable_id?: unknown } } }[]) {
      const cur = line.props?.cables?.cable_id;
      if (cur === undefined || cur === null) continue;
      if (Array.isArray(cur)) {
        const arr = cur.filter((x) => x !== cable.id);
        if (arr.length !== cur.length) {
          if (arr.length > 0) line.props!.cables = { cable_id: arr };
          else delete line.props!.cables;
        }
      } else if (cur === cable.id) {
        delete line.props!.cables;
      }
    }
  }
}

/**
 * cable_delete: связь удаляется, обратные ссылки (массив у под-розетки, скаляр
 * у светильника) снимаются. Предметы не затрагиваются — item_delete отклоняет
 * подключённые к связям предметы (сначала cable_delete).
 */
export function deleteCable(model: Model, cableId: string): void {
  const cable = model.cables?.[cableId];
  if (!cable) throw new McpError("NOT_FOUND", `связь ${cableId} не найдена в cables`);
  unlinkCable(model, cable);
  delete model.cables![cableId];
}

/** Ссылается ли какая-нибудь связь на предмет (вершина-светильник или группа с под-розеткой). */
export function cablesReferencingItem(model: Model, itemId: string): Cable[] {
  const out: Cable[] = [];
  for (const cable of Object.values(model.cables ?? {})) {
    for (const v of cable.vertexes) {
      if (v.type === "switch") {
        const parsed = parseSwitchVertexId(v.id);
        if (parsed && parsed[0] === itemId) { out.push(cable); break; }
      } else if (v.type !== "node" && v.id === itemId) {
        out.push(cable); break;
      }
    }
  }
  return out;
}

/**
 * Пересчитать вершины-предметы связей после переноса предмета (транзитивный
 * пересчёт затронутых привязок, как refreshPipeForItem): светильник — точка pc;
 * выключатель — center его под-розетки (refreshSocketGroupSubs пересчитывает
 * под-розетки до этого вызова).
 */
export function refreshCablesForItem(model: Model, itemId: string): void {
  for (const cable of Object.values(model.cables ?? {})) {
    let changed = false;
    for (const v of cable.vertexes) {
      if (v.type === "switch") {
        const parsed = parseSwitchVertexId(v.id);
        if (!parsed || parsed[0] !== itemId) continue;
        const item = model.items[parsed[0]] as ItemProps | undefined;
        const subs = item?.socket_group as SocketGroupSub[] | undefined;
        const s = Array.isArray(subs) ? subs.find((x) => x.id === parsed[1]) : undefined;
        if (s?.center) { v.point = { ...s.center }; changed = true; }
      } else if (v.type !== "node" && v.id === itemId) {
        const item = model.items[itemId] as ItemProps | undefined;
        if (item) { v.point = { ...item.pc }; changed = true; }
      }
    }
    if (changed) cable.length = gasLineLengthM(cable);
  }
}
