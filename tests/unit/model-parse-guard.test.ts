// Дефект 3 (отчёт 11-user-trial-1): project_open не возвращает пустую модель молча —
// если сервер отдал непустой data или save_id > 0, а разобранная модель пустая,
// то MODEL_PARSE_EMPTY; сохранение такого проекта блокируется без force;
// project_save сверяет счётчики с серверной версией и предупреждает об удалениях.
import "./helpers/tmp-home.ts";
// Ревью v0.1.1 №2: валидная пустая модель — не потеря данных. Новый или очищенный
// проект должен открываться. MODEL_PARSE_EMPTY — только когда data непустой, разбор
// дал пустую модель, а в сыром JSON есть объекты (схема не распознана); проверка по
// сырому JSON, не по save_id (save_id > 0 не доказывает наличие объектов).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace, type WorkspaceDeps, type EditorLike, type SaveOutcome } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import type { Model, FixtureEnvelope } from "../../src/model/types.ts";
import { McpError } from "../../src/errors.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function fixtureModel(): Model {
  const env = JSON.parse(
    readFileSync(join(ROOT, "tests/fixtures/anon-rect-4000x3000.json"), "utf8"),
  ) as FixtureEnvelope;
  return structuredClone(env.model);
}

function emptyModel(): Model {
  return { v: 3, id: "0", plan_id: "0", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: true };
}

type Server = { saveId: string; model: Model; dataEmpty: boolean };

function mockDeps(server: Server) {
  let lastNormalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "123", planId: "1",
    async normalize(model) {
      const walls = (model as { walls: Record<string, unknown> }).walls;
      lastNormalized = structuredClone(model) as Record<string, unknown>;
      return {
        model: structuredClone(model) as unknown as Record<string, unknown>,
        rooms: [],
        before: { walls: Object.keys(walls).length, holes: 0, items: 0 },
        after: { walls: Object.keys(walls).length, holes: 0, items: 0 },
      };
    },
    async save() {
      server.saveId = "s_saved";
      server.model = (lastNormalized ?? emptyModel()) as unknown as Model;
      return { ok: true, saveId: server.saveId, conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { throw new Error("not used"); },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(_s, _oid, _pid): Promise<LoadedModel> {
      return {
        object_id: "123", plan_id: "1", save_id: server.saveId, units: "cm",
        data_empty: server.dataEmpty,
        model: structuredClone(server.model) as unknown as Record<string, unknown>,
      };
    },
    async openEditor() { return editor; },
  };
  return { deps, editor };
}

test("parse-guard: валидная пустая модель в непустом data открывается (было MODEL_PARSE_EMPTY)", async () => {
  const server: Server = { saveId: "0", model: emptyModel(), dataEmpty: false };
  const ws = new Workspace(mockDeps(server).deps);
  const p = await ws.open("123", "1");
  assert.equal(p.saveId, "0");
  assert.equal(Object.keys(ws.model.walls).length, 0);
});

test("parse-guard: data пустой, save_id > 0 → открывается (save_id не доказывает объекты)", async () => {
  const server: Server = { saveId: "8", model: emptyModel(), dataEmpty: true };
  const ws = new Workspace(mockDeps(server).deps);
  const p = await ws.open("123", "1");
  assert.equal(p.saveId, "8");
});

test("parse-guard: data непустой, разобранная модель пустая, в сыром JSON объекты → MODEL_PARSE_EMPTY", async () => {
  // схема, которую адаптер не разобрал: сущности в необработанных полях
  const server: Server = { saveId: "0", model: { v: 3, floors: [{ id: "f1" }] } as unknown as Model, dataEmpty: false };
  const ws = new Workspace(mockDeps(server).deps);
  await assert.rejects(
    ws.open("123", "1"),
    (e: unknown) => {
      assert.ok(e instanceof McpError);
      assert.equal(e.code, "MODEL_PARSE_EMPTY");
      return true;
    },
  );
});

test("parse-guard: круг сохранения пустого проекта — save, повторный open, снова save", async () => {
  const server: Server = { saveId: "0", model: emptyModel(), dataEmpty: false };
  const { deps } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const res = await ws.save();
  assert.ok(res.verified);
  // проект очищен на сервере (data непустой JSON пустой модели) — открывается
  server.dataEmpty = false;
  const ws2 = new Workspace(deps);
  const p = await ws2.open("123", "1");
  assert.equal(Object.keys(ws2.model.walls).length, 0);
  const res2 = await ws2.save();
  assert.ok(res2.verified);
});

test("parse-guard: пустой проект без сохранений (data пустой, save_id 0) открывается", async () => {
  const server: Server = { saveId: "0", model: emptyModel(), dataEmpty: true };
  const ws = new Workspace(mockDeps(server).deps);
  const p = await ws.open("123", "1");
  assert.equal(p.saveId, "0");
  assert.equal(Object.keys(ws.model.walls).length, 0);
});

test("parse-guard: project_save на проекте, открытом пустым, при непустой серверной — ошибка; force пишет", async () => {
  const server: Server = { saveId: "0", model: emptyModel(), dataEmpty: true };
  const { deps } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  // в другой вкладке на сервере появилась модель
  server.model = fixtureModel();
  server.dataEmpty = false;
  await assert.rejects(
    ws.save(),
    (e: unknown) => {
      assert.ok(e instanceof McpError);
      assert.equal(e.code, "SAVE_CONFLICT");
      assert.match(e.message, /пустой/);
      return true;
    },
  );
  // force: true — принудительная запись пустой модели
  const res = await ws.save({ force: true });
  assert.ok(res.save_id);
});

// Ревью v0.1.1 №5: will_delete — разность идентичностей (id объектов сервера, которых
// нет локально), а не разность общих счётчиков: удаление существующего предмета с
// добавлением нового не должно маскировать удаление.
test("parse-guard: will_delete по id — удаление + добавление при равных счётчиках не маскируется", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel(), dataEmpty: false };
  const serverModel = server.model as Model;
  serverModel.items["srv_old"] = {
    id: "srv_old", name: "sofa", pc: { x: 200, y: 150 }, angle: 0, width: 100, height: 100,
    plan: { furniture: 1 },
  };
  const { deps } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  // локально: удаляем существующие предмет и проём, добавляем новые с другими id —
  // счётчики равны серверным, но объекты сервера будут удалены
  ws.apply("replace", (m) => {
    delete m.items["srv_old"];
    m.items["srv_new"] = {
      id: "srv_new", name: "table", pc: { x: 250, y: 150 }, angle: 0, width: 100, height: 100,
      plan: { furniture: 1 },
    };
    const wallId = Object.keys(m.walls).find((k) => Object.keys(m.walls[k]!.holes).length > 0)!;
    const holeId = Object.keys(m.walls[wallId]!.holes)[0]!;
    delete m.walls[wallId]!.holes[holeId];
    m.walls[wallId]!.holes["hole_new"] = { id: "hole_new", pc: { x: 300, y: 0 } } as Model["walls"][string]["holes"][string];
    return true;
  });
  const res: SaveOutcome = await ws.save();
  assert.deepEqual(res.will_delete, { walls: 0, openings: 1, items: 1, pillars: 0, rigels: 0, gas_lines: 0, pipes: 0, terrace_borders: 0, territory_borders: 0, level_holes: 0, led_strips: 0, stripes_light: 0, line_strips: 0, cables: 0, cables_socket: 0, cables_warm_floor: 0, cables_conditioner: 0, rulers: 0, comments: 0, shields: 0, warm_floors: 0, zone_delimiters: 0, pipes_warm_floor: 0, pipes_conditioner: 0, pipes_heat: 0, pipes_ventilation: 0 });
  assert.ok(res.warnings.some((w) => w.includes("srv_old")), res.warnings.join("; "));
  const lostHole = res.warnings.find((w) => /проём/.test(w)) ?? "";
  assert.ok(/apuny6wral|pbwydi1o66/.test(lostHole), `в предупреждении id удалённого проёма: ${lostHole}`);
});

test("parse-guard: project_save предупреждает, сколько объектов сервера будет удалено", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel(), dataEmpty: false };
  // на сервере есть предметы, которых нет в локальной модели
  const serverModel = server.model as Model;
  serverModel.items["srv1"] = {
    id: "srv1", name: "sofa", pc: { x: 200, y: 150 }, angle: 0, width: 100, height: 100,
    plan: { furniture: 1 },
  };
  serverModel.items["srv2"] = {
    id: "srv2", name: "table", pc: { x: 250, y: 150 }, angle: 0, width: 100, height: 100,
    plan: { furniture: 1 },
  };
  const { deps } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  // локально предмет srv2 удалён: серверная версия имеет на 1 предмет больше —
  // при записи он пропадёт с сервера, project_save обязан об этом предупредить
  ws.apply("item_delete", (m) => { delete m.items["srv2"]; return true; });
  const res: SaveOutcome = await ws.save();
  assert.deepEqual(res.will_delete, { walls: 0, openings: 0, items: 1, pillars: 0, rigels: 0, gas_lines: 0, pipes: 0, terrace_borders: 0, territory_borders: 0, level_holes: 0, led_strips: 0, stripes_light: 0, line_strips: 0, cables: 0, cables_socket: 0, cables_warm_floor: 0, cables_conditioner: 0, rulers: 0, comments: 0, shields: 0, warm_floors: 0, zone_delimiters: 0, pipes_warm_floor: 0, pipes_conditioner: 0, pipes_heat: 0, pipes_ventilation: 0 });
  assert.ok(res.warnings.some((w) => w.includes("1") && w.includes("предмет")), res.warnings.join("; "));
  // публичные ключи will_delete — словарь compact model_get: gas_lines есть, pipes_gas нет
  const willDelete = res.will_delete as unknown as Record<string, number>;
  assert.ok("gas_lines" in willDelete, "will_delete содержит gas_lines");
  assert.ok(!("pipes_gas" in willDelete), "will_delete не содержит внутреннего pipes_gas");
});

// Ревью v0.1.1 финал F-1: смена идентификатора стены (нормализация редактора
// переименовала стену, геометрия сохранена) — не удаление. Предупреждение
// «будут удалены стены» при сохранённой геометрии ложно.
test("parse-guard: will_delete — переименование стены с сохранённой геометрией — не удаление", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel(), dataEmpty: false };
  const { deps } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  // локально: стена сервера переименована (id другой, координаты и проёмы те же)
  ws.apply("replace", (m) => {
    const [oldId, wall] = Object.entries(m.walls)[0]!;
    delete m.walls[oldId];
    m.walls["renamed_wall"] = structuredClone(wall) as Model["walls"][string];
    m.walls["renamed_wall"]!.id = "renamed_wall";
    return true;
  });
  const res: SaveOutcome = await ws.save();
  assert.deepEqual(res.will_delete.walls, 0);
  assert.ok(
    res.warnings.some((w) => /идентификатор/.test(w) && /стен/.test(w)),
    `предупреждение о смене идентификаторов стен: ${res.warnings.join("; ")}`,
  );
});

test("parse-guard: will_delete — реальное удаление стены остаётся удалением", async () => {
  const server: Server = { saveId: "s1", model: fixtureModel(), dataEmpty: false };
  const { deps } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  ws.apply("replace", (m) => {
    const wallId = Object.keys(m.walls)[0]!;
    delete m.walls[wallId];
    return true;
  });
  const res: SaveOutcome = await ws.save();
  assert.deepEqual(res.will_delete.walls, 1);
  assert.ok(res.warnings.some((w) => /будут удалены стены/.test(w)), res.warnings.join("; "));
});
