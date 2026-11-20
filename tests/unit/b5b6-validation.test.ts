// B5+B6 (аудит 65, этап 169): структурная валидация импорта (.plan) и лимиты
// входа инструментов. Негативные тесты на каждое правило, позитивные — все
// текущие фикстуры-эталоны проходят импорт. Офлайн: сеть не используется.
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { readPlanFile } from "../../src/server/tools-projects.ts";
import { parseModelImport } from "../../src/model/import-schema.ts";
import { MODEL_ENTITY_COLLECTIONS } from "../../src/model/collections.ts";
import { PLANS_DIR } from "../../src/config.ts";
import { McpError } from "../../src/errors.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as ToolCallResult).content as { text: string }[])[0]!.text;

async function start(): Promise<Client> {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "b5b6-validation", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

function baseModel(): Record<string, unknown> {
  return {
    v: 3, id: "0", plan_id: "0",
    walls: {}, items: {}, pillars: {}, rulers: {}, comments: {},
    total_height: 270, final: true,
  };
}

function wall(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "w1", plan: "a", role: "wall", depth: 20, height: 270, p1: { x: 0, y: 0 }, p2: { x: 400, y: 0 }, holes: {}, ...extra };
}

function assertRejected(model: unknown, pathRe: RegExp, why: string): void {
  assert.throws(() => parseModelImport(model), (e: unknown) => {
    assert.ok(e instanceof McpError, `${why}: не McpError`);
    assert.equal((e as McpError).code, "INVALID_ARGUMENT", `${why}: код не INVALID_ARGUMENT`);
    assert.match((e as McpError).message, pathRe, `${why}: путь ${pathRe} не в сообщении: ${(e as McpError).message}`);
    return true;
  }, why);
}

// ---------- негативные: структура коллекций ----------

test("b5: walls не словарь (строка/массив) — INVALID_ARGUMENT с путём", () => {
  for (const walls of ["bad", []]) {
    const m = { ...baseModel(), walls };
    assertRejected(m, /model\.walls/, `walls=${JSON.stringify(walls).slice(0, 20)}`);
  }
});

test("b5: items/pillars/rulers/comments не словари — INVALID_ARGUMENT", () => {
  for (const key of ["items", "pillars", "rulers", "comments"]) {
    const m = { ...baseModel(), [key]: "bad" };
    assertRejected(m, new RegExp(`model\\.${key}`), key);
  }
});

test("b5: объекты коллекций не объекты — INVALID_ARGUMENT с путём", () => {
  assertRejected({ ...baseModel(), walls: { w1: "bad" } }, /model\.walls\.w1/, "wall-строка");
  assertRejected({ ...baseModel(), items: { i1: 42 } }, /model\.items\.i1/, "item-число");
});

// ---------- негативные: числа, диапазоны, лимиты ----------

test("b5: нечисловая координата — путь к полю", () => {
  const m = { ...baseModel(), walls: { w1: wall({ p1: { x: "abc", y: 0 } }) } };
  assertRejected(m, /model\.walls\.w1\.p1\.x/, "p1.x строка");
});

test("b5: бесконечная координата (1e999) — путь к полю", () => {
  const m = { ...baseModel(), walls: { w1: wall({ p2: { x: 400, y: 1e999 } }) } };
  assertRejected(m, /model\.walls\.w1\.p2\.y/, "p2.y Infinity");
});

test("b5: координата вне диапазона (1e8 см = 1000 км) — INVALID_ARGUMENT", () => {
  const m = { ...baseModel(), walls: { w1: wall({ p2: { x: 1e8, y: 0 } }) } };
  assertRejected(m, /model\.walls\.w1\.p2\.x/, "x за пределом");
});

test("b5: отрицательный/завышенный размер стены — INVALID_ARGUMENT", () => {
  assertRejected({ ...baseModel(), walls: { w1: wall({ depth: -5 }) } }, /model\.walls\.w1\.depth/, "depth<0");
  assertRejected({ ...baseModel(), walls: { w1: wall({ height: 2e5 }) } }, /model\.walls\.w1\.height/, "height>лимита");
});

test("b5: число в неизвестном (passthrough) поле — конечность проверяется", () => {
  const m = { ...baseModel(), strange_editor_field: { deep: { v: 1e999 } } };
  assertRejected(m, /model\.strange_editor_field\.deep\.v/, "Infinity в неизвестном поле");
});

test("b5: слишком много стен (лимит MAX_IMPORT_WALLS=500) — INVALID_ARGUMENT", () => {
  const walls: Record<string, unknown> = {};
  for (let i = 0; i < 501; i++) walls[`w${i}`] = wall({ id: `w${i}` });
  assertRejected({ ...baseModel(), walls }, /model\.walls.*лимит 500/, "501 стена");
});

test("b5: слишком глубокая вложенность (лимит 64) — INVALID_ARGUMENT", () => {
  let deep: Record<string, unknown> = {};
  const cur = deep;
  for (let i = 0; i < 80; i++) { deep["n"] = {}; deep = deep["n"] as Record<string, unknown>; }
  assertRejected({ ...baseModel(), strange_editor_field: cur }, /вложенность глубже 64/, "глубина 80");
});

test("b5: слишком много сущностей в необязательной коллекции — INVALID_ARGUMENT", () => {
  const pipes_gas: Record<string, unknown> = {};
  for (let i = 0; i < 2001; i++) pipes_gas[`g${i}`] = { id: `g${i}` };
  assertRejected({ ...baseModel(), pipes_gas }, /model\.pipes_gas.*лимит 2000/, "2001 труба");
});

test("b5: неверный sheet отклонён схемой render_plan, click не доходит", async () => {
  const client = await start();
  try {
    for (const sheet of ["x, #unrelated", "a b", "#furniture", "furniture]", "furniture'"]) {
      const res = await client.callTool({ name: "render_plan", arguments: { sheet } });
      assert.ok(res.isError, `sheet ${JSON.stringify(sheet)} должен быть отклонён`);
      assert.match(text(res), /-32602/, "ошибка схемы, не исполнения");
    }
  } finally {
    await client.close();
  }
});

test("b5: width_px > лимита отклонён схемой render_plan", async () => {
  const client = await start();
  try {
    const res = await client.callTool({ name: "render_plan", arguments: { width_px: 5000 } });
    assert.ok(res.isError);
    assert.match(text(res), /-32602/);
  } finally {
    await client.close();
  }
});

test("b5: полигоны/ломаные длиннее лимита отклонены схемой", async () => {
  const client = await start();
  try {
    const many = Array.from({ length: 201 }, (_, i) => ({ x: i * 10, y: 0 }));
    const res = await client.callTool({ name: "walls_add_polyline", arguments: { points: many } });
    assert.ok(res.isError, "201 точка ломаной отклонена");
    assert.match(text(res), /-32602/);
    const poly = Array.from({ length: 65 }, (_, i) => ({ x: i * 10, y: 0 }));
    const res2 = await client.callTool({ name: "room_add_polygon", arguments: { points: poly } });
    assert.ok(res2.isError, "65 вершин полигона отклонены");
    assert.match(text(res2), /-32602/);
    // границы не задевают нормальные входы: 64 вершины проходят схему
    // (исполнение упадёт на геометрии — проверяем, что ошибка НЕ схемы)
    const res3 = await client.callTool({ name: "room_add_polygon", arguments: { points: poly.slice(0, 64) } });
    assert.ok(!String(text(res3)).includes("-32602"), "64 вершины — не ошибка схемы");
  } finally {
    await client.close();
  }
});

// ---------- readPlanFile: конверт и ошибки ----------

test("b5: readPlanFile на файле с walls-строкой — INVALID_ARGUMENT с путём, без содержимого файла", () => {
  const dir = mkdtempSync(join(tmpdir(), "b5b6-"));
  try {
    const secretMarker = "SECRET_CANARY_4242_content_marker_xxxxxxxxxxxxxxxx";
    const p = join(dir, "bad.plan");
    writeFileSync(p, JSON.stringify({ model: { ...baseModel(), walls: "bad", marker: secretMarker } }));
    assert.throws(() => readPlanFile(p), (e: unknown) => {
      assert.ok(e instanceof McpError);
      assert.equal((e as McpError).code, "INVALID_ARGUMENT");
      assert.match((e as McpError).message, /model\.walls/);
      assert.ok(!(e as McpError).message.includes(secretMarker), "содержимое файла не выходит в ошибку");
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("b5: глубоко вложенный файл — INVALID_ARGUMENT про вложенность", () => {
  const dir = mkdtempSync(join(tmpdir(), "b5b6-"));
  try {
    let deep: Record<string, unknown> = {};
    const root: Record<string, unknown> = deep;
    for (let i = 0; i < 80; i++) { deep["n"] = {}; deep = deep["n"] as Record<string, unknown>; }
    const p = join(dir, "deep.plan");
    writeFileSync(p, JSON.stringify({ model: { ...baseModel(), strange: root } }));
    assert.throws(() => readPlanFile(p), (e: unknown) => {
      assert.ok(e instanceof McpError);
      assert.equal((e as McpError).code, "INVALID_ARGUMENT");
      assert.match((e as McpError).message, /вложенность/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- позитивные: все текущие фикстуры-эталоны ----------

test("b5: все фикстуры-модели проходят импортную валидацию, не-модели отклоняются", () => {
  const MODEL_KEYS = ["walls", "items", "pillars", "rulers", "comments", "plan_id", "total_height", "floors", "plans", "v"];
  let checked = 0;
  for (const f of readdirSync(join(ROOT, "tests/fixtures")).filter((f) => f.endsWith(".json"))) {
    const env: unknown = JSON.parse(readFileSync(join(ROOT, "tests/fixtures", f), "utf8"));
    const root = env !== null && typeof env === "object" && !Array.isArray(env) ? env as Record<string, unknown> : null;
    if (root === null) continue;
    const model = "model" in root ? root["model"] : root;
    if (model === null || typeof model !== "object" || Array.isArray(model)) continue;
    const isModel = Object.keys(model as Record<string, unknown>).some((k) => MODEL_KEYS.includes(k));
    if (!isModel) continue; // технические ответы/каталог/дампы — не планы
    checked++;
    // ui-ref-mouse-drawing — дамп рантайма редактора (walls массивом), не
    // канонический .plan: валидатор обязан его отклонить (walls — не словарь)
    if (f === "ui-ref-mouse-drawing.json") {
      assertRejected(model, /model\.walls/, "рантайм-дамп с walls-массивом");
      continue;
    }
    assert.doesNotThrow(() => parseModelImport(model), `${f}: эталон должен проходить импорт`);
  }
  assert.ok(checked >= 10, `проверено моделей ${checked}, ожидалось >= 10`);
});

test("b5: неизвестные поля редактора сохраняются при импорте (passthrough)", () => {
  const m = {
    ...baseModel(),
    walls: { w1: wall({ extra_runtime_field: { vd: 1 }, bak: { x: 1 } }) },
    unknown_editor_field: { keep: true },
    floors: [{ floor_id: "1" }],
  };
  const out = parseModelImport(m) as Record<string, unknown>;
  const w = (out["walls"] as Record<string, Record<string, unknown>>)["w1"]!;
  assert.deepEqual(w["extra_runtime_field"], { vd: 1 }, "неизвестное поле стены сохранено");
  assert.deepEqual(out["unknown_editor_field"], { keep: true }, "неизвестное поле модели сохранено");
  assert.deepEqual(out["floors"], [{ floor_id: "1" }], "floors сохранены");
});

// ---------- позитивные: эталоны сущностей по коллекциям (ревью 170 №1–№3) ----------

// Ревью 170 №3: позитивный тест по фикстурам-моделям не видит эталоны сущностей
// (model_object / entity / model_cable / сущность на верхнем уровне), поэтому
// расхождения схемы с форматом редактора проходили незамеченными. Здесь каждый
// эталон сущности прогоняется через схему СВОЕЙ коллекции, а отдельный тест
// требует, чтобы у каждой коллекции реестра MODEL_ENTITY_COLLECTIONS был хотя
// бы один позитивный эталон (нет эталона — тест красный).

// Трубные коллекции без отдельных эталонов покрыты синтетическими ui-ref-pipe-*
// (тип → коллекция, как в CLIMATE_PIPE_KINDS из src/model/pipes.ts).
const PIPE_TYPE_TO_COLL: Record<string, string> = {
  water_pipe: "pipes",
  water_hot_pipe: "pipes",
  drainage_pipe: "pipes",
  warm_floor_pipe: "pipes_warm_floor",
  conditioner_drainage: "pipes_conditioner",
  heat_pipe_hot: "pipes_heat",
  heat_pipe_cold: "pipes_heat",
  ventpipe_out: "pipes_ventilation",
  ventpipe_in: "pipes_ventilation",
};

/** Кабели-проводка (часть 2): ключ инструмента UI → коллекция (как в ELEC_CABLE_TOOLS). */
const ELEC_TOOL_TO_COLL: Record<string, string> = {
  warm_floor_wire: "cables_warm_floor",
  conditioner_wire: "cables_conditioner",
};
for (const t of ["wire_2_05", "wire_2_07", "wire_2_15", "wire_2_25", "wire_2_40", "wire_2_60",
  "wire_3_15", "wire_3_25", "wire_3_40", "wire_3_60", "wire_3_100",
  "wire_4_15", "wire_4_25", "wire_4_40", "wire_4_60", "wire_4_100",
  "wire_5_15", "wire_5_25", "wire_5_40", "wire_5_60", "wire_5_100",
  "wire_earth_1_40", "wire_earth_1_100", "wire_earth_3_15", "wire_earth_3_60",
  "wire_tv", "wire_utp", "wire_hdmi", "wire_audio", "wire_phone", "wire_optical"]) {
  ELEC_TOOL_TO_COLL[t] = "cables_socket";
}

/** Эталон(ы) сущности из фикстуры → [коллекция, сущность]. Не эталон — пусто. */
function fixtureEntities(name: string, root: Record<string, unknown>): [string, unknown][] {
  const out: [string, unknown][] = [];
  const push = (coll: string, v: unknown): void => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) out.push([coll, v]);
  };
  const mo = root["model_object"];
  if (mo !== undefined && mo !== null && typeof mo === "object") {
    if (name.startsWith("ui-ref-rigel-")) push("rigels", mo);
    else if (name.startsWith("ui-ref-pillar-")) push("pillars", mo);
    else if (name.startsWith("ui-ref-light-led_strip")) push("led_strips", mo);
    else if (name.startsWith("ui-ref-light-line_light")) push("line_strips", mo);
    else if (name.startsWith("ui-ref-light-pendent_strip")) push("stripes_light", mo);
    else if (name.startsWith("ui-ref-climate-wf-")) push("warm_floors", mo);
    else if (name.startsWith("ui-ref-comm-gas_line")) push("pipes_gas", mo);
    else if (name.startsWith("ui-ref-pipe-")) push(PIPE_TYPE_TO_COLL[String((mo as { type?: string })["type"])] ?? "pipes", mo);
    else {
      const coll = PIPE_TYPE_TO_COLL[String((mo as { type?: string })["type"])]
        ?? ELEC_TOOL_TO_COLL[String((mo as { type?: string })["type"])];
      if (coll !== undefined) push(coll, mo);
      else push("items", mo);
    }
  }
  push("cables", root["model_cable"]);
  const ent = root["entity"];
  if (ent !== undefined && ent !== null && typeof ent === "object") {
    if (name.includes("fence")) push("walls", ent);
    else if (name.includes("terrace-column")) push("pillars", ent);
    else if (name.includes("territory")) push("territory_borders", ent);
    else if (name.includes("terrace-border")) push("terrace_borders", ent);
    else if (name.includes("floorhole")) push("level_holes", ent);
  }
  // щитки: эталоны ui-ref-shield-* несут словарь shields (этап 255)
  const shieldDict = root["shields"];
  if (shieldDict !== null && typeof shieldDict === "object" && !Array.isArray(shieldDict)) {
    for (const s of Object.values(shieldDict as Record<string, unknown>)) push("shields", s);
  }
  // свободные стены: эталоны ui-ref-free-wall-* несут словарь walls
  const walls = root["walls"];
  if (walls !== null && typeof walls === "object" && !Array.isArray(walls)) {
    for (const w of Object.values(walls as Record<string, unknown>)) push("walls", w);
  }
  // размеры и комментарии: эталоны ui-ref-dims-* несут сущность на верхнем уровне
  if (root["p1"] !== undefined && root["offset"] !== undefined && root["prs"] !== undefined) push("rulers", root);
  if (root["pc"] !== undefined && root["points"] !== undefined && root["prs"] !== undefined) push("comments", root);
  return out;
}

function allFixtureEntities(): Map<string, string[]> {
  const covered = new Map<string, string[]>();
  for (const f of readdirSync(join(ROOT, "tests/fixtures")).filter((f) => f.endsWith(".json")).sort()) {
    const env: unknown = JSON.parse(readFileSync(join(ROOT, "tests/fixtures", f), "utf8"));
    if (env === null || typeof env !== "object" || Array.isArray(env)) continue;
    for (const [coll, entity] of fixtureEntities(f, env as Record<string, unknown>)) {
      const list = covered.get(coll) ?? [];
      list.push(f);
      covered.set(coll, list);
    }
  }
  return covered;
}

test("b5/171: каждый эталон сущности проходит валидацию в своей коллекции", () => {
  let checked = 0;
  for (const f of readdirSync(join(ROOT, "tests/fixtures")).filter((f) => f.endsWith(".json")).sort()) {
    const env: unknown = JSON.parse(readFileSync(join(ROOT, "tests/fixtures", f), "utf8"));
    if (env === null || typeof env !== "object" || Array.isArray(env)) continue;
    for (const [coll, entity] of fixtureEntities(f, env as Record<string, unknown>)) {
      checked++;
      // ревью 256 №6: у щитков ключ записи = id (SHIELDS.restore перекладывает по id)
      const key = coll === "shields" ? String((entity as { id?: unknown }).id ?? "e0") : "e0";
      assert.doesNotThrow(
        () => parseModelImport({ ...baseModel(), [coll]: { [key]: entity } }),
        `${f}: эталон коллекции ${coll} должен проходить импорт`,
      );
    }
  }
  // ревью 170: 84 эталонов сущностей, из них 3 отклонялись (ригели у стены/
  // колонны, ограждение террасы) — сейчас проходят все
  assert.ok(checked >= 80, `проверено эталонов сущностей ${checked}, ожидалось >= 80`);
});

test("b5/171: у каждой коллекции реестра есть позитивный эталон", () => {
  const covered = allFixtureEntities();
  const missing = MODEL_ENTITY_COLLECTIONS.filter((c) => !covered.has(c));
  assert.deepEqual(
    missing,
    [],
    `нет позитивного эталона для коллекций: ${missing.join(", ")} — добавьте фикстуру (тест красный, пока эталона нет)`,
  );
});

test("b5/171: негативный контроль — связь конца стены с обязательным ct/z0 и ригель с RigelLink разведены", () => {
  // WallLink стены требует ct/z0 (эталон ui-ref-balcony.json), RigelLink ригеля —
  // нет (эталон ui-ref-rigel-wall.json); перепутанные схемы дают ложный отказ
  assert.doesNotThrow(() =>
    parseModelImport({
      ...baseModel(),
      walls: {
        w1: wall({ p1: { x: 0, y: 0, link: { ot: "wall", ct: "edge", id: "w2", z0: "l", z1: "c", pos: "in" } } }),
      },
      rigels: { r1: { id: "r1", p1: { x: 10, y: 10, link: { ot: "pillar", id: "p1", z1: "t" } }, p2: { x: 100, y: 10, link: 0 }, depth: 30, height: 30 } },
    }),
  );
  // связь стены без ct/z0 отклоняется
  assertRejected(
    { ...baseModel(), walls: { w1: wall({ p1: { x: 0, y: 0, link: { ot: "wall", id: "w2", z1: "c" } } }) } },
    /model\.walls\.w1\.p1\.link/,
    "WallLink без ct/z0",
  );
  // стена terrace_fence без height проходит (ревью 170 №2)
  assert.doesNotThrow(() =>
    parseModelImport({ ...baseModel(), walls: { w1: { id: "w1", plan: "a", role: "terrace_fence", depth: 5, p1: { x: 0, y: 0 }, p2: { x: 0, y: 200 } } } }),
  );
});

// ---------- инструментальный уровень: import → workspace ----------

test("b5: project_import_plan принимает валидный .plan (офлайн)", async () => {
  // 213 plans-root: путь импорта — относительно корня plans
  const rel = join("b5b6", "ok.plan");
  const p = join(PLANS_DIR, rel);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ model: { ...baseModel(), walls: { w1: wall() } } }));
    const client = await start();
    try {
      const res = await client.callTool({ name: "project_import_plan", arguments: { path: rel, replace: true } });
      assert.ok(!res.isError, text(res));
      const payload = JSON.parse(text(res)) as { walls: number };
      assert.equal(payload.walls, 1);
    } finally {
      await client.close();
    }
  } finally {
    rmSync(join(PLANS_DIR, "b5b6"), { recursive: true, force: true });
  }
});

test("b5: project_import_plan с walls-строкой — INVALID_ARGUMENT, путь без содержимого файла", async () => {
  const rel = join("b5b6", "bad.plan");
  const p = join(PLANS_DIR, rel);
  try {
    mkdirSync(dirname(p), { recursive: true });
    const marker = "SECRET_CANARY_4242_file_body_marker_xxxxxxxxxxxxxxxxxx";
    writeFileSync(p, JSON.stringify({ model: { ...baseModel(), walls: "bad", marker } }));
    const client = await start();
    try {
      const res = await client.callTool({ name: "project_import_plan", arguments: { path: rel, replace: true } });
      assert.ok(res.isError, "импорт должен отклоняться");
      const payload = JSON.parse(text(res)) as { code: string; message: string };
      assert.equal(payload.code, "INVALID_ARGUMENT");
      assert.match(payload.message, /model\.walls/);
      assert.ok(!payload.message.includes(marker), "содержимое файла не выходит наружу");
    } finally {
      await client.close();
    }
  } finally {
    rmSync(join(PLANS_DIR, "b5b6"), { recursive: true, force: true });
  }
});

// ---------- round-trip через MCP-клиент (ревью 170 №1, №2) ----------

// Ревью 170 №1: ригель, прилипший к стене, — основной сценарий; до фикса
// import отклонял собственный экспорт MCP на rigels.<id>.p1.link.
test("b5/171: round-trip ригеля у стены: rigel_add → export → import (офлайн)", async () => {
  // 213 plans-root: путь export/import — относительно корня plans
  const rel = join("b5b6", "rigel.plan");
  const p = join(PLANS_DIR, rel);
  try {
    const ctx = new ServerContext({ offlineFixture: join(ROOT, "tests/fixtures/editor-corridor-3rooms.json") });
    const server = buildServer(ctx);
    const client = new Client({ name: "b5b6-rigel-rt", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      // конец оси на грани стены (w4/w6, y=-290): связь RigelLink {ot: wall}
      const add = await client.callTool({ name: "rigel_add", arguments: { start: { x: 100, y: -2000 }, end: { x: 2900, y: -2000 } } });
      assert.ok(!add.isError, text(add));
      const exp = await client.callTool({ name: "project_export_plan", arguments: { path: rel, scope: "full" } });
      assert.ok(!exp.isError, text(exp));
      const exported = JSON.parse(readFileSync(p, "utf8")) as { model: Record<string, Record<string, { p1?: { link?: { ot?: string } } }>> };
      const rigel = Object.values(exported.model.rigels ?? {})[0];
      assert.ok(rigel, "в экспорте нет ригеля");
      assert.equal(rigel.p1?.link?.ot, "wall", "конец ригеля должен быть привязан к стене (иначе тест не проверяет RigelLink)");
      const imp = await client.callTool({ name: "project_import_plan", arguments: { path: rel, replace: true } });
      assert.ok(!imp.isError, text(imp));
    } finally {
      await client.close();
    }
  } finally {
    rmSync(join(PLANS_DIR, "b5b6"), { recursive: true, force: true });
  }
});

// Ревью 170 №2: ограждение террасы из редактора — стена role terrace_fence
// без height (эталон ui-ref-terrace-fence.json); round-trip MCP не должен
// отклонять собственный экспорт.
test("b5/171: round-trip ограждения террасы: terrace_add → terrace_fence_add → export → import (офлайн)", async () => {
  // 213 plans-root: путь export/import — относительно корня plans
  const rel = join("b5b6", "fence.plan");
  const p = join(PLANS_DIR, rel);
  try {
    const client = await start();
    try {
      const terrace = await client.callTool({ name: "terrace_add", arguments: { points: [{ x: 500, y: 500 }, { x: 3500, y: 500 }, { x: 3500, y: 2500 }, { x: 500, y: 2500 }] } });
      assert.ok(!terrace.isError, text(terrace));
      const fence = await client.callTool({ name: "terrace_fence_add", arguments: { start: { x: 600, y: 600 }, end: { x: 3400, y: 600 } } });
      assert.ok(!fence.isError, text(fence));
      const exp = await client.callTool({ name: "project_export_plan", arguments: { path: rel, scope: "full" } });
      assert.ok(!exp.isError, text(exp));
      const exported = JSON.parse(readFileSync(p, "utf8")) as { model: Record<string, Record<string, { role?: string; height?: number }>> };
      const fenceWall = Object.values(exported.model.walls ?? {}).find((w) => w.role === "terrace_fence");
      assert.ok(fenceWall, "в экспорте нет ограждения террасы");
      const imp = await client.callTool({ name: "project_import_plan", arguments: { path: rel, replace: true } });
      assert.ok(!imp.isError, text(imp));
      // и стена без height (формат живого редактора) тоже проходит
      delete fenceWall.height;
      assert.doesNotThrow(() => parseModelImport(exported.model), "ограждение без height должно проходить импорт");
    } finally {
      await client.close();
    }
  } finally {
    rmSync(join(PLANS_DIR, "b5b6"), { recursive: true, force: true });
  }
});
