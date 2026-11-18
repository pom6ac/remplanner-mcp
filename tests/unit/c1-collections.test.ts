// C1 (аудит 65): единый реестр коллекций сущностей.
// 1) Сторож: эталон полной модели (все коллекции реестра, включая ригель и
//    газовую линию) по ключам совпадает с MODEL_ENTITY_COLLECTIONS — новая
//    коллекция в типах без регистрации в реестре ловится ещё на typecheck
//    (сторож компиляции в src/model/collections.ts), а рассинхрон эталона и
//    реестра — красным тестом здесь.
// 2) Импорт заменяет КАЖДУЮ коллекцию импортированной, clear очищает КАЖДУЮ.
// 3) count (modelCounts) считает все коллекции реестра.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { MODEL_ENTITY_COLLECTIONS, MODEL_REQUIRED_COLLECTIONS, PUBLIC_COLLECTION_KEYS, entityCounts, hasEntities } from "../../src/model/collections.ts";
import { modelCounts, modelIsContentEmpty } from "../../src/workspace.ts";
import { compactModel } from "../../src/model/compact.ts";
import { PLANS_DIR } from "../../src/config.ts";
import type { ModelEntityCollection } from "../../src/model/collections.ts";
import type { Model, GasLine, LevelHole, LedStrip, LineStrip, Pipe, StripLight, WarmFloor, FixtureEnvelope } from "../../src/model/types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

// 213 plans-root: путь import/export — относительно корня plans; фикстура и
// модель копируются в корень plans под именами .plan
const FIXTURE_REL = "c1-fixture.plan";
const FULL_REL = "c1-full.plan";
const fixtureRel = (): string => {
  mkdirSync(PLANS_DIR, { recursive: true });
  const p = join(PLANS_DIR, FIXTURE_REL);
  writeFileSync(p, readFileSync(FIXTURE));
  return FIXTURE_REL;
};
const fullRel = (): string => {
  mkdirSync(PLANS_DIR, { recursive: true });
  writeFileSync(join(PLANS_DIR, FULL_REL), JSON.stringify({ model: fullPlanModel() }));
  return FULL_REL;
};
const cleanupPlans = (): void => {
  rmSync(join(PLANS_DIR, FIXTURE_REL), { force: true });
  rmSync(join(PLANS_DIR, FULL_REL), { force: true });
};

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as ToolCallResult).content as { text: string }[])[0]!.text;

async function start(): Promise<{ client: Client; ctx: ServerContext }> {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "c1-collections", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, ctx };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(!res.isError, `${name}: ${text(res)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
}

const POINT = { x: 100, y: 100 };
const EDGE = { length: 1 };

/** Графовая труба (pipes и трубные коллекции климата) в формате редактора. */
function pipe(id: string, type: string): Pipe {
  return {
    id,
    type,
    matrix: [[null, EDGE], [EDGE, null]],
    vertexes: [{ id: `${id}_n1`, point: POINT, type: "node" }],
    items: { [`${id}_n1`]: "node" },
    length: 0.1,
  };
}

function gasLine(id: string): GasLine {
  return { ...pipe(id, "gas_line"), plan: "a" };
}

function levelHole(id: string): LevelHole {
  return {
    ...pipe(id, "floor_hole"),
    plan: "a",
    polygon: [POINT, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 }],
    id_room: null,
    area: 1,
    pc: { x: 150, y: 150 },
  };
}

function ledStrip(id: string): LedStrip {
  return { ...pipe(id, "led_strip"), props: { id, name: "led_strip" }, on_size: 1 };
}

function stripLight(id: string, type: string): StripLight {
  return { ...ledStrip(id), type, spots: {}, line_spots: [] };
}

function lineStrip(id: string): LineStrip {
  return { ...ledStrip(id), type: "line_light", plan: "light", prs: {} };
}

function warmFloor(id: string): WarmFloor {
  return {
    ...pipe(id, "warm_floor"),
    polygon: [POINT, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 }],
    id_room: null,
    props: { id, name: "warm_floor" },
    area: 1,
  };
}

/**
 * Эталон: все коллекции реестра, по одной сущности в каждой (включая ригель
 * и газовую линию). Тип Pick<Model, ModelEntityCollection> требует, чтобы при
 * добавлении коллекции в типы + реестр эталон тоже пополнялся (иначе
 * typecheck красный), а рассинхрон с реестром ловит тест-сторож.
 */
const FULL_COLLECTIONS: Pick<Model, ModelEntityCollection> = {
  walls: { w1: { id: "w1", plan: "a", role: "wall", depth: 20, height: 280, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, holes: {}, material: "a_block" } },
  items: { i1: { id: "i1", name: "sofa_triple", pc: POINT, angle: 0, width: 100, height: 50, plan: {} } },
  pillars: { pi1: { id: "pi1", plan: "a", role: "pillar", width: 40, height: 40, angle: 0, pc: POINT, p1: { x: 0, y: 0 }, p2: { x: 4, y: 0 }, p3: { x: 4, y: 4 }, p4: { x: 0, y: 4 } } },
  rigels: { r1: { id: "r1", p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, depth: 10, height: 10, ceiling_type: "", polygon: [], l: { p1: POINT, p2: { x: 101, y: 100 } }, r: { p1: { x: 100, y: 0 }, p2: POINT } } },
  pipes_gas: { g1: gasLine("g1") },
  pipes: { wp1: pipe("wp1", "water_pipe") },
  terrace_borders: { tb1: { id: "tb1", p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } } },
  territory_borders: { tb2: { id: "tb2", p1: { x: 0, y: 100 }, p2: { x: 10, y: 100 } } },
  level_holes: { lh1: levelHole("lh1") },
  led_strips: { ls1: ledStrip("ls1") },
  stripes_light: { sl1: stripLight("sl1", "pendent_strip") },
  line_strips: { ll1: lineStrip("ll1") },
  cables: { cb1: { ...pipe("cb1", "cable"), color_custom: "", on_arc: 0 } },
  rulers: { ru1: { id: "ru1", p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, offset: { val: 5, side: "a" }, plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, color: "#ed143d" } },
  comments: { c1: { id: "c1", pc: POINT, points: [POINT], text: "тест", label: "free", plan: "a", plan_: 0, prs: { room: 0, mode: 1 }, font_size: 10 } },
  warm_floors: { wf1: warmFloor("wf1") },
  pipes_warm_floor: { pwf1: pipe("pwf1", "warm_floor_pipe") },
  pipes_conditioner: { pc1: pipe("pc1", "conditioner_drainage") },
  pipes_heat: { ph1: pipe("ph1", "heat_pipe_hot") },
  pipes_ventilation: { pv1: pipe("pv1", "ventpipe_out") },
};

/** Полная модель импорта: эталон + корневые поля Model. */
function fullPlanModel(): Model {
  const m = structuredClone(FULL_COLLECTIONS) as unknown as Model;
  m.v = 1;
  m.id = "c1test";
  m.plan_id = "1";
  m.total_height = 270;
  m.final = false;
  return m;
}

function fixtureModel(): Model {
  const env = JSON.parse(readFileSync(FIXTURE, "utf8")) as FixtureEnvelope;
  return structuredClone(env.model);
}

test("c1 сторож: эталон полной модели по ключам совпадает с реестром коллекций", () => {
  assert.deepEqual(
    Object.keys(FULL_COLLECTIONS).sort(),
    [...MODEL_ENTITY_COLLECTIONS].sort(),
    "эталон полной модели и реестр MODEL_ENTITY_COLLECTIONS разошлись — добавьте коллекцию в обе стороны",
  );
  assert.ok(MODEL_ENTITY_COLLECTIONS.includes("rigels"), "ригели в реестре");
  assert.ok(MODEL_ENTITY_COLLECTIONS.includes("pipes_gas"), "газовая линия в реестре");
  assert.equal(new Set(MODEL_ENTITY_COLLECTIONS).size, MODEL_ENTITY_COLLECTIONS.length, "в реестре нет дубликатов");
});

test("c1: entityCounts/hasEntities считают все коллекции реестра", () => {
  const m = fullPlanModel();
  const counts = entityCounts(m);
  assert.deepEqual(Object.keys(counts).sort(), [...MODEL_ENTITY_COLLECTIONS].sort());
  for (const key of MODEL_ENTITY_COLLECTIONS) assert.equal(counts[key], 1, `${key}: 1 сущность`);
  assert.equal(hasEntities(m), true);
  // модель только с кабелями — не пустая (раньше cables выпадали из empty)
  const cablesOnly = fixtureModel();
  cablesOnly.cables = { cb1: { ...pipe("cb1", "cable"), color_custom: "", on_arc: 0 } };
  assert.equal(hasEntities(cablesOnly), true);
  assert.equal(modelIsContentEmpty(cablesOnly), false);
  assert.equal(modelIsContentEmpty(fixtureModel()), false);
});

test("c1: modelCounts — публичные ключи по compact model_get + walls/openings", () => {
  const c = modelCounts(fullPlanModel());
  assert.deepEqual(
    Object.keys(c).sort(),
    [...MODEL_ENTITY_COLLECTIONS.filter((k) => k !== "walls").map((k) => PUBLIC_COLLECTION_KEYS[k]), "openings", "walls"].sort(),
  );
  assert.equal(c.walls, 1);
  assert.equal(c.gas_lines, 1, "gas_lines считается");
  assert.equal(c.cables, 1);
  assert.equal(c.rulers, 1);
  assert.equal(c.comments, 1);
  assert.equal(c.openings, 0);
});

test("c1: публичные ключи счётчиков — словарь compact model_get; gas_lines есть, pipes_gas нет", () => {
  const model = fullPlanModel();
  const c = modelCounts(model) as unknown as Record<string, number>;
  const compactKeys = new Set(Object.keys(compactModel(model)));
  for (const key of MODEL_ENTITY_COLLECTIONS) {
    const pub = PUBLIC_COLLECTION_KEYS[key];
    assert.ok(pub in c, `${pub} присутствует в counts`);
    if (key === "walls" || key === "rulers" || key === "comments") continue; // walls — спецсчётчик, rulers/comments — аддитивные ключи
    assert.ok(compactKeys.has(pub), `${pub} есть в compact model_get`);
  }
  assert.ok(!("pipes_gas" in c), "внутреннее имя pipes_gas в публичном выводе отсутствует");
});

test("c1: project_import_plan заменяет ВСЕ коллекции импортированными (включая ригель и газ)", async () => {
  const { client } = await start();
  const planPath = fullRel();
  try {
    await call(client, "project_import_plan", { path: planPath, replace: true });
    const m = (await call(client, "model_get", { detail: "full" })) as unknown as Model;
    const counts = entityCounts(m);
    for (const key of MODEL_ENTITY_COLLECTIONS) {
      assert.equal(counts[key], 1, `${key} после импорта = ${counts[key]}`);
    }
    assert.equal(Object.keys(m.rigels ?? {}).length, 1, "ригель импортирован");
    assert.equal(Object.keys((m as unknown as Record<string, Record<string, unknown>>).pipes_gas ?? {}).length, 1, "газовая линия импортирована");
    // повторный импорт фикстуры (без новых коллекций) убирает их из модели
    await call(client, "project_import_plan", { path: fixtureRel(), replace: true });
    const after = (await call(client, "model_get", { detail: "full" })) as unknown as Model;
    const fx = fixtureModel();
    for (const key of MODEL_ENTITY_COLLECTIONS) {
      assert.deepEqual(after[key] ?? {}, fx[key] ?? {}, `${key} после повторного импорта = содержимому импортируемой модели`);
    }
  } finally {
    await client.close();
    cleanupPlans();
  }
});

test("c1: project_clear очищает ВСЕ коллекции (включая ригель и газ); undo восстанавливает", async () => {
  const { client } = await start();
  const planPath = fullRel();
  try {
    await call(client, "project_import_plan", { path: planPath, replace: true });
    await call(client, "project_clear", { confirm: true });
    const cleared = (await call(client, "model_get", { detail: "full" })) as unknown as Model;
    for (const key of MODEL_ENTITY_COLLECTIONS) {
      if ((MODEL_REQUIRED_COLLECTIONS as readonly string[]).includes(key)) {
        assert.deepEqual(cleared[key], {}, `${key} (обязательная) после clear — пустой объект`);
      } else {
        assert.equal(cleared[key], undefined, `${key} после clear удалена`);
      }
    }
    const undone = await call(client, "undo", {});
    assert.equal((undone as { applied: number }).applied, 1);
    const restored = (await call(client, "model_get", { detail: "full" })) as unknown as Model;
    const counts = entityCounts(restored);
    for (const key of MODEL_ENTITY_COLLECTIONS) assert.equal(counts[key], 1, `${key} после undo = ${counts[key]}`);
  } finally {
    await client.close();
    cleanupPlans();
  }
});
