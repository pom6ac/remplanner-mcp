import type { Cable, ElecCable, Model, Wall, GasLine, Pipe, LedStrip, StripLight, LineStrip, WarmFloor, Shield, ShieldPort } from "./types.ts";
import { cmToMm, round0 } from "./units.ts";
import { roomPolygons, type RoomPolygon } from "./rooms.ts";
import { holeOffsetFromStart } from "./openings.ts";
import { wallFaces } from "./wall-geometry.ts";
import { projectionLength, type Segment } from "./geometry.ts";
import { parseSwitchVertexId } from "./electric.ts";
import { zoneDelimiterList } from "./zone.ts";
import { ceilingRigelList } from "./ceiling-rigels.ts";
import { ceilingFinishZones } from "./finish.ts";
import { unescapeCommentText } from "./dims.ts";
import { zoneNumbersByEditorRule } from "./room-fields.ts";
import { prsStateOf } from "./projections.ts";

// Компактное представление модели для агента (< 5 КБ): метки W/R/O/I, мм.

export type CompactWall = {
  id: string;
  site_id: string;
  /** Осевые концы, мм. */
  from: [number, number];
  to: [number, number];
  len_mm: number;
  len_inner_mm: number;
  thickness_mm: number;
  /** Лист: a — исходный план, c — перегородка (этап 103). */
  plan: string;
  /** Материал стены (a_block, c_pgb, c_gypsum, …). */
  material: string;
  /** Пометка демонтажа стены целиком (лист «Демонтаж», этап 103). */
  demount?: boolean;
  /** Участки демонтажа: отступ от начала оси и длина, мм. */
  sectors?: Array<{ sector_id: string; offset_mm: number; width_mm: number }>;
  /** Роль не-wall стен: balcony (ограждение балкона), terrace_fence (ограждение террасы). */
  role?: string;
  openings: CompactOpening[];
};

export type CompactOpening = {
  id: string;
  wall: string;
  type: string;
  offset_mm: number;
  width_mm: number;
  height_mm: number;
  sill_mm: number;
  /** Число створок (окна). */
  casements?: number;
  /** Угол рассвета, градусы (окна). */
  slope_angle_deg?: number;
  /** Сторона открывания из модели (окна: "r", "l", "r-l", "l-r"). */
  opening?: string;
  /** Короб с наличниками (двери и окна; 1 — включён). */
  casing?: number;
  /** Арочный проём. */
  arched?: boolean;
  /** Подоконник (окна). */
  sill?: { thickness_mm: number; overhang_mm: number; overmeasure_mm: number } | null;
  /** Балконный блок (windoor): части окна и двери. */
  window_width_mm?: number;
  window_height_mm?: number;
  door_width_mm?: number;
  door_height_mm?: number;
  door_position?: "l" | "r";
  /** Балконная дверь: импост, мм от низа двери (поле impost_offset модели; высота от пола = значение + подоконник). */
  impost_offset_mm?: number;
  /** Пометка демонтажа проёма (лист «Демонтаж», этап 103). */
  demount?: boolean;
  /** Проём заменён проёмом листа «Перегородок» (hasReplacement, этап 103). */
  replaced?: boolean;
  /** Этап 354: запись — замена исходного проёма (plan:c, replacement=1 в модели). */
  replacement?: boolean;
};

export type CompactRoom = {
  id: string;
  name: string | null;
  /** Цвет зоны помещения (этап 347, палитра #cm-room2; null — не задан). */
  color: string | null;
  /** Номер зоны помещения (этап 347, производное редактора: зоны по убыванию
   *  площади, number_by_area; null — номер не назначен). */
  number: number | null;
  /** Площадь по внутренним граням (как показывает редактор), м². */
  area_m2: number;
  /** Площадь по осевым линиям, м² (null для комнат из rooms2 — осевой контур не восстанавливается). */
  area_axis_m2: number | null;
  perimeter_mm: number;
  /** Рёбра контура комнаты в мм, в порядке rooms2.edges (для выбора edge в
   *  warm_wall_add; ревью 274 №3): edge — индекс, from/to — первая/вторая
   *  вершина ребра, length_mm — длина ребра. */
  edges?: CompactRoomEdge[];
  /** Покрытие пола комнаты (лист «Напольные покрытия», этап 94). */
  floor?: string | null;
  /** Покрытие потолка комнаты (лист «Потолки», этап 94). */
  ceiling?: string | null;
  /** Настройки развёрток комнаты (этап 389): hidden — «скрыть развёртки»,
   *  first_edge — ребро «первой» развёртки (null — авто), disabled_edges —
   *  скрытые развёртки (индексы рёбер). */
  prs?: { hidden: boolean; first_edge: number | null; disabled_edges: number[] };
};

export type CompactRoomEdge = {
  edge: number;
  from: [number, number];
  to: [number, number];
  length_mm: number;
};

export type CompactItem = {
  id: string;
  /** id сайта (ключ в model.items) — резолв меток и удаление item_delete (ревью 269 М3). */
  site_id: string;
  name: string;
  x_mm: number;
  y_mm: number;
  angle_deg: number;
  width_mm: number;
  depth_mm: number;
  height_mm: number;
  /** Высота установки над полом, мм (розетки/выключатели: over_floor.value; ревью 90 R5). */
  over_floor_mm?: number;
  /** Под-розетки группы socket_group (ревью 90 R5): id, тип, координаты в мм. */
  socket_group?: CompactSocketSub[];
  /** Электрика ч.3: слой вертикального блока («друг над другом»), 2/3 — только
   *  когда задан (аддитивное поле; CHANGELOG/README этапа 370). */
  layer?: number;
};

/** Под-розетка группы socket_group в компактном виде (ревью 90 R5). */
export type CompactSocketSub = {
  id: string;
  /** Тип под-розетки (socket, light_switch_double, …). */
  name: string;
  /** Точка center под-розетки, мм. */
  x_mm: number;
  y_mm: number;
};

export type CompactPillar = {
  id: string;
  site_id: string;
  x_mm: number;
  y_mm: number;
  angle_deg: number;
  /** Габарит по X, мм. */
  width_mm: number;
  /** Габарит по Y (глубина), мм. */
  depth_mm: number;
  /** Высота, мм. */
  total_height_mm: number;
};

export type CompactRigel = {
  id: string;
  site_id: string;
  /** Концы оси, мм. */
  from: [number, number];
  to: [number, number];
  /** Толщина на плане, мм. */
  depth_mm: number;
  /** Опускание от потолка, мм. */
  height_mm: number;
  /** Тип отделки потолка ("" — без отделки). */
  ceiling_type: string;
  /** Привязки концов: {end, ot, id}. */
  links: { end: "p1" | "p2"; ot: string; id: string }[];
};

export type CompactGasLine = {
  id: string;
  site_id: string;
  /** Концы прямой линии, мм (у линии из двух узлов). */
  from: [number, number];
  to: [number, number];
  /** Число узлов графа (у прямой — 2). */
  vertexes: number;
  /** Длина трубы, м (поле модели редактора). */
  length_m: number;
};

/** Труба водоснабжения/канализации (этап 78). */
export type CompactPipe = {
  id: string;
  site_id: string;
  /** Вид: water_pipe | water_hot_pipe | drainage_pipe. */
  type: string;
  /** Концы цепочки вершин, мм. */
  from: [number, number];
  to: [number, number];
  /** Число вершин графа. */
  vertexes: number;
  /** Длина трубы, мм (все длины API — в мм, design §7.2; ревью 79 №6). */
  length_mm: number;
  /** id предметов-вершин (выводы воды, стояки, ввод), мм-узлы не перечисляются. */
  connected: string[];
};

/** Световая линия листа «Освещение» (этап 84): лента, трековая шина, линейный свет. */
export type CompactLightStrip = {
  id: string;
  site_id: string;
  /** Вид: led_strip | recessed_strip | surface_stripe | pendent_strip | line_light. */
  type: string;
  /** Концы цепочки узлов, мм. */
  from: [number, number];
  to: [number, number];
  /** Число узлов графа. */
  vertexes: number;
  /** Длина линии, мм (все длины API — в мм; в модели редактора метры). */
  length_mm: number;
  /** Опускание подвеса шины, мм (только pendent_strip). */
  height_lowering_mm?: number;
};

/** Связь «выключатель → светильник» (лист «Выключатели», этап 88). */
export type CompactCable = {
  id: string;
  site_id: string;
  /** id предмета-группы выключателя (ревью 90 R5 — без склейки «|s|»). */
  switch_item_id: string;
  /** id под-розетки-выключателя внутри группы. */
  switch_sub_id: string;
  /** id предмета-светильника. */
  lamp_item_id: string;
  /** Число вершин графа (включая промежуточные узлы). */
  vertexes: number;
  /** Длина, мм (в модели редактора метры). */
  length_mm: number;
};

/** Вершина кабеля-проводки в списке (ревью 241 №9): узел или предмет. */
export type CompactElecCableVertex = {
  /** Индекс в vertexes (0-based) — для wiring_update positions.vertex. */
  index: number;
  /** node — узел графа, item — вершина-предмет (multi/electrospot/под-элемент). */
  kind: "node" | "item";
  /** id предмета-держателя (для kind=item; у под-розетки — id группы). */
  item_id?: string;
  /** id под-розетки внутри группы (вершина «<gid>|s|<subId>»). */
  sub_id?: string;
  /** Точка вершины, мм. */
  x_mm: number;
  y_mm: number;
};

/** Кабель-проводка (лист «Электропроводка», часть 2). */
export type CompactElecCable = {
  id: string;
  site_id: string;
  /** Ключ кабеля из каталога UI (wire_3_25, warm_floor_wire, conditioner_wire). */
  type: string;
  /** Подключённые предметы (id вершин; у под-розеток — «<gid>|s|<subId>»). */
  connected: string[];
  /** Вершины списком (ревью 241 №9): индексы для wiring_update и координаты узлов в мм. */
  vertex_list: CompactElecCableVertex[];
  /** Число вершин графа (включая промежуточные узлы). */
  vertexes: number;
  /** Длина, мм (в модели редактора метры, с опусками редактора). */
  length_mm: number;
};

/** Контур тёплого пола (лист «Тёплые полы», этап 122). */
export type CompactWarmFloor = {
  id: string;
  site_id: string;
  /** Вид: warm_floor (кабельный) | warm_floor_ir | warm_floor_water. */
  type: string;
  /** Габариты контура, мм (по осям X/Y). */
  width_mm: number;
  depth_mm: number;
  /** Площадь, м² (поле модели). */
  area_m2: number;
  /** Периметр, мм (длина поля модели — метры). */
  perimeter_mm: number;
  /** id комнаты. */
  room: string | null;
  /** Водяной: шаг укладки, мм. */
  step_mm?: number;
  /** Водяной: длина трубы, мм. */
  length_pipes_mm?: number;
};

export type CompactFloorHole = {
  id: string;
  site_id: string;
  /** Вид проёма: floor_hole (пол, план a) или ceiling_hole (потолок, план ceiling). */
  type: "floor_hole" | "ceiling_hole";
  /** Центр, мм. */
  x_mm: number;
  y_mm: number;
  /** Габарит по X, мм. */
  width_mm: number;
  /** Габарит по Y, мм. */
  depth_mm: number;
  /** Площадь, м². */
  area_m2: number;
};

/** Разделитель зон (зонирование пола/потолка, этап 260). */
export type CompactZoneDelimiter = {
  id: string;
  site_id: string;
  /** Вид: zone_ceiling | zone_floor | zone_c | zone_hydroisolation | zone_floor_cap. */
  type: string;
  /** Лист: "ceiling" — потолок, "c" — зоны помещений, ... */
  plan: string;
  /** id комнаты, мм-координаты концов линии. */
  room_id: string | null;
  from: [number, number];
  to: [number, number];
  /** Длина линии, мм (все длины API — в мм). */
  length_mm: number;
};

export type CompactBorder = {
  id: string;
  site_id: string;
  /** Концы отрезка, мм. */
  from: [number, number];
  to: [number, number];
};

/** Потолочная закладная (ceiling_rigel, этап 303). */
export type CompactCeilingRigel = {
  id: string;
  site_id: string;
  room_id: string;
  from: [number, number];
  to: [number, number];
  width_mm: number;
  ceiling_type: string;
};

/** Модуль щитка в компактном виде (этап 255). */
export type CompactShieldModule = {
  /** id модуля (id сайта) — для shield_module_update/delete. */
  module_id: string;
  /** Индекс рейки (0-based). */
  rail: number;
  /** Позиция на рейке, DIN. */
  index: number;
  /** Ширина, DIN. */
  width_din: number;
  type: string;
  subtype: string;
  group_number?: number;
  comment?: string;
};

/** Провод щитка в компактном виде (этап 284). */
export type CompactShieldWire = {
  /** id провода (id сайта) — для shield_wire_delete. */
  wire_id: string;
  /** shield_wire_phase|phase2|phase3|null|earth. */
  type: string;
  // ревью 285 №10: порт шины виден агенту — {bus: <bus_id>, port: n}
  from: { module_id?: string; port?: number; input?: "phase" | "null" | "earth"; bus?: string };
  to: { module_id?: string; port?: number; input?: "phase" | "null" | "earth"; bus?: string };
  is_broken?: number;
};

/** Конструктор электрощитка (лист «Электрощиток», этап 255). */
export type CompactShield = {
  id: string;
  site_id: string;
  /** id предмета-щитка (связь shields[].shield_id). */
  item: string;
  /** Длина щитка, DIN. */
  length_rails_din: number;
  /** Число DIN-реек. */
  rails: number;
  /** Модули по рейкам (порядок: рейка, позиция). */
  modules: CompactShieldModule[];
  /** Провода (этап 284; порядок по id). */
  wires?: CompactShieldWire[];
  /** Число шин/коллекторов (детали — bus_list/collector_list, этап 291). */
  buses?: number;
  collectors?: number;
  /** Шины (этап 291; порядок по id): гнёзда, connection, привязка. */
  bus_list?: CompactShieldBus[];
  /** Коллекторы (этап 291; порядок по id). */
  collector_list?: CompactShieldCollector[];
};

/** Шина конструктора щитка (этап 291). */
export type CompactShieldBus = {
  bus_id: string;
  /** T|B + L|C|R: «TL», «BC», … (ряд + привязка). */
  type: string;
  /** Число гнёзд (default 6, ShieldDimensions.bus). */
  sockets: number;
  /** Отступ от левого края схемы щитка, px svg (формат редактора, не мм). */
  distance: number;
  /** Тип провода первого подключённого гнезда ("": нет). */
  connection: string;
  /** Подключённые гнёзда: {port, ...адрес} по порядку ports. */
  sockets_list: { port: number; connected: 0 | 1 }[];
};

/** Коллектор (гребёнка) конструктора щитка (этап 291). */
export type CompactShieldCollector = {
  collector_id: string;
  /** Рейка (индекс из modules[].rail). */
  rail: number;
  /** Ширина модулей, DIN. */
  module_width: number;
  /** Модули (id из modules[]). */
  module_ids: string[];
  /** Ряд щитка: T | B. */
  position: string;
};

export type CompactModel = {
  walls: CompactWall[];
  rooms: CompactRoom[];
  items: CompactItem[];
  pillars: CompactPillar[];
  rigels: CompactRigel[];
  gas_lines: CompactGasLine[];
  pipes: CompactPipe[];
  terrace_borders: CompactBorder[];
  territory_borders: CompactBorder[];
  level_holes: CompactFloorHole[];
  zone_delimiters: CompactZoneDelimiter[];
  ceiling_rigels: CompactCeilingRigel[];
  led_strips: CompactLightStrip[];
  stripes_light: CompactLightStrip[];
  line_strips: CompactLightStrip[];
  cables: CompactCable[];
  cables_socket: CompactElecCable[];
  cables_warm_floor: CompactElecCable[];
  cables_conditioner: CompactElecCable[];
  shields: CompactShield[];
  warm_floors: CompactWarmFloor[];
  pipes_warm_floor: CompactPipe[];
  pipes_conditioner: CompactPipe[];
  pipes_heat: CompactPipe[];
  pipes_ventilation: CompactPipe[];
  /** Пользовательские листы (этап 375, CustomPlan). */
  custom_plans: CompactSheet[];
  /** Свободные линии / толстые линии / фигуры / изображения (этап 375). */
  freelines: CompactDrawLine[];
  thick_lines: CompactDrawLine[];
  free_figures: CompactFigure[];
  pictures: CompactPicture[];
  /** Молдинги развёрток (wall_moldings, лист «Развёртки», этап 389). */
  wall_moldings: CompactPrsFigure[];
  /** Ниши развёрток (wall_niches). */
  wall_niches: CompactPrsFigure[];
  total_height_mm: number;
};

/** Пользовательский лист (этап 375): лист адресуется именем или site_id. */
export type CompactSheet = {
  /** Метка S<n> (порядок в model.custom_plans). */
  id: string;
  site_id: string;
  name: string;
  /** После какого встроенного листа стоит вкладка («first» — в начало). */
  after_plan: string;
  /** Что видно на листе (plan / furniture_santeh / light / electro_points). */
  content: string[];
};

/** Линия «Нарисовать элемент» (freelines/thick_lines, PRO). */
export type CompactDrawLine = {
  id: string;
  site_id: string;
  /** Лист: встроенный или custom_<id> пользовательского листа. */
  plan: string;
  /** Вершины ломаной, мм. */
  points_mm: Array<[number, number]>;
  length_mm: number;
  color?: string;
  /** Индивидуальная ширина толстой линии, мм. */
  width_mm?: number;
};

/** Фигура «Нарисовать элемент» (free_figures, PRO). */
export type CompactFigure = {
  id: string;
  site_id: string;
  /** rect / rect_round / round / triangle / … (FreeFigure.type). */
  type: string;
  plan: string;
  center_mm: [number, number];
  width_mm: number;
  height_mm: number;
  angle_deg: number;
  color?: string;
};

/** Изображение на плане (pictures). */
export type CompactPicture = {
  id: string;
  site_id: string;
  url: string;
  plan: string;
  center_mm: [number, number];
  width_mm: number;
  height_mm: number;
  text?: string;
};

/**
 * Молдинг/ниша развёртки (wall_moldings/wall_niches, этап 389). Позиция —
 * семантическая: along_mm — от начала развёртки (prs.pc_xd), from_floor_mm —
 * от низа развёртки (prs.pc_yd и total_height); pc — кэш рамки развёрток,
 * в публичный API не идёт. room — метка R<n>, edge_index — индекс ребра
 * развёртки (развёртки комнаты в model_get edges_prs).
 */
export type CompactPrsFigure = {
  id: string;
  site_id: string;
  kind: "wall_molding" | "wall_niche";
  room: string | null;
  edge_index: number;
  along_mm: number;
  from_floor_mm: number;
  width_mm: number;
  height_mm: number;
  depth_mm?: number;
  width_line_mm?: number;
};

export function wallLengthMm(wall: Wall): number {
  return round0(cmToMm(Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y)));
}

/**
 * Длина по внутренним граням: берём реальные грани (wallFaces: углы стыков с соседями)
 * и проецируем на ось; из двух сторон берём ту, что короче (внутренняя грань комнаты;
 * находка №15 ревью: вычитание собственной толщины врало при разных толщинах соседей).
 */
export function wallInnerLengthMm(wall: Wall, walls: Record<string, Wall> = {}): number {
  try {
    const faces = wallFaces(wall, walls);
    const axis: Segment = { p1: wall.p1, p2: wall.p2 };
    const lenL = Math.abs(projectionLength(axis, faces.l2) - projectionLength(axis, faces.l1));
    const lenR = Math.abs(projectionLength(axis, faces.r2) - projectionLength(axis, faces.r1));
    return round0(cmToMm(Math.min(lenL, lenR)));
  } catch {
    return wallLengthMm(wall);
  }
}

/** Компактное представление: стены с метками, комнаты с площадями, проёмы с отступами, предметы.
 *  rooms — комнаты из кеша workspace (нормализованная модель), если в model.rooms2 их ещё нет. */
export function compactModel(model: Model, rooms?: RoomPolygon[]): CompactModel {
  const roomList: RoomPolygon[] = rooms && rooms.length > 0 ? rooms : roomPolygons(model);
  const roomNames = model.rooms2 as Record<string, { zones?: Array<{ name?: string }>; name?: string }> | undefined;

  const siteToLabel = new Map<string, string>();
  const walls: CompactWall[] = Object.values(model.walls).map((wall, i) => {
    const label = `W${i + 1}`;
    siteToLabel.set(wall.id, label);
    const lenInner = wallInnerLengthMm(wall, model.walls);
    const openings: CompactOpening[] = Object.values(wall.holes ?? {}).map((hole) => {
      const c: CompactOpening = {
        id: hole.id,
        wall: label,
        type: hole.type,
        offset_mm: round0(holeOffsetFromStart(wall, hole)),
        width_mm: round0(cmToMm(hole.width)),
        height_mm: hole.height !== undefined ? round0(cmToMm(hole.height)) : 0,
        sill_mm: hole.floor_height !== undefined ? round0(cmToMm(hole.floor_height)) : 0,
      };
      const sill = hole.sill as { thinkness?: number; overhang?: number; overmeasure?: number } | undefined;
      if (sill && typeof sill === "object") {
        c.sill = {
          thickness_mm: round0(cmToMm(sill.thinkness ?? 0)),
          overhang_mm: round0(cmToMm(sill.overhang ?? 0)),
          overmeasure_mm: round0(cmToMm(sill.overmeasure ?? 0)),
        };
      }
      if (hole.casements !== undefined) c.casements = hole.casements;
      if (hole.slope_angle !== undefined) c.slope_angle_deg = hole.slope_angle as number;
      if (hole.opening !== undefined) c.opening = hole.opening;
      if (hole.casing !== undefined) c.casing = hole.casing as number;
      if (hole.arched !== undefined && hole.arched !== 0) c.arched = true;
      if (hole.window_width !== undefined) c.window_width_mm = round0(cmToMm(hole.window_width as number));
      if (hole.window_height !== undefined) c.window_height_mm = round0(cmToMm(hole.window_height as number));
      if (hole.door_width !== undefined) c.door_width_mm = round0(cmToMm(hole.door_width as number));
      if (hole.door_height !== undefined) c.door_height_mm = round0(cmToMm(hole.door_height as number));
      if (hole.door_position !== undefined) c.door_position = hole.door_position as "l" | "r";
      if (hole.impost_offset !== undefined) c.impost_offset_mm = round0(cmToMm(hole.impost_offset as number));
      if (hole.demount === 1) c.demount = true;
      if (hole.hasReplacement) c.replaced = true;
      // этап 354: у замены поле replacement (как в модели редактора, setReplacement)
      const isReplacement = (hole as { replacement?: unknown })["replacement"] === 1;
      if (isReplacement) c.replacement = true;
      return c;
    });
    // перепланировка (этап 103): план, материал, пометки демонтажа
    const sectors = wall.sectors as Record<string, { pc: { x: number; y: number }; width: number }> | undefined;
    const axisLen = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y) || 1;
    const ux = (wall.p2.x - wall.p1.x) / axisLen;
    const uy = (wall.p2.y - wall.p1.y) / axisLen;
    // ревью 105 R8: актуальный sector_id в ответе — отменить отдельный участок
    // (demolish_cancel sector_id) иначе нечем: id, возвращённый demolish, нормализатор
    // может пересоздать, а компактная model_get без id не позволяет выбрать участок
    const sectorList = Object.entries(sectors ?? {}).map(([sid, s]) => ({
      sector_id: (s as { id?: string }).id ?? sid,
      offset_mm: round0(cmToMm((s.pc.x - wall.p1.x) * ux + (s.pc.y - wall.p1.y) * uy - s.width / 2)),
      width_mm: round0(cmToMm(s.width)),
    })).sort((a, b) => a.offset_mm - b.offset_mm);
    return {
      id: label,
      site_id: wall.id,
      from: [round0(cmToMm(wall.p1.x)), round0(cmToMm(wall.p1.y))],
      to: [round0(cmToMm(wall.p2.x)), round0(cmToMm(wall.p2.y))],
      len_mm: wallLengthMm(wall),
      len_inner_mm: lenInner,
      thickness_mm: round0(cmToMm(wall.depth)),
      plan: wall.plan,
      material: wall.material,
      ...(wall.demount === 1 ? { demount: true } : {}),
      ...(sectorList.length > 0 ? { sectors: sectorList } : {}),
      ...(wall.role && wall.role !== "wall" ? { role: wall.role } : {}),
      openings,
    };
  });

  const compactRooms: CompactRoom[] = (() => {
    const zoneNumbers = zoneNumbersByEditorRule(model);
    return roomList.map((room, i) => {
    let perimeter = 0;
    for (let j = 0; j < room.polygon.length; j++) {
      const a = room.polygon[j]!;
      const b = room.polygon[(j + 1) % room.polygon.length]!;
      perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const room2 = room.roomId ? (model.rooms2 as Record<string, Record<string, unknown>> | undefined)?.[room.roomId] : undefined;
    const zone0 = room2 && Array.isArray(room2["zones"]) ? (room2["zones"] as Array<Record<string, unknown>>)[0] : undefined;
    const name = room.roomId && roomNames?.[room.roomId]
      ? ((roomNames[room.roomId] as { zones?: Array<{ name?: string }> }).zones?.[0]?.name ?? null)
      : null;
    // этап 347: цвет зоны помещения — пользовательское поле (палитра #cm-room2)
    const color = zone0 && typeof zone0["color"] === "string" ? zone0["color"] as string : null;
    // этап 347: номер зоны — производное редактора (number_by_area: зоны всех
    // помещений по убыванию площади, ROOMS2.draw); пересчитывается правилом
    // редактора, а не берётся из записи (после локальных операций со стенами
    // записанное значение устаревает до пересчёта редактором)
    const zoneNumber = room.roomId ? zoneNumbers.get(room.roomId)?.get(0) ?? null : null;
    // этап 94: покрытие пола/потолка комнаты видно в компактном API
    // рёбра контура комнаты в мм (ревью 274 №3): записи edges rooms2 или
    // производные из полигона — тот же порядок, что в warm_wall_add (edge)
    const edgesRec = room2 ? room2["edges"] : undefined;
    let edgeSegs: Array<{ p1: { x: number; y: number }; p2: { x: number; y: number } }> = [];
    if (Array.isArray(edgesRec)) {
      edgeSegs = (edgesRec as Array<{ p1?: { x: number; y: number }; p2?: { x: number; y: number } }>)
        .filter((e) => e && e.p1 && e.p2) as Array<{ p1: { x: number; y: number }; p2: { x: number; y: number } }>;
    }
    if (edgeSegs.length === 0 && room.polygon.length >= 3) {
      for (let j = 0; j < room.polygon.length; j++) {
        edgeSegs.push({ p1: room.polygon[j]!, p2: room.polygon[(j + 1) % room.polygon.length]! });
      }
    }
    const compactEdges: CompactRoomEdge[] = edgeSegs.map((e, j) => ({
      edge: j,
      from: [round0(cmToMm(e.p1.x)), round0(cmToMm(e.p1.y))],
      to: [round0(cmToMm(e.p2.x)), round0(cmToMm(e.p2.y))],
      length_mm: round0(cmToMm(Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y))),
    }));
    const floorRec = room2 ? (room2["floors"] as Array<Record<string, unknown>> | undefined)?.[0] : undefined;
    // ревью 313 A: отделка потолка по зонам (общий слой ceilingFinishZones) —
    // после пересчёта зон (закладная/делитель) отделка может стоять в любой
    // записи; чтение только ceilings[0] показывало null (регрессия против 141fd2b)
    const ceilingZone = room2 ? ceilingFinishZones(room2 as Parameters<typeof ceilingFinishZones>[0])[0] : undefined;
    return {
      id: `R${i + 1}`,
      name,
      // этап 347: цвет зоны (null — не задан, как в редакторе белый = без цвета)
      color,
      // этап 347: номер зоны — производное редактора (по убыванию площади зон)
      number: zoneNumber,
      area_m2: Math.round((room.areaCm2 / 10_000) * 100) / 100,
      area_axis_m2: room.axisAreaCm2 === null ? null : Math.round((room.axisAreaCm2 / 10_000) * 100) / 100,
      perimeter_mm: round0(cmToMm(perimeter)),
      ...(compactEdges.length > 0 ? { edges: compactEdges } : {}),
      floor: floorRec && floorRec["exist"] === true && typeof floorRec["cover"] === "string" ? floorRec["cover"] as string : null,
      ceiling: ceilingZone ? ceilingZone.material : null,
      ...(room2 ? { prs: (({ hidden, firstEdge, disabledEdges }) => ({ hidden, first_edge: firstEdge, disabled_edges: disabledEdges }))(prsStateOf(room2 as Parameters<typeof prsStateOf>[0])) } : {}),
    };
    });
  })();

  const items: CompactItem[] = Object.values(model.items ?? {}).map((item, i) => {
    // ревью 90 R5: состав под-розеток и высота установки видны в компактном API
    const subs = Array.isArray(item.socket_group) ? (item.socket_group as Array<{ name?: string; id?: string; center?: { x?: number; y?: number } }>) : null;
    const overFloor = item.over_floor;
    return {
      id: `I${i + 1}`,
      // ревью 269 М3: site_id в компактном виде — резолв метки из рабочей модели
      // (удаление item_delete по метке, сверенной с site_id)
      site_id: item.id,
      name: item.name,
      x_mm: round0(cmToMm(item.pc.x)),
      y_mm: round0(cmToMm(item.pc.y)),
      angle_deg: item.angle,
      width_mm: round0(cmToMm(item.width)),
      depth_mm: round0(cmToMm(item.height)),
      height_mm: round0(cmToMm(item.self_height ?? 0)),
      ...(overFloor && typeof overFloor === "object" && typeof (overFloor as { value?: unknown }).value === "number"
        ? { over_floor_mm: round0(cmToMm((overFloor as { value: number }).value)) }
        : {}),
      ...(subs && subs.length > 0
        ? {
            socket_group: subs.map((s) => ({
              id: s.id ?? "",
              name: s.name ?? "",
              x_mm: round0(cmToMm(s.center?.x ?? item.pc.x)),
              y_mm: round0(cmToMm(s.center?.y ?? item.pc.y)),
            })),
          }
        : {}),
      // электрика ч.3: слой вертикального блока — только когда задан (2/3)
      ...(typeof item.layer === "number" && (item.layer === 2 || item.layer === 3) ? { layer: item.layer } : {}),
    };
  });

  const pillars: CompactPillar[] = Object.values(model.pillars ?? {}).map((pillar, i) => ({
    id: `P${i + 1}`,
    site_id: pillar.id,
    x_mm: round0(cmToMm(pillar.pc.x)),
    y_mm: round0(cmToMm(pillar.pc.y)),
    angle_deg: pillar.angle ?? 0,
    width_mm: round0(cmToMm(pillar.width)),
    depth_mm: round0(cmToMm(pillar.height)),
    total_height_mm: round0(cmToMm(pillar.total_height ?? 270)),
  }));

  const rigels: CompactRigel[] = Object.values(model.rigels ?? {}).map((rigel, i) => {
    const links: CompactRigel["links"] = [];
    for (const end of ["p1", "p2"] as const) {
      const link = rigel[end]?.link;
      if (link && typeof link === "object") links.push({ end, ot: link.ot, id: link.id });
    }
    return {
      id: `B${i + 1}`,
      site_id: rigel.id,
      from: [round0(cmToMm(rigel.p1.x)), round0(cmToMm(rigel.p1.y))],
      to: [round0(cmToMm(rigel.p2.x)), round0(cmToMm(rigel.p2.y))],
      depth_mm: round0(cmToMm(rigel.depth)),
      height_mm: round0(cmToMm(rigel.height)),
      ceiling_type: rigel.ceiling_type ?? "",
      links,
    };
  });

  const gasLines: CompactGasLine[] = Object.values(model.pipes_gas ?? {}).map((line: GasLine, i) => {
    const first = line.vertexes[0]?.point;
    const last = line.vertexes[line.vertexes.length - 1]?.point;
    return {
      id: `G${i + 1}`,
      site_id: line.id,
      from: [round0(cmToMm(first?.x ?? 0)), round0(cmToMm(first?.y ?? 0))],
      to: [round0(cmToMm(last?.x ?? 0)), round0(cmToMm(last?.y ?? 0))],
      vertexes: line.vertexes.length,
      length_m: line.length ?? 0,
    };
  });

  const pipes: CompactPipe[] = Object.values(model.pipes ?? {}).map((pipe: Pipe, i) => {
    const first = pipe.vertexes[0]?.point;
    const last = pipe.vertexes[pipe.vertexes.length - 1]?.point;
    return {
      id: `TP${i + 1}`,
      site_id: pipe.id,
      type: pipe.type,
      from: [round0(cmToMm(first?.x ?? 0)), round0(cmToMm(first?.y ?? 0))],
      to: [round0(cmToMm(last?.x ?? 0)), round0(cmToMm(last?.y ?? 0))],
      vertexes: pipe.vertexes.length,
      // все длины API — в мм (design §7.2, ревью 79 №6); метры редактора остаются внутри адаптации
      length_mm: Math.round((pipe.length ?? 0) * 1000),
      connected: pipe.vertexes.filter((v) => v.type !== "node").map((v) => v.id),
    };
  });

  const totalHeight = typeof model.total_height === "number" ? model.total_height : 270;

  type BorderLike = { id: string; p1: { x: number; y: number }; p2: { x: number; y: number } };
  const compactBorders = (src: Record<string, unknown> | undefined): CompactBorder[] =>
    Object.values(src ?? {}).map((b, i) => {
      const b0 = b as BorderLike;
      return {
        id: `${keyLabel}${i + 1}`,
        site_id: b0.id,
        from: [round0(cmToMm(b0.p1.x)), round0(cmToMm(b0.p1.y))],
        to: [round0(cmToMm(b0.p2.x)), round0(cmToMm(b0.p2.y))],
      };
    });
  let keyLabel = "TB";
  const terraceBorders = compactBorders(model.terrace_borders);
  keyLabel = "XB";
  const territoryBorders = compactBorders(model.territory_borders);

  // Проёмы пола (FH<n>) и потолка (CH<n>, этап 328) — одна коллекция level_holes,
  // метки по типу сквозные (как ZD/CR); нумерация — по полному списку своего типа.
  const floorHoles = Object.values(model.level_holes ?? {}).filter((h) => (h.type ?? "floor_hole") === "floor_hole");
  const ceilingHoles = Object.values(model.level_holes ?? {}).filter((h) => h.type === "ceiling_hole");
  const compactHole = (hole: (typeof floorHoles)[number], label: string): CompactFloorHole => {
    const xs = hole.polygon.map((p) => p.x);
    const ys = hole.polygon.map((p) => p.y);
    return {
      id: label,
      site_id: hole.id,
      type: (hole.type ?? "floor_hole") as "floor_hole" | "ceiling_hole",
      x_mm: round0(cmToMm(hole.pc.x)),
      y_mm: round0(cmToMm(hole.pc.y)),
      width_mm: round0(cmToMm(Math.max(...xs) - Math.min(...xs))),
      depth_mm: round0(cmToMm(Math.max(...ys) - Math.min(...ys))),
      area_m2: hole.area ?? 0,
    };
  };
  const levelHoles: CompactFloorHole[] = [
    ...floorHoles.map((h, i) => compactHole(h, `FH${i + 1}`)),
    ...ceilingHoles.map((h, i) => compactHole(h, `CH${i + 1}`)),
  ];

  // разделители зон (этап 260): один источник меток ZD<n> — zoneDelimiterList
  // (верхнеуровневое zone_delimiters + legacy per-room с миграцией; ревью 261 №7:
  // compact нумерует так же, как finish_get/list и zone_ceiling_remove)
  const zoneDelimiters: CompactZoneDelimiter[] = zoneDelimiterList(model).map((d) => {
    const from = d["from_mm"] as [number, number];
    const to = d["to_mm"] as [number, number];
    return {
      id: String(d["id"] ?? ""),
      site_id: String(d["site_id"] ?? ""),
      type: String(d["type"] ?? ""),
      plan: String(d["plan"] ?? ""),
      room_id: (d["room_id"] as string | null) || null,
      from: [round0(from[0]), round0(from[1])] as [number, number],
      to: [round0(to[0]), round0(to[1])] as [number, number],
      length_mm: round0(Number(d["length_mm"] ?? 0)),
    };
  });
  // потолочные закладные (этап 303): метки CR<n> — тот же источник, что
  // finish_get/ceilingRigelList
  const ceilingRigels: CompactCeilingRigel[] = ceilingRigelList(model).map((r) => {
    const from = r["from_mm"] as [number, number];
    const to = r["to_mm"] as [number, number];
    return {
      id: String(r["id"] ?? ""),
      site_id: String(r["site_id"] ?? ""),
      room_id: String(r["room_id"] ?? ""),
      from,
      to,
      width_mm: round0(Number(r["width_mm"] ?? 0)),
      ceiling_type: String(r["ceiling_type"] ?? ""),
    };
  });

  // световые линии листа «Освещение» (этап 84): метки LS/SL/LL
  const compactLightStrips = (
    src: Record<string, LedStrip | StripLight | LineStrip> | undefined,
    label: string,
  ): CompactLightStrip[] =>
    Object.values(src ?? {}).map((line, i) => {
      const first = line.vertexes[0]?.point;
      const last = line.vertexes[line.vertexes.length - 1]?.point;
      return {
        id: `${label}${i + 1}`,
        site_id: line.id,
        type: line.type,
        from: [round0(cmToMm(first?.x ?? 0)), round0(cmToMm(first?.y ?? 0))],
        to: [round0(cmToMm(last?.x ?? 0)), round0(cmToMm(last?.y ?? 0))],
        vertexes: line.vertexes.length,
        // все длины API — в мм (design §7.2); в модели редактора метры
        length_mm: Math.round((line.length ?? 0) * 1000),
        ...(line.type === "pendent_strip" && (line as StripLight).height_lowering !== undefined
          ? { height_lowering_mm: round0(cmToMm((line as StripLight).height_lowering!)) }
          : {}),
      };
    });

  // связи «выключатель → светильник» (этап 88): метки CB
  const compactCables = (src: Record<string, Cable> | undefined): CompactCable[] =>
    Object.values(src ?? {}).map((cable, i) => {
      const sw = cable.vertexes.find((v) => v.type === "switch");
      const lamp = cable.vertexes.find((v) => v.type !== "node" && v.type !== "switch");
      const parsedSw = sw?.id ? parseSwitchVertexId(sw.id) : null;
      return {
        id: `CB${i + 1}`,
        site_id: cable.id,
        switch_item_id: parsedSw?.[0] ?? "",
        switch_sub_id: parsedSw?.[1] ?? "",
        lamp_item_id: lamp?.id ?? "",
        vertexes: cable.vertexes.length,
        length_mm: Math.round((cable.length ?? 0) * 1000),
      };
    });

  // кабели-проводка (часть 2): метки CS/CW/CC
  const compactElecCables = (src: Record<string, ElecCable> | undefined, label: string): CompactElecCable[] =>
    Object.values(src ?? {}).map((cable, i) => {
      // ревью 241 №9: вершины списком — индексы для wiring_update (узлы и
      // предметы), item_id/sub_id без сырой формы «<gid>|s|<subId>», точки в мм
      const vertexList: CompactElecCableVertex[] = cable.vertexes.map((v, index) => {
        const at = v.id.indexOf("|s|");
        const isItem = v.type !== "node";
        return {
          index,
          kind: isItem ? ("item" as const) : ("node" as const),
          ...(isItem ? { item_id: at > 0 ? v.id.slice(0, at) : v.id } : {}),
          ...(isItem && at > 0 ? { sub_id: v.id.slice(at + 3) } : {}),
          x_mm: round0(cmToMm(v.point?.x ?? 0)),
          y_mm: round0(cmToMm(v.point?.y ?? 0)),
        };
      });
      return {
        id: `${label}${i + 1}`,
        site_id: cable.id,
        type: cable.type,
        connected: cable.vertexes.filter((v) => v.type !== "node").map((v) => v.id),
        vertex_list: vertexList,
        vertexes: cable.vertexes.length,
        length_mm: Math.round((cable.length ?? 0) * 1000),
      };
    });

  // конструктор электрощитка (этап 255): метки SH
  const compactShields = (src: Record<string, Shield> | undefined): CompactShield[] =>
    Object.values(src ?? {}).map((shield, i) => {
      const rails = Object.values(shield.rails ?? {}).sort((a, b) => a.index - b.index);
      const modules: CompactShieldModule[] = [];
      for (const [railIdx, rail] of rails.entries()) {
        for (const mod of Object.values(rail.modules ?? {}).sort((a, b) => a.index - b.index)) {
          modules.push({
            module_id: mod.id,
            rail: railIdx,
            index: mod.index,
            width_din: mod.width,
            type: mod.type,
            subtype: mod.subtype,
            ...(mod.group_number ? { group_number: mod.group_number } : {}),
            ...(mod.comment ? { comment: mod.comment } : {}),
          });
        }
      }
      // провода (этап 284): адрес порта — {module_id, port} или {input}
      const inputPortByKey = new Map<string, "phase" | "null" | "earth">();
      for (const input of Object.values(shield.inputs ?? {})) {
        for (const p of input.ports ?? []) {
          if (p.type === "shield_wire_phase") inputPortByKey.set(p.id, "phase");
          else if (p.type === "shield_wire_null") inputPortByKey.set(p.id, "null");
          else if (p.type === "shield_wire_earth") inputPortByKey.set(p.id, "earth");
        }
      }
      const moduleByPort = new Map<string, { module_id: string; port: number }>();
      for (const rail of rails) {
        for (const mod of Object.values(rail.modules ?? {})) {
          (mod.ports ?? []).forEach((p, idx) => moduleByPort.set(p.id, { module_id: mod.id, port: idx }));
        }
      }
      // ревью 285 №10: порт шины — {bus: <bus_id>, port: n} вместо пустого {}
      const busByPort = new Map<string, { bus: string; port: number }>();
      for (const bus of Object.values(shield.buses ?? {}) as Array<{ id: string; ports?: ShieldPort[] }>) {
        (bus.ports ?? []).forEach((p, idx) => busByPort.set(p.id, { bus: bus.id, port: idx }));
      }
      const portRef = (portId: string): CompactShieldWire["from"] => {
        const m = moduleByPort.get(portId);
        if (m) return { module_id: m.module_id, port: m.port };
        const inp = inputPortByKey.get(portId);
        if (inp) return { input: inp };
        const bus = busByPort.get(portId);
        if (bus) return { bus: bus.bus, port: bus.port };
        return {};
      };
      const wires = Object.values(shield.wires ?? {})
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((w) => ({
          wire_id: w.id,
          type: w.type,
          from: portRef(w.id_source),
          to: portRef(w.id_target),
          ...(w.is_broken ? { is_broken: w.is_broken } : {}),
        }));
      // шины/коллекторы (этап 291): адрес гнезда шины — {bus, port} в portRef
      const railIndexById = new Map(rails.map((r, idx) => [r.id, idx]));
      const busList = Object.values(shield.buses ?? {})
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((b) => ({
          bus_id: b.id,
          type: b.type,
          sockets: b.ports.length,
          distance: b.distance,
          connection: b.connection,
          sockets_list: b.ports.map((p, idx) => ({ port: idx, connected: (p.connected ? 1 : 0) as 0 | 1 })),
        }));
      const collectorList = Object.values(shield.collectors ?? {})
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((c) => ({
          collector_id: c.id,
          rail: railIndexById.get(c.rail_id) ?? -1,
          module_width: c.module_width,
          module_ids: Object.keys(c.modules ?? {}),
          position: c.position,
        }));
      return {
        id: `SH${i + 1}`,
        site_id: shield.id,
        item: shield.shield_id,
        length_rails_din: shield.length_rails ?? 12,
        rails: rails.length,
        modules,
        ...(wires.length ? { wires } : {}),
        ...(busList.length ? { buses: busList.length, bus_list: busList } : {}),
        ...(collectorList.length ? { collectors: collectorList.length, collector_list: collectorList } : {}),
      };
    });

  // контуры тёплого пола (этап 122): метки WF
  const compactWarmFloors = (src: Record<string, WarmFloor> | undefined): CompactWarmFloor[] =>
    Object.values(src ?? {}).map((wf, i) => {
      const xs = (wf.polygon ?? []).map((p) => p.x);
      const ys = (wf.polygon ?? []).map((p) => p.y);
      const w = xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0;
      const h = ys.length > 0 ? Math.max(...ys) - Math.min(...ys) : 0;
      return {
        id: `WF${i + 1}`,
        site_id: wf.id,
        type: wf.type,
        width_mm: round0(cmToMm(w)),
        depth_mm: round0(cmToMm(h)),
        area_m2: wf.area ?? 0,
        perimeter_mm: Math.round((wf.length ?? 0) * 1000),
        room: wf.id_room ?? null,
        ...(wf.step !== undefined ? { step_mm: round0(cmToMm(wf.step)) } : {}),
        ...(wf.length_pipes !== undefined ? { length_pipes_mm: Math.round(wf.length_pipes * 1000) } : {}),
      };
    });

  // трубы климата (этап 122): метки PW/PC/PH/PV
  const compactClimatePipes = (src: Record<string, Pipe> | undefined, label: string): CompactPipe[] =>
    Object.values(src ?? {}).map((pipe: Pipe, i) => {
      const first = pipe.vertexes[0]?.point;
      const last = pipe.vertexes[pipe.vertexes.length - 1]?.point;
      return {
        id: `${label}${i + 1}`,
        site_id: pipe.id,
        type: pipe.type,
        from: [round0(cmToMm(first?.x ?? 0)), round0(cmToMm(first?.y ?? 0))],
        to: [round0(cmToMm(last?.x ?? 0)), round0(cmToMm(last?.y ?? 0))],
        vertexes: pipe.vertexes.length,
        length_mm: Math.round((pipe.length ?? 0) * 1000),
        connected: pipe.vertexes.filter((v) => v.type !== "node").map((v) => v.id),
      };
    });

  // нижняя панель / листы (этап 375)
  const compactSheets = (src: Record<string, import("./sheets.ts").CustomPlanEntity> | undefined): CompactSheet[] =>
    Object.values(src ?? {}).map((s, i) => ({
      id: `S${i + 1}`,
      site_id: s.id,
      name: s.name,
      after_plan: s.after_plan,
      content: s.content ?? [],
    }));
  const compactDrawLines = (src: Record<string, import("./draw.ts").GraphDrawRec> | undefined, label: string, thick = false): CompactDrawLine[] =>
    Object.values(src ?? {}).map((r, i) => {
      // индивидуальная ширина толстой линии — в ячейках matrix {length, width}
      let widthCm: number | undefined;
      if (thick && r.on_width === 1) {
        for (const row of r.matrix) {
          for (const cell of row) {
            if (cell && typeof cell === "object" && typeof (cell as { width?: unknown }).width === "number") {
              widthCm = (cell as { width: number }).width;
              break;
            }
          }
          if (widthCm !== undefined) break;
        }
      }
      return {
        id: `${label}${i + 1}`,
        site_id: r.id,
        plan: r.plan,
        points_mm: (r.vertexes ?? []).map((v) => [round0(cmToMm(v.point?.x ?? 0)), round0(cmToMm(v.point?.y ?? 0))] as [number, number]),
        length_mm: Math.round((r.length ?? 0) * 1000),
        ...(r.color_custom ? { color: r.color_custom } : {}),
        ...(widthCm !== undefined ? { width_mm: round0(cmToMm(widthCm)) } : {}),
      };
    });
  const compactFigures = (src: Record<string, import("./draw.ts").FreeFigureEntity> | undefined, label: string): CompactFigure[] =>
    Object.values(src ?? {}).map((f, i) => ({
      id: `${label}${i + 1}`,
      site_id: f.id,
      type: f.type ?? "rect",
      plan: f.plan ?? "plan",
      center_mm: [round0(cmToMm(f.pc?.x ?? 0)), round0(cmToMm(f.pc?.y ?? 0))] as [number, number],
      width_mm: round0(cmToMm(f.width ?? 0)),
      height_mm: round0(cmToMm(f.height ?? 0)),
      angle_deg: f.angle ?? 0,
      ...(typeof f.color === "string" ? { color: f.color } : {}),
    }));
  const compactPictures = (src: Record<string, import("./pictures.ts").PictureEntity> | undefined, label: string): CompactPicture[] =>
    Object.values(src ?? {}).map((p, i) => ({
      id: `${label}${i + 1}`,
      site_id: p.id,
      url: p.url,
      plan: p.plan ?? "plan",
      center_mm: [round0(cmToMm(p.pc?.x ?? 0)), round0(cmToMm(p.pc?.y ?? 0))] as [number, number],
      width_mm: round0(cmToMm(p.width ?? 0)),
      height_mm: round0(cmToMm(p.height ?? 0)),
      // major 376 №2: подпись наружу — видимым текстом (server-форма → unescape)
      ...(p.text ? { text: unescapeCommentText(p.text) } : {}),
    }));

  // Развёртки: молдинги/ниши (этап 389). Позиция наружу — семантическая
  // (along — от начала развёртки по prs.pc_xd, from_floor — от низа по
  // prs.pc_yd и total_height): pc — кэш рамки развёрток, агент его не видит.
  const compactPrsFigures = (src: Record<string, import("./projections.ts").PrsFigureEntity> | undefined, label: string, kind: string): CompactPrsFigure[] => {
    const roomLabelById = new Map<string, string>();
    roomList.forEach((r, i) => {
      if (r.roomId) roomLabelById.set(r.roomId, `R${i + 1}`);
    });
    return Object.values(src ?? {}).map((f, i) => {
      const prs = (f.prs ?? {}) as Record<string, unknown>;
      const xd = typeof prs["pc_xd"] === "number" ? prs["pc_xd"] : 0;
      const yd = typeof prs["pc_yd"] === "number" ? prs["pc_yd"] : 0;
      const H = totalHeight;
      const roomSite = typeof prs["room"] === "string" ? prs["room"] : null;
      return {
        id: `${label}${i + 1}`,
        site_id: f.id,
        kind: kind as CompactPrsFigure["kind"],
        room: roomSite ? (roomLabelById.get(roomSite) ?? roomSite) : null,
        edge_index: typeof prs["edge_index"] === "number" ? prs["edge_index"] : -1,
        along_mm: round0(cmToMm(xd)),
        from_floor_mm: round0(cmToMm(H - yd)),
        width_mm: round0(cmToMm(f.width ?? 0)),
        height_mm: round0(cmToMm(f.height ?? 0)),
        ...(f.depth !== undefined ? { depth_mm: round0(cmToMm(f.depth)) } : {}),
        ...(f.width_line !== undefined ? { width_line_mm: round0(cmToMm(f.width_line)) } : {}),
      };
    });
  };

  return {
    walls,
    rooms: compactRooms,
    items,
    pillars,
    rigels,
    gas_lines: gasLines,
    pipes,
    terrace_borders: terraceBorders,
    territory_borders: territoryBorders,
    level_holes: levelHoles,
    zone_delimiters: zoneDelimiters,
    ceiling_rigels: ceilingRigels,
    led_strips: compactLightStrips(model.led_strips, "LS"),
    stripes_light: compactLightStrips(model.stripes_light, "SL"),
    line_strips: compactLightStrips(model.line_strips, "LL"),
    cables: compactCables(model.cables),
    cables_socket: compactElecCables(model.cables_socket, "CS"),
    cables_warm_floor: compactElecCables(model.cables_warm_floor, "CW"),
    cables_conditioner: compactElecCables(model.cables_conditioner, "CC"),
    shields: compactShields(model.shields),
    warm_floors: compactWarmFloors(model.warm_floors),
    pipes_warm_floor: compactClimatePipes(model.pipes_warm_floor, "PW"),
    pipes_conditioner: compactClimatePipes(model.pipes_conditioner, "PC"),
    pipes_heat: compactClimatePipes(model.pipes_heat, "PH"),
    pipes_ventilation: compactClimatePipes(model.pipes_ventilation, "PV"),
    custom_plans: compactSheets(model.custom_plans),
    freelines: compactDrawLines(model.freelines, "FL"),
    thick_lines: compactDrawLines(model.thick_lines, "TL", true),
    free_figures: compactFigures(model.free_figures, "DE"),
    pictures: compactPictures(model.pictures, "PIC"),
    wall_moldings: compactPrsFigures(model.wall_moldings, "WM", "wall_molding"),
    wall_niches: compactPrsFigures(model.wall_niches, "WN", "wall_niche"),
    total_height_mm: round0(cmToMm(totalHeight)),
  };
}

export function compactModelJson(model: Model): string {
  return JSON.stringify(compactModel(model));
}
