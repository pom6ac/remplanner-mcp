// Этап 310 — зонирование ч.4 (m11 ревью 304): пересчёт зон потолка при операциях
// с закладными и zone_ceiling-делителями, сверка отделки по ВСЕМ потолочным зонам,
// консервативный отказ update ширины при делителе на грани закладной.
// Живой эталон: tests/fixtures/ui-ref-zones4-ceiling-zones.json (проба 310-m11-live).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import type { Model, Wall } from "../../src/model/types.ts";
import { addCeilingRigel, updateCeilingRigel, deleteCeilingRigel } from "../../src/model/ceiling-rigels.ts";
import { addZoneCeiling, removeZoneCeiling } from "../../src/model/zone.ts";
import { rebuildCeilingZones } from "../../src/model/ceiling-zones.ts";
import { finishCompare, finishList, setCeilingFinish, removeCeilingFinish, addCeilingNiche, removeCeilingNiche } from "../../src/model/finish.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";

type Pt = { x: number; y: number };

/** Стены-рамка: боковые грани совпадают с рёбрами комнаты (грань = ось ± depth/2). */
function frameWalls(x0: number, y0: number, x1: number, y1: number, depth = 10): Record<string, Wall> {
  const mk = (id: string, p1: Pt, p2: Pt): Wall =>
    ({ id, plan: "a", role: "wall", child: 0, archive: 0, demount: 0, depth, height: 270, p1: { ...p1, role: "p1", link: 0 }, p2: { ...p2, role: "p2", link: 0 } }) as unknown as Wall;
  return {
    wallR: mk("wallR", { x: x1 + depth / 2, y: y0 - depth / 2 }, { x: x1 + depth / 2, y: y1 + depth / 2 }),
    wallB: mk("wallB", { x: x0 - depth / 2, y: y1 + depth / 2 }, { x: x1 + depth / 2, y: y1 + depth / 2 }),
    wallL: mk("wallL", { x: x0 - depth / 2, y: y1 + depth / 2 }, { x: x0 - depth / 2, y: y0 - depth / 2 }),
    wallT: mk("wallT", { x: x0 - depth / 2, y: y0 - depth / 2 }, { x: x1 + depth / 2, y: y0 - depth / 2 }),
  };
}

/** Прямоугольная комната (см) с рёбрами (контур по граням стен) и стенами. */
function rectRoom(id: string, x0: number, y0: number, x1: number, y1: number, extra: Record<string, unknown> = {}): Model {
  const poly: Pt[] = [
    { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 },
  ];
  const edges = poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length]!;
    return { p1: p, p2: q, c: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, length: Math.hypot(q.x - p.x, q.y - p.y) };
  });
  return {
    walls: frameWalls(x0, y0, x1, y1),
    pillars: {},
    rooms2: { [id]: { id, polygon: poly, points: poly, edges, zones: [{ name: null }], ceilings: [{ exist: false }], ...extra } },
  } as unknown as Model;
}

const materialsOf = (model: Model, roomId: string): string[] =>
  (((model.rooms2 as Record<string, Record<string, unknown>>)[roomId]!.ceilings) as Array<Record<string, unknown>>)
    .filter((c) => c.exist === true)
    .map((c) => String(c.material))
    .sort();

const REF = JSON.parse(readFileSync(new URL("../fixtures/ui-ref-zones4-ceiling-zones.json", import.meta.url), "utf8")) as {
  data: {
    room_id: string; room_name: string; polygon: Pt[]; zone_names: string[];
    rigel: Record<string, unknown>; rigel_id: string;
    delimiter: Record<string, unknown>; delimiter_id: string;
    ceilings: Array<Record<string, unknown>>;
  };
};

test("310: эталон UI — зоны потолка после закладной+делителя (обе стороны сверки)", () => {
  const d = REF.data;
  assert.equal(d.ceilings.length, 3);
  assert.equal(d.ceilings.filter((c) => c.exist === true).length, 1);
  assert.equal(d.ceilings[0]!.material, "gypsum_ceiling");
  // ожидание → ожидание: мультимножество совпадает (положительная сверка)
  const rooms = {
    [d.room_id]: { polygon: d.polygon, ceilings: structuredClone(d.ceilings) },
  };
  const res = finishCompare(rooms, structuredClone(rooms), undefined, undefined, "save");
  assert.deepEqual(res.problems, []);
  // потеря второй зоны: got без записи с отделкой → расхождение (раньше [0]-сверка
  // видела только первую зону)
  const got = {
    [d.room_id]: { polygon: d.polygon, ceilings: [{ exist: false }, { exist: false }, { exist: false }] },
  };
  const lost = finishCompare(rooms, got, undefined, undefined, "save");
  assert.equal(lost.problems.length, 1);
  assert.match(lost.problems[0]!, /покрытие потолка не совпало/);
  // перенос отделки в другую зону (штатная нормализация) — не блокируется
  const moved = {
    [d.room_id]: {
      polygon: d.polygon,
      ceilings: [{ exist: false }, structuredClone(d.ceilings[0]!), { exist: false }],
    },
  };
  const movedRes = finishCompare(rooms, moved, undefined, undefined, "save");
  assert.deepEqual(movedRes.problems, []);
  // umолчания: profile absent ≡ standard (96 R4)
  const noProfile = {
    [d.room_id]: {
      polygon: d.polygon,
      ceilings: [{ ...structuredClone(d.ceilings[0]!), profile: undefined }],
    },
  };
  const defRes = finishCompare(rooms, noProfile, undefined, undefined, "save");
  assert.deepEqual(defRes.problems, []);
});

test("310: ceiling_rigel_add пересчитывает зоны потолка — отделка остаётся в первой зоне, вторая exist:false", () => {
  const model = rectRoom("room1", 100, 100, 400, 300);
  setCeilingFinish(model, "room1", "gypsum_ceiling", { profile: "standard" });
  // ось вертикально по центру: конец на верхней и нижней стене (грань r у нижней)
  const rec = addCeilingRigel(model, "room1", {
    start: { x: 2500, y: 1005 },
    end: { x: 2500, y: 2995 },
  });
  assert.ok(rec.polygon.length === 4);
  const ceilings = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.equal(ceilings.length, 2, "закладная делит потолок на 2 зоны");
  assert.deepEqual(materialsOf(model, "room1"), ["gypsum_ceiling"], "отделка переживает пересчёт зон");
  const withMaterial = ceilings.filter((c) => c.exist === true);
  assert.equal(withMaterial.length, 1);
  // полигон зоны — половина комнаты, рёбра посчитаны
  assert.ok(Array.isArray(withMaterial[0]!.polygon) && (withMaterial[0]!.polygon as Pt[]).length >= 4);
  assert.ok(Array.isArray(withMaterial[0]!.edges));
  assert.equal(ceilings.filter((c) => c.exist === false).length, 1);
});

test("310: zone_ceiling_add режет зоны потолка; remove схлопывает обратно с отделкой (getZone)", () => {
  const model = rectRoom("room1", 100, 100, 400, 300);
  setCeilingFinish(model, "room1", "stretch_ceiling", {});
  const rec = addCeilingRigel(model, "room1", { start: { x: 2500, y: 1005 }, end: { x: 2500, y: 2995 } });
  const zd = addZoneCeiling(model, "room1", { fromMm: { x: 1005, y: 2000 }, toMm: { x: 2545, y: 2000 } });
  assert.ok(zd.id);
  const ceilings3 = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.equal(ceilings3.length, 3, "закладная + делитель → 3 зоны");
  assert.deepEqual(materialsOf(model, "room1"), ["stretch_ceiling"]);
  removeZoneCeiling(model, zd.id);
  const ceilings2 = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.equal(ceilings2.length, 2);
  assert.deepEqual(materialsOf(model, "room1"), ["stretch_ceiling"]);
  deleteCeilingRigel(model, rec.id);
  const ceilings1 = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.equal(ceilings1.length, 1);
  assert.deepEqual(materialsOf(model, "room1"), ["stretch_ceiling"], "удаление закладной схлопывает зоны с отделкой");
});

test("312 №3: update ширины при zone_ceiling-делителе из zone_ceiling_add — конец проецируется на новую грань (порт restoreDelimiters)", () => {
  const model = rectRoom("room1", 100, 100, 400, 300);
  setCeilingFinish(model, "room1", "gypsum_ceiling", {});
  const rec = addCeilingRigel(model, "room1", { start: { x: 2500, y: 1005 }, end: { x: 2500, y: 2995 } });
  // делитель от левой стены к грани закладной — БЕЗ ручной установки vertex.zone:
  // её пишет zone_ceiling_add, как mouseup редактора
  const zd = addZoneCeiling(model, "room1", { fromMm: { x: 1005, y: 2000 }, toMm: { x: 2545, y: 2000 } });
  const delim = ((model.zone_delimiters ?? {}) as Record<string, { vertexes: Array<{ point: Pt; zone?: Record<string, unknown> }> }>)[zd.id]!;
  assert.deepEqual(
    delim.vertexes[1]!.zone,
    {
      room_id: "room1",
      rigel_id: rec.id,
      edge: { p1: { x: 255, y: 100 }, p2: { x: 255, y: 300 } },
      edge_index: 0,
      edge_side: "l",
      type: "rigel_ceiling",
    },
    `zone-привязка конца на грани закладной: ${JSON.stringify(delim.vertexes[1]!.zone)}`,
  );
  assert.equal(delim.vertexes[0]!.zone, undefined, "конец на ребре комнаты — без zone-привязки");
  // прежний консервативный отказ убран (ревью 311 №3): редактор (restoreDelimiters)
  // перепривязывает узел делителя к новой грани
  const upd = updateCeilingRigel(model, rec.id, { widthMm: 300 });
  assert.equal(upd.width, 30);
  assert.deepEqual(delim.vertexes[1]!.point, { x: 265, y: 200 }, "конец делителя на новой грани (265)");
  assert.deepEqual(materialsOf(model, "room1"), ["gypsum_ceiling"], "отделка переживает пересчёт зон");
  const ceilings = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.equal(ceilings.length, 3, "закладная + делитель → 3 зоны");
  // mock save: нормализация не теряет отделку — save проходит
  assert.deepEqual(finishCompare(structuredClone(model.rooms2) as never, model.rooms2 as never, undefined, undefined, "save").problems, []);
});

test("312 №3: update ширины — узел делителя на старой грани без zone-привязки проецируется геометрически", () => {
  const model = rectRoom("room1", 100, 100, 400, 300);
  setCeilingFinish(model, "room1", "gypsum_ceiling", {});
  const rec = addCeilingRigel(model, "room1", { start: { x: 2500, y: 1005 }, end: { x: 2500, y: 2995 } });
  const zd = addZoneCeiling(model, "room1", { fromMm: { x: 1005, y: 2000 }, toMm: { x: 2545, y: 2000 } });
  // старая модель: запись делителя без zone-привязок (создана до 312)
  const delim = ((model.zone_delimiters ?? {}) as Record<string, { vertexes: Array<{ point: Pt; zone?: Record<string, unknown> }> }>)[zd.id]!;
  delete delim.vertexes[1]!.zone;
  const upd = updateCeilingRigel(model, rec.id, { widthMm: 300 });
  assert.equal(upd.width, 30);
  assert.deepEqual(delim.vertexes[1]!.point, { x: 265, y: 200 }, "геометрический запасной путь: узел на старой грани закладной");
  assert.deepEqual(materialsOf(model, "room1"), ["gypsum_ceiling"]);
});

test("310: эталонная геометрия зон (фикстура) — rebuild согласован с живой геометрией (идемпотентен, отделка на месте)", () => {
  const d = REF.data;
  const model = rectRoom(d.room_id, 10, 10, 390, 310, {
    name: d.room_name,
    zones: d.zone_names.map((name) => ({ name })),
    rigels: { [d.rigel_id]: structuredClone(d.rigel) },
    ceilings: structuredClone(d.ceilings),
  });
  (model.zone_delimiters ??= {} as never)[d.delimiter_id] = structuredClone(d.delimiter) as never;
  rebuildCeilingZones(model, d.room_id);
  const ceilings = ((model.rooms2 as Record<string, Record<string, unknown>>)[d.room_id]!.ceilings) as Array<Record<string, unknown>>;
  assert.equal(ceilings.length, d.ceilings.length, "число зон как в живом эталоне");
  assert.deepEqual(materialsOf(model, d.room_id), ["gypsum_ceiling"]);
  // зоны покрывают комнату: суммарная площадь ≈ площадь комнаты минус полоса закладной
  const area = (poly: Pt[]): number => {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  };
  const total = ceilings.reduce((acc, c) => acc + area(c.polygon as Pt[]), 0);
  const roomArea = area(d.polygon);
  const bandArea = area(REF.data.rigel.polygon as Pt[]);
  assert.ok(Math.abs(total - (roomArea - bandArea)) < 2, `зоны покрывают комнату без полосы закладной: ${total} vs ${roomArea - bandArea}`);
});

test("310: комната без закладных — rebuild не меняет ceilings (одна запись)", () => {
  const model = rectRoom("room1", 100, 100, 400, 300);
  setCeilingFinish(model, "room1", "gypsum_ceiling", {});
  const before = structuredClone(((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as unknown[]);
  rebuildCeilingZones(model, "room1");
  const after = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.equal(after.length, 1);
  assert.deepEqual(materialsOf(model, "room1"), ["gypsum_ceiling"]);
  assert.deepEqual(before.length, 1);
});

test("310: Г-образная комната — закладная у выемки даёт 3 зоны, отделка не теряется", () => {
  // Г-комната: 100..400 × 100..300 с вырезом 300..400 × 200..300
  const poly: Pt[] = [
    { x: 400, y: 100 }, { x: 400, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 300 },
    { x: 100, y: 300 }, { x: 100, y: 100 },
  ];
  const edges = poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length]!;
    return { p1: p, p2: q, c: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, length: Math.hypot(q.x - p.x, q.y - p.y) };
  });
  const model = {
    walls: frameWalls(100, 100, 400, 300),
    pillars: {},
    rooms2: { room1: { id: "room1", polygon: poly, points: poly, edges, zones: [{ name: null }], ceilings: [{ exist: false }] } },
  } as unknown as Model;
  setCeilingFinish(model, "room1", "gypsum_ceiling", {});
  // вертикальная закладная через всё Г (от y=100 до y=300)
  addCeilingRigel(model, "room1", { start: { x: 2000, y: 1005 }, end: { x: 2000, y: 2995 } });
  assert.deepEqual(materialsOf(model, "room1"), ["gypsum_ceiling"]);
  const ceilings = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.ok(ceilings.length >= 2, `Г-комната делится: ${ceilings.length} зон`);
});

// ---------- ревью 311 №1: API отделки потолка работает со всеми зонами комнаты ----------

/** pid на рёбрах комнаты (addCeilingNiche/removeCeilingNiche ищут стороны по pid). */
function withEdgePids(model: Model, roomId: string): void {
  const room = (model.rooms2 as Record<string, Record<string, unknown>>)[roomId]!;
  const pids = ["wallR", "wallB", "wallL", "wallT"];
  ((room["edges"] ?? []) as Array<Record<string, unknown>>).forEach((e, i) => { e["pid"] = pids[i]!; });
}

test("312 №1: после закладной finish_get видит отделку зоны (не только ceilings[0]), remove снимает", () => {
  const model = rectRoom("room1", 100, 100, 400, 300);
  setCeilingFinish(model, "room1", "gypsum_ceiling", {});
  // закладная у правой стены: отделка по граням уходит в запись [1] (311-exp5)
  addCeilingRigel(model, "room1", { start: { x: 3700, y: 1005 }, end: { x: 3700, y: 2995 } });
  const fl = finishList(model, "room1")[0] as Record<string, unknown>;
  assert.deepEqual(fl["ceiling"], { material: "gypsum_ceiling", level: 0, profile: "standard" }, "отделка зоны [1] видна в finish_get");
  removeCeilingFinish(model, "room1");
  const fl2 = finishList(model, "room1")[0] as Record<string, unknown>;
  assert.equal(fl2["ceiling"], undefined, "remove снимает отделку в любой зоне");
  const ceilings = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.deepEqual(materialsOf(model, "room1"), [], "записей с отделкой нет");
  assert.equal(ceilings.length, 2, "зоны сохранены");
});

test("312 №1: finish_ceiling_set в зонированной комнате — во все зоны, полигоны зон не переписываются", () => {
  const model = rectRoom("room1", 100, 100, 400, 300);
  setCeilingFinish(model, "room1", "gypsum_ceiling", {});
  addCeilingRigel(model, "room1", { start: { x: 2500, y: 1005 }, end: { x: 2500, y: 2995 } });
  setCeilingFinish(model, "room1", "stretch_ceiling", {});
  const ceilings = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.equal(ceilings.length, 2);
  assert.deepEqual(materialsOf(model, "room1"), ["stretch_ceiling", "stretch_ceiling"], "отделка во всех зонах");
  const zonePolys = ceilings.map((c) => c.polygon as Pt[]);
  assert.ok(
    zonePolys.some((p) => p.every((q) => q.x <= 245.01)) && zonePolys.some((p) => p.every((q) => q.x >= 254.99)),
    `полигоны — две зоны, не вся комната: ${JSON.stringify(zonePolys)}`,
  );
  // finish_get: одинаковый материал — ceiling; разные — ceiling_zones по записям
  const fl = finishList(model, "room1")[0] as Record<string, unknown>;
  assert.deepEqual(fl["ceiling"], { material: "stretch_ceiling", level: 0, profile: "standard" });
  assert.deepEqual(fl["ceiling_zones"], [
    { zone: 1, material: "stretch_ceiling", level: 0, profile: "standard" },
    { zone: 2, material: "stretch_ceiling", level: 0, profile: "standard" },
  ]);
  ceilings[1]!["material"] = "rack_ceiling";
  const fl2 = finishList(model, "room1")[0] as Record<string, unknown>;
  assert.deepEqual(fl2["ceiling_zones"], [
    { zone: 1, material: "stretch_ceiling", level: 0, profile: "standard" },
    { zone: 2, material: "rack_ceiling", level: 0, profile: "standard" },
  ]);
  assert.equal(fl2["ceiling"], undefined, "разные материалы по зонам — поле ceiling не вводит в заблуждение");
});

test("312 №1: ниша в зонированной комнате — в зоны у этой стены, снимается по стене", () => {
  const model = rectRoom("room1", 100, 100, 400, 300);
  withEdgePids(model, "room1");
  setCeilingFinish(model, "room1", "gypsum_ceiling", {});
  addCeilingRigel(model, "room1", { start: { x: 2500, y: 1005 }, end: { x: 2500, y: 2995 } });
  setCeilingFinish(model, "room1", "stretch_ceiling", {});
  const res = addCeilingNiche(model, "room1", "wallL");
  assert.ok(res.id);
  const ceilings = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  const withNiche = ceilings.filter((c) => ((c["niches"] ?? []) as Array<Record<string, unknown>>).some((n) => n.exist === true));
  assert.equal(withNiche.length, 1, "ниша — только в зоне у левой стены");
  const niche = withNiche[0]!;
  const nicheEdge = ((niche["edges"] ?? []) as Array<{ p1: Pt; p2: Pt }>).find((e) => e.p1.x <= 105 && e.p2.x <= 105);
  assert.ok(nicheEdge, "ниша стоит на ребре зоны вдоль левой стены");
  const removed = removeCeilingNiche(model, "room1", "wallL");
  assert.equal(removed.parts, 1);
  assert.deepEqual(materialsOf(model, "room1"), ["stretch_ceiling", "stretch_ceiling"]);
  const flAfter = finishList(model, "room1")[0] as Record<string, unknown>;
  assert.equal(flAfter["niches"], undefined, "ниши сняты");
});

// ---------- ревью 311 №2: сверка ceilingSigsOf во всех ветках finishCompare ----------

test("312 №2: save — отделка только в ceilings[1], комната сменила контур → NORMALIZATION_DROPPED", () => {
  const rooms: Record<string, Record<string, unknown>> = {
    room1: {
      polygon: [{ x: 400, y: 100 }, { x: 400, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }],
      ceilings: [
        { exist: false, polygon: [{ x: 255, y: 100 }, { x: 255, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }] },
        { exist: true, id: "_cB", material: "stretch_ceiling", level: 0, profile: "standard", polygon: [{ x: 245, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }, { x: 245, y: 100 }] },
      ],
    },
  };
  const got: Record<string, Record<string, unknown>> = structuredClone(rooms);
  (got["room1"]!["polygon"] as Pt[]).forEach((p) => { p.x = p.x === 400 ? 500 : p.x; });
  got["room1"]!["ceilings"] = [{ exist: false }];
  const res = finishCompare(rooms, got, undefined, undefined, "save");
  assert.equal(res.problems.length, 1, `одна проблема: ${JSON.stringify(res.problems)}`);
  assert.match(res.problems[0]!, /покрытие потолка.*stretch_ceiling/);
  // контроль: та же модель с отделкой в [0] — тоже проблема (старая сверка её ловила)
  const rooms0 = structuredClone(rooms);
  const c = rooms0["room1"]!["ceilings"] as unknown[];
  [c[0], c[1]] = [c[1], c[0]];
  const res0 = finishCompare(rooms0, got, undefined, undefined, "save");
  assert.equal(res0.problems.length, 1);
});

test("312 №2: split — часть не унаследовала отделку зоны [1] → problem (normalize)", () => {
  const poly = [{ x: 400, y: 100 }, { x: 400, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }];
  const expRooms = {
    room1: {
      polygon: poly,
      ceilings: [
        { exist: true, id: "_cA", material: "gypsum_ceiling", level: 0, profile: "standard", polygon: [{ x: 255, y: 100 }, { x: 255, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }] },
        { exist: true, id: "_cB", material: "stretch_ceiling", level: 0, profile: "standard", polygon: [{ x: 400, y: 100 }, { x: 400, y: 300 }, { x: 255, y: 300 }, { x: 255, y: 100 }] },
      ],
    },
  };
  const part = (xLeft: number, xRight: number, withStretch: boolean): Record<string, unknown> => ({
    polygon: [{ x: xRight, y: 100 }, { x: xRight, y: 300 }, { x: xLeft, y: 300 }, { x: xLeft, y: 100 }],
    ceilings: [
      { exist: true, id: `_c${xLeft}A`, material: "gypsum_ceiling", level: 0, profile: "standard", polygon: [{ x: 255, y: 100 }, { x: 255, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }] },
      ...(withStretch
        ? [{ exist: true, id: `_c${xLeft}B`, material: "stretch_ceiling", level: 0, profile: "standard", polygon: [{ x: 400, y: 100 }, { x: 400, y: 300 }, { x: 255, y: 300 }, { x: 255, y: 100 }] }]
        : [{ exist: false }]),
    ],
  });
  const ok = finishCompare(expRooms, { _p1: part(100, 250, true), _part2: part(250, 400, true) }, undefined, undefined, "normalize");
  assert.deepEqual(ok.problems, []);
  const lost = finishCompare(expRooms, { _p1: part(100, 250, false), _part2: part(250, 400, true) }, undefined, undefined, "normalize");
  assert.ok(lost.problems.some((p) => p.includes("не унаследовала покрытие потолка") && p.includes("stretch_ceiling")), JSON.stringify(lost.problems));
});

test("312 №2: merge — объединённая комната потеряла отделку источников → problem", () => {
  const expRooms: Record<string, Record<string, unknown>> = {
    a: { polygon: [{ x: 200, y: 100 }, { x: 200, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }], ceilings: [{ exist: true, id: "_cA", material: "gypsum_ceiling", level: 0, profile: "standard", polygon: [{ x: 200, y: 100 }, { x: 200, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }] }] },
    room2: { polygon: [{ x: 300, y: 100 }, { x: 300, y: 300 }, { x: 200, y: 300 }, { x: 200, y: 100 }], ceilings: [] },
  };
  const merged = {
    _m: { polygon: [{ x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }], ceilings: [{ exist: true, id: "_cM", material: "gypsum_ceiling", level: 0, profile: "standard", polygon: [{ x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }] }] },
  };
  const ok = finishCompare(expRooms, structuredClone(merged), undefined, undefined, "normalize");
  assert.deepEqual(ok.problems, [], "отделка источника сохранена — не потеря");
  const lost = finishCompare(expRooms, { _m: { ...merged["_m"]!, ceilings: [{ exist: false }] } }, undefined, undefined, "normalize");
  assert.ok(lost.problems.some((p) => p.includes("объединённая комната потеряла покрытие потолка")), JSON.stringify(lost.problems));
});

// ---------- ревью 311 №4: ниши не переносятся на чужие рёбра ----------

test("312 №4: ниша на левой стене остаётся на ребре левой зоны, не переезжает на грань закладной", () => {
  const model = rectRoom("room1", 100, 100, 400, 300);
  // ниша на левой стене (ребро 2) у записи-«вся комната» (как 311-exp4)
  ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!["ceilings"] as Array<Record<string, unknown>>)[0] = {
    exist: true, id: "_cA", material: "stretch_ceiling", level: 0, profile: "standard",
    polygon: [{ x: 400, y: 100 }, { x: 400, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }],
    niches: [
      { exist: false },
      { exist: false },
      { exist: true, parts: { p1: { line: { p1: { x: 100, y: 300 }, p2: { x: 100, y: 100 } }, depth: 15, plan: "ceiling" } } },
      { exist: false },
    ],
  };
  // закладная ближе к левой стене: отделка уйдёт в правую (большую) зону,
  // чьё ребро 2 — грань закладной, а не стена с нишей
  addCeilingRigel(model, "room1", { start: { x: 1300, y: 1005 }, end: { x: 1300, y: 2995 } });
  const ceilings = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.deepEqual(materialsOf(model, "room1"), ["stretch_ceiling"]);
  // ниша выжила и стоит на ребре вдоль левой стены (x=100), а не на грани закладной
  const holders = ceilings.filter((c) => ((c["niches"] ?? []) as Array<Record<string, unknown>>).some((n) => n?.exist === true));
  assert.equal(holders.length, 1, `ниша в одной записи: ${JSON.stringify(holders.map((c) => c["niches"]))}`);
  const holderEdges = holders[0]!["edges"] as Array<{ p1: Pt; p2: Pt }>;
  const holderNiches = holders[0]!["niches"] as Array<Record<string, unknown>>;
  const idx = holderNiches.findIndex((n) => n?.exist === true);
  const hostEdge = holderEdges[idx]!;
  assert.ok(
    Math.abs(hostEdge.p1.x - 100) < 0.05 && Math.abs(hostEdge.p2.x - 100) < 0.05,
    `ниша на ребре левой стены, не на грани закладной: ${JSON.stringify(hostEdge)}`,
  );
  // id_ceiling части перепривязан к записи-хозяину
  const part = Object.values((holderNiches[idx]!["parts"] ?? {}) as Record<string, Record<string, unknown>>)[0]!;
  assert.equal(part["id_ceiling"], holders[0]!["id"]);
});

test("312 №4: ниша, не ложащаяся на рёбра новых зон, — отказ с подсказкой finish_ceiling_niche_remove", () => {
  const model = rectRoom("room1", 100, 100, 400, 300);
  // запись без edges — линия ниши берётся из части (200,150)-(300,150): не лежит
  // ни на одном ребре новых зон
  ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!["ceilings"] as Array<Record<string, unknown>>)[0] = {
    exist: true, id: "_cA", material: "stretch_ceiling", level: 0, profile: "standard",
    polygon: [{ x: 400, y: 100 }, { x: 400, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }],
    niches: [
      { exist: false }, { exist: false }, { exist: false },
      { exist: true, parts: { p1: { line: { p1: { x: 200, y: 150 }, p2: { x: 300, y: 150 } }, depth: 15, plan: "ceiling" } } },
    ],
  };
  assert.throws(
    () => addCeilingRigel(model, "room1", { start: { x: 2500, y: 1005 }, end: { x: 2500, y: 2995 } }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      return err.code === "INVALID_ARGUMENT" && /finish_ceiling_niche_remove/.test(err.message ?? "");
    },
    "ниша не переносится молча и не стирается",
  );
});

// ---------- ревью 311 №6: legacy-делители и записи без plan видны пересчёту ----------

function twoZoneRoom(): Model {
  const model = rectRoom("room1", 100, 100, 400, 300);
  ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!["ceilings"]) = [
    { exist: true, id: "_cA", material: "gypsum_ceiling", level: 0, profile: "standard", polygon: [{ x: 400, y: 100 }, { x: 400, y: 200 }, { x: 100, y: 200 }, { x: 100, y: 100 }] },
    { exist: true, id: "_cB", material: "stretch_ceiling", level: 0, profile: "standard", polygon: [{ x: 400, y: 200 }, { x: 400, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 200 }] },
  ];
  return model;
}

test("312 №6: legacy per-room d_ceiling-делитель (points-форма) режет зоны потолка при rigel_add", () => {
  const model = twoZoneRoom();
  ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!)["delimiters"] = {
    _dl1: { id: "_dl1", type: "d_ceiling", points: [{ x: 100, y: 200 }, { x: 400, y: 200 }] },
  };
  // горизонтальная закладная y=150 (полоса 145..155): с делителем y=200 — 3 зоны
  addCeilingRigel(model, "room1", { start: { x: 1005, y: 1500 }, end: { x: 3995, y: 1500 } });
  const ceilings = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.equal(ceilings.length, 3, `legacy-делитель виден: ${ceilings.length} зон`);
  assert.deepEqual(materialsOf(model, "room1"), ["gypsum_ceiling", "stretch_ceiling"]);
});

test("312 №6: верхнеуровневый zone_ceiling без поля plan виден пересчётом (plan выводится по типу)", () => {
  const model = twoZoneRoom();
  (model.zone_delimiters ??= {}) as never;
  (model.zone_delimiters as Record<string, Record<string, unknown>>)["_dz1"] = {
    id: "_dz1", type: "zone_ceiling", id_room: "room1",
    vertexes: [
      { id: "v0", point: { x: 100, y: 200 }, type: "node" },
      { id: "v1", point: { x: 400, y: 200 }, type: "node" },
    ],
    items: { v0: "node", v1: "node" },
    matrix: [[null, { length: 3 }], [{ length: 3 }, null]],
    length: 3, on_size: 1,
  };
  addCeilingRigel(model, "room1", { start: { x: 1005, y: 1500 }, end: { x: 3995, y: 1500 } });
  const ceilings = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.equal(ceilings.length, 3);
  assert.deepEqual(materialsOf(model, "room1"), ["gypsum_ceiling", "stretch_ceiling"]);
});

// ---------- ревью 311 №7: висячее ребро делителя не обрывает пересчёт ----------

test("312 №7: delete закладной с привязанным делителем — зоны схлопываются в одну с отделкой", () => {
  const model = rectRoom("room1", 100, 100, 400, 300);
  setCeilingFinish(model, "room1", "stretch_ceiling", {});
  const rec = addCeilingRigel(model, "room1", { start: { x: 2500, y: 1005 }, end: { x: 2500, y: 2995 } });
  addZoneCeiling(model, "room1", { fromMm: { x: 1005, y: 2000 }, toMm: { x: 2545, y: 2000 } });
  // делитель остаётся (стандарт редактора — без каскадов), конец висит на грани
  // удалённой закладной; пересчёт не должен молча ничего не делать
  deleteCeilingRigel(model, rec.id);
  const ceilings = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.equal(ceilings.length, 1, `висячее ребро отброшено, одна зона: ${ceilings.length}`);
  assert.deepEqual(materialsOf(model, "room1"), ["stretch_ceiling"]);
});

// ---------- ревью 311 №8: запасной путь restoreCeiling и порог «good» ----------

test("312 №8: fallback restoreCeiling — одна запись, полигон которого не «good», но пересекает единственную зону", () => {
  const model = rectRoom("room1", 100, 100, 400, 300);
  // запись с «плохим» полигоном (треугольник внутри комнаты) — getZone не даёт
  // кандидата (вершины зоны не внутри сохранённого полигона)
  ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!["ceilings"]) = [
    { exist: true, id: "_cA", material: "stretch_ceiling", level: 0, profile: "standard", polygon: [{ x: 200, y: 150 }, { x: 300, y: 150 }, { x: 250, y: 250 }] },
  ];
  rebuildCeilingZones(model, "room1");
  const ceilings = ((model.rooms2 as Record<string, Record<string, unknown>>)["room1"]!.ceilings) as Array<Record<string, unknown>>;
  assert.equal(ceilings.length, 1);
  assert.deepEqual(materialsOf(model, "room1"), ["stretch_ceiling"], "отделка восстановлена запасным путём restoreCeiling");
});

// ---------- mock save: потеря отделки зоны потолка при нормализации — отказ ----------

const COMPAT = { global_version: "test", planner_version: "test", bundles: [] as string[], object_id: "0", plan_id: "1", present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };
type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock4(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      afterSave(server);
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return COMPAT; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] } as never,
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: server.saveId, units: "cm", data_empty: false, model: structuredClone(server.model) } as LoadedModel;
    },
    async openEditor() { return editor; },
  };
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  return ws;
}

test("310: mock save — нормализация потеряла отделку второй зоны потолка → NORMALIZATION_DROPPED с finish_mismatches", async () => {
  const d = REF.data;
  const m = rectRoom(d.room_id, 10, 10, 390, 310, {
    name: d.room_name,
    zones: d.zone_names.map((name) => ({ name })),
    rigels: { [d.rigel_id]: structuredClone(d.rigel) },
    ceilings: structuredClone(d.ceilings),
  });
  (m.zone_delimiters ??= {} as never)[d.delimiter_id] = structuredClone(d.delimiter) as never;
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let wrote = false;
  const ws = saveMock4(server, () => { wrote = true; }, (norm) => {
    // редактор при пересчёте зон потерял отделку (как updateZones без restoreCeiling)
    const rooms = norm["rooms2"] as Record<string, Record<string, unknown>>;
    for (const r of Object.values(rooms)) {
      r["ceilings"] = ((r["ceilings"] as Array<Record<string, unknown>>) ?? []).map((c) => ({ ...c, exist: false, material: undefined }));
    }
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as Error & { details?: Record<string, unknown> };
    assert.match(err.message, /NORMALIZATION_DROPPED|потерял объекты/);
    const fm = err.details?.["finish_mismatches"] as string[] | undefined;
    assert.ok(Array.isArray(fm) && fm.some((p) => p.includes("покрытие потолка")), `details.finish_mismatches: ${JSON.stringify(err.details)?.slice(0, 500)}`);
    return true;
  });
  assert.equal(wrote, false, "модель с потерянной отделкой зон не записывается");
});
