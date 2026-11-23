import { McpError } from "../errors.ts";
import type { PrsFigureEntity } from "../model/projections.ts";
import { prsStateOf } from "../model/projections.ts";
import type { Model } from "../model/types.ts";
import { matchRoomsByContour, roomHeirs } from "../model/room-geo.ts";
import type { RoomRec } from "../model/finish.ts";
import type { VerificationMismatches } from "./types.ts";

/** Результат сверки молдингов/ниш развёрток: problems — расхождения (блокируют
 *  save/verified), warnings — предупреждения (save проходит). */
export type PrsFigureCompare = { problems: VerificationMismatches; warnings: string[] };

/**
 * Сверка молдингов/ниш развёрток после save (этап 389) — семантическая
 * мультимножеством (один-к-одному): ключ — тип, комната (алиас по каноническому
 * полигону комнат), ребро, pc_xd/pc_yd (позиция на развёртке), размеры,
 * depth/width_line, on_size. pc и id НЕ входят: pc — кэш рамки развёрток
 * (редактор пересчитывает при каждой перерисовке развёрток), сопоставление
 * мультимножеством устойчиво к переупорядочиванию и переименованию id.
 */
export function prsFigureUserMismatches(
  expected: { rooms?: Record<string, Record<string, unknown>>; coll?: Record<string, PrsFigureEntity> },
  got: { rooms?: Record<string, Record<string, unknown>>; coll?: Record<string, unknown> },
  title: string,
): PrsFigureCompare {
  const out: string[] = [];
  const inherited: string[] = [];
  const alias = (rooms: Record<string, Record<string, unknown>> | undefined): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [rid, r] of Object.entries(rooms ?? {})) {
      out.set(rid, canonPoly(r["polygon"] ?? r["points"]) || rid);
    }
    return out;
  };
  const aliasE = alias(expected.rooms);
  const aliasG = alias(got.rooms);
  const keyOf = (rec: PrsFigureEntity, aliases: Map<string, string>): string => {
    const prs = (rec.prs ?? {}) as Record<string, unknown>;
    return JSON.stringify({
      type: rec.type ?? null,
      room: typeof prs["room"] === "string" ? (aliases.get(prs["room"]) ?? prs["room"]) : null,
      edge: typeof prs["edge_index"] === "number" ? prs["edge_index"] : null,
      pc_xd: typeof prs["pc_xd"] === "number" ? Math.round(prs["pc_xd"] * 10) / 10 : null,
      pc_yd: typeof prs["pc_yd"] === "number" ? Math.round(prs["pc_yd"] * 10) / 10 : null,
      width: typeof rec.width === "number" ? Math.round(rec.width * 10) / 10 : null,
      height: typeof rec.height === "number" ? Math.round(rec.height * 10) / 10 : null,
      depth: typeof rec.depth === "number" ? Math.round(rec.depth * 10) / 10 : null,
      width_line: typeof rec.width_line === "number" ? Math.round(rec.width_line * 10) / 10 : null,
      on_size: rec.on_size ?? null,
    });
  };
  const want = new Map<string, number>();
  for (const e of Object.values(expected.coll ?? {})) {
    const k = keyOf(e, aliasE);
    want.set(k, (want.get(k) ?? 0) + 1);
  }
  const have = new Map<string, number>();
  for (const g of Object.values(got.coll ?? {})) {
    const k = keyOf(g as PrsFigureEntity, aliasG);
    have.set(k, (have.get(k) ?? 0) + 1);
  }
  for (const [k, n] of want) {
    const h = have.get(k) ?? 0;
    if (h < n) {
      out.push(`${title}: потеряна запись после сохранения (${k}; на сервере ${h} из ${n})`);
    }
  }
  for (const [k, n] of have) {
    const w = want.get(k) ?? 0;
    if (w < n) {
      out.push(`${title}: на сервере лишняя запись (${k}; на сервере ${n}, ожидалось ${w})`);
    }
  }
  // №18 follow-up 392 (находка 4 ревью 395): висячая ссылка prs.room (комнаты
  // нет среди rooms сервера) — ошибка сверки, только если она ПОЯВИЛАСЬ при
  // правке (в expected этой висячей ссылки не было). Унаследованная висячая
  // ссылка (была и в expected) — предупреждение: редактор такие записи терпит
  // (if(this.prs.room){s=ROOMS2[...];if(s){…}}, @255886/@258958 бандла) и сам
  // не удаляет — блокировать save легитимного проекта из-за неё нельзя
  for (const [id, g] of Object.entries(got.coll ?? {})) {
    const prs = ((g as PrsFigureEntity).prs ?? {}) as Record<string, unknown>;
    const room = typeof prs["room"] === "string" ? prs["room"] : "";
    if (room === "" || got.rooms === undefined || got.rooms[room] !== undefined) continue;
    const was = (expected.coll ?? {})[id] as PrsFigureEntity | undefined;
    const wasRoom = ((was?.prs ?? {}) as Record<string, unknown>)["room"];
    const wasDangling = was !== undefined && wasRoom === room && (expected.rooms ?? {})[room] === undefined;
    (wasDangling ? inherited : out).push(`${title}: висячая ссылка prs.room после сохранения — комнаты ${room} нет среди rooms (${title} ${id})`);
  }
  return { problems: out, warnings: inherited };
}

/** Канонический контур комнаты (полигональный алиас, как в probe-sig). */
function canonPoly(poly: unknown): string {
  if (!Array.isArray(poly)) return "";
  const pts = (poly as Array<{ x?: unknown; y?: unknown }>)
    .filter((p) => typeof p?.x === "number" && typeof p?.y === "number")
    .map((p) => ({ x: Math.round((p.x as number) * 10) / 10, y: Math.round((p.y as number) * 10) / 10 }));
  if (pts.length === 0) return "";
  let min = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]!.x < pts[min]!.x || (pts[i]!.x === pts[min]!.x && pts[i]!.y < pts[min]!.y)) min = i;
  }
  return pts.map((p) => `${p.x},${p.y}`).join(";") + `#${min}`;
}

/**
 * Сверка настроек развёрток (prs_hidden/prs_disabled/prs_first) комнат до/после
 * save — по семантике «развёртка ребра комнаты» (edge_index): oid перегенерируется
 * редактором при каждой перерисовке развёрток и при изменении нарезки рёбер.
 * При изменении числа рёбер/развёрток комнаты (wall-операция) редактор переносит
 * настройки по геометрии (restorePrsChangeEdges) — сверка пропускается
 * (консервативно: потерю настроек на wall-операции сверка не ловит).
 *
 * Ключ prs_disabled/prs_first, не совпадающий ни с одним oid edges_prs (находка
 * A ревью 397 — синтетические derived_<i> или устаревший oid), — ошибка сверки,
 * если он ПОЯВИЛСЯ при правке (в expected такого висячего ключа не было), и
 * предупреждение, если он унаследован (был и до правки — как №18 follow-up 392
 * для висячего prs.room: редактор такие ключи игнорирует, блокировать
 * легитимный проект из-за них нельзя).
 */
export function prsSettingsMismatches(
  before: Record<string, Record<string, unknown>> | undefined,
  after: Record<string, Record<string, unknown>> | undefined,
  // №9 follow-up 402: стены для оси «порядок вдоль стены» (edgeSemKeyOf) —
  // walls до/после; wallsAfter по умолчанию = walls
  walls?: Record<string, unknown>,
  wallsAfter?: Record<string, unknown>,
): { problems: VerificationMismatches; warnings: string[] } {
  const out: string[] = [];
  const inherited: string[] = [];
  const b = before ?? {};
  const a = after ?? {};
  const danglingKeysOf = (room: Record<string, unknown>): string[] => {
    const edgesPrs = Array.isArray(room["edges_prs"]) ? (room["edges_prs"] as Array<Record<string, unknown>>) : [];
    const oids = new Set(edgesPrs.map((e) => e["oid"]).filter((v): v is string => typeof v === "string" && v !== ""));
    const keys: string[] = [];
    const disabled = room["prs_disabled"];
    if (disabled !== null && typeof disabled === "object" && !Array.isArray(disabled)) {
      keys.push(...Object.keys(disabled as Record<string, unknown>).filter((k) => !oids.has(k)));
    }
    const first = room["prs_first"];
    if (typeof first === "string" && first !== "" && !oids.has(first)) keys.push(first);
    return keys;
  };
  for (const [rid, rb] of Object.entries(b)) {
    const ra = a[rid];
    if (!ra) continue;
    const edgesB = Array.isArray(rb["edges_prs"]) ? (rb["edges_prs"] as unknown[]).length : 0;
    const edgesA = Array.isArray(ra["edges_prs"]) ? (ra["edges_prs"] as unknown[]).length : 0;
    if (edgesB !== edgesA) continue;
    const hidB = rb["prs_hidden"] === 1;
    const hidA = ra["prs_hidden"] === 1;
    if (hidB !== hidA) {
      out.push(`${rid}: скрытие развёрток изменилось после сохранения (ожидалось ${hidB ? "скрыты" : "показаны"}; на сервере ${hidA ? "скрыты" : "показаны"})`);
    }
    const disB = disabledEdgeSemKeys(rb, walls);
    const disA = disabledEdgeSemKeys(ra, wallsAfter ?? walls);
    if (disB.join(",") !== disA.join(",")) {
      out.push(`${rid}: набор скрытых развёрток изменился после сохранения (ожидалось [${disB.join(",")}]; на сервере [${disA.join(",")}])`);
    }
    const firstB = firstEdgeSemKeyOf(rb, walls);
    const firstA = firstEdgeSemKeyOf(ra, wallsAfter ?? walls);
    if (firstB !== firstA) {
      out.push(`${rid}: «первая» развёртка изменилась после сохранения (ожидалось ${firstB ?? "авто"}; на сервере ${firstA ?? "авто"})`);
    }
    // находка A ревью 397: ключи, не совпадающие ни с одним oid edges_prs
    for (const k of danglingKeysOf(ra)) {
      const wasDangling = danglingKeysOf(rb).includes(k);
      const oidsShown = Array.isArray(ra["edges_prs"])
        ? (ra["edges_prs"] as Array<Record<string, unknown>>).map((e) => String(e["oid"])).join(", ")
        : "нет";
      (wasDangling ? inherited : out).push(
        `${rid}: ключ «${k}» в prs_disabled/prs_first не совпадает ни с одним oid edges_prs` +
        `${wasDangling ? " (унаследован — был в модели до правки)" : ""} — редактор такой ключ не знает ` +
        `(развертки комнаты: ${oidsShown})`,
      );
    }
  }
  return { problems: out, warnings: inherited };
}

/**
 * Предупреждение о ФАКТИЧЕСКОМ сбросе настроек развёрток при wall-операциях
 * (№17 follow-up 392; находка 1 ревью 395): prs-состояние комнат «до → после»
 * сравнивается (prs_hidden/prs_first/prs_disabled — по edge-семантике развёрток),
 * комнаты сопоставляются как в остальных сверках — matchRoomsByContour +
 * roomHeirs (наследник — kind «same», по перекрытию). По бандлу при перестройке
 * комнат (268-app.js@90669) пару получают только комнаты с arePolygonsEqual,
 * остальные Room.delete() + new Room2({id:LIB.id()}) → Restorer.restore_rooms
 * (@93237) → restoreOneToOne/restorePrs (@1014145)/restoreElementPrs (@2863309,
 * перенос prs_disabled/prs_first только на совпавшие линии: тот же pid/side,
 * areLinesEqual или Δдлины < 2); новая комната стартует с prs_disabled={}
 * (конструктор Room2). При изменении контура id может смениться (пары по
 * arePolygonsEqual — 268-app.js@90669), а может и сохраниться (живые прогоны
 * 396: сдвиг контура на 20 мм — id прежний), поэтому точный контур наследника
 * не всегда находит пару. Предупреждение — только при фактическом
 * расхождении prs-состояния; у комнаты без наследника — отдельная формулировка
 * «комната пересоздана» (сверка невозможна). При смене числа граней редактор
 * восстанавливает иначе — restorePrsChangeEdges (@2858382, ветка
 * edges.length!==edges_decors.length @2592793).
 */
export function prsSettingsResetWarnings(before: Model, after: Model): string[] {
  const roomsB = ((before as Record<string, unknown>)["rooms2"] ?? (before as Record<string, unknown>)["rooms1"] ?? {}) as Record<string, RoomRec>;
  const roomsA = ((after as Record<string, unknown>)["rooms2"] ?? (after as Record<string, unknown>)["rooms1"] ?? {}) as Record<string, RoomRec>;
  const { pairs: exact } = matchRoomsByContour(roomsB, roomsA);
  const heirOf = roomHeirs(roomsB, roomsA, exact, "normalize");
  // №9 follow-up 402: ось стены для «порядка вдоль стены» — walls своей модели
  const wallsB = ((before as Record<string, unknown>)["walls"] ?? {}) as Record<string, unknown>;
  const wallsA = ((after as Record<string, unknown>)["walls"] ?? {}) as Record<string, unknown>;
  // находка D ревью 397: состояние «до/после» сравнивается по СТЕНЕ ребра и
  // стороне (pid + room_side), а не по edge_index — пересозданная комната может
  // нумеровать рёбра с другой вершины, и при переносе настроек на ту же стену
  // сравнение по индексу давало бы ложное «сброшены». Находка 4 ревью 400:
  // сравнение — мультимножеством ключей «стена|сторона|порядок вдоль стены»
  // (edgeSemKeyOf): набор «стена|сторона» схлопывал несколько рёбер одной
  // стены и стороны (стена, разрезанная колонной/пилястрой), и при сбросе
  // редактором ОДНОГО из скрытых сегментов предупреждения не было
  const sameState = (rb: RoomRec, ra: RoomRec): boolean => {
    const stB = prsStateOf(rb);
    const stA = prsStateOf(ra);
    if (stB.hidden !== stA.hidden) return false;
    const firstB = stB.firstEdge === null ? null : edgeSemKeyOf(rb, stB.firstEdge, wallsB);
    const firstA = stA.firstEdge === null ? null : edgeSemKeyOf(ra, stA.firstEdge, wallsA);
    if (firstB !== firstA) return false;
    const disB = stB.disabledEdges.map((i) => edgeSemKeyOf(rb, i, wallsB)).sort();
    const disA = stA.disabledEdges.map((i) => edgeSemKeyOf(ra, i, wallsA)).sort();
    return disB.length === disA.length && disB.every((k, i) => k === disA[i]);
  };
  const reset: string[] = [];
  // находка E ревью 397: различаем «наследник не найден» и «наследник не
  // однозначен (разделение/слияние)» — при kind split/merge наследник ЕСТЬ,
  // но сопоставить состояние «до → после» нельзя
  const recreated: Array<{ rid: string; reason: "none" | "ambiguous" }> = [];
  for (const [rid, rb] of Object.entries(roomsB)) {
    const hidden = rb["prs_hidden"] === 1;
    const first = typeof rb["prs_first"] === "string" && rb["prs_first"] !== "";
    const disabled = rb["prs_disabled"];
    const hasDisabled = disabled !== null && typeof disabled === "object" && !Array.isArray(disabled) && Object.keys(disabled as Record<string, unknown>).length > 0;
    if (!hidden && !first && !hasDisabled) continue;
    const exactHeir = exact.get(rid);
    const h = heirOf.get(rid);
    const heirRid = exactHeir ?? (h && h.kind === "same" ? h.key : undefined);
    if (heirRid === undefined) {
      // находка E ревью 397: наследник ЕСТЬ, но не однозначен (split/merge) —
      // отдельная формулировка; наследника нет вовсе — «не найден»
      recreated.push({ rid, reason: h && h.kind !== "same" ? "ambiguous" : "none" });
      continue;
    }
    const ra = roomsA[heirRid];
    // в перечне — id комнат ПОСЛЕ (наследников): их агент проверяет model_get
    if (!ra || !sameState(rb, ra)) reset.push(heirRid);
  }
  const out: string[] = [];
  if (reset.length > 0) {
    out.push(
      `настройки развёрток (prs_hidden/prs_first/prs_disabled) сброшены редактором в комнатах ${reset.join(", ")} ` +
      `(механизм по бандлу: при перестройке комнат редактор пересоздаёт комнату и восстанавливает развёртки ` +
      `через Restorer.restore_rooms → restorePrs/restoreElementPrs, перенося настройки только на совпавшие линии; ` +
      `при смене числа граней — restorePrsChangeEdges); проверьте model_get rooms[].prs`,
    );
  }
  for (const { rid, reason } of recreated) {
    out.push(
      reason === "ambiguous"
        ? `комната ${rid} пересоздана, настройки развёртки проверьте (наследник не однозначен — разделение/слияние комнат, сверка prs «до → после» невозможна); проверьте model_get rooms[].prs`
        : `комната ${rid} пересоздана, настройки развёртки проверьте (наследник не найден — сверка prs «до → после» невозможна); проверьте model_get rooms[].prs`,
    );
  }
  return out;
}

/**
 * Ключ ребра «стена|сторона|порядок вдоль стены» (находки 4/8 ревью 400):
 * стена может быть разрезана колонной/пилястрой на несколько рёбер одной
 * стороны — ключ «pid|room_side» (находка D ревью 397) схлопывал такие рёбра
 * в один элемент набора и пропускал сброс части сегментов. Порядок —
 * ПОЛОЖЕНИЕ ребра на стене: проекция середины ребра на ось стены
 * walls[pid].p1→p2, номер среди рёбер той же стены и стороны по этому
 * расстоянию (№9 follow-up 402: при пересозданной комнате обход контура может
 * начаться МЕЖДУ сегментами разрезанной стены — индексы обхода сегментов
 * меняются местами 0↔1, положение на стене — нет; раньше это давало ложное
 * «сброшены» в sameState и ложную problem в prsSettingsMismatches). Ось
 * канонически ориентирована (инвариант к смене p1↔p2 записи стены). Стена
 * неизвестна/вырождена или у ребра нет p1/p2 — прежний порядок обхода.
 */
function edgeSemKeyOf(room: Record<string, unknown>, edgeIndex: number, walls?: Record<string, unknown>): string {
  const edges = Array.isArray(room["edges"]) ? (room["edges"] as Array<Record<string, unknown>>) : [];
  const pidOf = (e?: Record<string, unknown>): string => String(e?.["pid"] ?? "");
  const sideOf = (e?: Record<string, unknown>): string => String(e?.["room_side"] ?? "");
  const pid = pidOf(edges[edgeIndex]);
  const side = sideOf(edges[edgeIndex]);
  const ptOf = (o: unknown): { x: number; y: number } | null => {
    const p = o as { x?: unknown; y?: unknown } | undefined;
    return p && typeof p.x === "number" && typeof p.y === "number" ? { x: p.x, y: p.y } : null;
  };
  const wall = walls?.[pid] as { p1?: unknown; p2?: unknown } | undefined;
  const w1 = ptOf(wall?.p1);
  const w2 = ptOf(wall?.p2);
  if (w1 && w2) {
    let dx = w2.x - w1.x;
    let dy = w2.y - w1.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-9) {
      // каноническая ориентация оси: проекция не зависит от направления записи стены
      if (dx < 0 || (dx === 0 && dy < 0)) {
        dx = -dx;
        dy = -dy;
      }
      const ux = dx / len;
      const uy = dy / len;
      const projOf = (i: number): number | null => {
        const p1 = ptOf(edges[i]?.["p1"]);
        const p2 = ptOf(edges[i]?.["p2"]);
        if (!p1 || !p2) return null;
        return Math.round((((p1.x + p2.x) / 2) * ux + ((p1.y + p2.y) / 2) * uy) * 1000) / 1000;
      };
      const me = projOf(edgeIndex);
      if (me !== null) {
        let n = 0;
        for (let i = 0; i < edges.length; i++) {
          if (i === edgeIndex || pidOf(edges[i]) !== pid || sideOf(edges[i]) !== side) continue;
          const p = projOf(i);
          if (p !== null && (p < me || (p === me && i < edgeIndex))) n++;
        }
        return `${pid}|${side}|${n}`;
      }
    }
  }
  let n = 0;
  for (let i = 0; i < edgeIndex && i < edges.length; i++) {
    if (pidOf(edges[i]) === pid && sideOf(edges[i]) === side) n++;
  }
  return `${pid}|${side}|${n}`;
}

/** Скрытые развёртки комнаты мультимножеством ключей edgeSemKeyOf (sorted). */
function disabledEdgeSemKeys(room: Record<string, unknown>, walls?: Record<string, unknown>): string[] {
  const disabled = room["prs_disabled"];
  if (!disabled || typeof disabled !== "object" || Array.isArray(disabled)) return [];
  const oids = new Set(Object.keys(disabled as Record<string, unknown>));
  const out: string[] = [];
  const edgesPrs = Array.isArray(room["edges_prs"]) ? (room["edges_prs"] as Array<Record<string, unknown>>) : [];
  for (const e of edgesPrs) {
    if (typeof e["oid"] === "string" && oids.has(e["oid"]) && typeof e["edge_index"] === "number") {
      out.push(edgeSemKeyOf(room, e["edge_index"], walls));
    }
  }
  return out.sort();
}

/** «Первая» развёртка комнаты ключом edgeSemKeyOf или null (prs_first 0/пусто). */
function firstEdgeSemKeyOf(room: Record<string, unknown>, walls?: Record<string, unknown>): string | null {
  const first = room["prs_first"];
  if (typeof first !== "string" || first === "") return null;
  const edgesPrs = Array.isArray(room["edges_prs"]) ? (room["edges_prs"] as Array<Record<string, unknown>>) : [];
  const e = edgesPrs.find((x) => x["oid"] === first);
  return e && typeof e["edge_index"] === "number" ? edgeSemKeyOf(room, e["edge_index"], walls) : null;
}

// ---------- точка укладки плитки на стене (anchor_decor) ----------

/**
 * Точка начала укладки отделки стены (инструмент anchor_decor листа «Развёртки»,
 * 2-й режим развёрток; НЕ PRO — в разметке анонимного проекта ключ без is_pro,
 * в отличие от anchor_floor). Обработчик бандла (@3393728): a=$DecorLining.
 * get_decor_line(decor_id); a.anchor={p:точка}; a.angle=0 (wall_woodbatten → 90);
 * a.custom_angle=undefined; a.anchor.pc_xd=p.x−xMin полигона развёртки декора,
 * a.anchor.pc_yd=p.y−yMin; пересчёт раскладки (buildLayouts). MCP принимает
 * позицию точки семантически: along_mm — от начала развёртки ребра, height_mm —
 * от низа развёртки (пола); anchor.p пишется в рамке развёрток (кэш, как у
 * молдингов), pc_xd/pc_yd — семантические поля.
 */


/** Сверка точки укладки при save: наличие и семантика (pc_xd/pc_yd) по частям decors. */
export function wallDecorAnchorMismatches(
  before: Record<string, Record<string, unknown>> | undefined,
  after: Record<string, Record<string, unknown>> | undefined,
): string[] {
  const out: string[] = [];
  const b = before ?? {};
  const a = after ?? {};
  const anchorsOf = (room: Record<string, unknown>): string[] => {
    const decors = Array.isArray(room["decors"]) ? (room["decors"] as Array<Record<string, unknown>>) : [];
    const list: string[] = [];
    for (const d of decors) {
      if (!d || d["exist"] !== true) continue;
      const parts = (d["parts"] ?? {}) as Record<string, Record<string, unknown>>;
      for (const part of Object.values(parts)) {
        const anchor = part["anchor"] as Record<string, unknown> | undefined;
        if (!anchor) continue;
        const p = (anchor["p"] ?? {}) as { x?: unknown; y?: unknown };
        list.push(JSON.stringify({
          type: part["type"] ?? null,
          edge: typeof anchor["pc_xd"] === "number" ? Math.round((anchor["pc_xd"] as number) * 10) / 10 : null,
          yd: typeof anchor["pc_yd"] === "number" ? Math.round((anchor["pc_yd"] as number) * 10) / 10 : null,
          px: typeof p["x"] === "number" ? Math.round((p.x as number) * 10) / 10 : null,
          py: typeof p["y"] === "number" ? Math.round((p.y as number) * 10) / 10 : null,
          angle: part["angle"] ?? null,
        }));
      }
    }
    return list.sort();
  };
  for (const rid of Object.keys(b)) {
    if (!a[rid]) continue;
    const ab = anchorsOf(b[rid]!);
    const aa = anchorsOf(a[rid]!);
    if (ab.length !== aa.length || ab.some((v, i) => v !== aa[i])) {
      out.push(`${rid}: точка укладки отделки стены изменилась после сохранения (ожидалось ${ab.join(" | ") || "нет"}; на сервере ${aa.join(" | ") || "нет"})`);
    }
  }
  return out;
}
