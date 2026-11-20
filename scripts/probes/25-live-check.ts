// 25-windows: живая проверка раздела «Окна» через MCP-инструменты.
// 7 типов с нестандартными параметрами → model_validate → project_save → переоткрытие → сверка → render_plan.
//
// ВНИМАНИЕ: проба ОТКРЫВАЕТ и ПИШЕТ (project_save) в указанный аккаунтный проект и
// предназначена ТОЛЬКО для dev-проекта; как доказательство живого сценария не используется.
// node scripts/probes/25-live-check.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ServerContext } from "../../src/server/context.ts";
import { buildServer } from "../../src/server.ts";
import { refuseLegacyProbe } from "./probe-guard.ts";
refuseLegacyProbe(); // 322 N3г: старая пишущая проба без гардов — запуск запрещён

// Проект для пробы задаётся env: проба открывает указанный проект, а 25-live-check
// ещё и сохраняет в него. Без env — отказ (ревью 26, №5).
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID: проба открывает (25-live-check — и сохраняет в) указанный проект.");
  process.exit(1);
}

type Res = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as Res).content as { text: string }[])[0]!.text;
const json = (r: unknown): any => JSON.parse(text(r));

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "25-windows-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

await client.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } });
const before = json(await client.callTool({ name: "model_get", arguments: {} }));

// стены для окон: без проёмов, с запасом длины
const WALLS = ["mum46g7h3k", "e83g72t0rs", "7kmwa9hpxx", "ndikcxe1sj"];
const wallInfo = before.walls.filter((w: any) => WALLS.includes(w.site_id));
console.log("стены:", wallInfo.map((w: any) => `${w.site_id} len=${w.len_mm} openings=${w.openings.length}`));

// expect — поля компактной модели (model_get) после переоткрытия; door_position: right
// не используется — right отвергается валидатором (ревью 26)
const JOBS = [
  { type: "windowway", args: { width_mm: 1200, height_mm: 1600, sill_height_mm: 900, casements: 2, slope_angle_deg: 10, sill_thickness_mm: 60 },
    expect: { width_mm: 1200, height_mm: 1600, sill_mm: 900, casements: 2, slope_angle_deg: 10, "sill.thickness_mm": 60 } },
  { type: "window", args: { width_mm: 1300, height_mm: 1600, casements: 2, sill_overhang_mm: 50 },
    expect: { width_mm: 1300, height_mm: 1600, casements: 2, "sill.overhang_mm": 50 } },
  { type: "window_balcony", args: { window_width_mm: 1000, door_width_mm: 800, door_position: "left", window_height_mm: 1600, door_height_mm: 2200 },
    expect: { width_mm: 1800, window_width_mm: 1000, door_width_mm: 800, window_height_mm: 1600, door_height_mm: 2200, door_position: "l" } },
  { type: "window_door", args: { width_mm: 900, height_mm: 2300, impost_height_mm: 1400 },
    expect: { width_mm: 900, height_mm: 2300, sill_mm: 100, impost_offset_mm: 1300 } },
  { type: "french_window", args: { width_mm: 1200, height_mm: 2400, slope_angle_deg: 15, sill_thickness_mm: 60 },
    expect: { width_mm: 1200, height_mm: 2400, slope_angle_deg: 15, "sill.thickness_mm": 60 } },
  { type: "french_window_coupe", args: { width_mm: 1200, height_mm: 2400 },
    expect: { width_mm: 1200, height_mm: 2400 } },
  { type: "french_window_double", args: { width_mm: 1800, height_mm: 2400, sill_overmeasure_mm: 30 },
    expect: { width_mm: 1800, height_mm: 2400, "sill.overmeasure_mm": 30 } },
];

/** Свободный центр (мм от начала оси) под проём заданной ширины: зазор 300, край 300. */
function freeCenter(wall: any, widthMm: number): number | null {
  const ranges: [number, number][] = wall.openings.map((o: any) => [o.offset_mm, o.offset_mm + o.width_mm]);
  ranges.sort((x, y) => x[0] - y[0]);
  let cursor = 300;
  for (const [s, e] of ranges) {
    if (cursor + widthMm + 300 <= s - 300) return cursor + widthMm / 2;
    cursor = Math.max(cursor, e + 300);
  }
  if (cursor + widthMm <= wall.len_mm - 300) return cursor + widthMm / 2;
  return null;
}

// 1. Добавляем 7 проёмов, запоминаем id и ожидаемые значения
const added: { id: string; label: string; expect: Record<string, unknown> }[] = [];
for (const [i, job] of JOBS.entries()) {
  const widthMm = (job.args.width_mm as number) ?? (job.args.window_width_mm as number) + (job.args.door_width_mm as number);
  let placed = false;
  for (let k = 0; k < WALLS.length && !placed; k++) {
    const wall = before.walls.find((w: any) => w.site_id === WALLS[(i + k) % WALLS.length]);
    if (!wall) continue;
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
    // freeCenter считает по этой же структуре — сразу учесть добавленный проём
    wall.openings.push({ offset_mm: r.entity.offset_mm, width_mm: r.entity.width_mm });
    placed = true;
  }
  if (!placed) {
    console.error(`не нашлось свободного места под ${job.type} (${widthMm} мм)`);
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
const saved = json(await client.callTool({ name: "project_save", arguments: { comment: "probe 25-windows live check" } }));
console.log("save:", JSON.stringify({ save_id: saved.save_id, will_delete: saved.will_delete, warnings: saved.warnings }).slice(0, 300));

// 3. Переоткрытие в чистом контексте и сверка по всем заявленным параметрам
const ctx2 = new ServerContext();
const server2 = buildServer(ctx2);
const client2 = new Client({ name: "25-windows-live-reopen", version: "0.0.0" });
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

// 4. render_plan (визуальная проверка) — в первом контексте, модель уже сохранена
const render = await client.callTool({ name: "render_plan", arguments: { sheet: "init" } });
const rtext = text(render);
const rjson = (() => { try { return JSON.parse(rtext); } catch { return null; } })();
console.log("render:", render.isError ? rtext.slice(0, 300) : JSON.stringify({ save_path: rjson?.save_path ?? rjson?.path, revision: rjson?.revision ?? null }).slice(0, 300));
if (rjson?.save_path) {
  const { copyFileSync } = await import("node:fs");
  copyFileSync(rjson.save_path, ".orca-reports/25-live-render.png");
  console.log("copied to .orca-reports/25-live-render.png");
}
process.exit(failed === 0 ? 0 : 1);
