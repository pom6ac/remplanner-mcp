// Этап 78 «Сантехника и водоснабжение»: точки воды (waterspots) и трубы водоснабжения
// (model.pipes). Эталоны UI в обе стороны, атомарность, update-цепочки, удаление,
// смежные операции (предметы, подключения), реестр коллекций, mock save
// (подмена writeBackup/loadModel/openEditor — new-entity-section.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps, Pipe } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addItem, updateItem, deleteItem } from "../../src/model/items.ts";
import { addPipe, updatePipe, deletePipe, addGasLine, gasLineLengthM, PIPE_TYPE_BY_KIND } from "../../src/model/pipes.ts";
import { compactModel } from "../../src/model/compact.ts";
import { clearEntityCollections, replaceEntityCollections } from "../../src/model/collections.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {} };
}

function baseModel(): Model {
  const model = emptyModel();
  addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  // детерминированная комната (см): внутренняя зона стен осей (-10..410, -10..310)
  model.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return model;
}

function addSpot(model: Model, x: number, y: number, name = "waterspot_cold_hot"): ItemProps {
  return addItem(model, {
    name,
    position: { center: { x: x * 10, y: y * 10 } },
    catalogEntry: { id: 0, name, title: name, group: "waterspots", width: 16, height: 9, self_height: 0, plan: { water: 27 }, over_floor: { value: 50, display: false } },
  });
}

// ---------- эталоны точек воды (UI, обе стороны) ----------

test("78: эталон ui-ref-plumb-waterspot — item_add воспроизводит семантику предмета (обе стороны)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-plumb-waterspot.json"), "utf8"));
  const m = fx.model_object as Record<string, unknown>;
  assert.equal(m["name"], "waterspot_cold_hot");
  assert.equal(m["width"], 16);
  assert.equal(m["height"], 9);
  assert.deepEqual(m["plan"], { water: 27 });
  assert.deepEqual(m["over_floor"], { value: 50, display: false });
  assert.equal(m["angle"], 180); // центр на внутренней грани, предмет «спиной» к стене
  assert.equal((m["dimensions"] as { display: boolean }).display, true);
  // обратная сторона: item_add у стены даёт те же поля (угол вдоль грани, план, высота)
  const model = baseModel();
  const wallId = Object.keys(model.walls)[0]!;
  const item = addItem(model, {
    name: "waterspot_cold_hot",
    position: { againstWall: { wallId, offsetMm: 1500 } },
    catalogEntry: { id: 0, name: "waterspot_cold_hot", title: "Вывод ХВС+ГВС", group: "waterspots", width: 16, height: 9, self_height: 0, plan: { water: 27 }, over_floor: { value: 50, display: false } },
  });
  assert.equal(item.name, m["name"]);
  assert.deepEqual(item.plan, m["plan"]);
  assert.deepEqual(item.over_floor, m["over_floor"]);
  assert.equal(item.width, m["width"]);
  assert.equal(item.height, m["height"]);
  assert.equal((item.dimensions as { display: boolean }).display, true);
  // умолчание высоты вывода — из каталога (как у реального item_add с ToolEntry)
  const item2 = addSpot(structuredClone(model), 100, 100);
  assert.deepEqual(item2.over_floor, { value: 50, display: false });
});

test("78: эталон ui-ref-plumb-waterspot-drainage — у комбинированной точки с канализацией своя высота (value_2)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-plumb-waterspot-drainage.json"), "utf8"));
  const m = fx.model_object as Record<string, unknown>;
  assert.equal(m["name"], "waterspot_drainage_cold_hot");
  assert.equal(m["width"], 21);
  assert.equal(m["height"], 15);
  assert.deepEqual(m["over_floor"], { value: 50, display: false, value_2: 40 });
});

test("78: item_add отвергает трубы-графы (water_pipe/water_hot_pipe/drainage_pipe) — нужен pipe_add", () => {
  for (const name of ["water_pipe", "water_hot_pipe", "drainage_pipe"]) {
    const model = baseModel();
    assert.throws(
      () => addItem(model, { name, position: { center: { x: 1000, y: 1000 } }, catalogEntry: { id: 0, name, title: name, group: "waterspots", width: 0, height: 0, self_height: 0, plan: { water: 27 } } }),
      (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && (e as McpError).message.includes("pipe_add"),
    );
    assert.equal(Object.keys(model.items).length, 0, "модель не изменилась");
  }
});

// ---------- трубы: add/update/delete, подключения, атомарность ----------

test("78: pipe_add — цепочка предмет-узел-предмет, матрица, items, обратные ссылки, длина", () => {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_cold");
  const b = addSpot(model, 300, 100, "waterspot_cold");
  const pipe = addPipe(model, { kind: "water", path: [{ itemId: a.id }, { x: 2000, y: 1000 }, { itemId: b.id }] });
  assert.equal(Object.keys(model.pipes!).length, 1);
  assert.equal(pipe.type, "water_pipe");
  assert.equal(pipe.vertexes.length, 3);
  assert.deepEqual(pipe.items, { [a.id]: "waterspot", [pipe.vertexes[1]!.id]: "node", [b.id]: "waterspot" });
  assert.deepEqual(pipe.matrix[0]![1], { length: 1 });
  assert.deepEqual(pipe.matrix[1]![0], { length: 1 });
  assert.deepEqual(pipe.matrix[1]![2], { length: 1 });
  assert.deepEqual(pipe.matrix[2]![1], { length: 1 });
  assert.equal(pipe.matrix[0]![2], null);
  assert.equal(pipe.matrix[1]![1], null);
  // длина — по рёбрам (100 см + 100 см), округление 2 знака
  assert.equal(pipe.length, 2);
  // обратные ссылки: обычный вывод — скаляр
  assert.equal((a as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, pipe.id);
});

test("78: pipe_add — коллектор и стояки water_column_* — multi-подключение (массив в props.pipes)", () => {
  const model = baseModel();
  const col = addSpot(model, 100, 100, "waterspot_collector");
  const pipe = addPipe(model, { kind: "water", path: [{ itemId: col.id }, { x: 2000, y: 1000 }] });
  assert.equal(pipe.items[col.id], "multi");
  assert.deepEqual((col as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, [pipe.id]);
  // стояк ХВС water_column_cold тоже multi
  const st = addSpot(model, 200, 100, "water_column_cold");
  const pipe2 = addPipe(model, { kind: "water", path: [{ itemId: st.id }, { x: 2500, y: 1000 }] });
  assert.equal(pipe2.items[st.id], "multi");
  assert.deepEqual((st as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, [pipe2.id]);
});

test("78: pipe_add — подключение неподходящего предмета отвергается как в редакторе (Piping.source_items)", () => {
  const model = baseModel();
  const hot = addSpot(model, 100, 100, "waterspot_hot");
  assert.throws(
    () => addPipe(model, { kind: "drainage", path: [{ itemId: hot.id }, { x: 2000, y: 1000 }] }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT" && (e as McpError).message.includes("drainage_pipe"),
  );
  assert.equal(model.pipes, undefined, "модель не изменилась");
  // стояк ГВС не подключается к холодной трубе
  assert.throws(
    () => addPipe(model, { kind: "water", path: [{ itemId: hot.id }, { x: 2000, y: 1000 }] }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
});

test("78: pipe_add — атомарность: дубликат подряд и NOT_FOUND не меняют модель", () => {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_cold");
  const before = JSON.stringify(model);
  assert.throws(() => addPipe(model, { kind: "water", path: [{ itemId: a.id }, { itemId: a.id }] }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.throws(() => addPipe(model, { kind: "water", path: [{ itemId: "nope" }, { x: 100, y: 100 }] }),
    (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
  assert.throws(() => addPipe(model, { kind: "wrong" as never, path: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.equal(JSON.stringify(model), before);
});

test("78: pipe_update — перенос узла пересчитывает длину; вершина-предмет не двигается", () => {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_cold");
  const b = addSpot(model, 300, 100, "waterspot_cold");
  const pipe2 = addPipe(model, { kind: "water", path: [{ itemId: a.id }, { x: 2000, y: 1000 }, { itemId: b.id }] });
  const nodeIdx = pipe2.vertexes.findIndex((v) => v.type === "node");
  assert.ok(nodeIdx > 0);
  const before = JSON.stringify(model);
  const updated = updatePipe(model, { pipeId: pipe2.id, positions: [{ vertex: nodeIdx, x: 2000, y: 3000 }] });
  assert.deepEqual(updated.vertexes[nodeIdx]!.point, { x: 200, y: 300 });
  assert.equal(updated.length, 4.47);
  assert.notEqual(JSON.stringify(model), before);
  // вершина-предмет — INVALID_ARGUMENT
  assert.throws(() => updatePipe(model, { pipeId: pipe2.id, positions: [{ vertex: 0, x: 0, y: 0 }] }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  // пустой update — но-оп
  assert.equal(updatePipe(model, { pipeId: pipe2.id }), pipe2);
  assert.throws(() => updatePipe(model, { pipeId: "nope", positions: [] }), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
});

test("78: pipe_delete снимает обратные ссылки (скаляр и массив), item_delete подключённого предмета блокирован", () => {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_cold_hot");
  const col = addSpot(model, 300, 100, "waterspot_collector");
  const p1 = addPipe(model, { kind: "water", path: [{ itemId: a.id }, { x: 2000, y: 1000 }, { itemId: col.id }] });
  const p2 = addPipe(model, { kind: "hot", path: [{ itemId: a.id }, { x: 2000, y: 1200 }, { itemId: col.id }] });
  assert.equal((a as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, p1.id);
  assert.equal((a as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_hot_pipe_id, p2.id);
  assert.deepEqual((col as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, [p1.id]);
  // item_delete подключённого — INVALID_ARGUMENT
  assert.throws(() => deleteItem(model, a.id), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  // удаление одной трубы снимает только её ключ
  deletePipe(model, p1.id);
  const ap = a as ItemProps & { pipes?: Record<string, unknown> };
  assert.equal(ap.pipes!.water_pipe_id, undefined);
  assert.equal(ap.pipes!.water_hot_pipe_id, p2.id);
  // multi-массив сокращается: у коллектора p1 (water) и p2 (hot) — отдельные ключи
  const cp = col as ItemProps & { pipes?: Record<string, unknown> };
  assert.deepEqual(cp.pipes!.water_hot_pipe_id, [p2.id]);
  assert.equal(cp.pipes!.water_pipe_id, undefined);
  deletePipe(model, p2.id);
  assert.equal(cp.pipes!.water_pipe_id, undefined);
  deleteItem(model, a.id);
  assert.equal(model.items[a.id], undefined);
  assert.throws(() => deletePipe(model, "nope"), (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
});

test("78: item_update (center) транзитивно двигает вершины подключённых труб и пересчитывает длину", () => {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_cold");
  const b = addSpot(model, 300, 100, "waterspot_cold");
  const pipe = addPipe(model, { kind: "water", path: [{ itemId: a.id }, { itemId: b.id }] });
  updateItem(model, { itemId: a.id, center: { x: 1000, y: 2000 } });
  const v = pipe.vertexes.find((x) => x.id === a.id)!;
  assert.deepEqual(v.point, { x: 100, y: 200 });
  assert.equal(pipe.length, 2.24);
});

// ---------- компакт, реестр коллекций ----------

test("78: compactModel — трубы TP<n> с типом, длиной и подключёнными предметами", () => {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_cold");
  const pipe = addPipe(model, { kind: "water", path: [{ itemId: a.id }, { x: 2000, y: 1000 }] });
  const compact = compactModel(model);
  assert.equal(compact.pipes.length, 1);
  assert.deepEqual(compact.pipes[0], {
    id: "TP1", site_id: pipe.id, type: "water_pipe",
    from: [1000, 1000], to: [2000, 1000], vertexes: 2, length_mm: 1000, connected: [a.id],
  });
  assert.equal((compact.pipes[0] as unknown as Record<string, unknown>)["length_m"], undefined, "длина труб — только в мм (ревью 79 №6)");
});

test("78: реестр коллекций — clear удаляет трубы, import переносит, walls/items не трогает", () => {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_cold");
  addPipe(model, { kind: "water", path: [{ itemId: a.id }, { x: 2000, y: 1000 }] });
  clearEntityCollections(model);
  assert.equal(model.pipes, undefined);
  assert.deepEqual(model.walls, {});
  assert.deepEqual(model.items, {});
  const source = baseModel();
  const b = addSpot(source, 50, 50, "waterspot_hot");
  addPipe(source, { kind: "hot", path: [{ itemId: b.id }, { x: 1000, y: 500 }] });
  clearEntityCollections(model);
  replaceEntityCollections(model, source);
  assert.equal(Object.keys(model.pipes ?? {}).length, 1);
  assert.equal(Object.keys(model.items).length, 1);
});

// ---------- mock save (подмена writeBackup/loadModel/openEditor) ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(m.walls as Record<string, unknown>).length;
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
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: server.saveId, units: "cm", data_empty: false, model: structuredClone(server.model) };
    },
    async openEditor() { return editor; },
  };
  const ws = new Workspace(deps);
  // ревью 79 №11: helper изолирован и от записи бэкапов (тройная подмена)
  ws.writeBackup = () => "/mock/no-write";
  return ws;
}

function pipeScenario(): { model: Model; pipe: Pipe } {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_cold");
  const b = addSpot(model, 300, 100, "waterspot_cold");
  const pipe = addPipe(model, { kind: "water", path: [{ itemId: a.id }, { x: 2000, y: 1000 }, { itemId: b.id }] });
  return { model, pipe };
}

test("78: mock save — труба и подключения доходят до серверной модели, verified", async () => {
  const { model } = pipeScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.equal(res.backup_path, "/mock/no-write", "бэкап подменён в helper (ревью 79 №11)");
  assert.equal(Object.keys((server.model as { pipes?: Record<string, Pipe> }).pipes ?? {}).length, 1);
});

test("78: mock save — редактор потерял трубу при нормализации → NORMALIZATION_DROPPED, записи нет", async () => {
  const { model, pipe } = pipeScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    delete (m as { pipes?: Record<string, Pipe> }).pipes![pipe.id];
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED");
  assert.equal(saves, 0, "до записи дело не дошло");
});

test("78: mock save — сервер испортил матрицу трубы (обе стороны графа) → SITE_ERROR", async () => {
  const { model, pipe } = pipeScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const got = (s.model as { pipes?: Record<string, Pipe> }).pipes![pipe.id]!;
    got.matrix[0]![1] = null; // прямое ребро потеряно
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    assert.ok(JSON.stringify((e as McpError).details).includes("pipe_mismatches"));
    return true;
  });
  // обратное ребро тоже сверяется
  const server2: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws2 = saveMock(server2, (s) => {
    const got = (s.model as { pipes?: Record<string, Pipe> }).pipes![pipe.id]!;
    got.matrix[1]![2] = null;
  });
  await ws2.open("0", "1");
  await assert.rejects(ws2.save(), (e: unknown) => e instanceof McpError && e.code === "SITE_ERROR");
});

test("78: mock save — редактор переставил узлы графа и пересчитал точку подключения — не ложная блокировка", async () => {
  const { model, pipe } = pipeScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (m) => {
    const got = (m as { pipes?: Record<string, Pipe> }).pipes![pipe.id]!;
    // переупорядочивание вершин (устойчивое сопоставление по id) и сдвиг точки
    // вершины-предмета (connector geometry редактора) — штатная нормализация
    got.vertexes = [got.vertexes[2]!, got.vertexes[1]!, got.vertexes[0]!];
    got.vertexes[0]!.point = { x: got.vertexes[0]!.point.x + 3, y: got.vertexes[0]!.point.y - 2 };
    const n = got.vertexes.length;
    const reordered: ({ length: number } | null)[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => got.matrix[j]![i] ?? null));
    got.matrix = reordered;
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("78: mock save — сервер сместил узел трубы → SITE_ERROR; сменил тип трубы → SITE_ERROR", async () => {
  const { model, pipe } = pipeScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const got = (s.model as { pipes?: Record<string, Pipe> }).pipes![pipe.id]!;
    got.vertexes[1]!.point = { x: got.vertexes[1]!.point.x + 50, y: got.vertexes[1]!.point.y };
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "SITE_ERROR");

  const server2: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws2 = saveMock(server2, (s) => {
    (s.model as { pipes?: Record<string, Pipe> }).pipes![pipe.id]!.type = "drainage_pipe";
  });
  await ws2.open("0", "1");
  await assert.rejects(ws2.save(), (e: unknown) => e instanceof McpError && e.code === "SITE_ERROR");
  void PIPE_TYPE_BY_KIND;
});

// ---------- эталон трубы (нормализованная модель PRO-проекта, живая проверка 78) ----------

test("78: эталон ui-ref-plumb-pipe — pipe_add воспроизводит семантику трубы (обе стороны)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-plumb-pipe.json"), "utf8"));
  const m = fx.model_object as Record<string, unknown>;
  // формат: без plan, граф {id, matrix, vertexes, items, type, length}
  assert.equal(m["type"], "water_pipe");
  assert.deepEqual(m["items"], { i1: "multi", n1: "node", i2: "waterspot" });
  assert.equal(m["plan"], undefined, "Pipe.serialize не пишет plan");
  // обратная сторона: pipe_add строит тот же граф (сопоставление по геометрии)
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_collector");
  const b = addSpot(model, 300, 100, "waterspot_cold_hot");
  const pipe = addPipe(model, { kind: "water", path: [{ itemId: a.id }, { x: 2000, y: 1000 }, { itemId: b.id }] });
  assert.equal(pipe.type, m["type"]);
  assert.deepEqual(pipe.items[a.id], "multi");
  assert.deepEqual(pipe.items[b.id], "waterspot");
  assert.equal(pipe.vertexes[1]!.type, "node");
  assert.deepEqual(pipe.matrix[0]![1], { length: 1 });
  assert.deepEqual(pipe.matrix[1]![2], { length: 1 });
  assert.equal(pipe.matrix[0]![2], null);
  assert.equal(pipe.length, 2);
  // мульти-подключение коллектора — массив в props.pipes
  assert.deepEqual((a as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, [pipe.id]);
  // семантика подключений из эталона (Piping.source_items)
  const sem = (fx.semantics as { connectable_waterspots: Record<string, string[]> }).connectable_waterspots;
  for (const [kind, names] of Object.entries(sem)) {
    const pk = kind === "water_pipe" ? "water" : kind === "water_hot_pipe" ? "hot" : "drainage";
    const model2 = baseModel();
    for (const name of names) {
      const spot = addSpot(model2, 100, 100, name);
      assert.doesNotThrow(() => addPipe(model2, { kind: pk as never, path: [{ itemId: spot.id }, { x: 2000, y: 1000 }] }), `${name} → ${kind}`);
    }
  }
});

// ---------- ревью 79: исправления major №1–6, minor №7/№8 ----------

/** Предмет с заданными габаритами (для проверок геометрии подключения). */
function addWideSpot(model: Model, xCm: number, yCm: number, name = "waterspot_cold"): ItemProps {
  return addItem(model, {
    name,
    position: { center: { x: xCm * 10, y: yCm * 10 } },
    catalogEntry: { id: 0, name, title: name, group: "waterspots", width: 16, height: 9, self_height: 0, plan: { water: 27 }, over_floor: { value: 50, display: false } },
  });
}

// №1: второе скалярное подключение того же вида не перезаписывает обратную ссылку
test("ревью 79 №1: повторное подключение обычного вывода к трубе того же вида отвергается, модель не меняется", () => {
  const model = baseModel();
  const s = addWideSpot(model, 100, 100);
  const p1 = addPipe(model, { kind: "water", path: [{ itemId: s.id }, { x: 2000, y: 1000 }] });
  const before = JSON.stringify(model);
  assert.throws(
    () => addPipe(model, { kind: "water", path: [{ itemId: s.id }, { x: 3000, y: 1000 }] }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  assert.equal(JSON.stringify(model), before, "модель не изменилась");
  // после отказа первая труба цела, обратная ссылка указывает на неё
  assert.equal(model.pipes![p1.id]!.vertexes.some((v) => v.id === s.id), true);
  assert.equal((s as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, p1.id);
});

// №2: повтор item-id в разных вершинах пути запрещён во всём пути
test("ревью 79 №2: один предмет дважды в пути (не подряд) — INVALID_ARGUMENT, модель не меняется", () => {
  const model = baseModel();
  const s = addWideSpot(model, 100, 100);
  const before = JSON.stringify(model);
  assert.throws(
    () => addPipe(model, { kind: "water", path: [{ itemId: s.id }, { x: 2000, y: 1000 }, { itemId: s.id }] }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  assert.equal(JSON.stringify(model), before, "модель не изменилась");
});

// №3: пересчёт длины от точки подключения — не ложный отказ save
test("ревью 79 №3: редактор пересчитал точку подключения и длину — save проходит (verified)", async () => {
  const { model, pipe } = pipeScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (m) => {
    const got = (m as { pipes?: Record<string, Pipe> }).pipes![pipe.id]!;
    got.vertexes[0]!.point = { x: got.vertexes[0]!.point.x + 5, y: got.vertexes[0]!.point.y };
    got.length = gasLineLengthM(got);
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

// №3-negative: пересчёт длины не отключает проверку целиком — сдвиг узла с изменением длины ловится
// (порча внесена при нормализации → NORMALIZATION_DROPPED до записи)
test("ревью 79 №3: ложная блокировка снята, но реальная порча длины узла всё ещё отвергается", async () => {
  const { model, pipe } = pipeScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    const got = (m as { pipes?: Record<string, Pipe> }).pipes![pipe.id]!;
    got.vertexes[1]!.point = { x: got.vertexes[1]!.point.x + 50, y: got.vertexes[1]!.point.y };
    got.length = gasLineLengthM(got);
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED");
  assert.equal(saves, 0, "до записи дело не дошло");
});

// №4: переименование свободного узла + сдвиг точки предмета — не ложная блокировка
test("ревью 79 №4: rename свободного узла при согласованном items не роняет сопоставление по id", async () => {
  const { model, pipe } = pipeScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (m) => {
    const got = (m as { pipes?: Record<string, Pipe> }).pipes![pipe.id]!;
    got.vertexes[0]!.point = { x: got.vertexes[0]!.point.x, y: got.vertexes[0]!.point.y + 1 };
    const nodeIdx = got.vertexes.findIndex((v) => v.type === "node");
    const old = got.vertexes[nodeIdx]!.id;
    got.vertexes[nodeIdx]!.id = "renamed";
    delete got.items[old];
    got.items["renamed"] = "node";
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

// №5: identity вершины-предмета после save — только по id; обратные ссылки и множество труб сверяются
test("ревью 79 №5a: сервер потерял props.pipes у предмета — SITE_ERROR, не verified", async () => {
  const { model } = pipeScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const items = (s.model as { items?: Record<string, ItemProps> }).items ?? {};
    for (const it of Object.values(items)) delete (it as ItemProps & { pipes?: unknown }).pipes;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    assert.ok(JSON.stringify((e as McpError).details).includes("ссылк"), JSON.stringify((e as McpError).details));
    return true;
  });
});

test("ревью 79 №5b: сервер подменил id вершины-предмета — SITE_ERROR (identity только по id)", async () => {
  const { model, pipe } = pipeScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const got = (s.model as { pipes?: Record<string, Pipe> }).pipes![pipe.id]!;
    const old = got.vertexes[0]!.id;
    got.vertexes[0]!.id = "missing";
    delete got.items[old];
    got.items["missing"] = "waterspot";
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "SITE_ERROR");
});

test("ревью 79 №5c: лишняя труба на сервере — SITE_ERROR (сверка множества в обе стороны)", async () => {
  const { model, pipe } = pipeScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const pipes = (s.model as { pipes?: Record<string, Pipe> }).pipes ?? {};
    pipes["extra"] = { ...structuredClone(pipe), id: "extra" };
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    assert.ok(JSON.stringify((e as McpError).details).includes("лишн"), JSON.stringify((e as McpError).details));
    return true;
  });
});

// №5 на общей сверке: то же для газовых линий (общий слой, не копия для воды)
test("ревью 79 №5 (общий слой): лишняя газовая линия на сервере — SITE_ERROR", async () => {
  const model = baseModel();
  const line = addGasLine(model, { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 } });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const gas = (s.model as { pipes_gas?: Record<string, unknown> }).pipes_gas ?? {};
    gas["extra"] = structuredClone((gas as Record<string, unknown>)[line.id]!);
    (gas as Record<string, unknown>)["extra"] = { ...structuredClone((gas as Record<string, unknown>)[line.id] as object), id: "extra" } as unknown;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    assert.ok(JSON.stringify((e as McpError).details).includes("лишн"), JSON.stringify((e as McpError).details));
    return true;
  });
});

// ---------- ревью 82 (3-R): короткая труба — штатный save проходит, порча длины ловится ----------

/** Короткая труба: предмет + узел в 2 см от середины грани габарита (воспроизведение 3-R). */
function shortPipeNodeScenario(angle = 0): { model: Model; pipe: Pipe } {
  const model = baseModel();
  const s = addWideSpot(model, 100, 100);
  (s as ItemProps & { angle?: number }).angle = angle;
  const pipe = addPipe(model, { kind: "water", path: [{ itemId: s.id }, { x: 1100, y: 1000 }] });
  return { model, pipe };
}

// 3-R: допустимое подключение к середине грани (угол 0) — не ложная блокировка
test("ревью 82 3-R: короткая труба, точка подключения на середине грани — save проходит (verified)", async () => {
  const { model, pipe } = shortPipeNodeScenario(0);
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (m) => {
    // редактор пересчитал точку подключения к габариту (середина правой грани x=108)
    // и длину линии (2 см)
    const got = (m as { pipes?: Record<string, Pipe> }).pipes![pipe.id]!;
    got.vertexes[0]!.point = { x: 108, y: 100 };
    got.length = gasLineLengthM(got);
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

// 3-R: то же с поворотом предмета (angle=90 — грань вдоль другой оси)
test("ревью 82 3-R: короткое подключение к середине грани повёрнутого предмета — verified", async () => {
  const { model, pipe } = shortPipeNodeScenario(90);
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (m) => {
    // у повёрнутого на 90° предмета правая грань x=104.5, середина (104.5, 100)
    const got = (m as { pipes?: Record<string, Pipe> }).pipes![pipe.id]!;
    got.vertexes[0]!.point = { x: 104.5, y: 100 };
    got.length = gasLineLengthM(got);
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

// 3-R: обе вершины — предметы, длина меньше размеров габаритов (регионы перекрываются)
test("ревью 82 3-R: короткая труба предмет-предмет с перекрывающимися габаритами — verified", async () => {
  const model = baseModel();
  const a = addWideSpot(model, 100, 100);
  const b = addWideSpot(model, 108, 100);
  addPipe(model, { kind: "water", path: [{ itemId: a.id }, { itemId: b.id }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (m) => {
    const got = (m as { pipes?: Record<string, Pipe> }).pipes![Object.keys((m as { pipes?: Record<string, Pipe> }).pipes ?? {})[0]!]!;
    got.vertexes[0]!.point = { x: 108, y: 100 };
    got.vertexes[1]!.point = { x: 100, y: 100 };
    got.length = gasLineLengthM(got);
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

// 3-R negative: допустимый диапазон не выродился в «любая длина» — испорченная длина ловится
// (порча внесена при нормализации → NORMALIZATION_DROPPED до записи)
test("ревью 82 3-R: испорченная длина короткой трубы — NORMALIZATION_DROPPED, записи нет", async () => {
  const { model, pipe } = shortPipeNodeScenario(0);
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    const got = (m as { pipes?: Record<string, Pipe> }).pipes![pipe.id]!;
    got.vertexes[0]!.point = { x: 108, y: 100 };
    got.length = gasLineLengthM(got) + 1; // порча: +1 м к короткой трубе
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED");
  assert.equal(saves, 0, "до записи дело не дошло");
});

// ---------- ревью 82 (5-R): обратные ссылки props.pipes сверяются в обе стороны ----------

// 5-R: лишняя висячая ссылка в props.pipes scalar-вывода — SITE_ERROR
test("ревью 82 5-R: лишняя висячая ссылка в props.pipes — SITE_ERROR, не verified", async () => {
  const { model } = pipeScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const items = (s.model as { items?: Record<string, ItemProps & { pipes?: Record<string, unknown> }> }).items ?? {};
    const first = Object.keys(items)[0]!;
    items[first]!.pipes!.water_pipe_id = [String(items[first]!.pipes!.water_pipe_id), "missing"];
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    assert.ok(JSON.stringify((e as McpError).details).includes("pipe_connection_mismatches"), JSON.stringify((e as McpError).details));
    return true;
  });
});

// 5-R: ссылка не того вида трубы (water_hot_pipe_id на трубу water_pipe) — SITE_ERROR
test("ревью 82 5-R: обратная ссылка чужого вида трубы — SITE_ERROR", async () => {
  const { model } = pipeScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const items = (s.model as { items?: Record<string, ItemProps & { pipes?: Record<string, unknown> }> }).items ?? {};
    const first = Object.keys(items)[0]!;
    items[first]!.pipes!.water_hot_pipe_id = items[first]!.pipes!.water_pipe_id;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "SITE_ERROR");
});

// 5-R: ссылка у постороннего предмета (не вершины трубы) — SITE_ERROR
test("ревью 82 5-R: обратная ссылка у постороннего предмета — SITE_ERROR", async () => {
  const model = baseModel();
  const a = addSpot(model, 100, 100, "waterspot_cold");
  const b = addSpot(model, 300, 100, "waterspot_cold");
  const outsider = addSpot(model, 350, 100, "waterspot_cold");
  addPipe(model, { kind: "water", path: [{ itemId: a.id }, { x: 2000, y: 1000 }, { itemId: b.id }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const items = (s.model as { items?: Record<string, ItemProps & { pipes?: Record<string, unknown> }> }).items ?? {};
    items[outsider.id]!.pipes = { water_pipe_id: Object.keys((s.model as { pipes?: Record<string, unknown> }).pipes ?? {})[0] };
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "SITE_ERROR");
});

// 5-R positive: multi-подключение коллектора (массив) доходит до сервера — verified
test("ревью 82 5-R: multi-подключение (массив у коллектора) — штатный save verified", async () => {
  const model = baseModel();
  const col = addSpot(model, 100, 100, "waterspot_collector");
  const p1 = addPipe(model, { kind: "water", path: [{ itemId: col.id }, { x: 2000, y: 1000 }] });
  const p2 = addPipe(model, { kind: "hot", path: [{ itemId: col.id }, { x: 2000, y: 1200 }] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  assert.deepEqual((col as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_pipe_id, [p1.id]);
  assert.deepEqual((col as ItemProps & { pipes?: Record<string, unknown> }).pipes!.water_hot_pipe_id, [p2.id]);
});

// №9 (ревью 81): тариф — открытый вопрос, описания инструментов честно называют трубы PRO-функцией
test("ревью 82 №9: описания pipe_* называют трубы PRO-функцией редактора", async () => {
  const { buildServer } = await import("../../src/server.ts");
  const { ServerContext } = await import("../../src/server/context.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = buildServer(new ServerContext());
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ta, tb] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(tb), client.connect(ta)]);
  const tools = await client.listTools();
  await client.close();
  for (const name of ["pipe_add", "pipe_update", "pipe_delete", "item_add"]) {
    const t = tools.tools.find((x) => x.name === name);
    assert.ok(t, `инструмент ${name} есть`);
    assert.match(t.description ?? "", /PRO/i, `${name}: в описании упомянут PRO`);
  }
});
// №7: верхняя граница пути до аллокации квадратичной матрицы
test("ревью 79 №7: путь трубы длиннее лимита — INVALID_ARGUMENT до построения матрицы", () => {
  const model = baseModel();
  const s = addWideSpot(model, 100, 100);
  const path: ({ x: number; y: number } | { itemId: string })[] = [{ itemId: s.id }];
  for (let i = 0; i < 200; i++) path.push({ x: 1000 + i * 10, y: 1000 });
  const before = JSON.stringify(model);
  assert.throws(
    () => addPipe(model, { kind: "water", path }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  assert.equal(JSON.stringify(model), before, "модель не изменилась");
});

// №8: validatePipePath подключён — пустой путь, одна точка и NaN отвергаются моделью
test("ревью 79 №8: addPipe отвергает пустой путь, одну точку и NaN до любых мутаций", () => {
  const model = baseModel();
  const s = addWideSpot(model, 100, 100);
  const before = JSON.stringify(model);
  for (const bad of [
    [],
    [{ itemId: s.id }],
    [{ x: Number.NaN, y: 0 }, { x: 2000, y: 0 }],
    [{ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 0 }],
  ]) {
    assert.throws(
      () => addPipe(model, { kind: "water", path: bad as never }),
      (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
    );
  }
  assert.equal(JSON.stringify(model), before, "модель не изменилась");
});
