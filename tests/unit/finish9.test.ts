// 347 (отделка ч.9): подъём пола (f0offset), точка начала укладки (anchor_floor,
// PRO), имя/цвет/номер зоны помещения, дедуп finishLossHint по границе слова.
// Эталоны — синтетические ui-ref-finish9-*.json (форма записи редактора);
// сверка в обе стороны, атомарность, PRO free/pro, мутации краснеют.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Model } from "../../src/model/types.ts";
import {
  setFloorFinish, setFloorOffset, setFloorAnchor, removeFloorFinish,
  finishMismatches, finishCompare, finishLossSteps,
  FINISH_LOSS_REGISTRY, type FinishLoss, type FinishLossRule,
} from "../../src/model/finish.ts";
import { setRoomName, setRoomColor, zoneNumbersByEditorRule } from "../../src/model/room-fields.ts";
import { compactModel } from "../../src/model/compact.ts";
import { roomUserSig, roomsSaveCompare } from "../../src/model/rooms-save.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { McpError } from "../../src/errors.ts";
import { cmToMm } from "../../src/model/units.ts";

const FIXTURE = new URL("../../tests/fixtures/editor-corridor-3rooms.json", import.meta.url).pathname;

function baseModel(): Model {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { model: Model }).model;
}

function roomsOf(m: Model): Record<string, Record<string, unknown>> {
  return (m.rooms2 ?? {}) as Record<string, Record<string, unknown>>;
}

function firstRoomId(m: Model): string {
  const id = Object.keys(roomsOf(m))[0];
  assert.ok(id, "в фикстуре есть комната");
  return id!;
}

const OFFSET_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-finish9-offset.json", "utf8")) as {
  room: { polygon: { x: number; y: number }[] };
  floors: Array<Record<string, unknown>>;
};
const ANCHOR_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-finish9-anchor.json", "utf8")) as {
  room: { polygon: { x: number; y: number }[] };
  floors: Array<Record<string, unknown>>;
};
const ROOM_FIELDS_REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-finish9-room-fields.json", "utf8")) as {
  rooms: Record<string, Record<string, unknown>>;
};

function floorOf(m: Model, room: string): Record<string, unknown> {
  return ((roomsOf(m)[room]!["floors"] as Array<Record<string, unknown>>))[0]!;
}

// ---------- подъём пола (f0offset) ----------

test("347: эталон UI — запись инструмента совпадает с формой Floor редактора (f0offset), сверка в обе стороны", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  (roomsOf(m)[room]!["polygon"]) = structuredClone(OFFSET_REF.room.polygon) as never;
  setFloorFinish(m, room, "laminate", { angleDeg: 0, plankLengthMm: 1200, plankWidthMm: 180, stitchWidthMm: 2, typeLaying: "1/2" });
  setFloorOffset(m, room, 300);
  const got = floorOf(m, room);
  const exp = OFFSET_REF.floors[0]!;
  assert.equal(got["cover"], exp["cover"]);
  assert.equal(got["angle"], exp["angle"]);
  assert.equal(got["width"], exp["width"]);
  assert.equal(got["height"], exp["height"]);
  assert.equal(got["stitch_width"], exp["stitch_width"]);
  assert.equal(got["type_laying"], exp["type_laying"]);
  assert.equal(got["f0offset"], exp["f0offset"]);
  assert.equal(got["exist"], true);
  const rooms = { [room]: roomsOf(m)[room]! };
  assert.deepEqual(finishMismatches(rooms, rooms), []);
  const fixtureRooms = { [room]: { polygon: OFFSET_REF.room.polygon, floors: structuredClone(OFFSET_REF.floors) } };
  assert.deepEqual(finishMismatches(fixtureRooms, rooms), [], "эталон → запись: без расхождений");
  assert.deepEqual(finishMismatches(rooms, fixtureRooms), [], "запись → эталон: без расхождений");
});

test("347: пределы редактора 0..100 см — INVALID_ARGUMENT, модель не меняется (атомарность)", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  const before = structuredClone(roomsOf(m)[room]);
  for (const bad of [-1, 1001, Number.NaN]) {
    assert.throws(() => setFloorOffset(m, room, bad), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT", `offset ${bad}`);
  }
  assert.deepEqual(roomsOf(m)[room], before, "модель не изменилась при отказе");
  // нет покрытия пола — отказ
  const m2 = baseModel();
  assert.throws(() => setFloorOffset(m2, firstRoomId(m2), 300), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
});

test("347: apply_to_all_zero — кнопка «Применить ко всем» редактора; ненулевые полы не трогаются", () => {
  const m = baseModel();
  const rooms = roomsOf(m);
  const ids = Object.keys(rooms);
  assert.ok(ids.length >= 2, "в фикстуре несколько комнат");
  const [a, b, c] = ids;
  for (const id of [a, b, c]) {
    if (!id) continue;
    setFloorFinish(m, id, "laminate", {});
  }
  if (c) (floorOf(m, c))["f0offset"] = 10;
  const res = setFloorOffset(m, a!, 300, true);
  assert.equal(floorOf(m, a!)["f0offset"], 30);
  assert.equal(floorOf(m, b!)["f0offset"], 30, "пол с нулевым подъёмом получил значение");
  if (c) assert.equal(floorOf(m, c)["f0offset"], 10, "ненулевой подъём не перезаписывается");
  assert.equal(res.updated, c ? 2 : 2);
  // без apply_to_all_zero — только текущий пол (отмена диалога)
  const m2 = baseModel();
  const ids2 = Object.keys(roomsOf(m2));
  for (const id of ids2) setFloorFinish(m2, id, "laminate", {});
  setFloorOffset(m2, ids2[0]!, 300);
  assert.equal(floorOf(m2, ids2[1]!)["f0offset"], undefined, "другие полы не тронуты");
});

// ---------- точка укладки (anchor, PRO) ----------

test("347: эталон UI — anchor ставится как mouseup anchor_floor (p, angle=0, custom_angle снят), сверка в обе стороны", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  (roomsOf(m)[room]!["polygon"]) = structuredClone(ANCHOR_REF.room.polygon) as never;
  setFloorFinish(m, room, "laminate", { angleDeg: 0, plankLengthMm: 1200, plankWidthMm: 180, stitchWidthMm: 2, typeLaying: "1/2" });
  // угол из предыдущей правки сбрасывается кликом инструмента
  (floorOf(m, room))["angle"] = 45;
  (floorOf(m, room))["custom_angle"] = 1;
  const res = setFloorAnchor(m, room, { x: cmToMm(200), y: cmToMm(-200) });
  const got = floorOf(m, room);
  const exp = ANCHOR_REF.floors[0]!;
  assert.deepEqual(got["anchor"], exp["anchor"]);
  assert.equal(got["angle"], 0);
  assert.equal(got["custom_angle"], undefined);
  assert.deepEqual(res.anchor, { x_mm: 2000, y_mm: -2000 });
  const rooms = { [room]: roomsOf(m)[room]! };
  assert.deepEqual(finishMismatches(rooms, rooms), []);
  const fixtureRooms = { [room]: { polygon: ANCHOR_REF.room.polygon, floors: structuredClone(ANCHOR_REF.floors) } };
  assert.deepEqual(finishMismatches(fixtureRooms, rooms), [], "эталон → запись");
  assert.deepEqual(finishMismatches(rooms, fixtureRooms), [], "запись → эталон");
});

test("347: anchor — угол с якорем (контекстное меню #cm-floor-anchor--angle), вне полигона — отказ, null снимает", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  const res = setFloorAnchor(m, room, { x: cmToMm(150), y: cmToMm(-150) }, 45);
  const f = floorOf(m, room);
  assert.equal(f["angle"], 45);
  assert.equal(f["custom_angle"], 1);
  assert.deepEqual(res.anchor, { x_mm: 1500, y_mm: -1500 });
  // точка вне полигона
  assert.throws(
    () => setFloorAnchor(m, room, { x: cmToMm(5000), y: cmToMm(-5000) }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  // удаление якоря (ластик)
  setFloorAnchor(m, room, null);
  assert.equal(floorOf(m, room)["anchor"], undefined);
  // нет покрытия пола — отказ
  const m2 = baseModel();
  assert.throws(
    () => setFloorAnchor(m2, firstRoomId(m2), { x: 0, y: 0 }),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
});

// ---------- сверка save: f0offset/anchor — явно заданные пользователем ----------

function baseFloorRooms(): { exp: Record<string, Record<string, unknown>>; room: string } {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  return { exp: { [room]: structuredClone(roomsOf(m)[room]!) } as Record<string, Record<string, unknown>>, room };
}

test("347: потеря f0offset/anchor при normalize — problems вида floor; появление якоря без пользовательского — подмена", () => {
  // подъём пола: исчезновение — потеря
  const { exp, room } = baseFloorRooms();
  const expWithF0 = structuredClone(exp) as Record<string, Record<string, unknown>>;
  (floorOf({ rooms2: expWithF0 } as Model, room))["f0offset"] = 30;
  const gotPlain = structuredClone(exp) as Record<string, Record<string, unknown>>;
  const res = finishCompare(expWithF0, gotPlain, undefined, undefined, "normalize");
  assert.equal(res.problems.length, 1, JSON.stringify(res));
  assert.deepEqual(res.losses.map((l) => l.kind), ["floor"]);
  // сменившееся значение — расхождение
  const gotOther = structuredClone(expWithF0);
  (floorOf({ rooms2: gotOther } as Model, room))["f0offset"] = 20;
  assert.equal(finishMismatches(expWithF0, gotOther).length, 1);
  // отсутствие значения на ОБЕИХ сторонах эквивалентно нулю (умолчание редактора);
  // исчезновение явно заданного ненулевого значения — потеря (проверено выше)
  const expZero = structuredClone(exp) as Record<string, Record<string, unknown>>;
  delete (floorOf({ rooms2: expZero } as Model, room))["f0offset"];
  const gotZero = structuredClone(expZero);
  assert.deepEqual(finishMismatches(expZero, gotZero), []);
  // якорь: симметрично по наличию
  const expA = structuredClone(exp) as Record<string, Record<string, unknown>>;
  (floorOf({ rooms2: expA } as Model, room))["anchor"] = { p: { x: 150, y: -150 } };
  assert.equal(finishMismatches(expA, exp).length, 1, "якорь потерян — расхождение");
  assert.equal(finishMismatches(exp, expA).length, 1, "якорь появился без пользовательского — подмена");
  // позиция якоря с допуском
  const gotMoved = structuredClone(expA);
  (floorOf({ rooms2: gotMoved } as Model, room))["anchor"] = { p: { x: 152, y: -152 } };
  assert.equal(finishMismatches(expA, gotMoved).length, 1, "сдвиг якоря на 2 см — расхождение");
  const gotNear = structuredClone(expA);
  (floorOf({ rooms2: gotNear } as Model, room))["anchor"] = { p: { x: 150.2, y: -150.2 } };
  assert.deepEqual(finishMismatches(expA, gotNear), [], "численный шум в допуске");
});

// ---------- стена делит комнату — без ложной ошибки ----------

test("347: split стены делит комнату — имя зоны и пол (f0offset/anchor) переживают разрез, ложной ошибки нет", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  const rooms = roomsOf(m);
  rooms[room]!["polygon"] = [
    { x: 290, y: -290 }, { x: 290, y: -10 }, { x: 10, y: -10 }, { x: 10, y: -290 },
  ];
  setFloorFinish(m, room, "laminate", {});
  setFloorOffset(m, room, 300);
  setFloorAnchor(m, room, { x: cmToMm(200), y: cmToMm(-200) });
  (rooms[room]!["zones"]) = [{ name: "Комната 9", color: "#f5e9d0", is_micro_zone: 0 }] as never;
  const exp = structuredClone({ [room]: rooms[room]! }) as Record<string, Record<string, unknown>>;
  // редактор: две части; пол наследует каждая (f0offset/anchor копируются restoreTotal),
  // имя зоны уходит части с совпавшим контуром (getZone)
  const part = (key: string, x0: number, x1: number, withName: boolean): Record<string, unknown> => {
    const s = structuredClone(rooms[room]!) as unknown as Record<string, unknown>;
    s["polygon"] = [
      { x: x1, y: -290 }, { x: x1, y: -10 }, { x: x0, y: -10 }, { x: x0, y: -290 },
    ];
    if (!withName) (s["zones"] as Array<Record<string, unknown>>)[0]!["name"] = "none";
    return s;
  };
  const got: Record<string, Record<string, unknown>> = {
    _p1: part("_p1", 150, 290, true),
    _p2: part("_p2", 10, 150, false),
  };
  const res = finishCompare(exp, got, undefined, undefined, "normalize");
  assert.deepEqual(res.problems, [], JSON.stringify(res.problems));
  // отрицательный: часть потеряла подъём пола
  const got2 = structuredClone(got) as Record<string, Record<string, unknown>>;
  delete (floorOf({ rooms2: got2 } as Model, "_p2"))["f0offset"];
  (floorOf({ rooms2: got2 } as Model, "_p2"))["f0offset"] = 0;
  const res2 = finishCompare(exp, got2, undefined, undefined, "normalize");
  assert.ok(res2.problems.length > 0, "потеря подъёма в части — problem");
  // отрицательный: части потеряли покрытие пола целиком
  const got3: Record<string, Record<string, unknown>> = {
    _p1: structuredClone(got["_p1"]!),
    _p2: structuredClone(got["_p2"]!),
  };
  for (const k of ["_p1", "_p2"]) {
    (got3[k]!["floors"] as Array<Record<string, unknown>>)[0] = { exist: false };
  }
  const res3 = finishCompare(exp, got3, undefined, undefined, "normalize");
  assert.ok(res3.problems.length > 0, "пол в частях исчез — problem");
});

// ---------- имя/цвет/номер зоны помещения ----------

test("347: эталон UI — имя/цвет зоны и номера зон по правилу редактора; компакт видит color/number", () => {
  const m = baseModel();
  (m as unknown as { rooms2: Record<string, unknown> }).rooms2 = structuredClone(ROOM_FIELDS_REF.rooms) as never;
  const roomA = setRoomName(m, "A", "Комната 9");
  assert.equal(roomA.name, "Комната 9");
  const roomB = setRoomName(m, "B", "");
  assert.equal(roomB.name, null, "пустая строка — «без имени» (none)");
  assert.equal(zoneNumbersByEditorRule(m).get("A")?.get(0), 1, "большая комната — номер 1");
  assert.equal(zoneNumbersByEditorRule(m).get("B")?.get(0), 2, "меньшая — номер 2");
  const compact = compactModel(m);
  const ca = compact.rooms.find((r) => r.name === "Комната 9")!;
  assert.ok(ca, "комната с именем в компактном виде");
  assert.equal(ca.color, "#f5e9d0");
  assert.equal(ca.number, 1);
  // эталон против модели — сверка комнат в обе стороны
  assert.deepEqual(finishMismatches(ROOM_FIELDS_REF.rooms as never, m.rooms2 as never), []);
});

test("347: room_set_name/room_set_color — валидация, атомарность, «none»/белый снимают", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  (roomsOf(m)[room]!["zones"]) = [{ name: "none", is_micro_zone: 0 }] as never;
  assert.throws(
    () => setRoomName(m, room, "x".repeat(101)),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  assert.throws(
    () => setRoomName(m, room, "строка\nс переводом"),
    (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT",
  );
  const before = structuredClone(roomsOf(m)[room]);
  assert.throws(() => setRoomColor(m, room, "#gggggg"), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.throws(() => setRoomColor(m, room, "#12345"), (e: unknown) => e instanceof McpError && e.code === "INVALID_ARGUMENT");
  assert.deepEqual(roomsOf(m)[room], before, "модель не изменилась при отказе");
  const c = setRoomColor(m, room, "#F5E9D0");
  assert.equal(c.color, "#f5e9d0", "hex нормализуется в нижний регистр");
  const w = setRoomColor(m, room, "#ffffff");
  assert.equal(w.color, null, "белый снимает цвет (как в редакторе)");
  const n = setRoomName(m, room, "?");
  assert.equal(n.name, null, "\"?\" — «без имени», как в редакторе");
});

test("347: roomUserSig — цвет зоны в сигнатуре; потеря цвета — problem; правка через MCP сверяется с рабочей копией", () => {
  const base = structuredClone(ROOM_FIELDS_REF.rooms) as Record<string, Record<string, unknown>>;
  // цвет в сигнатуре
  const sigA = roomUserSig(base["A"]!);
  assert.ok(sigA.zones.some((z) => z.includes("#f5e9d0")), "цвет в сигнатуре зоны");
  // потеря цвета — расхождение
  const noColor = structuredClone(base);
  delete ((noColor["A"]!["zones"] as Array<Record<string, unknown>>)[0]!)["color"];
  const res = roomSaveCompareSig(base, noColor);
  assert.ok(res.problems.length > 0, "потеря цвета зоны — problem");
  // rename через MCP: база без имени, рабочая копия с именем, сервер с именем — штатно
  const renamed = structuredClone(noColor);
  ((renamed["A"]!["zones"] as Array<Record<string, unknown>>)[0]!)["name"] = "Кабинет";
  const edited = new Set(["A"]);
  const okRes = roomSaveCompareOpts(noColor, renamed, { userEditedRooms: edited, workingRooms: renamed });
  assert.deepEqual(okRes.problems, [], JSON.stringify(okRes.problems));
  // сервер потерял правку — расхождение
  const lost = structuredClone(noColor);
  const lostRes = roomSaveCompareOpts(noColor, lost, { userEditedRooms: edited, workingRooms: renamed });
  assert.ok(lostRes.problems.length > 0, "потеря правки имени — problem");
  // сырое удаление зон (мимо инструментов) — сверка от базы ловит
  const rawDeleted = structuredClone(noColor);
  delete rawDeleted["A"]!["zones"];
  const rawRes = roomSaveCompareOpts(noColor, rawDeleted, {});
  assert.ok(rawRes.problems.length > 0, "правка мимо инструментов — problem (сверка от базы)");
  // эталон в обе стороны
  assert.deepEqual(roomSaveCompareSig(base, structuredClone(base)).problems, []);
});

function roomSaveCompareSig(a: Record<string, unknown>, b: Record<string, unknown>): { problems: string[]; warnings: string[] } {
  return roomsSaveCompare(a, b, "normalize");
}
function roomSaveCompareOpts(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  opts: Parameters<typeof roomsSaveCompare>[4],
): { problems: string[]; warnings: string[] } {
  return roomsSaveCompare(a, b, "normalize", {}, opts);
}

// ---------- дедуп подсказки по границе слова (n1 ревью 344) ----------

test("347: finishLossSteps — дедуп по границе слова, не по подстроке; инструменты-подстроки не выпадают", () => {
  // дедуп по инструменту: составной шаг ceiling_complex называет finish_ceiling_remove
  const losses: FinishLoss[] = [
    { kind: "ceiling_complex", text: "x" },
    { kind: "ceiling", text: "y" },
  ];
  const steps = finishLossSteps(losses);
  assert.equal(steps.filter((s) => s.includes("finish_ceiling_remove")).length, 1, "инструмент не повторяется");
  // синтетический реестр с именами-подстроками: оба шага присутствуют
  // (дедуп по подстроке глотает короткий инструмент после длинного — n1 ревью 344)
  const synthetic: FinishLossRule[] = [
    { kind: "floor", label: "пол", tool: "finish_wall_remove_all", order: 1 },
    { kind: "wall_side", label: "стена", tool: "finish_wall_remove", order: 2 },
  ];
  const both: FinishLoss[] = [
    { kind: "floor", text: "x" },
    { kind: "wall_side", text: "y" },
  ];
  const steps2 = finishLossSteps(both, synthetic);
  assert.deepEqual(steps2, ["finish_wall_remove_all", "finish_wall_remove"], "подстрока не глотает второй шаг");
  // реальные шаги реестра не теряются (пол + плинтус + потолок + ниша)
  const mixed: FinishLoss[] = [
    { kind: "floor_molding", text: "x" }, { kind: "ceiling_molding", text: "x" },
    { kind: "niche", text: "x" }, { kind: "ceiling", text: "x" }, { kind: "floor", text: "x" },
  ];
  const steps3 = finishLossSteps(mixed);
  assert.equal(steps3.length, 5, "все инструменты различны и названы");
  assert.ok(FINISH_LOSS_REGISTRY.length >= 8, "реестр не пуст");
});

// ---------- PRO-гейт точки укладки (полный путь MCP) ----------

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
function payloadOf(r: unknown): { code?: string } {
  return JSON.parse(((r as ToolCallResult).content ?? []).map((c) => c.text ?? "").join("")) as { code?: string };
}

async function start(tariff: "free" | "pro" | null): Promise<Client> {
  const ctx = new ServerContext({
    offlineFixture: new URL("../../tests/fixtures/anon-rect-4000x3000.json", import.meta.url).pathname,
    ...(tariff === null ? {} : { offlineTariff: tariff, offlineAnon: false }),
  });
  const server = buildServer(ctx);
  const client = new Client({ name: "finish9-pro", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

test("347: finish_floor_anchor_set на free — NOT_AVAILABLE_ON_TARIFF; на pro — гейт проходит", async () => {
  const free = await start(null);
  try {
    const res = await free.callTool({ name: "finish_floor_anchor_set", arguments: { room_id: "R1", at_mm: { x: 1500, y: -1500 } } });
    assert.ok(res.isError, "ожидался отказ на free");
    assert.equal(payloadOf(res).code, "NOT_AVAILABLE_ON_TARIFF", JSON.stringify(payloadOf(res)));
  } finally {
    await free.close();
  }
  const pro = await start("pro");
  try {
    const res = await pro.callTool({ name: "finish_floor_anchor_set", arguments: { room_id: "R1", at_mm: { x: 1500, y: -1500 } } });
    assert.ok(res.isError, "нет покрытия пола — отказ по существу, не по тарифу");
    assert.equal(payloadOf(res).code, "INVALID_ARGUMENT", JSON.stringify(payloadOf(res)));
    // удаление якоря не гейтится (ластик) — на free ошибка по существу
    const free2 = await start(null);
    try {
      const del = await free2.callTool({ name: "finish_floor_anchor_set", arguments: { room_id: "R1", at_mm: null } });
      assert.ok(del.isError);
      assert.equal(payloadOf(del).code, "INVALID_ARGUMENT", "удаление — не тарифный отказ");
    } finally {
      await free2.close();
    }
  } finally {
    await pro.close();
  }
});

// ---------- lастер покрывает offset/anchor (производные снимаются с покрытием) ----------

test("347: removeFloorFinish сбрасывает подъём и якорь вместе с покрытием", () => {
  const m = baseModel();
  const room = firstRoomId(m);
  setFloorFinish(m, room, "laminate", {});
  setFloorOffset(m, room, 300);
  setFloorAnchor(m, room, { x: cmToMm(150), y: cmToMm(-150) });
  removeFloorFinish(m, room);
  const f = floorOf(m, room);
  assert.equal(f["exist"], false);
  assert.equal(f["f0offset"], undefined);
  assert.equal(f["anchor"], undefined);
});
