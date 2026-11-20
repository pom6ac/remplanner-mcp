// 322: регрессионные тесты находок повторного ревью 321 (PR #49 zone_c).
// N1 (сценарий C из .orca-reports/tmp/321-repro.test.ts): post-save сверка
// комнат — база norm.model (отправленное ожидание), не roomSaveBase: если
// сервер при записи потерял именованную зону из отправленной нормализованной
// модели в комнате с изменённым набором zone_c-делителей, save НЕ verified
// (SITE_ERROR), это не штатное «деление зон».
// N2: resurrectedZoneCDividers в комнатах, затронутых изменёнными стенами, —
// воскрешённый делитель, который был в базе (roomSaveBase), — предупреждение,
// а придуманный (в базе его не было) — отказ.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Model } from "../../src/model/types.ts";
import { addZoneDelimiter, resurrectedZoneCDividers } from "../../src/model/zone.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";

const REF = JSON.parse(readFileSync("tests/fixtures/ui-ref-zonec-delimiter.json", "utf8"));
const COMPAT = { global_version: null, planner_version: null, bundles: [], object_id: null, plan_id: null, present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } };
const rec = Object.values(REF.zone_delimiters)[0] as Record<string, unknown>;
const pts = (r: Record<string, unknown>) => ((r["vertexes"]) as Array<{ point: { x: number; y: number } }>).map((v) => ({ x: Math.round(v.point.x * 10), y: Math.round(v.point.y * 10) }));

function base(): { m: Model; room: string } {
  const m = (JSON.parse(readFileSync("tests/fixtures/editor-corridor-3rooms.json", "utf8")) as { model: Model }).model;
  const rooms = m.rooms2 as Record<string, Record<string, unknown>>;
  const room = Object.keys(rooms)[0]!;
  rooms[room]!["polygon"] = structuredClone(REF.room.polygon);
  rooms[room]!["edges"] = structuredClone(REF.room.edges);
  delete rooms[room]!["delimiters"]; delete rooms[room]!["rigels"];
  rooms[room]!["zones"] = [{ polygon: REF.room.polygon, exist: true, name: "Кухня" }, { polygon: REF.room.polygon, exist: true, name: "Столовая" }];
  return { m, room };
}

test("321 N1 C: post-save — сервер потерял именованную зону в комнате с изменённым набором делителей → SITE_ERROR", async () => {
  const { m, room } = base();
  const p = pts(rec);
  addZoneDelimiter(m, room, { type: "zone_c", fromMm: p[0]!, toMm: p[1]! });
  const server = { model: structuredClone(m) as unknown as Record<string, unknown> };
  let normalized: Record<string, unknown> | null = null;
  const editor = {
    objectId: "0", planId: "1",
    async normalize(mm: Record<string, unknown>) {
      normalized = structuredClone(mm as object) as Record<string, unknown>;
      const c = { walls: Object.keys(mm.walls as object).length, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      // сервер при записи теряет «Кухня» (зоны в отправленной модели сохранены)
      server.model = structuredClone(normalized!);
      (server.model["rooms2"] as Record<string, Record<string, unknown>>)[room]!["zones"] = [{ polygon: REF.room.polygon, exist: false, name: "none" }, { polygon: REF.room.polygon, exist: true, name: "Столовая" }];
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); }, async compatInfo() { return COMPAT as never; }, async close() {},
  } as unknown as EditorLike;
  const deps = { session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> { return { object_id: "0", plan_id: "1", save_id: "s1", units: "cm", data_empty: false, model: structuredClone(server.model) }; },
    async openEditor() { return editor; } } as unknown as WorkspaceDeps;
  const ws = new Workspace(deps); (ws as unknown as { writeBackup: () => string }).writeBackup = () => "/mock";
  await ws.open("0", "1");
  // D2 — параллельно D1, смещён на 50 см по перпендикуляру
  const dx = p[1]!.x - p[0]!.x, dy = p[1]!.y - p[0]!.y; const L = Math.hypot(dx, dy); const ox = Math.round(-dy / L * 500), oy = Math.round(dx / L * 500);
  ws.apply("zone_c_add", (mm) => addZoneDelimiter(mm, room, { type: "zone_c", fromMm: { x: p[0]!.x + ox, y: p[0]!.y + oy }, toMm: { x: p[1]!.x + ox, y: p[1]!.y + oy } }));
  await assert.rejects(
    () => ws.save(),
    (e: unknown) => {
      const err = e as { code?: string; message?: string; details?: { room_mismatches?: string[] } };
      if (err.code !== "SITE_ERROR") return false;
      if (!String(err.message).includes("после сохранения модель на сервере не совпала")) return false;
      const mism = err.details?.room_mismatches ?? [];
      return mism.some((s) => s.includes("зоны"));
    },
    "ожидался SITE_ERROR с расхождением зон, получено verified (сервер испортил зоны незамеченным)",
  );
});
