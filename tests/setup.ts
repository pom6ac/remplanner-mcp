// Глобальный setup тестового раннера (ревью v0.1.1-r2 R2-1): подключается через
// --import в скриптах npm test / npm run test:contract / npm run test:live, поэтому
// исполняется в каждом тестовом процессе ДО импорта тестов и src/config.ts.
// Перенаправляет каталог состояния (~/.remplanner-mcp) во временный: тесты не имеют
// права писать в настоящий домашний каталог (EPERM в песочнице, замусоривание
// backups пользователя). Флаг REMPLANNER_TEST вместе с NODE_TEST_CONTEXT включает
// guard в src/config.ts: тестовый процесс с реальным ~/.remplanner-mcp падает сразу.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env["REMPLANNER_HOME"]) {
  process.env["REMPLANNER_HOME"] = mkdtempSync(join(tmpdir(), "remplanner-test-home-"));
}
process.env["REMPLANNER_TEST"] = "1";
