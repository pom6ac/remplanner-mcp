import type { Model, Cable, CableVertex, ItemProps, Point, Wall } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { McpError } from "../errors.ts";
import { add, leftNormal, scale, sub } from "./geometry.ts";
import { gasLineLengthM } from "./pipes.ts";
import { roomPolygons, inwardSideByProbe } from "./rooms.ts";

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
  // к выключателю тем же классом Cabling (lamps) — вершина "<lineId>|t|<vertexId>"
  // (проба 239-elec2-link6, часть 2): точка — вершина линии, sc — перекрёстная
  // ссылка на вершину выключателя, обратная ссылка props.cables.cable_id (скаляр)
]);
/** Световые линии, подключаемые к выключателю (вершина «<lineId>|t|<vertexId>»). */
export const CABLE_LINE_ITEMS = new Set(["led_strip", "line_light", "recessed_strip", "surface_stripe", "pendent_strip"]);

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
 * Внутренняя нормаль стены — тем же правилом пробной точки, что у
 * againstWallPlacement (общий хелпер inwardSideByProbe, ревью 209 №3): якорь —
 * проекция pc на ось стены, pc уже стоит с внутренней стороны, и на вогнутом
 * ребре невыпуклой комнаты (центр её вершин лежит снаружи) это единственный
 * надёжный ориентир. Обе или ни одна проба в комнате (перегородка, стена вне
 * помещений) — сторона pc предмета, как раньше сторона его комнаты.
 */
export function wallInwardNormal(model: Model, wall: Wall, item: ItemProps): Point {
  const dir = sub(wall.p2, wall.p1);
  const u = scale(dir, 1 / (Math.hypot(dir.x, dir.y) || 1));
  const nl = leftNormal(dir.x, dir.y);
  const wallMid = { x: (wall.p1.x + wall.p2.x) / 2, y: (wall.p1.y + wall.p2.y) / 2 };
  const along = (item.pc.x - wallMid.x) * u.x + (item.pc.y - wallMid.y) * u.y;
  const anchor = add(wallMid, scale(u, along));
  const byProbe = inwardSideByProbe(wall, nl, anchor, roomPolygons(model));
  if (byProbe) return byProbe;
  const toPc = sub(item.pc, wallMid);
  return nl.x * toPc.x + nl.y * toPc.y > 0 ? nl : scale(nl, -1);
}

/**
 * Пересчитать точки под-розетки после постановки/переноса группы (транзитивный
 * пересчёт затронутых привязок): real_center = pc группы, center/center_prs —
 * на 7 см внутрь помещения от оси стены (пробы 88: у розетки pc в 7 см от оси —
 * center совпадает; у выключателя высотой 18 pc в 9 см — center в 7 см).
 * Направление внутрь — правилом пробной точки из againstWallPlacement
 * (wallInwardNormal, ревью 209 №3).
 *
 * Перенос (oldPc): смещения под-розеток относительно pc переносятся с доворотом
 * на изменение угла. Режим resnapToWall (ревью 203 №8 — перенос against_wall на
 * другую стену): взаимное расположение под-розеток сохраняется, как у item_add
 * той же группы — вдоль-составляющая смещения относительно новой оси стены
 * переносится, нормальная ставится от новой стены (center на 7 см внутрь от
 * лица стены, real_center на оси pc). Иначе многоэлементная группа схлопывается
 * в одну точку.
 */
export function refreshSocketGroupSubs(
  model: Model, item: ItemProps, oldPc?: Point, oldAngle?: number, resnapToWall = false,
): void {
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
    const wall = resnapToWall && item.id_wall ? model.walls[item.id_wall] : undefined;
    if (!wall) {
      for (const s of subs) {
        if (s.real_center) s.real_center = rotate(s.real_center);
        if (s.center) s.center = rotate(s.center);
        if (s.center_prs) s.center_prs = { ...s.center };
      }
      return;
    }
    const u = scale(sub(wall.p2, wall.p1), 1 / (Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y) || 1));
    const inward = wallInwardNormal(model, wall, item);
    const alongOf = (p: Point): number => {
      const r = rotate(p);
      return (r.x - item.pc.x) * u.x + (r.y - item.pc.y) * u.y;
    };
    for (const s of subs) {
      if (s.real_center) {
        s.real_center = { x: r2(item.pc.x + u.x * alongOf(s.real_center)), y: r2(item.pc.y + u.y * alongOf(s.real_center)) };
      }
      if (s.center) {
        const along = alongOf(s.center);
        s.center = {
          x: r2(item.pc.x + u.x * along + inward.x * (7 - item.height / 2)),
          y: r2(item.pc.y + u.y * along + inward.y * (7 - item.height / 2)),
        };
      }
      if (s.center_prs) s.center_prs = { ...s.center };
    }
    return;
  }
  const wall = item.id_wall ? model.walls[item.id_wall] : undefined;
  const inward = wall ? wallInwardNormal(model, wall, item) : null;
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
 * cable_add: связь «выключатель → светильник/световая линия» (мм): switch_item_id —
 * предмет-группа с под-розеткой-выключателем, lamp_item_id — светильник из
 * CABLE_LAMP_ITEMS или световая линия (led_strip/line_light/трековые шины —
 * вершина "<lineId>|t|<vertexId>", проба 239-elec2-link6),
 * path — промежуточные узлы (мм, опционально). У под-розетки должен быть свободный
 * ключ (число подключённых связей < SWITCH_MAX_KEYS), у светильника — занятый слот
 * cables.cable_id отвергается (скалярная ссылка); у линии props.cables.cable_id
 * скалярен — занятая линия отвергается. Вершина выключателя —
 * "<itemId>|s|<subId>" с точкой center под-розетки; вершина светильника — id
 * предмета с точкой pc; вершина линии — "<lineId>|t|<vertexId>" с точкой вершины
 * линии и sc {вершинаВыключателя: idВершиныЛинии}. Кандидат-копия; при ошибке
 * модель не меняется.
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
  // цель: предмет-светильник или световая линия (led_strips/stripes_light/line_strips)
  let lamp: ItemProps | undefined = model.items[params.lampItemId] as ItemProps | undefined;
  let lineColl: "led_strips" | "stripes_light" | "line_strips" | undefined;
  let lineVertexId: string | undefined;
  let lineType: string | undefined;
  if (!lamp) {
    for (const coll of ["led_strips", "stripes_light", "line_strips"] as const) {
      const line = (model[coll] as Record<string, { id: string; type: string; vertexes: { id: string; point: Point }[]; props?: { cables?: { cable_id?: unknown } } }> | undefined)?.[params.lampItemId];
      if (line) {
        if (!CABLE_LINE_ITEMS.has(line.type)) {
          throw new McpError("INVALID_ARGUMENT", `линия «${line.type}» не подключается к выключателю (в редакторе у связи другой список светильников)`, {
            details: { kind: "not_connectable", item: line.type },
          });
        }
        lineColl = coll;
        lineType = line.type;
        lineVertexId = line.vertexes[0]?.id;
        break;
      }
    }
    if (!lineColl) throw new McpError("NOT_FOUND", `светильник ${params.lampItemId} не найден`);
  }
  if (lamp && !CABLE_LAMP_ITEMS.has(lamp.name)) {
    throw new McpError("INVALID_ARGUMENT", `предмет «${lamp.name}» не подключается к выключателю (в редакторе у связи другой список светильников)`, {
      details: { kind: "not_connectable", item: lamp.name },
    });
  }
  if (lamp) {
    const lampLinked = (lamp as ItemProps & { cables?: { cable_id?: unknown } }).cables?.cable_id;
    if (typeof lampLinked === "string" ? lampLinked !== "" : Array.isArray(lampLinked) ? lampLinked.length > 0 : lampLinked !== undefined && lampLinked !== null) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `светильник ${lamp.id} уже подключён к связи ${JSON.stringify(lampLinked)} — у светильника одно подключение; сначала удалите связь cable_delete`,
        { details: { kind: "already_connected", item: lamp.id } },
      );
    }
  } else {
    const line = (model[lineColl!] as Record<string, { props?: { cables?: { cable_id?: unknown } } }> | undefined)![params.lampItemId]!;
    const linked = line.props?.cables?.cable_id;
    if (typeof linked === "string" ? linked !== "" : Array.isArray(linked) ? linked.length > 0 : linked !== undefined && linked !== null) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `линия ${params.lampItemId} уже подключена к связи ${JSON.stringify(linked)} — у линии одно подключение; сначала удалите связь cable_delete`,
        { details: { kind: "already_connected", item: params.lampItemId } },
      );
    }
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
  // вершина-цель: светильник (id предмета, точка pc) или световая линия
  // ("<lineId>|t|<vertexId>", точка вершины линии, sc — перекрёстная ссылка, проба 239)
  const lampVertex: CableVertex = lamp
    ? { id: lamp.id, point: { ...lamp.pc }, type: cableLampVertexType(lamp.name) }
    : {
        id: `${params.lampItemId}|t|${lineVertexId}`,
        point: { ...((model[lineColl!] as Record<string, { vertexes: { id: string; point: Point }[] }>)[params.lampItemId]!.vertexes.find((v) => v.id === lineVertexId))!.point },
        type: lineType!,
        sc: { [switchVertex.id]: lineVertexId },
      };
  const nodeVertexes: CableVertex[] = (params.path ?? []).map((p) => ({ id: `_${newId(5)}`, point: cmPoint(p), type: "node" }));
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
    if (lamp) {
      (lamp as ItemProps & { cables?: { cable_id: string } }).cables = { cable_id: candidate.id };
    } else {
      const line = (model[lineColl!] as Record<string, { props?: { cables?: { cable_id?: unknown } }; type?: string }>)[params.lampItemId]!;
      line.props ??= { id: params.lampItemId, name: line.type ?? "" } as never;
      line.props.cables = { cable_id: candidate.id };
    }
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

/** Ссылается ли какая-нибудь связь на световую линию (вершина "<lineId>|t|<vertexId>"). */
export function cablesReferencingLine(model: Model, lineId: string): Cable[] {
  const out: Cable[] = [];
  for (const cable of Object.values(model.cables ?? {})) {
    for (const v of cable.vertexes) {
      if (v.type !== "node" && v.type !== "switch" && typeof v.id === "string" && v.id.startsWith(`${lineId}|t|`)) {
        out.push(cable);
        break;
      }
    }
  }
  return out;
}

/**
 * Пересчитать вершины-линии связей после переноса световой линии (транзитивный
 * пересчёт затронутых привязок): точка вершины связи = точка вершины линии по sc.
 */
export function refreshCablesForLine(model: Model, lineId: string): void {
  for (const cable of Object.values(model.cables ?? {})) {
    let changed = false;
    for (const v of cable.vertexes) {
      if (v.type === "node" || v.type === "switch") continue;
      if (typeof v.id !== "string" || !v.id.startsWith(`${lineId}|t|`)) continue;
      const stripVertexId = v.id.slice(lineId.length + 3);
      for (const coll of ["led_strips", "stripes_light", "line_strips"] as const) {
        const line = (model[coll] as Record<string, { vertexes: { id: string; point: Point }[] }> | undefined)?.[lineId];
        const sv = line?.vertexes.find((x) => x.id === stripVertexId);
        if (sv) { v.point = { ...sv.point }; changed = true; break; }
      }
    }
    if (changed) cable.length = gasLineLengthM(cable);
  }
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

/**
 * Вертикальные блоки («друг над другом», электрика ч.3, бандл app.3.0): у
 * пристенной электрики (розетки, выключатели, socket_thermo) слой хранится в
 * props.layer предмета. Редактор ставит слой перетаскиванием предмета на чужую
 * базовую линию (dragmoveWall: layer = чужой.layer ? чужой.layer + 1 : 2) и
 * пересчитывает pc: расстояние от оси стены = getHeight()/2 − model().offset +
 * get_offset_layer2(), где get_offset_layer2 = 26/52 см (22/44 у slope_side).
 * Связка (pairing_line, has_layer_up) — производная, в модели не хранится.
 * MCP: слой задаётся явно (1 — снять), pc пересчитывается тем же правилом с
 * сохранением собственного отступа пластины предмета (height/2 − offset), угол
 * и over_floor не трогаются. Перенос against_wall (resnap) ставит предмет на
 * базу слоя 1; у типов с can_move_between_walls (CAN_MOVE_BETWEEN_WALLS)
 * dragmoveWall редактора слой снимает — он ставится заново только сцепкой с
 * другой розеткой, в MCP — явным layer; у прочей пристенной электрики
 * (выключатели) смещение слоя сохраняется поверх новой базы (major 371 №1);
 * явный layer в том же вызове ставится относительно новой позиции.
 * Слои 4+ не поддерживаются (get_offset_layer2 обрабатывает только 2 и 3).
 */
export const SOCKET_LAYER_OFFSET_CM: Record<number, { flat: number; slope: number }> = {
  2: { flat: 26, slope: 22 },
  3: { flat: 52, slope: 44 },
};

/**
 * Типы каталога с can_move_between_walls: true (catalog-sample.json, весь
 * известный набор из живого каталога сайта). dragmoveWall бандла у таких
 * предметов первым делом снимает привязку к прежней опоре (projection,
 * slope_side, hole_group, layer = void 0): слой ставится заново только
 * сцепкой с другой розеткой (чужой.layer + 1). У прочей пристенной
 * электрики (выключатели и виды вне набора) флага в каталоге нет — общая
 * ветка dragmoveWall (if (this.baseline)) смещение слоя сохраняет.
 */
export const CAN_MOVE_BETWEEN_WALLS = new Set([
  "socket", "socket_thermo", "furniture_socket", "bra", "bra_shades",
]);

/** Тип каталога предмета-группы (имя под-розетки socket_group[0]). */
export function socketCatalogType(item: ItemProps): string | null {
  const subs = item.socket_group as SocketGroupSub[] | undefined;
  return Array.isArray(subs) && subs[0] ? subs[0].name : null;
}

/** Слой вертикального блока как число (строку "2" редактор трактует как 2 —
 *  бандл 2==layer); отсутствие/null/нечисловое — null. */
export function socketLayerNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Слой предмета: число 2/3 (строка «2» — тоже 2, как в редакторе) или
 *  отсутствие слоя (1, в модели null). */
export function socketLayerOf(item: ItemProps): number {
  const n = socketLayerNum(item.layer);
  return n !== null && n >= 2 ? n : 1;
}

/**
 * item_update layer: поменять слой вертикального блока у пристенной
 * электрики (socket_group). Возвращает true, если pc изменился.
 */
export function applySocketGroupLayer(
  model: Model, item: ItemProps, layer: number,
  opts: { prevOffsetCm?: number } = {},
): boolean {
  if (!Array.isArray(item.socket_group)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      "слой вертикального блока («друг над другом») поддерживается только у пристенной электрики — групп розеток и выключателей (socket_group)",
      { details: { kind: "not_socket_group", item: item.name } },
    );
  }
  if (!item.id_wall || !model.walls[item.id_wall]) {
    throw new McpError(
      "INVALID_ARGUMENT",
      "предмет не привязан к стене — слой вертикального блока задаётся только у электрики на стене",
      { details: { kind: "no_wall", item: item.id } },
    );
  }
  if (layer !== 1 && layer !== 2 && layer !== 3) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `слой ${layer} не поддерживается — в редакторе вертикальный блок имеет слои 1 (у стены), 2 и 3 (друг над другом)`,
      { details: { kind: "bad_layer", layer } },
    );
  }
  const wall = model.walls[item.id_wall] as Wall;
  const dir = sub(wall.p2, wall.p1);
  const u = scale(dir, 1 / (Math.hypot(dir.x, dir.y) || 1));
  const wallMid = { x: (wall.p1.x + wall.p2.x) / 2, y: (wall.p1.y + wall.p2.y) / 2 };
  const along = (item.pc.x - wallMid.x) * u.x + (item.pc.y - wallMid.y) * u.y;
  // проекция pc на ось стены (LIB.projection без ограничений отрезком —
  // редактор держит projection и за концами стены)
  const proj = add(wallMid, scale(u, along));
  const inward = wallInwardNormal(model, wall, item);
  const currentDist = (item.pc.x - proj.x) * inward.x + (item.pc.y - proj.y) * inward.y;
  const prev = socketLayerOf(item);
  const next = layer === 1 ? 1 : layer;
  // ревью 371 №2: бандл проверяет истинность slope_side, а редактор пишет туда
  // строку стороны ("1"/"2" из _.side, сброс — void 0) — сравнение === true
  // никогда не срабатывало и скос получал смещение плоского слоя (26/52 вместо 22/44)
  const slope = Boolean((item as { slope_side?: unknown }).slope_side);
  // major 371 №1: после переноса against_wall (resnap) новая позиция — база слоя 1
  // (редактор при перетаскивании вдоль стены держит смещение слоя поверх базы:
  // dragmoveWall pc = ... + get_offset_layer2()), поэтому prevOffset = 0
  const prevOffset = opts.prevOffsetCm ?? SOCKET_LAYER_OFFSET_CM[prev]?.[slope ? "slope" : "flat"] ?? 0;
  const nextOffset = SOCKET_LAYER_OFFSET_CM[next]?.[slope ? "slope" : "flat"] ?? 0;
  const newDist = currentDist - prevOffset + nextOffset;
  const newPc = add(proj, scale(inward, newDist));
  const changed = Math.abs(newPc.x - item.pc.x) > 1e-9 || Math.abs(newPc.y - item.pc.y) > 1e-9 || socketLayerOf(item) !== next;
  item.pc = { x: r2(newPc.x), y: r2(newPc.y) };
  item.layer = next === 1 ? null : next;
  return changed;
}
