// Раунд 2, R2-12: headed-запрос при живом headless-браузере требует перезапуска.
import test from "node:test";
import assert from "node:assert/strict";
import { needsHeadedRelaunch } from "../../src/browser.ts";

test("R2-12: needsHeadedRelaunch — перезапуск только headless → headed", () => {
  assert.equal(needsHeadedRelaunch("headless", true), true, "headless запущен, запросили headed");
  assert.equal(needsHeadedRelaunch("headed", true), false, "headed уже запущен");
  assert.equal(needsHeadedRelaunch(null, true), false, "браузера нет — launch с headed");
  assert.equal(needsHeadedRelaunch("headless", undefined), false, "headed не запрошен");
  assert.equal(needsHeadedRelaunch("headless", false), false);
});
