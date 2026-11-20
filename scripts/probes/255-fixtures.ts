// 255 (веха 1): обезличенные эталоны конструктора щитка из проб разведки.
// node --experimental-strip-types scripts/probes/255-fixtures.ts build
import { readFileSync, writeFileSync } from "node:fs";
import { anonymizeEditorIds } from "../../scripts/anonymize.ts";

if (process.argv[2] !== "build") {
  console.error("запуск по явному аргументу: … build");
  process.exit(0);
}

// Эталон 1: пустой щиток (рейка + ввод) — UI-проба 255-shield-scout (лист «Электрощиток»)
const full = JSON.parse(readFileSync(".orca-reports/tmp/255-shield-full.json", "utf8"));
const a1 = anonymizeEditorIds({ shields: structuredClone(full.shields) }, "id");
writeFileSync("tests/fixtures/ui-ref-shield-empty.json", JSON.stringify({
  _source: "UI-проба scripts/probes/255-shield-scout.ts (dev-проект из env, без сохранения): лист «Электрощиток», щиток-предмет electric_shield (item_add у стены), клик по щитку открывает конструктор, инструмент «Провод фазный» создаёт щиток с DIN-рейкой и вводом (порты фаза/ноль/земля). Идентификаторы обезличены (scripts/anonymize.ts); привязка shield_id к предмету заменена на id-метку.",
  ...a1.data,
}, null, 1) + "\n");

// Эталон 2: рейка с модулем — сериализация редактора (Shield.add_module + Shield.serialize,
// проба в dev-проекте из env, без сохранения)
const mod = JSON.parse(readFileSync(".orca-reports/tmp/255-module-classes.json", "utf8"));
const a2 = anonymizeEditorIds({ shields: { s1: mod.serializeAll } }, "id");
writeFileSync("tests/fixtures/ui-ref-shield-module.json", JSON.stringify({
  _source: "Эталон сериализации редактора (бандл app.3.0, класс Shield.serialize; проба в dev-проекте из env без сохранения: SHIELDS.restore + $ShieldBuilder.add_rail_to_shield + Shield.add_module «Автомат. выключатель»): щиток с DIN-рейкой и одним автоматом (subtype 16A по умолчанию, group_number 0, ports ×2, custom {}). Идентификаторы обезличены (scripts/anonymize.ts).",
  ...a2.data,
}, null, 1) + "\n");
console.log("fixtures written");
