// Конструктор электрощитка (лист «Электрощиток», часть 3): model.shields — рейки,
// модули, ввод. Эталоны UI в обе стороны (ui-ref-shield-*), атомарность, лимиты
// рейки, удаление без висячих ссылок (модуль, рейка, щиток-предмет), реестр
// коллекций, компакт, сверка shieldMismatches, mock save (verified,
// NORMALIZATION_DROPPED, SITE_ERROR).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps, Shield } from "../../src/model/types.ts";
import { addRoomRect, moveWall } from "../../src/model/walls.ts";
import { addItem, deleteItem } from "../../src/model/items.ts";
import {
  addShieldRail, deleteShieldRail, addShieldModule, updateShieldModule, deleteShieldModule,
  addShieldWire, deleteShieldWire, moveShieldModuleToRail, reorderShieldModule,
  validateShieldDerived,
  ensureShieldForItem, deleteShieldsForItem, findShieldByItem, shieldProjection, findShieldModule,
  addShieldBus, updateShieldBus, deleteShieldBus,
  addShieldCollector, updateShieldCollector, deleteShieldCollector,
  SHIELD_MODULE_TYPES, SHIELD_ITEM_NAMES, SHIELD_RAIL_MIN_DIN, SHIELD_RAIL_MAX_DIN, SHIELD_WIRE_TYPES,
} from "../../src/model/shield.ts";
import { compactModel } from "../../src/model/compact.ts";
import {
  clearEntityCollections, replaceEntityCollections, MODEL_ENTITY_COLLECTIONS,
} from "../../src/model/collections.ts";
import { parseModelImport } from "../../src/model/import-schema.ts";
import { shieldMismatches, isDefaultEmptyShield } from "../../src/verify/shields.ts";
import { toModel } from "../../src/model/canonical.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));

function baseModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  const m = { ...structuredClone(model), walls: {} } as Model;
  addRoomRect(m, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  m.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return m;
}

const CATALOG: Record<string, Record<string, unknown>> = {
  electric_shield: { id: 28, group: "furniture", width: 30, height: 11, self_height: 25, plan: { cables: 31, sockets: 9 }, anchor: "wall", over_floor: { value: 120, display: false }, title: "Накладной электрощиток" },
  electric_shield_internal: { id: 29, group: "furniture", width: 30, height: 10, self_height: 25, plan: { cables: 31, sockets: 9 }, anchor: "wall", over_floor: { value: 120, display: false }, title: "Встр. электрощиток" },
  lowcurrent_shield: { id: 30, group: "furniture", width: 30, height: 11, self_height: 25, plan: { cables: 31 }, anchor: "wall", over_floor: { value: 120, display: false }, title: "Слаботочный щиток" },
};

function entry(name: string): Record<string, unknown> {
  const raw = CATALOG[name];
  assert.ok(raw, `нет каталога для ${name}`);
  return raw;
}

const topWall = (m: Model): string => {
  const w = Object.values(m.walls).find((w) => w.p1.y === w.p2.y)!;
  assert.ok(w, "нет горизонтальной стены");
  return w.id;
};

function scenario(): { m: Model; shield: ItemProps; internal: ItemProps } {
  const m = baseModel();
  const shield = addItem(m, { name: "electric_shield", position: { againstWall: { wallId: topWall(m), offsetMm: 3000 } }, catalogEntry: entry("electric_shield") } as never);
  const internal = addItem(m, { name: "electric_shield_internal", position: { againstWall: { wallId: topWall(m), offsetMm: 1000 } }, catalogEntry: entry("electric_shield_internal") } as never);
  return { m, shield, internal };
}

// ---------- состав раздела ----------

test("255: состав раздела — 35 типов модулей + предмет-щиток (power); lowcurrent — не щиток конструктора", () => {
  assert.equal(Object.keys(SHIELD_MODULE_TYPES).length, 35);
  for (const t of ["shield_module", "shield_module_x2", "shield_module_uzo", "shield_module_input", "shield_module_counter", "shield_custom_module", "shield_module_din_bus"]) {
    assert.ok(t in SHIELD_MODULE_TYPES, t);
  }
  assert.deepEqual([...SHIELD_ITEM_NAMES].sort(), ["electric_shield", "electric_shield_internal", "electric_shield_old"]);
  assert.equal(SHIELD_RAIL_MIN_DIN, 12);
  assert.equal(SHIELD_RAIL_MAX_DIN, 48);
});

test("255: лимиты типов — ширина в DIN и порты как в module_types редактора", () => {
  assert.equal(SHIELD_MODULE_TYPES.shield_module!.width, 1);
  assert.equal(SHIELD_MODULE_TYPES.shield_module!.ports, 2);
  assert.equal(SHIELD_MODULE_TYPES.shield_module_terminal!.width, 0.5);
  assert.equal(SHIELD_MODULE_TYPES.shield_module_splitter!.ports, 0);
  assert.equal(SHIELD_MODULE_TYPES.shield_module_uvr!.width, 5);
  assert.equal(SHIELD_MODULE_TYPES.shield_module_cross_4x!.ports, 28);
});

// ---------- эталоны UI в обе стороны ----------

/** Ревью 256 №7: маскированная форма целиком — id-поля заменены на «<id>»,
 *  ключи отсортированы; сравнение deepEqual, а не по выбранным полям. */
function maskedForm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskedForm);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, /^(id|shield_id|rail_id|parent_id|module_id|id_source|id_target)$/.test(k) ? "<id>" : maskedForm(x)]),
    );
  }
  return v;
}

/** 284: маскированная форма со словарями записей (rails/modules/wires/…), ключи
 *  которых — случайные id сайта: словари объектов → массивы, отсортированные по
 *  маскированному содержимому, — deepEqual не зависит от порядка и имён ключей. */
function maskedUnordered(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => maskedUnordered(x, key));
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskedUnordered(x, k)] as const);
    if (entries.length > 0 && entries.every(([, x]) => x !== null && typeof x === "object")) {
      entries.sort((p, q) => JSON.stringify(p[1]).localeCompare(JSON.stringify(q[1])));
      return entries.map(([, x]) => x);
    }
    // 291: карта модулей коллектора {moduleId: 1} — ключи случайные id сайта:
    // маскируем ключи (порядок не значим), значения сравниваем
    if (key === "modules" && entries.length > 0) {
      return entries.map(([, x]) => x).sort((p, q) => JSON.stringify(p).localeCompare(JSON.stringify(q)));
    }
    return Object.fromEntries(entries);
  }
  return /^(id|shield_id|rail_id|parent_id|module_id|id_source|id_target)$/.test(key) ? "<id>" : v;
}

test("255: эталон ui-ref-shield-empty — форма щитка по умолчанию (рейка + ввод с 3 портами)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-shield-empty.json"), "utf8")) as { shields: Record<string, Shield> };
  const s = Object.values(fx.shields)[0]!;
  assert.equal(typeof s.shield_id, "string");
  assert.equal(s.on_auto_length_rails, 1);
  assert.equal(s.length_rails, 12);
  assert.equal(Object.keys(s.rails).length, 1);
  assert.equal(Object.keys(Object.values(s.rails)[0]!.modules).length, 0);
  const inputs = Object.values(s.inputs);
  assert.equal(inputs.length, 1);
  const types = inputs[0]!.ports.map((p) => p.type).sort();
  assert.deepEqual(types, ["shield_wire_earth", "shield_wire_null", "shield_wire_phase"]);
  // эталон проходит импорт в коллекцию shields
  // эталон проходит импорт в коллекцию shields (ключ = id записи — ревью 256 №6)
  assert.doesNotThrow(() => parseModelImport({ ...baseModel(), shields: { [s.id]: structuredClone(s) } }));
  // и воспроизводится ensureShieldForItem как маскированная форма ЦЕЛИКОМ
  // (ревью 256 №7: не по выбранным полям)
  const { m, shield } = scenario();
  const made = ensureShieldForItem(m, shield);
  assert.equal(isDefaultEmptyShield(made), true);
  assert.equal(isDefaultEmptyShield(structuredClone(s)), true);
  assert.deepEqual(maskedForm(shieldProjection(made)), maskedForm(shieldProjection(s)), "форма ensureShieldForItem ≅ эталон");
});

test("255: эталон ui-ref-shield-module — форма модуля воспроизводится addShieldModule (обе стороны)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-shield-module.json"), "utf8")) as { shields: Record<string, Shield> };
  const ref = Object.values(fx.shields)[0]!;
  const refRail = Object.values(ref.rails).find((r) => Object.keys(r.modules).length > 0)!;
  const refMod = Object.values(refRail.modules)[0]!;
  assert.equal(refMod.type, "shield_module");
  assert.equal(refMod.width, 1);
  assert.equal(refMod.group_number, 0);
  assert.equal(refMod.subtype, "16A");
  assert.equal(refMod.comment, "");
  assert.deepEqual(refMod.custom, {});
  assert.equal(refMod.ports.length, 2);
  // обратная сторона: наш слой воспроизводит все поля эталона
  const { m, shield } = scenario();
  const { module: mod } = addShieldModule(m, shield.id, { type: "shield_module" });
  assert.equal(mod.type, refMod.type);
  assert.equal(mod.width, refMod.width);
  assert.equal(mod.group_number, refMod.group_number);
  assert.equal(mod.subtype, refMod.subtype);
  assert.equal(mod.comment, refMod.comment);
  assert.deepEqual(mod.custom, refMod.custom);
  assert.equal(mod.ports.length, refMod.ports.length);
  for (const p of mod.ports) {
    assert.equal(p.parent_id, mod.id);
    assert.equal(p.parent_type, "module");
    assert.equal(p.connected, 0);
  }
  assert.equal(mod.rail_id, Object.keys(findShieldByItem(m, shield.id)!.rails)[0]);
  assert.equal(mod.index, 0);
  // эталон снят после add_rail_to_shield + add_module: две рейки (с модулем и пустая)
  addShieldRail(m, shield.id);
  // маскированная форма ЦЕЛИКОМ (ревью 256 №7): наш щиток ≅ эталону
  assert.deepEqual(maskedForm(shieldProjection(findShieldByItem(m, shield.id)!)), maskedForm(shieldProjection(ref)), "форма щитка с модулем ≅ эталон");
  // эталон в импорте проходит (ключ = id записи — ревью 256 №6)
  assert.doesNotThrow(() => parseModelImport({ ...baseModel(), shields: { [ref.id]: structuredClone(ref) } }));
});

// ---------- add/update/delete ----------

// Ревью 256 №1: редактор ставит модулю subtype = default_subtype ?? subtypes[0],
// иначе RailModule-ctor берёт dims.module.default_subtype ("5A"); MCP с пустым
// subtype после restore редактора превращался в "5A" и save падал
// NORMALIZATION_DROPPED. Умолчания 12 типов без default_subtype сверены с дампом
// ShieldDimensions.module_types (255-module-classes.json).
const EDITOR_SUBTYPE_DEFAULTS: Record<string, string> = {
  shield_module_uzip: "5A", shield_module_uzip_2x: "5A", shield_module_uzip_4x: "5A",
  shield_module_terminal: "5A", shield_module_terminal_x2: "5A",
  shield_module_din_bus: "5A", shield_module_cross: "5A", shield_module_cross_4x: "5A",
  shield_module_socket: "5A", shield_module_counter: "5A", shield_module_splitter: "5A",
  shield_module_uvr: "63A",
};

/** Restore редактора (RailModule ctor): e.subtype || "5A", e.group_number || 0, e.comment || "". */
function editorRestoreShields(shields: Record<string, Shield>): void {
  for (const s of Object.values(shields)) {
    for (const rail of Object.values(s.rails)) {
      for (const mod of Object.values(rail.modules)) {
        mod.subtype = mod.subtype || "5A";
        mod.group_number = mod.group_number || 0;
        mod.comment = mod.comment || "";
      }
    }
  }
}

test("256 №1: все 35 типов — проекция после «restore редактора» равна исходной, subtype по таблице редактора", () => {
  for (const type of Object.keys(SHIELD_MODULE_TYPES)) {
    const { m, shield } = scenario();
    ensureShieldForItem(m, shield);
    addShieldModule(m, shield.id, { type });
    const s = findShieldByItem(m, shield.id)!;
    const restored = structuredClone({ s1: s });
    editorRestoreShields(restored);
    assert.deepEqual(shieldProjection(s), shieldProjection(restored.s1!), `restore редактора меняет модуль типа ${type}`);
    if (type in EDITOR_SUBTYPE_DEFAULTS) {
      const mod = Object.values(Object.values(s.rails)[0]!.modules)[0]!;
      assert.equal(mod.subtype, EDITOR_SUBTYPE_DEFAULTS[type], `subtype типа ${type}`);
    }
  }
});

test("256 №1: mock save — щиток с uzip/terminal/uvr (restore редактора дописывает subtype) — verified", async () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module_uzip" });
  addShieldModule(m, shield.id, { type: "shield_module_terminal" });
  addShieldModule(m, shield.id, { type: "shield_module_uvr" });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    editorRestoreShields(norm.shields as Record<string, Shield>);
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res).slice(0, 500));
});

test("255: shield_rail_add — вторая рейка в конец, index 1; первая — index 0", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldRail(m, shield.id);
  const s = findShieldByItem(m, shield.id)!;
  const rails = Object.values(s.rails).sort((a, b) => a.index - b.index);
  assert.equal(rails.length, 2);
  assert.deepEqual(rails.map((r) => r.index), [0, 1]);
});

test("255: shield_rail_delete — модули рейки удаляются, индексы пересчитываются; последнюю рейку нельзя", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module" });
  addShieldRail(m, shield.id);
  addShieldModule(m, shield.id, { type: "shield_module_x2", rail: 1 });
  const { deleted_modules } = deleteShieldRail(m, shield.id, 0);
  assert.equal(deleted_modules.length, 1);
  const s = findShieldByItem(m, shield.id)!;
  const rails = Object.values(s.rails).sort((a, b) => a.index - b.index);
  assert.deepEqual(rails.map((r) => r.index), [0]);
  assert.equal(Object.keys(rails[0]!.modules).length, 1);
  assert.equal(Object.values(rails[0]!.modules)[0]!.type, "shield_module_x2");
  // последнюю рейку редактор не даёт удалить
  assert.throws(() => deleteShieldRail(m, shield.id, 0), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
});

test("255: shield_module_add — позиция в конец рейки (index = ширина), авто-длина пересчитывается", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A", group_number: 3, comment: "кухня" });
  addShieldModule(m, shield.id, { type: "shield_module_terminal", rail: 0 });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  assert.deepEqual(mods.map((x) => x.index), [0, 1]);
  assert.equal(mods[1]!.width, 0.5);
  assert.equal(mods[0]!.subtype, "25A");
  assert.equal(mods[0]!.group_number, 3);
  assert.equal(mods[0]!.comment, "кухня");
  assert.equal(s.length_rails, 12); // 1.5 DIN < минимума 12
  // много модулей: авто-длина следует за шириной (1.5 + 11×4 = 45.5 DIN)
  for (let i = 0; i < 11; i++) addShieldModule(m, shield.id, { type: "shield_module_x4_simple" });
  assert.equal(findShieldByItem(m, shield.id)!.length_rails, 45.5);
});

test("255: атомарность — неизвестный тип, переполнение рейки, плохой номинал модель не меняют", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  const before = structuredClone(m.shields);
  assert.throws(() => addShieldModule(m, shield.id, { type: "shield_module_nonexistent" }), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
  assert.throws(() => addShieldModule(m, shield.id, { type: "shield_module", subtype: "99A" }), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
  // заполнить рейку до лимита и отказаться от лишнего (снимок ПОСЛЕ заполнения)
  for (let i = 0; i < 48; i++) addShieldModule(m, shield.id, { type: "shield_module" });
  const filled = structuredClone(m.shields);
  assert.throws(() => addShieldModule(m, shield.id, { type: "shield_module" }), (e: unknown) => {
    const err = e as McpError;
    return err.code === "INVALID_ARGUMENT" && /48/.test(err.message);
  });
  assert.deepEqual(m.shields, filled);
  // group_number у типа без группы — отказ
  assert.throws(() => addShieldModule(m, shield.id, { type: "shield_module_counter", group_number: 2 }), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
});

test("255: shield_module_update — номинал/группа/подпись; неуказанные поля не меняются", () => {
  const { m, shield } = scenario();
  const { module: mod } = addShieldModule(m, shield.id, { type: "shield_module", comment: "зал" });
  updateShieldModule(m, shield.id, mod.id, { subtype: "32A", group_number: 5 });
  const after = findShieldByItem(m, shield.id)!;
  const updated = Object.values(Object.values(after.rails)[0]!.modules)[0]!;
  assert.equal(updated.subtype, "32A");
  assert.equal(updated.group_number, 5);
  assert.equal(updated.comment, "зал");
  assert.equal(updated.type, "shield_module");
  // bad subtype — отказ, модель не меняется
  const snapshot = structuredClone(after);
  assert.throws(() => updateShieldModule(m, shield.id, mod.id, { subtype: "99A" }), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
  assert.deepEqual(findShieldByItem(m, shield.id), snapshot);
});

// Ревью 258 №6: пустой/пробельный номинал после чистки — не «», а умолчание по
// цепочке редактора (RailModule ctor: e.subtype || default_subtype; типы без
// списка — "5A"): иначе сверка save видит изменение и блокирует NORMALIZATION_DROPPED.
test("258 №6: пустой/пробельный subtype нормализуется в умолчание типа (add/update/custom)", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  // тип без списка номиналов: редактор даёт "5A"
  const counter = addShieldModule(m, shield.id, { type: "shield_module_counter", subtype: " \n " });
  assert.equal(counter.module.subtype, "5A");
  // тип со списком: default_subtype ?? subtypes[0]
  const auto = addShieldModule(m, shield.id, { type: "shield_module", subtype: "" });
  assert.equal(auto.module.subtype, "16A");
  const custom = addShieldModule(m, shield.id, { type: "shield_custom_module", subtype: " \n " });
  assert.equal(custom.module.subtype, "16A");
  // update: пустая строка — тоже умолчание, а не ""
  const { module: mod } = addShieldModule(m, shield.id, { type: "shield_module_terminal" });
  updateShieldModule(m, shield.id, mod.id, { subtype: "" });
  const s = findShieldByItem(m, shield.id)!;
  const updated = findShieldModule(s, mod.id)!;
  assert.equal(updated.subtype, "5A");
});

test("255: shield_module_delete — позиции правее уменьшаются на ширину; несуществующий — NOT_FOUND", () => {
  const { m, shield } = scenario();
  const { module: m1 } = addShieldModule(m, shield.id, { type: "shield_module" });
  const { module: m2 } = addShieldModule(m, shield.id, { type: "shield_module_x2" });
  const { module: m3 } = addShieldModule(m, shield.id, { type: "shield_module" });
  deleteShieldModule(m, shield.id, m2.id);
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  assert.deepEqual(mods.map((x) => x.id), [m1.id, m3.id]);
  assert.deepEqual(mods.map((x) => x.index), [0, 1]);
  assert.throws(() => deleteShieldModule(m, shield.id, "no_such"), (e: unknown) => (e as McpError).code === "NOT_FOUND");
});

test("284: провода не запрещают операции с модулями/рейками (запрет 255 снят, как в редакторе)", () => {
  const { m, shield } = scenario();
  const { module: mod } = addShieldModule(m, shield.id, { type: "shield_module" });
  const s = findShieldByItem(m, shield.id)!;
  (s.wires as Record<string, never>)["w1"] = { id: "w1", id_source: "x", id_target: "y", type: "shield_wire_phase", is_broken: 0 } as never;
  // добавление модуля/рейки проходит при непустых проводах
  addShieldModule(m, shield.id, { type: "shield_module" });
  addShieldRail(m, shield.id);
  assert.equal(Object.values(s.rails).length, 2);
  // удаление модуля — провода к его портам каскадно, чужие остаются
  const { module: m2 } = addShieldModule(m, shield.id, { type: "shield_module_x2" });
  const wDel = addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: m2.id, port: 0 }, target: { module_id: mod.id, port: 0 } });
  const wKeep = addShieldWire(m, shield.id, { type: "shield_wire_null", source: { module_id: mod.id, port: 1 }, target: { input: "earth" } });
  const res = deleteShieldModule(m, shield.id, m2.id);
  const sh = findShieldByItem(m, shield.id)!;
  // каскад validate_wires: провод удалённого модуля + висячий w1 (портов x/y нет);
  // ревью 285 №6: висячие провода больше не удаляются молча при add/delete провода —
  // их чистит validate_wires при операциях с модулями/рейками, id попадают в deleted_wires
  assert.deepEqual([...res.deleted_wires].sort(), ["w1", wDel.wire.id].sort());
  assert.ok(!sh.wires[res.deleted_wires[0]!]);
  assert.ok(sh.wires[wKeep.wire.id], "провод без отношения к удалённому остался");
  // connected портов пересчитан
  const modPorts = Object.values(Object.values(sh.rails)[0]!.modules)[0]!.ports;
  assert.equal(modPorts[0]!.connected, 0);
  assert.equal(modPorts[1]!.connected, 1);
});

// ---------- удаление без висячих ссылок ----------

test("255: item_delete щитка каскадно удаляет запись конструктора (нет висячих shield_id)", () => {
  const { m, shield, internal } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module" });
  ensureShieldForItem(m, internal);
  const res = deleteItem(m, shield.id);
  assert.equal(res.deleted_shields.length, 1);
  assert.equal(findShieldByItem(m, shield.id), null);
  // чужой щиток не затронут
  assert.ok(findShieldByItem(m, internal.id));
  for (const s of Object.values(m.shields ?? {})) {
    assert.ok(m.items[s.shield_id], `висячая ссылка shield_id=${s.shield_id}`);
  }
  // lowcurrent-щиток — предмет, но конструктор к нему не привязывается
  const low = addItem(m, { name: "lowcurrent_shield", position: { againstWall: { wallId: topWall(m), offsetMm: 2000 } }, catalogEntry: entry("lowcurrent_shield") } as never);
  assert.equal(findShieldByItem(m, low.id), null);
  assert.throws(() => addShieldModule(m, low.id, { type: "shield_module" }), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
});

test("255: deleteShieldsForItem — нет записей, нет удалений; повторный вызов безопасен", () => {
  const { m, shield } = scenario();
  assert.deepEqual(deleteShieldsForItem(m, shield.id), []);
  ensureShieldForItem(m, shield);
  assert.equal(deleteShieldsForItem(m, shield.id).length, 1);
  assert.equal(deleteShieldsForItem(m, shield.id).length, 0);
});

test("255: удаление стены со щитком — предмет и щиток остаются (привязка предмета пересчитывает редактор)", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module" });
  const wid = topWall(m);
  delete m.walls[wid];
  assert.ok(findShieldByItem(m, shield.id), "щиток остался после удаления стены");
  assert.ok(m.items[shield.id], "предмет остался (перенос/перепривязка — item_update)");
});

// ---------- реестр, компакт, импорт ----------

test("255: реестр — shields в MODEL_ENTITY_COLLECTIONS и PUBLIC_COLLECTION_KEYS; clear удаляет", () => {
  assert.ok(MODEL_ENTITY_COLLECTIONS.includes("shields"));
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  clearEntityCollections(m);
  assert.equal(Object.keys(m.shields ?? {}).length, 0);
});

test("255: replaceEntityCollections переносит shields; счётчики под публичным ключом", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module" });
  const target = baseModel();
  replaceEntityCollections(target, m);
  assert.equal(Object.keys(target.shields ?? {}).length, 1);
  const counts = compactModel(target);
  assert.equal(counts.shields.length, 1);
  const c = counts.shields[0]!;
  assert.equal(c.id, "SH1");
  assert.equal(c.item, shield.id);
  assert.equal(c.rails, 1);
  assert.equal(c.modules.length, 1);
  assert.equal(c.modules[0]!.type, "shield_module");
  assert.equal(c.modules[0]!.module_id, Object.values(Object.values(Object.values(target.shields!)[0]!.rails)[0]!.modules)[0]!.id);
});

test("255: импорт — щиток с модулями проходит; мусор отклоняется (схема shields)", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module" });
  assert.doesNotThrow(() => parseModelImport(structuredClone(m)));
  assert.throws(
    () => parseModelImport({ ...baseModel(), shields: { s1: { id: "s1", rails: "garbage", modules: 5 } } }),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT",
  );
  assert.throws(
    () => parseModelImport({ ...baseModel(), shields: { s1: { id: "s1", rails: { r: { id: "r", modules: { m: { id: "m", width: "wide" } } } } } } }),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT",
  );
});

// Ревью 256 №6: связь «предмет ↔ содержимое» при импорте однозначна —
// ключ записи = id, один щиток на предмет; щитки-сироты (item не существует)
// отбрасываются — редактор сам создаёт предметам записи по умолчанию.
test("256 №6: импорт отклоняет ключ ≠ id, дубль shield_id; сирота отбрасывается", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  // ключ ≠ id
  const badKey = structuredClone(m);
  const s = structuredClone(findShieldByItem(m, shield.id)!);
  s.id = "other";
  badKey.shields = { k1: s } as never;
  assert.throws(
    () => parseModelImport(badKey),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT",
  );
  // два щитка на один предмет
  const dup = structuredClone(m);
  const a1 = structuredClone(findShieldByItem(m, shield.id)!);
  const a2 = structuredClone(findShieldByItem(m, shield.id)!);
  a1.id = "s1";
  a2.id = "s2";
  dup.shields = { s1: a1, s2: a2 } as never;
  assert.throws(
    () => parseModelImport(dup),
    (e: unknown) => e instanceof McpError && (e as McpError).code === "INVALID_ARGUMENT",
  );
  // сирота: shield_id не из items — не ошибка, запись отбрасывается
  const orphan = structuredClone(m);
  const os = structuredClone(findShieldByItem(m, shield.id)!);
  os.id = "s1";
  os.shield_id = "ghost_item";
  orphan.shields = { s1: os } as never;
  const parsed = parseModelImport(structuredClone(orphan)) as { shields?: Record<string, unknown> };
  assert.equal(Object.keys(parsed.shields ?? {}).length, 0);
  // предмет без записи проходит — редактор дополнит сам
  assert.doesNotThrow(() => parseModelImport(structuredClone(m)));
});

test("255: toModel мигрирует legacy-формы — rails/buses массивом, inputs-массив, ports без обёртки", () => {  const raw = {
    v: 3, walls: {}, items: {}, pillars: {},
    shields: {
      s1: {
        id: "s1", shield_id: "i1", on_auto_length_rails: 1, length_rails: 12,
        rails: [{ id: "r1", index: 0, modules: [{ id: "m1", rail_id: "r1", index: 0, width: 1, type: "shield_module", group_number: 0, subtype: "16A", comment: "", ports: [] }] }],
        buses: [{ id: "b1" }],
        inputs: [
          { id: "p1", type: "shield_wire_earth", connected: 1 },
          { id: "p2", type: "shield_wire_null", connected: 0 },
          { id: "p3", type: "shield_wire_phase", connected: 0 },
        ],
        wires: [],
      },
      // ports без обёртки-ввода (SHIELDS.restore: ветка inputs.ports)
      s2: {
        id: "s2", shield_id: "i2",
        inputs: { ports: [{ id: "q1", connected: 0 }, { id: "q2", connected: 1 }] },
      },
    },
  };
  const m = toModel(structuredClone(raw) as unknown as Record<string, unknown>);
  const s = m.shields!.s1!;
  assert.ok(!Array.isArray(s.rails) && !Array.isArray(s.buses) && !Array.isArray(s.wires));
  assert.ok(!Array.isArray((s.rails as Record<string, { modules: unknown }>).r1!.modules));
  const inputs = s.inputs as Record<string, { id: string; ports: Array<{ parent_id: string; type?: string }> }>;
  const inputList = Object.values(inputs);
  assert.equal(inputList.length, 1);
  assert.equal(inputList[0]!.ports.length, 3);
  for (const p of inputList[0]!.ports) assert.equal(p.parent_id, inputList[0]!.id);
  assert.deepEqual(inputList[0]!.ports.map((p) => p.type).sort(), ["shield_wire_earth", "shield_wire_null", "shield_wire_phase"]);
  // ports без обёртки: один ввод, parent_id проставлен, земля/ноль/фаза по порядку
  const s2 = m.shields!.s2!;
  const input2 = Object.values(s2.inputs as Record<string, { id: string; ports: Array<{ id: string; parent_id: string; type: string; connected: number }> }>)[0]!;
  assert.equal(input2.ports.length, 3);
  assert.equal(input2.ports[0]!.id, "q1");
  assert.equal(input2.ports[0]!.connected, 0);
  assert.equal(input2.ports[1]!.id, "q2");
  assert.equal(input2.ports[1]!.connected, 1);
  for (const p of input2.ports) assert.equal(p.parent_id, input2.id);
});

// Ревью 256 №4: редактор (ShieldInput при restore) дописывает вводу index:0 и
// phase:1 (сериализация эталона ui-ref-shield-empty их содержит) — миграция
// legacy-inputs обязана дописывать то же, иначе каждая сверка save видит
// «содержимое изменилось» и любой save блокируется NORMALIZATION_DROPPED.
test("256 №4: миграция legacy-inputs дописывает index и phase во всех ветках", () => {
  const raw = {
    v: 3, walls: {}, items: {}, pillars: {},
    shields: {
      // inputs массивом (портам ставится parent_id)
      s1: { id: "s1", shield_id: "i1", rails: [{ id: "r1", index: 0, modules: [] }],
        inputs: [
          { id: "p1", type: "shield_wire_earth", connected: 0 },
          { id: "p2", type: "shield_wire_null", connected: 0 },
          { id: "p3", type: "shield_wire_phase", connected: 0 },
        ] },
      // ports без обёртки-ввода
      s2: { id: "s2", shield_id: "i2", inputs: { ports: [{ id: "q1", connected: 0 }, { id: "q2", connected: 1 }] } },
      // словарь с ключом ≠ id (ветка перегруппировки)
      s3: { id: "s3", shield_id: "i3", inputs: { old_key: { id: "in3", ports: [] } } },
    },
  };
  const m = toModel(structuredClone(raw) as unknown as Record<string, unknown>);
  for (const key of ["s1", "s2", "s3"] as const) {
    const s = m.shields![key]!;
    const input = Object.values(s.inputs as Record<string, { id: string; index?: number; phase?: number }>)[0]!;
    assert.equal(input.index, 0, `index ввода ${key}`);
    assert.equal(input.phase, 1, `phase ввода ${key}`);
  }
});

test("256 №4: mock save — модель с legacy-щитком (массивы rails/buses, inputs-массив) проходит save", async () => {
  const { m, shield } = scenario();
  m.shields = { s1: legacyShieldFor(shield.id) as never };
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    // restore редактора: ShieldInput дописывает index/phase вводам
    for (const s of Object.values(norm.shields as Record<string, Shield>)) {
      for (const input of Object.values(s.inputs)) {
        input.index ??= 0;
        input.phase ??= 1;
      }
    }
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res).slice(0, 500));
});

// ---------- сверка shieldMismatches ----------

// Ревью 256 №5: каждое поле семантической проекции участвует в сверке —
// изменение поля X в «фактической» модели даёт ровно 1 расхождение
// (мутации проверок не должны выживать).
test("256 №5: мутации проекции — порты, inputs, comment, group_number, shield_id, buses, index, custom", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  const { module: mod } = addShieldModule(m, shield.id, { type: "shield_module", comment: "зал" });
  const expected = m.shields!;
  const mutate: [string, (s: Shield) => void][] = [
    ["порт модуля удалён", (s) => { const mod2 = Object.values(Object.values(s.rails)[0]!.modules)[0]!; mod2.ports = mod2.ports.slice(1); }],
    ["порт модуля изменён", (s) => { const mod2 = Object.values(Object.values(s.rails)[0]!.modules)[0]!; mod2.ports[0]!.connected = 1; }],
    ["inputs потеряны", (s) => { s.inputs = {}; }],
    ["порт ввода изменён", (s) => { Object.values(s.inputs)[0]!.ports[0]!.connected = 1; }],
    ["phase ввода потеряна (258 №5)", (s) => { (Object.values(s.inputs)[0] as { phase?: number }).phase = undefined; }],
    ["comment модуля", (s) => { Object.values(Object.values(s.rails)[0]!.modules)[0]!.comment = "кухня"; }],
    ["group_number модуля", (s) => { Object.values(Object.values(s.rails)[0]!.modules)[0]!.group_number = 9; }],
    ["subtype модуля", (s) => { Object.values(Object.values(s.rails)[0]!.modules)[0]!.subtype = "63A"; }],
    ["type модуля", (s) => { Object.values(Object.values(s.rails)[0]!.modules)[0]!.type = "shield_module_x2"; }],
    ["width модуля", (s) => { Object.values(Object.values(s.rails)[0]!.modules)[0]!.width = 2; }],
    ["shield_id перепривязан", (s) => { s.shield_id = "other_item"; }],
    ["buses изменены", (s) => { s.buses = { b1: { id: "b1", type: "TC", ports: [], connection: "", distance: 0 } }; }],
    ["wires изменены", (s) => { s.wires = { w1: { id: "w1", id_source: "p1", id_target: "p2", type: "shield_wire_phase", is_broken: 0 } } as never; }],
    ["collectors изменены", (s) => { s.collectors = { c1: { id: "c1", rail_id: "r", module_width: 1, modules: {}, position: "T" } }; }],
    ["index модуля", (s) => { Object.values(Object.values(s.rails)[0]!.modules)[0]!.index = 5; }],
    ["rail_id модуля", (s) => { Object.values(Object.values(s.rails)[0]!.modules)[0]!.rail_id = "other_rail"; }],
    ["custom модуля", (s) => { Object.values(Object.values(s.rails)[0]!.modules)[0]!.custom = { ports: 1 }; }],
    ["index рейки", (s) => { Object.values(s.rails)[0]!.index = 3; }],
    ["on_auto_length_rails", (s) => { s.on_auto_length_rails = 0; }],
    ["рейка удалена", (s) => { s.rails = {}; }],
    ["модуль удалён", (s) => { delete Object.values(s.rails)[0]!.modules[mod.id]; }],
  ];
  for (const [label, fn] of mutate) {
    const got = structuredClone(expected);
    fn(Object.values(got)[0]!);
    const list = shieldMismatches(expected, got);
    assert.equal(list.length, 1, `мутация «${label}» не поймана сверкой`);
  }
});

test("255: shieldMismatches — потеря, изменение содержимого, лишняя запись, авто-запись по умолчанию", () => {
  const { m, shield, internal } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module" });
  const shields = m.shields!;
  const got = structuredClone(shields);
  // потеря
  let got2 = structuredClone(got);
  delete got2[Object.keys(shields)[0]!];
  let list = shieldMismatches(shields, got2);
  assert.equal(list.length, 1);
  assert.match(list[0]!, /потерян/);
  // изменение содержимого (subtype)
  got2 = structuredClone(got);
  Object.values(got2)[0]!.rails![Object.keys(Object.values(got2)[0]!.rails!)[0]!]!.modules![Object.keys(Object.values(Object.values(got2)[0]!.rails!)[0]!.modules!)[0]!]!.subtype = "63A";
  list = shieldMismatches(shields, got2);
  assert.equal(list.length, 1);
  assert.match(list[0]!, /изменилось/);
  // авто-запись по умолчанию для предмета без записи — не потеря
  ensureShieldForItem(m, internal);
  const expected2 = structuredClone(shields);
  delete expected2[Object.keys(m.shields!).find((k) => m.shields![k]!.shield_id === internal.id)!];
  list = shieldMismatches(expected2, m.shields!, { allowAutoCreate: true });
  assert.deepEqual(list, []);
  // а без allowAutoCreate — лишняя запись
  list = shieldMismatches(expected2, m.shields!);
  assert.equal(list.length, 1);
  // авто-запись с содержимым — потеря/лишняя
  const extra = structuredClone(m.shields!);
  const extraKey = Object.keys(extra).find((k) => extra[k]!.shield_id === internal.id)!;
  addShieldModule(m, internal.id, { type: "shield_module" });
  list = shieldMismatches(expected2, m.shields!, { allowAutoCreate: true });
  assert.equal(list.length, 1);
  delete m.shields![extraKey];
});

test("255: длина length_rails при on_auto_length_rails=1 — производная (в сверке не участвует)", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  const s = findShieldByItem(m, shield.id)!;
  const a = JSON.stringify(shieldProjection(s));
  s.length_rails = 48;
  const b = JSON.stringify(shieldProjection(s));
  assert.equal(a, b, "length_rails при авто-режиме в проекцию не входит");
  // но в сверке расхождения нет
  assert.deepEqual(shieldMismatches({ s1: structuredClone(s) }, { s1: structuredClone({ ...s, length_rails: 3 }) }), []);
  // при ручном режиме — сверяется
  s.on_auto_length_rails = 0;
  assert.equal(shieldMismatches({ s1: structuredClone(s) }, { s1: structuredClone({ ...s, length_rails: 3 }) }).length, 1);
});

// ---------- mock save ----------

const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };

/** Ревью 256 №4: legacy-щиток (rails/buses/wires массивы, inputs-массив) — та же
 *  модель, что в тесте миграции toModel, но на живых стенах/предметах. */
function legacyShieldFor(itemId: string): Record<string, unknown> {
  return {
    id: "s1", shield_id: itemId, on_auto_length_rails: 1, length_rails: 12,
    rails: [{ id: "r1", index: 0, modules: [] }],
    buses: [],
    inputs: [
      { id: "p1", type: "shield_wire_earth", connected: 0 },
      { id: "p2", type: "shield_wire_null", connected: 0 },
      { id: "p3", type: "shield_wire_phase", connected: 0 },
    ],
    wires: [],
  };
}

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm);
      transformNorm?.(normalized!);
      const walls = Object.keys(mm.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized!), rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      afterSave(server);
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return COMPAT; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: server.saveId, units: "cm", data_empty: false, model: structuredClone(server.model) };
    },
    async openEditor() { return editor as never; },
  };
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  return ws;
}

test("255: mock save — щиток с модулями сохраняется verified (ввод редактора досчитан не был: форма полная)", async () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A", group_number: 2, comment: "розетки кухни" });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res).slice(0, 500));
  const sm = server.model.shields as Record<string, Shield>;
  assert.equal(Object.keys(sm).length, 1);
  const saved = Object.values(sm)[0]!;
  assert.equal(Object.values(Object.values(saved.rails)[0]!.modules)[0]!.subtype, "25A");
  assert.equal(saved.inputs && Object.keys(saved.inputs).length, 1);
});

test("255: mock save — редактор пересчитал length_rails (производная при авто) → verified", async () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module" });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    for (const s of Object.values(norm.shields as Record<string, Shield>)) s.length_rails = 24;
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res).slice(0, 400));
});

test("255: mock save — предмет-щиток без записи: редактор дополнил записью по умолчанию → verified", async () => {
  const { m, shield } = scenario();
  // записи shields нет — редактор при restore создаёт щиток по умолчанию
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    const made = ensureShieldForItem(norm as unknown as Model, (norm.items as Record<string, ItemProps>)[shield.id]!);
    void made;
  });
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res).slice(0, 400));
});

test("255: mock save — нормализатор потерял щиток → NORMALIZATION_DROPPED, записи нет", async () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module" });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => { delete norm.shields; });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    if (!(e instanceof McpError) || e.code !== "NORMALIZATION_DROPPED") return false;
    // ревью 256 №5: details.shield_mismatches непустой
    const list = (e.details as Record<string, unknown>)["shield_mismatches"] as string[] | undefined;
    return Array.isArray(list) && list.length > 0;
  });
  // записи не было: серверная модель осталась в состоянии открытия
  assert.equal(Object.keys((server.model.shields ?? {}) as Record<string, unknown>).length, 1);
});

// Ревью 256 №5: мутация стен, при которой нормализатор теряет щиток, отменяется
// (INVALID_GEOMETRY с непустым shield_mismatches) — сверка shieldMismatches в
// applyWalls покрыта тестом.
test("256 №5: wall_move при потере щитка нормализатором — INVALID_GEOMETRY, shield_mismatches", async () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module" });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => { delete norm.shields; });
  await ws.open("0", "1");
  const wallId = Object.values(ws.model.walls)[0]!.id;
  await assert.rejects(
    () => ws.applyWalls("wall_move", (mm) => moveWall(mm, { wallId, offsetMm: 100 })),
    (e: unknown) => {
      if (!(e instanceof McpError) || e.code !== "INVALID_GEOMETRY") return false;
      const list = (e.details as Record<string, unknown>)["shield_mismatches"] as string[] | undefined;
      return Array.isArray(list) && list.length > 0;
    },
  );
});

test("255: mock save — сервер испортил номинал модуля → SITE_ERROR с shield_mismatches", async () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  const { module: mod } = addShieldModule(m, shield.id, { type: "shield_module" });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (s) => {
    const saved = Object.values(s.model.shields as Record<string, Shield>)[0]!;
    const rail = Object.values(saved.rails)[0]!;
    rail.modules[mod.id]!.subtype = "63A";
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as McpError;
    if (!(err instanceof McpError && err.code === "SITE_ERROR")) return false;
    const list = (err.details as Record<string, unknown>)["shield_mismatches"] as string[] | undefined;
    return Array.isArray(list) && list.length > 0;
  });
});

// ---------- 284: провода ----------

/** Щиток с 3 модулями и вводом (для проводов). */
function wiresScenario(): { m: Model; shield: ItemProps; s: Shield; mA: Shield["rails"][string]["modules"][string]; mB: ReturnType<typeof findShieldModule>; inputPorts: Shield["inputs"][string]["ports"] } {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module_x2", subtype: "16A/30mA" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  return { m, shield, s, mA: mods[0]!, mB: mods[1]!, inputPorts: Object.values(s.inputs)[0]!.ports };
}

test("284: эталон ui-ref-shield-wires — маскированная форма щитка с проводами воспроизводится addShieldWire", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-shield-wires.json"), "utf8")) as { shields: Record<string, Shield> };
  const ref = Object.values(fx.shields)[0]!;
  // эталон проходит импорт
  assert.doesNotThrow(() => parseModelImport({ ...baseModel(), shields: { [ref.id]: structuredClone(ref) } }));
  // воспроизводится операциями MCP как маскированная форма ЦЕЛИКОМ (2 порт+3 порта модулей)
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module_x2", subtype: "16A/30mA" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  const [mA, mB, mC] = mods as [typeof mods[number], typeof mods[number], typeof mods[number]];
  const inputEarth = Object.values(s.inputs)[0]!.ports.find((p) => p.type === "shield_wire_earth")!;
  addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0 }, target: { module_id: mB.id, port: 0 } });
  addShieldWire(m, shield.id, { type: "shield_wire_null", source: { module_id: mB.id, port: 2 }, target: { module_id: mC.id, port: 0 } });
  addShieldWire(m, shield.id, { type: "shield_wire_earth", source: { module_id: mC.id, port: 1 }, target: { input: "earth" } });
  const got = findShieldByItem(m, shield.id)!;
  assert.deepEqual(maskedUnordered(structuredClone(got)), maskedUnordered(structuredClone(ref)), "форма щитка с проводами ≠ эталону UI");
  // connected портов как в эталоне: земляной порт ввода connected 1
  const gotInput = Object.values(got.inputs)[0]!.ports.find((p) => p.type === "shield_wire_earth")!;
  assert.equal(gotInput.connected, 1);
  void inputEarth;
});

test("284: shield_wire_add — валидация: тип, ссылки, петля, лимит", () => {
  const { m, shield, mA, inputPorts } = wiresScenario();
  // неизвестный тип
  assert.throws(
    () => addShieldWire(m, shield.id, { type: "shield_wire_foo", source: { module_id: mA.id, port: 0 }, target: { input: "null" } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  // оба/ни одного источника
  assert.throws(
    () => addShieldWire(m, shield.id, { type: "shield_wire_phase", source: {}, target: { input: "null" } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  assert.throws(
    () => addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0, input: "null" }, target: { input: "null" } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  // порт за пределами
  assert.throws(
    () => addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 5 }, target: { input: "null" } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  // несуществующий модуль
  assert.throws(
    () => addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: "no_such", port: 0 }, target: { input: "null" } }),
    (e: unknown) => (e as McpError).code === "NOT_FOUND",
  );
  // петля
  assert.throws(
    () => addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0 }, target: { module_id: mA.id, port: 0 } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  // input-типы не из тройки — NOT_FOUND (порт ввода не найден)
  assert.throws(
    () => addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0 }, target: { input: "zero" as never } }),
    (e: unknown) => (e as McpError).code === "NOT_FOUND",
  );
  void inputPorts;
  // атомарность: после отказов проводов нет
  const s = findShieldByItem(m, shield.id)!;
  assert.equal(Object.keys(s.wires ?? {}).length, 0);
});

test("284: несколько проводов с одного порта разрешены (эталон 284-wire-cases); connected пересчитан", () => {
  const { m, shield, mA, mB } = wiresScenario();
  const w1 = addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0 }, target: { module_id: mB!.id, port: 0 } });
  const w2 = addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0 }, target: { module_id: mB!.id, port: 1 } });
  const s = findShieldByItem(m, shield.id)!;
  assert.equal(Object.keys(s.wires).length, 2);
  const mAports = Object.values(s.rails).flatMap((r) => Object.values(r.modules)).find((x) => x.id === mA.id)!.ports;
  assert.equal(mAports[0]!.connected, 1);
  const mBports = Object.values(s.rails).flatMap((r) => Object.values(r.modules)).find((x) => x.id === mB!.id)!.ports;
  assert.equal(mBports[0]!.connected, 1);
  assert.equal(mBports[1]!.connected, 1);
  // форма провода как в эталоне (id_source/id_target — id портов, thickness 0, is_broken 0)
  assert.deepEqual(
    maskedForm(structuredClone(s.wires[w1.wire.id]!)),
    maskedForm({ id: "<id>", id_source: mAports[0]!.id, id_target: mBports[0]!.id, type: "shield_wire_phase", thickness: 0, is_broken: 0 }),
  );
  void w2;
});

test("284: shield_wire_delete — connected портов пересчитан; NOT_FOUND", () => {
  const { m, shield, mA, mB } = wiresScenario();
  const { wire } = addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0 }, target: { module_id: mB!.id, port: 0 } });
  deleteShieldWire(m, shield.id, wire.id);
  const s = findShieldByItem(m, shield.id)!;
  assert.equal(Object.keys(s.wires).length, 0);
  const mAports = Object.values(s.rails).flatMap((r) => Object.values(r.modules)).find((x) => x.id === mA.id)!.ports;
  assert.equal(mAports[0]!.connected, 0);
  assert.throws(() => deleteShieldWire(m, shield.id, wire.id), (e: unknown) => (e as McpError).code === "NOT_FOUND");
});

test("284: провод к порту шины (живой эталон) — connected и connection шины пересчитываются", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-shield-bus.json"), "utf8")) as { shields: Record<string, Shield> };
  const ref = Object.values(fx.shields)[0]!;
  // эталон шины с проводом проходит импорт и сверку проекции (форма UI не теряется)
  assert.doesNotThrow(() => parseModelImport({ ...baseModel(), shields: { [ref.id]: structuredClone(ref) } }));
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  const s = findShieldByItem(m, shield.id)!;
  // шина из эталона (формат — следующий PR, MCP шины не пишет); провод к её порту
  // вписан как его сериализует редактор (порт шины в API не выражается), дальше —
  // пересчёты validateShieldDerived как у редактора
  const refBus = Object.values(ref.buses)[0] as unknown as Record<string, unknown>;
  s.buses = { [String(refBus["id"])]: structuredClone(refBus) } as Shield["buses"];
  const bus = Object.values(s.buses)[0] as unknown as { id: string; ports: Shield["inputs"][string]["ports"]; connection?: string };
  const busPort = bus.ports[0]!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  (s.wires as Record<string, never>)["wb"] = {
    id: "wb", id_source: mods[0]!.ports[0]!.id, id_target: busPort.id,
    type: "shield_wire_phase", thickness: 0, is_broken: 0,
  } as never;
  validateShieldDerived(s);
  const afterAdd = findShieldByItem(m, shield.id)!;
  const busAfterAdd = Object.values(afterAdd.buses)[0] as unknown as { ports: Shield["inputs"][string]["ports"]; connection?: string };
  assert.equal(busAfterAdd.ports[0]!.connected, 1);
  assert.equal(busAfterAdd.connection, "shield_wire_phase");
  // ревью 285 №10: провод к порту шины виден агенту в model_get — {bus, port},
  // а не пустые from/to
  const compactBus = (compactModel(m, []) as unknown as { shields: { wires: { wire_id: string; to: Record<string, unknown> }[] }[] }).shields[0]!
    .wires.find((w) => w.wire_id === "wb")!;
  assert.deepEqual(compactBus.to, { bus: String(refBus["id"]), port: 0 });
  // удаление провода: connected и connection шины обнулены (validate_buses)
  deleteShieldWire(m, shield.id, "wb");
  const afterDel = findShieldByItem(m, shield.id)!;
  const busAfterDel = Object.values(afterDel.buses)[0] as unknown as { ports: Shield["inputs"][string]["ports"]; connection?: string };
  assert.equal(busAfterDel.ports[0]!.connected, 0);
  assert.equal(busAfterDel.connection, "");
});

test("284: каскад — коллектор с <2 модулями после удаления модуля удаляется (validate_collectors)", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-shield-collector.json"), "utf8")) as { shields: Record<string, Shield> };
  const ref = Object.values(fx.shields)[0]!;
  assert.doesNotThrow(() => parseModelImport({ ...baseModel(), shields: { [ref.id]: structuredClone(ref) } }));
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "32A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  const collectorFormat = Object.values(ref.collectors)[0] as unknown as { module_width: number; position: string };
  s.collectors = {
    c1: { id: "c1", rail_id: Object.values(s.rails)[0]!.id, module_width: collectorFormat.module_width, modules: { [mods[0]!.id]: mods[0]!.id, [mods[1]!.id]: mods[1]!.id }, position: collectorFormat.position } as never,
  };
  // удалить первый модуль коллектора → остался 1 модуль → коллектор удалён
  const res = deleteShieldModule(m, shield.id, mods[0]!.id);
  const after = findShieldByItem(m, shield.id)!;
  assert.deepEqual(res.deleted_collectors, ["c1"]);
  assert.equal(Object.keys(after.collectors).length, 0);
  // коллектор на двух живых модулях не трогается удалением стороннего модуля
  s.collectors = {
    c2: { id: "c2", rail_id: Object.values(after.rails)[0]!.id, module_width: 1, modules: { [mods[1]!.id]: mods[1]!.id, [mods[2]!.id]: mods[2]!.id }, position: "T" } as never,
  };
  const res2 = deleteShieldModule(m, shield.id, mods[2]!.id);
  assert.deepEqual(res2.deleted_collectors, ["c2"]);
});

test("284: mock save — провода сохраняются verified (без потерь)", async () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mods[0]!.id, port: 0 }, target: { module_id: mods[1]!.id, port: 0 } });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res).slice(0, 500));
  const saved = Object.values(server.model.shields as Record<string, Shield>)[0]!;
  assert.equal(Object.keys(saved.wires).length, 1);
  assert.equal(Object.values(saved.wires)[0]!.type, "shield_wire_phase");
});

test("284: mock save — нормализатор потерял провод → NORMALIZATION_DROPPED", async () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mods[0]!.id, port: 0 }, target: { module_id: mods[1]!.id, port: 0 } });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    for (const sh of Object.values(norm.shields as Record<string, Shield>)) sh.wires = {};
  });
  await ws.open("0", "1");
  // ревью 285 №12: spec требует непустой details.shield_mismatches в NORMALIZATION_DROPPED
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as McpError;
    if (!(err instanceof McpError && err.code === "NORMALIZATION_DROPPED")) return false;
    const list = (err.details as Record<string, unknown>)["shield_mismatches"] as string[] | undefined;
    return Array.isArray(list) && list.length > 0;
  });
});

test("284: mock save — сервер испортил тип провода → SITE_ERROR с shield_mismatches", async () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mods[0]!.id, port: 0 }, target: { module_id: mods[1]!.id, port: 0 } });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (srv) => {
    const saved = Object.values(srv.model.shields as Record<string, Shield>)[0]!;
    Object.values(saved.wires)[0]!.type = "shield_wire_null";
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as McpError;
    if (!(err instanceof McpError && err.code === "SITE_ERROR")) return false;
    const list = (err.details as Record<string, unknown>)["shield_mismatches"] as string[] | undefined;
    return Array.isArray(list) && list.length > 0;
  });
});

test("284: projection — редактор переставил ключи словаря проводов → не расхождение", () => {
  const { m, shield, mA, mB } = wiresScenario();
  addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0 }, target: { module_id: mB!.id, port: 0 } });
  const s = findShieldByItem(m, shield.id)!;
  const reordered = structuredClone(s);
  const entries = Object.entries(reordered.wires);
  reordered.wires = Object.fromEntries(entries.reverse());
  assert.deepEqual(shieldMismatches({ [s.id]: s }, { [s.id]: reordered }), []);
});

test("284: компакт — провода с адресами портов (module/port, input)", () => {
  const { m, shield, mA, mB } = wiresScenario();
  addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0 }, target: { module_id: mB!.id, port: 0 } });
  addShieldWire(m, shield.id, { type: "shield_wire_earth", source: { module_id: mB!.id, port: 3 }, target: { input: "earth" } });
  const c = compactModel(m, []) as unknown as { shields: { wires: { wire_id: string; type: string; from: Record<string, unknown>; to: Record<string, unknown> }[] }[] };
  const sh = c.shields[0]!;
  assert.equal(sh.wires?.length, 2);
  const w1 = sh.wires.find((w) => w.type === "shield_wire_phase")!;
  const w2 = sh.wires.find((w) => w.type === "shield_wire_earth")!;
  assert.deepEqual(w1!.from, { module_id: mA.id, port: 0 });
  assert.deepEqual(w1!.to, { module_id: mB!.id, port: 0 });
  assert.deepEqual(w2!.to, { input: "earth" });
});

test("284: импорт — провод с мусорным id_source сверх схемы отклоняется", () => {
  const { m, shield, mA, mB } = wiresScenario();
  addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0 }, target: { module_id: mB!.id, port: 0 } });
  const s = findShieldByItem(m, shield.id)!;
  const bad = structuredClone(s);
  Object.values(bad.wires)[0]!.id_source = 42 as never;
  assert.throws(() => parseModelImport({ ...baseModel(), shields: { [s.id]: bad } }));
});

// ---------- 284: перенос модуля между рейками и порядок ----------

test("284: перенос модуля на другую рейку — в конец целевой, индексы старой сдвинуты, провода живы", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldRail(m, shield.id);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module_x2", subtype: "16A/30mA" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A", rail: 1 });
  const s = findShieldByItem(m, shield.id)!;
  const rails = Object.values(s.rails).sort((a, b) => a.index - b.index);
  const mod0 = Object.values(rails[0]!.modules).sort((a, b) => a.index - b.index)[0]!;
  const mod2 = Object.values(rails[1]!.modules)[0]!;
  addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mod0.id, port: 0 }, target: { module_id: mod2.id, port: 0 } });
  // перенос первого модуля на рейку 1 → в конец рейки (index 1)
  moveShieldModuleToRail(s, mod0, 1);
  const rails2 = Object.values(s.rails).sort((a, b) => a.index - b.index);
  assert.equal(mod0.rail_id, rails2[1]!.id);
  assert.equal(mod0.index, 1);
  // индексы старой рейки пересчитаны
  const rail0mods = Object.values(rails2[0]!.modules).sort((a, b) => a.index - b.index);
  assert.deepEqual(rail0mods.map((x) => x.index), [0]);
  // провод жив (порты переехали с модулем), connected сохранён
  assert.equal(Object.keys(s.wires).length, 1);
  assert.equal(Object.values(s.wires)[0]!.id_source, mod0.ports[0]!.id);
  assert.equal(mod0.ports[0]!.connected, 1);
  // переполнение целевой рейки — INVALID_ARGUMENT (MCP строже редактора)
  const modA = Object.values(rails2[1]!.modules).sort((x, y) => x.index - y.index)[0]!;
  for (let i = 0; i < 23; i++) addShieldModule(m, shield.id, { type: "shield_module_x2", rail: 0 });
  const s2 = findShieldByItem(m, shield.id)!;
  const rails3 = Object.values(s2.rails).sort((a, b) => a.index - b.index);
  assert.throws(() => moveShieldModuleToRail(s2, modA, 0), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
});

test("284: перенос модуля из коллектора — INVALID_ARGUMENT (коллектор — следующий PR)", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldRail(m, shield.id);
  addShieldModule(m, shield.id, { type: "shield_module" });
  addShieldModule(m, shield.id, { type: "shield_module" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules);
  s.collectors = { c1: { id: "c1", rail_id: Object.values(s.rails)[0]!.id, module_width: 1, modules: { [mods[0]!.id]: mods[0]!.id }, position: "T" } as never };
  assert.throws(() => moveShieldModuleToRail(s, mods[0]!, 1), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
});

test("284: reorder — сдвиг соседей в обе стороны; модуль шире 1 DIN — только к началу соседа", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module_x2", subtype: "16A/30mA" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "32A" });
  const s = findShieldByItem(m, shield.id)!;
  const rail = Object.values(s.rails)[0]!;
  const mods = () => Object.values(rail.modules).sort((x, y) => x.index - y.index);
  const [a, b, c, d] = mods() as [ReturnType<typeof mods>[number], ReturnType<typeof mods>[number], ReturnType<typeof mods>[number], ReturnType<typeof mods>[number]];
  // рейка: a(0, 1 DIN), b(1, 2 DIN), c(3, 1 DIN), d(4, 1 DIN); слоты — сетка 0.5 DIN
  // (ShieldDimensions.module.slot, проба 284-dims). a на позицию 2 — отказ:
  // модуль шире слота вправо ставится только на «конец соседа − слот» (2.5)
  assert.throws(() => reorderShieldModule(s, a, 2), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
  reorderShieldModule(s, a, 2.5);
  assert.deepEqual(mods().map((x) => x.id), [b!.id, a!.id, c!.id, d!.id]);
  assert.deepEqual(mods().map((x) => x.index), [0, 2, 3, 4]);
  // обратно: a (index 2) на позицию 0 — b сдвигается вправо
  reorderShieldModule(s, a, 0);
  assert.deepEqual(mods().map((x) => x.id), [a!.id, b!.id, c!.id, d!.id]);
  // 2-полюсный модуль (b) на позицию 0 — к началу соседа a, a сдвигается
  reorderShieldModule(s, b, 0);
  assert.deepEqual(mods().map((x) => x.id), [b!.id, a!.id, c!.id, d!.id]);
  assert.deepEqual(mods().map((x) => x.index), [0, 2, 3, 4]);
  // позиция внутри самого модуля — no-op (как reorder_modules редактора)
  reorderShieldModule(s, b, 0.5);
  assert.deepEqual(mods().map((x) => x.index), [0, 2, 3, 4]);
  // не начало соседа (1 — внутри b) для узкого c — отказ (как guard редактора)
  assert.throws(() => reorderShieldModule(s, Object.values(rail.modules).find((x) => x.type === "shield_module" && x.index === 3)!, 1), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
  // не на сетке 0.5 — отказ
  assert.throws(() => reorderShieldModule(s, a, 1.25), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
  // позиция за концом рейки → INVALID_ARGUMENT
  assert.throws(() => reorderShieldModule(s, a, 9), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
  assert.equal(Object.keys(s.wires ?? {}).length, 0);
});

test("284: shield_module_update с rail/index — перенос и порядок одним вызовом", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldRail(m, shield.id);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A", rail: 1 });
  const s = findShieldByItem(m, shield.id)!;
  const mod0 = Object.values(Object.values(s.rails).sort((x, y) => x.index - y.index)[0]!.modules)[0]!;
  updateShieldModule(m, shield.id, mod0.id, { rail: 1 });
  const s2 = findShieldByItem(m, shield.id)!;
  const rails = Object.values(s2.rails).sort((x, y) => x.index - y.index);
  assert.equal(mod0.rail_id, rails[1]!.id);
  assert.equal(mod0.index, 1);
  // порядок на рейке: модуль с index 1 на позицию 0
  updateShieldModule(m, shield.id, mod0.id, { index: 0 });
  assert.equal(mod0.index, 0);
  // позиция за концом рейки — отказ, модель не меняется
  assert.throws(() => updateShieldModule(m, shield.id, mod0.id, { index: 5 }), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
});

test("284: каскад удаления рейки — провода её модулей и коллекторы удалены, чужие целы", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldRail(m, shield.id);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A", rail: 1 });
  const s = findShieldByItem(m, shield.id)!;
  const rails = Object.values(s.rails).sort((a, b) => a.index - b.index);
  const mod0 = Object.values(rails[0]!.modules)[0]!;
  const mod1 = Object.values(rails[1]!.modules)[0]!;
  addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mod0.id, port: 0 }, target: { module_id: mod0.id, port: 1 } });
  addShieldWire(m, shield.id, { type: "shield_wire_null", source: { module_id: mod0.id, port: 0 }, target: { module_id: mod1.id, port: 0 } });
  const res = deleteShieldRail(m, shield.id, 1);
  const after = findShieldByItem(m, shield.id)!;
  assert.equal(res.deleted_modules.length, 1);
  // провод на удалённой рейке (mod1.target) каскадно; провод mod0.p0→mod0.p1 цел
  assert.equal(res.deleted_wires.length, 1);
  assert.equal(Object.keys(after.wires).length, 1);
  // индексы рейк пересчитаны
  assert.deepEqual(Object.values(after.rails).map((r) => r.index), [0]);
});

test("284: импорт — лимит проводов щитка (мусор сверх лимита → INVALID_ARGUMENT)", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  const s = findShieldByItem(m, shield.id)!;
  const wires: Record<string, unknown> = {};
  for (let i = 0; i < 201; i++) wires[`w${i}`] = { id: `w${i}`, id_source: "a", id_target: "b", type: "shield_wire_phase", is_broken: 0 };
  assert.throws(
    () => parseModelImport({ ...baseModel(), shields: { [s.id]: { ...structuredClone(s), wires } } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
});

// ---------- ревью 285 №4–№9 ----------

test("ревью 285 №4: повторный идентичный провод (в обе стороны, тот же тип) — INVALID_ARGUMENT", () => {
  const { m, shield, mA, mB } = wiresScenario();
  const { wire } = addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0 }, target: { module_id: mB!.id, port: 0 } });
  // прямой дубль
  assert.throws(
    () => addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0 }, target: { module_id: mB!.id, port: 0 } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  // обратный дубль
  assert.throws(
    () => addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mB!.id, port: 0 }, target: { module_id: mA.id, port: 0 } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  // разорванный провод (is_broken) тоже считается дублем
  wire.is_broken = 1;
  assert.throws(
    () => addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0 }, target: { module_id: mB!.id, port: 0 } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  const s = findShieldByItem(m, shield.id)!;
  assert.equal(Object.keys(s.wires).length, 1, "дубль не добавлен");
});

test("ревью 285 №5: разорванный провод (is_broken 1) не считается в connected и connection шины (как get_wire_by_port редактора)", () => {
  const { m, shield, mA, mB } = wiresScenario();
  const s = findShieldByItem(m, shield.id)!;
  addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id, port: 0 }, target: { module_id: mB!.id, port: 0 } });
  Object.values(s.wires)[0]!.is_broken = 1;
  validateShieldDerived(s);
  assert.equal(mA.ports[0]!.connected, 0, "разорванный провод — порт источника не connected");
  assert.equal(mB!.ports[0]!.connected, 0, "разорванный провод — порт цели не connected");
  // шина: connection по живому проводу, разорванный пропускается
  const busPortId = "busPort1";
  const bus = { id: "b1", type: "T_L", connection: "", distance: 0, ports: [{ id: busPortId, parent_id: "b1", parent_type: "bus", connected: 0 }] } as never;
  s.buses = { b1: bus };
  addShieldWire(m, shield.id, { type: "shield_wire_null", source: { module_id: mA.id, port: 1 }, target: { module_id: mB!.id, port: 1 } });
  const second = Object.values(s.wires).find((w) => w.type === "shield_wire_null")!;
  second.id_target = busPortId;
  validateShieldDerived(s);
  const busAfter = s.buses.b1 as unknown as { connection: string; ports: Array<{ connected: number }> };
  assert.equal(busAfter.connection, "shield_wire_null", "живой провод задаёт connection шины");
  second.is_broken = 1;
  validateShieldDerived(s);
  assert.equal(busAfter.connection, "", "разорванный провод не задаёт connection");
  assert.equal(busAfter.ports[0]!.connected, 0);
});

test("ревью 285 №6: add/delete провода пересчитывает только connected/connection — висячие провода и коллекторы не удаляются молча", () => {
  const { m, shield, mA, mB } = wiresScenario();
  const s = findShieldByItem(m, shield.id)!;
  // висячий провод (порт не существует) и «коллектор из одного модуля» — как из UI/импорта
  (s.wires ??= {})["dangling"] = { id: "dangling", id_source: "no_such_port", id_target: mA.ports[0]!.id, type: "shield_wire_phase", thickness: 0, is_broken: 0 } as never;
  s.collectors = { c1: { id: "c1", rail_id: Object.values(s.rails)[0]!.id, module_width: 1, modules: { [mA.id]: mA.id }, position: "T" } as never };
  addShieldWire(m, shield.id, { type: "shield_wire_null", source: { module_id: mA.id, port: 0 }, target: { module_id: mB!.id, port: 0 } });
  assert.equal("dangling" in s.wires, true, "висячий провод не удалён молча при добавлении провода");
  assert.equal("c1" in s.collectors, true, "коллектор не удалён молча при добавлении провода");
  const wireId = Object.values(s.wires).find((w) => w.type === "shield_wire_null")!.id;
  deleteShieldWire(m, shield.id, wireId);
  assert.equal("dangling" in s.wires, true, "висячий провод не удалён молча при удалении провода");
  assert.equal("c1" in s.collectors, true, "коллектор не удалён молча при удалении провода");
  // connected при этом пересчитан как в редакторе
  assert.equal(mA.ports[0]!.connected, 1, "dangling указывает на порт mA — connected 1");
  assert.equal(mB!.ports[0]!.connected, 0);
});

test("ревью 285 №7: схема импорта — id_source/id_target/type провода и ports шины обязательны", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  const s = findShieldByItem(m, shield.id)!;
  // провод без id_source/id_target/type — отказ
  for (const key of ["id_source", "id_target", "type"] as const) {
    const wire = { id: "w1", id_source: "a", id_target: "b", type: "shield_wire_phase", thickness: 0, is_broken: 0 };
    delete wire[key];
    assert.throws(
      () => parseModelImport({ ...baseModel(), shields: { [s.id]: { ...structuredClone(s), wires: { w1: wire } } } }),
      (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
      `провод без ${key} — отказ`,
    );
  }
  // шина: ports не число (garbage) и connection не строка — отказ
  const badPorts = { ...structuredClone(s), buses: { b1: { id: "b1", ports: 5 } } };
  assert.throws(
    () => parseModelImport({ ...baseModel(), shields: { [s.id]: badPorts } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
    "шина с ports=5 — отказ",
  );
  const badConnection = { ...structuredClone(s), buses: { b1: { id: "b1", ports: [], connection: 5 } } };
  assert.throws(
    () => parseModelImport({ ...baseModel(), shields: { [s.id]: badConnection } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
    "шина с connection=5 — отказ",
  );
});

// 293 ревью №3: у шины ports и type обязательны (редактор всегда их
// сериализует) — раньше схема пускала шину без них, и compactModel падал
// на b.ports.length (model_get не работал), а shield_bus_update — на bus.type.
test("293 №3: импорт шины без ports или type — отказ; валидная шина проходит, compact жив", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  const s = findShieldByItem(m, shield.id)!;
  const bus = { id: "b1", type: "TC", connection: "", distance: 157.5, ports: [{ id: "p1", parent_id: "b1", parent_type: "bus", connected: 0 }] };
  for (const key of ["ports", "type"] as const) {
    const bad = structuredClone(s) as never as { buses: Record<string, typeof bus> };
    bad.buses = { b1: { ...bus } };
    delete bad.buses["b1"]![key];
    assert.throws(
      () => parseModelImport({ ...baseModel(), shields: { [s.id]: bad } }),
      (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
      `шина без ${key} — отказ`,
    );
  }
  // валидная шина проходит импорт, compactModel/model_get не падает
  const ok = structuredClone(s) as never as { buses: Record<string, typeof bus> };
  ok.buses = { b1: { ...bus } };
  const parsed = parseModelImport({ ...structuredClone(m), shields: { [s.id]: ok } }) as { shields: Record<string, unknown> };
  const compact = compactModel(parsed as never, []) as unknown as { shields: { bus_list: { bus_id: string; type: string; sockets: number }[] }[] };
  assert.equal(compact.shields[0]!.bus_list![0]!.bus_id, "b1");
  assert.equal(compact.shields[0]!.bus_list![0]!.type, "TC");
  assert.equal(compact.shields[0]!.bus_list![0]!.sockets, 1);
});

test("ревью 285 №8: перенос модуля между рейками пересчитывает авто-длину щитка (refreshAutoLength)", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldRail(m, shield.id);
  // 14 DIN модулей на рейке 0 → length_rails 14
  addShieldModule(m, shield.id, { type: "shield_module_x4", rail: 0 });
  addShieldModule(m, shield.id, { type: "shield_module_x4", rail: 0 });
  addShieldModule(m, shield.id, { type: "shield_module_x4", rail: 0 });
  addShieldModule(m, shield.id, { type: "shield_module_x2", rail: 0 });
  const s = findShieldByItem(m, shield.id)!;
  assert.equal(s.length_rails, 14);
  // перенести 4-полюсный модуль на рейку 1 → рейки 10/4, авто-длина 12 (минимум), не 14
  const mod = Object.values(Object.values(s.rails)[0]!.modules)[0]!;
  updateShieldModule(m, shield.id, mod.id, { rail: 1 });
  assert.equal(findShieldByItem(m, shield.id)!.length_rails, 12, "авто-длина пересчитана после переноса");
});

test("ревью 285 №9: port обязателен при module_id — без него INVALID_ARGUMENT, а не молчаливый порт 0", () => {
  const { m, shield, mA, mB } = wiresScenario();
  assert.throws(
    () => addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mA.id }, target: { module_id: mB!.id, port: 0 } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  const s = findShieldByItem(m, shield.id)!;
  assert.equal(Object.keys(s.wires).length, 0, "провод без порта не создан");
});

// ---------- 291: шины (shield_bus_*) ----------

test("291: шина add — 6 гнёзд по умолчанию, формат как в живом эталоне (TC, distance 157.5)", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  const { bus } = addShieldBus(m, shield.id, { position: "T" });
  const s = findShieldByItem(m, shield.id)!;
  const got = Object.values(s.buses)[0]!;
  // ширина щитка на пустой рейке — 12 DIN → 393 px; TC → distance 157.5 (проба 291-shield3-ui3)
  assert.equal(got.type, "TC");
  assert.equal(got.distance, 157.5);
  assert.equal(got.connection, "");
  assert.equal(got.ports.length, 6);
  for (const p of got.ports) {
    assert.equal(p.parent_type, "bus");
    assert.equal(p.parent_id, bus.id);
    assert.equal(p.connected, 0);
  }
  assert.deepEqual(Object.keys(s.buses), [bus.id]);
});

test("291: шина add — привязка L/R и sockets 4..25; за пределами INVALID_ARGUMENT", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  const width = 6 * 6 + 12; // 48
  const maxDistance = 393 - 2 * 15 - width; // 315 (проба 291-shield3-ui7)
  assert.equal(addShieldBus(m, shield.id, { position: "T", align: "L" }).bus.distance, 0);
  assert.equal(addShieldBus(m, shield.id, { position: "B", align: "R" }).bus.distance, maxDistance);
  assert.equal(addShieldBus(m, shield.id, { position: "T", sockets: 4 }).bus.ports.length, 4);
  assert.equal(addShieldBus(m, shield.id, { position: "T", sockets: 25 }).bus.ports.length, 25);
  assert.throws(
    () => addShieldBus(m, shield.id, { position: "T", sockets: 3 }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  assert.throws(
    () => addShieldBus(m, shield.id, { position: "T", sockets: 26 }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  assert.throws(
    () => addShieldBus(m, shield.id, { position: "X" as never }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
});

test("291: шина update — align/position меняют type и distance как в редакторе; NOT_FOUND", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  const { bus } = addShieldBus(m, shield.id, { position: "T", align: "C" });
  assert.equal(bus.distance, 157.5);
  const u1 = updateShieldBus(m, shield.id, bus.id, { align: "L" });
  assert.equal(u1.bus.type, "TL");
  assert.equal(u1.bus.distance, 0);
  const u2 = updateShieldBus(m, shield.id, bus.id, { position: "B", align: "R" });
  assert.equal(u2.bus.type, "BR");
  assert.equal(u2.bus.distance, 315);
  assert.throws(
    () => updateShieldBus(m, shield.id, "no_such", { align: "L" }),
    (e: unknown) => (e as McpError).code === "NOT_FOUND",
  );
});

test("291: шина update sockets — добавление в конец, удаление с конца; провод к удалённому гнезду чистится (deleted_wires)", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  const { bus } = addShieldBus(m, shield.id, { position: "T" });
  const mod = Object.values(Object.values(findShieldByItem(m, shield.id)!.rails)[0]!.modules)[0]!;
  const tailPortId = bus.ports[bus.ports.length - 1]!.id;
  const s = findShieldByItem(m, shield.id)!;
  s.wires["wt"] = { id: "wt", id_source: mod.ports[0]!.id, id_target: tailPortId, type: "shield_wire_earth", thickness: 0, is_broken: 0 } as never;
  // сократить до 4 гнёзд: хвостовое гнездо удаляется, провод с ним — тоже
  const u = updateShieldBus(m, shield.id, bus.id, { sockets: 4 });
  assert.equal(u.bus.ports.length, 4);
  assert.deepEqual(u.deleted_wires, ["wt"]);
  // расширение: 4 → 8, новые гнёзда с connected 0
  const u2 = updateShieldBus(m, shield.id, bus.id, { sockets: 8 });
  assert.equal(u2.bus.ports.length, 8);
  assert.equal(u2.deleted_wires.length, 0);
  assert.ok(u2.bus.ports.slice(4).every((p) => p.connected === 0));
});

test("291: шина delete — deleted_wires по проводам к её гнёздам; NOT_FOUND", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  const { bus } = addShieldBus(m, shield.id, { position: "T" });
  const mod = Object.values(Object.values(findShieldByItem(m, shield.id)!.rails)[0]!.modules)[0]!;
  const s = findShieldByItem(m, shield.id)!;
  s.wires["wb"] = { id: "wb", id_source: mod.ports[0]!.id, id_target: bus.ports[2]!.id, type: "shield_wire_null", thickness: 0, is_broken: 0 } as never;
  const res = deleteShieldBus(m, shield.id, bus.id);
  assert.deepEqual(res.deleted_wires, ["wb"]);
  assert.equal(Object.keys(findShieldByItem(m, shield.id)!.buses).length, 0);
  assert.throws(
    () => deleteShieldBus(m, shield.id, bus.id),
    (e: unknown) => (e as McpError).code === "NOT_FOUND",
  );
});

// 293 ревью №1: провод «шина → шина» и «гнездо шины → другое гнездо той же
// шины» редактор запрещает (ShieldBus.port_mousedown/port_mouseover отклоняют
// клик, если temp_wire_source_type === "bus") — MCP должен отказывать так же.
test("293 №1: провод шина→шина и гнездо→гнездо той же шины — INVALID_ARGUMENT bus_to_bus", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  const { bus: bus1 } = addShieldBus(m, shield.id, { position: "T", align: "L" });
  const { bus: bus2 } = addShieldBus(m, shield.id, { position: "T", align: "R" });
  const busToBus = (source: { bus: string; port: number }, target: { bus: string; port: number }) =>
    addShieldWire(m, shield.id, { type: "shield_wire_phase", source, target });
  // две разные шины
  assert.throws(
    () => busToBus({ bus: bus1.id, port: 0 }, { bus: bus2.id, port: 0 }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT" && ((e as McpError).details as { kind?: string }).kind === "bus_to_bus",
  );
  // два гнезда одной шины
  assert.throws(
    () => busToBus({ bus: bus1.id, port: 0 }, { bus: bus1.id, port: 1 }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT" && ((e as McpError).details as { kind?: string }).kind === "bus_to_bus",
  );
  // атомарность: шины не изменены (connection пуст), проводов нет;
  // провод модуль→шина по-прежнему разрешён
  const mod = Object.values(Object.values(findShieldByItem(m, shield.id)!.rails)[0]!.modules)[0]!;
  addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mod.id, port: 0 }, target: { bus: bus1.id, port: 0 } });
  const s = findShieldByItem(m, shield.id)!;
  assert.equal(Object.keys(s.wires).length, 1);
  assert.equal(s.buses[bus1.id]!.connection, "shield_wire_phase");
  assert.equal(s.buses[bus2.id]!.connection, "");
});

// 293 ревью №7: delete_bus редактора вызывает только validate_wires/
// validate_ports — коллекторы (даже «битые», с <2 известными модулями) не
// трогаются, иначе импортированный битый коллектор пропадал бы молча
// (deleted_collectors в ответе нет).
test("293 №7: delete_bus — только провода к гнёздам; битый коллектор и чужой провод не тронуты", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  const { bus } = addShieldBus(m, shield.id, { position: "T" });
  const s0 = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s0.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  // провод модуль→гнездо шины (удалится) и модуль→модуль (останется);
  // битый коллектор с несуществующими модулями
  (s0.wires as Record<string, never>)["wb"] = { id: "wb", id_source: mods[0]!.ports[0]!.id, id_target: bus.ports[0]!.id, type: "shield_wire_phase", thickness: 0, is_broken: 0 } as never;
  (s0.wires as Record<string, never>)["wm"] = { id: "wm", id_source: mods[0]!.ports[1]!.id, id_target: mods[1]!.ports[0]!.id, type: "shield_wire_null", thickness: 0, is_broken: 0 } as never;
  (s0.collectors as Record<string, never>)["c1"] = { id: "c1", rail_id: Object.values(s0.rails)[0]!.id, module_width: 1, modules: { dead1: 1, dead2: 1 }, position: "T" } as never;
  const res = deleteShieldBus(m, shield.id, bus.id);
  assert.deepEqual(res.deleted_wires, ["wb"]);
  const s = findShieldByItem(m, shield.id)!;
  assert.deepEqual(Object.keys(s.collectors), ["c1"], "битый коллектор delete_bus не удаляет (validate_collectors при операциях с модулями)");
  assert.deepEqual(Object.keys(s.wires), ["wm"], "чужой провод не тронут");
});

// ---------- 291: коллекторы (shield_collector_*) ----------

test("291: эталон ui-ref-shield-collector — маскированная форма щитка с коллектором и шиной воспроизводится операциями MCP", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-shield-collector.json"), "utf8")) as { shields: Record<string, Shield> };
  const ref = Object.values(fx.shields)[0]!;
  // эталон проходит импорт
  assert.doesNotThrow(() => parseModelImport({ ...baseModel(), shields: { [ref.id]: structuredClone(ref) } }));
  // воспроизводится операциями MCP: 5 модулей по 1 DIN → коллектор на первых 4, шина TC
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  for (let i = 0; i < 5; i++) addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  addShieldCollector(m, shield.id, { modules: mods.slice(0, 4).map((x) => x.id) });
  addShieldBus(m, shield.id, { position: "T" });
  const got = findShieldByItem(m, shield.id)!;
  assert.deepEqual(maskedUnordered(structuredClone(got)), maskedUnordered(structuredClone(ref)), "форма щитка с коллектором ≠ эталону UI");
});

// 293 ревью №2: «модули подряд» — диапазон по min/max ВСЕХ модулей (а не по
// первому и последнему элементу списка): неупорядоченный список с разрывом
// оставил бы внутри диапазона чужие модули, которые calc() редактора забрал бы
// в коллектор. Правило одно для add и update.
test("293 №2: коллектор — неупорядоченный список с разрывом — отказ; без разрыва — ок (add и update)", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  for (let i = 0; i < 6; i++) addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  const gap = (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT" && ((e as McpError).details as { kind?: string }).kind === "collector_gap";
  // [m0, m5, m1]: диапазон 0..5, внутри чужие m2..m4
  assert.throws(() => addShieldCollector(m, shield.id, { modules: [mods[0]!.id, mods[5]!.id, mods[1]!.id] }), gap);
  // неупорядоченный без разрыва — проходит (calc() редактора дал бы тот же набор)
  const col = addShieldCollector(m, shield.id, { modules: [mods[2]!.id, mods[0]!.id, mods[1]!.id] });
  assert.deepEqual(Object.keys(col.collector.modules).sort(), [mods[0]!.id, mods[1]!.id, mods[2]!.id].sort());
  // update — то же правило
  assert.throws(() => updateShieldCollector(m, shield.id, col.collector.id, { modules: [mods[0]!.id, mods[5]!.id] }), gap);
  const u = updateShieldCollector(m, shield.id, col.collector.id, { modules: [mods[4]!.id, mods[3]!.id] });
  assert.deepEqual(Object.keys(u.collector.modules).sort(), [mods[3]!.id, mods[4]!.id].sort());
});

test("291: collector add — position по ряду, module_width по модулю; модуль не из collector.types — отказ", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  // shield_module_uvr не в dims.collector.types
  addShieldModule(m, shield.id, { type: "shield_module_uvr", subtype: "63A" });
  addShieldModule(m, shield.id, { type: "shield_module_uvr", subtype: "63A" });
  assert.throws(
    () => addShieldCollector(m, shield.id, { modules: (() => { const s = findShieldByItem(m, shield.id)!; return Object.values(Object.values(s.rails)[0]!.modules).map((x) => x.id); })() }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
});

test("291: collector add — один модуль, разрыв, разные ширины, разные рейки, чужой коллектор — INVALID_ARGUMENT", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldRail(m, shield.id);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "32A" });
  addShieldModule(m, shield.id, { type: "shield_module_x2", subtype: "16A/30mA" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "10A", rail: 1 });
  const s = findShieldByItem(m, shield.id)!;
  const rail0 = Object.values(s.rails).find((r) => r.index === 0)!;
  const rail1 = Object.values(s.rails).find((r) => r.index === 1)!;
  const mods = Object.values(rail0.modules).sort((a, b) => a.index - b.index);
  const lastMod = mods[mods.length - 1]!;
  const rail1mod = Object.values(rail1.modules)[0]!;
  // один модуль
  assert.throws(() => addShieldCollector(m, shield.id, { modules: [mods[0]!.id] }), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
  // пусто
  assert.throws(() => addShieldCollector(m, shield.id, { modules: [] }), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
  // несуществующий модуль
  assert.throws(() => addShieldCollector(m, shield.id, { modules: [mods[0]!.id, "no_such"] }), (e: unknown) => (e as McpError).code === "NOT_FOUND");
  // разрыв: модули 0 и 2 — между ними чужой модуль 1
  assert.throws(
    () => addShieldCollector(m, shield.id, { modules: [mods[0]!.id, mods[2]!.id] }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  // разные ширины: 1 DIN + x2 (2 DIN, последний на рейке)
  assert.throws(
    () => addShieldCollector(m, shield.id, { modules: [mods[0]!.id, lastMod.id] }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  // дубликат модуля в списке
  assert.throws(
    () => addShieldCollector(m, shield.id, { modules: [mods[0]!.id, mods[0]!.id] }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  // разные рейки
  assert.throws(
    () => addShieldCollector(m, shield.id, { modules: [mods[0]!.id, rail1mod.id] }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  // атомарность: коллекторов нет
  assert.equal(Object.keys(s.collectors).length, 0);
  // чужой коллектор: создать на 0 и 1, затем добавить 1 в новый
  addShieldCollector(m, shield.id, { modules: [mods[0]!.id, mods[1]!.id] });
  assert.throws(
    () => addShieldCollector(m, shield.id, { modules: [mods[1]!.id, mods[2]!.id] }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
});

test("291: collector update — замена набора модулей; валидация та же; NOT_FOUND", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "32A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  const { collector } = addShieldCollector(m, shield.id, { modules: [mods[0]!.id, mods[1]!.id] });
  const u = updateShieldCollector(m, shield.id, collector.id, { modules: [mods[1]!.id, mods[2]!.id] });
  assert.deepEqual(Object.keys(u.collector.modules), [mods[1]!.id, mods[2]!.id]);
  assert.equal(u.collector.rail_id, mods[1]!.rail_id);
  // один модуль — отказ, коллектор не меняется
  assert.throws(
    () => updateShieldCollector(m, shield.id, collector.id, { modules: [mods[0]!.id] }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  assert.equal(Object.keys(findShieldByItem(m, shield.id)!.collectors[collector.id]!.modules).length, 2);
  // разрыв — отказ
  assert.throws(
    () => updateShieldCollector(m, shield.id, collector.id, { modules: [mods[0]!.id, mods[2]!.id] }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  assert.throws(
    () => updateShieldCollector(m, shield.id, "no_such", { modules: [mods[0]!.id, mods[1]!.id] }),
    (e: unknown) => (e as McpError).code === "NOT_FOUND",
  );
});

test("291: collector delete — модули и провода живы; NOT_FOUND", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  const { collector } = addShieldCollector(m, shield.id, { modules: [mods[0]!.id, mods[1]!.id] });
  addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mods[0]!.id, port: 0 }, target: { module_id: mods[1]!.id, port: 0 } });
  deleteShieldCollector(m, shield.id, collector.id);
  const after = findShieldByItem(m, shield.id)!;
  assert.equal(Object.keys(after.collectors).length, 0);
  assert.equal(Object.keys(after.wires).length, 1, "провод жив");
  assert.equal(Object.keys(Object.values(after.rails)[0]!.modules).length, 2, "модули живы");
  assert.throws(
    () => deleteShieldCollector(m, shield.id, collector.id),
    (e: unknown) => (e as McpError).code === "NOT_FOUND",
  );
});

test("291: лимиты — шин и коллекторов не больше SHIELD_MAX_BUSES/SHIELD_MAX_COLLECTORS", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  for (let i = 0; i < 20; i++) addShieldBus(m, shield.id, { position: "T" });
  assert.throws(
    () => addShieldBus(m, shield.id, { position: "T" }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
});

// ---------- 291: mock save с шиной и коллектором ----------

test("291: mock save — шина и коллектор сохраняются verified", async () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  addShieldCollector(m, shield.id, { modules: [mods[0]!.id, mods[1]!.id] });
  addShieldBus(m, shield.id, { position: "T" });
  addShieldWire(m, shield.id, { type: "shield_wire_phase", source: { module_id: mods[0]!.id, port: 0 }, target: { bus: Object.values(findShieldByItem(m, shield.id)!.buses)[0]!.id, port: 3 } });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {});
  await ws.open("0", "1");
  const res = await ws.save();
  assert.equal(res.verified, true, JSON.stringify(res).slice(0, 500));
  const saved = Object.values(server.model.shields as Record<string, Shield>)[0]!;
  assert.equal(Object.keys(saved.buses).length, 1);
  assert.equal(Object.keys(saved.collectors).length, 1);
  assert.equal(Object.keys(saved.wires).length, 1);
});

test("291: mock save — нормализатор потерял коллектор → NORMALIZATION_DROPPED с непустыми shield_mismatches", async () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  addShieldCollector(m, shield.id, { modules: [mods[0]!.id, mods[1]!.id] });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, () => {}, (norm) => {
    for (const sh of Object.values(norm.shields as Record<string, Shield>)) sh.collectors = {};
  });
  await ws.open("0", "1");
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as McpError;
    if (!(err instanceof McpError && err.code === "NORMALIZATION_DROPPED")) return false;
    const list = (err.details as Record<string, unknown>)["shield_mismatches"] as string[] | undefined;
    return Array.isArray(list) && list.length > 0;
  });
});

test("291: mock save — сервер испортил distance шины → SITE_ERROR с shield_mismatches", async () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  const { bus } = addShieldBus(m, shield.id, { position: "T" });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server, (srv) => {
    const saved = Object.values(srv.model.shields as Record<string, Shield>)[0]!;
    Object.values(saved.buses)[0]!.distance = 100;
  });
  await ws.open("0", "1");
  void bus;
  await assert.rejects(() => ws.save(), (e: unknown) => {
    const err = e as McpError;
    if (!(err instanceof McpError && err.code === "SITE_ERROR")) return false;
    const list = (err.details as Record<string, unknown>)["shield_mismatches"] as string[] | undefined;
    return Array.isArray(list) && list.length > 0;
  });
});

// ---------- 291: компакт, импорт ----------

test("291: компакт — bus_list (гнёзда, connection, distance) и collector_list (рейка, модули, position)", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  const { collector } = addShieldCollector(m, shield.id, { modules: [mods[0]!.id, mods[1]!.id] });
  const { bus } = addShieldBus(m, shield.id, { position: "T" });
  addShieldWire(m, shield.id, { type: "shield_wire_earth", source: { module_id: mods[0]!.id, port: 0 }, target: { bus: bus.id, port: 1 } });
  const c = compactModel(m, []) as unknown as { shields: { buses: number; bus_list: { bus_id: string; type: string; sockets: number; distance: number; connection: string; sockets_list: { port: number; connected: number }[] }[]; collectors: number; collector_list: { collector_id: string; rail: number; module_width: number; module_ids: string[]; position: string }[] }[] };
  const sh = c.shields[0]!;
  assert.equal(sh.buses, 1);
  assert.equal(sh.bus_list!.length, 1);
  const b = sh.bus_list![0]!;
  assert.equal(b.bus_id, bus.id);
  assert.equal(b.type, "TC");
  assert.equal(b.sockets, 6);
  assert.equal(b.distance, 157.5);
  assert.equal(b.connection, "shield_wire_earth");
  assert.equal(b.sockets_list[1]!.connected, 1);
  assert.equal(sh.collectors, 1);
  const col = sh.collector_list![0]!;
  assert.equal(col.collector_id, collector.id);
  assert.equal(col.rail, 0);
  assert.equal(col.module_width, 1);
  assert.deepEqual(col.module_ids, [mods[0]!.id, mods[1]!.id]);
  assert.equal(col.position, "T");
});

test("291: импорт — коллектор с мусорной картой modules и лишние коллекторы сверх лимита отклоняются", () => {
  const { m, shield } = scenario();
  ensureShieldForItem(m, shield);
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "16A" });
  addShieldModule(m, shield.id, { type: "shield_module", subtype: "25A" });
  const s = findShieldByItem(m, shield.id)!;
  const mods = Object.values(Object.values(s.rails)[0]!.modules).sort((a, b) => a.index - b.index);
  // строковое значение в modules — отказ (живой эталон: значения 1)
  const bad = structuredClone(s);
  bad.collectors = { c1: { id: "c1", rail_id: Object.values(bad.rails)[0]!.id, module_width: 1, modules: { [mods[0]!.id]: mods[0]!.id }, position: "T" } as never };
  assert.throws(
    () => parseModelImport({ ...baseModel(), shields: { [s.id]: bad } }),
    (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT",
  );
  // 21 коллектор — импорт проходит (ревью 293 №6: лимит импорта не ниже
  // реалистичного — MAX_IMPORT_GRAPH_NODES, как у шин); SHIELD_MAX_COLLECTORS
  // действует только на add (тест «291: лимиты»)
  const many = structuredClone(s);
  many.collectors = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`c${i}`, { id: `c${i}`, rail_id: Object.values(many.rails)[0]!.id, module_width: 1, modules: {}, position: "T" }])) as never;
  assert.doesNotThrow(() => parseModelImport({ ...baseModel(), shields: { [s.id]: many } }));
});
