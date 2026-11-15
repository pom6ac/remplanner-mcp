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
  height: number;
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
  over_floor?: number | null;
  plan: Record<string, number>;
  id_room?: string | null;
  id_wall?: string | null;
  layer?: string | null;
  comment?: string | { id: string } | null;
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
  pillars: Record<string, unknown>;
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
