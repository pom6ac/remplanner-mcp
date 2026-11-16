// Ревью v0.1.1 №3: ошибка ожидания предметов в SVG подавлялась (.catch(() => {})),
// после чего возвращался PNG без предметов. Проверка счётчиков в workspace идёт до
// скриншота и модель не видит. Теперь renderPlan проверяет реальные ВИДИМЫЕ DOM-
// элементы предметов на листе; при таймауте — RENDER_OUT_OF_SYNC без PNG.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPlan } from "../../src/editor/adapter.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

type MockOpts = {
  /** waitForFunction: resolve (предметы отрисованы) или reject (таймаут). */
  itemsAppear: boolean;
};

/** Mock Page для renderPlan: evaluate по исходнику функции, waitForFunction управляется тестом. */
function mockPage(opts: MockOpts) {
  const calls: { sheetSwitch: string[]; screenshots: number; waitForArgs: unknown[] } = {
    sheetSwitch: [],
    screenshots: 0,
    waitForArgs: [],
  };
  const page = {
    async evaluate(fn: string | ((a?: unknown) => unknown), a?: unknown): Promise<unknown> {
      const src = String(fn);
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
