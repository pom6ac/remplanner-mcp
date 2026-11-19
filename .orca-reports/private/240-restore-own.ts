// 240: восстановление dev-проекта (env: REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID)
// из снимка GET до прогона (.orca-reports/tmp/get-own-before.json): restore исходной сырой
// модели в открытый редактор (тот же путь, что workspace.save) → штатный project.save →
// GET после → сверка осевых отрезков стен с оригиналом.
// Запуск: node --experimental-strip-types scripts/probes/240-restore-own.ts run
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { PAGE } from "../../src/editor/inject.js";
import { wallAxisSegments, wallAxisSetsEqual } from "../../src/model/walls.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run (REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID");
  process.exit(1);
}

const srcPath = process.env["REMPLANNER_RESTORE_SRC"] ?? ".orca-reports/tmp/get-own-before.json";
const before: LoadedModel = JSON.parse(readFileSync(srcPath, "utf8")) as LoadedModel;
const session = loadSession(STATE_PATH);
const shell = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";

const browser = await chromium.launch({ executablePath: existsSync(shell) ? shell : undefined, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "ru-RU" });
await ctx.addCookies(session.cookies.map((c: { name: string; value: string; domain: string; path?: string; httpOnly?: boolean; secure?: boolean }) => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/", httpOnly: c.httpOnly ?? false, secure: c.secure ?? false,
})));
const page = await ctx.newPage();
try {
  const current = await loadModel(session, OBJECT_ID, PLAN_ID);
  console.log("current save_id:", current.save_id, "walls:", Object.keys(current.model.walls ?? {}).length);

  await page.goto(`https://remplanner.ru/planner/?object_id=${OBJECT_ID}&plan_id=${PLAN_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { WALLS?: unknown }).WALLS && (window as unknown as { $Project?: unknown }).$Project && (window as unknown as { project?: unknown }).project, null, { timeout: 60000 });
  await page.waitForTimeout(3000);

  // восстановить исходную модель (reset:1 — как в адаптере перед нормализацией)
  await page.evaluate((arg) => {
    (window as unknown as { __remplanner_arg?: unknown }).__remplanner_arg = arg;
  }, { model: before.model, waitMs: 1500 });
  const restored = (await page.evaluate(PAGE.restoreDrawCopy)) as { restoreError?: string; model?: Record<string, unknown> };
  if (restored.restoreError) throw new Error(`restore: ${restored.restoreError}`);
  const restoredWalls = Object.keys((restored.model as { walls?: Record<string, unknown> })?.walls ?? {}).length;
  console.log("restored walls:", restoredWalls);

  // штатный project.save(false, true); ответ /setup/api/planner/save/
  const saveResponse = page.waitForResponse((r) => r.url().includes("/setup/api/planner/save/"), { timeout: 60000 });
  const started = (await page.evaluate(PAGE.savePlan)) as { started: boolean; error?: string };
  if (!started.started) throw new Error(`project.save не сработал: ${started.error ?? "?"}`);
  const resp = await saveResponse;
  const body = (await resp.json()) as { result?: string; save_id?: string };
  console.log("save:", body.result, "save_id:", body.save_id, "status:", resp.status());
  if (body.result !== "success") throw new Error(`save не удался: ${JSON.stringify(body).slice(0, 200)}`);

  // GET после — сверка осевых отрезков стен с оригиналом
  const after = await loadModel(session, OBJECT_ID, PLAN_ID);
  writeFileSync(".orca-reports/tmp/get-own-restored.json", JSON.stringify(after, null, 1));
  const segsBefore = wallAxisSegments(before.model.walls as never);
  const segsAfter = wallAxisSegments(after.model.walls as never);
  const equal = wallAxisSetsEqual(segsBefore, segsAfter);
  const holesBefore = Object.values(before.model.walls as Record<string, { holes?: Record<string, unknown> }>).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0);
  const holesAfter = Object.values(after.model.walls as Record<string, { holes?: Record<string, unknown> }>).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0);
  const itemsBefore = Object.keys(before.model.items ?? {}).length;
  const itemsAfter = Object.keys(after.model.items ?? {}).length;
  console.log("walls:", segsBefore.length, "→", segsAfter.length, "segments equal:", equal);
  console.log("holes:", holesBefore, "→", holesAfter, "items:", itemsBefore, "→", itemsAfter);
  console.log("RESULT:", equal && holesBefore === holesAfter && itemsBefore === itemsAfter ? "RESTORE_OK" : "RESTORE_DIFF");
} finally {
  await browser.close().catch(() => {});
}
process.exit(0);
