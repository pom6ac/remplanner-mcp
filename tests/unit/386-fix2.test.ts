// Фикс-2 по ревью 385 (386): nit 38 — serviceWorkers:"block" покрыт тестом
// (мутация «удалить строку» раньше давала 0 fail); nit 39 — content {}
// принимается как пустой список (бандл создаёт content как массив и читает
// через .length/in_array), непустой объект — по-прежнему попадание.
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { newContextOptions } from "../../src/editor/adapter.ts";
import { findUnsafeEditorStrings } from "../../src/model/strings.ts";
import type { Model } from "../../src/model/types.ts";

test("386 nit38: newContextOptions блокирует service workers (page.route их не видит)", () => {
  const opts = newContextOptions();
  assert.equal(opts.serviceWorkers, "block", "serviceWorkers: block — запросы service worker блокируются целиком");
  assert.equal(opts.locale, "ru-RU");
  assert.deepEqual(opts.viewport, { width: 1600, height: 1000 });
});

test("386 nit39: content {} — пустой список (не попадание); непустой объект — попадание", () => {
  const empty = { walls: {}, custom_plans: { sh1: { id: "sh1", name: "Лист", content: {} } } } as unknown as Model;
  assert.equal(findUnsafeEditorStrings(empty).length, 0, "content {} — как пустой массив, не попадание");
  const nonEmpty = { walls: {}, custom_plans: { sh1: { id: "sh1", name: "Лист", content: { 0: "plan" } } } } as unknown as Model;
  assert.ok(
    findUnsafeEditorStrings(nonEmpty).some((h) => h.collection === "custom_plans" && h.field === "content"),
    "непустой объект в content — по-прежнему попадание (fail-closed)",
  );
});
