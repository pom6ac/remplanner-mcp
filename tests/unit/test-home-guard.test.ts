// Ревью v0.1.1 раунд 2 R2-1: save-тесты писали бэкапы в настоящий ~/.remplanner-mcp.
// Любой тестовый процесс обязан работать во временном каталоге состояния: npm test
// подключает tests/setup.ts через --import, он выставляет REMPLANNER_HOME до импорта
// src/config.ts. Здесь проверяется сама изоляция; guard в config.ts дублирует её
// ошибкой при прямом запуске теста без setup.
import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME_DIR, BACKUPS_DIR } from "../../src/config.ts";

test("test-home: состояние тестов уходит во временный каталог, не в ~/.remplanner-mcp", () => {
  const realHome = join(homedir(), ".remplanner-mcp");
  assert.notEqual(HOME_DIR, realHome, `HOME_DIR указывает на настоящий домашний каталог: ${HOME_DIR}`);
  assert.ok(!HOME_DIR.startsWith(realHome), `HOME_DIR внутри настоящего домашнего каталога: ${HOME_DIR}`);
  assert.ok(!BACKUPS_DIR.startsWith(realHome), `BACKUPS_DIR внутри настоящего домашнего каталога: ${BACKUPS_DIR}`);
});
