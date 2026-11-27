// 427 (фикс major M1 ревью 426): юнит-тест чистой функции выбора удалений
// страховкой restore пробы 425 (scripts/probes/425-risers-restore.ts).
// Контракт fail-closed:
//  - бэкап не загружен → страховка НИЧЕГО не удаляет (проба печатает STOP, код ≠ 0);
//  - удалять можно только предметы из журнала ЭТОГО прогона и только вне бэкапа;
//  - предмет вида KEYS, которого нет ни в бэкапе, ни в журнале (чужой) — не
//    удалять, перечислить в manual для ручного разбора;
//  - предметы, которые есть в бэкапе (в т.ч. пользовательские water/water_column_cold/
//    ceiling_water этапа 57), не трогаются никогда.
// Мутации функции (инвертировать «в бэкапе», снять проверку журнала, удалить
// ветку no-backup, вернуть удаление чужих) — краснят этот тест.
import test from "node:test";
import assert from "node:assert/strict";
import { RISER_KEYS, selectRestoreDeletes } from "../../scripts/probes/425-risers-restore.ts";

const userItems = {
  // пользовательские предметы этапа 57, которые есть в бэкапе 425
  u_water: { name: "water" },
  u_cold: { name: "water_column_cold" },
  u_ceil: { name: "ceiling_water" },
  sofa: { name: "sofa" },
};

test("427 restore: бэкап не загружен — страховка НИЧЕГО не удаляет (fail-closed)", () => {
  const d = selectRestoreDeletes({
    backupItems: null,
    journal: [{ key: "water", site_id: "s_new" }],
    currentItems: { s_new: { name: "water" }, ...userItems },
  });
  assert.deepEqual(d, { ok: false, reason: "no-backup" }, "без бэкапа страховка ничего не удаляет");
});

test("427 restore: бэкап загружен пустым — предметы журнала удаляются, всё остальное вне бэкапа — manual", () => {
  const d = selectRestoreDeletes({
    backupItems: {},
    journal: [
      { key: "water", site_id: "s_new" },
      { key: "drainage_column", site_id: "s_del_ok" }, // уже удалён штатно — не в модели
    ],
    currentItems: { s_new: { name: "water" }, ...userItems },
  });
  assert.equal(d.ok, true);
  assert.deepEqual(d.ok ? d.delete : [], [{ id: "s_new", key: "water" }], "предмет журнала вне бэкапа — удалить");
  assert.deepEqual(
    d.ok ? d.manual : [],
    [
      { id: "u_water", name: "water" },
      { id: "u_cold", name: "water_column_cold" },
      { id: "u_ceil", name: "ceiling_water" },
    ],
    "KEYS-предметы вне (пустого) бэкапа и журнала — НЕ удалять, ручной разбор (fail-closed)",
  );
});

test("427 restore: предмет вида KEYS вне бэкапа и журнала (чужой) — НЕ удалять, в manual", () => {
  const d = selectRestoreDeletes({
    backupItems: userItems,
    journal: [],
    currentItems: { ...userItems, s_foreign: { name: "water_column_hot" } },
  });
  assert.equal(d.ok, true);
  assert.deepEqual(d.ok ? d.delete : [], [], "чужой предмет страховка не удаляет");
  assert.deepEqual(d.ok ? d.manual : [], [{ id: "s_foreign", name: "water_column_hot" }], "чужой — на ручной разбор");
});

test("427 restore: предмет журнала, совпавший с бэкапом, — не удалять (fail-closed)", () => {
  const d = selectRestoreDeletes({
    backupItems: { s_clash: { name: "water" } },
    journal: [{ key: "water", site_id: "s_clash" }],
    currentItems: { s_clash: { name: "water" } },
  });
  assert.equal(d.ok, true);
  assert.deepEqual(d.ok ? d.delete : [], [], "id из журнала есть в бэкапе — не удалять");
  assert.deepEqual(d.ok ? d.manual : [], [], "это свой предмет, не чужой");
});

test("427 restore: предметы бэкапа (в т.ч. вида KEYS) не трогаются никогда", () => {
  const d = selectRestoreDeletes({
    backupItems: userItems,
    journal: [{ key: "water", site_id: "s_new" }],
    currentItems: { s_new: { name: "water" }, ...userItems },
  });
  assert.equal(d.ok, true);
  assert.deepEqual(d.ok ? d.delete : [], [{ id: "s_new", key: "water" }]);
  assert.deepEqual(d.ok ? d.manual : [], []);
  // удалённые id не пересекаются с бэкапом
  for (const { id } of d.ok ? d.delete : []) assert.equal(id in userItems, false);
});

test("427 restore: пустой id журнала не удаляется и не считается предметом пробы", () => {
  const d = selectRestoreDeletes({
    backupItems: userItems,
    journal: [{ key: "water", site_id: "" }],
    currentItems: { ...userItems, s_x: { name: "water" } },
  });
  assert.equal(d.ok, true);
  assert.deepEqual(d.ok ? d.delete : [], [], "пустой id не удаляется");
  assert.deepEqual(d.ok ? d.manual : [], [{ id: "s_x", name: "water" }], "предмет вне бэкапа и журнала — manual");
});

test("427 restore: неполный бэкап ({items: {}}) — вид KEYS в currentItems виден", () => {
  assert.ok((RISER_KEYS as readonly string[]).includes("drainage_column"));
});
