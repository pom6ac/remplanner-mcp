// Ревью v0.1.1 №3: ошибка ожидания предметов в SVG подавлялась (.catch(() => {})),
// после чего возвращался PNG без предметов. Проверка счётчиков в workspace идёт до
// скриншота и модель не видит. Теперь renderPlan проверяет реальные ВИДИМЫЕ DOM-
// элементы предметов на листе; при таймауте — RENDER_OUT_OF_SYNC без PNG.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPlan } from "../../src/editor/adapter.ts";
import { MAX_RENDER_MISSING_LISTED } from "../../src/limits.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

type MockOpts = {
  /** waitForFunction: resolve (предметы отрисованы) или reject (таймаут). */
  itemsAppear: boolean;
  /** Ответ диагностики страницы (этап 410); undefined — evaluate падает. */
  diag?: unknown;
};

/** Mock Page для renderPlan: evaluate по исходнику функции, waitForFunction управляется тестом. */
function mockPage(opts: MockOpts) {
  const calls: { sheetSwitch: string[]; screenshots: number; waitForArgs: unknown[]; diagArgs: unknown[] } = {
    sheetSwitch: [],
    screenshots: 0,
    waitForArgs: [],
    diagArgs: [],
  };
  const page = {
    async evaluate(fn: string | ((a?: unknown) => unknown), a?: unknown): Promise<unknown> {
      const src = String(fn);
      if (src.includes("itemsRenderDiagInPage")) {
        calls.diagArgs.push(a);
        if (opts.diag === undefined) throw new Error("page closed");
        return opts.diag;
      }
      if (src.includes("planner_ui_message_fog")) return true;
      if (src.includes("groups_navi_item")) {
        calls.sheetSwitch.push(String(a));
        return "click";
      }
      if (src.includes("getBoundingClientRect") && src.includes("canvas_v2_wrapper")) {
        return { selector: "#canvas_v2_wrapper svg", index: 0 };
      }
      return {}; // dimensions, focus
    },
    async waitForFunction(fn: unknown, arg: unknown, _o?: unknown): Promise<void> {
      calls.waitForArgs.push(arg);
      if (!opts.itemsAppear) throw new Error(`Timeout 30000ms exceeded: ${String(fn).slice(0, 40)}`);
    },
    async waitForTimeout(_ms: number) {},
    viewportSize() { return { width: 1600, height: 1000 }; },
    async setViewportSize(_vp: { width: number; height: number }) {},
    locator(_selector: string) {
      return {
        nth(_i: number) {
          return {
            async screenshot(): Promise<Buffer> {
              calls.screenshots++;
              return PNG;
            },
          };
        },
      };
    },
  };
  return { page: page as never, calls };
}

test("render-items: предметы не отрисованы (таймаут ожидания) → RENDER_OUT_OF_SYNC, PNG не снимается", async () => {
  const { page, calls } = mockPage({ itemsAppear: false });
  await assert.rejects(
    renderPlan(page, { sheet: "furniture", itemIds: ["sofa1"] }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal((e as { code?: string }).code, "RENDER_OUT_OF_SYNC");
      assert.match((e as Error).message, /sofa1/);
      return true;
    },
  );
  assert.equal(calls.screenshots, 0, "скриншот без предметов не делается");
});

test("render-items: предметы отрисованы → PNG возвращается, ids переданы в ожидание", async () => {
  const { page, calls } = mockPage({ itemsAppear: true });
  const buf = await renderPlan(page, { sheet: "furniture", itemIds: ["sofa1", "sofa2"] });
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual(calls.waitForArgs[0], ["sofa1", "sofa2"], "ids переданы в waitForFunction");
  assert.equal(calls.sheetSwitch[0], "furniture", "лист переключен до ожидания");
  assert.equal(calls.screenshots, 1);
});

test("render-items: без предметов ожидание не запускается", async () => {
  const { page, calls } = mockPage({ itemsAppear: false });
  const buf = await renderPlan(page, { sheet: "init" });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(calls.waitForArgs.length, 0, "waitForFunction не вызывался");
});

// Этап 410 (лог 406-1): RENDER_OUT_OF_SYNC перечислял ВСЕ ожидаемые id — по логу
// нельзя было понять, какой предмет не виден. Проверка не ослаблена (PNG нет),
// но ошибка называет только невидимые предметы с причиной и активный лист.
test("render-items (410): ошибка называет только невидимые предметы, причину и активный лист", async () => {
  const diag = {
    statuses: { _a: "ok", _b: "absent", _c: "ok", _d: "hidden" },
    svg: true,
    activeSheet: "init",
    itemsInEditor: 8,
  };
  const { page, calls } = mockPage({ itemsAppear: false, diag });
  await assert.rejects(
    renderPlan(page, { sheet: "init", itemIds: ["_a", "_b", "_c", "_d"] }),
    (e: unknown) => {
      const err = e as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(err.code, "RENDER_OUT_OF_SYNC");
      assert.deepEqual(err.details?.["missing"], ["_b", "_d"], "missing — только невидимые");
      assert.deepEqual(err.details?.["items"], ["_a", "_b", "_c", "_d"], "items — все ожидаемые (совместимость)");
      assert.equal(err.details?.["active_sheet"], "init");
      assert.equal(err.details?.["items_in_editor"], 8);
      assert.match(err.message, /не видны 2 из 4/);
      assert.match(err.message, /_b: absent/);
      assert.match(err.message, /_d: hidden/);
      assert.doesNotMatch(err.message, /_a:/, "видимый предмет не назван невидимым");
      return true;
    },
  );
  assert.deepEqual(calls.diagArgs[0], ["_a", "_b", "_c", "_d"]);
  assert.equal(calls.screenshots, 0, "PNG по-прежнему не снимается");
});

test("render-items (410): диагностика недоступна — отказ сохраняется, перечислены все ожидаемые", async () => {
  const { page, calls } = mockPage({ itemsAppear: false });
  await assert.rejects(
    renderPlan(page, { sheet: "init", itemIds: ["_a", "_b"] }),
    (e: unknown) => {
      const err = e as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(err.code, "RENDER_OUT_OF_SYNC");
      assert.deepEqual(err.details?.["missing"], ["_a", "_b"]);
      assert.equal(err.details?.["statuses"], null);
      return true;
    },
  );
  assert.equal(calls.screenshots, 0);
});

test("render-items (410): предметы появились после таймаута (гонка) — всё равно отказ без PNG", async () => {
  const { page, calls } = mockPage({ itemsAppear: false, diag: { statuses: { _a: "ok" }, svg: true, activeSheet: "init", itemsInEditor: 1 } });
  await assert.rejects(renderPlan(page, { sheet: "init", itemIds: ["_a"] }), (e: unknown) => {
    assert.equal((e as { code?: string }).code, "RENDER_OUT_OF_SYNC");
    return true;
  });
  assert.equal(calls.screenshots, 0);
});

// Ревью 413 F5: при большом числе невидимых предметов сообщение не разрастается —
// в перечне не больше MAX_RENDER_MISSING_LISTED первых, остальные — «и ещё K».
// details.missing остаётся полным (диагностика не теряется, режется только текст).
test("render-items (413 F5): длинный список обрезается до лимита + «и ещё K»", async () => {
  const ids = Array.from({ length: MAX_RENDER_MISSING_LISTED + 5 }, (_, i) => `_x${i}`);
  const { page } = mockPage({ itemsAppear: false });
  await assert.rejects(
    renderPlan(page, { sheet: "init", itemIds: ids }),
    (e: unknown) => {
      const err = e as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(err.code, "RENDER_OUT_OF_SYNC");
      assert.match(err.message, /не видны 25 из 25/);
      assert.match(err.message, /_x0\b/, "первый предмет назван");
      assert.match(err.message, new RegExp(`_x${MAX_RENDER_MISSING_LISTED - 1}\\b`), "последний из лимита назван");
      assert.match(err.message, /и ещё 5\b/, "остаток — числом");
      assert.doesNotMatch(err.message, new RegExp(`_x${MAX_RENDER_MISSING_LISTED}\\b`), "предмет сверх лимита в перечне не назван");
      assert.deepEqual(err.details?.["missing"], ids, "details.missing — полный список");
      return true;
    },
  );
});

test("render-items (413 F5): список не длиннее лимита — без «и ещё»", async () => {
  const ids = Array.from({ length: MAX_RENDER_MISSING_LISTED }, (_, i) => `_y${i}`);
  const { page } = mockPage({ itemsAppear: false });
  await assert.rejects(
    renderPlan(page, { sheet: "init", itemIds: ids }),
    (e: unknown) => {
      const err = e as Error & { code?: string };
      assert.equal(err.code, "RENDER_OUT_OF_SYNC");
      assert.doesNotMatch(err.message, /и ещё\b/, "уместившийся список не обрезается");
      assert.match(err.message, new RegExp(`_y${MAX_RENDER_MISSING_LISTED - 1}\\b`), "последний предмет назван");
      return true;
    },
  );
});
