// T20: живая интеграция (design §10) — ТОЛЬКО при REMPLANNER_LIVE=1, только анонимный проект.
// Сценарий: создать → комната 4000×3000 → дверь + окно → диван → model_validate →
// render_plan → save → повторное чтение в чистом контексте → сверка. Скриншоты screenshots/live-*.png.
// Аккаунт не затрагивается (без входа; его save_id не проверяется, т.к. не используется).
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnonProject, loadModel } from "../../src/api.ts";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import type { SessionState } from "../../src/session.ts";

test.after(() => closeBrowser().catch(() => {}));

const ROOT = join(import.meta.dirname, "..", "..");
const LIVE = process.env["REMPLANNER_LIVE"] === "1";

const t = LIVE ? test : test.skip;

// T29: сценарий T24 «коридор + 3 комнаты» через MCP-инструменты (REMPLANNER_LIVE=1, анонимно):
// room_add_rect ×4 → save → reload → rooms_list с площадями T24 (7,84 / 5,80 / 5,04 / 2,24 м²).
t("live: коридор + 3 комнаты через MCP → save → reload → rooms_list (площади T24)", { timeout: 600_000 }, async () => {
  // свежая анонимная cookie-сессия на прогон (не state.json аккаунта, не state.anon.json)
  const session: SessionState = { cookies: [] };
  const ctx = new ServerContext({
    deps: {
      session,
      loadModel: (s, o, p) => loadModel(s, o, p),
      openEditor: (s, o, p, options) => openEditor(s, o, p, undefined, { ...options, anonymous: true }),
    },
  });
  const client = new Client({ name: "live-corridor", version: "0.0.0" });
  const server = buildServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  const text = (r: unknown): string => {
    const contents = (r as { content: { type: string; text?: string }[] }).content ?? [];
    const first = contents.find((c) => c.type === "text");
    return first?.text ?? JSON.stringify(contents);
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    assert.ok(!(res as { isError?: boolean }).isError, `${name}: ${text(res)}`);
    return JSON.parse(text(res));
  };

  // 1. анонимный проект: создаём свежей cookie-сессией (не state.json аккаунта)
  const created = await createAnonProject(session);
  assert.notEqual(created.object_id, "");
  // anon: true — редактор для этого проекта открывается без аккаунтных cookies
  await ctx.open(created.object_id, created.plan_id || "1", { anon: true, session });

  // 2. коридор + три комнаты (оси как в T24: 0..600 × −300..120 см)
  await call("room_add_rect", { origin: { x: 100, y: 100 }, width: 5800, depth: 1000, wall_thickness: 200 });
  await call("room_add_rect", { origin: { x: 100, y: -2900 }, width: 2800, depth: 2800, wall_thickness: 200 });
  await call("room_add_rect", { origin: { x: 3100, y: -2900 }, width: 1800, depth: 2800, wall_thickness: 200 });
  await call("room_add_rect", { origin: { x: 5100, y: -2900 }, width: 800, depth: 2800, wall_thickness: 200 });

  const model = await call("model_get", {}) as { walls: unknown[]; rooms: { area_m2: number }[] };
  assert.equal(model.walls.length, 7, `7 стен после мутаций (получено ${model.walls.length})`);
  const areasLocal = model.rooms.map((r) => r.area_m2).sort((x, y) => y - x);
  assert.deepEqual(areasLocal.map((x) => Math.round(x * 100) / 100), [7.84, 5.8, 5.04, 2.24], "площади комнат после нормализации (T24)");

  // 3. валидация и сохранение (workspace: бэкап → normalize → save → верификация по GET)
  const validation = await call("model_validate", {}) as { ok: boolean; problems: { code: string; message: string }[] };
  assert.ok(validation.ok, `валидатор: ${JSON.stringify(validation.problems)}`);
  const saved = await call("project_save", {}) as { save_id: string; verified: boolean };
  assert.ok(saved.save_id, "save_id получен");
  assert.ok(saved.verified, "модель на сервере сверена по GET");

  // 4. перезагрузка: GET той же сессией → rooms2 редактора с площадями T24
  const actualObject = ctx.workspace().project!.objectId;
  const actualPlan = ctx.workspace().project!.planId;
  const reloaded = await loadModel(session, actualObject, actualPlan);
  const walls2 = reloaded.model["walls"] as Record<string, unknown>;
  const rooms2 = reloaded.model["rooms2"] as Record<string, { area?: number }>;
  const areas2 = Object.values(rooms2).map((r) => r.area ?? 0).sort((x, y) => y - x);
  assert.ok(areas2.length === 4 && areas2.every((x, i) => Math.abs(x - [7.84, 5.8, 5.04, 2.24][i]!) <= 0.01),
    `rooms2 после перезагрузки: ${JSON.stringify(areas2)}`);

  await client.close();
});

t("live: две комнаты, дверь, окно, диван → validate → render → save → reload → сверка", { timeout: 600_000 }, async () => {
  // свежая анонимная cookie-сессия на прогон (не state.json аккаунта, не state.anon.json)
  const session: SessionState = { cookies: [] };
  const ctx = new ServerContext({
    deps: {
      session,
      loadModel: (s, o, p) => loadModel(s, o, p),
      openEditor: (s, o, p, options) => openEditor(s, o, p, undefined, { ...options, anonymous: true }),
    },
  });
  const client = new Client({ name: "live", version: "0.0.0" });
  const server = buildServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  const text = (r: unknown): string => {
    const contents = (r as { content: { type: string; text?: string }[] }).content ?? [];
    const first = contents.find((c) => c.type === "text");
    return first?.text ?? JSON.stringify(contents);
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    assert.ok(!(res as { isError?: boolean }).isError, `${name}: ${text(res)}`);
    return JSON.parse(text(res));
  };

  // 1. анонимный проект
  const created = await createAnonProject(session);
  assert.notEqual(created.object_id, "");
  // anon: true — редактор для этого проекта открывается без аккаунтных cookies
  await ctx.open(created.object_id, created.plan_id || "1", { anon: true, session });

  // 2. две смежные комнаты (общая стена — edge-link топология, как в живом круге ревью)
  await call("room_add_rect", { origin: { x: 0, y: 0 }, width: 4000, depth: 3000, wall_thickness: 200 });
  const after1 = await call("model_get", {}) as { walls: { id: string; from: [number, number]; to: [number, number] }[] };
  assert.equal(after1.walls.length, 4, "первая комната: 4 стены");
  // вторая комната 2000×3000 справа вплотную: внутренняя левая грань на оси общей стены (x=4200)
  await call("room_add_rect", { origin: { x: 4200, y: 0 }, width: 2000, depth: 3000, wall_thickness: 200 });
  const after2 = await call("model_get", {}) as { walls: typeof after1.walls; rooms: { area_m2: number }[] };
  // §12.3: коллинеарные стены, ставшие общими, сливаются (как Wall.merge редактора):
  // 4 + правая стена второй комнаты, верх и низ продлены и слиты
  assert.equal(after2.walls.length, 5, `после слияния коллинеарных стен — 5 (получено ${after2.walls.length})`);
  assert.equal(after2.rooms.length, 2, "обе комнаты найдены");
  const sorted = after2.rooms.map((r) => r.area_m2).sort((x, y) => y - x);
  assert.ok(Math.abs(sorted[0]! - 12) < 0.2, `комната 1 ≈ 12 м² (${sorted[0]})`);
  assert.ok(Math.abs(sorted[1]! - 6) < 0.2, `комната 2 ≈ 6 м² (${sorted[1]})`);

  // 3. дверь в нижней стене первой комнаты, окно в верхней (как в живом круге ревью)
  const horizontals = after1.walls.filter((w) => w.from[1] === w.to[1]);
  const topWall = horizontals.reduce((a, b) => (b.from[1] < a.from[1] ? b : a));
  const bottomWall = horizontals.reduce((a, b) => (b.from[1] > a.from[1] ? b : a));
  await call("opening_add", { wall_id: bottomWall.id, type: "door", offset_mm: 500, width_mm: 800, height_mm: 2000 });
  await call("opening_add", { wall_id: topWall.id, type: "window", offset_mm: 1500, width_mm: 1200, height_mm: 1500, sill_height_mm: 800 });

  // 4. диван из каталога у стены (каталог — из кэша или бандла редактора)
  const found = await call("catalog_search", { query: "диван", limit: 1 }) as { name: string }[];
  assert.ok(found.length > 0, "каталог: найден диван");
  const sofa = await call("item_add", {
    name: found[0]!.name,
    position: { in_room: { room_id: "R1", corner: "center" } },
  }) as { entity: { name: string } | null };
  assert.ok(sofa.entity, "диван добавлен");

  // 5. инварианты
  const validation = await call("model_validate", {}) as { ok: boolean; problems: { code: string; message: string }[] };
  assert.ok(validation.ok, `валидатор: ${JSON.stringify(validation.problems)}`);

  // 6. рендер (запускает headless-браузер) + скриншоты
  mkdirSync(join(ROOT, "screenshots"), { recursive: true });
  const rendered = await call("render_plan", { sheet: "init", width_px: 1600 }) as { path: string; bytes: number };
  assert.ok(rendered.bytes > 10_000, `PNG рендера ${rendered.bytes} байт`);
  copyFileSync(rendered.path, join(ROOT, "screenshots", "live-render-init.png"));
  // скриншот всей страницы редактора
  const editor = ctx.workspace().editor as unknown as { page: { screenshot(o: object): Promise<unknown> } };
  await editor.page.screenshot({ path: join(ROOT, "screenshots", "live-editor-final.png") });

  // 7. сохранение (workspace: бэкап → normalize → save → верификация по GET)
  const saved = await call("project_save", {}) as { save_id: string; verified: boolean; backup_path: string };
  assert.ok(saved.save_id, "save_id получен");
  assert.ok(saved.verified, "модель на сервере сверена по GET");

  // 8. повторное чтение в «чистом контексте»: HTTP GET той же сессией;
  // plan_id — фактический план редактора (workspace принимает его после открытия)
  const actualPlan = ctx.workspace().project!.planId;
  const actualObject = ctx.workspace().project!.objectId;
  const reloaded = await loadModel(session, actualObject, actualPlan);
  const walls2 = reloaded.model["walls"] as Record<string, { holes: Record<string, unknown> }>;
  // редактор при сохранении может перекроить слитые коллинеарные стены — сверяем,
  // что каждая ось рабочей копии покрыта объединением осей GET-модели
  const axesOf = (ws2: Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>) =>
    Object.values(ws2).map((w) => [w.p1.x, w.p1.y, w.p2.x, w.p2.y] as const);
  const reloadedAxes = axesOf(walls2 as never);
  const axisCovered = (a: readonly number[]): boolean =>
    reloadedAxes.some((b) => {
      const [x1, y1, x2, y2] = a;
      const len = Math.hypot(x2! - x1!, y2! - y1!) || 1;
      const ux = (x2! - x1!) / len, uy = (y2! - y1!) / len;
      const cross = (b[1]! - y1!) * ux - (b[0]! - x1!) * uy;
      if (Math.abs(cross) > 0.05) return false;
      const s1 = (b[0]! - x1!) * ux + (b[1]! - y1!) * uy;
      const s2 = (b[2]! - x1!) * ux + (b[3]! - y1!) * uy;
      return Math.min(s1, s2) <= 0.05 && Math.max(s1, s2) >= len - 0.05;
    });
  for (const w of after2.walls) {
    assert.ok(axisCovered([w.from[0]! / 10, w.from[1]! / 10, w.to[0]! / 10, w.to[1]! / 10]),
      `ось стены пережила save → GET: ${JSON.stringify(w.from)}-${JSON.stringify(w.to)}`);
  }
  const holes = Object.values(walls2).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0);
  assert.equal(holes, 2, "дверь и окно пережили save → GET");
  const items = reloaded.model["items"] as Record<string, { name?: string }>;
  assert.equal(Object.keys(items).length, 1, "диван пережил save → GET");
  const rooms2 = reloaded.model["rooms2"] as Record<string, unknown>;
  assert.equal(Object.keys(rooms2).length, 2, "обе комнаты найдены редактором после перезагрузки");

  // 9. undo после сохранения — история пуста (сброшена), project_open перечитает сервер
  const hist = await call("undo", {}) as { applied: number };
  assert.equal(hist.applied, 0, "история сброшена после сохранения");

  await client.close();
});
