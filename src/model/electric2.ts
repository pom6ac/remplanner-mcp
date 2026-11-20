import type { Model, ElecCable, ElecCableVertex, ItemProps, Point, ElecLinkItem } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { McpError } from "../errors.ts";
import { add, scale, sub } from "./geometry.ts";
import { gasLineLengthM } from "./pipes.ts";
import { wallInwardNormal, SOCKET_GROUP_SUBS, parseSwitchVertexId, type SocketGroupSub } from "./electric.ts";
import { warmWallEntries, warmWallCableOf, clearWarmWallCableLink, warmWallLinkHolders } from "./warmwall.ts";

/**
 * Кабели-проводка (часть 2, 2026-11-19): лист «Электропроводка» — model.cables_socket
 * (кабели 2–5 жил, заземление, слаботочные — ключи инструментов wire_*), провода
 * warm_floor_wire (model.cables_warm_floor) и conditioner_wire (model.cables_conditioner).
 * Формат — граф GraphLines (пробы 239-elec2-pro-scout/239-elec2-links/239-elec2-attach5/
 * 239-elec2-link6): вершины-предметы type "multi" (щитки/коробки, ссылка-МАССИВ) и
 * "electrospot" (розетки/выводы, ссылка-СКАЛЯР; у тёплого пола type = имя под-элемента),
 * pp — перекрёстные ссылки multi-вершин. Длина — метры, редактор считает с опусками до
 * точек (плоскость расчёта — в меню щитка); формула не воспроизведена — при сверке
 * производная (см. verify/elec.ts).
 */

/** Коллекции-графы проводки (порядок = порядок меток в компактном API). */
export const ELEC_CABLE_COLLECTIONS = ["cables_socket", "cables_warm_floor", "cables_conditioner"] as const;

export type ElecCableColl = (typeof ELEC_CABLE_COLLECTIONS)[number];

/** Кабели листа «Электропроводка» (31 тип из каталога, пробы 239-elec2-scout). */
export const SOCKET_CABLE_TOOLS = [
  "wire_2_05", "wire_2_07", "wire_2_15", "wire_2_25", "wire_2_40", "wire_2_60",
  "wire_3_15", "wire_3_25", "wire_3_40", "wire_3_60", "wire_3_100",
  "wire_4_15", "wire_4_25", "wire_4_40", "wire_4_60", "wire_4_100",
  "wire_5_15", "wire_5_25", "wire_5_40", "wire_5_60", "wire_5_100",
  "wire_earth_1_40", "wire_earth_1_100", "wire_earth_3_15", "wire_earth_3_60",
  "wire_tv", "wire_utp", "wire_hdmi", "wire_audio", "wire_phone", "wire_optical",
] as const;

/** Все ключи инструментов-кабелей по коллекциям (warm_floor_wire/conditioner_wire — по одной). */
export const ELEC_CABLE_TOOLS: Record<ElecCableColl, readonly string[]> = {
  cables_socket: SOCKET_CABLE_TOOLS,
  cables_warm_floor: ["warm_floor_wire"],
  cables_conditioner: ["conditioner_wire"],
};

/**
 * Ключ обратной ссылки предмета для кабеля (cable_wire_3_25_id / cable_warm_floor_id /
 * conditioner_cable_id — names_line_id_by_tool менеджеров, проба 250-connect4:
 * у трассы кондиционера редактор использует conditioner_cable_id, не cable_conditioner_id).
 */
export function elecLinkKey(coll: ElecCableColl, cableType: string): string {
  if (coll === "cables_conditioner") return "conditioner_cable_id";
  return `cable_${coll === "cables_socket" ? cableType : coll.replace("cables_", "")}_id`;
}

/** Коллекция и проверка типа кабеля; неизвестный тип — INVALID_ARGUMENT. */
export function elecCollOfTool(tool: string): ElecCableColl {
  for (const coll of ELEC_CABLE_COLLECTIONS) {
    if (ELEC_CABLE_TOOLS[coll].includes(tool)) return coll;
  }
  throw new McpError(
    "INVALID_ARGUMENT",
    `неизвестный тип кабеля «${tool}» (кабели листа «Электропроводка»: wire_2_05…wire_5_100, wire_earth_*, wire_tv/utp/hdmi/audio/phone/optical; warm_floor_wire; conditioner_wire)`,
  );
}

/** multi-предметы (щитки и коробки): вершина type "multi", ссылка-массив (пробы 239-elec2). */
export const ELEC_MULTI_ITEMS = new Set([
  "electric_shield", "electric_shield_internal", "electric_shield_old",
  "lowcurrent_shield", "lowcurrent_shield_internal",
  "electric_box", "electric_box_wall", "electric_kup",
]);

/** Выводы проводов (группа wires, лист «Розетки») — самостоятельные предметы, вершина "electrospot". */
export const ELEC_WIRE_ITEMS = new Set([
  "wire", "wire_light", "wire_oven", "wire_stove", "wire_conditioner", "wire_lowcurrent",
  "floor_wire", "ceiling_wire",
]);

/** Под-розетка-терморегулятор (лист «Тёплые полы») — вершина кабеля warm_floor_wire. */
export const ELEC_THERMO_SUBS = new Set(["socket_thermo"]);

/**
 * Контуры тёплого пола — вершины кабеля warm_floor_wire (климат ч.3, этап 268,
 * проба 268-recon5: source_items CablingWarnFloor — у wire от socket_group
 * подключаются warm_floor/warm_floor_ir/warm_wall_cable/node; водяной контур
 * warm_floor_water к проводу НЕ подключается — у него магистрали pipes_warm_floor).
 */
export const ELEC_WIRE_CONTOUR_TYPES = new Set(["warm_floor", "warm_floor_ir"]);

/**
 * Предметы кондиционера, подключаемые кабелем conditioner_wire (source_items
 * CablingConditioner, бандл app.3.0; проба 250-connect4): внутренние/внешние блоки,
 * напольный кондиционер, канальные/кассетные блоки, клапан, бризер, рекуператор.
 * Вершина — type "electrospot", point = pc предмета (у трассы кондиционера нет
 * сдвига «7 см от грани» — get_point возвращает props.pc, проба 250-connect4).
 */
export const ELEC_CONDITIONER_ITEMS = new Set([
  "conditioner", "conditioner_engine", "external_block_multisplit", "floor_conditioner",
  "duct_indoor_block", "cassette_indoor_block", "inflow_valve", "breezer", "recuperator",
]);

/** Предметы, подключаемые к кабелю коллекции (электрощиток, коробки, розетки, выводы). */
export function elecConnectable(coll: ElecCableColl, item: ItemProps): boolean {
  if (ELEC_MULTI_ITEMS.has(item.name)) return true;
  if (coll === "cables_socket") {
    if (ELEC_WIRE_ITEMS.has(item.name)) return true;
    const subs = item.socket_group as SocketGroupSub[] | undefined;
    return item.name === "socket_group" && Array.isArray(subs)
      && subs.some((s) => SOCKET_GROUP_SUBS.has(s.name));
  }
  if (coll === "cables_warm_floor") {
    const subs = item.socket_group as SocketGroupSub[] | undefined;
    return item.name === "socket_group" && Array.isArray(subs)
      && subs.some((s) => ELEC_THERMO_SUBS.has(s.name));
  }
  // cables_conditioner: блоки кондиционера, клапан, бризер, рекуператор (проба 250-connect4)
  return ELEC_CONDITIONER_ITEMS.has(item.name);
}

/**
 * Точка вершины вывода/под-розетки (одно правило для создания связи и пересчёта
 * после item_update): у под-розетки — её center; у трассы кондиционера — pc
 * предмета (без сдвига); у вывода проводки — 7 см от грани стены
 * (пробы 239-elec2, 250-connect4).
 */
export function elecVertexPoint(model: Model, item: ItemProps, sub?: SocketGroupSub, coll?: ElecCableColl): Point {
  if (sub?.center) return { ...sub.center };
  if (coll === "cables_conditioner" && !sub) return { ...item.pc };
  if (!item.id_wall) return { ...item.pc };
  const wall = model.walls[item.id_wall];
  if (!wall) return { ...item.pc };
  const inward = wallInwardNormal(model, wall, item);
  const shift = 7 - item.height / 2;
  return { x: r2(item.pc.x + inward.x * shift), y: r2(item.pc.y + inward.y * shift) };
}

/** Вершина-предмет кабеля: {vertex, holder} — holder для обратной ссылки. */
type ElecVertexSpec = {
  kind: "multi" | "electrospot" | "warm_floor" | "warm_wall";
  vertex: ElecCableVertex;
  itemId: string;
  subId?: string;
};

/**
 * Вершина-контур кабеля warm_floor_wire (климат ч.3, этап 268, проба 268-recon5):
 * {id: id контура, point: polygon[0], type: "warm_floor"} — точка вершины polygon[0]
 * (get_point редактора: props.pc ?? polygon[0]), pp {i, d} — производное протяжки
 * (проекция точки захвата мышью на ребро полигона), MCP его не пишет. Обратная
 * ссылка — props контура: props.cables_warm_floor.cable_warm_floor_id (скаляр —
 * в редакторе к контуру подключается один провод, l10n not_connect_same_floor).
 * Водяной контур (warm_floor_water) не подключается.
 */
export function elecContourVertex(model: Model, contourId: string): ElecVertexSpec {
  const wf = model.warm_floors?.[contourId];
  if (!wf) throw new McpError("NOT_FOUND", `контур тёплого пола ${contourId} не найден`);
  if (!ELEC_WIRE_CONTOUR_TYPES.has(wf.type)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `контур ${wf.id} (${wf.type}) не подключается к кабелю тёплого пола — в редакторе к проводу подключаются кабельный и инфракрасный контуры (у водяного — магистрали: pipe_add kind=warm_floor)`,
      { details: { kind: "not_connectable", item: wf.type, wiring: "warm_floor_wire" } },
    );
  }
  const p0 = wf.polygon[0] ?? { x: 0, y: 0 };
  return { kind: "warm_floor", itemId: wf.id, vertex: { id: wf.id, point: { ...p0 }, type: "warm_floor" } };
}

/**
 * Вершина-тёплая стена кабеля warm_floor_wire (этап 273, пробы 273-recon2/273-recon3):
 * {id: id части (WarmLine в rooms2[rid].warms_walls[edge].parts), point: центр
 * линии части (LIB.lineCenter), type: "warm_wall"}; pp {i, d} — производное
 * протяжки, MCP не пишет. Обратная ссылка — props части:
 * cables_warm_floor.cable_warm_floor_id (СКАЛЯР — у тёплой стены одно
 * подключение, l10n cabling_warm_floor_not_connect_same_wall).
 */
export function elecWarmWallVertex(model: Model, warmWallRef: string): ElecVertexSpec {
  const entries = warmWallEntries(model);
  const hit = entries.find((e) => e.part.id === warmWallRef)
    ?? (/^WW(\d+)$/.exec(warmWallRef) ? entries[Number(/^WW(\d+)$/.exec(warmWallRef)![1]) - 1] : undefined);
  if (!hit) throw new McpError("NOT_FOUND", `тёплая стена ${warmWallRef} не найдена (warm_wall_list)`);
  const linked = warmWallCableOf(hit.part);
  if (linked) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `тёплая стена ${hit.part.id} уже подключена к кабелю тёплого пола ${linked} — у тёплой стены одно подключение (не_connect_same_wall); сначала удалите его (wiring_delete)`,
      { details: { kind: "already_connected", item: hit.part.id, wiring: linked } },
    );
  }
  const line = hit.part.line;
  const center = { x: r2((line.p1.x + line.p2.x) / 2), y: r2((line.p1.y + line.p2.y) / 2) };
  return { kind: "warm_wall", itemId: hit.part.id, vertex: { id: hit.part.id, point: center, type: "warm_wall" } };
}

/** Контур тёплого пола по id или метке WF<n> (одна карта меток с tools-plan). */
function resolveContourRef(model: Model, ref: string): string {
  if (model.warm_floors?.[ref]) return ref;
  const m = /^WF(\d+)$/.exec(ref);
  if (m) {
    const wf = Object.values(model.warm_floors ?? {})[Number(m[1]) - 1];
    if (wf) return wf.id;
  }
  return ref;
}

/** Резолв элемента пути wiring_add для кабелей тёплого пола: контур, тёплая стена
 *  (id части или метка WW<n> — предмета с таким литеральным id не бывает) или предмет. */
export function elecVertexOfRef(model: Model, coll: ElecCableColl, itemId: string): ElecVertexSpec {
  if (coll === "cables_warm_floor") {
    if (model.warm_floors?.[itemId] || /^WF\d+$/.test(itemId)) return elecContourVertex(model, resolveContourRef(model, itemId));
    if (/^WW\d+$/.test(itemId) || warmWallEntries(model).some((e) => e.part.id === itemId)) return elecWarmWallVertex(model, itemId);
  }
  return itemVertex(model, coll, itemId);
}

function itemVertex(model: Model, coll: ElecCableColl, itemId: string): ElecVertexSpec {
  const item = model.items?.[itemId] as ItemProps | undefined;
  if (!item) throw new McpError("NOT_FOUND", `предмет ${itemId} не найден`);
  if (!elecConnectable(coll, item)) {
    // ревью 253 Н2: текст зависит от коллекции — у conditioner_wire один набор
    // выводов (блоки кондиционера, клапан, бризер, рекуператор, щиток),
    // у остальных кабелей — щиток, коробки, розетки, выводы проводов
    const outputs = coll === "cables_conditioner"
      ? "блоки кондиционера, клапан, бризер, рекуператор, щиток"
      : "щиток, коробки, розетки, выводы проводов";
    throw new McpError(
      "INVALID_ARGUMENT",
      `предмет «${item.name}» не подключается к кабелю этой проводки (в редакторе у кабеля другие выводы: ${outputs})`,
      { details: { kind: "not_connectable", item: item.name } },
    );
  }
  if (ELEC_MULTI_ITEMS.has(item.name)) {
    return { kind: "multi", itemId, vertex: { id: item.id, point: { ...item.pc }, type: "multi" } };
  }
  const subs = item.socket_group as SocketGroupSub[] | undefined;
  const sub = Array.isArray(subs) ? subs.find((s) => coll === "cables_socket" ? SOCKET_GROUP_SUBS.has(s.name) : ELEC_THERMO_SUBS.has(s.name)) : undefined;
  if (sub) {
    const type = coll === "cables_socket" ? "electrospot" : sub.name;
    return { kind: "electrospot", itemId, subId: sub.id, vertex: { id: `${item.id}|s|${sub.id}`, point: elecVertexPoint(model, item, sub, coll), type } };
  }
  // самостоятельный вывод провода / блок кондиционера
  return { kind: "electrospot", itemId, vertex: { id: item.id, point: elecVertexPoint(model, item, undefined, coll), type: "electrospot" } };
}

/** Существующая ссылка предмета/под-розетки на кабели этого вида (скаляр или массив). */
function existingLinks(item: ItemProps, coll: ElecCableColl, cableType: string): string[] {
  const holder = (item as ItemProps & { [k: string]: unknown })[coll] as { [k: string]: unknown } | undefined;
  const cur = holder?.[elecLinkKey(coll, cableType)];
  if (Array.isArray(cur)) return cur.filter((x): x is string => typeof x === "string");
  if (typeof cur === "string" && cur !== "") return [cur];
  return [];
}

function holderOf(model: Model, coll: ElecCableColl, itemId: string, subId?: string): Record<string, unknown> | undefined {
  const item = model.items?.[itemId] as ItemProps | undefined;
  if (!item) return undefined;
  if (subId) {
    const subs = item.socket_group as SocketGroupSub[] | undefined;
    const sub = Array.isArray(subs) ? subs.find((s) => s.id === subId) : undefined;
    return sub as unknown as Record<string, unknown> | undefined;
  }
  return item as unknown as Record<string, unknown>;
}

/** Проверка занятости скалярного слота под-розетки/вывода/контура (до любых мутаций). */
function assertScalarSlotsFree(model: Model, coll: ElecCableColl, cableType: string, specs: ElecVertexSpec[]): void {
  for (const s of specs) {
    if (s.kind === "multi") continue;
    // тёплая стена: занятость слота проверяет elecWarmWallVertex (props части)
    if (s.kind === "warm_wall") continue;
    if (s.kind === "warm_floor") {
      const wf = model.warm_floors?.[s.itemId];
      const cur = (wf?.props?.[coll] as { [k: string]: unknown } | undefined)?.[elecLinkKey(coll, cableType)];
      if (typeof cur === "string" && cur !== "") {
        throw new McpError(
          "INVALID_ARGUMENT",
          `контур ${s.itemId} уже подключён к кабелю тёплого пола ${cur} — у контура одно подключение; сначала удалите его (wiring_delete)`,
          { details: { kind: "already_connected", item: s.itemId, wiring: cur } },
        );
      }
      continue;
    }
    const holder = holderOf(model, coll, s.itemId, s.subId);
    const cur = holder?.[coll] as { [k: string]: unknown } | undefined;
    const linked = cur?.[elecLinkKey(coll, cableType)];
    const used = typeof linked === "string" && linked !== "" ? [linked] : Array.isArray(linked) ? linked.filter((x) => typeof x === "string") : [];
    if (used.length > 0) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `${s.subId ? "под-розетка" : "предмет"} ${s.itemId}${s.subId ? `/${s.subId}` : ""} уже подключён к кабелю ${String(used[0])} этого вида — у вывода одно подключение на тип кабеля; сначала удалите его (wiring_delete)`,
        { details: { kind: "already_connected", item: s.itemId, wiring: used[0] } },
      );
    }
  }
}

export type ElecPathElement = { x: number; y: number } | { itemId: string };

/** Лимит точек пути кабеля (матрица квадратична; как у труб — с запасом). */
export const MAX_ELEC_PATH_NODES = 32;

function validatePath(path: ElecPathElement[]): void {
  if (!Array.isArray(path) || path.length < 2) {
    throw new McpError("INVALID_ARGUMENT", "путь кабеля должен содержать минимум 2 точки (узлы и/или предметы)");
  }
  if (path.length > MAX_ELEC_PATH_NODES) {
    throw new McpError("INVALID_ARGUMENT", `путь кабеля слишком длинный: ${path.length} точек (лимит ${MAX_ELEC_PATH_NODES})`);
  }
  const seenItems = new Set<string>();
  for (const el of path) {
    if ("x" in el) {
      if (!Number.isFinite(el.x) || !Number.isFinite(el.y)) {
        throw new McpError("INVALID_ARGUMENT", "координаты узла кабеля должны быть конечными числами");
      }
    } else {
      if (typeof el.itemId !== "string" || el.itemId === "") {
        throw new McpError("INVALID_ARGUMENT", "элемент пути кабеля: ожидается {x, y} (мм) или {item_id}");
      }
      if (seenItems.has(el.itemId)) {
        throw new McpError("INVALID_ARGUMENT", `предмет ${el.itemId} встречается в пути кабеля дважды — у вершины-предмета одно подключение`);
      }
      seenItems.add(el.itemId);
    }
  }
}

function cmPoint(pt: MmPoint): Point {
  return { x: r2(mmToCm(pt.x)), y: r2(mmToCm(pt.y)) };
}

/**
 * wiring_add: кабель-проводка по пути из узлов ({x, y}, мм) и предметов ({item_id}).
 * tool — ключ инструмента UI (wire_3_25, warm_floor_wire, conditioner_wire) — он же
 * type коллекции; коллекция определяется по типу. У multi-предметов (щиток, коробки)
 * вершины получают pp-перекрёстные ссылки, у предметов — обратные ссылки
 * props.<coll>.cable_<тип>_id (массив у multi, скаляр у выводов). У warm_floor_wire
 * элемент пути может быть контуром тёплого пола (кабельный/ИК, метка WF<n> или id
 * сайта): вершина {id: id контура, point: polygon[0], type: "warm_floor"}, ссылка в
 * props контура (климат ч.3, этап 268). Правила редактора (source_items/l10n):
 * один терморегулятор на кабель, у контура одно подключение; MCP строже
 * редактора: в редакторе запрещён прямой штрих контур–контур
 * (not_connect_two_floor), терморегулятор с двумя контурами MCP не строит
 * (ревью 271 N3).
 * Повторное подключение вывода к кабелю того же вида
 * отклоняется. Кандидат-копия до записи; при ошибке модель не меняется.
 */
export function addElecCable(model: Model, params: { tool: string; path: ElecPathElement[] }): ElecCable {
  const coll = elecCollOfTool(params.tool);
  const cableType = params.tool;
  validatePath(params.path ?? []);
  const specs: ElecVertexSpec[] = [];
  const refToSpec = new Map<string, ElecVertexSpec>();
  const seenItems = new Set<string>();
  for (const el of params.path) {
    if ("itemId" in el) {
      const v = elecVertexOfRef(model, coll, el.itemId);
      if (!refToSpec.has(el.itemId)) refToSpec.set(el.itemId, v);
      if (specs.some((s) => s.vertex.id === v.vertex.id && s.vertex.type !== "node" && v.vertex.type !== "node")) {
        throw new McpError("INVALID_ARGUMENT", `предмет ${el.itemId} встречается в пути кабеля дважды — у вершины-предмета одно подключение`);
      }
      specs.push(v);
    }
  }
  // ревью правил редактора (климат ч.3): один терморегулятор на кабель
  // (l10n cabling_warm_floor_not_connect_two_thermo). Контур-к-контуру: MCP
  // строже редактора (ревью 271 N3) — в бандле запрещён прямой штрих
  // контур–контур (l10n not_connect_two_floor «Нельзя соединить два теплых
  // пола»), а терморегулятор с двумя контурами (двумя штрихами) бандл, судя
  // по check_allow_connect, разрешает: второй штрих проверяется только по
  // same_floor/two_thermo. MCP такой путь не строит — у кабеля не более
  // одного контура (ревью 269 m2: прежняя проверка соседства в specs
  // пропускала путь «контур → терморегулятор → контур», а подсказка
  // «добавьте узел» противоречила факту — узел разделителем не служит)
  if (coll === "cables_warm_floor") {
    const thermos = specs.filter((s) => s.subId !== undefined);
    if (thermos.length > 1) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `в пути кабеля тёплого пола ${thermos.length} терморегулятора — в редакторе у кабеля один терморегулятор`,
        { details: { kind: "two_thermo", items: thermos.map((s) => s.itemId) } },
      );
    }
    const contours = specs.filter((s) => s.kind === "warm_floor");
    if (contours.length > 1) {
      throw new McpError(
        "INVALID_ARGUMENT",
        `в пути кабеля тёплого пола ${contours.length} контура — MCP строже редактора: в редакторе запрещён прямой штрих контур–контур; терморегулятор с двумя контурами MCP не строит — подключите каждый контур отдельным кабелем`,
        { details: { kind: "two_contours", items: contours.map((s) => s.itemId) } },
      );
    }
  }
  assertScalarSlotsFree(model, coll, cableType, specs);
  const specByItem = new Map<string, ElecVertexSpec>();
  for (const s of specs) {
    if (!specByItem.has(s.itemId)) specByItem.set(s.itemId, s);
  }
  const vertexes: ElecCableVertex[] = [];
  for (const el of params.path) {
    if ("x" in el) {
      const p = cmPoint({ x: el.x, y: el.y });
      const last = vertexes[vertexes.length - 1];
      if (last && last.type === "node" && last.point.x === p.x && last.point.y === p.y) {
        throw new McpError("INVALID_ARGUMENT", "в пути кабеля подряд идут одинаковые узлы");
      }
      vertexes.push({ id: `_${newId(5)}`, point: p, type: "node" });
    } else {
      const spec = refToSpec.get(el.itemId) ?? specByItem.get(el.itemId);
      if (!spec) throw new McpError("INVALID_ARGUMENT", `предмет ${el.itemId} не разрешён в пути этого кабеля`);
      if (vertexes.some((v) => v.id === spec.vertex.id && v.type !== "node")) {
        throw new McpError("INVALID_ARGUMENT", `предмет ${el.itemId} встречается в пути кабеля дважды — у вершины-предмета одно подключение`);
      }
      vertexes.push(spec.vertex);
    }
  }
  if (vertexes.length < 2) {
    throw new McpError("INVALID_ARGUMENT", "путь кабеля должен содержать минимум 2 точки (узлы и/или предметы)");
  }
  // pp multi-вершин: перекрёстные ссылки на другие вершины-предметы (пробы 239-elec2)
  for (const v of vertexes) {
    if (v.type !== "multi") continue;
    const pp: Record<string, { i: number; d: number }> = {};
    for (const other of vertexes) {
      if (other === v || other.type === "node") continue;
      pp[other.id] = { i: 0, d: 0.5 };
    }
    v.pp = pp;
  }
  const n = vertexes.length;
  const matrix: ({ length: number } | null)[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
  for (let i = 0; i + 1 < n; i++) {
    matrix[i]![i + 1] = { length: 1 };
    matrix[i + 1]![i] = { length: 1 };
  }
  const items: Record<string, string> = {};
  for (const v of vertexes) items[v.id] = v.type;
  const candidate: ElecCable = {
    id: newId(10),
    matrix,
    vertexes,
    items,
    type: cableType,
    length: gasLineLengthM({ vertexes: vertexes as never, matrix }),
  };
  // атомарная запись: кабель + обратные ссылки (откат при ошибке)
  const had = model[coll] !== undefined;
  const backupCables = had ? structuredClone(model[coll]) : undefined;
  const backupItems = structuredClone(model.items);
  const backupWarmFloors = structuredClone(model.warm_floors);
  const hadRooms2 = model.rooms2 !== undefined;
  const backupRooms2 = hadRooms2 ? structuredClone(model.rooms2) : undefined;
  (model as Record<string, unknown>)[coll] ??= {};
  try {
    model[coll]![candidate.id] = candidate;
    for (const s of specs) {
      const key = elecLinkKey(coll, cableType);
      if (s.kind === "warm_wall") {
        // ссылка в props части тёплой стены (rooms2[rid].warms_walls[edge].parts)
        // — как set_tree_id редактора (проба 273-recon2: props дописаны сразу)
        const entry = warmWallEntries(model).find((e) => e.part.id === s.itemId);
        if (!entry) continue;
        const props = (entry.part.props ??= { id: entry.part.id, name: "warm_wall_cable" });
        const box = (props as unknown as Record<string, Record<string, unknown>>)[coll] ??= {} as Record<string, unknown>;
        box[key] = candidate.id;
        continue;
      }
      if (s.kind === "warm_floor") {
        // ссылка в props контура (cables_warm_floor.cable_warm_floor_id) — как
        // set_tree_id редактора (проба 268-recon5: props дописаны сразу)
        const wf = model.warm_floors?.[s.itemId];
        if (!wf) continue;
        const props = (wf.props ??= { id: wf.id, name: wf.type });
        const wfBox = (props as unknown as Record<string, Record<string, unknown>>)[coll] ??= {} as Record<string, unknown>;
        wfBox[key] = candidate.id;
        continue;
      }
      const holder = holderOf(model, coll, s.itemId, s.subId)!;
      const box = (holder[coll] ??= {} as Record<string, unknown>) as Record<string, unknown>;
      if (s.kind === "multi") {
        const arr = Array.isArray(box[key]) ? (box[key] as string[]) : [];
        arr.push(candidate.id);
        box[key] = arr;
      } else {
        box[key] = candidate.id;
      }
    }
  } catch (e) {
    if (backupCables) (model as Record<string, unknown>)[coll] = backupCables;
    else delete model[coll];
    model.items = backupItems;
    if (backupWarmFloors !== undefined || model.warm_floors !== undefined) {
      if (backupWarmFloors) model.warm_floors = backupWarmFloors;
      else delete model.warm_floors;
    }
    if (hadRooms2) {
      if (backupRooms2 !== undefined) model.rooms2 = backupRooms2;
      else delete model.rooms2;
    } else delete model.rooms2;
    throw e;
  }
  return candidate;
}

/**
 * wiring_update: перенос узлов графа (только вершины type "node"; вершины-предметы
 * следуют за своими предметами — item_update пересчитывает их транзитивно).
 * positions — список {vertex, x_mm, y_mm} (vertex — индекс в vertexes, 0-based).
 * Длина пересчитывается по рёбрам; формула опусков редактора не воспроизведена —
 * длина производная и в сверке не блокирует. Кандидат-копия; при ошибке модель не меняется.
 */
export function updateElecCable(
  model: Model,
  params: { wiringId: string; positions?: { vertex: number; x: number; y: number }[] },
): ElecCable {
  const found = findElecCable(model, params.wiringId);
  if (!found) throw new McpError("NOT_FOUND", `кабель ${params.wiringId} не найден`);
  const cable = found.cable;
  const positions = params.positions ?? [];
  if (positions.length === 0) return cable;
  for (const p of positions) {
    if (!Number.isInteger(p.vertex) || p.vertex < 0 || p.vertex >= cable.vertexes.length) {
      throw new McpError("INVALID_ARGUMENT", `vertex ${String(p.vertex)}: индекс вне диапазона 0..${cable.vertexes.length - 1}`);
    }
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new McpError("INVALID_ARGUMENT", "координаты узла кабеля должны быть конечными числами");
    }
  }
  const candidate = structuredClone(cable);
  for (const p of positions) {
    const v = candidate.vertexes[p.vertex]!;
    if (v.type !== "node") {
      throw new McpError(
        "INVALID_ARGUMENT",
        `вершина ${p.vertex} — предмет (${v.type}): она следует за предметом; переместите его item_update`,
      );
    }
    v.point = cmPoint({ x: p.x, y: p.y });
  }
  candidate.length = gasLineLengthM({ vertexes: candidate.vertexes as never, matrix: candidate.matrix });
  // assignCandidate-семантика: замена полей кандидата in-place
  cable.matrix = candidate.matrix;
  cable.vertexes = candidate.vertexes;
  cable.items = candidate.items;
  cable.length = candidate.length;
  return cable;
}

/** Найти кабель по id во всех коллекциях-графах проводки. */
export function findElecCable(model: Model, wiringId: string): { coll: ElecCableColl; cable: ElecCable } | null {
  for (const coll of ELEC_CABLE_COLLECTIONS) {
    const cable = (model[coll] as Record<string, ElecCable> | undefined)?.[wiringId];
    if (cable) return { coll, cable };
  }
  return null;
}

/** Ссылается ли какой-нибудь кабель проводки на предмет (вершина multi/electrospot). */
export function elecCablesReferencingItem(model: Model, itemId: string): ElecCable[] {
  const out: ElecCable[] = [];
  for (const coll of ELEC_CABLE_COLLECTIONS) {
    for (const cable of Object.values((model[coll] ?? {}) as Record<string, ElecCable>)) {
      for (const v of cable.vertexes) {
        if (v.type === "node") continue;
        if (v.id === itemId || v.id.startsWith(`${itemId}|s|`)) { out.push(cable); break; }
      }
    }
  }
  return out;
}

/** Снять обратные ссылки предмета/под-розеток/контура на кабель (удаление). */
function unlinkElecCable(model: Model, coll: ElecCableColl, cable: ElecCable): void {
  const key = elecLinkKey(coll, cable.type);
  for (const item of Object.values(model.items) as (ItemProps & { [k: string]: unknown })[]) {
    const clean = (holder: Record<string, unknown> | undefined) => {
      const box = holder?.[coll] as Record<string, unknown> | undefined;
      const cur = box?.[key];
      if (cur === undefined) return;
      if (Array.isArray(cur)) {
        const arr = cur.filter((x) => x !== cable.id);
        if (arr.length > 0) box![key] = arr;
        else delete box![key];
      } else if (cur === cable.id) {
        delete box![key];
      }
      if (box && Object.keys(box).length === 0 && holder) delete holder[coll];
    };
    clean(item as unknown as Record<string, unknown>);
    const subs = item.socket_group as SocketGroupSub[] | undefined;
    if (Array.isArray(subs)) for (const s of subs) clean(s as unknown as Record<string, unknown>);
  }
  // контуры тёплого пола: props.cables_warm_floor.cable_warm_floor_id (климат ч.3)
  for (const wf of Object.values(model.warm_floors ?? {})) {
    const props = wf.props as Record<string, unknown> | undefined;
    const box = props?.[coll] as Record<string, unknown> | undefined;
    const cur = box?.[key];
    if (cur === cable.id) {
      delete box![key];
      if (props && box && Object.keys(box).length === 0) delete props[coll];
    } else if (Array.isArray(cur)) {
      const arr = cur.filter((x) => x !== cable.id);
      if (arr.length > 0) box![key] = arr;
      else {
        delete box![key];
        if (props && Object.keys(box!).length === 0) delete props[coll];
      }
    }
  }
  // тёплые стены: props части в rooms2 (этап 273)
  if (coll === "cables_warm_floor") clearWarmWallCableLink(model, cable.id);
}

/**
 * wiring_delete: кабель удаляется (из своей коллекции), обратные ссылки предметов
 * и под-розеток снимаются. Предметы не затрагиваются — item_delete отклоняет
 * предметы, подключённые к кабелям (сначала wiring_delete).
 */
export function deleteElecCable(model: Model, wiringId: string): void {
  const found = findElecCable(model, wiringId);
  if (!found) throw new McpError("NOT_FOUND", `кабель ${wiringId} не найден`);
  unlinkElecCable(model, found.coll, found.cable);
  delete (model[found.coll] as Record<string, ElecCable>)[wiringId];
}

/**
 * Пересчитать вершины-предметы кабелей проводки после переноса предмета
 * (транзитивный пересчёт затронутых привязок): multi (щитки/коробки, ревью 241
 * №2) — точка pc предмета БЕЗ сдвига «7 см от грани» (тот сдвиг — только для
 * выводов); electrospot — center под-розетки (refreshSocketGroupSubs
 * пересчитывает под-розетки до этого вызова) или точка на 7 см от грани стены.
 * Длина пересчитывается по рёбрам.
 */
export function refreshElecCablesForItem(model: Model, itemId: string): void {
  for (const coll of ELEC_CABLE_COLLECTIONS) {
    for (const cable of Object.values((model[coll] ?? {}) as Record<string, ElecCable>)) {
      let changed = false;
      for (const v of cable.vertexes) {
        if (v.type === "node") continue;
        const [gid, subId] = v.id.includes("|s|") ? (() => {
          const idx = v.id.indexOf("|s|");
          return [v.id.slice(0, idx), v.id.slice(idx + 3)];
        })() : [v.id, undefined];
        if (gid !== itemId) continue;
        const item = model.items[itemId] as ItemProps | undefined;
        if (!item) continue;
        if (ELEC_MULTI_ITEMS.has(item.name)) {
          // ревью 241 №2: у multi-предметов вершина = pc (как в addElecCable);
          // сдвиг «7 см от грани» относится только к выводам (electrospot)
          v.point = { ...item.pc };
          changed = true;
          continue;
        }
        const subs = item.socket_group as SocketGroupSub[] | undefined;
        const sub = subId && Array.isArray(subs) ? subs.find((s) => s.id === subId) : undefined;
        const pt = sub ? elecVertexPoint(model, item, sub, coll) : elecVertexPoint(model, item, undefined, coll);
        v.point = pt;
        changed = true;
      }
      if (changed) cable.length = gasLineLengthM({ vertexes: cable.vertexes as never, matrix: cable.matrix });
    }
  }
}

/** Под-розетка по полному id вершины "<gid>|s|<subId>" (для сверок и удаления). */
export function elecVertexOwner(vertexId: string): [string, string | undefined] {
  const parsed = parseSwitchVertexId(vertexId);
  return parsed ? [parsed[0], parsed[1]] : [vertexId, undefined];
}

/**
 * Пересчитать вершины-контуры кабелей тёплого пола после переноса контура
 * (warm_floor_update, климат ч.3): point вершины = новый polygon[0] контура
 * (get_point редактора), длина пересчитывается по рёбрам. pp вершины-контура
 * ({i, d} — производное протяжки) не трогается: оно ссылается на ребро полигона,
 * порядок вершин полигона warm_floor_update сохраняет. Вызывается из
 * updateWarmFloor только при реальном изменении polygon[0] (пересчёт только
 * затронутых привязок).
 */
export function refreshElecCablesForWarmFloor(model: Model, warmFloorId: string, polygon0: Point): boolean {
  let any = false;
  for (const cable of Object.values((model.cables_warm_floor ?? {}) as Record<string, ElecCable>)) {
    let changed = false;
    for (const v of cable.vertexes) {
      if (v.id === warmFloorId && v.type === "warm_floor") {
        v.point = { ...polygon0 };
        changed = true;
      }
    }
    if (changed) {
      cable.length = gasLineLengthM({ vertexes: cable.vertexes as never, matrix: cable.matrix });
      any = true;
    }
  }
  return any;
}

/**
 * Держатели обратных ссылок кабелей проводки для сверок: предметы (props.<coll> и
 * socket_group[].<coll>) плюс контуры тёплого пола (props.cables_warm_floor,
 * name = type контура — для проверки формы ссылки: у контура скаляр).
 */
export function elecLinkHolders(model: Model): Record<string, ElecLinkItem> {
  const out: Record<string, ElecLinkItem> = {};
  for (const [id, item] of Object.entries(model.items ?? {})) {
    out[id] = item as ElecLinkItem;
  }
  for (const wf of Object.values(model.warm_floors ?? {})) {
    out[wf.id] = { ...(wf.props ?? {}), name: wf.type } as ElecLinkItem;
  }
  // тёплые стены (этап 273): props части, name = "warm_wall_cable" (скалярная ссылка)
  for (const [id, holder] of Object.entries(warmWallLinkHolders(model))) {
    out[id] = holder as ElecLinkItem;
  }
  return out;
}
