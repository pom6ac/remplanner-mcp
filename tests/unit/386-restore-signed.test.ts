// 386 (ревью 385 №36): restore в finally живых проб по ЗНАКОВОМУ смещению.
// Прежний беззнаковый hypot (rawShiftMm) при сбое save уводил стену dev-объекта
// в обратную сторону: wall_move −20 прошёл (копия на 0), save упал до записи
// (сервер +20) → finally off=20 → wall_move(-20) на копии с 0 → −20.
// Проверка офлайн: формула signedWallShiftMm согласована с moveWall
// (src/model/walls.ts — v = leftNormal(u) * mmToCm(offsetMm)) по знаку и
// величине; restoreDecision — none/−shift/refuse >25 мм; NaN — fail-closed.
import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "../../src/model/types.ts";
import { addWall, moveWall } from "../../src/model/walls.ts";
import {
  signedWallShiftMm, restoreDecision,
  RESTORE_TOLERANCE_MM, RESTORE_MAX_MM,
} from "../../scripts/probes/probe-wall-restore.ts";

/** Офлайн-модель: одна стена 1000 мм по +X, ось (0,0)→(1000,0) мм. */
function oneWall(): { model: Model; id: string } {
  const model = { walls: {} } as unknown as Model;
  const w = addWall(model, { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } });
  return { model, id: w.id };
}

test("386 №36: signedWallShiftMm согласован с moveWall по знаку и величине (+20 мм)", () => {
  const { model, id } = oneWall();
  const journal = { from: [0, 0] as [number, number], to: [1000, 0] as [number, number] };
  assert.equal(signedWallShiftMm(journal, model.walls[id]!), 0, "до мутации сдвиг 0");
  moveWall(model, { wallId: id, offsetMm: 20 });
  // RAW-вид серверной модели: p1/p2 в см
  const raw = model.walls[id]!;
  assert.ok(Math.abs(signedWallShiftMm(journal, raw) - 20) < 0.01, "после moveWall(+20) знаковый сдвиг ≈ +20 мм");
  const d = restoreDecision(signedWallShiftMm(journal, raw));
  assert.deepEqual(d, { action: "move", offsetMm: -20 }, "решение: вернуть на −20 мм");
  // применение решения возвращает ось точно (корректно и при сбое save —
  // смещение считается по серверной модели, а не по рабочей копии)
  moveWall(model, { wallId: id, offsetMm: d.action === "move" ? d.offsetMm : 0 });
  assert.ok(Math.abs(signedWallShiftMm(journal, model.walls[id]!)) < 0.01, "после restore сдвиг ≈ 0");
});

test("386 №36: знаковость — сдвиг в другую сторону даёт обратное смещение restore", () => {
  const { model, id } = oneWall();
  const journal = { from: [0, 0] as [number, number], to: [1000, 0] as [number, number] };
  moveWall(model, { wallId: id, offsetMm: -20 });
  const raw = model.walls[id]!;
  assert.ok(Math.abs(signedWallShiftMm(journal, raw) + 20) < 0.01, "после moveWall(−20) знаковый сдвиг ≈ −20 мм");
  const d = restoreDecision(signedWallShiftMm(journal, raw));
  assert.deepEqual(d, { action: "move", offsetMm: 20 }, "решение: вернуть на +20 мм (беззнаковый hypot дал бы −20 — уход стены дальше)");
});

test("386 №36: вертикальная ось — нормаль поворачивается вместе со стеной", () => {
  const model = { walls: {} } as unknown as Model;
  const w = addWall(model, { start: { x: 0, y: 0 }, end: { x: 0, y: 1000 } });
  const journal = { from: [0, 0] as [number, number], to: [0, 1000] as [number, number] };
  moveWall(model, { wallId: w.id, offsetMm: 20 });
  assert.ok(Math.abs(signedWallShiftMm(journal, model.walls[w.id]!) - 20) < 0.01, "сдвиг по нормали вертикальной стены ≈ +20 мм");
});

test("386 №36: сдвиг вдоль оси (не перпендикулярный) не считается — wall_move его не даёт", () => {
  const journal = { from: [0, 0] as [number, number], to: [1000, 0] as [number, number] };
  // RAW: стена уехала вдоль оси на 2 см, перпендикулярного сдвига нет
  const raw = { p1: { x: 2, y: 0 }, p2: { x: 102, y: 0 } };
  assert.equal(signedWallShiftMm(journal, raw), 0, "проекция на нормаль = 0");
  assert.deepEqual(restoreDecision(signedWallShiftMm(journal, raw)), { action: "none" });
});

test("386 №36: пороги решения — допуск 2 мм, отказ > 25 мм", () => {
  assert.ok(RESTORE_TOLERANCE_MM === 2 && RESTORE_MAX_MM === 25);
  assert.deepEqual(restoreDecision(0.1), { action: "none" });
  assert.deepEqual(restoreDecision(2), { action: "none" });
  assert.deepEqual(restoreDecision(-2), { action: "none" });
  assert.deepEqual(restoreDecision(2.1), { action: "move", offsetMm: -2.1 });
  assert.deepEqual(restoreDecision(25), { action: "move", offsetMm: -25 });
  assert.deepEqual(restoreDecision(25.1), { action: "refuse" });
  assert.deepEqual(restoreDecision(-25.1), { action: "refuse" });
});

test("386 №36: неизвестное состояние RAW (нет p1/p2, нулевая ось) — NaN → refuse (fail-closed)", () => {
  const journal = { from: [0, 0] as [number, number], to: [1000, 0] as [number, number] };
  assert.ok(Number.isNaN(signedWallShiftMm(journal, {})));
  assert.ok(Number.isNaN(signedWallShiftMm(journal, { p1: { x: 1, y: 0 } })));
  assert.ok(Number.isNaN(signedWallShiftMm(journal, { p1: { x: "a", y: 0 }, p2: { x: 2, y: 0 } })));
  assert.ok(Number.isNaN(signedWallShiftMm(journal, { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 } })), "нулевая ось — NaN");
  assert.deepEqual(restoreDecision(NaN), { action: "refuse" });
});
