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
  JournalWorkspace, recordingDeps, fixtureModel, addExtraWall, pinExtraWallId,
  recordOutcome, recordError, recordState, recordBackupFiles, recordVerifiedState, journalSnapshot,
  sanitizeBackupPath,
  type RecordingOptions, type SaveServer,
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

function newScenario(server: SaveServer, opts: RecordingOptions = {}): JournalWorkspace {
  let ws: JournalWorkspace;
  const { deps } = recordingDeps(server, opts, (e) => ws.record(e));
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

test("c2s: журнал устойчивого несовпадения сверки — две попытки, SITE_ERROR, рабочая копия сохранена (ревью 193 №5)", async () => {
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
  let mismatch: McpError | null = null;
  try {
    await ws.save();
    assert.fail("ожидался SITE_ERROR");
  } catch (e) {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    mismatch = e;
    recordError(ws, e);
  }
  // рабочая копия не заменена серверной (отката сервера нет): модель и dirty сохраняются,
  // но save_id — из ответа собственной записи (s2), иначе повторный save
  // без force получает SAVE_CONFLICT на собственную запись (ревью 193 №5, 199 №1)
  assert.equal(JSON.stringify(ws.model), modelBefore, "рабочая модель не заменена после неудачной сверки");
  assert.equal(ws.project!.dirty, true, "рабочая копия остаётся несохранённой");
  assert.equal(ws.project!.saveId, "s2", "запомнен save_id из ответа собственной записи");
  // значения details (ревью 199 №5): server_save_id — что реально на сервере,
  // backup_path — файл, записанный backup.write; подсказка без обещания отката
  assert.equal(mismatch!.details && (mismatch!.details as Record<string, unknown>)["server_save_id"], "s2");
  const backupWritten = ws.journal.findLast((e) => e.op === "backup.write")!.path as string;
  assert.equal(sanitizeBackupPath((mismatch!.details as Record<string, unknown>)["backup_path"] as string), backupWritten);
  // подсказка — в штатном поле hint (ревью 199 №4), без «восстановить из backup»
  assert.equal(typeof mismatch!.hint, "string");
  assert.ok(!("hint" in (mismatch!.details as object)));
  assert.doesNotMatch(mismatch!.hint!, /восстанов/);
  assert.doesNotMatch(JSON.stringify(mismatch!.toJSON()), /откат/i, "текст ошибки не обещает отката сервера");
  recordState(ws);
  checkSnapshot("verify-mismatch-working-copy-kept", ws);
});

test("c2s: журнал повторного save без force после устойчивого расхождения — успех без SAVE_CONFLICT (ревью 193 №5)", async () => {
  const server: SaveServer = { saveId: "s1", model: fixtureModel() };
  let ws: JournalWorkspace;
  // сервер искажает запись только в первых двух попытках: первый save уходит
  // в устойчивое расхождение, повторный save уже верифицируется
  const recording = recordingDeps(server, {
    afterSave: (s, n) => {
      if (n <= 2) {
        const walls = s.model.walls as Record<string, unknown>;
        delete walls[Object.keys(walls)[0]!];
      }
    },
  }, (e) => ws.record(e));
  ws = new JournalWorkspace(recording.deps);
  await ws.open("211", "1");
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
  // рабочая копия с желаемой моделью и dirty:true запомнила серверный save_id (s2)
  assert.equal(JSON.stringify(ws.model), modelBefore, "рабочая модель не заменена после неудачной сверки");
  assert.equal(ws.project!.saveId, "s2");
  assert.equal(ws.project!.dirty, true);
  recordState(ws);
  // редактор закрыт (как в реальной сессии между вызовами project_save):
  // повторный save без force не должен получать SAVE_CONFLICT на собственную запись.
  // Путь с открытым редактором здесь не закреплён: и до ревью 193 №5 он завершался
  // ok без pre-check по save_id (чужой конфликт ловит сверка контента)
  await ws.close();
  const outcome = await ws.save();
  recordOutcome(ws, outcome);
  recordBackupFiles(ws);
  recordState(ws);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.rounds, 1);
  assert.equal(ws.project!.dirty, false);
  checkSnapshot("verify-mismatch-resave", ws);
});

// --- ревью 199 №1/№2: источник save_id после mismatch — только ответ собственной
// записи (saveRes.saveId), не GET-сверка; чужая запись между своим save и GET
// не должна попадать в рабочую копию и затираться повторным save без force ---

test("c2s: mismatch → чужая запись → повторный save без force — SAVE_CONFLICT, чужая правка не затёрта (ревью 199 №2а)", async () => {
  const server: SaveServer = { saveId: "s1", model: fixtureModel() };
  let ws: JournalWorkspace;
  // сервер искажает запись в обеих попытках — устойчивое расхождение
  const recording = recordingDeps(server, {
    afterSave: (s) => {
      const walls = s.model.walls as Record<string, unknown>;
      delete walls[Object.keys(walls)[0]!];
    },
  }, (e) => ws.record(e));
  ws = new JournalWorkspace(recording.deps);
  await ws.open("212", "1");
  addExtraWall(ws);
  try {
    await ws.save();
    assert.fail("ожидался SITE_ERROR");
  } catch (e) {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    recordError(ws, e);
  }
  // рабочая копия запомнила save_id собственной записи (s2)
  assert.equal(ws.project!.saveId, "s2");
  assert.equal(ws.project!.dirty, true);
  recordState(ws);
  // редактор закрыт; после нашего неуспешного save чужая вкладка записала свой вариант
  await ws.close();
  server.saveId = "s3";
  try {
    await ws.save();
    assert.fail("ожидался SAVE_CONFLICT");
  } catch (e) {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SAVE_CONFLICT");
    recordError(ws, e);
  }
  // чужая правка не затёрта: рабочая копия не ушла в запись (dirty:true, save_id s2)
  assert.equal(ws.project!.dirty, true);
  assert.equal(ws.project!.saveId, "s2");
  recordState(ws);
  checkSnapshot("verify-mismatch-foreign-resave-conflict", ws);
});

test("c2s: гонка — чужая запись между ответом save и GET-сверкой; save_id не берётся из GET (ревью 199 №2б)", async () => {
  const server: SaveServer = { saveId: "s1", model: fixtureModel() };
  let ws: JournalWorkspace;
  // сервер искажает только первую запись: вторая попытка пишет чисто, но между
  // ответом save и GET-сверкой чужая вкладка записывает свой вариант (s3 + сдвиг стены)
  const recording = recordingDeps(server, {
    afterSave: (s, n) => {
      if (n === 1) {
        const walls = s.model.walls as Record<string, unknown>;
        delete walls[Object.keys(walls)[0]!];
      }
    },
  }, (e) => ws.record(e));
  let loads = 0;
  const baseLoad = recording.deps.loadModel.bind(recording.deps);
  recording.deps.loadModel = async (s, objectId, planId) => {
    loads++;
    if (loads === 4) {
      // четвёртая загрузка (1 — open, 2 — сверка до записи, 3 — GET после
      // попытки 1, 4 — GET после попытки 2): чужая запись ушла на сервер
      // между ответом save и сверкой
      server.saveId = "s3";
      const walls = server.model.walls as Record<string, { p1: { x: number; y: number } }>;
      walls[Object.keys(walls)[0]!]!.p1.x += 77;
    }
    return baseLoad(s, objectId, planId);
  };
  ws = new JournalWorkspace(recording.deps);
  await ws.open("213", "1");
  addExtraWall(ws);
  let raceMismatch: McpError | null = null;
  try {
    await ws.save();
    assert.fail("ожидался SITE_ERROR");
  } catch (e) {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    raceMismatch = e;
    recordError(ws, e);
  }
  // save_id — из ответа собственной записи (s2), а не из GET-сверки (s3):
  // иначе повторный save без force молча затёр бы чужую правку
  assert.equal(ws.project!.saveId, "s2");
  assert.equal(ws.project!.dirty, true);
  // details.server_save_id — диагностическое поле: что сейчас на сервере (s3)
  assert.equal((raceMismatch!.details as Record<string, unknown>)["server_save_id"], "s3");
  recordState(ws);
  // редактор закрыт: повторный save без force обязан получить SAVE_CONFLICT
  await ws.close();
  try {
    await ws.save();
    assert.fail("ожидался SAVE_CONFLICT");
  } catch (e) {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SAVE_CONFLICT");
    recordError(ws, e);
  }
  assert.equal(ws.project!.dirty, true);
  assert.equal(ws.project!.saveId, "s2");
  recordState(ws);
  checkSnapshot("verify-mismatch-race-foreign", ws);
});

test("c2s: ответ save без save_id при устойчивом расхождении — save_id рабочей копии не меняется (ревью 199 №2в)", async () => {
  const server: SaveServer = { saveId: "s1", model: fixtureModel() };
  let ws: JournalWorkspace;
  const recording = recordingDeps(server, {
    saveWithoutId: true,
    afterSave: (s) => {
      const walls = s.model.walls as Record<string, unknown>;
      delete walls[Object.keys(walls)[0]!];
    },
  }, (e) => ws.record(e));
  ws = new JournalWorkspace(recording.deps);
  await ws.open("214", "1");
  addExtraWall(ws);
  try {
    await ws.save();
    assert.fail("ожидался SITE_ERROR");
  } catch (e) {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SITE_ERROR");
    recordError(ws, e);
  }
  // ответ save не вернул save_id — остаётся прежний (s1), а не id из GET-сверки:
  // ложный SAVE_CONFLICT при повторном save безопаснее чужого save_id
  assert.equal(ws.project!.saveId, "s1");
  assert.equal(ws.project!.dirty, true);
  recordState(ws);
  checkSnapshot("verify-mismatch-save-without-id", ws);
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

// --- 194-fix-c2s (ревью 193 №1/№2): адаптеры SaveHost закреплены наблюдаемым
// состоянием после save — модель, roomSaveBase, кэш комнат (rooms()), dirty ---

test("c2s: журнал save при уже открытом редакторе — чужой save_id принят без SAVE_CONFLICT, без повторного openEditor", async () => {
  const server: SaveServer = { saveId: "s1", model: fixtureModel() };
  const ws = newScenario(server);
  await ws.open("207", "1");
  addExtraWall(ws);
  pinExtraWallId(ws, "extra1");
  // редактор запущен до save (рендер/каталог): наш редактор легитимно продвигает
  // save_id — свежий принимается как база, конфликт ловит только чужой
  await ws.ensureEditor();
  server.saveId = "s_other";
  const outcome = await ws.save();
  recordOutcome(ws, outcome);
  recordBackupFiles(ws);
  recordVerifiedState(ws);
  assert.equal(outcome.verified, true);
  assert.equal(ws.journal.filter((e) => e.op === "openEditor").length, 1, "повторного запуска редактора нет");
  assert.equal(ws.project!.saveId, "s2", "save_id после записи — с сервера");
  assert.equal(ws.project!.dirty, false);
  checkSnapshot("editor-open-fresh-saveid", ws);
});

test("c2s: журнал verified с переименованием стены сервером — рабочая копия и база комнат взяты с сервера", async () => {
  const server: SaveServer = { saveId: "s1", model: fixtureModel() };
  let ws: JournalWorkspace;
  // сервер при записи переименовал стену пользователя (сверка по осям проходит —
  // verified): onVerified обязан заменить рабочую копию ответом сервера
  const recording = recordingDeps(server, {
    afterSave: (s) => {
      const walls = s.model.walls as Record<string, { id: string; p1: { x: number; y: number } }>;
      const extra = Object.keys(walls).find((id) => walls[id]!.p1.y === 600)!;
      const w = walls[extra]!;
      delete walls[extra];
      w.id = "srv_renamed";
      walls["srv_renamed"] = w;
    },
  }, (e) => ws.record(e));
  ws = new JournalWorkspace(recording.deps);
  await ws.open("208", "1");
  addExtraWall(ws);
  pinExtraWallId(ws, "extra1");
  const outcome = await ws.save();
  recordOutcome(ws, outcome);
  recordBackupFiles(ws);
  recordVerifiedState(ws);
  assert.equal(outcome.verified, true);
  assert.ok(Object.keys(ws.model.walls).includes("srv_renamed"), "рабочая копия заменена ответом сервера");
  assert.ok(!Object.keys(ws.model.walls).includes("extra1"));
  checkSnapshot("verified-server-renamed-wall", ws);
});

test("c2s: журнал normalize со списком комнат — кэш комнат обновлён, rooms() видит их после save", async () => {
  const model = fixtureModel();
  delete model.rooms2; // в канонической копии комнат нет — rooms() читает кэш нормализации
  const server: SaveServer = { saveId: "s1", model };
  const ws = newScenario(server, {
    normalizeRooms: [{
      id: "r_norm", name: "Гостиная", area: null, area_m2: 10.64, height: null,
      polygon: [{ x: 10, y: 10 }, { x: 390, y: 10 }, { x: 390, y: 290 }, { x: 10, y: 290 }],
    }],
  });
  await ws.open("209", "1");
  addExtraWall(ws);
  pinExtraWallId(ws, "extra1");
  const outcome = await ws.save();
  recordOutcome(ws, outcome);
  recordBackupFiles(ws);
  recordVerifiedState(ws);
  assert.equal(outcome.verified, true);
  assert.deepEqual(ws.rooms().map((r) => String(r.roomId)), ["r_norm"], "комнаты от normalize доступны через rooms()");
  checkSnapshot("normalize-rooms-cache", ws);
});

test("c2s: журнал потери зоны комнаты при нормализации — сверка комнат от базы (roomSaveBase), NORMALIZATION_DROPPED", async () => {
  const model = fixtureModel();
  (model.rooms2!["r1"] as { zones?: unknown[] }).zones = [{ name: "Гостиная", is_micro_zone: false }];
  const server: SaveServer = { saveId: "s1", model };
  const ws = newScenario(server);
  await ws.open("210", "1");
  // пользователь убрал зону комнаты локально (без изменения стен): сверка до записи
  // идёт от базы (модель с сервера), а не от рабочей копии — потеря зоны не «verified»
  ws.apply("room_zone_remove", (m) => {
    delete (m.rooms2 as Record<string, { zones?: unknown[] }>)["r1"]!.zones;
  });
  try {
    await ws.save();
    assert.fail("ожидался NORMALIZATION_DROPPED");
  } catch (e) {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "NORMALIZATION_DROPPED");
    recordError(ws, e);
  }
  // рабочая копия не заменена, dirty сохраняется, база комнат — с зоной с сервера
  assert.equal(JSON.stringify(Object.keys(ws.model.rooms2 ?? {})), JSON.stringify(["r1"]));
  recordVerifiedState(ws);
  checkSnapshot("rooms-compare-from-base", ws);
});
