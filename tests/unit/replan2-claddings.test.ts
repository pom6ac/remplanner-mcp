// Этап 354: обшивка ГКЛ (claddings) — эталоны в обе стороны, валидации, атомарность,
// рез у проёма (порт addHole редактора), пустая форма, сверка claddingMismatches,
// полный путь через Workspace с mock-нормализатором (пробы 354-replan2-ui4/live).
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addCladding, removeCladding, claddingList, claddingMismatches, cutCladdingLinesForHole, type CladdingRec } from "../../src/model/claddings.ts";
import { addOpening } from "../../src/model/openings.ts";
import { parseModelImport } from "../../src/model/import-schema.ts";
import { McpError } from "../../src/errors.ts";
import type { Model, Point } from "../../src/model/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");

// База: комната 300×220 (внутренние границы 10..290 × 10..210), стены толщиной 10.
function baseModel(): Model {
  const m = {
    v: 1,
    id: "t",
    plan_id: "1",
    walls: {
      w1: wall("w1", { x: 0, y: 0 }, { x: 300, y: 0 }),
      w2: wall("w2", { x: 300, y: 0 }, { x: 300, y: 220 }),
      w3: wall("w3", { x: 300, y: 220 }, { x: 0, y: 220 }),
      w4: wall("w4", { x: 0, y: 220 }, { x: 0, y: 0 }),
    },
    items: {},
    pillars: {},
    rulers: {},
    comments: {},
    rooms2: {
      r1: { polygon: [{ x: 10, y: 10 }, { x: 290, y: 10 }, { x: 290, y: 210 }, { x: 10, y: 210 }], edges: [], exist: true },
    },
    total_height: 270,
    final: false,
  } as unknown as Model;
  return m;
}

function wall(id: string, p1: Point, p2: Point): Record<string, unknown> {
  return { id, plan: "a", role: "wall", p1, p2, depth: 10, material: "a_block", holes: {} };
}

function door(model: Model, wallId: string, centerCm: number, widthCm = 80): void {
  const w = model.walls[wallId]!;
  const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
  const at = centerCm - widthCm / 2;
  const hole = {
    id: `h_${centerCm}`,
    plan: "a",
    type: "door",
    group: "doors",
    pc: { x: w.p1.x + (w.p2.x - w.p1.x) * (centerCm / len), y: w.p1.y + (w.p2.y - w.p1.y) * (centerCm / len) },
    width: widthCm,
    height: 210,
    at,
  };
  w.holes = w.holes ?? {};
  w.holes[hole.id] = hole as never;
}

// ---------- эталон в обе стороны ----------

test("354: эталон ui-ref-replan2-cladding проходит импорт и воспроизводится cladding_add", () => {
  const env = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/ui-ref-replan2-cladding.json"), "utf8")) as {
    claddings: Record<string, CladdingRec>;
  };
  const rec = Object.values(env.claddings)[0]!;
  // эталон → импорт (валидатор схемы)
  assert.doesNotThrow(() => parseModelImport({ ...baseModel(), claddings: { [rec.id]: rec } } as never));
  // cladding_add → форма эталона (p1/p2/pc в мм → см, без производных полей)
  const m = baseModel();
  const res = addCladding(m, { fromMm: { x: rec.p1.x * 10, y: rec.p1.y * 10 }, toMm: { x: rec.p2.x * 10, y: rec.p2.y * 10 } });
  const stored = Object.values(m.claddings ?? {})[0]!;
  assert.equal(stored.p1.x, rec.p1.x);
  assert.equal(stored.p1.y, rec.p1.y);
  assert.equal(stored.p2.x, rec.p2.x);
  assert.equal(stored.p2.y, rec.p2.y);
  assert.deepEqual(stored.pc, rec.pc);
  assert.equal(Object.keys(stored).sort().join(","), ["id", "p1", "p2", "pc"].join(","), "MCP не пишет производные поля редактора");
  assert.ok(res.length_mm > 0);
  // список и метки CL
  const list = claddingList(m);
  assert.equal(list.length, 1);
  assert.equal(list[0]!["id"], "CL1");
  assert.equal(list[0]!["site_id"], res.id);
});

// ---------- валидации и атомарность ----------

test("354: линия вне комнаты — INVALID_ARGUMENT, модель не изменена (атомарность)", () => {
  const m = baseModel();
  assert.throws(
    () => addCladding(m, { fromMm: { x: -2000, y: -2000 }, toMm: { x: -1000, y: -2000 } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  assert.equal(m.claddings, undefined);
});

test("354: линия короче 40 мм и пересечение другой линии — INVALID_ARGUMENT", () => {
  const m = baseModel();
  addCladding(m, { fromMm: { x: 500, y: 500 }, toMm: { x: 2000, y: 500 } });
  assert.throws(
    () => addCladding(m, { fromMm: { x: 2500, y: 1500 }, toMm: { x: 2520, y: 1500 } }),
    (e: unknown) => (e as McpError).message?.includes("короче"),
  );
  // пересекающая линия — отказ; соединение концами — можно
  assert.throws(
    () => addCladding(m, { fromMm: { x: 1000, y: 200 }, toMm: { x: 1000, y: 2000 } }),
    (e: unknown) => (e as McpError).message?.includes("пересекает"),
  );
  addCladding(m, { fromMm: { x: 2000, y: 500 }, toMm: { x: 2600, y: 800 } });
  assert.equal(Object.keys(m.claddings ?? {}).length, 2);
});

test("354: магнит конца к ребру комнаты (5 см) и к свободному концу другой линии (10 см)", () => {
  const m = baseModel();
  // конец в 3 см от нижнего ребра (y=210) — магнит к ребру
  addCladding(m, { fromMm: { x: 1000, y: 1000 }, toMm: { x: 2000, y: 2070 } });
  const first = Object.values(m.claddings ?? {})[0]!;
  assert.equal(first.p2.y, 210, "конец примагничен к ребру комнаты (3 см < 5 см)");
  // конец в 8 см от свободного конца первой линии — магнит к концу линии
  addCladding(m, { fromMm: { x: 2200, y: 1000 }, toMm: { x: 1090, y: 970 } });
  const list = Object.values(m.claddings ?? {});
  const second = list[1]!;
  assert.deepEqual(second.p2, first.p1, "конец примагничен к свободному концу другой линии (8 см < 10 см)");
});

// ---------- рез у проёма (порт addHole редактора) ----------

test("354: линия, пересекающая оба откоса двери в полосе 51 см, режется на куски с отрезками до грани", () => {
  const m = baseModel();
  door(m, "w1", 150);
  addCladding(m, { fromMm: { x: 500, y: 500 }, toMm: { x: 2500, y: 500 } });
  const recs = Object.values(m.claddings ?? {}) as CladdingRec[];
  // форма из живой пробы dbg4/dbg5 (анонимный проект, редактор): куски 500..1100 и
  // 1900..2500 по оси линии + вертикальные отрезки от линии до грани стены (y=50)
  const horiz = recs.filter((r) => r.p1.y === 50 && r.p2.y === 50).sort((a, b) => a.p1.x - b.p1.x);
  assert.deepEqual(horiz.map((r) => [r.p1.x, r.p2.x]), [[50, 110], [190, 250]], "средняя часть в габарите проёма удалена");
  const reveals = recs.filter((r) => r.p1.x === r.p2.x);
  assert.equal(reveals.length, 2, "два отрезка откоса (вертикальные)");
  for (const r of reveals) {
    assert.equal(r.p2.y, 5, "отрезок идёт до грани стены (глубина 10 → грань 5 см)");
  }
});

test("354: линия, доставшая только до одного откоса, не режется (живая проба)", () => {
  const m = baseModel();
  door(m, "w1", 200); // дверь 1600..2400 мм на верхней стене
  addCladding(m, { fromMm: { x: 500, y: 500 }, toMm: { x: 2000, y: 500 } });
  const recs = Object.values(m.claddings ?? {}) as CladdingRec[];
  assert.equal(recs.length, 1, "рез не выполняется — второй откос за пределами линии");
  assert.equal(recs[0]!.p2.x, 200);
});

test("354: cutCladdingLinesForHole идемпотентен — куски без пересечения обоих откосов не трогаются", () => {
  const m = baseModel();
  door(m, "w1", 150);
  addCladding(m, { fromMm: { x: 500, y: 500 }, toMm: { x: 2500, y: 500 } });
  const before = JSON.stringify(m.claddings);
  const w = m.walls["w1"]!;
  const hole = Object.values(w.holes ?? {})[0]!;
  const pc = (hole as { pc: Point }).pc;
  const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
  const t = ((pc.x - w.p1.x) * (w.p2.x - w.p1.x)) / (len * len);
  cutCladdingLinesForHole(m, w, [t * len - 40, t * len + 40]);
  assert.equal(JSON.stringify(m.claddings), before, "повторный рез не меняет модель");
});

test("354: opening_add режет существующую линию обшивки (как addHole редактора)", () => {
  const m = baseModel();
  addCladding(m, { fromMm: { x: 600, y: 500 }, toMm: { x: 2600, y: 500 } });
  addOpening(m, { wallId: "w1", type: "door", centerMm: 1500 });
  const recs = Object.values(m.claddings ?? {}) as CladdingRec[];
  const horiz = recs.filter((r) => r.p1.y === 50 && r.p2.y === 50).sort((a, b) => a.p1.x - b.p1.x);
  assert.deepEqual(horiz.map((r) => [r.p1.x, r.p2.x]), [[60, 110], [190, 260]], "линия разрезана проёмом");
  const reveals = recs.filter((r) => r.p1.x === r.p2.x);
  assert.equal(reveals.length, 2, "плюс два отрезка откоса");
});

// ---------- пустая форма ----------

test("354: удаление последней линии оставляет claddings: {} (не удаляет ключ)", () => {
  const m = baseModel();
  const res = addCladding(m, { fromMm: { x: 500, y: 500 }, toMm: { x: 2000, y: 500 } });
  removeCladding(m, res.id);
  assert.deepEqual(m.claddings, {}, "пустая форма {} — $Claddings.restore при отсутствии ключа сохраняет прежние lines");
});

// ---------- сверка ----------

test("354: claddingMismatches — потеря, лишняя, изменение геометрии, смена id при той же геометрии", () => {
  const line = (id: string, p1: Point, p2: Point): Record<string, unknown> => ({ claddings: { [id]: { id, p1, p2, pc: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } } } });
  const A = { x: 50, y: 50 }, B = { x: 200, y: 50 };
  // идентично — пусто
  assert.deepEqual(claddingMismatches(line("a", A, B), line("a", A, B)), []);
  // смена id при той же геометрии — не расхождение (редактор может пересоздать id)
  assert.deepEqual(claddingMismatches(line("a", A, B), line("b", A, B)), []);
  // разворот оси — не расхождение
  assert.deepEqual(claddingMismatches(line("a", A, B), line("a", B, A)), []);
  // потеря
  assert.equal(claddingMismatches(line("a", A, B), { claddings: {} }).length, 1);
  // лишняя
  assert.equal(claddingMismatches({ claddings: {} }, line("b", A, B)).length, 1);
  // сдвиг — расхождение
  assert.ok(claddingMismatches(line("a", A, B), line("a", A, { x: 210, y: 50 })).length >= 1, "сдвиг — расхождение");
  // производные поля редактора не влияют
  const withDerived = line("a", A, B);
  (withDerived.claddings as Record<string, Record<string, unknown>>)["a"]!["p1lnk"] = { obj: 0 };
  (withDerived.claddings as Record<string, Record<string, unknown>>)["a"]!["l1"] = { x: 50, y: 45 };
  assert.deepEqual(claddingMismatches(line("a", A, B), withDerived), []);
});

// ---------- полный путь через Workspace (mock-нормализатор) ----------

test("354: полный путь через Workspace — cladding_add → save verified (mock normalize без потерь)", async () => {
  const { Workspace } = await import("../../src/workspace.ts");
  type EditorLike = import("../../src/workspace.ts").WorkspaceDeps["openEditor"] extends (...a: never[]) => Promise<infer E> ? E : never;
  const m = baseModel();
  const server: { saveId: string; model: Record<string, unknown> } = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  let normalized: Record<string, unknown> | null = null;
  const editor = {
    objectId: "0", planId: "1",
    async normalize(nm: Record<string, unknown>) {
      normalized = structuredClone(nm);
      const walls = Object.keys(nm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 1, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized!), rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return { global_version: null, planner_version: null, bundles: [], object_id: "0", plan_id: "1", present: {} }; },
    async close() {},
  };
  const deps = {
    session: { cookies: [] },
    async loadModel(): Promise<unknown> {
      return { object_id: "0", plan_id: "1", save_id: server.saveId, units: "cm", data_empty: false, model: structuredClone(server.model) };
    },
    async openEditor() { return editor; },
  };
  const ws = new Workspace(deps as never);
  ws.writeBackup = () => "/mock/no-write";
  await ws.open("0", "1");
  ws.apply("cladding_add", (mm) => addCladding(mm, { fromMm: { x: 500, y: 500 }, toMm: { x: 1500, y: 500 } }));
  const save = await ws.save();
  assert.equal(save.verified, true, "save verified с линией обшивки (mock normalize без изменений)");
  // mock-нормализатор потерял линию — NORMALIZATION_DROPPED
  const server2: { saveId: string; model: Record<string, unknown> } = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const editor2 = {
    ...editor,
    async normalize(nm: Record<string, unknown>) {
      const copy = structuredClone(nm);
      delete (copy as Record<string, unknown>)["claddings"];
      normalized = copy;
      const walls = Object.keys(nm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 1, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized!), rooms: [], before: c, after: c };
    },
  };
  const ws2 = new Workspace({ session: { cookies: [] }, loadModel: deps.loadModel, openEditor: () => Promise.resolve(editor2 as never) } as never);
  ws2.writeBackup = () => "/mock/no-write";
  await ws2.open("0", "1");
  ws2.apply("cladding_add", (mm) => addCladding(mm, { fromMm: { x: 500, y: 500 }, toMm: { x: 1500, y: 500 } }));
  await assert.rejects(ws2.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal((e as McpError).code, "NORMALIZATION_DROPPED");
    const details = (e as { details?: { cladding_mismatches?: string[] } }).details;
    assert.ok((details?.cladding_mismatches ?? []).some((x) => x.includes("обшивки")), JSON.stringify(details));
    return true;
  });
});
