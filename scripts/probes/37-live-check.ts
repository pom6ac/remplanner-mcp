// 37-doors: живая проверка раздела «Двери и проемы» через MCP-инструменты.
// 20 типов с нестандартными параметрами → model_validate → project_save → переоткрытие → сверка → render_plan.
//
// ВНИМАНИЕ: проба ОТКРЫВАЕТ и ПИШЕТ (project_save) в указанный аккаунтный проект и
// предназначена ТОЛЬКО для dev-проекта. node scripts/probes/37-live-check.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ServerContext } from "../../src/server/context.ts";
import { buildServer } from "../../src/server.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID: проба открывает (и сохраняет в) указанный проект.");
  process.exit(1);
}

type Res = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as Res).content as { text: string }[])[0]!.text;
const json = (r: unknown): any => JSON.parse(text(r));

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "37-doors-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

await client.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } });
const before = json(await client.callTool({ name: "model_get", arguments: {} }));
console.log("стен до:", before.walls.length,
  "проёмов до:", before.walls.reduce((s: number, w: any) => s + w.openings.length, 0));

// 1а. Удаляем 7 тестовых окон прошлого прогона (этап 34, артефакты пробы в dev-проекте):
// окно 130×160, windowway 120×160, windoor 200, window_door 90×230, french_window 120×240,
// french_window_coupe 120×240, french_window_double 180×240 — освобождаем место под 20 дверей.
// Новые стены не добавляем: нормализация модели проекта отвергает добавление из-за
// несоединённых концов существующих стен (INVALID_GEOMETRY) — размещаем на существующих.
const STAGE34 = [
  { wall: "mum46g7h3k", type: "windowway", w: 1200, h: 1600 },
  { wall: "e83g72t0rs", type: "window", w: 1300, h: 1600 },
  { wall: "7kmwa9hpxx", type: "windoor", w: 2000 },
  { wall: "ndikcxe1sj", type: "window_door", w: 900, h: 2300 },
  { wall: "mum46g7h3k", type: "french_window", w: 1200, h: 2400 },
  { wall: "7kmwa9hpxx", type: "french_window_coupe", w: 1200, h: 2400 },
  { wall: "mum46g7h3k", type: "french_window_double", w: 1800, h: 2400 },
];
let removedOld = 0;
for (const t of STAGE34) {
  const wall = before.walls.find((w: any) => w.site_id === t.wall);
  if (!wall) continue;
  // width_mm/height_mm в компактной модели — мм (у windoor height нет, height_mm = 0)
  const o = wall.openings.find((x: any) => x.type === t.type && Math.abs(x.width_mm - t.w) < 2 && (t.h === undefined || x.type === "windoor" || Math.abs(x.height_mm - t.h) < 20));
  if (!o) { console.error(`не найдено тестовое окно ${t.type} ${t.w} на ${t.wall}: есть ${JSON.stringify(wall.openings.map((x: any) => [x.type, x.width_mm, x.height_mm]))}`); continue; }
  await client.callTool({ name: "opening_delete", arguments: { opening_id: o.id } });
  removedOld++;
}
console.log(`удалено тестовых окон этапа 34: ${removedOld}`);
const afterRoom = json(await client.callTool({ name: "model_get", arguments: {} }));
const roomWalls = afterRoom.walls;

// 20 типов дверей с нестандартными параметрами; swing — у половины
const JOBS = [
  { type: "doorway", args: { width_mm: 1000 }, expect: { width_mm: 1000, height_mm: 2100, casing: 0 } },
  { type: "door", args: { width_mm: 900, height_mm: 2200, swing: { hinge: "start", into: "left" } },
    expect: { width_mm: 900, height_mm: 2200, opening: "l-l", casing: 1 } },
  { type: "door_double", args: { width_mm: 1400, swing: { hinge: "end", into: "right" } },
    expect: { width_mm: 1400, height_mm: 2100, opening: "r-r" } },
  { type: "door_coupe", args: { width_mm: 1000, casing: false }, expect: { width_mm: 1000, casing: 0 } },
  { type: "door_coupe_double", args: { width_mm: 1700 }, expect: { width_mm: 1700, height_mm: 2100 } },
  { type: "door_penal", args: { width_mm: 900 }, expect: { width_mm: 900 } },
  { type: "door_penal_double", args: { width_mm: 1700, casing: false }, expect: { width_mm: 1700, casing: 0 } },
  { type: "door_roto", args: { width_mm: 1000 }, expect: { width_mm: 1000 } },
  { type: "door_roto_double", args: { width_mm: 1700 }, expect: { width_mm: 1700 } },
  { type: "door_book", args: { width_mm: 900, casing: false }, expect: { width_mm: 900, casing: 0 } },
  { type: "door_book_double", args: { width_mm: 1700 }, expect: { width_mm: 1700 } },
  { type: "door_bellows", args: { width_mm: 1300 }, expect: { width_mm: 1300 } },
  { type: "door_glass", args: { width_mm: 1000, swing: { hinge: "end", into: "left" } },
    expect: { width_mm: 1000, opening: "r-l" } },
  { type: "door_garage", args: { width_mm: 2500, height_mm: 2400 },
    expect: { width_mm: 2500, height_mm: 2400, casing: 0 } },
  { type: "door_system_x2", args: { width_mm: 1800 }, expect: { width_mm: 1800 } },
  { type: "door_system_x3", args: { width_mm: 2600, casing: false }, expect: { width_mm: 2600, casing: 0 } },
  { type: "door_system_x4", args: { width_mm: 3400 }, expect: { width_mm: 3400 } },
  { type: "door_system_penal_x2", args: { width_mm: 1800 }, expect: { width_mm: 1800 } },
  { type: "door_system_penal_x3", args: { width_mm: 1200, swing: { hinge: "start", into: "right" } },
    expect: { width_mm: 1200, opening: "l-r" } },
  { type: "door_system_penal_x4", args: { width_mm: 1200 }, expect: { width_mm: 1200 } },
];

/** Свободный центр (мм от начала оси) под проём заданной ширины: зазор 150, край 150. */
function freeCenter(wall: any, widthMm: number): number | null {
  const margin = (wall.thickness_mm ?? 200) / 2 + 60;
  const ranges: [number, number][] = wall.openings.map((o: any) => [o.offset_mm, o.offset_mm + o.width_mm]);
  ranges.sort((x, y) => x[0] - y[0]);
  let cursor = margin;
  for (const [s, e] of ranges) {
    if (cursor + widthMm + 100 <= s - 100) return cursor + widthMm / 2;
    cursor = Math.max(cursor, e + 100);
  }
  if (cursor + widthMm <= wall.len_mm - margin) return cursor + widthMm / 2;
  return null;
}

// 1. Добавляем 20 проёмов на стены новой комнаты, запоминаем id и ожидаемые значения
const added: { id: string; label: string; expect: Record<string, unknown> }[] = [];
for (const job of JOBS) {
  const widthMm = (job.args.width_mm as number) ?? (job.type.includes("double") ? 1600 : 800);
  let placed = false;
  for (const wall of roomWalls) {
    if (widthMm > wall.len_mm - 600) continue;
    const center = freeCenter(wall, widthMm);
    if (center === null) continue;
    const r = json(await client.callTool({
      name: "opening_add",
      arguments: { wall_id: wall.site_id, type: job.type, center_mm: Math.round(center), ...job.args },
    }));
    if (r.code) {
      console.error(`opening_add ${job.type}: ${r.code} ${r.message ?? ""}`);
      process.exit(1);
    }
    added.push({ id: r.entity.id, label: job.type, expect: job.expect });
    wall.openings.push({ offset_mm: r.entity.offset_mm, width_mm: r.entity.width_mm });
    placed = true;
    break;
  }
  if (!placed) {
    console.error(`не нашлось свободного места под ${job.type} (${widthMm} мм)`);
    for (const wall of roomWalls) {
      console.error(`  ${wall.site_id} len=${wall.len_mm} th=${wall.thickness_mm} openings=`, JSON.stringify(wall.openings.map((o: any) => [o.type, o.offset_mm, o.width_mm])));
    }
    process.exit(1);
  }
}
console.log(`добавлено проёмов: ${added.length}`);

// 2. Инварианты и сохранение
const issues = json(await client.callTool({ name: "model_validate", arguments: {} }));
if (Array.isArray(issues) && issues.length > 0) {
  console.error("model_validate:", JSON.stringify(issues).slice(0, 500));
  process.exit(1);
}
const saved = json(await client.callTool({ name: "project_save", arguments: { comment: "probe 37-doors live check" } }));
console.log("save:", JSON.stringify({ save_id: saved.save_id, will_delete: saved.will_delete, warnings: saved.warnings }).slice(0, 300));

// 3. Переоткрытие в чистом контексте и сверка по всем заявленным параметрам
const ctx2 = new ServerContext();
const server2 = buildServer(ctx2);
const client2 = new Client({ name: "37-doors-live-reopen", version: "0.0.0" });
const [a2, b2] = InMemoryTransport.createLinkedPair();
await Promise.all([server2.connect(b2), client2.connect(a2)]);
await client2.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } });
const after = json(await client2.callTool({ name: "model_get", arguments: {} }));
const byId = new Map<string, any>(after.walls.flatMap((w: any) => w.openings.map((o: any) => [o.id, o])));

let failed = 0;
for (const a of added) {
  const o = byId.get(a.id);
  if (!o) {
    console.error(`✖ ${a.label}: проём ${a.id} исчез после save → reopen`);
    failed++;
    continue;
  }
  for (const [k, v] of Object.entries(a.expect)) {
    const got = k.split(".").reduce((acc: any, key: string) => acc?.[key], o);
    if (got !== v) {
      console.error(`✖ ${a.label} (${a.id}): ${k} = ${JSON.stringify(got)}, ожидалось ${JSON.stringify(v)}`);
      failed++;
    }
  }
}
console.log(failed === 0 ? `сверка после reopen: все ${added.length} проёмов совпали` : `сверка после reopen: расхождений ${failed}`);

// 4. render_plan (визуальная проверка)
const render = await client.callTool({ name: "render_plan", arguments: { sheet: "init" } });
const rtext = text(render);
const rjson = (() => { try { return JSON.parse(rtext); } catch { return null; } })();
console.log("render:", render.isError ? rtext.slice(0, 300) : JSON.stringify({ save_path: rjson?.save_path ?? rjson?.path, revision: rjson?.revision ?? null }).slice(0, 300));
if (rjson?.save_path) {
  const { copyFileSync } = await import("node:fs");
  copyFileSync(rjson.save_path, ".orca-reports/37-live-render.png");
  console.log("copied to .orca-reports/37-live-render.png");
}
process.exit(failed === 0 ? 0 : 1);
