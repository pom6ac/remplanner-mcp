import type { Cable, Model, Wall, GasLine, Pipe, LedStrip, StripLight, LineStrip, WarmFloor } from "./types.ts";
import { cmToMm, round0 } from "./units.ts";
import type { RoomPolygon } from "./items.ts";
import { roomPolygons } from "./items.ts";
import { holeOffsetFromStart } from "./openings.ts";
import { wallFaces } from "./wall-geometry.ts";
import { projectionLength, type Segment } from "./geometry.ts";
import { parseSwitchVertexId } from "./electric.ts";

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
};

export type CompactRoom = {
  id: string;
  name: string | null;
  /** Площадь по внутренним граням (как показывает редактор), м². */
  area_m2: number;
  /** Площадь по осевым линиям, м² (null для комнат из rooms2 — осевой контур не восстанавливается). */
  area_axis_m2: number | null;
  perimeter_mm: number;
  /** Покрытие пола комнаты (лист «Напольные покрытия», этап 94). */
  floor?: string | null;
  /** Покрытие потолка комнаты (лист «Потолки», этап 94). */
  ceiling?: string | null;
};

export type CompactItem = {
  id: string;
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

export type CompactBorder = {
  id: string;
  site_id: string;
  /** Концы отрезка, мм. */
  from: [number, number];
  to: [number, number];
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
  led_strips: CompactLightStrip[];
  stripes_light: CompactLightStrip[];
  line_strips: CompactLightStrip[];
  cables: CompactCable[];
  warm_floors: CompactWarmFloor[];
  pipes_warm_floor: CompactPipe[];
  pipes_conditioner: CompactPipe[];
  pipes_heat: CompactPipe[];
  pipes_ventilation: CompactPipe[];
  total_height_mm: number;
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

  const compactRooms: CompactRoom[] = roomList.map((room, i) => {
    let perimeter = 0;
    for (let j = 0; j < room.polygon.length; j++) {
      const a = room.polygon[j]!;
      const b = room.polygon[(j + 1) % room.polygon.length]!;
      perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const name = room.roomId && roomNames?.[room.roomId]
      ? ((roomNames[room.roomId] as { zones?: Array<{ name?: string }> }).zones?.[0]?.name ?? null)
      : null;
    // этап 94: покрытие пола/потолка комнаты видно в компактном API
    const room2 = room.roomId ? (model.rooms2 as Record<string, Record<string, unknown>> | undefined)?.[room.roomId] : undefined;
    const floorRec = room2 ? (room2["floors"] as Array<Record<string, unknown>> | undefined)?.[0] : undefined;
    const ceilingRec = room2 ? (room2["ceilings"] as Array<Record<string, unknown>> | undefined)?.[0] : undefined;
    return {
      id: `R${i + 1}`,
      name,
      area_m2: Math.round((room.areaCm2 / 10_000) * 100) / 100,
      area_axis_m2: room.axisAreaCm2 === null ? null : Math.round((room.axisAreaCm2 / 10_000) * 100) / 100,
      perimeter_mm: round0(cmToMm(perimeter)),
      floor: floorRec && floorRec["exist"] === true && typeof floorRec["cover"] === "string" ? floorRec["cover"] as string : null,
      ceiling: ceilingRec && ceilingRec["exist"] === true && typeof ceilingRec["material"] === "string" ? ceilingRec["material"] as string : null,
    };
  });

  const items: CompactItem[] = Object.values(model.items).map((item, i) => {
    // ревью 90 R5: состав под-розеток и высота установки видны в компактном API
    const subs = Array.isArray(item.socket_group) ? (item.socket_group as Array<{ name?: string; id?: string; center?: { x?: number; y?: number } }>) : null;
    const overFloor = item.over_floor;
    return {
      id: `I${i + 1}`,
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

  const levelHoles: CompactFloorHole[] = Object.values(model.level_holes ?? {}).map((hole, i) => {
    const xs = hole.polygon.map((p) => p.x);
    const ys = hole.polygon.map((p) => p.y);
    return {
      id: `FH${i + 1}`,
      site_id: hole.id,
      x_mm: round0(cmToMm(hole.pc.x)),
      y_mm: round0(cmToMm(hole.pc.y)),
      width_mm: round0(cmToMm(Math.max(...xs) - Math.min(...xs))),
      depth_mm: round0(cmToMm(Math.max(...ys) - Math.min(...ys))),
      area_m2: hole.area ?? 0,
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
    led_strips: compactLightStrips(model.led_strips, "LS"),
    stripes_light: compactLightStrips(model.stripes_light, "SL"),
    line_strips: compactLightStrips(model.line_strips, "LL"),
    cables: compactCables(model.cables),
    warm_floors: compactWarmFloors(model.warm_floors),
    pipes_warm_floor: compactClimatePipes(model.pipes_warm_floor, "PW"),
    pipes_conditioner: compactClimatePipes(model.pipes_conditioner, "PC"),
    pipes_heat: compactClimatePipes(model.pipes_heat, "PH"),
    pipes_ventilation: compactClimatePipes(model.pipes_ventilation, "PV"),
    total_height_mm: round0(cmToMm(totalHeight)),
  };
}

export function compactModelJson(model: Model): string {
  return JSON.stringify(compactModel(model));
}
