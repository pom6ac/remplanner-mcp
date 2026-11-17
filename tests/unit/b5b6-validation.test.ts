// B5+B6 (аудит 65, этап 169): структурная валидация импорта (.plan) и лимиты
// входа инструментов. Негативные тесты на каждое правило, позитивные — все
// текущие фикстуры-эталоны проходят импорт. Офлайн: сеть не используется.
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { readPlanFile } from "../../src/server/tools-projects.ts";
import { parseModelImport } from "../../src/model/import-schema.ts";
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

// ---------- инструментальный уровень: import → workspace ----------

test("b5: project_import_plan принимает валидный .plan (офлайн)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "b5b6-"));
  try {
    const p = join(dir, "ok.plan");
    writeFileSync(p, JSON.stringify({ model: { ...baseModel(), walls: { w1: wall() } } }));
    const client = await start();
    try {
      const res = await client.callTool({ name: "project_import_plan", arguments: { path: p, replace: true } });
      assert.ok(!res.isError, text(res));
      const payload = JSON.parse(text(res)) as { walls: number };
      assert.equal(payload.walls, 1);
    } finally {
      await client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("b5: project_import_plan с walls-строкой — INVALID_ARGUMENT, путь без содержимого файла", async () => {
  const dir = mkdtempSync(join(tmpdir(), "b5b6-"));
  try {
    const marker = "SECRET_CANARY_4242_file_body_marker_xxxxxxxxxxxxxxxxxx";
    const p = join(dir, "bad.plan");
    writeFileSync(p, JSON.stringify({ model: { ...baseModel(), walls: "bad", marker } }));
    const client = await start();
    try {
      const res = await client.callTool({ name: "project_import_plan", arguments: { path: p, replace: true } });
      assert.ok(res.isError, "импорт должен отклоняться");
      const payload = JSON.parse(text(res)) as { code: string; message: string };
      assert.equal(payload.code, "INVALID_ARGUMENT");
      assert.match(payload.message, /model\.walls/);
      assert.ok(!payload.message.includes(marker), "содержимое файла не выходит наружу");
    } finally {
      await client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
