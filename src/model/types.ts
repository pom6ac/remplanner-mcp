// Типы модели remplanner (project.copy("server")). Все длины в см, ось Y вниз.
// Полные эталоны — tests/fixtures/ui-one-wall.json, anon-rect-4000x3000.json.

export type Point = { x: number; y: number };

export type WallLink = {
  /** node — стык узлов; edge — примыкание к грани. */
  ct: "node" | "edge";
  ot: "wall";
  id: string;
  /**
   * Формат редактора (normalized-*.json, ui-ref-*.json): у node-связи z0 всегда "c",
   * у edge-связи — сторона грани соседа ("l"|"r").
   */
  z0: string;
  /** node-связь: имя узла СОСЕДА ("p1"|"p2"); edge-связь: конец соседа, к которому примыкаем. */
  z1: string;
  /** edge-связь: сторона примыкания ("in" — внутри). */
  pos?: string;
};

export type WallNode = Point & {
  link?: WallLink;
  /** Бэкап позиции узла у редактора; перед restore снимаем (мешает переносам). */
  bak?: unknown;
};

export type Hole = {
  id: string;
  plan: string;
  type: string;
  group: "doors" | "windows" | (string & {});
  pc: Point;
  width: number;
  /** У балконного блока (windoor) height в модели отсутствует. */
  height?: number;
  depth: number;
  /** Края проёма на оси стены (обязательны при restore). */
  p1?: Point;
  p2?: Point;
  /** Наше служебное поле: расстояние от начала оси стены до ближнего края, см. */
  at?: number;
  floor_height?: number;
  opening?: string;
  slopes?: unknown;
  casing?: number;
  casements?: number;
  sill?: unknown;
  [key: string]: unknown;
};

export type Wall = {
  id: string;
  plan: string;
  role: "wall" | "balcony" | "terrace_fence" | (string & {});
  depth: number;
  height: number;
  p1: WallNode;
  p2: WallNode;
  p1st?: number;
  p2st?: number;
  material: string;
  color?: number;
  level?: string;
  show_dls?: boolean;
  child?: number;
  archive?: number;
  demount?: number;
  holes: Record<string, Hole>;
  angle?: number;
  /** Грани (левая/правая сторона относительно направления p1→p2 при Y вниз). */
  l1?: Point;
  l2?: Point;
  r1?: Point;
  r2?: Point;
  [key: string]: unknown;
};

export type ItemProps = {
  id: string;
  name: string;
  pc: Point;
  angle: number;
  width: number;
  height: number;
  self_height?: number;
  /** Подъём над полом, см — форма редактора {value, display} (эталон ui-ref-stair-stair_spot);
   *  числовая форма из старых моделей читается, новые предметы пишут объект. */
  over_floor?: number | { value: number; display: boolean } | null;
  plan: Record<string, number>;
  id_room?: string | null;
  id_wall?: string | null;
  layer?: string | null;
  comment?: string | { id: string } | null;
  [key: string]: unknown;
};

/**
 * Колонна (model.pillars, модель редактора в см): эталоны
 * tests/fixtures/ui-ref-pillar-<вариант>.json (этап 41, 2026-11-16).
 * width/height — габариты пятна на плане (до поворота), total_height — высота
 * (как высота потолка комнаты), pc — центр, p1..p4 — углы (обязательны при restore),
 * edges — четыре грани с side t/r/b/l, eds — примыкания граней к стенам
 * (пересчитываются редактором при restore, но пишутся для каноничного вида).
 */
export type PillarEdge = {
  p1: Point;
  p2: Point;
  /** Сторона относительно углов p1→p2→p3→p4: t (p1-p2), r (p2-p3), b (p3-p4), l (p4-p1). */
  side: "t" | "r" | "b" | "l";
  /** 1 — грань без стены (свободная); отсутствует у грани-примыкания. */
  no_wall?: number;
  [key: string]: unknown;
};

export type Pillar = {
  id: string;
  /** 1 — целиком внутри контура квартиры; 0 — грань лежит на линии стены/границы. */
  inRoom?: number;
  /** Лист: "a" — init. */
  plan: string;
  role: "pillar" | "gypsum" | "terrace_column" | (string & {});
  /** Габарит по X до поворота, см. */
  width: number;
  /** Габарит по Y (глубина) до поворота, см. */
  height: number;
  /** Высота колонны, см (по умолчанию — высота потолка проекта). */
  total_height?: number;
  /** Поворот, градусы. */
  angle: number;
  /** Смещение по этажу (у колонны меню — 0). */
  f0offset?: number;
  /** Центр, см. */
  pc: Point;
  /** Углы (обязательны при restore: Pillar.restore читает p1..p4 до пересчёта граней). */
  p1: Point;
  p2: Point;
  p3: Point;
  p4: Point;
  /** Грани (пересчитываются редактором при restore; пишем для каноничного вида). */
  edges?: PillarEdge[];
  /** Примыкания граней к стенам: side → {p1, p2, wall:{id, balc}} (пересчитываются редактором). */
  eds?: Record<string, unknown>;
  /** Показывать размеры на плане (переключатель панели). */
  show_dls?: boolean;
  [key: string]: unknown;
};

/**
 * Потолочный ригель (model.rigels, пункт меню «Потолочный ригель», этап 47, 2026-11-16):
 * эталоны tests/fixtures/ui-ref-rigel-<вариант>.json. p1/p2 — концы оси (см) со связями
 * к граням стен/колонн/ригелей (пересчитываются редактором при restore), depth — толщина
 * на плане, height — опускание от потолка, ceiling_type — тип отделки потолка,
 * polygon/l/r — расчёт редактора (Rigel.calc/serialize), пишется каноничный вид.
 */
export type RigelLink = {
  /** К чему прилип конец оси: стена, колонна или другой ригель. */
  ot: "wall" | "pillar" | "rigel";
  id: string;
  /** Сторона грани: у стены l/r/s/e, у колонны t/r/b/l, у ригеля l/r/s/e. */
  z1: string;
};

export type RigelEndpoint = Point & {
  /** Связь конца с гранью или 0 (нет связи); пересчитывается редактором при restore. */
  link?: RigelLink | 0;
};

export type Rigel = {
  id: string;
  /** Начало оси, см. */
  p1: RigelEndpoint;
  /** Конец оси, см. */
  p2: RigelEndpoint;
  /** Толщина ригеля на плане, см (defs.rigel.depth: 10..100). */
  depth: number;
  /** Опускание от потолка, см (defs.rigel.height: 10..100). */
  height: number;
  /** Тип отделки потолка ("" — ригель без отделки). */
  ceiling_type: string;
  /** Полигон ригеля на плане (4 угла, расчёт редактора). */
  polygon: Point[];
  /** Левая боковая грань (расчёт редактора, 4 знака). */
  l: { p1: Point; p2: Point };
  /** Правая боковая грань (расчёт редактора, 4 знака). */
  r: { p1: Point; p2: Point };
  [key: string]: unknown;
};

/**
 * Газовая линия (model.pipes_gas, пункт меню «Коммуникации» → «Газовый трубопровод»,
 * этап 57, 2026-11-16): эталоны tests/fixtures/ui-ref-comm-gas_line.json. Граф трубы:
 * vertexes — узлы (point в см, type "node"), matrix — матрица смежности N×N
 * (диагональ null, у связной пары {length:1}), items — карта id узла → "node",
 * type "gas_line", plan "a" (лист исходного плана), length — длина трубы в метрах
 * (сумма сегментов, округление редактора до 2 знаков).
 */
export type GasLineVertex = {
  id: string;
  point: Point;
  type: "node" | (string & {});
};

export type GasLine = {
  id: string;
  /** Матрица смежности: matrix[i][j] — {length:1} у связных узлов, null иначе. */
  matrix: ({ length: number } | null)[][];
  vertexes: GasLineVertex[];
  /** Карта id узла → тип ("node"). */
  items: Record<string, string>;
  type: "gas_line" | (string & {});
  /** Лист: "a" — исходный план. */
  plan: string;
  /** Длина трубы, м (сумма сегментов, округление редактора до 2 знаков). */
  length: number;
  [key: string]: unknown;
};

/**
 * Труба водоснабжения/канализации (model.pipes, пункты листа «Водоснабжение» →
 * «Труба ХВС/ГВС/Канализация», этап 78, 2026-11-17). Формат — тот же граф GraphLines,
 * что у газовой линии: класс Pipe extends GraphLines (бандл app.3.0), serialize отдаёт
 * {id, matrix, vertexes, items, type, length} — БЕЗ plan (в отличие от PipeGas, план
 * «water» у Pipe только рантайм-поле конструктора). type — "water_pipe"|"water_hot_pipe"|
 * "drainage_pipe"; вершины — либо узлы ({id, point, type:"node"}), либо предметы:
 * выводы воды (waterspot_*), стояки (water, water_column_hot/cold, drainage_column) и
 * ввод водоснабжения (ceiling_water); тип вершины в items — "waterspot"|"node"|
 * "ceiling_water"|"multi" (multi — waterspot_collector и стояки water_column_*,
 * у них props.pipes хранит массив id труб). Предмет хранит обратную ссылку
 * props.pipes = {water_pipe_id|water_hot_pipe_id|drainage_pipe_id: id трубы|массив}.
 * Длина — сумма длин по рёбрам matrix, м с 2 знаками (как у газовой линии).
 */
export type Pipe = {
  id: string;
  /** Матрица смежности: matrix[i][j] — {length:1} у связных узлов, null иначе. */
  matrix: ({ length: number } | null)[][];
  vertexes: GasLineVertex[];
  /** Карта id вершины → тип ("node"|"waterspot"|"ceiling_water"|"multi"). */
  items: Record<string, string>;
  type: "water_pipe" | "water_hot_pipe" | "drainage_pipe" | (string & {});
  /** Длина трубы, м (сумма сегментов, округление редактора до 2 знаков). */
  length: number;
  [key: string]: unknown;
};

/**
 * Граница террасы/участка (model.terrace_borders / model.territory_borders, пункты меню
 * «Терраса и участок» → «Нарисовать террасу»/«Нарисовать участок», этап 64, 2026-11-16):
 * эталоны tests/fixtures/ui-ref-terrace-border.json и ui-ref-terrace-territory.json.
 * Отрезок оси в см; терраса/участок — замкнутое кольцо таких границ, площадь и заливка —
 * расчёт редактора. p1link/p2link редактор восстанавливает сам (getLinks), в модели их нет.
 */
export type TerraceBorder = {
  id: string;
  p1: Point;
  p2: Point;
  [key: string]: unknown;
};

/**
 * Проём в полу (model.level_holes, пункт меню «Проем в полу», этап 64, 2026-11-16):
 * эталон tests/fixtures/ui-ref-floorhole-floor_hole.json. Прямоугольник на плане:
 * polygon — 4 угла (см, Y вниз), matrix — кольцо 4×4 в обе стороны ({length:1}),
 * vertexes — узлы type "node", items — карта id узла → "node", type "floor_hole",
 * plan "a", length — периметр в метрах (пересчитывается редактором), area — площадь в м², pc — центр.
 * id_room редактор при restore не пересчитывает (проба 64-norm2) — пишем id комнаты
 * по проверенному включению (ревью 66 №8).
 */
export type LevelHole = {
  id: string;
  plan: string;
  polygon: Point[];
  matrix: ({ length: number } | null)[][];
  vertexes: { id: string; point: Point; type: string }[];
  items: Record<string, string>;
  type: "floor_hole" | "ceiling_hole" | (string & {});
  length: number;
  id_room: string | null;
  area: number;
  pc: Point;
  [key: string]: unknown;
};

/**
 * Световая линия листа «Освещение» (этап 84, 2026-11-17): LedStrip/StripLight/LineStrip
 * extends GraphLines (бандл app.3.0, классы в одном файле с классами труб). Формат —
 * тот же граф, что pipes_gas/pipes: vertexes — узлы type "node" (point в см;
 * serialize дописывает id_room:"" — у узла-не-предмета комнаты нет), matrix —
 * матрица смежности N×N (диагональ null, у связной пары {length:1}), items — карта
 * id узла → "node", length — длина в метрах (сумма сегментов, 2 знака). Общие поля:
 * props {id, name: type}, on_size 1. Отличия по коллекциям (serialize классов):
 * - led_strips (LedStrip, инструмент led_strip): {id, matrix, vertexes, items, type,
 *   length, props, on_size}; type "led_strip";
 * - stripes_light (StripLight, инструменты recessed_strip/surface_stripe/pendent_strip):
 *   то же + spots {} (точки-споты на шине — трековые светильники, этап 84 не пишет),
 *   line_spots [] (линейные споты track_line_spot — не пишет), height_lowering —
 *   у pendent_strip 20 (см), у остальных поле отсутствует; type = имени инструмента;
 * - line_strips (LineStrip, инструмент line_light): то же + plan "light", prs {}
 *   (plan_ у линий основного плана не пишется); type "line_light".
 * Все три вида — PRO-инструменты UI; запись в модель сервер не гейтит (как трубы).
 */
export type LightStripVertex = {
  id: string;
  point: Point;
  type: "node" | (string & {});
  id_room?: string;
};

export type LedStrip = {
  id: string;
  matrix: ({ length: number } | null)[][];
  vertexes: LightStripVertex[];
  items: Record<string, string>;
  type: "led_strip" | (string & {});
  length: number;
  props: { id: string; name: string };
  on_size: number;
  [key: string]: unknown;
};

export type StripLight = {
  id: string;
  matrix: ({ length: number } | null)[][];
  vertexes: LightStripVertex[];
  items: Record<string, string>;
  type: "recessed_strip" | "surface_stripe" | "pendent_strip" | (string & {});
  length: number;
  props: { id: string; name: string };
  on_size: number;
  spots: Record<string, unknown>;
  line_spots: unknown[];
  height_lowering?: number;
  [key: string]: unknown;
};

export type LineStrip = {
  id: string;
  matrix: ({ length: number } | null)[][];
  vertexes: LightStripVertex[];
  items: Record<string, string>;
  type: "line_light" | (string & {});
  length: number;
  props: { id: string; name: string };
  on_size: number;
  plan: string;
  prs: Record<string, unknown>;
  [key: string]: unknown;
};

export type Model = {
  v: number;
  id: string;
  plan_id: string;
  walls: Record<string, Wall>;
  /**
   * Предметы: в серверной модели значение — ПЛОСКИЕ props (эталон ui-ref-sofa.json → copy);
   * обёртка {props} — только формат живых объектов редактора (ITEMS).
   */
  items: Record<string, ItemProps>;
  /** Колонны (пункт меню «Несущая колонна») и прочие pillar-объекты модели редактора. */
  pillars: Record<string, Pillar>;
  /** Потолочные ригели (пункт меню «Потолочный ригель»); у старых моделей может отсутствовать. */
  rigels?: Record<string, Rigel>;
  /** Газовые линии (пункт меню «Коммуникации» → «Газовый трубопровод»); у старых моделей может отсутствовать. */
  pipes_gas?: Record<string, GasLine>;
  /** Трубы водоснабжения/канализации (лист «Водоснабжение»); у старых моделей может отсутствовать. */
  pipes?: Record<string, Pipe>;
  /** Границы террас (пункт меню «Терраса и участок» → «Нарисовать террасу»); может отсутствовать. */
  terrace_borders?: Record<string, TerraceBorder>;
  /** Границы участка (пункт меню «Терраса и участок» → «Нарисовать участок»); может отсутствовать. */
  territory_borders?: Record<string, TerraceBorder>;
  /** Проёмы в полу/потолке (пункт меню «Проем в полу» → floor_hole); может отсутствовать. */
  level_holes?: Record<string, LevelHole>;
  /** Светодиодные ленты (лист «Освещение» → led_strip); у старых моделей может отсутствовать. */
  led_strips?: Record<string, LedStrip>;
  /** Трековые шины (лист «Освещение» → recessed_strip/surface_stripe/pendent_strip); может отсутствовать. */
  stripes_light?: Record<string, StripLight>;
  /** Линейное освещение (лист «Освещение» → line_light); у старых моделей может отсутствовать. */
  line_strips?: Record<string, LineStrip>;
  rulers: Record<string, unknown>;
  comments: Record<string, unknown>;
  total_height: number;
  final: boolean;
  rooms1?: Record<string, unknown>;
  rooms2?: Record<string, unknown>;
  errors?: Record<string, number>;
  [key: string]: unknown;
};

/** Модель с фикстуры (обёртка с метаданными ответа). */
export type FixtureEnvelope = {
  _source?: string;
  response_meta?: Record<string, unknown>;
  model: Model;
};

export function newId(len = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
