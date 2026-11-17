import type { Point } from "./types.ts";
import { matchRoomsByContour, roomHeirs, roomPolygonOf, type FinishMode } from "./finish.ts";

// Надёжность save по комнатам (этап 126, урок ревью 46): прежняя сверка ловила только
// полное исчезновение комнат (N→0). Частичная потеря N→M>0 и потеря пользовательских
// полей комнат проходили с verified=true (fixture editor-corridor-3rooms, mock server
// удаляет одну комнату → verified=true, warnings=[]).
//
// Пользовательские поля комнаты (по эталонам UI и модели редактора):
// - имя/тип помещения — rooms2[rid].zones[0].name (поле name самой комнаты остаётся
//   "none", docs/remplanner-features.md; проба 43-rooms-name-finish: UI пишет и name,
//   и zone_name зоны);
// - состав зон (имя + is_micro_zone у каждой) — микрозоны пользовательские;
// - отделка (floors[0], ceilings[0], decors) — сверяется своим слоем finishCompare
//   (этап 94), здесь не дублируется.
// Производные (не сверяются): id комнаты и зон, area, pc, number_by_area, height
// (следует за высотами стен — покрыто сверкой осей и свойств стен), plan, edges/eds,
// polygon-дубли в floors/ceilings.
//
// Двухрежимная сверка (new-entity-section.md):
// - «normalize» (до записи, локальная модель против normalize): каждая комната
//   нормализованной модели объяснима — точное совпадение контура с теми же
//   пользовательскими полями, либо доказанная топологическая операция редактора
//   (split/merge по классификации площадей, эталоны ui-ref-finish-topo-*; имя при
//   split/merge — предупреждение, эталона наследования нет), всё остальное — потеря;
// - «save» (после записи, GET против нормализованной модели): строго — каждая комната
//   нормализованной модели (по каноническому контуру) есть на сервере с теми же
//   пользовательскими полями; лишние/пропавшие — расхождение.

type RoomRec = {
  polygon?: Point[];
  points?: Point[];
  name?: unknown;
  zones?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type RoomsMap = Record<string, RoomRec>;

function roomsOf(rooms: Record<string, unknown> | undefined): RoomsMap {
  return (rooms ?? {}) as RoomsMap;
}

/**
 * Пользовательские поля комнаты: имя помещения (zones[0].name) и состав зон
 * (имя + is_micro_zone, как мультимножество — порядок редактор вправе менять).
 */
export function roomUserSig(room: unknown): { name: string | null; zones: string[] } {
  const rec = (room ?? {}) as RoomRec;
  const zoneList = Array.isArray(rec.zones) ? rec.zones : [];
  const zones = zoneList
    .map((z) => JSON.stringify([String(z?.["name"] ?? ""), Boolean(z?.["is_micro_zone"])]))
    .sort();
  const name = typeof rec["name"] === "string" ? rec["name"] : null;
  return { name, zones };
}

function sigMismatch(exp: { name: string | null; zones: string[] }, got: { name: string | null; zones: string[] }): string | null {
  // имя: отсутствие поля/зон на ожидаемой стороне не блокирует (редактор вправе
  // достроить зону-классификатор), явное имя/состав обязаны сохраниться
  if (exp.name !== null && got.name !== exp.name) {
    return `имя помещения «${exp.name}» → «${got.name}»`;
  }
  if (exp.zones.length > 0 && JSON.stringify(exp.zones) !== JSON.stringify(got.zones)) {
    return `зоны (имя/микро) ${JSON.stringify(exp.zones)} → ${JSON.stringify(got.zones)}`;
  }
  return null;
}

export type RoomsSaveCompareResult = { problems: string[]; warnings: string[] };

/**
 * Семантическая сверка комнат по каноническому контуру с пользовательскими полями.
 * mode="normalize" — до записи (допустимы только штатные топологии редактора),
 * mode="save" — после записи по GET (строго, без освобождений).
 */
export function roomsSaveCompare(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
  mode: FinishMode,
): RoomsSaveCompareResult {
  const exp = roomsOf(expectedRooms);
  const got = roomsOf(gotRooms);
  const problems: string[] = [];
  const warnings: string[] = [];
  const { pairs: exact } = matchRoomsByContour(expectedRooms, gotRooms);
  const heirOf = roomHeirs(expectedRooms, gotRooms, exact, mode);
  const sameMatch = (rid: string): string | undefined => {
    const h = heirOf.get(rid);
    return h && h.kind === "same" ? h.key : undefined;
  };

  // каждая ожидаемая комната: найдена по контуру и хранит пользовательские поля
  for (const [rid, room] of Object.entries(exp)) {
    const gid = exact.get(rid) ?? sameMatch(rid);
    if (!gid) {
      const heir = heirOf.get(rid) ?? null;
      if (heir && (heir.kind === "split" || heir.kind === "merge")) {
        // штатная топология редактора (эталоны 98); наследование имени зон эталоном
        // не закреплено — предупреждение, а не блокировка
        warnings.push(`room_topology_changed: room ${rid}: ${heir.kind} при нормализации — имя помещения (${roomUserSig(room).name ?? "нет"}) не сверяется, проверьте rooms_list после сохранения`);
        continue;
      }
      problems.push(`room ${rid}: комната исчезла или изменилась при ${mode === "save" ? "сохранении (сервер)" : "нормализации"}`);
      continue;
    }
    const mismatch = sigMismatch(roomUserSig(room), roomUserSig(got[gid]));
    if (mismatch) problems.push(`room ${rid}: ${mismatch}`);
  }

  // лишние комнаты: в режиме save — строго (сервер добавил/вернул лишнюю);
  // в режиме normalize новые комнаты объяснимы только доказанными топологиями
  const claimed = new Set<string>();
  for (const [rid] of Object.entries(exp)) {
    const gid = exact.get(rid) ?? sameMatch(rid);
    if (gid) { claimed.add(gid); continue; }
    const heir = heirOf.get(rid) ?? null;
    if (heir?.kind === "split") for (const k of heir.partKeys) claimed.add(k);
    if (heir?.kind === "merge") claimed.add(heir.key);
  }
  for (const gk of Object.keys(got)) {
    if (claimed.has(gk)) continue;
    if (mode === "save") {
      problems.push(`room ${gk}: лишняя комната на сервере`);
      continue;
    }
    problems.push(`room ${gk}: лишняя комната при нормализации`);
  }
  return { problems, warnings };
}

/** Список расхождений комнат (режим normalize, до записи): пусто — совпало. */
export function roomsNormalizeMismatches(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
): string[] {
  return roomsSaveCompare(expectedRooms, gotRooms, "normalize").problems;
}

/** Список расхождений комнат после save (GET против нормализованной модели). */
export function roomsSaveMismatches(
  expectedRooms: Record<string, unknown> | undefined,
  gotRooms: Record<string, unknown> | undefined,
): string[] {
  return roomsSaveCompare(expectedRooms, gotRooms, "save").problems;
}

// re-export для workspace/тестов: полигон комнаты записи
export { roomPolygonOf };
