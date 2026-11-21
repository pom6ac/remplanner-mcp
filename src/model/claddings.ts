import type { Model, Point, Wall } from "./types.ts";
import { newId } from "./types.ts";
import { mmToCm, cmToMm, roundTenthMm as r2 } from "./units.ts";
import { McpError } from "../errors.ts";
import { roomPolygonOf, roomsMapOf, pointInPolygon } from "./room-geo.ts";
import { segmentInsidePolygon } from "./zone.ts";

// Обшивка ГКЛ (лист «Перегородки», инструмент gypsum_cladding «Обшивка гипсокартоном»,
// этап 354). Линии обшивки редактор хранит ВЕРХНЕУРОВНЕВО в model.claddings
// (project.copy("server"): o.claddings=$Claddings.copy(); restore:
// $Claddings.restore(e.claddings), бандл 268-app.js). Формат записи:
//   {id, p1, p2, pc (центр)} — координаты в см; у живых объектов редактора есть
//   производные поля (p1lnk/p2lnk/dlpos/l1/l2/r1/r2, полигоны chains), которые
//   редактор восстанавливает при draw — MCP их не пишет и при сверке игнорирует.
// Живой раунд-трип снят пробой 354-replan2-ui4 (анонимный проект, save → reload:
// запись сохраняется, производные поля дописывает редактор).
//
// Стандарт редактора (бандл, mousedown/mouseup режима gypsum_cladding):
//   - линия строится внутри ОДНОЙ комнаты (точка вне комнат — warning
//     cladding__in_room_only); комнаты листа «Перегородки» (rooms2);
//   - конец магнитится к ребру комнаты в 5 см (LIB.d(this.p0,l)<=5) или к
//     свободному концу другой линии обшивки в 10 см (LIB.distance(this.p0,a.p1)<10,
//     только у линий с p1lnk.obj==0); иначе — свободная точка внутри комнаты;
//   - линия короче 4 см не создаётся (t.length<4 — тихий пропуск);
//   - пересечение другой линии обшивки — отказ (cladding__dont_cross_other_cladding;
//     соединение концами допустимо — из цепочек линий редактор строит полигоны).
//
// Кнопки в разметке редактора НЕТ (#plannertool_gypsum_cladding отсутствует,
// пробы 354-replan2-ui), но режим, обработчик, сериализация и restore полностью
// работают — MCP поддерживает сущность, как в модели редактора.

export type CladdingRec = {
  id: string;
  p1: Point;
  p2: Point;
  pc?: Point;
  [key: string]: unknown;
};

/** Лимиты из бандла (см/мм). */
export const CLADDING_LIMITS = {
  /** Магнит конца к ребру комнаты, см (mousedown: LIB.d(p0, l) <= 5). */
  edgeSnapCm: 5,
  /** Магнит конца к свободному концу другой линии, см (LIB.distance(p0, a.p1) < 10). */
  lineEndSnapCm: 10,
  /** Минимальная длина линии, мм (бандл: t.length < 4 см — линия не создаётся). */
  minLineMm: 40,
} as const;

function claddingsOf(model: Model): Record<string, CladdingRec> {
  return (model.claddings ?? {}) as Record<string, CladdingRec>;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function projOnSeg(p: Point, a: Point, b: Point): Point | null {
  const vx = b.x - a.x, vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  if (l2 < 1e-9) return null;
  const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2;
  if (t < -1e-6 || t > 1 + 1e-6) return null;
  return { x: a.x + t * vx, y: a.y + t * vy };
}

/** Пересечение отрезков по ненулевой длине (общая точка-касание не считается —
 *  соединение линий концами редактор разрешает, из цепочек строит полигоны). */
function segsCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d = (o: Point, p: Point, q: Point) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = d(a1, a2, b1), d2 = d(a1, a2, b2), d3 = d(b1, b2, a1), d4 = d(b1, b2, a2);
  return ((d1 > 1e-9) !== (d2 > 1e-9)) && ((d3 > 1e-9) !== (d4 > 1e-9));
}

function distToSeg(p: Point, a: Point, b: Point): number {
  const q = projOnSeg(p, a, b) ?? (dist(p, a) < dist(p, b) ? a : b);
  return dist(p, q);
}

/** Магнит конца: ребро комнаты в 5 см, иначе свободный конец другой линии в 10 см. */
function snapEndpoint(model: Model, p: Point): Point {
  const rooms = roomsMapOf(model) ?? {};
  let best: { q: Point; d: number } | null = null;
  for (const room of Object.values(rooms)) {
    const poly = roomPolygonOf(room);
    if (!poly || poly.length < 3) continue;
    for (let i = 0; i < poly.length; i++) {
      const q = projOnSeg(p, poly[i]!, poly[(i + 1) % poly.length]!);
      if (!q) continue;
      const d = dist(p, q);
      if (d <= CLADDING_LIMITS.edgeSnapCm && (!best || d < best.d)) best = { q, d };
    }
  }
  if (best) return best.q;
  for (const line of Object.values(claddingsOf(model))) {
    if (line["p1lnk"] !== undefined && (line["p1lnk"] as { obj?: unknown })["obj"] !== 0) continue;
    if (dist(p, line.p1) < CLADDING_LIMITS.lineEndSnapCm) return { ...line.p1 };
  }
  return p;
}

/** Комната, содержащая обе точки линии (бандл: точка mousedown ищется в ROOMS2). */
function roomOfLine(model: Model, a: Point, b: Point): { id: string; poly: Point[] } | null {
  const rooms = roomsMapOf(model) ?? {};
  for (const [rid, room] of Object.entries(rooms)) {
    const poly = roomPolygonOf(room);
    if (!poly || poly.length < 3) continue;
    if (pointInPolygon(a, poly, 0.5) && pointInPolygon(b, poly, 0.5)) return { id: rid, poly };
  }
  return null;
}

/**
 * cladding_add: линия обшивки ГКЛ внутри одной комнаты (этап 354).
 * Концы магнитятся к рёбрам комнаты (5 см) и свободным концам других линий
 * (10 см), как в редакторе. Атомарность обеспечивает ws.apply.
 */
export function addCladding(
  model: Model,
  params: { fromMm: Point; toMm: Point },
): { id: string; room_id: string; length_mm: number } {
  const from = { x: mmToCm(params.fromMm.x), y: mmToCm(params.fromMm.y) };
  const to = { x: mmToCm(params.toMm.x), y: mmToCm(params.toMm.y) };
  if (!Number.isFinite(from.x) || !Number.isFinite(from.y) || !Number.isFinite(to.x) || !Number.isFinite(to.y)) {
    throw new McpError("INVALID_ARGUMENT", "from_mm/to_mm должны быть конечными числами", {
      details: { kind: "cladding_points_invalid" },
    });
  }
  const room = roomOfLine(model, from, to);
  if (!room) {
    throw new McpError("INVALID_ARGUMENT", "линия обшивки должна лежать внутри одной комнаты (оба конца)", {
      hint: "обшивка ГКЛ строится внутри комнаты листа «Перегородки», как в редакторе (cladding__in_room_only)",
      details: { kind: "cladding_outside_room" },
    });
  }
  const lenMm = dist(from, to) * 10;
  if (lenMm < CLADDING_LIMITS.minLineMm) {
    throw new McpError("INVALID_ARGUMENT", `линия обшивки ${Math.round(lenMm)} мм короче минимальной ${CLADDING_LIMITS.minLineMm} мм`, {
      details: { kind: "cladding_too_short", length_mm: Math.round(lenMm) },
    });
  }
  const p1 = snapEndpoint(model, from);
  const p2 = snapEndpoint(model, to);
  // пересечение другой линии обшивки — отказ (соединение концами — можно)
  for (const [oid, line] of Object.entries(claddingsOf(model))) {
    const shared =
      dist(line.p1, p1) <= 0.05 || dist(line.p1, p2) <= 0.05 || dist(line.p2, p1) <= 0.05 || dist(line.p2, p2) <= 0.05;
    if (!shared && segsCross(p1, p2, line.p1, line.p2)) {
      throw new McpError("INVALID_ARGUMENT", `линия обшивки пересекает линию ${oid} — как в редакторе (cladding__dont_cross_other_cladding)`, {
        hint: "линии обшивки могут соединяться только концами",
        details: { kind: "cladding_cross", other_id: oid },
      });
    }
  }
  // линия внутри комнаты (в вогнутой комнате хорда через выемку — отказ)
  if (!segmentInsidePolygon(p1, p2, room.poly)) {
    throw new McpError("INVALID_ARGUMENT", "линия обшивки проходит вне комнаты", {
      details: { kind: "cladding_outside_room" },
    });
  }
  const id = newId();
  const rec: CladdingRec = {
    id,
    p1: { x: r2(p1.x), y: r2(p1.y) },
    p2: { x: r2(p2.x), y: r2(p2.y) },
  };
  rec.pc = { x: r2((rec.p1.x + rec.p2.x) / 2), y: r2((rec.p1.y + rec.p2.y) / 2) };
  model.claddings ??= {};
  model.claddings[id] = rec;
  // как в редакторе (draw/addHole режут линии обшивки у проёмов): линия,
  // пересекающая обе линии откоса проёма в полосе 51 см от грани стены, режется
  // на куски с доборными отрезками до грани — иначе normalize редактора режет её
  // сам и save блокируется (пробы 354-replan2-live dev, dbg4/dbg5)
  for (const wall of Object.values(model.walls)) {
    for (const hole of Object.values(wall.holes ?? {})) {
      const span = holeSpanOf(wall, hole);
      if (span) cutCladdingLinesForHole(model, wall, span, new Set([id]));
    }
  }
  const stored = model.claddings[id] ?? null;
  return { id, room_id: room.id, length_mm: cmToMm(dist(stored ? stored.p1 : rec.p1, stored ? stored.p2 : rec.p2)) };
}

/**
 * Резка линий обшивки у проёма (порт поведения редактора, бандл addHole ~108400):
 * линии обшивки, пересекающие ОБЕ линии откосов проёма (продолжение боковых кромок
 * проёма в комнату на 51 см от грани стены), режутся: средняя часть (в габарите
 * проёма) удаляется, у краёв добавляются отрезки от точки реза до угла проёма на
 * грани стены (у редактора они hasHole). Линия, доставшая только до одного откоса,
 * не режется (закреплено живой пробой: аноним, дверь 1600..2400 при линии до 2000 —
 * без реза). Вызывается из cladding_add (для новой линии) и opening_add (для
 * нового проёма); поведение идемпотентно — куски, не пересекающие оба откоса,
 * не трогаются.
 * Возвращает число сделанных резов.
 */
export function cutCladdingLinesForHole(model: Model, wall: Wall, holeSpanCm: [number, number], onlyIds?: Set<string>): number {
  const depth = wall.depth;
  if (!(depth > 0)) return 0;
  const len = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
  if (len < 1e-9) return 0;
  const ux = (wall.p2.x - wall.p1.x) / len;
  const uy = (wall.p2.y - wall.p1.y) / len;
  const nx = -uy;
  const ny = ux;
  const [lo, hi] = holeSpanCm;
  if (!(hi - lo > 0.5)) return 0;
  const p1a = { x: wall.p1.x + ux * lo, y: wall.p1.y + uy * lo };
  const p2a = { x: wall.p1.x + ux * hi, y: wall.p1.y + uy * hi };
  let cuts = 0;
  for (const side of [-1, 1] as const) {
    const f1 = { x: p1a.x + nx * (depth / 2) * side, y: p1a.y + ny * (depth / 2) * side };
    const f2 = { x: p2a.x + nx * (depth / 2) * side, y: p2a.y + ny * (depth / 2) * side };
    const e1 = { x: f1.x + nx * REVEAL_EXTEND_CM * side, y: f1.y + ny * REVEAL_EXTEND_CM * side };
    const e2 = { x: f2.x + nx * REVEAL_EXTEND_CM * side, y: f2.y + ny * REVEAL_EXTEND_CM * side };
    for (const [key, line] of Object.entries(model.claddings ?? {})) {
      if (onlyIds && !onlyIds.has(String(line.id ?? key))) continue;
      const cut = cutLineAtJambs(line, f1, e1, f2, e2);
      if (!cut) continue;
      const { piece1, piece2, reveal1, reveal2 } = cut;
      const replacement: CladdingRec[] = [];
      for (const piece of [piece1, piece2]) {
        if (piece && dist(piece.p1, piece.p2) > 0.05) replacement.push(piece);
      }
      for (const reveal of [reveal1, reveal2]) {
        if (dist(reveal.p1, reveal.p2) > 0.05) replacement.push(reveal);
      }
      delete model.claddings![key];
      for (const rec of replacement) {
        rec.pc = { x: r2((rec.p1.x + rec.p2.x) / 2), y: r2((rec.p1.y + rec.p2.y) / 2) };
        model.claddings![rec.id] = rec;
      }
      cuts++;
    }
  }
  if (Object.keys(model.claddings ?? {}).length === 0) delete model.claddings;
  return cuts;
}

/** Диапазон проёма на оси стены, см (как holeRange openings — локально, чтобы не
 *  создавать runtime-цикл openings ↔ claddings; сторож 181-c3b). */
function holeSpanOf(wall: Wall, hole: Record<string, unknown>): [number, number] | null {
  const pc = hole["pc"] as Point | undefined;
  const width = Number(hole["width"] ?? 0);
  if (!pc || !(width > 0)) return null;
  const len = Math.hypot(wall.p2.x - wall.p1.x, wall.p2.y - wall.p1.y);
  if (len < 1e-9) return null;
  const t = ((pc.x - wall.p1.x) * (wall.p2.x - wall.p1.x) + (pc.y - wall.p1.y) * (wall.p2.y - wall.p1.y)) / (len * len);
  const tCm = t * len;
  return [tCm - width / 2, tCm + width / 2];
}

/** Хвост откоса проёма в комнату, см (бандл: pointAtLinePoint(..., 51, side)). */
export const REVEAL_EXTEND_CM = 51;

type CutResult = {
  piece1: CladdingRec | null;
  piece2: CladdingRec | null;
  reveal1: CladdingRec;
  reveal2: CladdingRec;
};

function newRec(p1: Point, p2: Point): CladdingRec {
  return { id: newId(), p1: { x: r2(p1.x), y: r2(p1.y) }, p2: { x: r2(p2.x), y: r2(p2.y) } };
}

/** Рез линии L двумя отрезками откосов [f1,e1] и [f2,e2]: обе точки реза строго
 *  внутри L (t в 0.02..0.98) — иначе линия лишь доставала до одного откоса. */
function cutLineAtJambs(line: CladdingRec, f1: Point, e1: Point, f2: Point, e2: Point): CutResult | null {
  const a = line.p1, b = line.p2;
  const c1 = segCrossPoint(a, b, f1, e1);
  const c2 = segCrossPoint(a, b, f2, e2);
  if (!c1 || !c2) return null;
  if (c1.t < 0.02 || c1.t > 0.98 || c2.t < 0.02 || c2.t > 0.98) return null;
  const [first, second] = c1.t < c2.t ? [c1, c2] : [c2, c1];
  const [fFirst, fSecond] = c1.t < c2.t ? [{ x: f1.x, y: f1.y }, { x: f2.x, y: f2.y }] : [{ x: f2.x, y: f2.y }, { x: f1.x, y: f1.y }];
  return {
    piece1: { ...line, id: line.id ?? newId(), p1: { ...a }, p2: { x: r2(first.p.x), y: r2(first.p.y) } },
    piece2: newRec({ x: r2(second.p.x), y: r2(second.p.y) }, { ...b }),
    reveal1: newRec({ x: r2(first.p.x), y: r2(first.p.y) }, fFirst),
    reveal2: newRec({ x: r2(second.p.x), y: r2(second.p.y) }, fSecond),
  };
}

/** Точка пересечения отрезков ab × cd (null — нет в пределах обоих отрезков). */
function segCrossPoint(a: Point, b: Point, c: Point, d: Point): { p: Point; t: number } | null {
  const d1x = b.x - a.x, d1y = b.y - a.y;
  const d2x = d.x - c.x, d2y = d.y - c.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * d2y - (c.y - a.y) * d2x) / den;
  const s = ((c.x - a.x) * d1y - (c.y - a.y) * d1x) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || s < -1e-9 || s > 1 + 1e-9) return null;
  return { p: { x: a.x + d1x * t, y: a.y + d1y * t }, t };
}

/**
 * cladding_remove: удалить линию обшивки по id сайта или метке CL<n>
 * (нумерация — claddingList, одна для list/compact/remove).
 */
export function removeCladding(model: Model, ref: string): { removed: true } {
  const map = claddingsOf(model);
  if (map[ref]) {
    delete model.claddings![ref];
    // пустая форма ОБЯЗАТЕЛЬНО остаётся ({}), а не удаляется: $Claddings.restore
    // редактора при отсутствующем ключе сохраняет прежние lines того же экземпляра
    // редактора, и удаление возвращает их при normalize (найдено живой пробой
    // 354-cleanup: удалённые линии возвращались на save)
    if (Object.keys(model.claddings!).length === 0) model.claddings = {};
    return { removed: true };
  }
  const m = /^CL(\d+)$/.exec(ref);
  if (m) {
    const entry = claddingList(model)[Number(m[1]) - 1];
    if (entry && entry["site_id"]) return removeCladding(model, String(entry["site_id"]));
  }
  throw new McpError("NOT_FOUND", `линия обшивки ${ref} не найдена`, {
    hint: "id — site_id из cladding_add или метка CL<n> из model_get",
    details: { kind: "cladding_not_found", cladding_id: ref },
  });
}

/** Список линий обшивки (мм; метки CL<n> сквозные по комнатам). */
export function claddingList(model: Model, roomRef?: string): Array<Record<string, unknown>> {
  const rooms = roomsMapOf(model) ?? {};
  const allKeys = Object.keys(rooms);
  const wanted = roomRef
    ? new Set(allKeys.filter((rid) => rid === roomRef || `R${allKeys.indexOf(rid) + 1}` === roomRef))
    : null;
  const out: Array<Record<string, unknown>> = [];
  let n = 0;
  for (const [key, line] of Object.entries(claddingsOf(model))) {
    const roomId = allKeys.find((rid) => {
      const poly = roomPolygonOf(rooms[rid]!);
      return poly ? pointInPolygon(line.pc ?? line.p1, poly, 0.5) : false;
    }) ?? null;
    if (wanted && (roomId === null || !wanted.has(roomId))) continue;
    n += 1;
    out.push({
      id: `CL${n}`,
      site_id: line.id ?? key,
      room_id: roomId,
      from_mm: [cmToMm(line.p1.x), cmToMm(line.p1.y)],
      to_mm: [cmToMm(line.p2.x), cmToMm(line.p2.y)],
      length_mm: cmToMm(dist(line.p1, line.p2)),
    });
  }
  return out;
}

// ---------- Семантическая сверка ----------

export type CladdingSig = {
  id: string;
  /** Каноническое направление: p1 ≤ p2 лексикографически (разворот оси — не расхождение). */
  p1: Point;
  p2: Point;
};

const CLAD_TOL_CM = 0.5;

function canonLine(rec: CladdingRec): CladdingSig {
  const { p1, p2 } = rec;
  const rev = p2.x < p1.x || (p2.x === p1.x && p2.y < p1.y);
  return { id: String(rec.id ?? ""), p1: rev ? p2 : p1, p2: rev ? p1 : p2 };
}

function sigsOf(model: Record<string, unknown> | undefined): CladdingSig[] {
  const map = ((model ?? {})["claddings"] ?? {}) as Record<string, CladdingRec>;
  return Object.values(map).map(canonLine);
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= CLAD_TOL_CM && Math.abs(a.y - b.y) <= CLAD_TOL_CM;
}

function sameSig(a: CladdingSig, b: CladdingSig): boolean {
  return samePoint(a.p1, b.p1) && samePoint(a.p2, b.p2);
}

export type CladdingCompareMode = "normalize" | "save";

/**
 * Сверка обшивки ГКЛ (двухрежимная, как demolitionMismatches): линии обязаны
 * сохраниться при normalize и после save. Сопоставление прежде всего по id
 * (редактор сохраняет id — живой раунд-трип 354-replan2-ui4), геометрический
 * запасной путь один-к-одному — редактор может пересоздать id при разрезании
 * линии проёмом (holes режут линии обшивки, hasHole). Производные поля
 * (pc, l1/l2/r1/r2, p1lnk/p2lnk, dlpos) не сверяются.
 */
export function claddingMismatches(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  mode: CladdingCompareMode = "normalize",
): string[] {
  void mode;
  const exp = sigsOf(before);
  const got = sigsOf(after);
  const problems: string[] = [];
  const used = new Set<number>();
  const pairOf = new Map<number, number>();
  for (let i = 0; i < exp.length; i++) {
    const byId = got.findIndex((g, j) => !used.has(j) && g.id === exp[i]!.id && sameSig(g, exp[i]!));
    if (byId >= 0) {
      used.add(byId);
      pairOf.set(i, byId);
    }
  }
  for (let i = 0; i < exp.length; i++) {
    if (pairOf.has(i)) continue;
    const byGeo = got.findIndex((g, j) => !used.has(j) && sameSig(g, exp[i]!));
    if (byGeo >= 0) {
      used.add(byGeo);
      pairOf.set(i, byGeo);
    }
  }
  const mm = (v: number): string => String(Math.round(v * 10));
  for (let i = 0; i < exp.length; i++) {
    if (pairOf.has(i)) continue;
    const e = exp[i]!;
    problems.push(
      `линия обшивки ${e.id} (${mm(e.p1.x)},${mm(e.p1.y)} → ${mm(e.p2.x)},${mm(e.p2.y)} мм) ` +
      (got.some((g) => g.id === e.id) ? "изменилась при операции" : "потеряна при операции"),
    );
  }
  for (let j = 0; j < got.length; j++) {
    if (![...pairOf.values()].includes(j)) {
      const g = got[j]!;
      problems.push(`лишняя линия обшивки ${g.id} (${mm(g.p1.x)},${mm(g.p1.y)} → ${mm(g.p2.x)},${mm(g.p2.y)} мм) после операции`);
    }
  }
  return problems;
}
