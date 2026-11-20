// 291 (веха 1): обновление эталона коллектора по живому дампу (проба
// 291-shield3-ui3, copy("server") после drag коллектора по портам модулей).
// Поправка эталона 284: в живой форме ShieldCollector.modules — {moduleId: 1}
// (число), а не {moduleId: moduleId}, как было снято в 284-wire-matrix вручную
// собранной картой (наблюдение ревью 285 без номера).
// node --experimental-strip-types scripts/probes/291-fixtures.ts build
import { readFileSync, writeFileSync } from "node:fs";
import { anonymizeEditorIds } from "../../scripts/anonymize.ts";

if (process.argv[2] !== "build") {
  console.error("запуск по явному аргументу: … build");
  process.exit(0);
}

const src = (name: string) => JSON.parse(readFileSync(`.orca-reports/tmp/${name}`, "utf8"));

// Эталон: коллектор (4 модуля по 1 DIN, подряд на рейке 0) + шина TC (6 гнёзд,
// distance 157.5) — те же обработчики, что клик/drag UI: шина — bus_slot_*,
// коллектор — module_port_click_collector (клик порта источника → hover портами
// промежуточных модулей → клик порта конца).
const data = src("293-after-collector.json");
const a = anonymizeEditorIds({ shields: structuredClone(data) }, "id");
writeFileSync("tests/fixtures/ui-ref-shield-collector.json", JSON.stringify({
  _source: "Живая проба scripts/probes/291-shield3-ui3.ts (dev-проект из env, без сохранения): коллектор через module_port_click_collector (клик порта модуля-источника → hover портами модулей 2..4 → клик порта последнего — те же обработчики, что drag UI), шина через bus_slot_mouseover/mousemove/mousedown (инструмент shield_busbar, слоты над щитком). ShieldCollector {id, rail_id, module_width, modules {moduleId: 1}, position: \"T\"|\"B\"} — в живой форме значения карты равны 1 (в эталоне 284 карта была собрана вручную с id-значениями — исправлено). ShieldBus {id, type (T/B + L/C/R), ports[6], connection, distance} — width_bus = 6×гнёзд+12 (дамп .orca-reports/tmp/294-busfactory.json), TC distance 157.5. Идентификаторы обезличены (scripts/anonymize.ts).",
  ...(a.data as Record<string, unknown>),
}, null, 1) + "\n");

console.log("fixture written");
