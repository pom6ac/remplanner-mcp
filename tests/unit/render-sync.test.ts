// Дефект 1 (отчёт 11-user-trial-1): render_plan синхронизирует каноническую модель
// со редактором перед скриншотом и возвращает ревизию (хэш + счётчики объектов);
// расхождение счётчиков редактора с моделью workspace → RENDER_OUT_OF_SYNC.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import type { Model, FixtureEnvelope, ItemProps } from "../../src/model/types.ts";
import { addItem } from "../../src/model/items.ts";
import { McpError } from "../../src/errors.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function fixtureModel(): Model {
  const env = JSON.parse(
    readFileSync(join(ROOT, "tests/fixtures/anon-rect-4000x3000.json"), "utf8"),
  ) as FixtureEnvelope;
  return structuredClone(env.model);
}

type Counts = { walls: number; holes: number; items: number };

function countsOf(model: Model | Record<string, unknown>): Counts {
  const walls = ((model as Model).walls ?? {}) as Record<string, { holes?: Record<string, unknown> }>;
  return {
    walls: Object.keys(walls).length,
    holes: Object.values(walls).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0),
    items: Object.keys(((model as Model).items ?? {}) as Record<string, unknown>).length,
  };
}

type EditorMockOpts = {
  /** Счётчики «после», которые редактор показывает (по умолчанию — как во входной модели). */
  after?: Partial<Counts>;
  /** Перехват опций renderPng (ревью v0.1.1 №3: itemIds листа). */
  captureRenderOptions?: (o: unknown) => void;
};

function mockDeps(server: { saveId: string; model: Model }, editorOpts: EditorMockOpts = {}) {
  const calls: { normalizeModels: Record<string, unknown>[]; renderCalls: number } = {
    normalizeModels: [],
    renderCalls: 0,
  };
  const editor: EditorLike = {
    objectId: "123", planId: "1",
    async normalize(model) {
      calls.normalizeModels.push(structuredClone(model) as Record<string, unknown>);
      const c = countsOf(model as Model);
      const after = { walls: c.walls, holes: c.holes, items: c.items, ...editorOpts.after };
      return {
        model: structuredClone(model) as unknown as Record<string, unknown>,
        rooms: [],
        before: { walls: c.walls, holes: c.holes, items: c.items },
        after,
      };
    },
    async save() { return { ok: true, saveId: server.saveId, conflict: false }; },
    async renderPng(options) { calls.renderCalls++; editorOpts.captureRenderOptions?.(options); return PNG; },
    async compatInfo() { throw new Error("not used"); },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(_s, _oid, _pid): Promise<LoadedModel> {
      return { object_id: "123", plan_id: "1", save_id: server.saveId, units: "cm", model: structuredClone(server.model) as unknown as Record<string, unknown> };
    },
    async openEditor() { return editor; },
  };
  return { deps, calls };
}

test("render-sync: render_plan проталкивает всю каноническую модель (стены, проёмы, предметы) в редактор перед скриншотом", async () => {
  const model = fixtureModel();
  // предмет поверх фикстуры (в ней уже окно и дверь)
  addItem(model, { name: "sofa_triple", position: { center: { x: 2000, y: 1500 } }, widthMm: 2000, depthMm: 800, heightMm: 850 });
  const server = { saveId: "s1", model };
  const { deps, calls } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const dir = mkdtempSync(join(tmpdir(), "remplanner-render-sync-"));
  try {
    const res = await ws.renderPlan({ sheet: "init", dir });
    assert.equal(calls.normalizeModels.length, 1, "нормализация (restore→draw→copy) вызвана перед скриншотом");
    const pushed = countsOf(calls.normalizeModels[0] as Model);
    assert.equal(pushed.walls, 4, "стены переданы в редактор");
    assert.equal(pushed.holes, 2, "проёмы переданы в редактор");
    assert.equal(pushed.items, 1, "предметы переданы в редактор");
    assert.ok(existsSync(res.path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render-sync: редактор показывает не все объекты → RENDER_OUT_OF_SYNC, PNG не отдаётся", async () => {
  const model = fixtureModel();
  addItem(model, { name: "sofa_triple", position: { center: { x: 2000, y: 1500 } }, widthMm: 2000, depthMm: 800, heightMm: 850 });
  const server = { saveId: "s1", model };
  const { deps, calls } = mockDeps(server, { after: { items: 0 } });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const dir = mkdtempSync(join(tmpdir(), "remplanner-render-sync-"));
  try {
    await assert.rejects(
      ws.renderPlan({ sheet: "init", dir }),
      (e: unknown) => {
        assert.ok(e instanceof McpError);
        assert.equal(e.code, "RENDER_OUT_OF_SYNC");
        return true;
      },
    );
    assert.equal(calls.renderCalls, 0, "скриншот при расхождении не делается");
    assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], [], "PNG при ошибке не пишется");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render-sync: renderPng получает только предметы запрошенного листа (ревью v0.1.1 №3)", async () => {
  const model = fixtureModel();
  const item = addItem(model, { name: "sofa_triple", position: { center: { x: 2000, y: 1500 } }, widthMm: 2000, depthMm: 800, heightMm: 850 });
  assert.equal(Object.keys(item.plan ?? {})[0], "furniture", "предмет фикстуры — мебель");
  const server = { saveId: "s1", model };
  const seen: unknown[] = [];
  const { deps } = mockDeps(server, { captureRenderOptions: (o) => seen.push(o) });
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const dir = mkdtempSync(join(tmpdir(), "remplanner-render-sync-"));
  try {
    await ws.renderPlan({ sheet: "furniture", dir });
    assert.deepEqual((seen[0] as { itemIds?: string[] }).itemIds, [item.id], "на furniture — диван в itemIds");
    await ws.renderPlan({ sheet: "init", dir });
    assert.deepEqual((seen[1] as { itemIds?: string[] }).itemIds, [], "на init слой мебели скрыт — ожидание не запускается");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render-sync: ответ render_plan содержит ревизию — хэш модели и счётчики редактора", async () => {
  const model = fixtureModel();
  const item: ItemProps = addItem(model, { name: "sofa_triple", position: { center: { x: 2000, y: 1500 } }, widthMm: 2000, depthMm: 800, heightMm: 850 });
  void item;
  const server = { saveId: "s1", model };
  const { deps } = mockDeps(server);
  const ws = new Workspace(deps);
  await ws.open("123", "1");
  const dir = mkdtempSync(join(tmpdir(), "remplanner-render-sync-"));
  try {
    const res = await ws.renderPlan({ sheet: "init", dir });
    assert.ok(res.revision, "ревизия в ответе");
    const expectedHash = createHash("sha256").update(JSON.stringify(ws.model)).digest("hex").slice(0, 16);
    assert.equal(res.revision!.model_hash, expectedHash);
    assert.equal(res.revision!.save_id, "s1");
    assert.equal(res.revision!.walls, 4);
    assert.equal(res.revision!.openings, 2);
    assert.equal(res.revision!.items, 1);
    assert.deepEqual(res.revision!.editor, { walls: 4, openings: 2, items: 1, pillars: 0, rigels: 0, gas_lines: 0, pipes: 0, terrace_borders: 0, territory_borders: 0, level_holes: 0, led_strips: 0, stripes_light: 0, line_strips: 0, cables: 0, cables_socket: 0, cables_warm_floor: 0, cables_conditioner: 0, rulers: 0, comments: 0, shields: 0, warm_floors: 0, zone_delimiters: 0, pipes_warm_floor: 0, pipes_conditioner: 0, pipes_heat: 0, pipes_ventilation: 0 }, "счётчики, которые видит редактор");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
