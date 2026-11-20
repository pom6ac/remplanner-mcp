// 298: резолюция ревью 297 (.orca-reports/297-review-zones2.md) — №1 major
// (регрессия: legacy-делитель без поля plan выпал из проверки пересечений),
// №2 (remove проверяет тип), №4 (тексты сверки по типу), №5 (рёбра
// material gypsum_sm как в редакторе), №8 (мутации сверки разделителей).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model } from "../../src/model/types.ts";
import {
  addZoneDelimiter,
  addZoneCeiling,
  removeZoneCeiling,
  removeZoneFloor,
  zoneDelimiterCompare,
} from "../../src/model/zone.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

function firstRoomId(m: Model): string {
  const rooms = (m.rooms2 ?? m.rooms1) as Record<string, unknown> | undefined;
  const id = Object.keys(rooms ?? {})[0];
  assert.ok(id, "в фикстуре есть комната");
  return id!;
}

/** Модель с эталонной комнатой-прямоугольником 10..390 × 10..310 (см). */
function modelWithRefRoom(): { m: Model; room: string } {
  const m = baseModel();
  const room = firstRoomId(m);
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  const rec = rooms[room]!;
  rec["polygon"] = [
    { x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 },
  ];
  rec["edges"] = [
    { p1: { x: 390, y: 10 }, p2: { x: 390, y: 310 }, length: 300, side: "r", pid: "wall1" },
    { p1: { x: 390, y: 310 }, p2: { x: 10, y: 310 }, length: 380, side: "t", pid: "wall2" },
    { p1: { x: 10, y: 310 }, p2: { x: 10, y: 10 }, length: 300, side: "l", pid: "wall3" },
    { p1: { x: 10, y: 10 }, p2: { x: 390, y: 10 }, length: 380, side: "b", pid: "wall4" },
  ];
  delete rec["delimiters"];
  delete rec["rigels"];
  return { m, room };
}

const mm = (x: number, y: number) => ({ x: Math.round(x * 10), y: Math.round(y * 10) });

/** Поперечная линия от левого ребра (10,160) до правого (390,160), мм. */
const CROSS_MM = { fromMm: mm(10, 160), toMm: mm(390, 160) };

// ---------- №1: legacy-делитель без plan участвует в проверке пересечений ----------

test("298 №1: legacy d_ceiling без plan (per-room points) — пересекающая линия зон потолка отвергается (как на 8f04b2e)", () => {
  const { m, room } = modelWithRefRoom();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  rooms[room]!["delimiters"] = {
    legacy1: { type: "d_ceiling", points: [{ x: 200, y: 10 }, { x: 200, y: 310 }] },
  };
  assert.throws(() => addZoneCeiling(m, room, CROSS_MM), /пересекает другой разделитель/);
});

test("298 №1: legacy zone_ceiling без plan (points-форма) — то же", () => {
  const { m, room } = modelWithRefRoom();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  rooms[room]!["delimiters"] = {
    legacy1: { type: "zone_ceiling", points: [{ x: 200, y: 10 }, { x: 200, y: 310 }] },
  };
  assert.throws(() => addZoneCeiling(m, room, CROSS_MM), /пересекает другой разделитель/);
});

test("298 №1: legacy без plan другого типа (d_ceiling vs зона пола) — пересекать можно", () => {
  const { m, room } = modelWithRefRoom();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  rooms[room]!["delimiters"] = {
    legacy1: { type: "d_ceiling", points: [{ x: 200, y: 10 }, { x: 200, y: 310 }] },
  };
  assert.doesNotThrow(() => addZoneDelimiter(m, room, { type: "zone_floor", ...CROSS_MM }));
});

// ---------- №2: remove проверяет тип ----------

test("298 №2: zone_floor_remove молча не удаляет разделитель потолка — INVALID_ARGUMENT с подсказкой zone_ceiling_remove", () => {
  const { m, room } = modelWithRefRoom();
  const res = addZoneCeiling(m, room, CROSS_MM);
  assert.ok(res.id, "add вернул id сайта");
  assert.throws(
    () => removeZoneFloor(m, res.id),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      return err.code === "INVALID_ARGUMENT" && /zone_ceiling_remove/.test(err.message ?? "");
    },
  );
  assert.equal(Object.keys(m.zone_delimiters ?? {}).length, 1, "чужой разделитель не удалён");
  assert.equal(removeZoneCeiling(m, res.id).removed, true, "правильный инструмент удаляет");
});

test("299 мелочь: remove по метке ZD<n> при несовпадении типа называет метку, а не site_id", () => {
  const { m, room } = modelWithRefRoom();
  const res = addZoneCeiling(m, room, CROSS_MM);
  assert.throws(
    () => removeZoneFloor(m, "ZD1"),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      return err.code === "INVALID_ARGUMENT" && /ZD1/.test(err.message ?? "") && !(err.message ?? "").includes(res.id);
    },
  );
});

test("318: legacy zone_c — подсказка zone_c_remove (инструмент появился в этапе 318)", () => {
  const legacy = {
    id: "zc", matrix: [[null, { length: 1 }], [{ length: 1 }, null]],
    vertexes: [
      { id: "v1", point: { x: 200, y: 10 }, type: "node" },
      { id: "v2", point: { x: 200, y: 310 }, type: "node" },
    ],
    items: { v1: "node", v2: "node" },
    type: "zone_c", length: 3, id_room: "r1", on_size: 1,
  };
  const exp = { rooms2: { r1: { polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }] } }, zone_delimiters: { zc: legacy } };
  const res = zoneDelimiterCompare(exp, { rooms2: structuredClone(exp.rooms2), zone_delimiters: {} }, "normalize", { affectedRooms: new Set(["r1"]) });
  assert.ok(res.warnings.some((w) => /не сохранил/.test(w)), JSON.stringify(res.warnings));
  assert.ok(res.warnings.some((w) => w.includes("zone_c_remove")), JSON.stringify(res.warnings));
  // у типов с инструментом подсказка остаётся
  const ceil = structuredClone(legacy) as Record<string, unknown>;
  ceil["type"] = "zone_ceiling";
  ceil["plan"] = "ceiling";
  const exp2 = { rooms2: { r1: { polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }] } }, zone_delimiters: { zc: ceil } };
  const res2 = zoneDelimiterCompare(exp2, { rooms2: structuredClone(exp2.rooms2), zone_delimiters: {} }, "normalize", { affectedRooms: new Set(["r1"]) });
  assert.ok(res2.warnings.some((w) => w.includes("zone_ceiling_remove")), JSON.stringify(res2.warnings));
});

// ---------- №3: единый текст магнита ----------

test("298 №3: текст магнита — ребро в 150 мм (ригель 100 мм — только потолок), без путаницы 100/150", () => {
  const { m, room } = modelWithRefRoom();
  assert.throws(
    () => addZoneCeiling(m, room, { fromMm: mm(200, 160), toMm: mm(300, 160) }),
    /from_mm: нет ребра комнаты в 150 мм \(или грани потолочного ригеля в 100 мм\)/,
  );
  assert.throws(
    () => addZoneDelimiter(m, room, { type: "zone_floor", fromMm: mm(200, 160), toMm: mm(300, 160) }),
    /from_mm: нет ребра комнаты в 150 мм — конец не магнитится/,
  );
});

// ---------- №4: тексты сверки по типу зоны ----------

test("298 №4: потеря разделителя зон пола — текст по типу, без «потолка»", () => {
  const rec = {
    id: "f1", matrix: [[null, { length: 1 }], [{ length: 1 }, null]],
    vertexes: [
      { id: "v1", point: { x: 100, y: 160 }, type: "node" },
      { id: "v2", point: { x: 390, y: 160 }, type: "node" },
    ],
    items: { v1: "node", v2: "node" },
    type: "zone_floor", length: 2.9, id_room: "r1", plan: "floor", on_size: 1,
  };
  const exp = { rooms2: { r1: { polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }] } }, zone_delimiters: { f1: structuredClone(rec) } };
  const got = { rooms2: structuredClone(exp.rooms2), zone_delimiters: {} };
  const { problems } = zoneDelimiterCompare(exp, got, "save");
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /потерян разделитель зон \(zone_floor\)/);
  assert.doesNotMatch(problems[0]!, /потолка/);
});

// ---------- №5: рёбра комнаты material gypsum_sm, как в редакторе ----------

const GYPSUM_EDGES = [
  { p1: { x: 390, y: 10 }, p2: { x: 390, y: 310 }, length: 300, side: "r", pid: "wall1" },
  { p1: { x: 390, y: 310 }, p2: { x: 10, y: 310 }, length: 380, side: "t", pid: "wall2" },
  { p1: { x: 10, y: 310 }, p2: { x: 10, y: 10 }, length: 300, side: "l", pid: "wall3" },
  { p1: { x: 10, y: 10 }, p2: { x: 390, y: 10 }, length: 380, side: "b", pid: "wall4" },
  { p1: { x: 200, y: 60 }, p2: { x: 200, y: 260 }, length: 200, side: "g", material: "gypsum_sm" },
];

test("298 №5: ребро комнаты material gypsum_sm не пересечение (бандл: gypsum_sm!==a.material)", () => {
  const { m, room } = modelWithRefRoom();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  rooms[room]!["edges"] = structuredClone(GYPSUM_EDGES);
  assert.doesNotThrow(() => addZoneCeiling(m, room, CROSS_MM), "линия поперёк ГКЛ-пятна допустима");
});

test("298 №5: магнит к ребру material gypsum_sm не срабатывает (268-app.js: gypsum_sm!==v.material)", () => {
  const { m, room } = modelWithRefRoom();
  const rooms = (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
  rooms[room]!["edges"] = structuredClone(GYPSUM_EDGES);
  // конец в 4 см от ГКЛ-ребра — магнит не берёт его (ребро пропущено),
  // других рёбер в 15 см нет → отказ
  assert.throws(
    () => addZoneDelimiter(m, room, { type: "zone_ceiling", fromMm: mm(10, 160), toMm: mm(204, 160) }),
    /не магнитится/,
  );
  // магнит к обычному ребру работает
  assert.doesNotThrow(() => addZoneDelimiter(m, room, { type: "zone_ceiling", fromMm: mm(10, 160), toMm: mm(386, 160) }));
});

// ---------- №8: мутации сверки (доказательство сопоставления) ----------

function twoSame(type: string, plan: string): Record<string, unknown> {
  const mk = (id: string): Record<string, unknown> => ({
    id, matrix: [[null, { length: 1 }], [{ length: 1 }, null]],
    vertexes: [
      { id: `${id}v1`, point: { x: 100, y: 160 }, type: "node" },
      { id: `${id}v2`, point: { x: 390, y: 160 }, type: "node" },
    ],
    items: { [`${id}v1`]: "node", [`${id}v2`]: "node" },
    type, length: 2.9, id_room: "r1", plan, on_size: 1,
  });
  return { rooms2: { r1: { polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }] } }, zone_delimiters: { a: mk("a"), b: mk("b") } };
}

test("298 №8: пропажа одного из двух совпадающих — problem", () => {
  const exp = twoSame("zone_ceiling", "ceiling");
  const got = structuredClone(exp);
  delete (got.zone_delimiters as Record<string, unknown>).b;
  const { problems } = zoneDelimiterCompare(exp, got, "save");
  assert.ok(problems.some((p) => /потерян/.test(p)), JSON.stringify(problems));
});

test("298 №8: смена типа и смена plan при той же геометрии — problem", () => {
  const exp = twoSame("zone_ceiling", "ceiling");
  const gotType = structuredClone(exp);
  for (const z of Object.values(gotType.zone_delimiters as Record<string, Record<string, unknown>>)) z["type"] = "zone_floor";
  assert.ok(zoneDelimiterCompare(exp, gotType, "save").problems.length > 0);
  const gotPlan = structuredClone(exp);
  for (const z of Object.values(gotPlan.zone_delimiters as Record<string, Record<string, unknown>>)) z["plan"] = "floor";
  assert.ok(zoneDelimiterCompare(exp, gotPlan, "save").problems.length > 0);
});

test("298 №8: лишний делитель на сервере в save — problem", () => {
  const exp = twoSame("zone_ceiling", "ceiling");
  const got = structuredClone(exp);
  (got.zone_delimiters as Record<string, unknown>)["extra"] = structuredClone(
    (exp.zone_delimiters as Record<string, Record<string, unknown>>).a,
  );
  const { problems } = zoneDelimiterCompare(exp, got, "save");
  assert.ok(problems.some((p) => /неожиданный разделитель/.test(p)), JSON.stringify(problems));
});

// ---------- 299 M1: сверка сопоставляет записи прежде всего по id ----------
// (живая проба 298-zone-ids: редактор сохраняет id top-level zone_delimiters;
// MCP отдаёт его агенту как site_id, поэтому перестановка/подмена id сервером
// должна быть проблемой, а геометрия — запасным путём для записей с новым id)

function delimRec(id: string, p1: { x: number; y: number }, p2: { x: number; y: number }): Record<string, unknown> {
  return {
    id, matrix: [[null, { length: 1 }], [{ length: 1 }, null]],
    vertexes: [
      { id: `${id}v1`, point: p1, type: "node" },
      { id: `${id}v2`, point: p2, type: "node" },
    ],
    items: { [`${id}v1`]: "node", [`${id}v2`]: "node" },
    type: "zone_ceiling", length: Math.round((Math.hypot(p2.x - p1.x, p2.y - p1.y) / 100) * 100) / 100,
    id_room: "r1", plan: "ceiling", on_size: 1,
  };
}

const ROOM_R1 = { polygon: [{ x: 390, y: 10 }, { x: 390, y: 310 }, { x: 10, y: 310 }, { x: 10, y: 10 }] };
const GA = { p1: { x: 100, y: 160 }, p2: { x: 390, y: 160 } };
const GB = { p1: { x: 200, y: 10 }, p2: { x: 200, y: 310 } };

function twoDiff(): Record<string, unknown> {
  return {
    rooms2: { r1: structuredClone(ROOM_R1) },
    zone_delimiters: { a: delimRec("a", GA.p1, GA.p2), b: delimRec("b", GB.p1, GB.p2) },
  };
}

test("299 M1: сервер переставил id двух разных разделителей — problem (оба режима)", () => {
  const exp = twoDiff();
  const zd = exp.zone_delimiters as Record<string, Record<string, unknown>>;
  const a = structuredClone(zd.b!);
  const b = structuredClone(zd.a!);
  a["id"] = "a";
  b["id"] = "b";
  const got = { rooms2: structuredClone(exp.rooms2), zone_delimiters: { a, b } };
  for (const mode of ["normalize", "save"] as const) {
    const { problems } = zoneDelimiterCompare(exp, got, mode);
    assert.ok(problems.length >= 2 && problems.every((p) => /изменился/.test(p)), `${mode}: ${JSON.stringify(problems)}`);
  }
});

test("299 M1: тот же id перенесён на геометрию пропавшего соседа — problem", () => {
  const exp = twoDiff();
  const moved = structuredClone((exp.zone_delimiters as Record<string, Record<string, unknown>>).b!);
  moved["id"] = "a";
  const got = { rooms2: structuredClone(exp.rooms2), zone_delimiters: { a: moved } };
  for (const mode of ["normalize", "save"] as const) {
    const { problems } = zoneDelimiterCompare(exp, got, mode);
    assert.ok(problems.length > 0, `${mode}: ${JSON.stringify(problems)}`);
  }
});

test("299 M1: редактор сменил id при той же геометрии — warning, не problem (запасной путь)", () => {
  const exp = { rooms2: { r1: structuredClone(ROOM_R1) }, zone_delimiters: { a: delimRec("a", GA.p1, GA.p2) } };
  const rec = structuredClone(exp.zone_delimiters.a);
  rec["id"] = "zzzzzzzzz";
  const got = { rooms2: structuredClone(exp.rooms2), zone_delimiters: { zzzzzzzzz: rec } };
  for (const mode of ["normalize", "save"] as const) {
    const res = zoneDelimiterCompare(exp, got, mode);
    assert.deepEqual(res.problems, [], `${mode}: смена id при той же геометрии не блок: ${JSON.stringify(res)}`);
    assert.ok(res.warnings.some((w) => /сменил id/.test(w)), `${mode}: ${JSON.stringify(res.warnings)}`);
  }
});

test("299 M1: normalize затронутой комнаты — редактор пересоздал id при той же геометрии — не блок", () => {
  const exp = { rooms2: { r1: structuredClone(ROOM_R1) }, zone_delimiters: { a: delimRec("a", GA.p1, GA.p2) } };
  const rec = structuredClone(exp.zone_delimiters.a);
  rec["id"] = "zzzzzzzzz";
  const got = { rooms2: structuredClone(exp.rooms2), zone_delimiters: { zzzzzzzzz: rec } };
  const res = zoneDelimiterCompare(exp, got, "normalize", { affectedRooms: new Set(["r1"]) });
  assert.deepEqual(res.problems, [], JSON.stringify(res));
});

test("299 M1: запись с id из ожидания не подбирается по геометрии чужой записи", () => {
  // id b остался на сервере, но его геометрия заменена геометрией a; a потерян.
  // Запасной путь для a запрещён (got b держит id из ожидания), для b — id на
  // месте, а геометрия чужая → обе записи не совпали
  const exp = twoDiff();
  const rec = structuredClone((exp.zone_delimiters as Record<string, Record<string, unknown>>).a!);
  rec["id"] = "b";  const got = { rooms2: structuredClone(exp.rooms2), zone_delimiters: { b: rec } };
  for (const mode of ["normalize", "save"] as const) {
    const { problems } = zoneDelimiterCompare(exp, got, mode);
    assert.ok(problems.length >= 2, `${mode}: ${JSON.stringify(problems)}`);
  }
});
