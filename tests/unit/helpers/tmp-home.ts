// Подключается ПЕРВЫМ импортом в тестах, которые пишут состояние (~/.remplanner-mcp):
// перенаправляет каталог состояния во временный (src/config.ts читает REMPLANNER_HOME
// при загрузке модуля, поэтому env обязан быть выставлен до его импорта).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env["REMPLANNER_HOME"]) {
  process.env["REMPLANNER_HOME"] = mkdtempSync(join(tmpdir(), "remplanner-test-home-"));
}
