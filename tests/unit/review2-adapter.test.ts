// Раунд 2: адаптер редактора — R2-8 (listener до триггера, чужой ранний/наш поздний
// ответ, статусы), R2-9 (reload:101 → SESSION_EXPIRED), R2-11 (закрытие контекста
// при отказе newPage), R2-16 (молчаливое удаление элементов → NORMALIZATION_DROPPED).
import test from "node:test";
import assert from "node:assert/strict";
import { buildHandle, openEditorInContext, type EditorHandle } from "../../src/editor/adapter.ts";
import type { Model } from "../../src/model/types.ts";

type Scheduled = { atMs: number; status: number; body: string; forced?: boolean };

const saveUrl = (forced: boolean): string =>
  `https://remplanner.ru/setup/api/planner/save/?object_id=1&save_id=s1&is_forced=${forced ? 1 : 0}`;

/** Mock Page: ответы /save/ по расписанию; evaluate для savePlan/clearFog/restoreDrawCopy. */
function mockPage(opts: {
  schedule?: Scheduled[];
  /** Ответы на КАЖДЫЙ вызов project.save (от момента вызова) — для тестов лимитера. */
  perSave?: Omit<Scheduled, "atMs">[];
  normalizeResult?: () => { copy: Record<string, unknown>; rooms: never[]; before: { walls: number; holes: number; items: number }; after: { walls: number; holes: number; items: number } };
}) {
  const t0 = Date.now();
  const waiters: Array<(r: unknown) => void> = [];
  const listeners: Array<(r: unknown) => void> = [];
  const timers: NodeJS.Timeout[] = [];
  const deliver = (s: Scheduled): void => {
    const res = { url: () => saveUrl(s.forced ?? false), status: () => s.status, text: async () => s.body, request: () => null };
    waiters.splice(0).forEach((w) => w(res));
    [...listeners].forEach((l) => l(res));
  };
  const timers2 = { list: timers };
  const fired = (opts.schedule ?? []).map(() => false);
  const tick = setInterval(() => {
    (opts.schedule ?? []).forEach((s, i) => {
      if (!fired[i]! && Date.now() - t0 >= s.atMs) {
        fired[i] = true;
        deliver(s);
      }
    });
  }, 40);
  let arg: unknown;
  const page = {
    on(ev: string, l: (r: unknown) => void) { if (ev === "response") listeners.push(l); },
    off(ev: string, l: (r: unknown) => void) { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); },
    async waitForResponse(_pred: unknown) {
      return new Promise((resolve) => waiters.push(resolve));
    },
    async waitForTimeout(ms: number) { await new Promise((r) => setTimeout(r, ms)); },
    async evaluate(fn: string | ((a: unknown) => unknown), a?: unknown): Promise<unknown> {
      if (typeof fn === "function") { arg = a; return {}; } // установка window.__remplanner_arg
      const src = String(fn);
      if (src.includes("planner_ui_message_fog")) return true;
      if (src.includes("project.save")) {
        (opts.perSave ?? []).forEach((s) => {
          timers2.list.push(setTimeout(() => deliver({ ...s, atMs: 0 }), s.status >= 0 ? 100 : 100));
        });
        return { started: true };
      }
      if (src.includes("$Project.restore")) {
        const res = opts.normalizeResult?.() ?? { copy: {}, rooms: [], before: { walls: 0, holes: 0, items: 0 }, after: { walls: 0, holes: 0, items: 0 } };
        return res;
      }
      return {};
    },
  };
  return { page, stop: () => { clearInterval(tick); timers2.list.forEach(clearTimeout); }, getArg: () => arg };
}

function inputModel(walls = 2, holes = 0, items = 1): Model {
  const m = { v: 3, id: "x", plan_id: "1", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: false } as unknown as Model;
  for (let i = 0; i < walls; i++) {
    m.walls[`w${i}`] = { id: `w${i}`, plan: "a", role: "wall", depth: 20, height: 270,
      p1: { x: 0, y: i * 100 }, p2: { x: 100, y: i * 100 },
      holes: i === 0 && holes > 0 ? Object.fromEntries(Array.from({ length: holes }, (_, h) => [`h${h}`, { id: `h${h}` }])) : {},
    } as never;
  }
  for (let i = 0; i < items; i++) m.items[`i${i}`] = { id: `i${i}`, name: "x", pc: { x: 1, y: 1 }, angle: 0, width: 10, height: 10, plan: {} } as never;
  return m;
}

const COMPAT = { global_version: "1", planner_version: "3", bundles: [], object_id: "123", plan_id: "1",
  present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

test("R2-8: чужой ранний автосейв не глотает наш поздний ответ — итог по последнему ответу", { timeout: 60_000 }, async () => {
  const { page, stop } = mockPage({
    schedule: [
      { atMs: 200, status: 200, body: JSON.stringify({ result: "success", save_id: "foreign-autosave" }), forced: false },
      { atMs: 2300, status: 200, body: JSON.stringify({ result: "success", save_id: "our-save" }), forced: true },
    ],
  });
  const handle = buildHandle(page as never, { close: async () => {} }, "123", "1", COMPAT, { acquire: async () => {} });
  try {
    const res = await handle.save(6000);
    assert.equal(res.ok, true);
    assert.equal(res.saveId, "our-save", "итог — наш поздний ответ, а не ранний чужой автосейв");
  } finally {
    stop();
  }
});

test("R2-8: ответ 5xx на сохранение → SITE_ERROR (статус проверяется, тело вторично)", { timeout: 60_000 }, async () => {
  const { page, stop } = mockPage({
    schedule: [{ atMs: 100, status: 500, body: "Internal Server Error" }],
  });
  const handle = buildHandle(page as never, { close: async () => {} }, "123", "1", COMPAT, { acquire: async () => {} });
  try {
    await assert.rejects(handle.save(2000), (e: unknown) => {
      assert.equal((e as { code?: string }).code, "SITE_ERROR");
      return true;
    });
  } finally {
    stop();
  }
});

test("R2-9/№13: browser save с ответом {reload:101} → SESSION_EXPIRED (не ok:false)", { timeout: 60_000 }, async () => {
  const { page, stop } = mockPage({
    schedule: [{ atMs: 100, status: 200, body: JSON.stringify({ reload: 101 }) }],
  });
  const handle = buildHandle(page as never, { close: async () => {} }, "123", "1", COMPAT, { acquire: async () => {} });
  try {
    await assert.rejects(handle.save(2000), (e: unknown) => {
      assert.equal((e as { code?: string }).code, "SESSION_EXPIRED");
      return true;
    });
  } finally {
    stop();
  }
});

test("R2-16: редактор молча удалил предмет → NORMALIZATION_DROPPED с деталями", { timeout: 60_000 }, async () => {
  const model = inputModel(2, 0, 1);
  const { page, stop, getArg } = mockPage({
    normalizeResult: () => {
      const arg = getArg() as { model: Model } | undefined;
      const inWalls = Object.keys(arg?.model.walls ?? {}).length;
      return {
        copy: { walls: arg?.model.walls ?? {} },
        rooms: [],
        before: { walls: inWalls, holes: 0, items: 1 },
        after: { walls: inWalls, holes: 0, items: 0 }, // предмет пропал
      };
    },
  });
  const handle = buildHandle(page as never, { close: async () => {} }, "123", "1", COMPAT, { acquire: async () => {} });
  try {
    await assert.rejects(handle.normalize(model as unknown as Record<string, unknown>), (e: unknown) => {
      assert.equal((e as { code?: string }).code, "NORMALIZATION_DROPPED");
      assert.match((e as Error).message, /items/);
      return true;
    });
  } finally {
    stop();
  }
});

test("R2-16: стены редактор может ДОБАВИТЬ (нормализация) — это не ошибка; потерю стен ловим", { timeout: 60_000 }, async () => {
  const model = inputModel(2, 0, 0);
  const { page, stop, getArg } = mockPage({
    normalizeResult: () => {
      const inWalls = Object.keys((getArg() as { model: Model }).model.walls).length;
      return {
        copy: { walls: {} },
        rooms: [],
        before: { walls: inWalls, holes: 0, items: 0 },
        after: { walls: inWalls + 1, holes: 0, items: 0 }, // редактор разрезал/достроил стену
      };
    },
  });
  const handle = buildHandle(page as never, { close: async () => {} }, "123", "1", COMPAT, { acquire: async () => {} });
  try {
    const res = await handle.normalize(model as unknown as Record<string, unknown>);
    assert.equal(res.after.walls, 3, "рост числа стен допустим");
  } finally {
    stop();
  }
});

test("R2-11: отказ newPage закрывает контекст", { timeout: 30_000 }, async () => {
  let closed = 0;
  const context = {
    newPage: async () => { throw new Error("newPage failed"); },
    close: async () => { closed++; },
  };
  await assert.rejects(
    openEditorInContext({ cookies: [] } as never, "123", "1", context as never),
    /newPage failed/,
  );
  assert.equal(closed, 1, "контекст закрыт при отказе newPage");
});

test("R2-10: два сохранения подряд через адаптер разнесены минимум на SAVE_INTERVAL_MS", { timeout: 60_000 }, async () => {
  const { page, stop } = mockPage({
    perSave: [{ status: 200, body: JSON.stringify({ result: "success", save_id: "s" }), forced: true }],
  });
  const handle = buildHandle(page as never, { close: async () => {} }, "123", "1", COMPAT, (await import("../../src/http.ts")).saveLimiter);
  try {
    const t0 = Date.now();
    await handle.save(6000);
    await handle.save(6000);
    const elapsed = Date.now() - t0;
    const { SAVE_INTERVAL_MS } = await import("../../src/config.ts");
    assert.ok(elapsed >= SAVE_INTERVAL_MS, `два сохранения за ${elapsed} мс — меньше квоты сайта ${SAVE_INTERVAL_MS} мс`);
  } finally {
    stop();
  }
});

test("R2-10: чтение и сохранение идут через ОБЩУЮ очередь — суммарно не быстрее MIN_REQUEST_INTERVAL_MS", { timeout: 60_000 }, async () => {
  const http = await import("../../src/http.ts");
  const { saveModel } = await import("../../src/api.ts");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ result: "success" }), { status: 200 })) as typeof fetch;
  try {
    const session = { cookies: [] };
    const t0 = Date.now();
    await Promise.all([
      http.httpRequestJson({ path: "/setup/api/planner/?object_id=1", session }),
      saveModel(session, { objectId: "1", planId: "1", authkey: "a", saveId: "s", model: {} }),
    ]);
    const elapsed = Date.now() - t0;
    const { MIN_REQUEST_INTERVAL_MS } = await import("../../src/config.ts");
    assert.ok(elapsed >= MIN_REQUEST_INTERVAL_MS, `чтение+сохранение параллельно за ${elapsed} мс — очереди независимы`);
  } finally {
    globalThis.fetch = original;
  }
});
