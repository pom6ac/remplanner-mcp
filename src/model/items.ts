import type { Model, ItemProps, Wall, WallLink, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import {
  add, sub, scale, leftNormal, angleDeg, pointInPolygon, polygonSignedArea,
  lineIntersection, type Polygon,
} from "./geometry.ts";
import type { MmPoint } from "./walls.ts";
import type { ToolEntry } from "../catalog.ts";
import { McpError } from "../errors.ts";
import { pipesReferencingItem, refreshPipeForItem } from "./pipes.ts";
import { elecCablesReferencingItem, refreshElecCablesForItem } from "./electric2.ts";
import { detachRulerItemTargets, itemComments, deleteComment, refreshRulersForItem, refreshItemComments } from "./dims.ts";
import {
  CABLE_LAMP_ITEMS, cablesReferencingItem, refreshCablesForItem, refreshSocketGroupSubs,
  STANDALONE_SOCKETS, SWITCH_ITEMS, type SocketGroupSub,
} from "./electric.ts";

// ---------- комнаты (канонические полигоны считает редактор: rooms2) ----------

export { roomPolygons, type RoomPolygon } from "./rooms.ts";
import { roomPolygons, inwardSideByProbe, type RoomPolygon } from "./rooms.ts";

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function roomCenter(poly: Polygon): Point {
  let sx = 0;
  let sy = 0;
  for (const p of poly) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / poly.length, y: sy / poly.length };
}

function findRoom(rooms: RoomPolygon[], point?: Point): RoomPolygon {
  if (rooms.length === 0) {
    throw new McpError("GEOMETRY_CONFLICT", "в модели нет замкнутых помещений", { details: { kind: "no_rooms" } });
  }
  if (point) {
    const found = rooms.find((room) => pointInPolygon(room.polygon, point));
    if (found) return found;
    throw new McpError("OUTSIDE_ROOM", "точка вне помещений", { details: { kind: "outside_room", point } });
  }
  return rooms.reduce((a, b) => (b.areaCm2 > a.areaCm2 ? b : a));
}



// ---------- предметы ----------

export type AddItemParams = {
  name: string;
  position:
    | { center: MmPoint }
    | { againstWall: { wallId: string; offsetMm: number; from?: "start" | "end"; gapMm?: number } }
    | { inRoom: { corner: "nw" | "ne" | "se" | "sw" | "center" } };
  angleDeg?: number;
  widthMm?: number;
  depthMm?: number;
  heightMm?: number;
  elevationMm?: number;
  catalogEntry?: ToolEntry;
};

/**
 * Позиции меню «Лестницы» вне группы каталога `stairs` (этап 55, ревью №2): сам список
 * меню выводится из группы `stairs` каталога (см. itemPlanFromEntry), а эти два пункта
 * редактор показывает в том же меню «Лестницы» при других группах каталога —
 * «Тренажер-лестница» `stair_machine` (furniture) и «Светильник для подсветки пола»
 * `stair_spot` (lights, эталон ui-ref-stair-stair_spot: план {light:10, a:1}).
 */
export const STAIR_MENU_EXTRA = new Set(["stair_machine", "stair_spot"]);

/**
 * План предмета из записи каталога (этап 55, ревью №2): список пунктов меню «Лестницы»
 * берётся из каталога, а не вручную — видимость на исходном плане (a:1) получает любая
 * позиция группы `stairs` (все 21 пункт меню, включая 4 с планом {furniture:6}:
 * ladder_2march_console-fan, ladder_fan_2march, ladder_3march_fan, floor_hatch) и два
 * пункта меню вне группы (STAIR_MENU_EXTRA). Ключ листа каталога init отображается в
 * модельный a (лист «Исходный план»; эталон ui-ref-stair-upper_march: план {a:1});
 * у лестниц уже с a:1 дубля нет. Мебель вне меню не затронута (эталон ui-ref-sofa:
 * {furniture:6} без a).
 */
export function itemPlanFromEntry(entry: ToolEntry | undefined): Record<string, number> {
  const plan: Record<string, number> = {};
  for (const [k, v] of Object.entries(entry?.plan ?? {})) plan[k === "init" ? "a" : k] = v;
  if (entry && (entry.group === "stairs" || STAIR_MENU_EXTRA.has(entry.name)) && plan["a"] === undefined) plan["a"] = 1;
  return plan;
}

/**
 * dimensions.display у пунктов меню «Лестницы» (этап 55, ревью №3) — подтверждено
 * эталонами ui-ref-stair-*: у пяти видов лестниц редактор пишет display:false
 * (ladder_march, ladder_2march, spiral_staircase, upper_march, porch), у stair_spot —
 * display:true (как у мебели, эталон ui-ref-sofa). Для остальных пунктов меню эталонов
 * нет — пишется display:true (поведение мебели), это не заявляется как факт о них.
 */
const STAIR_DIMENSIONS_HIDDEN = new Set([
  "ladder_march", "ladder_2march", "spiral_staircase", "upper_march", "porch",
]);

/**
 * dimensions.display у пунктов меню «Коммуникации» (этап 57): подтверждено пробами
 * UI (57-comm-ui*, клики в dev-проекте, эталоны ui-ref-comm-*) — у пяти видов редактор
 * пишет display:false (water, water_column_hot, water_column_cold, drainage_column, air),
 * у остальных (radiator_old, gas_pipe, gas_boiler, gas_meter, fire_detector,
 * ceiling_water, conditioner_cage) — display:true. У ventilation_hole и
 * electric_shield_old эталонов постановки нет (UI не воспроизвёл), пишется display:true
 * (поведение мебели), это не заявляется как факт о них.
 */
const COMM_DIMENSIONS_HIDDEN = new Set([
  "water", "water_column_hot", "water_column_cold", "drainage_column", "air",
]);

/**
 * Флаг display у over_floor у пунктов меню «Коммуникации» (этап 57, эталоны ui-ref-comm-*):
 * у radiator_old и conditioner_cage редактор пишет {value, display:false}; у gas_boiler —
 * {value, display:true}. Для остальных видов эталонов с over_floor нет — display:true
 * (поведение stair_spot/ui-ref-sofa), это не заявляется как факт о них.
 */
const COMM_OVER_FLOOR_DISPLAY_FALSE = new Set(["radiator_old", "conditioner_cage"]);

/**
 * Пункты меню климата (этап 122, эталоны ui-ref-climate-*): у conditioner_engine и
 * floor_conditioner редактор пишет dimensions {display:0, default_value_set:1}
 * (показ размеров выключен по умолчанию), у остальных — display:true.
 */
const CLIMATE_DIMENSIONS_DEFAULT = new Set(["conditioner_engine", "floor_conditioner"]);

/**
 * Климат-предметы (этап 122): группы каталога, чьи plan указывает листы разделов
 * климата. У них over_floor берётся из каталога целиком (значение И display —
 * эталоны ui-ref-climate-*: conditioner {value:210, display:false}, radiator_bimetal
 * {value:10, display:false}, socket_thermo {value:90, display:true}).
 */
const CLIMATE_SHEETS = new Set(["warm_floor", "conditioners", "ventilation", "radiators"]);

function isClimateEntry(entry: ToolEntry | undefined): boolean {
  if (!entry) return false;
  return Object.keys(entry.plan ?? {}).some((k) => CLIMATE_SHEETS.has(k));
}

/**
 * Линейные сущности (этапы 57, 78, 84, 122): «Газовый трубопровод» gas_line редактор
 * ставит в отдельную коллекцию model.pipes_gas, трубы водоснабжения/канализации
 * water_pipe/water_hot_pipe/drainage_pipe (лист «Водоснабжение») — в model.pipes,
 * световые линии листа «Освещение» — led_strip в model.led_strips,
 * recessed_strip/surface_stripe/pendent_strip в model.stripes_light, line_light в
 * model.line_strips (этап 84); трубы/провода климата (этап 122): warm_floor_pipe
 * (pipes_warm_floor), conditioner_wire (cables_conditioner — следующий PR),
 * conditioner_drainage (pipes_conditioner), heat_pipe_hot/heat_pipe_cold (pipes_heat),
 * ventpipe_out/ventpipe_in (pipes_ventilation), warm_floor_wire (cables_warm_floor —
 * следующий PR), warm_floor/warm_floor_ir/warm_floor_water (контуры model.warm_floors —
 * warm_floor_add), warm_wall_cable (Кабельная тёплая стена — формат не снят, следующий PR);
 * все — графы или контуры, через item_add неприменимы.
 */
export const LINE_TOOLS = new Set([
  "gas_line", "water_pipe", "water_hot_pipe", "drainage_pipe",
  "led_strip", "recessed_strip", "surface_stripe", "pendent_strip", "line_light",
  "warm_floor", "warm_floor_ir", "warm_floor_water", "warm_floor_wire", "warm_floor_pipe",
  "conditioner_wire", "conditioner_drainage", "heat_pipe_hot", "heat_pipe_cold",
  "ventpipe_out", "ventpipe_in", "warm_wall_cable",
]);

/** Подсказка для LINE_TOOLS: каким инструментом ставится линия. */
export function lineToolHint(name: string): string {
  if (name === "gas_line") return "gas_line_add";
  if (name === "led_strip") return "led_strip_add";
  if (name === "line_light") return "line_light_add";
  if (name === "recessed_strip" || name === "surface_stripe" || name === "pendent_strip") return "stripe_add";
  if (name === "warm_floor" || name === "warm_floor_ir" || name === "warm_floor_water") return "warm_floor_add";
  return "pipe_add";
}

/**
 * Трековые споты на шине (этап 84): track_spot/track_pendent_spot/track_panel_spot
 * ставятся НА трековую шину (двусторонняя связь: props.strip_light_id у предмета и
 * spots[<id предмета>] = {name, line_id, d} у шины), track_line_spot — линейный спот
 * на шине (strip.line_spots). Связь со шиной в этапе 84 не пишется — предмет без
 * привязки к шине редактором не поддержан, item_add отклоняет с подсказкой
 * (см. отчёт 84, «вынесено в следующий PR»).
 */
export const TRACK_SPOT_TOOLS = new Set([
  "track_spot", "track_pendent_spot", "track_panel_spot", "track_line_spot",
]);

function itemPlan(entry: ToolEntry | undefined): Record<string, number> {
  const mapped = itemPlanFromEntry(entry);
  return Object.keys(mapped).length > 0 ? mapped : { furniture: 1 };
}

/** Параметры постановки у стены (публичные мм, переводит формула). */
export type AgainstWallSpec = {
  wallId: string;
  offsetMm: number;
  from?: "start" | "end";
  gapMm?: number;
};

/**
 * Угол пристенной электрики (socket_group: розетки, выключатели, socket_thermo):
 * ось стены + 180, нормированный в (−180; 180] — предмет развёрнут лицом от стены
 * (эталоны ui-ref-elec-*). Одно правило для item_add и item_update against_wall
 * (ревью 198 №1): иначе под-элементы refreshSocketGroupSubs оказываются не с той
 * стороны от pc.
 */
export function socketGroupAngleDeg(wallAxisAngleDeg: number): number {
  let a = wallAxisAngleDeg + 180;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

/**
 * Постановка предмета у стены: центр (см модели) и угол оси, нормированный
 * в (−90; 90]. Общая формула item_add (againstWall) и item_update
 * (against_wall, через DTO-слой) — ревью 190: дубликат в DTO считал нормаль
 * вектором в 10 раз короче (мм↔см), без полутолщины стены и без стороны
 * помещения. Внутренняя сторона стены — ревью 198 №4: та, чья пробная точка
 * (на offset вдоль стены, depth/2 + ε от оси) попадает в полигон комнаты;
 * если попадают обе (внутренняя перегородка) или ни одна — прежнее правило:
 * сторона центра самой большой комнаты.
 */
export function againstWallPlacement(
  wall: Wall,
  aw: AgainstWallSpec,
  widthCm: number,
  depthCm: number,
  rooms: RoomPolygon[],
): { pc: Point; angleDeg: number } {
  const dir = sub(wall.p2, wall.p1);
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-6) throw new McpError("INVALID_ARGUMENT", "стена нулевой длины");
  const u = scale(dir, 1 / len);
  const nl = leftNormal(dir.x, dir.y);
  const from = aw.from ?? "start";
  const sign = from === "end" ? -1 : 1;
  const base = from === "end" ? wall.p2 : wall.p1;
  const along = mmToCm(aw.offsetMm) + widthCm / 2;
  // ревью 198 №4: точка проб и центр предмета — одно смещение вдоль стены
  // (offset от from + полуширина), пробная точка стороны — на depth/2 + ε от оси
  // (общий хелпер inwardSideByProbe, ревью 209 №3)
  const onAxis = add(base, scale(u, sign * along));
  let inward = inwardSideByProbe(wall, nl, onAxis, rooms);
  if (!inward) {
    // запасное правило (обе или ни одна проба в комнате): сторона центра самой большой комнаты
    const room = findRoom(rooms);
    const center = roomCenter(room.polygon);
    const wallMid = { x: (wall.p1.x + wall.p2.x) / 2, y: (wall.p1.y + wall.p2.y) / 2 };
    const toRoom = sub(center, wallMid);
    inward = nl.x * toRoom.x + nl.y * toRoom.y > 0 ? nl : scale(nl, -1);
  }
  const pc = add(onAxis, scale(inward, wall.depth / 2 + mmToCm(aw.gapMm ?? 0) + depthCm / 2));
  // ширина предмета ВДОЛЬ стены (эталон ui-ref-sofa: угол = углу оси, а не нормали) — №10 ревью
  let angle = angleDeg(wall.p1, wall.p2);
  if (angle > 90) angle -= 180;
  if (angle <= -90) angle += 180;
  return { pc, angleDeg: angle };
}

/**
 * Часть 2: щитки и настенные коробки — over_floor из каталога с display:false
 * (проба 239-elec2-items3); electric_box — свободный, over_floor нет.
 */
const ELEC_SHIELD_CATALOG_OVER_FLOOR = new Set([
  "electric_shield", "electric_shield_internal", "lowcurrent_shield", "lowcurrent_shield_internal",
  "electric_box_wall", "electric_kup",
]);

/** item_add: центр / у стены (с касанием внутренней грани при gap=0) / в углу помещения.
 *  rooms — комнаты из кеша workspace (нормализованная модель), если в model.rooms2 их ещё нет. */
export function addItem(model: Model, params: AddItemParams, rooms?: RoomPolygon[]): ItemProps {
  model.items ??= {};
  const entry = params.catalogEntry;
  // этап 55, ревью №4: у позиций с anchor:"wall" (porch, stair_spot — эталоны ui-ref-*)
  // редактор свободную постановку не выполняет: одиночный клик вдали от стены предмет
  // не создаёт. Свободная установка (center/in_room) отвергается как в редакторе;
  // разрешена только against_wall.
  if (entry?.anchor === "wall" && !("againstWall" in params.position)) {
    throw new McpError("INVALID_ARGUMENT", `предмет «${entry.name}» ставится только у стены (anchor: wall — так же в редакторе), используйте against_wall`, {
      details: { kind: "wall_anchor_required", item: entry.name },
    });
  }
  // этап 78: трубы водоснабжения/канализации и газовая линия — отдельные сущности-графы;
  // этап 84: световые линии листа «Освещение» — тоже
  if (entry && LINE_TOOLS.has(entry.name)) {
    throw new McpError("INVALID_ARGUMENT", `«${entry.name}» — линия (световая линия/труба), ставится инструментом ${lineToolHint(entry.name)}, а не item_add: редактор пишет её в отдельную коллекцию графа, а не в items`, {
      details: { kind: "line_tool_required", item: entry.name },
    });
  }
  // этап 84: трековые споты ставятся НА трековую шину (связь spots/strip_light_id) —
  // предмет без шины редактором не поддержан, подключение к шине — следующий этап
  if (entry && TRACK_SPOT_TOOLS.has(entry.name)) {
    throw new McpError("INVALID_ARGUMENT", `«${entry.name}» ставится на трековую шину (recessed_strip/surface_stripe/pendent_strip, инструменты stripe_add): подключение спота к шине редактором не поддержано — поставьте шину, спот добавьте в редакторе`, {
      details: { kind: "track_spot_requires_strip", item: entry.name },
    });
  }
  // этап 88: соединительный провод — отдельная сущность model.cables, не предмет
  if (entry && entry.name === "cable") {
    throw new McpError("INVALID_ARGUMENT", "«cable» (Соединительная линия) — связь «выключатель → светильник», ставится инструментом cable_add (выключатель item_add, затем cable_add), а не item_add", {
      details: { kind: "cable_tool_required" },
    });
  }
  // часть 2: кабели-коллекции листа «Электропроводка» (wire_*, warm_floor_wire,
  // conditioner_wire) — отдельные сущности-графы, ставятся инструментом wiring_add;
  // electrospot_node («Узел») — обычный предмет
  if (entry && entry.group === "cables" && entry.name !== "electrospot_node") {
    throw new McpError("INVALID_ARGUMENT", `«${entry.name}» — кабель-проводка, ставится инструментом wiring_add (редактор пишет его в отдельную коллекцию-граф, а не в items)`, {
      details: { kind: "wiring_tool_required", item: entry.name },
    });
  }
  /** Розетка/выключатель у стены — группа socket_group (проба 88-elec-groups:
   *  одиночная розетка и выключатель тоже пишутся как item name="socket_group";
   *  socket_power/socket_380 — самостоятельные предметы, $SocketsGroup.types их не знает). */
  const electricGroup = entry !== undefined
    && (entry.group === "sockets" || entry.group === "switches")
    && !STANDALONE_SOCKETS.has(entry.name);
  const widthCm = mmToCm(params.widthMm ?? (entry ? entry.width * 10 : 100));
  const depthCm = mmToCm(params.depthMm ?? (entry ? entry.height * 10 : 100));
  const selfHeightCm = mmToCm(params.heightMm ?? (entry ? entry.self_height * 10 : 0));

  const allRooms = rooms ?? roomPolygons(model);

  let pc: Point;
  let angle = params.angleDeg ?? 0;
  let idWall: string | null = null;

  if ("center" in params.position) {
    pc = { x: mmToCm(params.position.center.x), y: mmToCm(params.position.center.y) };
  } else if ("againstWall" in params.position) {
    const aw = params.position.againstWall;
    const wall = model.walls[aw.wallId];
    if (!wall) throw new McpError("NOT_FOUND", `стена ${aw.wallId} не найдена`);
    const placement = againstWallPlacement(wall, aw, widthCm, depthCm, allRooms);
    pc = placement.pc;
    angle = placement.angleDeg;
    idWall = wall.id;
  } else {
    const corner = params.position.inRoom.corner;
    const room = findRoom(allRooms);
    const xs = room.polygon.map((p) => p.x);
    const ys = room.polygon.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const hw = widthCm / 2;
    const hd = depthCm / 2;
    switch (corner) {
      case "nw": pc = { x: minX + hw, y: minY + hd }; break;
      case "ne": pc = { x: maxX - hw, y: minY + hd }; break;
      case "se": pc = { x: maxX - hw, y: maxY - hd }; break;
      case "sw": pc = { x: minX + hw, y: maxY - hd }; break;
      default: pc = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    }
  }

  const found = allRooms.find((room) => pointInPolygon(room.polygon, pc));
  if (!found) {
    if (allRooms.length === 0) {
      throw new McpError("GEOMETRY_CONFLICT", "в модели нет замкнутых помещений", { details: { kind: "no_rooms" } });
    }
    throw new McpError("OUTSIDE_ROOM", "точка вне помещений", { details: { kind: "outside_room", point: pc } });
  }

  const id = `_${newId(5)}`;
  const climate = isClimateEntry(entry);
  const overFloor = params.elevationMm !== undefined
    ? { value: r2(mmToCm(params.elevationMm)), display: !COMM_OVER_FLOOR_DISPLAY_FALSE.has(params.name) && entry?.group !== "waterspots" }
    : climate && entry?.over_floor && typeof entry.over_floor === "object" && typeof (entry.over_floor as { value?: unknown }).value === "number"
      // этап 122: у климат-предметов over_floor из каталога целиком (значение и display,
      // эталоны ui-ref-climate-*: conditioner {value:210, display:false})
      ? { value: r2((entry.over_floor as { value: number }).value), display: (entry.over_floor as { display?: boolean }).display !== false }
      : entry?.group === "waterspots" && entry.over_floor && typeof entry.over_floor === "object" && typeof (entry.over_floor as { value?: unknown }).value === "number"
      ? { value: r2((entry.over_floor as { value: number }).value), display: false }
      : entry?.group === "lights" && entry.over_floor && typeof entry.over_floor === "object" && typeof (entry.over_floor as { value?: unknown }).value === "number"
        ? { value: r2((entry.over_floor as { value: number }).value), display: (entry.over_floor as { display?: boolean }).display !== false }
        : entry && (entry.group === "sockets" || entry.group === "switches") && entry.over_floor && typeof entry.over_floor === "object" && typeof (entry.over_floor as { value?: unknown }).value === "number"
          // этап 88: самостоятельные розетки (socket_power/socket_380) — редактор
          // включает display (эталон ui-ref-elec-socket_power: {value:30, display:true})
          ? { value: r2((entry.over_floor as { value: number }).value), display: true }
          : entry && entry.group === "wires" && entry.over_floor && typeof entry.over_floor === "object" && typeof (entry.over_floor as { value?: unknown }).value === "number"
          // часть 2: выводы проводов у стены — редактор включает display
          // (проба 239-elec2-items3: {value:30, display:true}); floor_wire/ceiling_wire
          // свободные — over_floor в модели нет
          ? { value: r2((entry.over_floor as { value: number }).value), display: true }
          : entry && ELEC_SHIELD_CATALOG_OVER_FLOOR.has(entry.name) && entry.over_floor && typeof entry.over_floor === "object" && typeof (entry.over_floor as { value?: unknown }).value === "number"
          // часть 2: щитки и настенные коробки — каталог целиком, display:false
          // (проба 239-elec2-items3: electric_shield {value:120, display:false})
          ? { value: r2((entry.over_floor as { value: number }).value), display: false }
          : null;
  let props: ItemProps;
  // часть 2: выводы проводов у стены — угол как у розеток (ось стены + 180°,
  // проба 239-elec2-items3: angle 180 на горизонтальной оси)
  if (entry?.group === "wires" && idWall) angle = socketGroupAngleDeg(angle);
  if (electricGroup) {
    // этап 88: группа socket_group с одной под-розеткой (проба 88-elec-groups:
    // одиночная розетка/выключатель редактор пишет группой из одного элемента;
    // имя предмета всегда "socket_group", plan — план под-элемента).
    // over_floor: редактор включает display и дописывает vd = value
    // (эталоны ui-ref-elec-*: {value:30, display:true, vd:30}).
    const ofValue = overFloor !== null
      ? overFloor.value
      : entry && entry.over_floor && typeof entry.over_floor === "object" && typeof (entry.over_floor as { value?: unknown }).value === "number"
        ? r2((entry.over_floor as { value: number }).value)
        : 0;
    const angle180 = socketGroupAngleDeg(angle);
    const sub: SocketGroupSub = {
      name: params.name,
      id: `_${newId(5)}`,
      real_center: { x: r2(pc.x), y: r2(pc.y) },
      center: { x: r2(pc.x), y: r2(pc.y) },
      center_prs: { x: r2(pc.x), y: r2(pc.y) },
    };
    props = {
      id,
      name: "socket_group",
      pc: { x: r2(pc.x), y: r2(pc.y) },
      angle: Math.round(angle180),
      width: r2(widthCm),
      height: r2(depthCm),
      self_height: 0,
      plan: itemPlan(entry),
      id_room: found.roomId ?? null,
      id_wall: idWall,
      layer: null,
      comment: { id: "" },
      demount: 0,
      dimensions: { display: true },
      rotated: 0,
      socket_group: [sub],
      legend: "",
      over_floor: { value: ofValue, display: true, vd: ofValue },
    };
  } else {
    props = {
      id,
      name: params.name,
      pc: { x: r2(pc.x), y: r2(pc.y) },
      angle: Math.round(angle),
      width: r2(widthCm),
      height: r2(depthCm),
      self_height: r2(selfHeightCm),
      plan: itemPlan(entry),
      id_room: found.roomId ?? null,
      id_wall: idWall,
      layer: null,
      comment: { id: "" },
      demount: 0,
      // этап 55, ревью №3 / этап 57: display — как в эталонах UI (у пяти видов лестниц
      // и пяти видов «Коммуникаций» false)
      // этап 122: у conditioner_engine/floor_conditioner — {display:0, default_value_set:1}
      dimensions: CLIMATE_DIMENSIONS_DEFAULT.has(params.name)
        ? ({ display: 0, default_value_set: 1 } as unknown as { display: boolean })
        : { display: !STAIR_DIMENSIONS_HIDDEN.has(params.name) && !COMM_DIMENSIONS_HIDDEN.has(params.name) },
      rotated: 0,
      // этап 55, ревью №3 / этап 57: подъём над полом — в форме редактора {value, display};
      // display — по эталонам UI (у radiator_old/conditioner_cage false, у прочих true).
      // Этап 78: у точек воды (waterspots) умолчание — из каталога (over_floor.value,
      // эталон ui-ref-plumb-waterspot: {value:50, display:false}), display:false.
      // Этап 84: у настенных светильников листа «Освещение» (bra и т.п.) умолчание —
      // из каталога целиком с его display (эталон ui-ref-light-bra: {value:140, display:true});
      // у потолочных (lightspot и др.) over_floor в модели нет (null).
      over_floor: overFloor,
    };
  }
  model.items[id] = props;
  if (electricGroup && idWall) refreshSocketGroupSubs(model, props);
  return props;
}

export type UpdateItemParams = {
  itemId: string;
  center?: MmPoint;
  angleDeg?: number;
  widthMm?: number;
  depthMm?: number;
  heightMm?: number;
  elevationMm?: number;
  comment?: string;
  /** ревью 198 №2: перенос against_wall пишет id_wall = wall.id, как item_add. */
  idWall?: string;
  /** ревью 203 №8/№10: явный режим пересчёта под-розеток при переносе against_wall —
   *  взаимное расположение (шаг) сохраняется, нормальная составляющая ставится от
   *  новой стены. Наличие idWall само по себе алгоритм не переключает. */
  resnapToWall?: boolean;
  /** ревью 198 №7: комнаты, по которым считалась позиция (кеш workspace) —
   *  OUTSIDE_ROOM проверяется по ним, а не только по rooms2 модели. */
  rooms?: RoomPolygon[];
};

/** item_update: перемещение, поворот, размеры. */
export function updateItem(model: Model, params: UpdateItemParams): ItemProps {
  const item = model.items[params.itemId];
  if (!item) throw new McpError("NOT_FOUND", `предмет ${params.itemId} не найден`);
  const props = item;
  const oldPc = { ...props.pc };
  const oldAngle = props.angle;
  if (params.center) {
    const pc = { x: mmToCm(params.center.x), y: mmToCm(params.center.y) };
    const found = (params.rooms ?? roomPolygons(model)).find((room) => pointInPolygon(room.polygon, pc));
    if (!found) {
      throw new McpError("OUTSIDE_ROOM", "точка вне помещений", { details: { kind: "outside_room", point: pc } });
    }
    props.pc = { x: r2(pc.x), y: r2(pc.y) };
    props.id_room = found.roomId ?? props.id_room;
    // этап 78: транзитивный пересчёт затронутых привязок — вершины труб, ссылающиеся
    // на этот предмет, следуют за его центром, длины пересчитываются по рёбрам
    refreshPipeForItem(model, params.itemId, props.pc);
  }
  if (params.angleDeg !== undefined) props.angle = Math.round(params.angleDeg);
  if (params.idWall !== undefined) props.id_wall = params.idWall;
  if (params.widthMm !== undefined) props.width = r2(mmToCm(params.widthMm));
  if (params.depthMm !== undefined) props.height = r2(mmToCm(params.depthMm));
  if (params.heightMm !== undefined) props.self_height = r2(mmToCm(params.heightMm));
  if (params.elevationMm !== undefined) {
    // этап 55, ревью №3: форма редактора {value, display}; display сохраняется прежний,
    // если предмет уже несёт объектную форму (у stair_spot эталон даёт display:true)
    const prev = props.over_floor;
    const display = prev !== null && typeof prev === "object" ? prev.display : true;
    props.over_floor = { value: r2(mmToCm(params.elevationMm)), display };
  }
  if (params.comment !== undefined) props.comment = { id: params.comment };
  // этап 88: транзитивный пересчёт затронутых привязок электрики — под-розетки
  // группы (перенос/поворот) и вершины связей, ссылающиеся на предмет
  if (Array.isArray(props.socket_group) && (params.center !== undefined || params.angleDeg !== undefined)) {
    // ревью 198 №1/№2, 203 №8/№10: перенос against_wall (явный режим resnapToWall
    // от tools-plan) — под-элементы пересчитываются с сохранением взаимного
    // расположения (шаг): вдоль-составляющая смещения переносится, нормальная
    // ставится от новой стены, как у item_add; обычный перенос/поворот — прежние
    // смещения переносятся с доворотом. idWall лишь пишет id_wall, алгоритм
    // переключает только явный флаг (ревью 203 №10).
    refreshSocketGroupSubs(model, props, oldPc, oldAngle, params.resnapToWall === true);
  }
  if (params.center !== undefined || params.angleDeg !== undefined) {
    refreshCablesForItem(model, params.itemId);
    // часть 2: вершины кабелей-проводки следуют за предметом (multi — pc,
    // electrospot — точка на 7 см от грани стены)
    refreshElecCablesForItem(model, params.itemId);
  }
  // этап 113: транзитивный пересчёт затронутых привязок размеров (формула
  // Ruler.update редактора) и комментариев, привязанных к предмету
  if (params.center !== undefined || params.angleDeg !== undefined) {
    refreshRulersForItem(model, params.itemId);
    refreshItemComments(model, params.itemId);
  }
  return props;
}

/** item_delete: предмет, подключённый к трубе или связи, удаляется только после них. */
export function deleteItem(model: Model, itemId: string): { detached_rulers: string[]; deleted_comments: string[] } {
  if (!model.items[itemId]) throw new McpError("NOT_FOUND", `предмет ${itemId} не найден`);
  const linked = pipesReferencingItem(model, itemId);
  if (linked.length > 0) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `предмет ${itemId} подключён к трубе (${linked.map((p) => p.id).join(", ")}) — сначала удалите трубу pipe_delete, затем предмет`,
      { details: { kind: "pipe_referenced", pipes: linked.map((p) => p.id) } },
    );
  }
  // часть 2: кабели-проводка держат обратные ссылки предмета/под-розеток —
  // удаление оставило бы висячие ссылки
  const elecCables = elecCablesReferencingItem(model, itemId);
  if (elecCables.length > 0) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `предмет ${itemId} подключён к кабелю-проводке (${elecCables.map((c) => c.id).join(", ")}) — сначала удалите кабель wiring_delete, затем предмет`,
      { details: { kind: "wiring_referenced", wirings: elecCables.map((c) => c.id) } },
    );
  }
  // этап 88: связь «выключатель → светильник» держит обратные ссылки предмета —
  // удаление оставило бы висячие ссылки
  const cables = cablesReferencingItem(model, itemId);
  if (cables.length > 0) {
    throw new McpError(
      "INVALID_ARGUMENT",
      `предмет ${itemId} подключён к связи «выключатель → светильник» (${cables.map((c) => c.id).join(", ")}) — сначала удалите связь cable_delete, затем предмет`,
      { details: { kind: "cable_referenced", cables: cables.map((c) => c.id) } },
    );
  }
  delete model.items[itemId];
  // этап 113: привязки размеров к предмету снимаются (геометрия размеров
  // сохраняется; редактор оставил бы висячую привязку — проба 113-fixtures),
  // комментарий предмета (label "item") удаляется каскадно
  const detached = detachRulerItemTargets(model, itemId);
  const comments = itemComments(model, itemId);
  for (const c of comments) deleteComment(model, c.id);
  return { detached_rulers: detached, deleted_comments: comments.map((c) => c.id) };
}

/** items_list (опционально по комнате-точке). */
export function itemsList(model: Model, inRoomPoint?: Point): ItemProps[] {
  return Object.values(model.items)
    .map((it) => it)
    .filter((props) => {
      if (!inRoomPoint) return true;
      const rooms = roomPolygons(model);
      const room = rooms.find((r) => pointInPolygon(r.polygon, inRoomPoint));
      if (!room) return false;
      return props.id_room === room.roomId || pointInPolygon(room.polygon, props.pc);
    });
}
