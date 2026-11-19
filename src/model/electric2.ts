import type { Model, ElecCable, ElecCableVertex, ItemProps, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import type { MmPoint } from "./walls.ts";
import { McpError } from "../errors.ts";
import { add, scale, sub } from "./geometry.ts";
import { gasLineLengthM } from "./pipes.ts";
import { wallInwardNormal, SOCKET_GROUP_SUBS, parseSwitchVertexId, type SocketGroupSub } from "./electric.ts";

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

/** Ключ обратной ссылки предмета для кабеля (cable_wire_3_25_id / cable_warm_floor_id). */
export function elecLinkKey(coll: ElecCableColl, cableType: string): string {
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
  // cables_conditioner: подключаемые предметы кондиционера в пробы не сняты —
  // только узлы и multi-предметы (открытый вопрос отчёта)
  return false;
}

/** Точка вершины вывода/под-розетки: center под-розетки или 7 см от грани стены (пробы 239-elec2). */
export function elecVertexPoint(model: Model, item: ItemProps, sub?: SocketGroupSub): Point {
  if (sub?.center) return { ...sub.center };
  if (!item.id_wall) return { ...item.pc };
  const wall = model.walls[item.id_wall];
  if (!wall) return { ...item.pc };
  const inward = wallInwardNormal(model, wall, item);
  const shift = 7 - item.height / 2;
  return { x: r2(item.pc.x + inward.x * shift), y: r2(item.pc.y + inward.y * shift) };
}

/** Вершина-предмет кабеля: {vertex, holder} — holder для обратной ссылки. */
type ElecVertexSpec = {
  kind: "multi" | "electrospot";
  vertex: ElecCableVertex;
  itemId: string;
  subId?: string;
};

function itemVertex(model: Model, coll: ElecCableColl, itemId: string): ElecVertexSpec {
  const item = model.items?.[itemId] as ItemProps | undefined;
  if (!item) throw new McpError("NOT_FOUND", `предмет ${itemId} не найден`);
  if (!elecConnectable(coll, item)) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `предмет «${item.name}» не подключается к кабелю этой проводки (в редакторе у кабеля другие выводы: щиток, коробки, розетки, выводы проводов)`,
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
    return { kind: "electrospot", itemId, subId: sub.id, vertex: { id: `${item.id}|s|${sub.id}`, point: elecVertexPoint(model, item, sub), type } };
  }
  // самостоятельный вывод провода
  return { kind: "electrospot", itemId, vertex: { id: item.id, point: elecVertexPoint(model, item), type: "electrospot" } };
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

/** Проверка занятости скалярного слота под-розетки/вывода (до любых мутаций). */
function assertScalarSlotsFree(model: Model, coll: ElecCableColl, cableType: string, specs: ElecVertexSpec[]): void {
  for (const s of specs) {
    if (s.kind !== "electrospot") continue;
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
 * props.<coll>.cable_<тип>_id (массив у multi, скаляр у выводов). Повторное
 * подключение вывода к кабелю того же вида отклоняется. Кандидат-копия до записи;
 * при ошибке модель не меняется.
 */
export function addElecCable(model: Model, params: { tool: string; path: ElecPathElement[] }): ElecCable {
  const coll = elecCollOfTool(params.tool);
  const cableType = params.tool;
  validatePath(params.path ?? []);
  const specs: ElecVertexSpec[] = [];
  const seenItems = new Set<string>();
  for (const el of params.path) {
    if ("itemId" in el) {
      const v = itemVertex(model, coll, el.itemId);
      if (specs.some((s) => s.vertex.id === v.vertex.id && s.vertex.type !== "node" && v.vertex.type !== "node")) {
        throw new McpError("INVALID_ARGUMENT", `предмет ${el.itemId} встречается в пути кабеля дважды — у вершины-предмета одно подключение`);
      }
      specs.push(v);
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
      const spec = specByItem.get(el.itemId);
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
  (model as Record<string, unknown>)[coll] ??= {};
  try {
    model[coll]![candidate.id] = candidate;
    for (const s of specs) {
      const holder = holderOf(model, coll, s.itemId, s.subId)!;
      const key = elecLinkKey(coll, cableType);
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

/** Снять обратные ссылки предмета/под-розеток на кабель (удаление). */
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
        const pt = sub ? elecVertexPoint(model, item, sub) : elecVertexPoint(model, item);
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
