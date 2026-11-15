import { z } from "zod";
import { SCENARIO_HINT, mmInt, mm, mmPoint } from "./context.ts";
import type { ServerContext } from "./context.ts";
import { ok, tool, type ToolDefLike } from "./toolkit.ts";
import {
  addWall, addPolyline, addRoomRect, addRoomPolygon, updateWall, moveWall, splitWall, deleteWall,
  type MmPoint,
} from "../model/walls.ts";
import { addOpening, updateOpening, deleteOpening, OPENING_KINDS } from "../model/openings.ts";
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
      "Добавить проём на стену: дверь (door, door_double, doorway, door_coupe…), окно (window, windowway, window_balcony…). " +
        "Положение: offset_mm + from (смещение края проёма от угла комнаты; from=end — от противоположного конца) " +
        "или center_mm (центр от начала оси стены). width/height в мм; для окон sill_height_mm — высота подоконника. " +
        "Проём должен целиком помещаться на стене и не пересекать другие проёмы и примыкания стен (GEOMETRY_CONFLICT).",
      {
        wall_id: wallRef,
        type: z.string().refine((t) => t in OPENING_KINDS, { message: "неизвестный тип проёма" })
          .describe(`door, door_double, doorway, window, windowway, … (всего ${Object.keys(OPENING_KINDS).length} типов)`),
        offset_mm: mmInt.optional(),
        from: z.enum(["start", "end"]).optional(),
        center_mm: mmInt.optional(),
        width_mm: mmInt.optional(),
        height_mm: mmInt.optional(),
        sill_height_mm: mmInt.optional().describe("окна: высота подоконника над полом"),
        swing: swing.optional().describe("двери: петля и сторона открывания"),
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
        }));
        return ok(compactEntity(ws.model, (c) =>
          c.walls.flatMap((w) => w.openings).find((o) => o.id === hole.id) ?? { id: hole.id, type: hole.type }));
      },
    ),

    opening_update: tool(
      "Изменить проём: размеры, положение (offset_mm/from или center_mm), подоконник, сторону открывания. " +
        "Поля не указанные — не меняются. opening_id — id проёма (site_id) из model_get.",
      {
        opening_id: z.string().min(1).describe("id проёма из model_get (поле id у openings)"),
        wall_id: wallRef.optional().describe("если известен; иначе находится автоматически"),
        type: z.string().refine((t) => t in OPENING_KINDS).optional(),
        offset_mm: mmInt.optional(),
        from: z.enum(["start", "end"]).optional(),
        center_mm: mmInt.optional(),
        width_mm: mmInt.optional(),
        height_mm: mmInt.optional(),
        sill_height_mm: mmInt.optional(),
        swing: swing.optional(),
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
        "Возвращает name (точное имя для item_add), title, размеры в мм, resizable. Примеры запросов: «диван», «унитаз», «кровать».",
      {
        query: z.string().min(1),
        group: z.string().optional().describe("furniture, santeh_furniture, lights, sockets, …"),
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
        "Точка вне помещений → OUTSIDE_ROOM. Размеры берутся из каталога; width_mm/depth_mm/height_mm переопределяют (если resizable).",
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

    // ---------- Чтение и проверка (§7.6) ----------
    model_get: tool(
      "Текущая модель плана в компактном виде: стены W1… (осевые концы, длины по осям и внутренним граням, толщины, проёмы с отступами), " +
        "комнаты R1… (площади м², периметры), предметы I1… Обычно < 5 КБ. id сайта — в поле site_id; метки W/R/I можно использовать в других инструментах.",
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
