// T15: совместимость версий редактора — EDITOR_INCOMPATIBLE на моке страницы,
// отпечатки бандлов, лог смены global_version.
import test from "node:test";
import assert from "node:assert/strict";
import {
  readCompat, assertCompatible, missingFunctions, bundleFingerprints,
  trackVersion, resetVersionTracking, type CompatInfo,
} from "../../src/editor/compat.ts";
import { PAGE } from "../../src/editor/inject.js";
import { McpError } from "../../src/errors.ts";

/** Мок страницы: evaluate исполняет строковые функции inject.js через new Function. */
function mockPage(globals: Record<string, unknown>, dom: Record<string, unknown> = {}) {
  return {
    evaluate<T>(fn: string): Promise<T> {
      const w = { ...globals };
      const document = {
        querySelector: (sel: string) => (dom[sel] ?? null),
        querySelectorAll: (sel: string) => {
          if (sel === "script[src]") return (dom["scripts"] ?? []) as ArrayLike<unknown> & { [Symbol.iterator](): Iterator<unknown> };
          return [];
        },
        body: { dataset: { objectId: (dom["object_id"] as string) ?? "", plan_id: (dom["plan_id"] as string) ?? "" } },
      };
      const fnObj = new Function("window", "document", `"use strict"; return (${fn});`);
      return Promise.resolve(fnObj(w, document) as T);
    },
  };
}

function scriptList(...srcs: string[]) {
  return srcs.map((src) => ({ getAttribute: () => src }));
}

const fullGlobals = () => ({
  global_version: "1234567890",
  planner_version: "3",
  WALLS: { w1: {} },
  ROOMS2: {},
  $Project: { restore: () => {}, draw: () => {} },
  project: { copy: () => {}, save: () => {} },
  // класс Wall проверяется через window.Wall (в живом бандле — лексическая привязка,
  // compatInfo читает оба пути); T25: связи строятся Wall.prototype.link1/link2/calc
  Wall: class { link1() {} link2() {} calc() {} },
});

test("compat: все точки входа на месте — assertCompatible проходит", async () => {
  const page = mockPage(fullGlobals(), {
    "#canvas_v2_wrapper": { el: true },
    scripts: scriptList("/files/js/v2/app/planner.tools___1___2.js"),
  });
  const info = await readCompat(page as never);
  assert.equal(info.global_version, "1234567890");
  assert.equal(info.present.restore, true);
  assert.equal(info.present.save, true);
  assert.deepEqual(missingFunctions(info.present), []);
  assertCompatible(info);
});

test("compat: подмена имени функции (нет $Project.restore) → EDITOR_INCOMPATIBLE", async () => {
  const g = fullGlobals();
  (g.$Project as Record<string, unknown>) = { draw: () => {} }; // restore пропал
  const page = mockPage(g, { "#canvas_v2_wrapper": { el: true }, scripts: [] });
  const info = await readCompat(page as never);
  assert.deepEqual(missingFunctions(info.present), ["$Project.restore"]);
  assert.throws(() => assertCompatible(info), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "EDITOR_INCOMPATIBLE");
    assert.match(e.message, /restore/);
    assert.deepEqual((e.details as { missing: string[] }).missing, ["$Project.restore"]);
    return true;
  });
});

test("compat: пропало несколько точек входа — все перечислены в ошибке", async () => {
  const page = mockPage({}, {}); // пустой редактор
  const info = await readCompat(page as never);
  const missing = missingFunctions(info.present);
  assert.ok(missing.includes("window.WALLS"));
  assert.ok(missing.includes("window.ROOMS2"));
  assert.ok(missing.includes("$Project.restore"));
  assert.ok(missing.includes("$Project.draw"));
  assert.ok(missing.includes("project.copy"));
  assert.ok(missing.includes("project.save"));
  assert.ok(missing.includes("#canvas_v2_wrapper"));
  assert.ok(missing.includes("Wall.prototype.link1"));
  assert.ok(missing.includes("Wall.prototype.link2"));
  assert.ok(missing.includes("Wall.prototype.calc"));
  assert.throws(() => assertCompatible(info), /EDITOR_INCOMPATIBLE|несовместим/);
});

test("compat: у Wall пропал link2 → EDITOR_INCOMPATIBLE (T25: draw не построит edge-связи)", async () => {
  const g = fullGlobals();
  (g.Wall as unknown as { prototype: Record<string, unknown> }) = class { link1() {} calc() {} } as never;
  const page = mockPage(g, { "#canvas_v2_wrapper": { el: true }, scripts: [] });
  const info = await readCompat(page as never);
  assert.equal(info.present.wall_link2, false);
  assert.deepEqual(missingFunctions(info.present), ["Wall.prototype.link2"]);
  assert.throws(() => assertCompatible(info), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "EDITOR_INCOMPATIBLE");
    assert.match(e.message, /link2/);
    return true;
  });
});

test("compat: bundleFingerprints — смена имени бандла меняет отпечаток", () => {
  const a = bundleFingerprints(["/files/js/v2/app/planner.tools___1___2.js"]);
  const b = bundleFingerprints(["/files/js/v2/app/planner.tools___3___4.js"]);
  assert.equal(a.length, 1);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, bundleFingerprints(["/files/js/v2/app/planner.tools___1___2.js"]));
});

function infoWith(version: string | null): CompatInfo {
  return {
    global_version: version,
    planner_version: "3",
    bundles: ["/files/js/v2/app/planner.js"],
    object_id: "123",
    plan_id: "1",
    present: {
      WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true,
      wall_link1: true, wall_link2: true, wall_calc: true,
    },
  };
}

test("compat: trackVersion — фиксация при первом контакте, предупреждение при смене", () => {
  resetVersionTracking(null);
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  trackVersion(infoWith("100"), log);
  trackVersion(infoWith("100"), log);
  assert.equal(lines.length, 0, "первый контакт и совпадение не логируются");
  trackVersion(infoWith("200"), log);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /1234567890|100/);
  assert.match(lines[0]!, /200/);
  // null-версия не трогает состояние
  trackVersion(infoWith(null), log);
  assert.equal(lines.length, 1);
  resetVersionTracking(null);
});
