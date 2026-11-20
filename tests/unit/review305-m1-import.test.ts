// 305 M1 (ревью 304): схема импорта rooms2[].rigels — мусор и превышение лимита
// отклоняются, живой формат (эталон 303) проходит.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseModelImport } from "../../src/model/import-schema.ts";

const REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-zones3-ceiling-rigel.json", "utf8")) as {
  room: { polygon: { x: number; y: number }[] };
  rigels: Record<string, Record<string, unknown>>;
};

function baseModel(): Record<string, unknown> {
  return { v: 1, plan_id: "1", walls: {}, items: {}, pillars: {} };
}

// ---------- M1: схема импорта rooms2[].rigels ----------

test("305 M1: мусор в rooms2[].rigels отклоняется импортом (схема+лимиты)", () => {
  const m = {
    ...baseModel(),
    rooms2: { a: { rigels: { r1: { p1: "x", p2: 5, width: -1e9, polygon: "bad" } } } },
  };
  assert.throws(() => parseModelImport(m), (e: unknown) => {
    const msg = (e as Error).message;
    assert.match(msg, /model\.rooms2\.a\.rigels/);
    return true;
  });
});

test("305 M1: превышение лимита числа закладных по комнатам отклоняется", () => {
  const mk = (i: number) => ({ id: `r${i}`, p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 }, width: 10 });
  const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`r${i}`, mk(i)]));
  const m = { ...baseModel(), rooms2: { a: { rigels: many }, b: { rigels: { z: mk(0) } } } };
  assert.throws(() => parseModelImport(m), /лимит|слишком много/);
});

test("305 M1: живой формат закладной (эталон 303) проходит импорт", () => {
  const m = {
    ...baseModel(),
    rooms2: {
      room1: {
        polygon: structuredClone(REF.room.polygon),
        rigels: structuredClone(REF.rigels),
      },
    },
  };
  const out = parseModelImport(m) as Record<string, unknown>;
  const room = ((out["rooms2"] as Record<string, Record<string, unknown>>)["room1"] ?? {}) as Record<string, unknown>;
  assert.ok(room["rigels"], "закладная прошла импорт");
});

