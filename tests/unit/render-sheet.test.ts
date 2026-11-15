// Дефект 1 (отчёт 11), живая проба 17: переключение листа — клик по навигации
// включает слои листа (предметы рисуются), $Project.setPlanName — нет.
import test from "node:test";
import assert from "node:assert/strict";
import { pickSheetStrategy } from "../../src/editor/adapter.ts";

test("render-sheet: навигация предпочитается setPlanName (клик включает слои листа)", () => {
  assert.equal(pickSheetStrategy("furniture", true, true), "click");
  assert.equal(pickSheetStrategy("init", true, true), "click");
});

test("render-sheet: без навигации — запасной путь setPlanName", () => {
  assert.equal(pickSheetStrategy("furniture", false, true), "setPlanName");
  assert.equal(pickSheetStrategy("init", false, false), null);
});

test("render-sheet: нет ни навигации, ни setPlanName, лист не init → null (ошибка листа)", () => {
  assert.equal(pickSheetStrategy("furniture", false, false), null);
});
