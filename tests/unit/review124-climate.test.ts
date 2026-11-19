// Ревью 124 (этап 123) — резолюция находок R1–R6 по климату (PR #16):
// R1 — привязка контура к комнате по геометрии (двухрежимно: normalize — геометрия,
// save — строго); R2 — обратные ссылки предметов на трубы климата в обе стороны;
// R3 — полный состав vertexes/props.id/согласованность polygon-matrix; R4 — включение
// контура в вогнутую комнату; R5/R6 — семантика mock save (writeBackup, запись без
// верификации). Mock save — подмена метода writeBackup, loadModel, openEditor
// (new-entity-section.md): реальной записи бэкапов и сети нет.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, Pipe, WarmFloor } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addItem } from "../../src/model/items.ts";
import { addPipe } from "../../src/model/pipes.ts";
import { addWarmFloor as addWf } from "../../src/model/climate.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {} };
}

function baseModel(): Model {
  const model = emptyModel();
  addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  model.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return model;
}

/** Вогнутая (Г-образная) комната из воспроизведения ревью 123 R4, см. */
function concaveModel(): Model {
  const model = emptyModel();
  addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 4000, thicknessMm: 200 });
  model.rooms2 = {
    r1: {
      polygon: [
        { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 280, y: 400 },
        { x: 280, y: 150 }, { x: 250, y: 150 }, { x: 250, y: 400 }, { x: 0, y: 400 },
      ],
      area: 13.5,
    } as never,
  };
  return model;
}

function climateEntry(name: string, over: Record<string, unknown> | null): Parameters<typeof addItem>[1]["catalogEntry"] {
  const sizes: Record<string, { w: number; h: number; sh: number }> = {
    radiator_bimetal: { w: 70, h: 12, sh: 56 },
  };
  const s = sizes[name]!;
  const plans: Record<string, Record<string, number>> = { radiator_bimetal: { radiators: 26 } };
  return { id: 0, name, title: name, group: "furniture", width: s.w, height: s.h, self_height: s.sh, plan: plans[name]!, ...(over ? { over_floor: over as never } : {}) } as never;
}

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(
  server: SaveServer,
  afterSave: (s: SaveServer) => void,
  transformNorm?: (m: Record<string, unknown>) => void,
  opts: { loadModelThrowsAfter?: () => boolean } = {},
): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const c = { walls: Object.keys(m.walls as Record<string, unknown>).length, holes: 0, items: 0, pillars: 0, rigels: 0 };
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
    loadModel: async () => {
      if (opts.loadModelThrowsAfter?.()) throw new McpError("SITE_ERROR", "GET-верификация упала после записи");
      return { saveId: server.saveId, model: structuredClone(server.model), dataEmpty: false } as never;
    },
    openEditor: async () => editor,
  } as unknown as WorkspaceDeps;
  const ws = new Workspace(deps);
  // R6 (ревью 123): подмена самого метода writeBackup — подмена в deps не работает,
  // Workspace.save вызывает this.writeBackup()
  ws.writeBackup = () => "/tmp/mock-not-written";
  return ws;
}

/** Сценарий: комната r1, контур тёплого пола, радиатор у стены, труба отопления с вершиной-предметом. */
function heatScenario(): { model: Model; wf: WarmFloor; pipe: Pipe; itemId: string } {
  const model = baseModel();
  const wf = addWf(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
  const wallId = Object.keys(model.walls)[0]!;
  const item = addItem(model, {
    name: "radiator_bimetal",
    position: { againstWall: { wallId, offsetMm: 1000 } },
    catalogEntry: climateEntry("radiator_bimetal", { value: 10, display: false }),
  });
  // труба отопления из узлов; подключение предмета — как в UI (refreshPipeForItem:
  // вершина в точке подключения предмета, обратная ссылка item.pipes). addPipe климата
  // новые item-подключения отвергает, существующие подключения UI — валидны
  const pipe = addPipe(model, { kind: "heat_hot", path: [{ x: 500, y: 500 }, { x: 1500, y: 500 }] });
  const v = pipe.vertexes[1]!;
  delete pipe.items[v.id];
  v.id = item.id;
  v.type = "waterspot";
  v.point = { x: (item.pc as { x: number; y: number }).x, y: (item.pc as { x: number; y: number }).y };
  pipe.items[item.id] = "waterspot";
  // климат ч.2: обратная ссылка в props.pipes_heat (name_object_lines менеджера,
  // проба 250-connect-heat), ключ heat_pipe_hot_id
  (item as unknown as { pipes_heat: Record<string, string> }).pipes_heat = { heat_pipe_hot_id: pipe.id };
  return { model, wf, pipe, itemId: item.id };
}

// ---------- R1: привязка контура к комнате — геометрия при normalize, строго после save ----------

test("124 R1: нормализатор регенерирует ID комнаты при той же геометрии — verified", async () => {
  const { model } = (() => {
    const m = baseModel();
    addWf(m, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
    return { model: m };
  })();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (m) => {
    // штатная регенерация ID комнат: r1 → r2 с тем же polygon, id_room контура переносится
    const rooms = (m as { rooms2?: Record<string, unknown> }).rooms2!;
    rooms.r2 = rooms.r1!;
    delete rooms.r1;
    (m as { warm_floors?: Record<string, WarmFloor> }).warm_floors![Object.keys((m as { warm_floors?: Record<string, WarmFloor> }).warm_floors!)[0]!]!.id_room = "r2";
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("124 R1: нормализатор привязал контур к комнате, не содержащей его — NORMALIZATION_DROPPED", async () => {
  const model = baseModel();
  addWf(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    // «комната» с другим контуром: контур (50..300, 50..200) в неё не помещается
    (m as { rooms2?: Record<string, unknown> }).rooms2!.r1 = { polygon: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }], area: 0.16 } as never;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED");
  assert.equal(saves, 0, "до записи дело не дошло");
});

test("124 R1: split комнаты — контур в одной из частей — verified", async () => {
  const model = baseModel();
  addWf(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (m) => {
    // перенос стены разрезал комнату: обе части, контур целиком в левой (x ≤ 350)
    const rooms = (m as { rooms2?: Record<string, unknown> }).rooms2!;
    rooms.ra = { polygon: [{ x: 0, y: 0 }, { x: 350, y: 0 }, { x: 350, y: 300 }, { x: 0, y: 300 }], area: 10.5 } as never;
    rooms.rb = { polygon: [{ x: 350, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 350, y: 300 }], area: 1.5 } as never;
    delete rooms.r1;
    const wfs = (m as { warm_floors?: Record<string, WarmFloor> }).warm_floors!;
    wfs[Object.keys(wfs)[0]!]!.id_room = "ra";
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
});

test("124 R1: после save сервер сменил id_room контура — SITE_ERROR (строгий режим)", async () => {
  const model = baseModel();
  const wf = addWf(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 3000, y: 2000 } });
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    (s.model as { warm_floors?: Record<string, WarmFloor> }).warm_floors![wf.id]!.id_room = "rX";
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "SITE_ERROR");
});

// ---------- R2: обратные ссылки предметов на трубы климата ----------

test("124 R2: сервер удалил обратную ссылку предмета на трубу климата — SITE_ERROR", async () => {
  const { model, itemId } = heatScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    delete (s.model as { items?: Record<string, { pipes_heat?: Record<string, string> }> }).items![itemId]!.pipes_heat!.heat_pipe_hot_id;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError && e.code === "SITE_ERROR", String((e as McpError)?.code));
    assert.ok(JSON.stringify((e as McpError).details).includes("heat_pipe_hot_id"));
    return true;
  });
});

test("124 R2: сервер добавил ссылку на несуществующую трубу — SITE_ERROR", async () => {
  const { model, itemId } = heatScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    (s.model as { items?: Record<string, { pipes_heat?: Record<string, string> }> }).items![itemId]!.pipes_heat!.heat_pipe_cold_id = "ghost";
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError && e.code === "SITE_ERROR", String((e as McpError)?.code));
    assert.ok(JSON.stringify((e as McpError).details).includes("ghost"));
    return true;
  });
});

test("124 R2: нормализатор удалил обратную ссылку — NORMALIZATION_DROPPED", async () => {
  const { model, itemId } = heatScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    delete (m as { items?: Record<string, { pipes_heat?: Record<string, string> }> }).items![itemId]!.pipes_heat!.heat_pipe_hot_id;
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED");
  assert.equal(saves, 0, "до записи дело не дошло");
});

test("124 R2: нормализатор добавил ссылку на несуществующую трубу — NORMALIZATION_DROPPED", async () => {
  const { model, itemId } = heatScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saves = 0;
  const ws = saveMock(server, () => { saves++; }, (m) => {
    (m as { items?: Record<string, { pipes_heat?: Record<string, string> }> }).items![itemId]!.pipes_heat!.heat_pipe_cold_id = "ghost";
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "NORMALIZATION_DROPPED");
  assert.equal(saves, 0, "до записи дело не дошло");
});

// ---------- R3: полный состав vertexes, props.id, согласованность polygon/matrix ----------

test("124 R3: сервер удалил все вершины контура (polygon/items/matrix целы) — SITE_ERROR", async () => {
  const { model, wf } = heatScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const g = (s.model as { warm_floors?: Record<string, WarmFloor> }).warm_floors![wf.id]!;
    g.vertexes = [];
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => {
    assert.ok(e instanceof McpError && e.code === "SITE_ERROR", String((e as McpError)?.code));
    assert.ok(JSON.stringify((e as McpError).details).includes("vertexes"));
    return true;
  });
});

test("124 R3: сервер подменил props.id контура — SITE_ERROR", async () => {
  const { model, wf } = heatScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    (s.model as { warm_floors?: Record<string, WarmFloor> }).warm_floors![wf.id]!.props = { id: "other", name: "warm_floor" };
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "SITE_ERROR");
});

test("124 R3: сервер подменил ID одной вершины контура — SITE_ERROR", async () => {
  const { model, wf } = heatScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const g = (s.model as { warm_floors?: Record<string, WarmFloor> }).warm_floors![wf.id]!;
    g.vertexes[1]!.id = "_substituted";
  });
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError && e.code === "SITE_ERROR");
});

test("124 R3: положительный — штатный save с контуром verified, writeBackup подменён (R6)", async () => {
  const { model } = heatScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true);
  // R6: подмена метода writeBackup реально работает (а не кладёт файл в backups/)
  assert.equal(res.backup_path, "/tmp/mock-not-written");
});

// ---------- R4: вогнутая комната ----------

test("124 R4: контур, пересекающий вырез вогнутой комнаты, отвергается OUTSIDE_ROOM до мутации", () => {
  const model = concaveModel();
  const before = JSON.stringify(model);
  // прямоугольник (50,50)–(350,350) см пересекает вырез x=250…280, y=150…350
  assert.throws(
    () => addWf(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 3500, y: 3500 } }),
    (e: unknown) => e instanceof McpError && e.code === "OUTSIDE_ROOM",
  );
  assert.equal(JSON.stringify(model), before, "модель не изменилась");
  // допустимый контур целиком в основной части комнаты
  const wf = addWf(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 2000, y: 2000 } });
  assert.equal(wf.id_room, "r1");
});

test("124 R4: касание в вершине вогнутой комнаты (контур вплотную к вырезу) — допустимо", () => {
  const model = concaveModel();
  // контур (50,50)–(250,140): упирается в угол выреза (250,150) границей, не пересекая
  const wf = addWf(model, { kind: "cable", corner1: { x: 500, y: 500 }, corner2: { x: 2500, y: 1400 } });
  assert.equal(wf.id_room, "r1");
});

// ---------- R5: запись успешна, GET-верификация бросает — save отвергает, а не verified ----------

test("124 R5: запись успешна, GET-верификация упала — save бросает (не verified)", async () => {
  const { model } = heatScenario();
  const server: SaveServer = { saveId: "s1", model: structuredClone(model) as unknown as Record<string, unknown> };
  let saved = false;
  const ws = saveMock(
    server,
    () => { saved = true; },
    undefined,
    { loadModelThrowsAfter: () => saved },
  );
  await ws.open("0", "1");
  await assert.rejects(ws.save(), (e: unknown) => e instanceof McpError);
});
