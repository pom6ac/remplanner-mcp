// Журнал вызовов save-оркестрации (аудит 65 C2, план п.11 «save orchestration»,
// задача 192-c2s п.1): через существующий seam WorkspaceDeps/EditorLike (фейки)
// записывается порядок и аргументы вызовов для сценариев save. Снапшоты журналов
// — в tests/unit/snapshots/c2-save-journal-*.json; после вынесения save-оркестрации
// в src/save/ журналы обязаны остаться побайтно теми же (задача 192-c2s п.3).
// Переснятие — только осознанно: C2_SAVE_JOURNAL_REGEN=1 npm test
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpError } from "../../src/errors.ts";
import {
  JournalWorkspace, recordingDeps, fixtureModel, addExtraWall,
  recordOutcome, recordError, recordState, recordBackupFiles, journalSnapshot,
  type SaveServer,
} from "./helpers/c2-save-journal.ts";

const SNAPSHOT_DIR = join(import.meta.dirname, "snapshots");
const REGEN = process.env["C2_SAVE_JOURNAL_REGEN"] === "1";

/** Прогон сценария: журнал сравнивается с сохранённым снапшотом побайтно. */
function checkSnapshot(name: string, ws: JournalWorkspace): void {
  const current = journalSnapshot(ws.journal);
  const path = join(SNAPSHOT_DIR, `c2-save-journal-${name}.json`);
  if (REGEN) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(path, current);
    return;
  }
  const stored = readFileSync(path, "utf8");
  assert.equal(current, stored, `журнал вызовов save изменился (${name}) — рефакторинг не должен менять последовательность вызовов; переснятие — только осознанно`);
}

function newScenario(server: SaveServer): JournalWorkspace {
  let ws: JournalWorkspace;
  const { deps } = recordingDeps(server, {}, (e) => ws.record(e));
  ws = new JournalWorkspace(deps);
  return ws;
}

test("c2s: журнал успешного save — сверка, backup до записи, openEditor, normalize, save, верификация по GET", async () => {
  const server: SaveServer = { saveId: "s1", model: fixtureModel() };
  const ws = newScenario(server);
  await ws.open("201", "1");
  addExtraWall(ws);
  const outcome = await ws.save();
  recordOutcome(ws, outcome);
  recordBackupFiles(ws);
  recordState(ws);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.rounds, 1);
  assert.equal(ws.project!.dirty, false);
  checkSnapshot("success", ws);
});

test("c2s: журнал конфликта ревизии (SAVE_CONFLICT) и записи поверх по force", async () => {
  const server: SaveServer = { saveId: "s1", model: fixtureModel() };
  const ws = newScenario(server);
  await ws.open("202", "1");
  addExtraWall(ws);
  // в другой вкладке сохранились: save_id сервера убежал вперёд
  server.saveId = "s_other";
  try {
    await ws.save();
    assert.fail("ожидался SAVE_CONFLICT");
  } catch (e) {
    assert.ok(e instanceof McpError);
    recordError(ws, e);
  }
  assert.equal(ws.project!.dirty, true, "конфликт не сбрасывает dirty");
  // force: true — принудительная запись поверх
  const outcome = await ws.save({ force: true });
  recordOutcome(ws, outcome);
  recordBackupFiles(ws);
  recordState(ws);
  assert.equal(outcome.verified, true);
  checkSnapshot("conflict-force", ws);
});

test("c2s: журнал сетевого сбоя editor.save — одна попытка, без повторов и задержек", async () => {
  let ws: JournalWorkspace;
  const server: SaveServer = { saveId: "s1", model: fixtureModel() };
  const { deps } = recordingDeps(server, { failSave: true }, (e) => ws.record(e));
  ws = new JournalWorkspace(deps);
  await ws.open("203", "1");
  addExtraWall(ws);
  try {
    await ws.save();
    assert.fail("ожидался SITE_ERROR");
  } catch (e) {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    recordError(ws, e);
  }
  recordState(ws);
  // текущая семантика: сетевой сбой — одна попытка, ретраев и задержек нет
  assert.equal(ws.journal.filter((e) => e.op === "editor.save").length, 1);
  assert.equal(ws.journal.filter((e) => e.op === "sleep").length, 0);
  checkSnapshot("network-failure", ws);
});

test("c2s: журнал несовпадения сверки после save — повтор записи, вторая попытка verified", async () => {
  const server: SaveServer = { saveId: "s1", model: fixtureModel() };
  let ws: JournalWorkspace;
  // первая запись оставляет на сервере модель без одной стены — сверка по GET
  // не сходится; повторная запись пишет нормализованную модель целиком
  const recording = recordingDeps(server, {
    afterSave: (s, n) => {
      if (n === 1) {
        const walls = s.model.walls as Record<string, unknown>;
        delete walls[Object.keys(walls)[0]!];
      }
    },
  }, (e) => ws.record(e));
  ws = new JournalWorkspace(recording.deps);
  await ws.open("204", "1");
  addExtraWall(ws);
  const outcome = await ws.save();
  recordOutcome(ws, outcome);
  recordBackupFiles(ws);
  recordState(ws);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.rounds, 2, "сверка сошлась со второй попытки");
  assert.equal(ws.project!.dirty, false);
  checkSnapshot("verify-retry", ws);
});

test("c2s: журнал устойчивого несовпадения сверки — две попытки, SITE_ERROR, откат рабочей копии", async () => {
  const server: SaveServer = { saveId: "s1", model: fixtureModel() };
  let ws: JournalWorkspace;
  const recording = recordingDeps(server, {
    afterSave: (s) => {
      const walls = s.model.walls as Record<string, unknown>;
      delete walls[Object.keys(walls)[0]!];
    },
  }, (e) => ws.record(e));
  ws = new JournalWorkspace(recording.deps);
  await ws.open("205", "1");
  addExtraWall(ws);
  const modelBefore = JSON.stringify(ws.model);
  try {
    await ws.save();
    assert.fail("ожидался SITE_ERROR");
  } catch (e) {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    recordError(ws, e);
  }
  // откат: каноническая копия не заменена серверной, dirty сохраняется
  assert.equal(JSON.stringify(ws.model), modelBefore, "рабочая модель не заменена после неудачной сверки");
  recordState(ws);
  checkSnapshot("verify-mismatch-rollback", ws);
});

test("c2s: журнал save без изменений (dirty=false) — та же последовательность сверок", async () => {
  const server: SaveServer = { saveId: "s1", model: fixtureModel() };
  const ws = newScenario(server);
  await ws.open("206", "1");
  assert.equal(ws.project!.dirty, false);
  const outcome = await ws.save();
  recordOutcome(ws, outcome);
  recordBackupFiles(ws);
  recordState(ws);
  assert.equal(outcome.verified, true);
  assert.equal(ws.project!.dirty, false);
  checkSnapshot("unchanged", ws);
});
