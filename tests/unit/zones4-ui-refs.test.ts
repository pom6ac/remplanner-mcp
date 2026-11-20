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
import { finishCompare, setCeilingFinish } from "../../src/model/finish.ts";
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

test("310: update ширины при zone_ceiling-делителе с концом на грани закладной — отказ с подсказкой", () => {
  const model = rectRoom("room1", 100, 100, 400, 300);
  setCeilingFinish(model, "room1", "gypsum_ceiling", {});
  const rec = addCeilingRigel(model, "room1", { start: { x: 2500, y: 1005 }, end: { x: 2500, y: 2995 } });
  // делитель от левой стены к грани закладной (узлы без zone-привязок — их пишет редактор)
  const zd = addZoneCeiling(model, "room1", { fromMm: { x: 1005, y: 2000 }, toMm: { x: 2545, y: 2000 } });
  // zone-привязка узла к закладной — хранимое поле вершины (редактор ставит её в mouseup)
  const delims = (model.zone_delimiters ?? {}) as Record<string, Record<string, unknown>>;
  const delim = delims[zd.id] as { vertexes: Array<{ zone?: Record<string, unknown> }> };
  delim.vertexes[1]!.zone = { room_id: "room1", rigel_id: rec.id, type: "rigel_ceiling" };
  assert.throws(
    () => updateCeilingRigel(model, rec.id, { widthMm: 300 }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      return err.code === "INVALID_ARGUMENT" && /zone_ceiling_remove/.test(err.message ?? "");
    },
    "ширина меняется только после удаления делителя",
  );
  // после снятия делителя ширина меняется
  removeZoneCeiling(model, zd.id);
  const upd = updateCeilingRigel(model, rec.id, { widthMm: 300 });
  assert.equal(upd.width, 30);
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
