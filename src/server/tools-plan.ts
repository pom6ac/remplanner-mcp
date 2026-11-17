import { z } from "zod";
import { SCENARIO_HINT, mmInt, mmIntSigned, mm, mmPoint } from "./context.ts";
import type { ServerContext } from "./context.ts";
import { ok, tool, type ToolDefLike } from "./toolkit.ts";
import {
  addWall, addPolyline, addRoomRect, addRoomPolygon, updateWall, moveWall, splitWall, deleteWall,
  type MmPoint,
} from "../model/walls.ts";
import { addOpening, updateOpening, deleteOpening, OPENING_KINDS, KIND_BY_HOLE_TYPE } from "../model/openings.ts";
import { addPillar, updatePillar, deletePillar } from "../model/pillars.ts";
import { addRigel, updateRigel, deleteRigel, RIGEL_CEILING_TYPES } from "../model/rigels.ts";
import { addGasLine, updateGasLine, deleteGasLine, addPipe, updatePipe, deletePipe, MAX_PIPE_PATH_NODES, type PipeKind } from "../model/pipes.ts";
import { addLightLine, updateLightLine, deleteLightLine, MAX_LIGHT_PATH_NODES, LIGHT_COLLECTION_BY_KIND, type LightKind } from "../model/lighting.ts";
import { addCable, deleteCable, MAX_CABLE_PATH_NODES } from "../model/electric.ts";
import type { LedStrip, StripLight, LineStrip } from "../model/types.ts";
import { addFloorHole, updateFloorHole, deleteFloorHole } from "../model/floorhole.ts";
import {
  addBorderRing, updateBorder, deleteBorder, addTerraceFence, addTerraceColumn, updateTerraceColumn, deleteTerraceColumn,
} from "../model/terraces.ts";
import { addBalcony, updateBalcony, deleteBalcony, balconyWall } from "../model/balcony.ts";
import type { TerraceBorder } from "../model/types.ts";
import { addItem, updateItem, deleteItem, itemsList, roomPolygons, type RoomPolygon } from "../model/items.ts";
import { compactModel, wallLengthMm } from "../model/compact.ts";
import { validateModel } from "../model/validate.ts";
import { renderPlanToFile } from "../render.ts";
import type { Model, Wall, ItemProps } from "../model/types.ts";

// T19: инструменты стен, проёмов, предметов, каталога и чтения (design §7.2–7.4, §7.6).

/** Стена по site-id или компактной метке W1…Wn (порядок совпадает с model_get). */
function resolveWall(model: Model, ref: string): Wall {
  if (model.walls[ref]) return model.walls[ref]!;
  const m = /^W(\d+)$/.exec(ref);
  if (m) {
    const walls = Object.values(model.walls);
    const wall = walls[Number(m[1]) - 1];
    if (wall) return wall;
  }
  throw Object.assign(new Error(`стена ${ref} не найдена (id сайта или метка W<n> из model_get)`), { code: "NOT_FOUND" });
}

function throwNotFound(message: string): never {
  throw Object.assign(new Error(message), { code: "NOT_FOUND" });
}

/** Колонна по site-id или метке P1…P_n. */
function resolvePillar(model: Model, ref: string): import("../model/types.ts").Pillar {
  if (model.pillars[ref]) return model.pillars[ref]!;
  const m = /^P(\d+)$/.exec(ref);
  if (m) {
    const pillars = Object.values(model.pillars);
    const pillar = pillars[Number(m[1]) - 1];
    if (pillar) return pillar;
  }
  return throwNotFound(`колонна ${ref} не найдена (id сайта или метка P<n> из model_get)`);
}

/** Ригель по site-id или метке B1…B_n. */
function resolveRigel(model: Model, ref: string): import("../model/types.ts").Rigel {
  const rigels = model.rigels ?? {};
  if (rigels[ref]) return rigels[ref]!;
  const m = /^B(\d+)$/.exec(ref);
  if (m) {
    const list = Object.values(rigels);
    const rigel = list[Number(m[1]) - 1];
    if (rigel) return rigel;
  }
  return throwNotFound(`ригель ${ref} не найден (id сайта или метка B<n> из model_get)`);
}

/** Предмет по site-id или метке I1…I_n. */
function resolveItem(model: Model, ref: string): ItemProps {
  if (model.items[ref]) return model.items[ref]!;
  const m = /^I(\d+)$/.exec(ref);
  if (m) {
    const items = Object.values(model.items);
    const item = items[Number(m[1]) - 1];
    if (item) return item;
  }
  return throwNotFound(`предмет ${ref} не найден (id сайта или метка I<n> из model_get)`);
}

/** Граница террасы/участка по site-id или метке TB<n>/XB<n> из model_get. */
function resolveBorder(model: Model, key: "terrace_borders" | "territory_borders", label: string, ref: string): TerraceBorder {
  const borders = (model[key] ?? {}) as Record<string, TerraceBorder>;
  if (borders[ref]) return borders[ref]!;
  const m = new RegExp(`^${label}(\\d+)$`).exec(ref);
  if (m) {
    const list = Object.values(borders);
    const border = list[Number(m[1]) - 1];
    if (border) return border;
  }
  return throwNotFound(`граница ${ref} не найдена (id сайта или метка ${label}<n> из model_get)`);
}

/** Конец границы в публичном ответе: мм (ревью 68 №3 — как во всём MCP). */
function mmPointOf(p: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(p.x * 10), y: Math.round(p.y * 10) };
}

/** Граница для публичного ответа: концы в мм. */
function borderResponse(b: TerraceBorder): { id: string; p1: { x: number; y: number }; p2: { x: number; y: number } } {
  return { id: b.id, p1: mmPointOf(b.p1), p2: mmPointOf(b.p2) };
}

/** Проём в полу по site-id или метке FH1…FH_n из model_get. */
function resolveFloorHole(model: Model, ref: string): { id: string } {
  const holes = model.level_holes ?? {};
  if (holes[ref]) return holes[ref]!;
  const m = /^FH(\d+)$/.exec(ref);
  if (m) {
    const list = Object.values(holes);
    const hole = list[Number(m[1]) - 1];
    if (hole) return hole;
  }
  return throwNotFound(`проём в полу ${ref} не найден (id сайта или метка FH<n> из model_get)`);
}

/** Газовая линия по site-id или метке G1…G_n. */
function resolveGasLine(model: Model, ref: string): import("../model/types.ts").GasLine {
  const lines = model.pipes_gas ?? {};
  if (lines[ref]) return lines[ref]!;
  const m = /^G(\d+)$/.exec(ref);
  if (m) {
    const list = Object.values(lines);
    const line = list[Number(m[1]) - 1];
    if (line) return line;
  }
  return throwNotFound(`газовая линия ${ref} не найдена (id сайта или метка G<n> из model_get)`);
}

/** Труба водоснабжения по site-id или метке TP1…TP_n (этап 78). */
function resolvePipe(model: Model, ref: string): import("../model/types.ts").Pipe {
  const pipes = model.pipes ?? {};
  if (pipes[ref]) return pipes[ref]!;
  const m = /^TP(\d+)$/.exec(ref);
  if (m) {
    const list = Object.values(pipes);
    const pipe = list[Number(m[1]) - 1];
    if (pipe) return pipe;
  }
  return throwNotFound(`труба ${ref} не найдена (id сайта или метка TP<n> из model_get)`);
}

/** Световая линия по site-id или метке LS/SL/LL1…_n из model_get (этап 84). */
function resolveLightLine(model: Model, kind: LightKind, ref: string): LedStrip | StripLight | LineStrip {
  const label = kind === "led" ? "LS" : kind === "line" ? "LL" : "SL";
  const lines = model[LIGHT_COLLECTION_BY_KIND[kind]] ?? {};
  if (lines[ref]) return lines[ref]!;
  const m = new RegExp(`^${label}(\\d+)$`).exec(ref);
  if (m) {
    const list = Object.values(lines);
    const line = list[Number(m[1]) - 1];
    if (line) return line;
  }
  return throwNotFound(`световая линия ${ref} не найдена (id сайта или метка ${label}<n> из model_get)`);
}

const wallRef = z.string().min(1).describe("id стены сайта или метка W<n> из model_get");

const thickness = z.union([mmInt, z.object({
  top: mmInt, right: mmInt, bottom: mmInt, left: mmInt,
})]).describe("толщина в мм: одно число или {top,right,bottom,left}");

const swing = z.object({
  hinge: z.enum(["start", "end"]).describe("у какого конца оси петля"),
  into: z.enum(["left", "right"]).describe("куда открывается дверь (left — левая грань по направлению оси)"),
});

const position = z.union([
  z.object({ center: mmPoint }),
  z.object({ against_wall: z.object({
    wall_id: wallRef,
    offset_mm: mmInt.describe("смещение центра предмета от начала стены (учитывая from)"),
    from: z.enum(["start", "end"]).optional(),
    gap_mm: mm.optional().describe("зазор до внутренней грани стены (0 — вплотную, по умолчанию)"),
  }) }),
  z.object({ in_room: z.object({
    room_id: z.string().min(1).describe("метка комнаты R<n> из model_get"),
    corner: z.enum(["nw", "ne", "se", "sw", "center"]),
  }) }),
]);

export function planTools(ctx: ServerContext): Record<string, ToolDefLike> {
  const wsOf = () => ctx.workspace();

  const compactEntity = (model: Model, predicate: (c: ReturnType<typeof compactModel>) => unknown) => {
    // комнаты — из кеша workspace (нормализованная модель), если в model.rooms2 их ещё нет
    const compact = compactModel(model, wsOf().rooms());
    return { hint: SCENARIO_HINT, entity: predicate(compact) };
  };

  return {
    // ---------- Стены и помещения (§7.2) ----------
    wall_add: tool(
      "Добавить стену по осевой линии (координаты в мм; X вправо, Y вниз; толщина по умолчанию 200). " +
        "Для отдельной перегородки используйте kind=partition (тонкая, plan:c). Концы стен должны совпадать с концами соседних стен — " +
        "примыкание узла к середине стены не поддерживается (UNSUPPORTED_JUNCTION; используйте wall_split). " +
        SCENARIO_HINT,
      {
        start: mmPoint, end: mmPoint,
        thickness_mm: mmInt.optional(),
        material: z.string().optional().describe("a_block (по умолчанию), кирпич и др."),
        kind: z.enum(["initial", "partition"]).optional(),
        role: z.enum(["wall", "balcony"]).optional(),
      },
      async (a) => {
        const ws = wsOf();
        const { result: wall, warnings } = await ws.applyWalls("wall_add", (m) => addWall(m, {
          start: a["start"] as MmPoint, end: a["end"] as MmPoint,
          thicknessMm: a["thickness_mm"] as number | undefined,
          material: (a["material"] as string | undefined) ?? "a_block",
          plan: a["kind"] === "partition" ? "c" : "a",
          role: a["role"] as "wall" | "balcony" | undefined,
        }));
        return ok({ ...compactEntity(ws.model, (c) => c.walls.find((w) => w.site_id === wall.id) ?? null), ...(warnings.length ? { warnings } : {}) });
      },
    ),

    walls_add_polyline: tool(
      "Добавить ломаную из связанных стен (и замкнутый контур при closed: true). Точки в мм, узлы связываются автоматически.",
      {
        points: z.array(mmPoint).min(2),
        closed: z.boolean().optional(),
        thickness_mm: mmInt.optional(),
        material: z.string().optional(),
        kind: z.enum(["initial", "partition"]).optional(),
      },
      async (a) => {
        const ws = wsOf();
        const { result: walls, warnings } = await ws.applyWalls("walls_add_polyline", (m) => addPolyline(m, {
          points: a["points"] as MmPoint[],
          closed: a["closed"] as boolean | undefined,
          thicknessMm: a["thickness_mm"] as number | undefined,
          material: (a["material"] as string | undefined) ?? "a_block",
          plan: a["kind"] === "partition" ? "c" : "a",
        }));
        return ok({ ...compactEntity(ws.model, (c) => c.walls.filter((w) => walls.some((x) => x.id === w.site_id))), ...(warnings.length ? { warnings } : {}) });
      },
    ),

    room_add_rect: tool(
      "Добавить прямоугольную комнату. dimensions=inner (по умолчанию): width/depth — чистые внутренние размеры " +
        "(как в замерах квартиры), origin — внутренний левый верхний угол. Толщина — одно число или по сторонам. " +
        "Если сторона совпадает со стеной соседней комнаты, общая стена переиспользуется (не дублируется). " +
        "Возвращает созданные стены. После добавления комнат вызываете model_validate и render_plan.",
      {
        origin: mmPoint,
        width: mmInt.describe("мм по X"),
        depth: mmInt.describe("мм по Y"),
        wall_thickness: thickness.optional(),
        dimensions: z.enum(["inner", "axis"]).optional(),
        name: z.string().optional().describe("имя помещения (фаза 2 — сейчас игнорируется)"),
      },
      async (a) => {
        const ws = wsOf();
        void a["name"];
        const { result: walls, warnings } = await ws.applyWalls("room_add_rect", (m) => addRoomRect(m, {
          origin: a["origin"] as MmPoint,
          widthMm: a["width"] as number,
          depthMm: a["depth"] as number,
          thicknessMm: a["wall_thickness"] as number | undefined,
          dimensions: a["dimensions"] as "inner" | "axis" | undefined,
        }));
        return ok({
          ...compactEntity(ws.model, (c) => ({ walls: c.walls.filter((w) => walls.some((x) => x.id === w.site_id)), rooms: c.rooms })),
          ...(warnings.length ? { warnings } : {}),
        });
      },
    ),

    room_add_polygon: tool(
      "Добавить комнату-полигон: точки внутреннего контура по часовой стрелке (мм). Для Г- и П-образных комнат.",
      {
        points: z.array(mmPoint).min(3).describe("обход по часовой стрелке, Y вниз"),
        wall_thickness: mmInt.optional(),
        dimensions: z.enum(["inner", "axis"]).optional(),
        name: z.string().optional(),
      },
      async (a) => {
        const ws = wsOf();
        void a["name"];
        const { result: walls, warnings } = await ws.applyWalls("room_add_polygon", (m) => addRoomPolygon(m, {
          points: a["points"] as MmPoint[],
          thicknessMm: a["wall_thickness"] as number | undefined,
          dimensions: a["dimensions"] as "inner" | "axis" | undefined,
        }));
        return ok({
          ...compactEntity(ws.model, (c) => ({ walls: c.walls.filter((w) => walls.some((x) => x.id === w.site_id)), rooms: c.rooms })),
          ...(warnings.length ? { warnings } : {}),
        });
      },
    ),

    wall_update: tool(
      "Изменить стену: длину (anchor — какой конец на месте), толщину (side: both/left/right), материал или положение концов. " +
        "Перенос узла тянет связанные стены; проёмы на стене переезжают автоматически.",
      {
        wall_id: wallRef,
        length_mm: mmInt.optional(),
        anchor: z.enum(["start", "end"]).optional(),
        thickness_mm: mmInt.optional(),
        side: z.enum(["both", "left", "right"]).optional(),
        material: z.string().optional(),
        start: mmPoint.optional(),
        end: mmPoint.optional(),
      },
      async (a) => {
        const ws = wsOf();
        const { result: wall, warnings } = await ws.applyWalls("wall_update", (m) => updateWall(m, {
          wallId: resolveWall(m, a["wall_id"] as string).id,
          lengthMm: a["length_mm"] as number | undefined,
          anchor: a["anchor"] as "start" | "end" | undefined,
          thicknessMm: a["thickness_mm"] as number | undefined,
          side: a["side"] as "both" | "left" | "right" | undefined,
          material: a["material"] as string | undefined,
          start: a["start"] as MmPoint | undefined,
          end: a["end"] as MmPoint | undefined,
        }));
        return ok({ ...compactEntity(ws.model, (c) => c.walls.find((w) => w.site_id === wall.id) ?? null), ...(warnings.length ? { warnings } : {}) });
      },
    ),

    wall_move: tool(
      "Параллельно перенести стену на offset_mm перпендикулярно (вправо от направления p1→p2 — положительное). " +
        "Соседние стены удлиняются/укорачиваются сами. Проёмы едут вместе со стеной.",
      { wall_id: wallRef, offset_mm: mm.describe("мм; + вправо от оси, − влево") },
      async (a) => {
        const ws = wsOf();
        const { result: wall, warnings } = await ws.applyWalls("wall_move", (m) => moveWall(m, {
          wallId: resolveWall(m, a["wall_id"] as string).id,
          offsetMm: a["offset_mm"] as number,
        }));
        return ok({ ...compactEntity(ws.model, (c) => c.walls.find((w) => w.site_id === wall.id) ?? null), ...(warnings.length ? { warnings } : {}) });
      },
    ),

    wall_split: tool(
      "Разрезать стену на две в точке at_mm от начала оси (нужно для Т-примыканий: разрежьте стену и приведите конец новой стены к точке разреза). " +
        "Разрез через проём запрещён (GEOMETRY_CONFLICT).",
      { wall_id: wallRef, at_mm: mmInt },
      async (a) => {
        const ws = wsOf();
        const { result: parts, warnings } = await ws.applyWalls("wall_split", (m) => splitWall(m, resolveWall(m, a["wall_id"] as string).id, a["at_mm"] as number));
        const ids = [parts.first.id, parts.second.id];
        return ok({ ...compactEntity(ws.model, (c) => c.walls.filter((w) => ids.includes(w.site_id))), ...(warnings.length ? { warnings } : {}) });
      },
    ),

    wall_delete: tool(
      "Удалить стену вместе с её проёмами (в ответе — число удалённых проёмов). Связанные стены теряют связь в узле.",
      { wall_id: wallRef },
      async (a) => {
        const ws = wsOf();
        const { result: res, warnings } = await ws.applyWalls("wall_delete", (m) => deleteWall(m, resolveWall(m, a["wall_id"] as string).id));
        return ok({ ...res, hint: SCENARIO_HINT, ...(warnings.length ? { warnings } : {}) });
      },
    ),

    rooms_list: tool(
      "Список комнат с площадями (по внутренним граням, как показывает редактор), периметром и именами. " +
        "Комнаты считает редактор (rooms2 нормализованной модели). Если модель ещё не нормализовалась " +
        "(нет редактора) — список пуст: добавьте комнату и сохраните.",
      {},
      async () => {
        const ws = wsOf();
        return ok(compactModel(ws.model, ws.rooms()).rooms);
      },
    ),

    project_set_height: tool(
      "Общая высота стен и потолков проекта (мм, по умолчанию 2700).",
      { height_mm: mmInt },
      async (a) => {
        const ws = wsOf();
        ws.apply("project_set_height", (m) => { m["total_height"] = (a["height_mm"] as number) / 10; return true; });
        return ok({ height_mm: a["height_mm"], hint: SCENARIO_HINT });
      },
    ),

    // ---------- Проёмы (§7.3) ----------
    opening_add: tool(
      "Добавить проём на стену. Двери (пункты меню «Двери и проемы»): doorway (Проем без двери 80×210), " +
        "door (Дверь стандартная 80×210), door_double (Дверь 2-створчатая 120), door_coupe (Дверь-купе сдвижная 80), " +
        "door_coupe_double (Дверь-купе 2-створчатая 160), door_penal (Дверь-пенал раздвижная 80), " +
        "door_penal_double (Дверь-пенал 2-створчатая 160), door_roto (Рото-дверь 80), door_roto_double (Рото-дверь 160), " +
        "door_book (Дверь-книжка 80), door_book_double (Дверь-книжка 160), door_bellows (Дверь-гармошка 120), " +
        "door_glass (Стеклянная дверь 80), door_garage (Гаражные ворота 300×225), " +
        "door_system_x2/x3/x4 (Каскадная система 2/3/4-створчатая 160/240/320), " +
        "door_system_penal_x2/x3/x4 (Раздвижная система 2/3/4-створчатая 160/240/320). " +
        "Пункты меню «Двери-купе 2/3/4-дверные» (doors_coupe_2x/3x/4x), «Домофон» (door_remote) и «Видеодомофон» " +
        "(door_videoremote) — предметы каталога, ставятся item_add, а не opening_add. " +
        "Окна (пункты меню «Окна»): windowway (Проем без окна 120×150), window (Стандартное окно 120×150, подоконник 85), " +
        "window_balcony (Балконный блок 180: окно+дверь, параметры window_*_mm/door_*_mm/door_position), " +
        "window_door (Балконная дверь 80×225), french_window (Французское окно распашное 120×250), " +
        "french_window_coupe (Французское окно раздвижное 120×250), french_window_double (Французское окно 4-створчатое 180×250). " +
        "Положение: offset_mm + from (смещение края проёма от угла комнаты; from=end — от противоположного конца) " +
        "или center_mm (центр от начала оси стены). Размеры в мм; двери: swing (сторона петель/открывания), " +
        "casing (короб с наличниками; по умолчанию включён, у doorway и door_garage выключен); " +
        "окна: sill_height_mm (подоконник), casements (створки), slope_angle_deg (угол рассвета), " +
        "sill_thickness_mm/sill_overhang_mm/sill_overmeasure_mm (подоконник). " +
        "Параметры применяются строго по типу: sill_height_mm и sill-параметры — только окна, " +
        "части балконного блока (window_*_mm, door_*_mm, door_position) — только window_balcony, " +
        "impost_height_mm — только window_door, casements у французских окон не принимается; " +
        "door_position поддерживает только left (редактор сохраняет лишь левую дверь). " +
        "Ширина/высота проверяются по лимитам типа из панели редактора. " +
        "Проём должен целиком помещаться на стене и не пересекать другие проёмы и примыкания стен (GEOMETRY_CONFLICT).",
      {
        wall_id: wallRef,
        type: z.string().refine((t) => t in OPENING_KINDS, { message: "неизвестный тип проёма" })
          .describe(`door, door_double, doorway, door_coupe, door_penal, door_roto, door_book, door_bellows, door_glass, door_garage, door_system_*, window, windowway, window_balcony, window_door, french_window, french_window_coupe, french_window_double (всего ${Object.keys(OPENING_KINDS).length} типов)`),
        offset_mm: mmInt.optional(),
        from: z.enum(["start", "end"]).optional(),
        center_mm: mmInt.optional(),
        width_mm: mmInt.optional(),
        height_mm: mmInt.optional(),
        sill_height_mm: mmInt.optional().describe("окна: высота подоконника над полом"),
        swing: swing.optional().describe("двери: петля и сторона открывания"),
        casing: z.boolean().optional().describe("короб с наличниками (двери и окна); по умолчанию включён, у doorway и door_garage выключен"),
        casements: z.number().int().min(0).max(6).optional().describe("окна и двери: число створок (кроме французских окон)"),
        slope_angle_deg: z.number().min(0).max(45).optional().describe("окна: угол рассвета (откосов), градусы"),
        sill_thickness_mm: mmInt.optional().describe("окна: толщина подоконника"),
        sill_overhang_mm: mmInt.optional().describe("окна: вылет подоконника"),
        sill_overmeasure_mm: mmInt.optional().describe("окна: выпуски подоконника вбок"),
        window_width_mm: mmInt.optional().describe("только балконный блок (window_balcony): ширина окна (итог = окно + дверь, обе > 0)"),
        window_height_mm: mmInt.optional().describe("только балконный блок: высота окна"),
        door_width_mm: mmInt.optional().describe("только балконный блок: ширина двери (итог = окно + дверь, обе > 0)"),
        door_height_mm: mmInt.optional().describe("только балконный блок: высота двери"),
        door_position: z.enum(["left", "right"]).optional()
          .describe("только балконный блок: сторона двери; поддерживается только left — right вернёт INVALID_ARGUMENT"),
        impost_height_mm: mmInt.optional().describe("только балконная дверь (window_door): высота импоста от пола, в пределах высоты двери"),
      },
      async (a) => {
        const ws = wsOf();
        const hole = ws.apply("opening_add", (m) => addOpening(m, {
          wallId: resolveWall(m, a["wall_id"] as string).id,
          type: a["type"] as string,
          offsetMm: a["offset_mm"] as number | undefined,
          from: a["from"] as "start" | "end" | undefined,
          centerMm: a["center_mm"] as number | undefined,
          widthMm: a["width_mm"] as number | undefined,
          heightMm: a["height_mm"] as number | undefined,
          sillHeightMm: a["sill_height_mm"] as number | undefined,
          swing: a["swing"] as { hinge: "start" | "end"; into: "left" | "right" } | undefined,
          casing: a["casing"] as boolean | undefined,
          casements: a["casements"] as number | undefined,
          slopeAngleDeg: a["slope_angle_deg"] as number | undefined,
          sillThicknessMm: a["sill_thickness_mm"] as number | undefined,
          sillOverhangMm: a["sill_overhang_mm"] as number | undefined,
          sillOvermeasureMm: a["sill_overmeasure_mm"] as number | undefined,
          windowWidthMm: a["window_width_mm"] as number | undefined,
          windowHeightMm: a["window_height_mm"] as number | undefined,
          doorWidthMm: a["door_width_mm"] as number | undefined,
          doorHeightMm: a["door_height_mm"] as number | undefined,
          doorPosition: a["door_position"] as "left" | "right" | undefined,
          impostHeightMm: a["impost_height_mm"] as number | undefined,
        }));
        return ok(compactEntity(ws.model, (c) =>
          c.walls.flatMap((w) => w.openings).find((o) => o.id === hole.id) ?? { id: hole.id, type: hole.type }));
      },
    ),

    opening_update: tool(
      "Изменить проём: размеры, положение (offset_mm/from или center_mm), сторону открывания (swing), " +
        "короб с наличниками (casing); у окон — подоконник, створки, угол рассвета; у балконного блока — " +
        "window_*_mm/door_*_mm/door_position, у балконной двери impost_height_mm. " +
        "Параметры применяются строго по типу проёма: sill_height_mm и sill-параметры — только окна, " +
        "части балконного блока — только window_balcony, impost_height_mm — только window_door, " +
        "casements у французских окон не принимается, door_position — только left; " +
        "ширина/высота проверяются по лимитам типа из панели редактора. " +
        "Смена типа не поддерживается: переданный type, отличный от текущего, вернёт INVALID_ARGUMENT — " +
        "удалите проём (opening_delete) и добавьте новый (opening_add) с нужным типом; передача текущего типа — no-op. " +
        "Поля не указанные — не меняются. opening_id — id проёма (site_id) из model_get.",
      {
        opening_id: z.string().min(1).describe("id проёма из model_get (поле id у openings)"),
        wall_id: wallRef.optional().describe("если известен; иначе находится автоматически"),
        type: z.string().refine((t) => t in OPENING_KINDS || t in KIND_BY_HOLE_TYPE).optional()
          .describe("передача текущего типа проёма допустима (no-op); смена типа не поддерживается — удалите проём (opening_delete) и добавьте новый (opening_add)"),
        offset_mm: mmInt.optional(),
        from: z.enum(["start", "end"]).optional(),
        center_mm: mmInt.optional(),
        width_mm: mmInt.optional(),
        height_mm: mmInt.optional(),
        sill_height_mm: mmInt.optional(),
        swing: swing.optional(),
        casing: z.boolean().optional().describe("короб с наличниками (двери и окна)"),
        casements: z.number().int().min(0).max(6).optional().describe("окна и двери: число створок (кроме французских окон)"),
        slope_angle_deg: z.number().min(0).max(45).optional().describe("окна: угол рассвета, градусы"),
        sill_thickness_mm: mmInt.optional(),
        sill_overhang_mm: mmInt.optional(),
        sill_overmeasure_mm: mmInt.optional(),
        window_width_mm: mmInt.optional().describe("только балконный блок: ширина окна (итог = окно + дверь, обе > 0)"),
        window_height_mm: mmInt.optional().describe("только балконный блок: высота окна"),
        door_width_mm: mmInt.optional().describe("только балконный блок: ширина двери (итог = окно + дверь, обе > 0)"),
        door_height_mm: mmInt.optional().describe("только балконный блок: высота двери"),
        door_position: z.enum(["left", "right"]).optional()
          .describe("только балконный блок: сторона двери; поддерживается только left — right вернёт INVALID_ARGUMENT"),
        impost_height_mm: mmInt.optional().describe("только балконная дверь (window_door): высота импоста от пола, в пределах высоты двери"),
      },
      async (a) => {
        const ws = wsOf();
        const openingId = a["opening_id"] as string;
        const hole = ws.apply("opening_update", (m) => {
          let wallId = a["wall_id"] as string | undefined;
          if (!wallId) {
            const found = Object.values(m.walls).find((w) => (w.holes ?? {})[openingId]);
            if (!found) throwNotFound(`проём ${openingId} не найден ни на одной стене`);
            wallId = found.id;
          }
          return updateOpening(m, {
            wallId: resolveWall(m, wallId).id,
            holeId: openingId,
            type: a["type"] as string | undefined,
            offsetMm: a["offset_mm"] as number | undefined,
            from: a["from"] as "start" | "end" | undefined,
            centerMm: a["center_mm"] as number | undefined,
            widthMm: a["width_mm"] as number | undefined,
            heightMm: a["height_mm"] as number | undefined,
            sillHeightMm: a["sill_height_mm"] as number | undefined,
            swing: a["swing"] as { hinge: "start" | "end"; into: "left" | "right" } | undefined,
            casing: a["casing"] as boolean | undefined,
            casements: a["casements"] as number | undefined,
            slopeAngleDeg: a["slope_angle_deg"] as number | undefined,
            sillThicknessMm: a["sill_thickness_mm"] as number | undefined,
            sillOverhangMm: a["sill_overhang_mm"] as number | undefined,
            sillOvermeasureMm: a["sill_overmeasure_mm"] as number | undefined,
            windowWidthMm: a["window_width_mm"] as number | undefined,
            windowHeightMm: a["window_height_mm"] as number | undefined,
            doorWidthMm: a["door_width_mm"] as number | undefined,
            doorHeightMm: a["door_height_mm"] as number | undefined,
            doorPosition: a["door_position"] as "left" | "right" | undefined,
            impostHeightMm: a["impost_height_mm"] as number | undefined,
          });
        });
        return ok(compactEntity(ws.model, (c) =>
          c.walls.flatMap((w) => w.openings).find((o) => o.id === hole.id) ?? null));
      },
    ),

    opening_delete: tool(
      "Удалить проём (дверь/окно) со стены.",
      { opening_id: z.string().min(1) },
      async (a) => {
        const ws = wsOf();
        const openingId = a["opening_id"] as string;
        ws.apply("opening_delete", (m) => {
          const found = Object.values(m.walls).find((w) => (w.holes ?? {})[openingId]);
          if (!found) throwNotFound(`проём ${openingId} не найден`);
          deleteOpening(m, found.id, openingId);
          return true;
        });
        return ok({ deleted: openingId, hint: SCENARIO_HINT });
      },
    ),

    // ---------- Каталог и предметы (§7.4) ----------
    catalog_search: tool(
      "Поиск по каталогу мебели/сантехники remplanner (русский или английский запрос; ё=е, регистр не важен). " +
        "Возвращает name (точное имя для item_add), title, размеры в мм, resizable. Примеры запросов: «диван», «унитаз», «кровать», «лестница», «стояк». " +
        "Лестницы — группа stairs (21 позиция меню «Лестницы»: ladder_march, spiral_staircase, …) — это предметы каталога, ставятся item_add, а не отдельная сущность. " +
        "«Коммуникации» (меню на исходном плане) — тоже предметы каталога: стояки water, water_column_hot, water_column_cold, drainage_column, " +
        "вентиляция air, отопление radiator_old, heat_pipe, газ gas_pipe, gas_boiler, gas_meter, пожарный датчик fire_detector и др.; " +
        "исключения — линии-графы: газовая линия gas_line (gas_line_add) и трубы водоснабжения water_pipe, water_hot_pipe, drainage_pipe (pipe_add). " +
        "Сантехника — группа santeh_furniture (140 позиций листа «Сантехника»: ванны, унитазы, раковины, душевые, бойлеры — plan santeh, item_add). " +
        "Точки воды — группа waterspots (лист «Водоснабжение»): комбинированные выводы waterspot_cold_hot, waterspot_drainage_cold, " +
        "waterspot_drainage_hot, waterspot_drainage_cold_hot — предметы каталога (item_add, высота вывода по умолчанию 500 мм от пола); " +
        "одиночные waterspot_cold/hot/drainage и коллектор waterspot_collector — PRO; подключение труб к выводам — pipe_add. " +
        "Освещение — группа lights (лист «Освещение», 49 позиций: люстры chandelier*, светильники lightspot*, бра bra*, настенные wall_*, " +
        "лампы led_lamp и др.) — предметы каталога, ставятся item_add; потолочные — свободно (центр комнаты — in_room center), " +
        "настенные (bra, led_lamp, wall_spot, …) — только against_wall. Исключения-линии: led_strip (led_strip_add), " +
        "recessed_strip/surface_stripe/pendent_strip (stripe_add), line_light (line_light_add); трековые споты " +
        "track_spot/track_pendent_spot/track_panel_spot/track_line_spot ставятся на шину (MCP пока не поддерживает). " +
        "Меню «Терраса и участок» (исходный план): террасная мебель — предметы каталога; контуры террасы/участка, " +
        "ограждение и опорный столб — отдельные сущности (terrace_add, terrace_fence_add, terrace_column_add, territory_add); " +
        "«Террасная доска» — покрытие листа «Полы» (не предмет).",
      {
        query: z.string().min(1),
        group: z.string().optional().describe("furniture, santeh_furniture, lights, stairs, sockets, …"),
        sheet: z.string().optional().describe("лист: furniture, santeh, …"),
        limit: mmInt.optional().describe("сколько позиций (по умолчанию 20)"),
      },
      async (a) => {
        const tools = await ctx.tools();
        const { searchTools: search } = await import("../catalog.ts");
        const found = search(tools, a["query"] as string, {
          group: a["group"] as string | undefined,
          sheet: a["sheet"] as string | undefined,
          limit: (a["limit"] as number | undefined) ?? 20,
        });
        return ok(found.map((t) => ({
          name: t.name, title: t.title, group: t.group,
          width_mm: t.width * 10, depth_mm: t.height * 10, height_mm: t.self_height * 10,
          resizable: t.resizable ?? false,
        })));
      },
    ),

    catalog_get: tool(
      "Все параметры позиции каталога по точному name (из catalog_search).",
      { name: z.string().min(1) },
      async (a) => {
        const entry = await ctx.toolEntry(a["name"] as string);
        return ok({
          name: entry.name, title: entry.title, group: entry.group, subgroup: entry.subgroup ?? null,
          width_mm: entry.width * 10, depth_mm: entry.height * 10, height_mm: entry.self_height * 10,
          resizable: entry.resizable ?? false, anchor: entry.anchor ?? null,
          magnetized: entry.is_magnetized ?? false, can_be_outside: entry.can_be_outside ?? false,
        });
      },
    ),

    item_add: tool(
      "Поставить предмет из каталога (name — точное имя из catalog_search). Позиция: center (координаты в мм, точка внутри комнаты) " +
        "ИЛИ against_wall (у стены, вплотную к внутренней грани при gap_mm=0) ИЛИ in_room (угол комнаты R<n>). " +
        "Точка вне помещений → OUTSIDE_ROOM. Размеры берутся из каталога; width_mm/depth_mm/height_mm переопределяют (если resizable). " +
        "Лестницы (меню «Лестницы»: ladder_march, ladder_console, ladder_2march, ladder_2march-fan, ladder_2march_console-fan, " +
        "ladder_2march_console, ladder_trapeze, rounded_staircase, ladder_march_double, ladder_fan_2march, ladder_3march, ladder_3march_fan, " +
        "spiral_staircase, upper_march, ladder_circle, porch, attic_staircase, step_ladder, escalator, elevator, floor_hatch) — " +
        "предметы каталога, а не отдельная сущность; марши/ступени/ограждение в модель не пишутся (отрисовка вида). " +
        "Как в UI, план предмета получает видимость на исходном плане (a:1). У stair_spot над полом 20 см — передайте elevation_mm=200. " +
        "porch и stair_spot в редакторе ставятся только у стены — используйте against_wall. " +
        "Раздел «Коммуникации» (исходный план): стояки водоснабжения/канализации water, water_column_hot, water_column_cold, drainage_column, " +
        "вентиляционный короб air, радиатор radiator_old, стояк отопления heat_pipe, газовый стояк gas_pipe, колонка gas_boiler, счётчик gas_meter, " +
        "пожарный датчик fire_detector — предметы каталога (ставятся item_add, размеры из каталога). " +
        "У ceiling_water (ввод водоснабжения) и conditioner_cage (корзина кондиционера) постановка только у стены — against_wall. " +
        "Сантехника (лист «Сантехника», группа santeh_furniture — ванны, унитазы, раковины, душевые, полотенцесушители, бойлеры) и " +
        "точки воды (лист «Водоснабжение», группа waterspots — комбинированные выводы waterspot_cold_hot, waterspot_drainage_cold, " +
        "waterspot_drainage_hot, waterspot_drainage_cold_hot) — предметы каталога; у точек воды высота вывода по умолчанию 500 мм " +
        "(elevation_mm переопределяет); одиночные waterspot_cold/hot/drainage и коллектор waterspot_collector — PRO-функция. " +
        "Линии-графы — НЕ предметы: газовая линия gas_line → gas_line_add, трубы водоснабжения " +
        "water_pipe/water_hot_pipe/drainage_pipe → pipe_add, световые линии листа «Освещение» led_strip → led_strip_add, " +
        "recessed_strip/surface_stripe/pendent_strip → stripe_add, line_light → line_light_add. " +
        "Освещение (лист «Освещение», группа lights — 40 предметов из 49; остальные 5 — световые линии " +
        "(led_strip/recessed_strip/surface_stripe/pendent_strip/line_light) и 4 — трековые споты track_spot/track_pendent_spot/" +
        "track_panel_spot/track_line_spot на шину, оба вида не item_add): люстры chandelier, hanging_chandelier, потолочные " +
        "светильники lightspot, lightspot_surface, подвесные hanging_light*, рейлинговые track_single/double/triple, " +
        "светильник Армстронг armstrong_light, бра bra, bra_shades, лампы led_lamp, light_stick, настенные wall_spot, wall_lamp, " +
        "подсветка для картин painting_lighting и др. — предметы каталога (item_add, размеры/высота из каталога). " +
        "Потолочные ставятся свободно (in_room center — «люстра по центру комнаты»), настенные (bra, led_lamp, wall_spot, " +
        "wall_lamp, painting_lighting, light_stick) — только against_wall, высота по умолчанию 140 см из каталога (elevation_mm переопределяет). " +
        "Трековые споты track_spot/track_pendent_spot/track_panel_spot/track_line_spot ставятся НА трековую шину — " +
        "MCP пока не поддерживает подключение к шине. " +
        "Электрика (листы «Розетки» и «Выключатели», этап 88): пристенные розетки socket, socket_ip44, socket_power, " +
        "socket_380, socket_tv, socket_usb, socket_hdmi, socket_phone, socket_audio, socket_ip (поз. PRO: floor_socket, " +
        "ceiling_socket, furniture_socket) и выключатели light_switch, light_switch_double (поз. PRO: light_switch_triple, " +
        "light_dimmer, light_switch_through, light_switch_through_double, light_switch_cross, light_switch_cross_double, " +
        "light_switch_master) — предметы каталога item_add у стены (against_wall; высота установки по умолчанию 30 см у " +
        "розеток и 90 см у выключателей из каталога, elevation_mm переопределяет). Редактор пишет их группой " +
        "socket_group (одна под-розетка) — model_get показывает items[] с socket_group[]. Группа розеток — несколько " +
        "под-розеток на одной пластине (как клик рядом в редакторе) — пока одиночными item_add. " +
        "Связь «выключатель → светильник» — cable_add (выключатель item_add, светильник item_add, затем cable_add); " +
        "cable (Соединительная линия) — не item_add. Потолочная ceiling_socket и напольная floor_socket розетки ставятся " +
        "свободно (center/in_room). Выводы проводов (wire*, группа wires) и электрощит — отдельные этапы. " +
        "Меню «Терраса и участок»: диваны terrace-серии (sofa_pottery_barn_malibu_wicker, sofa_coup_detat_campanha, " +
        "armchair_solana_papasan) — предметы каталога (item_add, план furniture); сами терраса/ограждение/столб — " +
        "отдельные сущности (terrace_add, terrace_fence_add, terrace_column_add), «Террасная доска» terrace_board — " +
        "покрытие листа «Полы» (MCP пока не покрывает).",
      {
        name: z.string().min(1).describe("точное имя позиции каталога"),
        position,
        angle_deg: mm.optional().describe("поворот в градусах, по часовой стрелке"),
        width_mm: mmInt.optional(),
        depth_mm: mmInt.optional(),
        height_mm: mmInt.optional(),
        elevation_mm: mmInt.optional().describe("подъём над полом (настенные полки, ТВ)"),
      },
      async (a) => {
        const ws = wsOf();
        const entry = await ctx.toolEntry(a["name"] as string);
        const item = ws.apply("item_add", (m) => addItem(m, {
          name: entry.name,
          position: normalizePosition(a["position"] as Record<string, unknown>, m, ws.rooms()),
          angleDeg: a["angle_deg"] as number | undefined,
          widthMm: a["width_mm"] as number | undefined,
          depthMm: a["depth_mm"] as number | undefined,
          heightMm: a["height_mm"] as number | undefined,
          elevationMm: a["elevation_mm"] as number | undefined,
          catalogEntry: entry,
        }, ws.rooms()));
        return ok(compactEntity(ws.model, (c) => c.items.find((i) => i.name === item.name) ?? null));
      },
    ),

    item_update: tool(
      "Изменить предмет: переместить (center или against_wall), повернуть (angle_deg), изменить размеры.",
      {
        item_id: z.string().min(1).describe("метка I<n> из model_get или id сайта"),
        position: z.union([
          z.object({ center: mmPoint }),
          z.object({ against_wall: z.object({
            wall_id: wallRef, offset_mm: mmInt, from: z.enum(["start", "end"]).optional(), gap_mm: mm.optional(),
          }) }),
        ]).optional(),
        angle_deg: mm.optional(),
        width_mm: mmInt.optional(),
        depth_mm: mmInt.optional(),
        height_mm: mmInt.optional(),
        elevation_mm: mmInt.optional(),
      },
      async (a) => {
        const ws = wsOf();
        const item = ws.apply("item_update", (m) => {
          const target = resolveItem(m, a["item_id"] as string);
          const pos = a["position"] as Record<string, unknown> | undefined;
          if (pos && "center" in pos) {
            return updateItem(m, { itemId: target.id, center: pos["center"] as MmPoint,
              angleDeg: a["angle_deg"] as number | undefined,
              widthMm: a["width_mm"] as number | undefined, depthMm: a["depth_mm"] as number | undefined,
              heightMm: a["height_mm"] as number | undefined, elevationMm: a["elevation_mm"] as number | undefined });
          }
          if (pos && "against_wall" in pos) {
            // перенос к стене: считаем точку и двигаем как center
            const aw = pos["against_wall"] as { wall_id: string; offset_mm: number; from?: "start" | "end"; gap_mm?: number };
            const wall = resolveWall(m, aw.wall_id);
            const len = wallLengthMm(wall);
            const off = aw.from === "end" ? len - aw.offset_mm : aw.offset_mm;
            const t = Math.min(Math.max(off / len, 0), 1);
            const px = wall.p1.x + (wall.p2.x - wall.p1.x) * t;
            const py = wall.p1.y + (wall.p2.y - wall.p1.y) * t;
            const dirx = (wall.p2.x - wall.p1.x) / len;
            const diry = (wall.p2.y - wall.p1.y) / len;
            const angleDeg = Math.atan2(diry, dirx) * 180 / Math.PI;
            // нормаль в сторону комнаты подберёт gap при updateItem? — упрощённо: центр на оси + gap по нормали вправо
            const gap = (aw.gap_mm ?? 0) / 10 + target.height / 2;
            return updateItem(m, {
              itemId: target.id,
              center: { x: Math.round((px + diry * gap) * 10), y: Math.round((py - dirx * gap) * 10) },
              angleDeg: a["angle_deg"] as number | undefined ?? Math.round(angleDeg),
              widthMm: a["width_mm"] as number | undefined, depthMm: a["depth_mm"] as number | undefined,
              heightMm: a["height_mm"] as number | undefined, elevationMm: a["elevation_mm"] as number | undefined,
            });
          }
          return updateItem(m, {
            itemId: target.id,
            angleDeg: a["angle_deg"] as number | undefined,
            widthMm: a["width_mm"] as number | undefined, depthMm: a["depth_mm"] as number | undefined,
            heightMm: a["height_mm"] as number | undefined, elevationMm: a["elevation_mm"] as number | undefined,
          });
        });
        return ok(compactEntity(ws.model, (c) => c.items.find((i) => i.name === item.name) ?? null));
      },
    ),

    item_delete: tool(
      "Удалить предмет (метка I<n> из model_get).",
      { item_id: z.string().min(1) },
      async (a) => {
        const ws = wsOf();
        ws.apply("item_delete", (m) => {
          const target = resolveItem(m, a["item_id"] as string);
          deleteItem(m, target.id);
          return true;
        });
        return ok({ deleted: a["item_id"], hint: SCENARIO_HINT });
      },
    ),

    items_list: tool(
      "Список предметов (все или в конкретной комнате).",
      { room_id: z.string().optional().describe("метка комнаты R<n> — предметы только этой комнаты") },
      async (a) => {
        const ws = wsOf();
        const compact = compactModel(ws.model, ws.rooms());
        if (!a["room_id"]) return ok(compact.items);
        const roomId = a["room_id"] as string;
        const room = compact.rooms.find((r) => r.id === roomId);
        if (!room) throwNotFound(`комната ${roomId} не найдена`);
        const inRoom = itemsInRoom(ws.model, ws.rooms(), compact.rooms.indexOf(room));
        return ok(compact.items.filter((_, i) => inRoom.has(i)));
      },
    ),

    // ---------- Колонны (пункт меню «Несущая колонна», этап 41) ----------
    pillar_add: tool(
      "Поставить несущую колонну (пункт меню «Несущая колонна»): прямоугольник 20×20 см по умолчанию, " +
        "центр в мм. Колонна ставится внутри комнаты или вплотную к грани стены (как в UI); " +
        "пересекать стены и другие колонны нельзя (касание грани стены разрешено; если колонна в 30 мм " +
        "от грани стены — прижимается к ней, как в UI). " +
        "Габариты 100..20000 × 100..6000 мм (лимиты панели редактора). Колонна вырезает площадь из комнаты " +
        "редактора (комната пересчитается при сохранении; имя и отделка комнат переживают сохранение — живая проба 43). После добавления вызывайте model_validate и project_save.",
      {
        center: mmPoint.describe("центр колонны, мм"),
        width_mm: mmInt.optional().describe("габарит по X (по умолчанию 200)"),
        height_mm: mmInt.optional().describe("габарит по Y (по умолчанию 200)"),
        angle_deg: mm.optional().describe("поворот в градусах, по часовой стрелке (по умолчанию 0)"),
      },
      async (a) => {
        const ws = wsOf();
        const pillar = ws.apply("pillar_add", (m) => addPillar(m, {
          center: a["center"] as MmPoint,
          widthMm: a["width_mm"] as number | undefined,
          heightMm: a["height_mm"] as number | undefined,
          angleDeg: a["angle_deg"] as number | undefined,
        }, ws.rooms()));
        return ok(compactEntity(ws.model, (c) => c.pillars.find((p) => p.site_id === pillar.id) ?? null));
      },
    ),

    pillar_update: tool(
      "Изменить несущую колонну: переместить (center, мм), изменить габариты (width_mm/height_mm) или поворот " +
        "(angle_deg). Правила те же: внутри комнаты, без пересечения стен и колонн; мм→см только для явно " +
        "переданных значений. pillar_id — id колонны (site_id) или метка P<n> из model_get.",
      {
        pillar_id: z.string().min(1).describe("метка P<n> из model_get или id сайта"),
        center: mmPoint.optional().describe("новый центр, мм"),
        width_mm: mmInt.optional(),
        height_mm: mmInt.optional(),
        angle_deg: mm.optional(),
      },
      async (a) => {
        const ws = wsOf();
        const pillar = ws.apply("pillar_update", (m) => updatePillar(m, {
          pillarId: resolvePillar(m, a["pillar_id"] as string).id,
          center: a["center"] as MmPoint | undefined,
          widthMm: a["width_mm"] as number | undefined,
          heightMm: a["height_mm"] as number | undefined,
          angleDeg: a["angle_deg"] as number | undefined,
        }, ws.rooms()));
        return ok(compactEntity(ws.model, (c) => c.pillars.find((p) => p.site_id === pillar.id) ?? null));
      },
    ),

    pillar_delete: tool(
      "Удалить несущую колонну (метка P<n> из model_get).",
      { pillar_id: z.string().min(1).describe("метка P<n> из model_get или id сайта") },
      async (a) => {
        const ws = wsOf();
        ws.apply("pillar_delete", (m) => {
          deletePillar(m, resolvePillar(m, a["pillar_id"] as string).id);
          return true;
        });
        return ok({ deleted: a["pillar_id"], hint: SCENARIO_HINT });
      },
    ),

    // ---------- Потолочные ригели (пункт меню «Потолочный ригель», этап 47) ----------
    rigel_add: tool(
      "Поставить потолочный ригель (пункт меню «Потолочный ригель»): балка-прямоугольник на плане " +
        "от точки start до точки end (ось, мм). Толщина depth_mm (по умолчанию 300, лимиты " +
        "100..1000 мм) и высота height_mm — опускание от потолка (по умолчанию 300, 100..1000 мм, " +
        "лимиты панели редактора). Концы оси на расстоянии до 30 мм от грани стены, колонны или " +
        "другого ригеля прилипают к ней (конец срезается по линии грани, как в UI). Ригель не " +
        "влияет на комнаты и площадь. После добавления вызывайте model_validate и project_save.",
      {
        start: mmPoint.describe("начало оси ригеля, мм"),
        end: mmPoint.describe("конец оси ригеля, мм"),
        depth_mm: mmInt.optional().describe("толщина на плане, мм (по умолчанию 300)"),
        height_mm: mmInt.optional().describe("опускание от потолка, мм (по умолчанию 300)"),
        ceiling_type: z.enum([...RIGEL_CEILING_TYPES, ""]).optional()
          .describe("тип отделки потолка: \"\" — без отделки или ключ инструмента листа потолка " +
            "(stretch_ceiling, paint_ceiling, gypsum_ceiling и др. — группа ceiling_elements редактора); " +
            "произвольные значения не принимаются"),
      },
      async (a) => {
        const ws = wsOf();
        const rigel = ws.apply("rigel_add", (m) => addRigel(m, {
          start: a["start"] as MmPoint,
          end: a["end"] as MmPoint,
          depthMm: a["depth_mm"] as number | undefined,
          heightMm: a["height_mm"] as number | undefined,
          ceilingType: a["ceiling_type"] as string | undefined,
        }));
        return ok(compactEntity(ws.model, (c) => c.rigels.find((r) => r.site_id === rigel.id) ?? null));
      },
    ),

    rigel_update: tool(
      "Изменить потолочный ригель: переместить ось (start/end, мм), изменить толщину (depth_mm), " +
        "высоту (height_mm) или тип отделки (ceiling_type). Мм→см только для явно переданных " +
        "значений. rigel_id — id ригеля (site_id) или метка B<n> из model_get.",
      {
        rigel_id: z.string().min(1).describe("метка B<n> из model_get или id сайта"),
        start: mmPoint.optional().describe("новое начало оси, мм"),
        end: mmPoint.optional().describe("новый конец оси, мм"),
        depth_mm: mmInt.optional(),
        height_mm: mmInt.optional(),
        ceiling_type: z.enum([...RIGEL_CEILING_TYPES, ""]).optional(),
      },
      async (a) => {
        const ws = wsOf();
        const rigel = ws.apply("rigel_update", (m) => updateRigel(m, {
          rigelId: resolveRigel(m, a["rigel_id"] as string).id,
          start: a["start"] as MmPoint | undefined,
          end: a["end"] as MmPoint | undefined,
          depthMm: a["depth_mm"] as number | undefined,
          heightMm: a["height_mm"] as number | undefined,
          ceilingType: a["ceiling_type"] as string | undefined,
        }));
        return ok(compactEntity(ws.model, (c) => c.rigels.find((r) => r.site_id === rigel.id) ?? null));
      },
    ),

    rigel_delete: tool(
      "Удалить потолочный ригель (метка B<n> из model_get).",
      { rigel_id: z.string().min(1).describe("метка B<n> из model_get или id сайта") },
      async (a) => {
        const ws = wsOf();
        ws.apply("rigel_delete", (m) => {
          deleteRigel(m, resolveRigel(m, a["rigel_id"] as string).id);
          return true;
        });
        return ok({ deleted: a["rigel_id"], hint: SCENARIO_HINT });
      },
    ),

    // ---------- Газовая линия (пункт меню «Коммуникации», §7.4, этап 57) ----------
    gas_line_add: tool(
      "Поставить газовую линию (пункт меню «Коммуникации» → «Газовый трубопровод»): труба-отрезок " +
        "от точки start до точки end (мм, коллекция pipes_gas — отдельная сущность, не item_add). " +
        "Длина в модели — в метрах, пересчитывается автоматически. Лимитов нет (кроме конечных " +
        "координат). После добавления вызывайте model_validate и project_save.",
      {
        start: mmPoint.describe("начало газовой линии, мм"),
        end: mmPoint.describe("конец газовой линии, мм"),
      },
      async (a) => {
        const ws = wsOf();
        const line = ws.apply("gas_line_add", (m) => addGasLine(m, {
          start: a["start"] as MmPoint,
          end: a["end"] as MmPoint,
        }));
        return ok(compactEntity(ws.model, (c) => c.gas_lines.find((g) => g.site_id === line.id) ?? null));
      },
    ),

    gas_line_update: tool(
      "Изменить газовую линию: переместить начало (start) или конец (end), мм. Мм→см только " +
        "для явно переданных значений. gas_line_id — id линии (site_id) или метка G<n> из model_get.",
      {
        gas_line_id: z.string().min(1).describe("метка G<n> из model_get или id сайта"),
        start: mmPoint.optional().describe("новое начало линии, мм"),
        end: mmPoint.optional().describe("новый конец линии, мм"),
      },
      async (a) => {
        const ws = wsOf();
        const line = ws.apply("gas_line_update", (m) => updateGasLine(m, {
          gasLineId: resolveGasLine(m, a["gas_line_id"] as string).id,
          start: a["start"] as MmPoint | undefined,
          end: a["end"] as MmPoint | undefined,
        }));
        return ok(compactEntity(ws.model, (c) => c.gas_lines.find((g) => g.site_id === line.id) ?? null));
      },
    ),

    gas_line_delete: tool(
      "Удалить газовую линию (метка G<n> из model_get).",
      { gas_line_id: z.string().min(1).describe("метка G<n> из model_get или id сайта") },
      async (a) => {
        const ws = wsOf();
        ws.apply("gas_line_delete", (m) => {
          deleteGasLine(m, resolveGasLine(m, a["gas_line_id"] as string).id);
          return true;
        });
        return ok({ deleted: a["gas_line_id"], hint: SCENARIO_HINT });
      },
    ),

    // ---------- Трубы водоснабжения/канализации (лист «Водоснабжение», этап 78) ----------
    pipe_add: tool(
      "Провести трубу водоснабжения/канализации (лист «Водоснабжение» → «Труба ХВС/ГВС/Канализация»): " +
        "kind=water (ХВС, water_pipe), kind=hot (ГВС, water_hot_pipe), kind=drainage (канализация, drainage_pipe). " +
        "path — цепочка элементов по порядку: {x, y} (узел, мм) или {item_id} (подключение предмета: выводы воды " +
        "waterspot_*, стояки water/water_column_hot/water_column_cold/drainage_column, ввод ceiling_water, коллектор " +
        "waterspot_collector — какие выводы к какой трубе подключаются, проверяется как в редакторе). " +
        "Соседние элементы пути соединяются ребром; у предметов ставится обратная ссылка pipes.<вид>_id. " +
        "Длина в модели — в метрах, пересчитывается автоматически. Трубы водоснабжения/канализации — функция PRO-тарифа " +
        "редактора (лист «Водоснабжение» в UI доступен только в PRO): на бесплатном тарифе трубы могут не сохраниться — " +
        "поведение free не проверялось. После добавления вызывайте model_validate и project_save.",
      {
        kind: z.enum(["water", "hot", "drainage"]).describe("вид трубы: water — ХВС, hot — ГВС, drainage — канализация"),
        path: z.array(z.union([
          mmPoint.describe("узел трубы, мм"),
          z.object({ item_id: z.string().min(1).describe("предмет-вершина (вывод воды, стояк, ввод) — метка I<n> или id сайта") }),
        ])).min(2).max(MAX_PIPE_PATH_NODES).describe("путь трубы по порядку: узлы ({x, y}) и подключения предметов ({item_id}); не более 32 точек"),
      },
      async (a) => {
        const ws = wsOf();
        const pipe = ws.apply("pipe_add", (m) => addPipe(m, {
          kind: a["kind"] as PipeKind,
          path: (a["path"] as unknown[]).map((el) => {
            const e = el as Record<string, unknown>;
            return "item_id" in e ? { itemId: resolveItem(m, String(e["item_id"])).id } : { x: Number(e["x"]), y: Number(e["y"]) };
          }),
        }));
        return ok(compactEntity(ws.model, (c) => c.pipes.find((p) => p.site_id === pipe.id) ?? null));
      },
    ),

    pipe_update: tool(
      "Изменить трубу (PRO-функция редактора, как и вся лист «Водоснабжение»): перенести узлы графа. positions — список {vertex, x_mm, y_mm}; vertex — индекс вершины " +
        "в графе трубы (0-based, как в model_get pipes[].vertexes); двигать можно только узлы (type node) — " +
        "вершины-предметы следуют за предметом (item_update). Длина пересчитывается по рёбрам.",
      {
        pipe_id: z.string().min(1).describe("метка TP<n> из model_get или id сайта"),
        positions: z.array(z.object({
          vertex: mmInt.describe("индекс вершины (0-based)"),
          x_mm: mmInt,
          y_mm: mmInt,
        })).min(1).max(MAX_PIPE_PATH_NODES),
      },
      async (a) => {
        const ws = wsOf();
        const pipe = ws.apply("pipe_update", (m) => updatePipe(m, {
          pipeId: resolvePipe(m, a["pipe_id"] as string).id,
          positions: (a["positions"] as { vertex: number; x_mm: number; y_mm: number }[]).map((p) => ({
            vertex: p.vertex, x: p.x_mm, y: p.y_mm,
          })),
        }));
        return ok(compactEntity(ws.model, (c) => c.pipes.find((p) => p.site_id === pipe.id) ?? null));
      },
    ),

    pipe_delete: tool(
      "Удалить трубу (PRO-функция редактора, как и весь лист «Водоснабжение»; метка TP<n> из model_get). Обратные ссылки подключённых предметов снимаются; " +
        "сами предметы не удаляются.",
      { pipe_id: z.string().min(1).describe("метка TP<n> из model_get или id сайта") },
      async (a) => {
        const ws = wsOf();
        ws.apply("pipe_delete", (m) => {
          deletePipe(m, resolvePipe(m, a["pipe_id"] as string).id);
          return true;
        });
        return ok({ deleted: a["pipe_id"], hint: SCENARIO_HINT });
      },
    ),

    // ---------- Освещение: световые линии (лист «Освещение», этап 84) ----------
    led_strip_add: tool(
      "Провести светодиодную ленту (лист «Освещение» → «Светодиодная подсветка», PRO): ломаная по точкам path " +
        "(мм, не менее 2; коллекция led_strips — отдельная сущность, не item_add). Соседние точки пути соединяются ребром. " +
        "Длина в модели — в метрах, пересчитывается автоматически. Точки можно двигать led_strip_update. " +
        "После добавления вызывайте model_validate и project_save.",
      {
        path: z.array(mmPoint).min(2).max(MAX_LIGHT_PATH_NODES).describe("точки ленты по порядку, мм; не более 32"),
      },
      async (a) => {
        const ws = wsOf();
        const line = ws.apply("led_strip_add", (m) => addLightLine(m, { kind: "led", path: a["path"] as MmPoint[] }));
        return ok(compactEntity(ws.model, (c) => c.led_strips.find((g) => g.site_id === line.id) ?? null));
      },
    ),

    led_strip_update: tool(
      "Изменить светодиодную ленту: перенести узлы графа. positions — список {vertex, x_mm, y_mm}; vertex — индекс " +
        "вершины (0-based, как в model_get led_strips[].vertexes). Длина пересчитывается по рёбрам.",
      {
        led_strip_id: z.string().min(1).describe("метка LS<n> из model_get или id сайта"),
        positions: z.array(z.object({
          vertex: mmInt.describe("индекс узла (0-based)"),
          x_mm: mmIntSigned,
          y_mm: mmIntSigned,
        })).min(1).max(MAX_LIGHT_PATH_NODES),
      },
      async (a) => {
        const ws = wsOf();
        const line = ws.apply("led_strip_update", (m) => updateLightLine(m, {
          kind: "led",
          lineId: resolveLightLine(m, "led", a["led_strip_id"] as string).id,
          positions: (a["positions"] as { vertex: number; x_mm: number; y_mm: number }[]).map((p) => ({
            vertex: p.vertex, x: p.x_mm, y: p.y_mm,
          })),
        }));
        return ok(compactEntity(ws.model, (c) => c.led_strips.find((g) => g.site_id === line.id) ?? null));
      },
    ),

    led_strip_delete: tool(
      "Удалить светодиодную ленту (метка LS<n> из model_get).",
      { led_strip_id: z.string().min(1).describe("метка LS<n> из model_get или id сайта") },
      async (a) => {
        const ws = wsOf();
        ws.apply("led_strip_delete", (m) => {
          deleteLightLine(m, "led", resolveLightLine(m, "led", a["led_strip_id"] as string).id);
          return true;
        });
        return ok({ deleted: a["led_strip_id"], hint: SCENARIO_HINT });
      },
    ),

    stripe_add: tool(
      "Провести трековую шину (лист «Освещение», PRO): kind=recessed (встроенная, recessed_strip), kind=surface " +
        "(накладная, surface_stripе), kind=pendent (подвесная, pendent_strip — опускание подвеса 20 см по умолчанию). " +
        "path — ломаная по точкам (мм, не менее 2; коллекция stripes_light). Трековые споты (track_spot и др.) " +
        "на шину MCP пока не ставит. После добавления вызывайте model_validate и project_save.",
      {
        kind: z.enum(["recessed", "surface", "pendent"]).describe("вид шины: recessed — встроенная, surface — накладная, pendent — подвесная"),
        path: z.array(mmPoint).min(2).max(MAX_LIGHT_PATH_NODES).describe("точки шины по порядку, мм; не более 32"),
      },
      async (a) => {
        const ws = wsOf();
        const line = ws.apply("stripe_add", (m) => addLightLine(m, { kind: a["kind"] as LightKind, path: a["path"] as MmPoint[] }));
        return ok(compactEntity(ws.model, (c) => c.stripes_light.find((g) => g.site_id === line.id) ?? null));
      },
    ),

    stripe_update: tool(
      "Изменить трековую шину: перенести узлы графа. positions — список {vertex, x_mm, y_mm}; vertex — индекс вершины " +
        "(0-based, как в model_get stripes_light[].vertexes). Длина пересчитывается по рёбрам.",
      {
        stripe_id: z.string().min(1).describe("метка SL<n> из model_get или id сайта"),
        positions: z.array(z.object({
          vertex: mmInt.describe("индекс узла (0-based)"),
          x_mm: mmIntSigned,
          y_mm: mmIntSigned,
        })).min(1).max(MAX_LIGHT_PATH_NODES),
      },
      async (a) => {
        const ws = wsOf();
        const line = ws.apply("stripe_update", (m) => {
          const found = resolveLightLine(m, "recessed", a["stripe_id"] as string);
          const kind = found.type === "pendent_strip" ? "pendent" : found.type === "surface_stripe" ? "surface" : "recessed";
          return updateLightLine(m, {
            kind,
            lineId: found.id,
            positions: (a["positions"] as { vertex: number; x_mm: number; y_mm: number }[]).map((p) => ({
              vertex: p.vertex, x: p.x_mm, y: p.y_mm,
            })),
          });
        });
        return ok(compactEntity(ws.model, (c) => c.stripes_light.find((g) => g.site_id === line.id) ?? null));
      },
    ),

    stripe_delete: tool(
      "Удалить трековую шину (метка SL<n> из model_get).",
      { stripe_id: z.string().min(1).describe("метка SL<n> из model_get или id сайта") },
      async (a) => {
        const ws = wsOf();
        ws.apply("stripe_delete", (m) => {
          const found = resolveLightLine(m, "recessed", a["stripe_id"] as string);
          const kind = found.type === "pendent_strip" ? "pendent" : found.type === "surface_stripe" ? "surface" : "recessed";
          deleteLightLine(m, kind, found.id);
          return true;
        });
        return ok({ deleted: a["stripe_id"], hint: SCENARIO_HINT });
      },
    ),

    line_light_add: tool(
      "Провести линейное освещение (лист «Освещение» → «Линейное освещение», PRO): ломаная по точкам path " +
        "(мм, не менее 2; коллекция line_strips — отдельная сущность, не item_add). Соседние точки пути соединяются ребром. " +
        "Длина в модели — в метрах, пересчитывается автоматически. После добавления вызывайте model_validate и project_save.",
      {
        path: z.array(mmPoint).min(2).max(MAX_LIGHT_PATH_NODES).describe("точки линии по порядку, мм; не более 32"),
      },
      async (a) => {
        const ws = wsOf();
        const line = ws.apply("line_light_add", (m) => addLightLine(m, { kind: "line", path: a["path"] as MmPoint[] }));
        return ok(compactEntity(ws.model, (c) => c.line_strips.find((g) => g.site_id === line.id) ?? null));
      },
    ),

    line_light_update: tool(
      "Изменить линию линейного освещения: перенести узлы графа. positions — список {vertex, x_mm, y_mm}; vertex — " +
        "индекс вершины (0-based, как в model_get line_strips[].vertexes). Длина пересчитывается по рёбрам.",
      {
        line_light_id: z.string().min(1).describe("метка LL<n> из model_get или id сайта"),
        positions: z.array(z.object({
          vertex: mmInt.describe("индекс узла (0-based)"),
          x_mm: mmIntSigned,
          y_mm: mmIntSigned,
        })).min(1).max(MAX_LIGHT_PATH_NODES),
      },
      async (a) => {
        const ws = wsOf();
        const line = ws.apply("line_light_update", (m) => updateLightLine(m, {
          kind: "line",
          lineId: resolveLightLine(m, "line", a["line_light_id"] as string).id,
          positions: (a["positions"] as { vertex: number; x_mm: number; y_mm: number }[]).map((p) => ({
            vertex: p.vertex, x: p.x_mm, y: p.y_mm,
          })),
        }));
        return ok(compactEntity(ws.model, (c) => c.line_strips.find((g) => g.site_id === line.id) ?? null));
      },
    ),

    line_light_delete: tool(
      "Удалить линию линейного освещения (метка LL<n> из model_get).",
      { line_light_id: z.string().min(1).describe("метка LL<n> из model_get или id сайта") },
      async (a) => {
        const ws = wsOf();
        ws.apply("line_light_delete", (m) => {
          deleteLightLine(m, "line", resolveLightLine(m, "line", a["line_light_id"] as string).id);
          return true;
        });
        return ok({ deleted: a["line_light_id"], hint: SCENARIO_HINT });
      },
    ),

    // ---------- Электрика: связь «выключатель → светильник» (лист «Выключатели», этап 88) ----------
    cable_add: tool(
      "Соединить выключатель со светильником (лист «Выключатели», инструмент «Соединительная линия», PRO в UI): " +
        "switch_item_id — предмет-группа с выключателем (light_switch*, item_add), lamp_item_id — светильник " +
        "(люстры, бра, светильники группы lights, вентилятор fan; трековые шины/ленты — следующий этап). " +
        "switch_sub_id — id под-розетки-выключателя внутри группы (model_get items[].socket_group[].id); " +
        "по умолчанию первая под-розетка со свободным ключом. path — промежуточные узлы (мм, опционально). " +
        "У выключателя ограничение по клавишам (light_switch — 1 связь, double — 2, triple — 3); у светильника " +
        "одно подключение. Коллекция cables — отдельная сущность; обратные ссылки на предметах ставятся " +
        "автоматически (cables.cable_id). После добавления вызывайте model_validate и project_save.",
      {
        switch_item_id: z.string().min(1).describe("предмет-группа с выключателем (I<n> из model_get или id сайта)"),
        switch_sub_id: z.string().optional().describe("id под-розетки-выключателя (socket_group[].id); по умолчанию первый свободный"),
        lamp_item_id: z.string().min(1).describe("светильник (I<n> из model_get или id сайта)"),
        path: z.array(mmPoint).max(MAX_CABLE_PATH_NODES).optional().describe("промежуточные узлы, мм; не более 32"),
      },
      async (a) => {
        const ws = wsOf();
        const cable = ws.apply("cable_add", (m) => addCable(m, {
          switchItemId: resolveItem(m, a["switch_item_id"] as string).id,
          switchSubId: a["switch_sub_id"] as string | undefined,
          lampItemId: resolveItem(m, a["lamp_item_id"] as string).id,
          path: a["path"] as MmPoint[] | undefined,
        }));
        return ok(compactEntity(ws.model, (c) => c.cables.find((g) => g.site_id === cable.id) ?? null));
      },
    ),

    cable_delete: tool(
      "Удалить связь «выключатель → светильник» (метка CB<n> из model_get): обратные ссылки " +
        "(cables.cable_id у под-розетки выключателя и у светильника) снимаются автоматически.",
      { cable_id: z.string().min(1).describe("метка CB<n> из model_get или id сайта") },
      async (a) => {
        const ws = wsOf();
        ws.apply("cable_delete", (m) => {
          const id = compactModel(m).cables.find((c) => c.id === (a["cable_id"] as string) || c.site_id === (a["cable_id"] as string))?.site_id
            ?? (a["cable_id"] as string);
          deleteCable(m, id);
          return true;
        });
        return ok({ deleted: a["cable_id"], hint: SCENARIO_HINT });
      },
    ),

    // ---------- Проем в полу (пункт меню «Проем в полу», этап 64) ----------
    floor_hole_add: tool(
      "Добавить проём в полу (пункт меню «Проем в пола»): прямоугольник по двум противоположным углам " +
        "(мм) внутри одной комнаты — перетаскиванию прямоугольника в редакторе соответствует пара углов. " +
        "Проём должен целиком лежать внутри одной комнаты и не пересекать другие проёмы в полу " +
        "(GEOMETRY_CONFLICT). Лимитов размеров в панели редактора нет — только ненулевой размер. " +
        "После добавления вызывайте model_validate и project_save.",
      {
        corner1: mmPoint.describe("первый угол прямоугольника, мм"),
        corner2: mmPoint.describe("противоположный угол прямоугольника, мм"),
      },
      async (a) => {
        const ws = wsOf();
        const hole = ws.apply("floor_hole_add", (m) => addFloorHole(m, {
          corner1: a["corner1"] as MmPoint,
          corner2: a["corner2"] as MmPoint,
        }, ws.rooms()));
        return ok(compactEntity(ws.model, (c) => c.level_holes.find((h) => h.site_id === hole.id) ?? null));
      },
    ),

    floor_hole_update: tool(
      "Изменить проём в полу: новые углы прямоугольника (corner1/corner2, мм; переданные — " +
        "заменяются, непереданные остаются). Правила те же: внутри одной комнаты, без пересечения " +
        "других проёмов. floor_hole_id — id проёма (site_id) или метка FH<n> из model_get.",
      {
        floor_hole_id: z.string().min(1).describe("метка FH<n> из model_get или id сайта"),
        corner1: mmPoint.optional().describe("новый первый угол, мм"),
        corner2: mmPoint.optional().describe("новый противоположный угол, мм"),
      },
      async (a) => {
        const ws = wsOf();
        const hole = ws.apply("floor_hole_update", (m) => updateFloorHole(m, {
          holeId: resolveFloorHole(m, a["floor_hole_id"] as string).id,
          corner1: a["corner1"] as MmPoint | undefined,
          corner2: a["corner2"] as MmPoint | undefined,
        }, ws.rooms()));
        return ok(compactEntity(ws.model, (c) => c.level_holes.find((h) => h.site_id === hole.id) ?? null));
      },
    ),

    floor_hole_delete: tool(
      "Удалить проём в полу (метка FH<n> из model_get).",
      { floor_hole_id: z.string().min(1).describe("метка FH<n> из model_get или id сайта") },
      async (a) => {
        const ws = wsOf();
        ws.apply("floor_hole_delete", (m) => {
          deleteFloorHole(m, resolveFloorHole(m, a["floor_hole_id"] as string).id);
          return true;
        });
        return ok({ deleted: a["floor_hole_id"], hint: SCENARIO_HINT });
      },
    ),

    // ---------- Терраса и участок (пункты меню «Терраса и участок», этап 64) ----------
    terrace_add: tool(
      "Нарисовать террасу (пункт меню «Терраса и участок» → «Нарисовать террасу»): замкнутый контур " +
        "из отрезков-границ, points — вершины (мм, минимум 3). Контур не должен самопересекаться; " +
        "сторона, лежащая на ограждении террасы, отклоняется — проведите там terrace_fence_add " +
        "(редактор удаляет такие границы). Площадь террасы редактор считает сам. " +
        "После добавления вызывайте model_validate и project_save.",
      { points: z.array(mmPoint).min(3).max(64).describe("вершины замкнутого контура, мм") },
      async (a) => {
        const ws = wsOf();
        const borders = ws.apply("terrace_add", (m) => addBorderRing(m, "terrace_borders", "терраса", { points: a["points"] as MmPoint[] }));
        return ok({ created: borders.length, borders: borders.map(borderResponse), hint: SCENARIO_HINT });
      },
    ),

    terrace_border_update: tool(
      "Перенести узел/границу террасы: новые концы отрезка (start/end, мм). Общий узел соседних " +
        "границ двигается вместе (как перенос узла в UI). terrace_border_id — метка TB<n> из model_get или id сайта.",
      {
        terrace_border_id: z.string().min(1).describe("метка TB<n> из model_get или id сайта"),
        start: mmPoint.optional().describe("новое начало отрезка, мм"),
        end: mmPoint.optional().describe("новый конец отрезка, мм"),
      },
      async (a) => {
        const ws = wsOf();
        const border = ws.apply("terrace_border_update", (m) => updateBorder(m, "terrace_borders", "терраса", {
          borderId: resolveBorder(m, "terrace_borders", "TB", a["terrace_border_id"] as string).id,
          start: a["start"] as MmPoint | undefined,
          end: a["end"] as MmPoint | undefined,
        }));
        return ok({ border: borderResponse(border), hint: SCENARIO_HINT });
      },
    ),

    terrace_border_delete: tool(
      "Удалить границу террасы (метка TB<n> из model_get). Контур может стать незамкнутым — " +
        "как при удалении границы в UI.",
      { terrace_border_id: z.string().min(1).describe("метка TB<n> из model_get или id сайта") },
      async (a) => {
        const ws = wsOf();
        ws.apply("terrace_border_delete", (m) => {
          deleteBorder(m, "terrace_borders", resolveBorder(m, "terrace_borders", "TB", a["terrace_border_id"] as string).id);
          return true;
        });
        return ok({ deleted: a["terrace_border_id"], hint: SCENARIO_HINT });
      },
    ),

    terrace_fence_add: tool(
      "Поставить ограждение террасы (пункт меню «Терраса и участок» → «Ограждение террасы»): отрезок " +
        "от start до end (мм). Как в UI, ставится при существующей террасе — сначала terrace_add. " +
        "Толщина по умолчанию 50 мм (defs редактора), лимит 10..1000 мм. Ограждение заменяет границу " +
        "террасы: границу под ограждением редактор убирает сам. Изменение/удаление — wall_update/wall_delete.",
      {
        start: mmPoint.describe("начало ограждения, мм"),
        end: mmPoint.describe("конец ограждения, мм"),
        thickness_mm: mmInt.optional().describe("толщина, мм (по умолчанию 50)"),
      },
      async (a) => {
        const ws = wsOf();
        const fence = ws.apply("terrace_fence_add", (m) => addTerraceFence(m, {
          start: a["start"] as MmPoint,
          end: a["end"] as MmPoint,
          thicknessMm: a["thickness_mm"] as number | undefined,
        }));
        return ok({ id: fence.id, from: [Math.round(fence.p1.x * 10), Math.round(fence.p1.y * 10)], to: [Math.round(fence.p2.x * 10), Math.round(fence.p2.y * 10)], thickness_mm: Math.round(fence.depth * 10), hint: SCENARIO_HINT });
      },
    ),

    // ---------- Балкон (пункт меню «Нарисовать балкон», этап 71) ----------
    balcony_add: tool(
      "Нарисовать балкон (пункт меню «Нарисовать балкон»): ломаная зелёных ограждений — стены role «balcony» " +
        "на исходном плане, points — осевые точки (мм). Концы пристают к наружным стенам (узел или грань); " +
        "контур, замкнутый с наружной стеной, даёт комнату-балкон с площадью (rooms_list). Толщина по умолчанию " +
        "100 мм (defs.wall), высота ограждения 1000 мм, материал a_block — как у инструмента редактора. " +
        "Проёмы на ограждения ставить нельзя (opening_add отклонит с INVALID_ARGUMENT). Контур без самопересечений; " +
        "отказ любого сегмента отменяет весь балкон. После добавления вызывайте model_validate и project_save.",
      {
        points: z.array(mmPoint).min(2).max(64).describe("осевые точки ограждения, мм"),
        closed: z.boolean().optional().describe("замкнуть контур (обычно нет — балкон замыкается наружной стеной)"),
        thickness_mm: mmInt.optional().describe("толщина, мм (по умолчанию 100, лимиты 40..1000)"),
        height_mm: mmInt.optional().describe("высота ограждения, мм (по умолчанию 1000)"),
        material: z.string().optional().describe("материал (по умолчанию a_block)"),
      },
      async (a) => {
        const ws = wsOf();
        const { result: walls, warnings } = await ws.applyWalls("balcony_add", (m) => addBalcony(m, {
          points: a["points"] as MmPoint[],
          closed: a["closed"] as boolean | undefined,
          thicknessMm: a["thickness_mm"] as number | undefined,
          heightMm: a["height_mm"] as number | undefined,
          material: a["material"] as string | undefined,
        }));
        return ok({
          created: walls.length,
          walls: walls.map((w) => ({
            id: w.id,
            from: [Math.round(w.p1.x * 10), Math.round(w.p1.y * 10)],
            to: [Math.round(w.p2.x * 10), Math.round(w.p2.y * 10)],
            thickness_mm: Math.round(w.depth * 10),
            height_mm: Math.round(w.height * 10),
          })),
          ...(warnings.length ? { warnings } : {}),
          hint: SCENARIO_HINT,
        });
      },
    ),

    balcony_update: tool(
      "Изменить балконное ограждение: длина (length_mm с anchor start|end), толщина (thickness_mm), перенос конца " +
        "(start/end, мм). Соседние ограждения в общем узле двигаются вместе. balcony_wall_id — id сайта из " +
        "model_get (стены с role «balcony»). Проёмы на ограждении появиться не могут.",
      {
        balcony_wall_id: z.string().min(1).describe("id балконного ограждения из model_get"),
        length_mm: mmInt.optional().describe("новая длина, мм"),
        anchor: z.enum(["start", "end"]).optional().describe("какой конец переносится, другой остаётся на месте (по умолчанию end — начало на месте; семантика wall_update)"),
        thickness_mm: mmInt.optional(),
        start: mmPoint.optional().describe("новое начало оси, мм"),
        end: mmPoint.optional().describe("новый конец оси, мм"),
      },
      async (a) => {
        const ws = wsOf();
        const { result: wall, warnings } = await ws.applyWalls("balcony_update", (m) =>
          updateBalcony(m, {
            wallId: resolveWall(m, a["balcony_wall_id"] as string).id,
            lengthMm: a["length_mm"] as number | undefined,
            anchor: a["anchor"] as "start" | "end" | undefined,
            thicknessMm: a["thickness_mm"] as number | undefined,
            start: a["start"] as MmPoint | undefined,
            end: a["end"] as MmPoint | undefined,
          }));
        return ok({
          id: wall.id,
          from: [Math.round(wall.p1.x * 10), Math.round(wall.p1.y * 10)],
          to: [Math.round(wall.p2.x * 10), Math.round(wall.p2.y * 10)],
          thickness_mm: Math.round(wall.depth * 10),
          ...(warnings.length ? { warnings } : {}),
          hint: SCENARIO_HINT,
        });
      },
    ),

    balcony_delete: tool(
      "Удалить балконное ограждение (id из model_get). Контур может разомкнуться — комната-балкон исчезнет, " +
        "как при удалении стены в UI. Балконная стена не демонтируется (demolish), только удаляется целиком.",
      { balcony_wall_id: z.string().min(1).describe("id балконного ограждения из model_get") },
      async (a) => {
        const ws = wsOf();
        await ws.applyWalls("balcony_delete", (m) => deleteBalcony(m, resolveWall(m, a["balcony_wall_id"] as string).id));
        return ok({ deleted: a["balcony_wall_id"], hint: SCENARIO_HINT });
      },
    ),

    terrace_column_add: tool(
      "Поставить опорный столб террасы (пункт меню «Терраса и участок» → «Опорный столб террасы»): " +
        "квадрат 200×200 мм по центру (мм). Как в UI, ставится на террасе — центр внутри контура " +
        "террасы или на его границе. Габариты 100..20000 × 100..6000 мм (лимиты панели). " +
        "После добавления вызывайте model_validate и project_save.",
      {
        center: mmPoint.describe("центр столба, мм"),
        width_mm: mmInt.optional().describe("габарит по X (по умолчанию 200)"),
        height_mm: mmInt.optional().describe("габарит по Y (по умолчанию 200)"),
      },
      async (a) => {
        const ws = wsOf();
        const column = ws.apply("terrace_column_add", (m) => addTerraceColumn(m, {
          center: a["center"] as MmPoint,
          widthMm: a["width_mm"] as number | undefined,
          heightMm: a["height_mm"] as number | undefined,
        }));
        return ok(compactEntity(ws.model, (c) => c.pillars.find((p) => p.site_id === column.id) ?? null));
      },
    ),

    terrace_column_update: tool(
      "Изменить столб террасы: перенести (center, мм) или изменить габариты (width_mm/height_mm). " +
        "Столб должен остаться в контуре террасы. terrace_column_id — метка P<n> из model_get или id сайта.",
      {
        terrace_column_id: z.string().min(1).describe("метка P<n> из model_get или id сайта"),
        center: mmPoint.optional().describe("новый центр, мм"),
        width_mm: mmInt.optional(),
        height_mm: mmInt.optional(),
      },
      async (a) => {
        const ws = wsOf();
        const column = ws.apply("terrace_column_update", (m) => updateTerraceColumn(m, resolvePillar(m, a["terrace_column_id"] as string).id, {
          center: a["center"] as MmPoint | undefined,
          widthMm: a["width_mm"] as number | undefined,
          heightMm: a["height_mm"] as number | undefined,
        }));
        return ok(compactEntity(ws.model, (c) => c.pillars.find((p) => p.site_id === column.id) ?? null));
      },
    ),

    terrace_column_delete: tool(
      "Удалить столб террасы (метка P<n> из model_get).",
      { terrace_column_id: z.string().min(1).describe("метка P<n> из model_get или id сайта") },
      async (a) => {
        const ws = wsOf();
        ws.apply("terrace_column_delete", (m) => {
          deleteTerraceColumn(m, resolvePillar(m, a["terrace_column_id"] as string).id);
          return true;
        });
        return ok({ deleted: a["terrace_column_id"], hint: SCENARIO_HINT });
      },
    ),

    territory_add: tool(
      "Нарисовать участок (пункт меню «Терраса и участок» → «Нарисовать участок»): замкнутый контур " +
        "из отрезков-границ (мм, минимум 3 вершины) — зона двора вокруг дома. Правила те же, что у " +
        "террасы: без самопересечений. После добавления вызывайте model_validate и project_save.",
      { points: z.array(mmPoint).min(3).max(64).describe("вершины замкнутого контура, мм") },
      async (a) => {
        const ws = wsOf();
        const borders = ws.apply("territory_add", (m) => addBorderRing(m, "territory_borders", "участок", { points: a["points"] as MmPoint[] }));
        return ok({ created: borders.map(borderResponse), hint: SCENARIO_HINT });
      },
    ),

    territory_border_update: tool(
      "Перенести узел/границу участка (start/end, мм); общие узлы соседних границ двигаются вместе. " +
        "territory_border_id — метка XB<n> из model_get или id сайта.",
      {
        territory_border_id: z.string().min(1).describe("метка XB<n> из model_get или id сайта"),
        start: mmPoint.optional().describe("новое начало отрезка, мм"),
        end: mmPoint.optional().describe("новый конец отрезка, мм"),
      },
      async (a) => {
        const ws = wsOf();
        const border = ws.apply("territory_border_update", (m) => updateBorder(m, "territory_borders", "участок", {
          borderId: resolveBorder(m, "territory_borders", "XB", a["territory_border_id"] as string).id,
          start: a["start"] as MmPoint | undefined,
          end: a["end"] as MmPoint | undefined,
        }));
        return ok({ border: borderResponse(border), hint: SCENARIO_HINT });
      },
    ),

    territory_border_delete: tool(
      "Удалить границу участка (метка XB<n> из model_get).",
      { territory_border_id: z.string().min(1).describe("метка XB<n> из model_get или id сайта") },
      async (a) => {
        const ws = wsOf();
        ws.apply("territory_border_delete", (m) => {
          deleteBorder(m, "territory_borders", resolveBorder(m, "territory_borders", "XB", a["territory_border_id"] as string).id);
          return true;
        });
        return ok({ deleted: a["territory_border_id"], hint: SCENARIO_HINT });
      },
    ),

    // ---------- Чтение и проверка (§7.6) ----------
    model_get: tool(
      "Текущая модель плана в компактном виде: стены W1… (осевые концы, длины по осям и внутренним граням, толщины, проёмы с отступами), " +
        "комнаты R1… (площади м², периметры), предметы I1…, колонны P1… (пункт меню «Несущая колонна»), ригели B1… (пункт меню «Потолочный ригель»), " +
        "газовые линии G1… (пункт меню «Коммуникации» → «Газовый трубопровод»), трубы TP1… (лист «Водоснабжение»), " +
        "границы террас TB1… и участка XB1… (пункт меню «Терраса и участок»), проёмы в полу FH1… (пункт меню «Проем в полу»), " +
        "световые линии LS1… (светодиодные ленты), SL1… (трековые шины), LL1… (линейное освещение — лист «Освещение»). " +
        "Обычно < 5 КБ. id сайта — в поле site_id; метки W/R/I/P/B/G/TP/TB/XB/FH/LS/SL/LL можно использовать в других инструментах.",
      { detail: z.enum(["compact", "full"]).optional() },
      async (a) => {
        const ws = wsOf();
        if ((a["detail"] as string | undefined) === "full") {
          return ok(JSON.parse(JSON.stringify(ws.model)) as Record<string, unknown>);
        }
        return ok(compactModel(ws.model, ws.rooms()));
      },
    ),

    model_validate: tool(
      "Проверить инварианты модели: короткие стены, стены поверх стен, незамкнутые контуры, проёмы вне стены/на краю/с пересечением, " +
        "предметы: выход прямоугольника (с учётом поворота) за внутренние грани комнат (ITEM_OUTSIDE_ROOM с вылетом в мм) " +
        "и пересечение со стеной (ITEM_INTERSECTS_WALL). Пустой список = всё хорошо. Вызывайте перед project_save и render_plan.",
      {},
      async () => {
        const ws = wsOf();
        const problems = validateModel(ws.model, ws.rooms());
        return ok({ ok: problems.length === 0, problems });
      },
    ),

    render_plan: tool(
      "Отрендерить план в PNG (скриншот листа редактора с размерами, если dimensions не выключен). " +
        "Перед скриншотом в редактор синхронизируется вся каноническая модель (стены, проёмы, предметы); " +
        "если редактор показывает не текущую модель — ошибка RENDER_OUT_OF_SYNC без картинки. " +
        "Мебель отрисовывается на листе furniture (на листе init её слой выключен самим сайтом). " +
        "Ответ содержит КАРТИНКУ (image content), путь к файлу в ~/.remplanner-mcp/renders/ и ревизию " +
        "(model_hash, счётчики стен/проёмов/предметов в модели и у редактора). " +
        "Листы: init (по умолчанию — общий чертёж), rooms, furniture, santeh. Используйте после правок для визуальной проверки.",
      {
        sheet: z.string().optional().describe("лист плана (по умолчанию init)"),
        width_px: mmInt.optional().describe("ширина PNG (по умолчанию 1600)"),
        dimensions: z.boolean().optional().describe("размеры на плане (по умолчанию true)"),
      },
      async (a) => {
        const ws = wsOf();
        const res = await ws.renderPlan({
          sheet: (a["sheet"] as string | undefined) ?? "init",
          widthPx: (a["width_px"] as number | undefined) ?? 1600,
          dimensions: a["dimensions"] as boolean | undefined,
        });
        return ok({ path: res.path, width_px: res.widthPx, sheet: res.sheet, bytes: res.bytes, revision: res.revision },
          [{ type: "image", data: res.base64, mimeType: "image/png" }]);
      },
    ),
  };
}

function normalizePosition(raw: Record<string, unknown>, model: Model, rooms?: RoomPolygon[]): Parameters<typeof addItem>[1]["position"] {
  if ("center" in raw) return { center: raw["center"] as MmPoint };
  if ("against_wall" in raw) {
    const aw = raw["against_wall"] as Record<string, unknown>;
    const wall = model.walls[aw["wall_id"] as string];
    if (!wall) {
      const m = /^W(\d+)$/.exec(aw["wall_id"] as string);
      const walls = Object.values(model.walls);
      const byLabel = m ? walls[Number(m[1]) - 1] : undefined;
      if (!byLabel) throwNotFound(`стена ${String(aw["wall_id"])} не найдена`);
      aw["wall_id"] = byLabel.id;
    }
    return { againstWall: {
      wallId: aw["wall_id"] as string,
      offsetMm: aw["offset_mm"] as number,
      from: aw["from"] as "start" | "end" | undefined,
      gapMm: aw["gap_mm"] as number | undefined,
    } };
  }
  if ("in_room" in raw) {
    const ir = raw["in_room"] as Record<string, unknown>;
    const roomList = rooms ?? roomPolygons(model);
    const idx = Number(/^R(\d+)$/.exec(ir["room_id"] as string)?.[1] ?? 0) - 1;
    const room = roomList[idx];
    if (!room) throwNotFound(`комната ${String(ir["room_id"])} не найдена (метки комнат — из model_get)`);
    // модельный слой берёт первую комнату — для выбранной считаем точку угла сами (в мм)
    const xs = room.polygon.map((p) => p.x);
    const ys = room.polygon.map((p) => p.y);
    const minX = Math.min(...xs) * 10, maxX = Math.max(...xs) * 10;
    const minY = Math.min(...ys) * 10, maxY = Math.max(...ys) * 10;
    void ir;
    return { center: cornerPoint(ir["corner"] as string, minX, maxX, minY, maxY) };
  }
  throw Object.assign(new Error("position: нужен center | against_wall | in_room"), { code: "INVALID_ARGUMENT" });
}

function cornerPoint(corner: string, minX: number, maxX: number, minY: number, maxY: number): MmPoint {
  // точный прижим в угол делал addItem; здесь — точка у угла с отступом полгабарита предмета,
  // addItem сам проверит попадание в комнату (OUTSIDE_ROOM при ошибке)
  const inset = 150; // мм от стен — предмет войдёт в комнату с типовыми габаритами
  switch (corner) {
    case "nw": return { x: minX + inset, y: minY + inset };
    case "ne": return { x: maxX - inset, y: minY + inset };
    case "se": return { x: maxX - inset, y: maxY - inset };
    case "sw": return { x: minX + inset, y: maxY - inset };
    default: return { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2) };
  }
}

/** Индексы предметов (в порядке compactModel) внутри комнаты с индексом roomIndex. */
function itemsInRoom(model: Model, rooms: RoomPolygon[], roomIndex: number): Set<number> {
  const compact = compactModel(model, rooms);
  const siteItems = Object.values(model.items);
  const out = new Set<number>();
  compact.items.forEach((ci, i) => {
    const site = siteItems[i];
    void site;
    void rooms;
    if (ci && roomIndex >= 0) {
      // принадлежность по точке центра: комнаты в том же порядке, что и в model_get
      const inside = rooms[roomIndex] ? pointInside(model, rooms[roomIndex]!, compact.items[i]!) : false;
      if (inside) out.add(i);
    }
  });
  return out;
}

function pointInside(model: Model, room: { polygon: { x: number; y: number }[]; roomId: string | null }, item: { x_mm: number; y_mm: number }): boolean {
  void model;
  // roomPolygons возвращает полигон в см
  const x = item.x_mm / 10;
  const y = item.y_mm / 10;
  let s = 0;
  const poly = room.polygon;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(s) < 1e-9) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
