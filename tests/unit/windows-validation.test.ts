// Этап 27: исправления по ревью «Окна» (26) — общий валидатор применимости параметров,
// инварианты балконного блока при update, door_position: right, импост в пределах двери,
// конечность геометрии и неизменность модели при ошибке.
// Этап 29: второй раунд по ревью 28 (R1–R5) — единицы, legacy window_balcony,
// кандидат-копия и атомарность финальных проверок, импост против итоговой высоты.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Hole, Model } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addOpening, updateOpening } from "../../src/model/openings.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

const here = dirname(fileURLToPath(import.meta.url));

function emptyModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  return { ...structuredClone(model), walls: {} };
}

function rect(model: Model) {
  const walls = addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  return { top: walls[0]!, bottom: walls[1]! };
}

function invalid(fn: () => unknown, re?: RegExp): void {
  assert.throws(fn, (e: { code?: string; message?: string }) => {
    assert.equal(e.code, "INVALID_ARGUMENT", `ожидался INVALID_ARGUMENT, получен ${e.code}: ${e.message}`);
    if (re) assert.match(e.message ?? "", re);
    return true;
  });
}

test("блокер №1: update обычного окна с door_width_mm — INVALID_ARGUMENT, модель не изменилась", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const w = addOpening(model, { wallId: top.id, type: "window", centerMm: 2000 });
  const before = structuredClone(model);
  invalid(() => updateOpening(model, { wallId: top.id, holeId: w.id, doorWidthMm: 900 }), /window_balcony/);
  assert.deepEqual(model, before, "модель не должна меняться при ошибке");
  // то же на старом объекте без полей частей
  const old: Hole = {
    id: "old1", plan: "a", type: "window", group: "windows",
    pc: { x: 200, y: -10 }, width: 120, height: 150, depth: 6, at: 140,
  };
  top.holes[old.id] = old;
  const beforeOld = structuredClone(model);
  invalid(() => updateOpening(model, { wallId: top.id, holeId: old.id, doorWidthMm: 900 }));
  assert.deepEqual(model, beforeOld);
});

test("№2: отрицательные/нулевые вычисленные части и противоречие с общей шириной", () => {
  const model = emptyModel();
  const { top } = rect(model);
  // единственная дверь шире блока → окно отрицательное
  invalid(() => addOpening(model, { wallId: top.id, type: "window_balcony", centerMm: 2000, doorWidthMm: 2000 }), /окна/);
  // единственное окно шире блока → дверь отрицательная
  invalid(() => addOpening(model, { wallId: top.id, type: "window_balcony", centerMm: 2000, windowWidthMm: 1900 }), /двери/);
  // общая ширина меньше дефолтной двери
  invalid(() => addOpening(model, { wallId: top.id, type: "window_balcony", centerMm: 2000, widthMm: 700 }), /окна/);
  // противоречие: сумма частей ≠ общей ширине
  invalid(() => addOpening(model, {
    wallId: top.id, type: "window_balcony", centerMm: 2000, widthMm: 1800, windowWidthMm: 1000, doorWidthMm: 900,
  }), /противоречит частям/);
  // нулевые и отрицательные входы
  invalid(() => addOpening(model, { wallId: top.id, type: "window_balcony", centerMm: 2000, widthMm: 0 }));
  invalid(() => addOpening(model, { wallId: top.id, type: "window_balcony", centerMm: 2000, windowWidthMm: -100 }));
  invalid(() => addOpening(model, { wallId: top.id, type: "window", centerMm: 2000, widthMm: 0 }));
  invalid(() => addOpening(model, { wallId: top.id, type: "window", centerMm: 2000, heightMm: -50 }));
  const before = structuredClone(model);
  assert.deepEqual(model, before);
});

test("№6: применимость параметров по типам — части только у windoor, casements не для французских, sill не для дверей", () => {
  const model = emptyModel();
  const { top, bottom } = rect(model);
  const w = addOpening(model, { wallId: top.id, type: "window", centerMm: 2000 });
  const fw = addOpening(model, { wallId: top.id, type: "french_window", centerMm: 700 });
  const d = addOpening(model, { wallId: top.id, type: "door", centerMm: 3000, widthMm: 800, heightMm: 2000, sillHeightMm: 0 });
  invalid(() => addOpening(model, { wallId: top.id, type: "window", centerMm: 2000, windowWidthMm: 1000 }), /window_balcony/);
  invalid(() => addOpening(model, { wallId: top.id, type: "window", centerMm: 2000, doorPosition: "left" }), /window_balcony/);
  invalid(() => updateOpening(model, { wallId: top.id, holeId: w.id, casements: 2, impostHeightMm: 1400 }), /window_door/);
  invalid(() => updateOpening(model, { wallId: top.id, holeId: fw.id, casements: 6 }), /французск/);
  invalid(() => addOpening(model, { wallId: top.id, type: "french_window_coupe", centerMm: 700, casements: 1 }), /французск/);
  invalid(() => updateOpening(model, { wallId: top.id, holeId: d.id, sillOverhangMm: 50 }), /окнам/);
  invalid(() => updateOpening(model, { wallId: top.id, holeId: d.id, slopeAngleDeg: 10 }), /окнам/);
  // импост в пределах двери: ниже подоконника и выше верха двери — нельзя
  invalid(() => addOpening(model, { wallId: bottom.id, type: "window_door", centerMm: 500, impostHeightMm: 3000 }), /импост/);
  invalid(() => addOpening(model, { wallId: bottom.id, type: "window_door", centerMm: 500, impostHeightMm: 90 }), /импост/);
  const okDoor = addOpening(model, { wallId: bottom.id, type: "window_door", centerMm: 2000, impostHeightMm: 1500 });
  assert.equal(okDoor.impost_offset, 140);
});

test("№3: update балконного блока — общая ширина пересчитывает части пропорционально, height запрещён", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const wd = addOpening(model, { wallId: top.id, type: "window_balcony", centerMm: 2000 });
  // 180 → 198: пропорционально 100/80 → 110/88
  updateOpening(model, { wallId: top.id, holeId: wd.id, widthMm: 1980 });
  assert.equal(wd.width, 198);
  assert.equal(wd.window_width, 110);
  assert.equal(wd.door_width, 88);
  assert.equal(wd.height, undefined);
  // height у windoor запрещён
  invalid(() => updateOpening(model, { wallId: top.id, holeId: wd.id, heightMm: 2000 }), /нет общей высоты/);
  invalid(() => addOpening(model, { wallId: top.id, type: "window_balcony", centerMm: 2000, heightMm: 2000 }), /нет общей высоты/);
  // высоты частей меняются, ширины остаются
  updateOpening(model, { wallId: top.id, holeId: wd.id, doorHeightMm: 2200 });
  assert.equal(wd.door_height, 220);
  assert.equal(wd.width, 198);
  // update высоты частей у windoor не создаёт поле height
  updateOpening(model, { wallId: top.id, holeId: wd.id, windowHeightMm: 1500 });
  assert.equal(wd.height, undefined);
  assert.equal(wd.window_height, 150);
});

test("ревью 30 N1/N2/N4: смена типа в update отвергается атомарно для любых пар типов", () => {
  const model = emptyModel();
  const { top, bottom } = rect(model);
  const d = addOpening(model, { wallId: top.id, type: "door", centerMm: 500, leaves: 2, sillHeightMm: 100 });
  const wd = addOpening(model, { wallId: top.id, type: "window_balcony", centerMm: 3000 });
  const w = addOpening(model, { wallId: bottom.id, type: "window", centerMm: 2000 });
  const d2 = addOpening(model, { wallId: bottom.id, type: "door", centerMm: 500 });
  const before = structuredClone(model);
  // дверные типы между собой (N2: конверсия теряла casements и высоту от пола)
  invalid(() => updateOpening(model, { wallId: top.id, holeId: d.id, type: "door_double" }), /смена типа не поддерживается/);
  // окно → французское раздвижное (N4: глубина 14 не переносилась)
  invalid(() => updateOpening(model, { wallId: bottom.id, holeId: w.id, type: "french_window_coupe" }), /смена типа не поддерживается/);
  // дверь → балконная дверь с явным импостом (N1: импост считался от старого пола)
  invalid(() => updateOpening(model, { wallId: bottom.id, holeId: d2.id, type: "window_door", impostHeightMm: 800 }), /смена типа не поддерживается/);
  // на/с балконного блока — как и прежде
  invalid(() => updateOpening(model, { wallId: top.id, holeId: wd.id, type: "window" }), /смена типа не поддерживается/);
  invalid(() => updateOpening(model, { wallId: bottom.id, holeId: w.id, type: "window_balcony" }), /opening_add/);
  // неизвестный тип
  invalid(() => updateOpening(model, { wallId: bottom.id, holeId: w.id, type: "нет_такого" }), /неизвестный тип/);
  // все отказы атомарны: модель равна снимку до вызовов
  assert.deepEqual(model, before, "модель не должна меняться при отказе смены типа");
  // передача текущего type — no-op: вызов успешен, объект не меняется
  const wBefore = structuredClone(w);
  updateOpening(model, { wallId: bottom.id, holeId: w.id, type: "window" });
  assert.deepEqual(w, wBefore);
  // legacy window_balcony: текущий канонический type принимается
  updateOpening(model, { wallId: top.id, holeId: wd.id, type: "windoor", centerMm: 2900 });
  assert.equal(wd.type, "windoor");
});

test("№3: update старых объектов — частей нет, общая ширина даёт дефолтную дверь 80", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const old: Hole = {
    id: "oldwd", plan: "a", type: "windoor", group: "windows",
    pc: { x: 200, y: -10 }, width: 180, depth: 6, at: 110, floor_height: 10,
  };
  top.holes[old.id] = old;
  updateOpening(model, { wallId: top.id, holeId: old.id, widthMm: 2000 });
  assert.equal(old.width, 200);
  assert.equal(old.window_width, 120); // 200 − дефолтная дверь 80
  assert.equal(old.door_width, 80);
  assert.equal(old.height, undefined);
});

test("R1: update ширины/позиции/одной высоты не портит сохранённые высоты частей (блокер 28)", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const wd = addOpening(model, { wallId: top.id, type: "window_balcony", centerMm: 2000 });
  assert.equal(wd.window_height, 150);
  assert.equal(wd.door_height, 225);
  // update общей ширины: части масштабируются, высоты остаются в см
  updateOpening(model, { wallId: top.id, holeId: wd.id, widthMm: 1980 });
  assert.equal(wd.window_width, 110);
  assert.equal(wd.door_width, 88);
  assert.equal(wd.window_height, 150, "высота окна не должна пройти mmToCm повторно");
  assert.equal(wd.door_height, 225);
  // update позиции двери: высоты снова не трогаются
  updateOpening(model, { wallId: top.id, holeId: wd.id, doorPosition: "left" });
  assert.equal(wd.window_height, 150);
  assert.equal(wd.door_height, 225);
  // update одной высоты: вторая сохраняется
  updateOpening(model, { wallId: top.id, holeId: wd.id, doorHeightMm: 2200 });
  assert.equal(wd.door_height, 220);
  assert.equal(wd.window_height, 150, "неизменённая высота не должна уменьшиться");
  // повторный update ширины: обе высоты остаются
  updateOpening(model, { wallId: top.id, holeId: wd.id, widthMm: 1980 });
  assert.equal(wd.window_height, 150);
  assert.equal(wd.door_height, 220);
  assert.equal(wd.window_width, 110);
  assert.equal(wd.door_width, 88);
});

function legacyHole(id: string, type: string): Hole {
  return {
    id, plan: "a", type, group: "windows",
    pc: { x: 200, y: -10 }, width: 180, depth: 6, at: 110, floor_height: 10,
  };
}

test("ревью 30 N3: старый блок без частей — centerMm, затем casing, затем высота одной части (оба имени)", () => {
  for (const name of ["window_balcony", "windoor"] as const) {
    const model = emptyModel();
    const { top } = rect(model);
    const old: Hole = {
      id: `oldwd-${name}`, plan: "a", type: name, group: "windows",
      pc: { x: 200, y: -10 }, width: 180, depth: 6, at: 110, floor_height: 10,
    };
    top.holes[old.id] = old;
    // первым вызовом — только положение: части нормализуются из дефолтов каталога
    updateOpening(model, { wallId: top.id, holeId: old.id, centerMm: 2100 });
    assert.equal(old.type, "windoor", `${name}: legacy-имя нормализуется при update`);
    assert.equal(old.window_width, 100); // 180 − дефолтная дверь 80
    assert.equal(old.door_width, 80);
    assert.equal(old.window_height, 150); // дефолты UI
    assert.equal(old.door_height, 225);
    assert.equal(old.door_position, "l");
    assert.equal(old.height, undefined);
    // вторым вызовом — короб с наличниками: части не пропадают
    updateOpening(model, { wallId: top.id, holeId: old.id, casing: true });
    assert.equal(old.casing, 1);
    assert.equal(old.window_width, 100);
    assert.equal(old.door_width, 80);
    // третьим вызовом — изменение высоты одной части
    updateOpening(model, { wallId: top.id, holeId: old.id, doorHeightMm: 2200 });
    assert.equal(old.door_height, 220);
    assert.equal(old.window_height, 150);
    // height у нормализованного блока отвергается
    const beforeErrors = structuredClone(model);
    invalid(() => updateOpening(model, { wallId: top.id, holeId: old.id, heightMm: 2000 }), /нет общей высоты/);
    // right отвергается (раньше молча игнорировался)
    invalid(() => updateOpening(model, { wallId: top.id, holeId: old.id, doorPosition: "right" }), /right не поддерживается/);
    // смена типа на обычное окно отвергается
    invalid(() => updateOpening(model, { wallId: top.id, holeId: old.id, type: "window" }), /смена типа не поддерживается/);
    assert.equal(old.type, "windoor");
    // атомарность отказов: модель равна снимку ДО вызовов (а не самой себе)
    assert.deepEqual(model, beforeErrors);
  }
});

// Точный объект, который создавал addOpening прежней версии MCP (d107f87):
// addOpening({type:"window_balcony", centerMm:2000}) на стене 4000×3000, толщина 200 —
// снят запуском `git show d107f87:src/model/openings.ts` (ревью 32, N3): общий height
// 225 при floor_height 80, частей нет.
function legacyD107f87(id: string, type: string, height = 225): Hole {
  return {
    id, plan: "a", type, group: "windows",
    pc: { x: 190, y: -10 }, width: 180, height, depth: 10, at: 110, floor_height: 80,
    p1: { x: 100, y: -10 }, p2: { x: 280, y: -10 },
  };
}

test("ревью 32 N3: legacy-блок d107f87 с общим height — высота мигрирует в части, height удаляется", () => {
  for (const name of ["window_balcony", "windoor"] as const) {
    // первым вызовом — только положение: height уходит в части, объект проходит инварианты
    const model = emptyModel();
    const { top } = rect(model);
    const old = legacyD107f87(`lg1-${name}`, name);
    top.holes[old.id] = old;
    updateOpening(model, { wallId: top.id, holeId: old.id, centerMm: 2100 });
    assert.equal(old.type, "windoor", `${name}: legacy-имя нормализуется при update`);
    assert.equal(old.height, undefined, `${name}: общий height удалён`);
    assert.equal(old.door_height, 225, `${name}: door_height = старый height`);
    assert.equal(old.window_height, 150, `${name}: window_height = дефолт каталога (не больше старого height)`);
    assert.equal(old.window_width, 100);
    assert.equal(old.door_width, 80);
    assert.equal(old.floor_height, 80, "floor_height не меняется");
    // первым вызовом — короб с наличниками: миграция та же
    const model2 = emptyModel();
    const { top: top2 } = rect(model2);
    const old2 = legacyD107f87(`lg2-${name}`, name);
    top2.holes[old2.id] = old2;
    updateOpening(model2, { wallId: top2.id, holeId: old2.id, casing: false });
    assert.equal(old2.height, undefined);
    assert.equal(old2.door_height, 225);
    assert.equal(old2.window_height, 150);
    assert.equal(old2.casing, 0);
    // первым вызовом — door_height_mm: явное значение сильнее миграции
    const model3 = emptyModel();
    const { top: top3 } = rect(model3);
    const old3 = legacyD107f87(`lg3-${name}`, name);
    top3.holes[old3.id] = old3;
    updateOpening(model3, { wallId: top3.id, holeId: old3.id, casing: false, doorHeightMm: 2200 });
    assert.equal(old3.height, undefined);
    assert.equal(old3.door_height, 220, "явная door_height_mm сильнее миграции");
    assert.equal(old3.window_height, 150);
  }
  // нестандартная старая высота 2000 (старый addOpening с heightMm:2000)
  const model = emptyModel();
  const { top } = rect(model);
  const old = legacyD107f87("lg-ns", "window_balcony", 200);
  top.holes[old.id] = old;
  updateOpening(model, { wallId: top.id, holeId: old.id, centerMm: 2100 });
  assert.equal(old.height, undefined);
  assert.equal(old.door_height, 200);
  assert.equal(old.window_height, 150);
  // совсем низкая старая высота: window_height зажимается до неё
  const model2 = emptyModel();
  const { top: top2 } = rect(model2);
  const low = legacyD107f87("lg-low", "window_balcony", 120);
  top2.holes[low.id] = low;
  updateOpening(model2, { wallId: top2.id, holeId: low.id, centerMm: 2100 });
  assert.equal(low.height, undefined);
  assert.equal(low.door_height, 120);
  assert.equal(low.window_height, 120, "window_height не больше старого height");
});

test("R2: неизвестный тип в модели не пропускается мимо валидатора", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const odd = legacyHole("odd", "что-то_иное");
  top.holes[odd.id] = odd;
  invalid(() => updateOpening(model, { wallId: top.id, holeId: odd.id, widthMm: 2000 }), /неизвестный тип проёма в модели/);
  assert.equal(odd.width, 180, "модель не изменилась");
});

test("R3: Infinity/NaN на входе — INVALID_ARGUMENT до мутации, модель равна снимку до вызова", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const w = addOpening(model, { wallId: top.id, type: "window", centerMm: 2000 });
  const before = structuredClone(model);
  invalid(() => updateOpening(model, { wallId: top.id, holeId: w.id, heightMm: Infinity }), /конечным числом/);
  assert.deepEqual(model, before, "модель не изменилась после ошибки входа");
  invalid(() => addOpening(model, { wallId: top.id, type: "window", centerMm: 2000, widthMm: Infinity }));
  invalid(() => addOpening(model, { wallId: top.id, type: "window", centerMm: 2000, sillOverhangMm: NaN }));
  invalid(() => updateOpening(model, { wallId: top.id, holeId: w.id, widthMm: NaN }), /конечным числом/);
  assert.deepEqual(model, before);
});

test("R4: импост, переставший помещаться при изменении высоты, — ошибка (выбор: ошибка, не коррекция), модель атомарна", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const d = addOpening(model, { wallId: top.id, type: "window_door", centerMm: 2000, impostHeightMm: 1400 });
  assert.equal(d.impost_offset, 130);
  const before = structuredClone(model);
  // update высоты без impost_height_mm: дефолтный/сохранённый импост больше не помещается
  invalid(() => updateOpening(model, { wallId: top.id, holeId: d.id, heightMm: 500 }), /импост/);
  assert.deepEqual(model, before, "ошибка финальной проверки тоже не меняет модель");
  // add с короткой высотой и дефолтным импостом 75 — тоже ошибка
  invalid(() => addOpening(model, { wallId: top.id, type: "window_door", centerMm: 500, heightMm: 500 }), /импост/);
  assert.deepEqual(model, before);
  // уменьшение высоты до допустимой проходит
  updateOpening(model, { wallId: top.id, holeId: d.id, heightMm: 1400 });
  assert.equal(d.height, 140);
  assert.equal(d.impost_offset, 130);
});

test("ревью 30 N5: неизвестное вложенное поле sill сохраняется при update подоконника", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const w = addOpening(model, { wallId: top.id, type: "window", centerMm: 2000 });
  (w.sill as Record<string, unknown>).extra = "keep";
  updateOpening(model, { wallId: top.id, holeId: w.id, sillThicknessMm: 50 });
  assert.equal((w.sill as Record<string, unknown>).extra, "keep", "неизвестное вложенное поле не теряется");
  assert.equal((w.sill as { thinkness: number }).thinkness, 5);
  // известные поля по-прежнему обновляются, side сохраняется
  updateOpening(model, { wallId: top.id, holeId: w.id, sillOverhangMm: 30 });
  const sill = w.sill as Record<string, unknown> & { overhang: number; side: string };
  assert.equal(sill.overhang, 3);
  assert.equal(sill.thinkness, 5);
  assert.equal(sill.side, "l");
  assert.equal(sill.extra, "keep");
});

test("MCP-путь: opening_add/opening_update отвергают неприменимые параметры кодом INVALID_ARGUMENT", async () => {
  const ctx = new ServerContext({ offlineFixture: join(here, "../fixtures/anon-rect-4000x3000.json") });
  const server = buildServer(ctx);
  const client = new Client({ name: "win-validation", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  type Res = { isError?: boolean; content?: { type: string; text?: string }[] };
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r as Res).content?.[0]?.text ?? "{}") as { code?: string; walls?: { site_id: string }[] };
  };
  const list = await call("model_get", {});
  const wall = list.walls!.find((w) => w.site_id === "0kvxg69h8n")!.site_id; // 300 см, без проёмов
  const wallB = list.walls!.find((w) => w.site_id === "jcdj4hyyeo")!.site_id; // вторая стена без проёмов
  const added = await call("opening_add", { wall_id: wall, type: "window", center_mm: 700 });
  const holeId = (added as unknown as { entity: { id: string } }).entity.id;
  const upd = await call("opening_update", { opening_id: holeId, wall_id: wall, door_width_mm: 900 });
  assert.equal(upd.code, "INVALID_ARGUMENT");
  const add = await call("opening_add", { wall_id: wall, type: "window_balcony", center_mm: 2300, door_position: "right" });
  assert.equal(add.code, "INVALID_ARGUMENT");
  const fr = await call("opening_add", { wall_id: wall, type: "french_window", center_mm: 500, casements: 6 });
  assert.equal(fr.code, "INVALID_ARGUMENT");
  const okAdd = await call("opening_add", { wall_id: wallB, type: "window_balcony", center_mm: 1000, window_width_mm: 1000, door_width_mm: 800 });
  assert.equal(okAdd.code, undefined, "допустимое сочетание должно проходить");
});
