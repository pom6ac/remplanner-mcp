import type { Model, ItemProps, Wall, WallLink, Point } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, roundTenthMm as r2 } from "./units.ts";
import {
  add, sub, scale, leftNormal, angleDeg, pointInPolygon, polygonArea, polygonSignedArea,
  lineIntersection, type Polygon,
} from "./geometry.ts";
import type { MmPoint } from "./walls.ts";
import type { ToolEntry } from "../catalog.ts";
import { McpError } from "../errors.ts";

// ---------- комнаты (канонические полигоны считает редактор: rooms2) ----------

export type RoomPolygon = {
  roomId: string | null;
  polygon: Polygon;
  areaCm2: number;
  /** Площадь по осевым линиям, см² (для комнат из rooms2 недоступна — null). */
  axisAreaCm2: number | null;
};

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Полигоны помещений — ТОЛЬКО из rooms2 нормализованной модели редактора (design §12.5).
 * Самодельные контуры по связям стен удалены (wallCycles, R2-7): редактор считает комнаты
 * из геометрии при draw, Node не дублирует эту работу. Если rooms2 нет (модель не
 * нормализовалась) — комнат нет, инструменты сообщат no_rooms.
 */
export function roomPolygons(model: Model): RoomPolygon[] {
  const rooms2 = model.rooms2 as Record<string, { polygon?: Point[]; area?: number }> | undefined;
  if (!rooms2) return [];
  return Object.entries(rooms2)
    .filter(([, r]) => r && Array.isArray(r.polygon) && r.polygon.length >= 3)
    .map(([rid, room]) => ({
      roomId: rid,
      polygon: room.polygon as Polygon,
      areaCm2: typeof room.area === "number" ? (room.area as number) * 10_000 : polygonArea(room.polygon as Polygon),
      axisAreaCm2: null, // осевой контур для комнат редактора не восстанавливаем (№15)
    }));
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
 * Линейные трубы (этап 57): «Газовый трубопровод» gas_line редактор ставит в отдельную
 * коллекцию model.pipes_gas (граф узлов), а не в items — через item_add он неприменим.
 */
export const LINE_TOOLS = new Set(["gas_line"]);

function itemPlan(entry: ToolEntry | undefined): Record<string, number> {
  const mapped = itemPlanFromEntry(entry);
  return Object.keys(mapped).length > 0 ? mapped : { furniture: 1 };
}

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
  // этап 57: газовая линия — отдельная сущность (model.pipes_gas), не предмет
  if (entry && LINE_TOOLS.has(entry.name)) {
    throw new McpError("INVALID_ARGUMENT", `«${entry.name}» — линия (труба), ставится инструментом gas_line_add, а не item_add: редактор пишет её в отдельную коллекцию pipes_gas`, {
      details: { kind: "line_tool_required", item: entry.name },
    });
  }
  const widthCm = mmToCm(params.widthMm ?? (entry ? entry.width * 10 : 100));
  const depthCm = mmToCm(params.depthMm ?? (entry ? entry.height * 10 : 100));
  const selfHeightCm = mmToCm(params.heightMm ?? (entry ? entry.self_height * 10 : 0));

  let pc: Point;
  let angle = params.angleDeg ?? 0;
  let idWall: string | null = null;

  if ("center" in params.position) {
    pc = { x: mmToCm(params.position.center.x), y: mmToCm(params.position.center.y) };
  } else if ("againstWall" in params.position) {
    const aw = params.position.againstWall;
    const wall = model.walls[aw.wallId];
    if (!wall) throw new McpError("NOT_FOUND", `стена ${aw.wallId} не найдена`);
    const dir = sub(wall.p2, wall.p1);
    const len = Math.hypot(dir.x, dir.y);
    if (len < 1e-6) throw new McpError("INVALID_ARGUMENT", "стена нулевой длины");
    const u = scale(dir, 1 / len);
    const nl = leftNormal(dir.x, dir.y);
    // внутренняя сторона стены — та, где помещение
    const room = findRoom(rooms ?? roomPolygons(model));
    const center = roomCenter(room.polygon);
    const wallMid = { x: (wall.p1.x + wall.p2.x) / 2, y: (wall.p1.y + wall.p2.y) / 2 };
    const toRoom = sub(center, wallMid);
    const inward = nl.x * toRoom.x + nl.y * toRoom.y > 0 ? nl : scale(nl, -1);
    const from = aw.from ?? "start";
    const sign = from === "end" ? -1 : 1;
    const base = from === "end" ? wall.p2 : wall.p1;
    const along = mmToCm(aw.offsetMm) + widthCm / 2;
    pc = add(add(base, scale(u, sign * along)), scale(inward, wall.depth / 2 + mmToCm(aw.gapMm ?? 0) + depthCm / 2));
    // ширина предмета ВДОЛЬ стены (эталон ui-ref-sofa: угол = углу оси, а не нормали) — №10 ревью
    angle = angleDeg(wall.p1, wall.p2);
    if (angle > 90) angle -= 180;
    if (angle <= -90) angle += 180;
    idWall = wall.id;
  } else {
    const corner = params.position.inRoom.corner;
    const room = findRoom(rooms ?? roomPolygons(model));
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

  const allRooms = rooms ?? roomPolygons(model);
  const found = allRooms.find((room) => pointInPolygon(room.polygon, pc));
  if (!found) {
    if (allRooms.length === 0) {
      throw new McpError("GEOMETRY_CONFLICT", "в модели нет замкнутых помещений", { details: { kind: "no_rooms" } });
    }
    throw new McpError("OUTSIDE_ROOM", "точка вне помещений", { details: { kind: "outside_room", point: pc } });
  }

  const id = `_${newId(5)}`;
  const props: ItemProps = {
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
    dimensions: { display: !STAIR_DIMENSIONS_HIDDEN.has(params.name) && !COMM_DIMENSIONS_HIDDEN.has(params.name) },
    rotated: 0,
    // этап 55, ревью №3 / этап 57: подъём над полом — в форме редактора {value, display};
    // display — по эталонам UI (у radiator_old/conditioner_cage false, у прочих true)
    over_floor: params.elevationMm !== undefined
      ? { value: r2(mmToCm(params.elevationMm)), display: !COMM_OVER_FLOOR_DISPLAY_FALSE.has(params.name) }
      : null,
  };
  model.items[id] = props;
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
};

/** item_update: перемещение, поворот, размеры. */
export function updateItem(model: Model, params: UpdateItemParams): ItemProps {
  const item = model.items[params.itemId];
  if (!item) throw new McpError("NOT_FOUND", `предмет ${params.itemId} не найден`);
  const props = item;
  if (params.center) {
    const pc = { x: mmToCm(params.center.x), y: mmToCm(params.center.y) };
    const found = roomPolygons(model).find((room) => pointInPolygon(room.polygon, pc));
    if (!found) {
      throw new McpError("OUTSIDE_ROOM", "точка вне помещений", { details: { kind: "outside_room", point: pc } });
    }
    props.pc = { x: r2(pc.x), y: r2(pc.y) };
    props.id_room = found.roomId ?? props.id_room;
  }
  if (params.angleDeg !== undefined) props.angle = Math.round(params.angleDeg);
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
  return props;
}

/** item_delete. */
export function deleteItem(model: Model, itemId: string): void {
  if (!model.items[itemId]) throw new McpError("NOT_FOUND", `предмет ${itemId} не найден`);
  delete model.items[itemId];
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
