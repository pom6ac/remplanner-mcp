// Контракт адаптера редактора (design §10): анонимный проект → restore эталонной модели →
// draw → copy → инварианты → save → повторное чтение по HTTP. Без входа в аккаунт.
// Запуск: npm run test:contract
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { saveSession, type SessionState } from "../../src/session.ts";
import { createAnonProject, loadModel } from "../../src/api.ts";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { prepareForRestore } from "../../src/model/walls.ts";
import type { Model, FixtureEnvelope } from "../../src/model/types.ts";

test.after(() => closeBrowser().catch(() => {}));

const ROOT = join(import.meta.dirname, "..", "..");

function fixtureModel(): Model {
  const env = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/anon-rect-4000x3000.json"), "utf8")) as FixtureEnvelope;
  const model = structuredClone(env.model);
  // комнаты редактора из фикстуры (rooms2 по внутренним граням, офлайн-смоук) не годятся
  // для $Project.restore: restore ждёт полные данные редактора — снимаем (сценарий B T24:
  // restore голой геометрии, комнаты редактор пересчитает сам)
  delete model.rooms2;
  delete model.rooms1;
  prepareForRestore(model);
  return model;
}

async function anonSession(): Promise<SessionState> {
  // свежая анонимная сессия на каждый прогон: переиспользование cookies visitor_id
  // приводит к гонке «текущего проекта» на сервере между прогонами
  return { cookies: [] };
}

test("contract: restore → draw → copy → save → повторный GET без потерь", { timeout: 240_000 }, async () => {
  const session = await anonSession();
  const created = await createAnonProject(session);
  assert.notEqual(created.object_id, "");

  const model = fixtureModel();
  const wallsBefore = Object.keys(model.walls).length;
  const holesBefore = Object.values(model.walls).reduce((n, w) => n + Object.keys(w.holes).length, 0);

  const editor = await openEditor(session, created.object_id, created.plan_id, 30_000, { anonymous: true });
  const actualObject = editor.compat.object_id ?? created.object_id;
  const actualPlan = editor.compat.plan_id ?? created.plan_id;
  try {
    const t0 = Date.now();
    const norm = await editor.normalize(structuredClone(model) as unknown as Record<string, unknown>, 800);
    const elapsedMs = Date.now() - t0;
    assert.ok(elapsedMs < 2000, `нормализация маленького проекта заняла ${elapsedMs} мс (ожидалось < 2000)`);

    assert.ok(!("restoreError" in norm), `restore упал: ${JSON.stringify((norm as { restoreError?: string }).restoreError)}`);
    assert.equal(norm.after.walls, wallsBefore, "все стены пережили restore");
    assert.equal(norm.after.holes, holesBefore, "все проёмы пережили restore (нужны p1/p2)");
    assert.equal(norm.rooms.length, 1, "редактор нашёл одну комнату");
    const area = norm.rooms[0]!.area_m2;
    assert.ok(area !== null && Math.abs(area - 10.64) < 0.02, `площадь комнаты ${area}, ожидалось 10,64 м²`);

    // hole.at переживает restore? (хвост этапа 2, №3 отчёта 03)
    const copy = norm.model as { walls?: Record<string, { holes?: Record<string, { at?: number }> }> };
    assert.ok(copy.walls && Object.keys(copy.walls).length > 0, `copy('server') без стен: ${JSON.stringify(Object.keys(norm.model ?? {}))}`);
    const atValues = Object.values(copy.walls).flatMap((w) => Object.values(w.holes ?? {}).map((h) => h.at));
    assert.equal(atValues.length, holesBefore, "проёмы в copy('server') на месте");
    const atSaved = atValues.filter((v) => v !== undefined).length;
    const atSavedNote = { at_saved: atSaved, at_total: atValues.length };

    // save штатным project.save(false, true)
    const saveRes = await editor.save();
    assert.ok(saveRes.ok, `сохранение не прошло: ${JSON.stringify(saveRes)}`);
    assert.ok(saveRes.saveId !== null);

    // повторное чтение по HTTP в том же session (каноническое чтение — GET)
    const reloaded = await loadModel(session, actualObject, actualPlan);
    const walls2 = reloaded.model["walls"] as Record<string, { holes: Record<string, unknown> }>;
    assert.equal(Object.keys(walls2).length, wallsBefore, "стены пережили круг save → GET");
    const holes2 = Object.values(walls2).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0);
    assert.equal(holes2, holesBefore, "проёмы пережили круг save → GET");
    const rooms2 = reloaded.model["rooms2"] as Record<string, unknown> | undefined;
    assert.ok(rooms2 && Object.keys(rooms2).length === 1, "после перезагрузки найдена комната (rooms2)");

    // служебное поле at: фиксируем факт (мешает/не мешает), чтобы решить, писать ли его в модель
    assert.ok(atSavedNote.at_total > 0);
  } finally {
    await editor.close();
  }
});

test("contract: редактор без точек входа → EDITOR_INCOMPATIBLE (mock)", () => {
  // проверяется в tests/unit/compat.test.ts на моке страницы; здесь только импорт-связность
  assert.equal(typeof openEditor, "function");
});

// Сценарий B из T24 (design §12, этап 6): голая геометрия «коридор + 3 комнаты» без link —
// редактор сам строит связи, грани и комнаты. Ожидания T24: 7 стен, 4 комнаты
// 7,84 / 5,80 / 5,04 / 2,24 м², 6 концов edge + 8 node, свободных 0, ошибок 0.
test("contract: топология из геометрии — коридор + 3 комнаты, T24", { timeout: 240_000 }, async () => {
  const session: SessionState = { cookies: [] };
  const created = await createAnonProject(session);
  const D = 20; // толщина, см
  const h = D / 2;
  const specs: [{ x: number; y: number }, { x: number; y: number }][] = [
    [{ x: 0, y: -300 }, { x: 600, y: -300 }],
    [{ x: 600, y: -300 }, { x: 600, y: 120 }],
    [{ x: 600, y: 120 }, { x: 0, y: 120 }],
    [{ x: 0, y: 120 }, { x: 0, y: -300 }],
    [{ x: 0 + h, y: 0 }, { x: 600 - h, y: 0 }],
    [{ x: 300, y: -300 + h }, { x: 300, y: 0 - h }],
    [{ x: 500, y: -300 + h }, { x: 500, y: 0 - h }],
  ];
  const model: Model = {
    v: 3, id: created.object_id, plan_id: "0",
    walls: {}, items: {}, pillars: {}, rulers: {}, comments: {},
    total_height: 270, final: false,
  };
  for (const [i, [p1, p2]] of specs.entries()) {
    model.walls[`w${i + 1}`] = {
      id: `w${i + 1}`, plan: "a", role: "wall", child: 0, archive: 0, demount: 0,
      depth: D, height: 270, p1: { ...p1 }, p2: { ...p2 }, p1st: 0, p2st: 0,
      material: "a_block", color: 0, level: "1", show_dls: true, holes: {},
    } as never;
  }
  prepareForRestore(model);

  const editor = await openEditor(session, created.object_id, created.plan_id || "1", 30_000, { anonymous: true });
  try {
    const norm = await editor.normalize(structuredClone(model) as unknown as Record<string, unknown>, 1200);
    assert.equal(norm.after.walls, 7, "7 стен после draw");
    assert.equal(norm.rooms.length, 4, "4 комнаты");
    const areas = norm.rooms.map((r) => r.area_m2 ?? 0).sort((a, b) => b - a);
    const want = [7.84, 5.8, 5.04, 2.24];
    assert.ok(areas.every((a, i) => Math.abs(a - want[i]!) <= 0.01), `площади ${JSON.stringify(areas)} ≠ ${JSON.stringify(want)}`);
    // связи, построенные редактором из геометрии (T24: 6 edge + 8 node, 0 свободных)
    let edge = 0, node = 0, free = 0, over = 0;
    for (const w of norm.walls ?? []) {
      for (const l of [w.link1, w.link2]) {
        if (!l) free++;
        else if (l.ct === "edge") edge++;
        else if (l.ct === "node") node++;
      }
      if (w.overWall) over++;
    }
    assert.equal(free, 0, "свободных концов нет");
    assert.equal(edge, 6, "6 T-концов на гранях (edge)");
    assert.equal(node, 8, "8 узловых концов (node)");
    assert.equal(over, 0, "наложений нет");
    assert.deepEqual(Object.values(norm.errors ?? {}).filter((v) => v > 0), [], "ошибки редактора нулевые");

    const saveRes = await editor.save();
    assert.ok(saveRes.ok, `сохранение не прошло: ${JSON.stringify(saveRes)}`);
    const reloaded = await loadModel(session, editor.objectId, editor.planId);
    const walls2 = reloaded.model["walls"] as Record<string, unknown>;
    assert.equal(Object.keys(walls2).length, 7, "7 стен пережили save → GET");
    const rooms2 = (reloaded.model["rooms2"] ?? {}) as Record<string, { area?: number }>;
    const areas2 = Object.values(rooms2).map((r) => r.area ?? 0).sort((a, b) => b - a);
    assert.ok(areas2.length === 4 && areas2.every((a, i) => Math.abs(a - want[i]!) <= 0.01),
      `rooms2 после перезагрузки: ${JSON.stringify(areas2)}`);
  } finally {
    await editor.close();
  }
});

// Этап 137: normalize несёт ПЕРЕСТРОЕННЫЕ комнаты (тот же пересчёт, что делает save:
// план "a" → copyRooms1 → план "c" → draw). До фикса копия имела старые комнаты,
// и каждый save с делением/слиянием/переносом комнаты давал ложный SITE_ERROR.
// Ревью 139 m3: на делящейся стене — дверь (split_by_holes), у исходной комнаты имя:
// имя наследуют обе части (эталон ui-ref-rooms-save-split-hole.json), проём переживает
// пересчёт; двойной normalize даёт тот же результат.
test("contract: normalize повторяет пересчёт комнат сохранения — деление с дверью и именем, двойной normalize", { timeout: 240_000 }, async () => {
  const session = await anonSession();
  const created = await createAnonProject(session);
  const D = 20;
  const h = D / 2;
  const specs: [{ x: number; y: number }, { x: number; y: number }][] = [
    [{ x: 0, y: -300 }, { x: 600, y: -300 }],
    [{ x: 600, y: -300 }, { x: 600, y: 120 }],
    [{ x: 600, y: 120 }, { x: 0, y: 120 }],
    [{ x: 0, y: 120 }, { x: 0, y: -300 }],
    [{ x: 0 + h, y: 0 }, { x: 600 - h, y: 0 }],
    [{ x: 300, y: -300 + h }, { x: 300, y: 0 - h }],
    [{ x: 500, y: -300 + h }, { x: 500, y: 0 - h }],
  ];
  const model: Model = {
    v: 3, id: created.object_id, plan_id: "0",
    walls: {}, items: {}, pillars: {}, rulers: {}, comments: {},
    total_height: 270, final: false,
  };
  for (const [i, [p1, p2]] of specs.entries()) {
    model.walls[`w${i + 1}`] = {
      id: `w${i + 1}`, plan: "a", role: "wall", child: 0, archive: 0, demount: 0,
      depth: D, height: 270, p1: { ...p1 }, p2: { ...p2 }, p1st: 0, p2st: 0,
      material: "a_block", color: 0, level: "1", show_dls: true, holes: {},
    } as never;
  }
  prepareForRestore(model);

  const editor = await openEditor(session, created.object_id, created.plan_id || "1", 30_000, { anonymous: true });
  try {
    // шаг 1: база — 4 комнаты, имя у исходной (7,84 м²) через zones[0].name существующей зоны
    const norm1 = await editor.normalize(structuredClone(model) as unknown as Record<string, unknown>, 1200);
    const rooms1 = (norm1.model as { rooms2?: Record<string, { area?: number; zones?: Array<{ name?: string }> }> }).rooms2 ?? {};
    assert.equal(Object.keys(rooms1).length, 4, "база: 4 комнаты");
    const src = Object.entries(rooms1).find(([, r]) => Math.abs((r.area ?? 0) - 7.84) < 0.02);
    assert.ok(src, "исходная комната 7,84 найдена");
    src[1]!.zones![0]!.name = "Гостиная";
    const named = await editor.normalize(structuredClone(norm1.model) as unknown as Record<string, unknown>, 1200);
    const namedRooms = (named.model as { rooms2?: Record<string, { zones?: Array<{ name?: string }> }> }).rooms2 ?? {};
    assert.equal(namedRooms[src[0]!]?.zones?.[0]?.name, "Гостиная", "имя пережило повторный normalize");

    // шаг 2: деление стеной y=-150 с дверью 80 см по центру (длина стены 280 → pc.x=140)
    const withSplitter = structuredClone(named.model) as unknown as Model;
    (withSplitter as { walls: Record<string, { holes?: Record<string, unknown> }> }).walls["w8"] = {
      id: "w8", plan: "a", role: "wall", child: 0, archive: 0, demount: 0,
      depth: 10, height: 270, p1: { x: 10, y: -150 }, p2: { x: 290, y: -150 }, p1st: 0, p2st: 0,
      material: "c_pgb", color: 0, level: "1", show_dls: true,
      holes: { h_door1: { id: "h_door1", plan: "a", type: "single", group: "doors", pc: { x: 140, y: 0 }, width: 80, height: 200, depth: 4, opening: "r-l" } },
    } as never;
    prepareForRestore(withSplitter);
    const norm = await editor.normalize(withSplitter as unknown as Record<string, unknown>, 1200);
    // ревью 139 m2: сбой пересчёта комнат не откатывается молча
    assert.equal(norm.roomsRebuild, "ok", `roomsRebuild=${norm.roomsRebuild}`);
    const copy = norm.model as { walls?: Record<string, { holes?: Record<string, unknown> }>; rooms2?: Record<string, { area?: number; zones?: Array<{ name?: string }> }> };
    const copyWalls = copy.walls ?? {};
    const copyHoles = Object.values(copyWalls).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0);
    // ревью 138 m3: число стен/проёмов копии = вход (8 стен, 1 дверь)
    assert.equal(Object.keys(copyWalls).length, 8, "число стен копии = вход (8)");
    assert.equal(copyHoles, 1, "дверь пережила пересчёт комнат в копии");
    const rooms2 = copy.rooms2 ?? {};
    const areas = Object.values(rooms2).map((r) => r.area ?? 0).sort((a, b) => b - a);
    assert.equal(Object.keys(rooms2).length, 5, "в копии normalize уже перестроенные комнаты (5)");
    assert.deepEqual(areas.map((x) => Math.round(x * 100) / 100), [5.8, 5.04, 3.78, 3.78, 2.24],
      `площади в копии: ${JSON.stringify(areas)} — деление 7,84 → 2×3,78`);
    // имя у исходной комнаты: наследуют обе части (эталон 139)
    const namedParts = Object.values(rooms2).filter((r) => r.zones?.[0]?.name === "Гостиная");
    assert.equal(namedParts.length, 2, "обе части деления унаследовали имя «Гостиная»");

    // двойной normalize даёт тот же результат (спецификация этапа 139)
    const again = await editor.normalize(structuredClone(norm.model) as unknown as Record<string, unknown>, 1200);
    const againRooms = (again.model as { rooms2?: Record<string, { area?: number }> }).rooms2 ?? {};
    const againAreas = Object.values(againRooms).map((r) => r.area ?? 0).sort((a, b) => b - a);
    assert.equal(again.roomsRebuild, "ok", `повторный roomsRebuild=${again.roomsRebuild}`);
    assert.deepEqual(againAreas.map((x) => Math.round(x * 100) / 100), areas.map((x) => Math.round(x * 100) / 100),
      "двойной normalize: площади комнат совпадают");
    const againHoles = Object.values(again.model.walls ?? {}).reduce((n: number, w: { holes?: Record<string, unknown> }) => n + Object.keys(w.holes ?? {}).length, 0);
    assert.equal(againHoles, 1, "двойной normalize: дверь на месте");

    // save → GET: дверь и имена пережили save → GET
    const saveRes = await editor.save();
    assert.ok(saveRes.ok, `сохранение не прошло: ${JSON.stringify(saveRes)}`);
    const reloaded = await loadModel(session, editor.objectId, editor.planId);
    const wallsAfter = reloaded.model["walls"] as Record<string, { holes?: Record<string, unknown> }>;
    assert.equal(Object.keys(wallsAfter).length, 8, "8 стен пережили save → GET");
    const holesAfter = Object.values(wallsAfter).reduce((n, w) => n + Object.keys(w.holes ?? {}).length, 0);
    assert.equal(holesAfter, 1, "дверь пережила save → GET");
    const roomsAfter = (reloaded.model["rooms2"] ?? {}) as Record<string, { area?: number; zones?: Array<{ name?: string }> }>;
    assert.equal(Object.keys(roomsAfter).length, 5, "5 комнат после save → GET");
    const namedAfter = Object.values(roomsAfter).filter((r) => r.zones?.[0]?.name === "Гостиная");
    assert.equal(namedAfter.length, 2, "имя «Гостиная» на обеих частях после save → GET");
  } finally {
    await editor.close();
  }
});

mkdirSync(join(ROOT, "screenshots"), { recursive: true });
