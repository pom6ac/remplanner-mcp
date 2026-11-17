// Аудит 65 A2: обезличивание пяти эталонов ui-ref-{room,door,window,roomname,sofa}.json.
// Было: полный дамп состояния страницы (walls/items/rooms1/rooms2/copy) без _source,
// с исходными ID проекта (copy.id/plan_id) и внутренними ID сайта.
// Стало: только серверная модель copy (project.copy("server")) с _source; ID стен/
// комнат/проёмов/предметов и все ссылки на них заменены детерминированно
// (scripts/anonymize.ts), id/plan_id → "0".
// Запуск (офлайн, по уже снятым файлам): node scripts/sanitize-ui-refs.ts
import { readFile } from "node:fs/promises";
import { anonymizeEditorIds, anonymizeProjectIds, writeFixture } from "./anonymize.ts";

const NAMES = ["room", "door", "window", "roomname", "sofa"] as const;

const SOURCE =
  "Серверная модель project.copy(\"server\") анонимного проекта remplanner.ru " +
  "(создан кнопкой «Нарисовать чертежи своими руками» в чистом browser context, аккаунт не использовался): " +
  "прямоугольник 400×300 см нарисован мышью (scripts/probe-normalize.ts, режим refs, etalon v0.1.0, коммит 29fbd07, 15.11.2026), " +
  "далее по сценарию скрипта — дверь/окно/диван/имя помещения «Гостиная» через UI. " +
  "Runtime-дампы верхнего уровня (walls, items, rooms1, rooms2) удалены — тесты не проверяют их; " +
  "формат модели берите из copy. ID проекта/плана и внутренние ID стен, комнат, проёмов, предметов " +
  "заменены на синтетические детерминированно (scripts/anonymize.ts); геометрия не менялась.";

for (const name of NAMES) {
  const path = `tests/fixtures/ui-ref-${name}.json`;
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (typeof raw["_source"] === "string" && raw["_source"].includes("anonymize.ts")) {
    console.log("уже обезличен, пропуск:", path);
    continue;
  }
  const copy = raw["copy"] as Record<string, unknown>;
  if (!copy || typeof copy !== "object") throw new Error(`в ${path} нет copy`);
  const { data, map } = anonymizeEditorIds(copy);
  const size = await writeFixture(path, { copy: anonymizeProjectIds(data as Record<string, unknown>) }, SOURCE);
  console.log(`${path}: заменено ID ${map.size}, ${size} байт`);
}
