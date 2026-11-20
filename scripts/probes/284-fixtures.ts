// 284 (веха 1): обезличенные эталоны проводов/шин/коллекторов конструктора щитка
// из живых проб (copy("server") после действий обработчиков портов редактора).
// node --experimental-strip-types scripts/probes/284-fixtures.ts build
import { readFileSync, writeFileSync } from "node:fs";
import { anonymizeEditorIds } from "../../scripts/anonymize.ts";

if (process.argv[2] !== "build") {
  console.error("запуск по явному аргументу: … build");
  process.exit(0);
}

const src = (name: string) => JSON.parse(readFileSync(`.orca-reports/tmp/${name}`, "utf8"));

// Эталон 1: провода модуль→модуль (фаза, ноль) и модуль→ввод (земля) —
// 284-wire-matrix: Shield.add_module ×3 + module_port_click ×2 (инструменты
// shield_wire_phase/null/earth), connected портов пересчитан редактором.
const wires = src("284-matrix-wires.json");
const a1 = anonymizeEditorIds({ shields: structuredClone(wires) }, "id");
writeFileSync("tests/fixtures/ui-ref-shield-wires.json", JSON.stringify({
  _source: "Живая проба scripts/probes/284-wire-matrix.ts (dev-проект из env, без сохранения): лист «Электрощиток», щиток с DIN-рейкой и 3 модулями (Shield.add_module — код постановки UI), провода через обработчик клика портов (module_port_click, тот же код, что клик UI): фаза модуль→модуль, ноль модуль→модуль, земля модуль→ввод. Формат ShieldWire {id, id_source, id_target, type, thickness, is_broken} (ShieldWire.serialize бандла app.3.0). Идентификаторы обезличены (scripts/anonymize.ts); привязка shield_id к предмету заменена на id-метку.",
  ...(a1.data as Record<string, unknown>),
}, null, 1) + "\n");

// Эталон 2: шина (busbar) и провод модуль→порт шины — 284-bus2: init_bus_slots +
// bus_slot_mouseover/mousemove/mousedown (те же обработчики слотов, что UI),
// затем module_port_click до порта шины; bus.connection вычислен редактором.
const bus = src("284-bus2-final.json");
const a2 = anonymizeEditorIds({ shields: structuredClone(bus) }, "id");
writeFileSync("tests/fixtures/ui-ref-shield-bus.json", JSON.stringify({
  _source: "Живая проба scripts/probes/284-bus2.ts (dev-проект из env, без сохранения): шина через обработчики слотов шин (bus_slot_mouseover → add_bus_start, bus_slot_mousemove → add_bus_move, bus_slot_mousedown → add_bus_end — те же обработчики, что клики UI), провод shield_wire_phase модуль→порт шины. ShieldBus {id, type (позиция T/B + L/C/R), connection, distance, ports[6 {id, parent_id, parent_type: \"bus\", connected}]}. Идентификаторы обезличены (scripts/anonymize.ts). Эталон для следующего PR (шины/коллекторы); в этом PR MCP их не пишет.",
  ...(a2.data as Record<string, unknown>),
}, null, 1) + "\n");

// Эталон 3: коллектор — 284-wire-matrix: add_collector_start + add_collector_end.
const collector = src("284-matrix-collector.json");
const a3 = anonymizeEditorIds({ shields: structuredClone(collector) }, "id");
writeFileSync("tests/fixtures/ui-ref-shield-collector.json", JSON.stringify({
  _source: "Живая проба scripts/probes/284-wire-matrix.ts (dev-проект из env, без сохранения): коллектор через обработчики портов (add_collector_start + add_collector_end с картой модулей — код пути UI). ShieldCollector {id, rail_id, module_width, modules {moduleId: moduleId}, position: \"T\"|\"B\"}. Внимание: в пробе коллектор с одним модулем (редактор удаляет такой в validate_collectors при следующей операции) — эталон ФОРМАТА, не валидного состояния. Идентификаторы обезличены (scripts/anonymize.ts). Эталон для следующего PR (шины/коллекторы).",
  ...(a3.data as Record<string, unknown>),
}, null, 1) + "\n");

console.log("fixtures written");
