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

test("№3: смена типа в update — на/с балконного блока INVALID_ARGUMENT, между окнами допустима", () => {
  const model = emptyModel();
  const { top, bottom } = rect(model);
  const wd = addOpening(model, { wallId: top.id, type: "window_balcony", centerMm: 2000 });
  const w = addOpening(model, { wallId: bottom.id, type: "window", centerMm: 2000 });
  invalid(() => updateOpening(model, { wallId: top.id, holeId: wd.id, type: "window" }), /удалите проём и добавьте заново/);
  invalid(() => updateOpening(model, { wallId: bottom.id, holeId: w.id, type: "window_balcony" }), /удалите проём и добавьте заново/);
  invalid(() => updateOpening(model, { wallId: bottom.id, holeId: w.id, type: "нет_такого" }), /неизвестный тип/);
  // при ошибке смена типа не произошла
  assert.equal(wd.type, "windoor");
  assert.equal(w.type, "window");
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

test("R2: legacy window_balcony без частей — нормализация типа, update, height, right, смена типа", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const legacy = legacyHole("legacywb", "window_balcony");
  top.holes[legacy.id] = legacy;
  // update общей ширины: тип нормализуется, части считаются как у канонического windoor
  updateOpening(model, { wallId: top.id, holeId: legacy.id, widthMm: 2000 });
  assert.equal(legacy.width, 200);
  assert.equal(legacy.window_width, 120);
  assert.equal(legacy.door_width, 80);
  assert.equal(legacy.type, "windoor", "legacy-имя нормализуется при update");
  // height у нормализованного блока отвергается
  invalid(() => updateOpening(model, { wallId: top.id, holeId: legacy.id, heightMm: 2000 }), /нет общей высоты/);
  // right отвергается (раньше молча игнорировался)
  invalid(() => updateOpening(model, { wallId: top.id, holeId: legacy.id, doorPosition: "right" }), /right не поддерживается/);
  // смена типа на обычное окно отвергается (раньше обходила запрет)
  invalid(() => updateOpening(model, { wallId: top.id, holeId: legacy.id, type: "window" }), /удалите проём и добавьте заново/);
  assert.equal(legacy.type, "windoor");
});

test("R2: канонический windoor без частей — update, height, right, смена типа", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const old = legacyHole("oldwd", "windoor");
  top.holes[old.id] = old;
  updateOpening(model, { wallId: top.id, holeId: old.id, widthMm: 2000 });
  assert.equal(old.width, 200);
  assert.equal(old.window_width, 120);
  assert.equal(old.door_width, 80);
  assert.equal(old.height, undefined);
  invalid(() => updateOpening(model, { wallId: top.id, holeId: old.id, heightMm: 2000 }), /нет общей высоты/);
  invalid(() => updateOpening(model, { wallId: top.id, holeId: old.id, doorPosition: "right" }), /right не поддерживается/);
  invalid(() => updateOpening(model, { wallId: top.id, holeId: old.id, type: "window" }), /удалите проём и добавьте заново/);
  assert.equal(old.type, "windoor");
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

test("смена типа между окнами: поля нового типа сбрасываются/выставляются по дефолтам вида", () => {
  const model = emptyModel();
  const { top } = rect(model);
  const w = addOpening(model, { wallId: top.id, type: "window", centerMm: 2000 });
  assert.equal(w.casements, 1);
  // окно → французское: casements сбрасывается в 0 (пробел из ревью 28)
  updateOpening(model, { wallId: top.id, holeId: w.id, type: "french_window" });
  assert.equal(w.type, "french_window");
  assert.equal(w.casements, 0);
  assert.equal(w.slopes, undefined);
  // и обратно: casements 1 по дефолту вида
  updateOpening(model, { wallId: top.id, holeId: w.id, type: "window" });
  assert.equal(w.casements, 1);
  assert.equal(w.slopes, 20);
  // окно → дверь: оконные поля сброшены
  updateOpening(model, { wallId: top.id, holeId: w.id, type: "door" });
  assert.equal(w.type, "single");
  assert.equal(w.casements, undefined);
  assert.equal(w.sill, undefined);
  assert.equal(w.slope_angle, undefined);
  assert.equal(w.floor_height, undefined);
  assert.equal(w.slopes, undefined);
  // дверь → окно: дефолты окна возвращаются
  updateOpening(model, { wallId: top.id, holeId: w.id, type: "window" });
  assert.equal(w.casements, 1);
  assert.equal(w.slope_angle, 0);
  assert.ok(w.sill);
  assert.equal(w.slopes, 20);
  assert.equal(w.floor_height, 85);
  assert.equal(w.opening, "r-l");
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
