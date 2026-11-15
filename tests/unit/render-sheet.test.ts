// Ревью v0.1.1 №6: тест переключения листа проверял pickSheetStrategy — функцию,
// которую production-код не вызывает (мёртвый дубликат switchSheet). Тест идёт через
// реальную реализацию switchSheetInPage (единственное тело, исполняемое page.evaluate)
// и через renderPlan: клик по навигации при доступности обоих путей, ошибка листа.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPlan, switchSheetInPage } from "../../src/editor/adapter.ts";

/** Подменяет document/window на время вызова switchSheetInPage (функция для страницы). */
function withFakeDom(opts: { nav: boolean; setPlanName?: () => void }, fn: () => void): { clicks: number; setPlanCalls: number } {
  const state = { clicks: 0, setPlanCalls: 0 };
  const g = globalThis as unknown as { document?: unknown; window?: unknown; HTMLElement?: unknown };
  const prevDocument = g.document;
  const prevWindow = g.window;
  const prevHTMLElement = g.HTMLElement;
  g.document = {
    querySelector: (sel: string) => {
      if (opts.nav && String(sel).startsWith(".groups_navi_item.plan_")) {
        return { click: () => { state.clicks++; } };
      }
      return null;
    },
  };
  g.window = {
    $Project: opts.setPlanName ? { setPlanName: () => { state.setPlanCalls++; opts.setPlanName?.(); } } : undefined,
  };
  g.HTMLElement = class {};
  try {
    fn();
  } finally {
    g.document = prevDocument;
    g.window = prevWindow;
    g.HTMLElement = prevHTMLElement;
  }
  return state;
}

test("render-sheet: при доступности обоих путей — клик по навигации, setPlanName не вызывается", () => {
  const state = withFakeDom({ nav: true, setPlanName() {} }, () => {
    assert.equal(switchSheetInPage("furniture"), "click");
  });
  assert.equal(state.clicks, 1, "клик по .groups_navi_item.plan_furniture");
  assert.equal(state.setPlanCalls, 0, "setPlanName не тронут — он не включает слои листа (живая проба 17)");
});

test("render-sheet: без навигации — запасной путь setPlanName", () => {
  const state = withFakeDom({ nav: false, setPlanName() {} }, () => {
    assert.equal(switchSheetInPage("furniture"), "setPlanName");
  });
  assert.equal(state.clicks, 0);
  assert.equal(state.setPlanCalls, 1);
});

test("render-sheet: нет ни навигации, ни setPlanName → null, renderPlan с чужим листом → INVALID_ARGUMENT", async () => {
  const state = withFakeDom({ nav: false }, () => {
    assert.equal(switchSheetInPage("furniture"), null);
  });
  assert.equal(state.clicks + state.setPlanCalls, 0);
  // renderPlan: switchSheet вернул null (evaluate → null), лист не init → ошибка
  const page = {
    async evaluate(fn: string | ((a?: unknown) => unknown)): Promise<unknown> {
      if (typeof fn === "function" && String(fn).includes("groups_navi_item")) return null;
      if (String(fn).includes("planner_ui_message_fog")) return true;
      return {};
    },
    async waitForTimeout(_ms: number) {},
    viewportSize() { return { width: 1600, height: 1000 }; },
    locator() { return { nth() { return { async screenshot() { return Buffer.alloc(9); } }; } }; },
  } as never;
  await assert.rejects(
    renderPlan(page, { sheet: "furniture" }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal((e as { code?: string }).code, "INVALID_ARGUMENT");
      assert.match((e as Error).message, /furniture/);
      return true;
    },
  );
});
