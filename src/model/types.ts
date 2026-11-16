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
