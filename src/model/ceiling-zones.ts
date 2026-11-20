import type { Model, Point } from "./types.ts";
import { newId } from "./types.ts";
import { roomPolygonOf, pointInPolygon, distToSeg, overlapShare, polygonEdgesOf } from "./room-geo.ts";
import { collinearOverlapCm } from "./geometry.ts";
import { zoneCeilingDelimiterLines } from "./zone-delimiters.ts";
import { McpError } from "../errors.ts";

// Пересчёт зон потолка комнаты (этап 310, m11 ревью 304): ставит модель в то
// состояние, которое редактор получает вызовом Room2.updateZones("ceiling") +
// restoreCeiling при действии пользователя с потолочной закладной или
// zone_ceiling-делителем (обработчики #cm-ceiling-rigel--width/remove и
// restoreCeilingsAfterChangeRigel, бандл 268).
//
// Без этого MCP пишет устаревший контейнер ceilings (одна запись на всю комнату
// с отделкой), а редактор при первом визите на лист «Потолки» перестраивает зоны
// по рёбрам закладных/делителей: запись-«вся комната» не совпадает ни с одной
// новой зоной (arePolygonsEqual / 75 % общих вершин — updateZones) и удаляется,
// отделка молча теряется. MCP воспроизводит тот же пересчёт: зоны — грани
// расположения отрезков (рёбра комнаты, боковые грани закладных, рёбра
// zone_ceiling-делителей и глобальных ригелей внутри комнаты), совпадающие
// записи сохраняются (правила «good» updateZones), отделка нераспознанных записей
// распределяется по новым зонам правилом getZone (restoreCeiling/restoreTotal).
//
// Полигоны записей ceilings — производные (сверка отделки их не читает), но от них
// зависит сопоставление при следующем restore редактора, поэтому считаются честно.

type Rec = Record<string, unknown>;
type Seg = { p1: Point; p2: Point };

const TOL = 0.05; // см: допуск совпадения точек (грань закладной/ребро)
const AREA_EPS = 0.5;

function ptKey(p: Point): string {
  return `${Math.round(p.x * 100)}/${Math.round(p.y * 100)}`;
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= TOL && Math.abs(a.y - b.y) <= TOL;
}

function segLength(s: Seg): number {
  return Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y);
}

/** Точка пересечения отрезков (концы включены), null если её нет. */
function segIntersection(a: Seg, b: Seg): Point | null {
  const d1x = a.p2.x - a.p1.x, d1y = a.p2.y - a.p1.y;
  const d2x = b.p2.x - b.p1.x, d2y = b.p2.y - b.p1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b.p1.x - a.p1.x) * d2y - (b.p1.y - a.p1.y) * d2x) / den;
  const u = ((b.p1.x - a.p1.x) * d1y - (b.p1.y - a.p1.y) * d1x) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.p1.x + d1x * t, y: a.p1.y + d1y * t };
}

function signedArea(poly: Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function removeCollinearPts(poly: Point[]): Point[] {
  if (poly.length < 3) return poly.slice();
  const out: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = out.length > 0 ? out[out.length - 1]! : poly[(i - 1 + poly.length) % poly.length]!;
    const b = poly[i]!;
    const c = poly[(i + 1) % poly.length]!;
    if (out.length > 0 && samePoint(a, b)) continue;
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const len = Math.hypot(c.x - b.x, c.y - b.y) + Math.hypot(b.x - a.x, b.y - a.y);
    if (out.length > 0 && len > 0 && Math.abs(cross) / len <= TOL) continue;
    out.push(b);
  }
  if (out.length >= 2 && samePoint(out[0]!, out[out.length - 1]!)) out.pop();
  return out;
}

/**
 * Грани расположения отрезков внутри полигона комнаты: комната режется рёбрами
 * закладных и делителей (аналог LIB.getPolygonsByLines + removeContainingPolygons).
 * Возвращает полигоны граней (ориентация сохранена), чей центр внутри комнаты
 * и не внутри полигонов-исключений (полоса закладной, глобальный ригель).
 */
function arrangementFaces(roomPoly: Point[], segments: Seg[], exclusion: Point[][]): Point[][] {
  // 1. режем отрезки во всех точках пересечения и концов других отрезков
  type Sub = { a: Point; b: Point };
  const subs: Sub[] = [];
  for (const s of segments) {
    const ts: number[] = [0, 1];
    const vx = s.p2.x - s.p1.x, vy = s.p2.y - s.p1.y;
    const push = (p: Point): void => {
      const l2 = vx * vx + vy * vy;
      if (l2 === 0) return;
      const t = ((p.x - s.p1.x) * vx + (p.y - s.p1.y) * vy) / l2;
      if (t > 1e-7 && t < 1 - 1e-7) ts.push(t);
    };
    for (const o of segments) {
      if (o === s) continue;
      const x = segIntersection(s, o);
      if (x) push(x);
      if (distToSeg(o.p1, s.p1, s.p2) <= TOL) push(o.p1);
      if (distToSeg(o.p2, s.p1, s.p2) <= TOL) push(o.p2);
    }
    ts.sort((p, q) => p - q);
    let prev = s.p1;
    for (let i = 1; i < ts.length; i++) {
      const cur = { x: s.p1.x + vx * ts[i]!, y: s.p1.y + vy * ts[i]! };
      if (segLength({ p1: prev, p2: cur }) > TOL) subs.push({ a: prev, b: cur });
      prev = cur;
    }
  }
  // 2. граф узлов
  const nodes = new Map<string, Point>();
  const adj = new Map<string, Array<{ to: string; dir: Point }>>();
  const nodeOf = (p: Point): string => {
    const k = ptKey(p);
    if (!nodes.has(k)) nodes.set(k, p);
    return k;
  };
  for (const s of subs) {
    const ka = nodeOf(s.a), kb = nodeOf(s.b);
    if (ka === kb) continue;
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
    const len = Math.hypot(dx, dy);
    if (len < TOL) continue;
    const dir = { x: dx / len, y: dy / len };
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka)!.push({ to: kb, dir });
    adj.get(kb)!.push({ to: ka, dir: { x: -dir.x, y: -dir.y } });
  }
  // 3. висячие рёбра (узел степени 1 — конец делителя на грани удалённой закладной,
  // редактор делитель оставляет): граней не образуют и обрывают обход всех граней —
  // отбрасываются итеративно, как в getPolygonsByLines (ревью 311 №7)
  for (;;) {
    const dangling = [...adj.entries()].filter(([, list]) => list.length === 1).map(([u]) => u);
    if (dangling.length === 0) break;
    for (const u of dangling) {
      const list = adj.get(u)!;
      if (list.length !== 1) continue;
      const e = list[0]!;
      adj.set(u, []);
      const other = adj.get(e.to);
      if (other) {
        const i = other.findIndex((o) => o.to === u);
        if (i >= 0) other.splice(i, 1);
      }
    }
  }
  // 4. обход граней: из каждого направленного ребра — следующий поворот
  // по часовой (минимальный угол от обратного направления)
  const used = new Set<string>();
  const faces: Point[][] = [];
  const startDir = (u: string, v: string): Point => {
    const pu = nodes.get(u)!, pv = nodes.get(v)!;
    return { x: pv.x - pu.x, y: pv.y - pu.y };
  };
  for (const [u, edges] of adj) {
    for (const e of edges) {
      const key = `${u}>${e.to}`;
      if (used.has(key)) continue;
      const face: string[] = [];
      let cu = u, cv = e.to;
      let guard = 0;
      let ok = true;
      for (;;) {
        const dk = `${cu}>${cv}`;
        if (used.has(dk)) { ok = face.length > 0 && dk === `${u}>${e.to}`; break; }
        used.add(dk);
        face.push(cu);
        if (guard++ > 512) { ok = false; break; }
        const incoming = startDir(cv, cu); // направление «назад»
        const outs = adj.get(cv) ?? [];
        let best: { to: string } | null = null;
        let bestAngle = Infinity;
        for (const o of outs) {
          if (o.to === cu && samePoint(nodes.get(o.to)!, nodes.get(cu)!)) continue;
          const ang = Math.atan2(o.dir.y, o.dir.x);
          const inAng = Math.atan2(incoming.y, incoming.x);
          let d = inAng - ang; // поворот по часовой от обратного направления
          while (d <= 1e-9) d += 2 * Math.PI;
          while (d > 2 * Math.PI) d -= 2 * Math.PI;
          if (d < bestAngle) { bestAngle = d; best = o; }
        }
        if (!best) { ok = false; break; }
        const nu = cv, nv = best.to;
        if (nu === u && nv === cv && face.length > 0) { break; }
        cu = nu; cv = nv;
        if (cu === u && cv === e.to) break;
        if (cu === u) { // замкнулись в стартовом узле по другому ребру — грань невалидна
          ok = false; break;
        }
      }
      if (!ok || face.length < 3) continue;
      const poly = face.map((k) => nodes.get(k)!);
      const area = signedArea(poly);
      if (area <= 1) continue; // внешняя грань (обратный обход) и вырожденные
      // центр грани
      const c = interiorPoint(poly);
      if (!c) continue;
      let inside = pointInPolygon(c, roomPoly);
      if (inside) {
        for (const ex of exclusion) {
          if (pointInPolygon(c, ex)) { inside = false; break; }
        }
      }
      if (!inside) continue;
      faces.push(poly);
    }
  }
  // дедупликация (одна грань может быть найдена с разных рёбер при разрыве обхода)
  const seen = new Set<string>();
  const out: Point[][] = [];
  for (const f of faces) {
    const key = f.map((p) => ptKey(p)).sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** Точка строго внутри полигона (get_point_in_polygon_2 редактора): центр вершин
 *  не подходит для вогнутых зон — сетка по bbox с запасом от границы. */
function interiorPoint(poly: Point[]): Point | null {
  const avg = poly.reduce((acc, p) => ({ x: acc.x + p.x / poly.length, y: acc.y + p.y / poly.length }), { x: 0, y: 0 });
  if (pointInPolygon(avg, poly)) {
    let minEdge = Infinity;
    for (let i = 0; i < poly.length; i++) {
      minEdge = Math.min(minEdge, distToSeg(avg, poly[i]!, poly[(i + 1) % poly.length]!));
    }
    if (minEdge > TOL) return avg;
  }
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const n = 24;
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < n; j++) {
      const p = { x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * j) / n };
      if (!pointInPolygon(p, poly)) continue;
      let minEdge = Infinity;
      for (let k = 0; k < poly.length; k++) {
        minEdge = Math.min(minEdge, distToSeg(p, poly[k]!, poly[(k + 1) % poly.length]!));
      }
      if (minEdge > TOL) return p;
    }
  }
  return null;
}

/** Правило «good» updateZones: запись совпадает с новой зоной целиком (упрощённые
 *  полигоны равны) или по площади с ≥75 % общих вершин — порог от НОВОЙ зоны
 *  (бандл 268: countCommonPointsOfPolygons(C,y) >= .75*C.length, C — новая зона;
 *  ревью 311 №8). */
function zoneMatchesNew(oldPoly: Point[], newPoly: Point[]): boolean {
  const o = removeCollinearPts(oldPoly);
  const n = removeCollinearPts(newPoly);
  if (o.length < 3 || n.length < 3) return false;
  const eq = (a: Point[], b: Point[]): boolean => {
    if (a.length !== b.length) return false;
    const key = (p: Point): string => `${Math.round(p.x * 10)}:${Math.round(p.y * 10)}`;
    for (let start = 0; start < a.length; start++) {
      let ok = true;
      for (let i = 0; i < a.length; i++) {
        if (key(a[(start + i) % a.length]!) !== key(b[i]!)) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  };
  if (eq(o, n)) return true;
  const areaOld = Math.abs(signedArea(o)), areaNew = Math.abs(signedArea(n));
  if (Math.abs(areaOld - areaNew) >= AREA_EPS) return false;
  let common = 0;
  for (const p of n) {
    for (const q of o) {
      if (samePoint(p, q)) { common += 1; break; }
    }
  }
  return common >= Math.floor(0.75 * n.length);
}

/** Правило getZone (restoreCeiling): номер зоны-кандидата для сохранённой записи
 *  или null. Кандидат: площадь ≥ трети сохранённой, ≥ половины вершин зоны внутри
 *  сохранённого полигона, ≥2 (и ≥ половины) совпадающих рёбер; максимум очков. */
function getZoneIndex(savedPoly: Point[], zones: Point[][]): number | null {
  const saved = removeCollinearPts(savedPoly);
  if (saved.length < 3) return null;
  const areaSaved = Math.abs(signedArea(saved));
  const savedEdges = edgeList(saved);
  let best: { score: number; index: number } | null = null;
  for (let zi = 0; zi < zones.length; zi++) {
    const zone = removeCollinearPts(zones[zi]!);
    if (zone.length < 3) continue;
    const areaZone = Math.abs(signedArea(zone));
    if (!(areaZone >= areaSaved / 3 - 1e-6)) continue;
    let insideCount = 0;
    for (const p of zone) if (pointInPolyInclusive(saved, p)) insideCount += 1;
    if (insideCount * 2 < zone.length) continue;
    const zoneEdges = edgeList(zone);
    let score = 0;
    for (const ze of zoneEdges) {
      let matched = false;
      for (const se of savedEdges) {
        if (samePoint(ze.c, se.c)) { matched = true; break; }
        if (shareEndpoint(ze, se) && (pointOnSegInclusive(se, ze.c) || pointOnSegInclusive(ze, se.c))) { matched = true; break; }
      }
      if (!matched && pointInPolyInclusive(saved, ze.c)) score += 1;
      else if (matched) score += 1;
    }
    if (score < 2 || score * 2 < zoneEdges.length) continue;
    // среди равных очков редактор берёт ПОСЛЕДНИЙ индекс (sort по возрастанию
    // distance, [length-1]; ревью 311 №8)
    if (!best || score >= best.score) best = { score, index: zi };
  }
  return best ? best.index : null;
}

type EdgeRec = { p1: Point; p2: Point; c: Point };
function edgeList(poly: Point[]): EdgeRec[] {
  const out: EdgeRec[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i]!, p2 = poly[(i + 1) % poly.length]!;
    out.push({ p1, p2, c: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } });
  }
  return out;
}
function shareEndpoint(a: EdgeRec, b: EdgeRec): boolean {
  return samePoint(a.p1, b.p1) || samePoint(a.p1, b.p2) || samePoint(a.p2, b.p1) || samePoint(a.p2, b.p2);
}
function pointOnSegInclusive(s: EdgeRec, p: Point): boolean {
  return distToSeg(p, s.p1, s.p2) <= 0.05;
}
function pointInPolyInclusive(poly: Point[], p: Point): boolean {
  if (pointInPolygon(p, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    if (distToSeg(p, poly[i]!, poly[(i + 1) % poly.length]!) <= TOL) return true;
  }
  return false;
}

/** Поля записи потолка, которые переносит restoreCeiling редактора (niches —
 *  НЕ здесь: ниши переносятся по геометрии, restoreNichesByGeometry — ревью 311 №4). */
const CEILING_USER_FIELDS = [
  "material", "level", "level2", "material2", "type", "profile", "complex", "radius",
  "offset", "anchor", "type_laying", "angle", "custom_angle", "interval", "width",
  "height", "height_rail", "on_interval",
] as const;

/** Округление полигона записи до 0.01 см (единый помощник — упрощение ревью 311). */
function roundPoly(poly: Point[]): Point[] {
  return poly.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }));
}

/**
 * Пересчитать ceilings комнаты по рёбрам закладных и zone_ceiling-делителей
 * (Room2.updateZones("ceiling") + restoreCeiling). Вызывается после
 * ceiling_rigel_add/update/delete и zone_ceiling_add/remove. Комната без контура
 * или без полей ceilings не меняется.
 *
 * Закарнизные ниши (ревью 311 №4): как в редакторе (updateZones сбрасывает
 * niches[] и зовёт restoreCeilingNiches), ниши не копируются по индексу рёбер —
 * они переносятся ПО ГЕОМЕТРИИ: контейнер ниши ставится в запись, чьё ребро
 * коллинеарно линии ниши и перекрывает её. Ниша, не ложащаяся ни на одно ребро
 * новых зон, — консервативный отказ с подсказкой finish_ceiling_niche_remove
 * (молчаливо стирать вложенное нельзя).
 */
export function rebuildCeilingZones(model: Model, roomId: string): void {
  const rooms = (model.rooms2 ?? model.rooms1 ?? {}) as Record<string, Rec>;
  const room = rooms[roomId];
  if (!room) return;
  const roomPoly = roomPolygonOf(room);
  if (!roomPoly || roomPoly.length < 3) return;
  if (!Array.isArray(room.ceilings)) room.ceilings = [{ exist: false }];
  const oldRecords = (room.ceilings as Rec[]).filter((c) => c && typeof c === "object");

  // отрезки-разделители: рёбра комнаты (кроме «пятен» ГКЛ), боковые грани закладных
  // комнаты, рёбра zone_ceiling-делителей комнаты, рёбра глобальных ригелей,
  // пересекающих комнату (updateZones: RIGELS + this.rigels)
  const segments: Seg[] = [];
  const edges = Array.isArray(room.edges) ? (room.edges as Array<Rec>) : [];
  for (const e of edges) {
    if (e["material"] === "gypsum_sm") continue;
    const p1 = e["p1"] as Point | undefined, p2 = e["p2"] as Point | undefined;
    if (p1 && p2) segments.push({ p1, p2 });
  }
  const rigelPolys: Point[][] = [];
  const rigels = (room.rigels ?? {}) as Record<string, Rec>;
  for (const rg of Object.values(rigels)) {
    const poly = rg["polygon"] as Point[] | undefined;
    if (!poly || poly.length < 4) continue;
    rigelPolys.push(poly);
    // боковые грани: [l1,l2,r2,r1] → l1-l2 и r2-r1
    segments.push({ p1: poly[0]!, p2: poly[1]! });
    segments.push({ p1: poly[2]!, p2: poly[3]! });
  }
  const globalRigels = (model.rigels ?? {}) as Record<string, Rec>;
  for (const rg of Object.values(globalRigels)) {
    const poly = rg["polygon"] as Point[] | undefined;
    if (!poly || poly.length < 3) continue;
    // рёбра, чей центр внутри комнаты или которые её пересекают (updateZones)
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i]!, p2 = poly[(i + 1) % poly.length]!;
      const c = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      if (pointInPolygon(c, roomPoly)) segments.push({ p1, p2 });
    }
    rigelPolys.push(poly);
  }
  // zone_ceiling-делители комнаты — общий слой delimiterMapOf + миграция legacy
  // (per-room delimiters, points-форма, записи без plan; ревью 311 №6): редактор
  // (restoreTotal: updateZones("ceiling","zone_ceiling")) видит их все
  for (const line of zoneCeilingDelimiterLines(model, roomId)) {
    segments.push({ p1: line.p1, p2: line.p2 });
  }

  const faces = arrangementFaces(roomPoly, segments, rigelPolys);
  if (faces.length === 0) return;

  // «good»: сохраняем записи, совпавшие с новыми зонами (полигон обновляется)
  const kept: Array<{ rec: Rec; zone: number }> = [];
  const usedZones = new Set<number>();
  for (const rec of oldRecords) {
    const poly = rec["polygon"] as Point[] | undefined;
    if (!poly || poly.length < 3) continue;
    for (let zi = 0; zi < faces.length; zi++) {
      if (usedZones.has(zi)) continue;
      if (zoneMatchesNew(poly, faces[zi]!)) {
        usedZones.add(zi);
        kept.push({ rec, zone: zi });
        break;
      }
    }
  }
  // распределение отделки выпавших записей по правилу getZone (restoreCeiling):
  // кандидат — любая новая зона, поля записи перезаписываются (как в редакторе)
  const redistributed: Array<{ rec: Rec; zone: number }> = [];
  for (const rec of oldRecords) {
    if (kept.some((k) => k.rec === rec)) continue;
    if (rec["exist"] !== true) continue;
    const poly = rec["polygon"] as Point[] | undefined;
    if (!poly || poly.length < 3) continue;
    let zi = getZoneIndex(poly, faces);
    if (zi === null && faces.length === 1) {
      // запасной путь restoreCeiling редактора (ревью 311 №8): одна сохранённая
      // запись → одна зона при пересечении полигонов (isPolygonsIntersections)
      const face = faces[0]!;
      if (overlapShare(poly, face) > 0 || overlapShare(face, poly) > 0) zi = 0;
    }
    if (zi === null) continue;
    redistributed.push({ rec, zone: zi });
  }

  const byZone = new Map<number, Rec>();
  for (const k of kept) {
    const rec: Rec = { ...structuredClone(k.rec), polygon: roundPoly(faces[k.zone]!), edges: polygonEdgesOf(faces[k.zone]!) };
    byZone.set(k.zone, rec);
  }
  for (const r of redistributed) {
    const existing = byZone.get(r.zone);
    const base: Rec = existing ?? {
      polygon: roundPoly(faces[r.zone]!),
      edges: polygonEdgesOf(faces[r.zone]!),
      exist: false,
    };
    const rec: Rec = { ...base, exist: true, id: typeof r.rec["id"] === "string" ? r.rec["id"] : `_c${newId(8)}` };
    for (const f of CEILING_USER_FIELDS) {
      if (r.rec[f] !== undefined) rec[f] = structuredClone(r.rec[f]);
    }
    byZone.set(r.zone, rec);
  }
  const out: Rec[] = [];
  for (let zi = 0; zi < faces.length; zi++) {
    const rec = byZone.get(zi);
    if (rec) { out.push(rec); continue; }
    out.push({ polygon: roundPoly(faces[zi]!), edges: polygonEdgesOf(faces[zi]!), exist: false });
  }
  // карта «старая запись → индекс зоны-наследника отделки» (kept/redistributed):
  // ниши старой записи переносятся только в запись, которой она досталась
  // (как restoreCeiling → restoreCeilingNiches(old, room.ceilings[e]) редактора)
  const heirZoneOf = new Map<Rec, number>();
  for (const k of kept) heirZoneOf.set(k.rec, k.zone);
  for (const r of redistributed) if (!heirZoneOf.has(r.rec)) heirZoneOf.set(r.rec, r.zone);
  restoreNichesByGeometry(oldRecords, out, heirZoneOf);
  room.ceilings = out;
}

/**
 * Порт restoreCeilingNiches + restoreCeilingNiche (режим 4) редактора
 * (ревью 311 №4, уточнение 313 №4): ниши старой записи переносятся ТОЛЬКО в
 * запись-наследника её отделки (heirZoneOf — kept/redistributed цель), на рёбра
 * этой записи. Режим 4: конец части, совпавший с концом старого ребра,
 * перепривязывается к концу нового ребра, иной конец проецируется на прямую
 * нового ребра, затем LIB.crossLine обрезает линию части по новому ребру
 * (сверено с бандлом 268). Ниша без наследника или без подходящего ребра —
 * отказ с подсказкой finish_ceiling_niche_remove (не молча и не на чужое ребро).
 */
function restoreNichesByGeometry(oldRecords: Rec[], newRecords: Rec[], heirZoneOf: Map<Rec, number>): void {
  type NicheItem = { from: Rec; container: Rec; line: { p1: Point; p2: Point }; edgeLine: { p1: Point; p2: Point } | null };
  const items: NicheItem[] = [];
  for (const old of oldRecords) {
    const niches = old["niches"];
    if (!Array.isArray(niches)) continue;
    const oldEdges = Array.isArray(old["edges"]) ? old["edges"] as Array<{ p1?: Point; p2?: Point }> : [];
    niches.forEach((n, idx) => {
      const cont = n as Rec | undefined;
      if (!cont || cont["exist"] !== true) return;
      const parts = (cont["parts"] ?? {}) as Record<string, Rec>;
      const part = Object.values(parts)[0];
      const partLine = part?.["line"] as { p1?: Point; p2?: Point } | undefined;
      const edge = oldEdges[idx];
      const edgeLine = edge?.p1 && edge?.p2 ? { p1: edge.p1, p2: edge.p2 } : null;
      const line = edgeLine ??
        (partLine?.p1 && partLine?.p2 ? { p1: partLine.p1, p2: partLine.p2 } : null);
      if (line) items.push({ from: old, container: structuredClone(cont) as Rec, line, edgeLine });
    });
  }
  if (items.length === 0) return;
  // ниши не копируются из старых записей (даже совпавших) — только перенос по геометрии
  for (const rec of newRecords) delete rec["niches"];
  const eq = (p: Point, q: Point | undefined): boolean =>
    q !== undefined && Math.abs(p.x - q.x) <= 0.5 && Math.abs(p.y - q.y) <= 0.5;
  /** Проекция точки на бесконечную прямую отрезка (LIB.projection на bigLine). */
  const projectOnLine = (p: Point, l: { p1: Point; p2: Point }): Point => {
    const vx = l.p2.x - l.p1.x, vy = l.p2.y - l.p1.y;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-12) return { ...l.p1 };
    const t = ((p.x - l.p1.x) * vx + (p.y - l.p1.y) * vy) / len2;
    return { x: l.p1.x + vx * t, y: l.p1.y + vy * t };
  };
  /** Общая часть двух коллинеарных отрезков (LIB.crossLine) или null. */
  const crossLineSpan = (a: { p1: Point; p2: Point }, b: { p1: Point; p2: Point }): { p1: Point; p2: Point } | null => {
    const vx = a.p2.x - a.p1.x, vy = a.p2.y - a.p1.y;
    const len = Math.hypot(vx, vy);
    if (len < 1e-9) return null;
    const d = (p: Point): number => Math.abs((p.x - a.p1.x) * vy - (p.y - a.p1.y) * vx) / len;
    if (d(b.p1) > TOL || d(b.p2) > TOL) return null; // не на прямой a
    const t = (p: Point): number => ((p.x - a.p1.x) * vx + (p.y - a.p1.y) * vy) / (len * len);
    const lo = Math.max(0, Math.min(t(b.p1), t(b.p2)));
    const hi = Math.min(1, Math.max(t(b.p1), t(b.p2)));
    if (hi - lo <= TOL / len) return null;
    return {
      p1: { x: a.p1.x + vx * lo, y: a.p1.y + vy * lo },
      p2: { x: a.p1.x + vx * hi, y: a.p1.y + vy * hi },
    };
  };
  const placed = new Set<NicheItem>();
  for (const item of items) {
    const zi = heirZoneOf.get(item.from);
    if (zi === undefined) continue; // наследника нет — перенос невозможен (отказ ниже)
    const rec = newRecords[zi]!;
    const edges = Array.isArray(rec["edges"]) ? rec["edges"] as Array<{ p1?: Point; p2?: Point }> : [];
    if (edges.length === 0) continue;
    for (let idx = 0; idx < edges.length; idx++) {
      const e = edges[idx]!;
      if (!e.p1 || !e.p2) continue;
      const edgeSeg = { p1: e.p1, p2: e.p2 };
      const ref = item.edgeLine;
      // режим 4: концы, совпавшие с концами СТАРОГО ребра, → концы нового ребра,
      // иные — проекция на прямую нового ребра; затем обрезка по новому ребру
      const remap = (p: Point): Point =>
        ref && eq(p, ref.p1) ? { ...e.p1! }
        : ref && eq(p, ref.p2) ? { ...e.p2! }
        : projectOnLine(p, edgeSeg);
      const parts = (item.container["parts"] ?? {}) as Record<string, Rec>;
      // ревью 315 F1: ребро-хозяин выбирается по ОТОБРАЖЁННОЙ линии части
      // (как в редакторе режима 4: isCrossLineProjection + непустой crossLine),
      // а не по старому ребру; у частичной ниши линия короче ребра — ребро без
      // перекрытия с ней не хозяин, отказ честный. Перепривязка концов (remap)
      // применяется уже к выбранному ребру — проектор не тянет линию на
      // параллельные рёбра.
      const mappedParts: Array<{ part: Rec; span: { p1: Point; p2: Point } }> = [];
      let host = true;
      for (const part of Object.values(parts)) {
        const pl = part["line"] as { p1?: Point; p2?: Point } | undefined;
        if (!pl?.p1 || !pl?.p2) continue;
        const orig = { p1: pl.p1, p2: pl.p2 };
        if (!crossLineSpan(orig, edgeSeg)) {
          host = false;
          break;
        }
        const mapped = { p1: remap(pl.p1), p2: remap(pl.p2) };
        const span = crossLineSpan(mapped, edgeSeg);
        if (!span) {
          host = false;
          break;
        }
        mappedParts.push({ part, span });
      }
      if (!host) continue; // у записи-наследника нет ребра на линии ниши
      if (!Array.isArray(rec["niches"])) rec["niches"] = edges.map(() => ({ exist: false }) as Rec);
      const niches = rec["niches"] as Rec[];
      const setLine = (part: Rec, span: { p1: Point; p2: Point }): void => {
        part["line"] = {
          p1: { x: Math.round(span.p1.x * 100) / 100, y: Math.round(span.p1.y * 100) / 100 },
          p2: { x: Math.round(span.p2.x * 100) / 100, y: Math.round(span.p2.y * 100) / 100 },
        };
        if (typeof rec["id"] === "string") part["id_ceiling"] = rec["id"];
      };
      if (niches[idx]!["exist"] === true) {
        // ревью 315 nit 1: на одном новом ребре части нескольких старых ниш
        // сливаются в один контейнер (как parts + union_part_lines редактора),
        // а не отказ «не ложится на рёбра зоны-наследника» — раскладка «ниша на
        // одной стене в обеих зонах» штатна для finish_ceiling_niche_add
        const target = niches[idx]!;
        const tParts = (target["parts"] ??= {}) as Record<string, Rec>;
        for (const { part, span } of mappedParts) {
          setLine(part, span);
          const key = typeof part["id"] === "string" ? part["id"] : `_ni${newId(8)}`;
          tParts[key] = part;
        }
      } else {
        for (const { part, span } of mappedParts) setLine(part, span);
        niches[idx] = item.container;
      }
      placed.add(item);
      break;
    }
  }
  const lost = items.filter((i) => !placed.has(i));
  if (lost.length > 0) {
    throw new McpError(
      "INVALID_ARGUMENT",
      "закарнизная ниша комнаты не ложится на рёбра зоны-наследника отделки (пересчёт зон при операции с закладной/делителем) — сначала finish_ceiling_niche_remove, затем повторите операцию",
    );
  }
}
