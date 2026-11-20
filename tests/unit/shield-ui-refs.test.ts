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
  ensureShieldForItem, deleteShieldsForItem, findShieldByItem, shieldProjection, findShieldModule,
  SHIELD_MODULE_TYPES, SHIELD_ITEM_NAMES, SHIELD_RAIL_MIN_DIN, SHIELD_RAIL_MAX_DIN,
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
        .map(([k, x]) => [k, /^(id|shield_id|rail_id|parent_id|module_id)$/.test(k) ? "<id>" : maskedForm(x)]),
    );
  }
  return v;
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

test("255: провода/шины в щитке запрещают операции с модулями (формат — следующий этап)", () => {
  const { m, shield } = scenario();
  const { module: mod } = addShieldModule(m, shield.id, { type: "shield_module" });
  const s = findShieldByItem(m, shield.id)!;
  (s.wires as Record<string, unknown>)["w1"] = { id: "w1" };
  const before = structuredClone(s);
  assert.throws(() => addShieldModule(m, shield.id, { type: "shield_module" }), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
  assert.throws(() => deleteShieldModule(m, shield.id, mod.id), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
  assert.throws(() => addShieldRail(m, shield.id), (e: unknown) => (e as McpError).code === "INVALID_ARGUMENT");
  assert.deepEqual(findShieldByItem(m, shield.id), before);
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
    ["buses изменены", (s) => { s.buses = { b1: { id: "b1" } }; }],
    ["wires изменены", (s) => { s.wires = { w1: { id: "w1" } }; }],
    ["collectors изменены", (s) => { s.collectors = { c1: { id: "c1" } }; }],
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
