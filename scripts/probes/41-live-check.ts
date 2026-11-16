// 41-pillars: живая проверка раздела «Несущая колонна» через MCP-инструменты.
// Колонны с нестандартными параметрами → model_validate → project_save → переоткрытие → сверка → render_plan.
//
// ВНИМАНИЕ: проба ОТКРЫВАЕТ и ПИШЕТ (project_save) в указанный аккаунтный проект и
// предназначена ТОЛЬКО для dev-проекта. node scripts/probes/41-live-check.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { copyFileSync } from "node:fs";
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
const client = new Client({ name: "41-pillars-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

await client.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } });
const full = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
const rooms: { id: string; polygon: { x: number; y: number }[] }[] = Object.entries<any>(full.rooms2 ?? {})
  .map(([id, r]) => ({ id, polygon: r.polygon ?? r.points ?? [] }));
console.log("комнат с полигонами:", rooms.length);

const distToSeg = (p: any, a1: any, a2: any) => {
  const dx = a2.x - a1.x, dy = a2.y - a1.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a1.x) * dx + (p.y - a1.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a1.x + dx * t), p.y - (a1.y + dy * t));
};
const wallsAll = Object.values<any>(full.walls ?? {});

function freeSpotIn(room: { polygon: { x: number; y: number }[] }, marginCm: number, minDistCm: number): { x: number; y: number } | null {
  const xs = room.polygon.map((p) => p.x), ys = room.polygon.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const inPoly = (p: any) => {
    let inside = false;
    const poly = room.polygon;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
      if (((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  for (let r = 0; r <= Math.max(maxX - minX, maxY - minY); r += 15) {
    for (let ang = 0; ang < 360; ang += 20) {
      const p = { x: (minX + maxX) / 2 + r * Math.cos(ang * Math.PI / 180), y: (minY + maxY) / 2 + r * Math.sin(ang * Math.PI / 180) };
      if (p.x < minX + marginCm || p.x > maxX - marginCm || p.y < minY + marginCm || p.y > maxY - marginCm) continue;
      if (!inPoly(p)) continue;
      if (wallsAll.every((w) => distToSeg(p, w.p1, w.p2) > minDistCm)) return p;
    }
  }
  return null;
}

// 0. Чистим колонны прошлых прогонов
const beforeCompact = json(await client.callTool({ name: "model_get", arguments: {} }));
for (const p of beforeCompact.pillars ?? []) {
  const del = json(await client.callTool({ name: "pillar_delete", arguments: { pillar_id: p.site_id } }));
  if (del.code) { console.error(`pillar_delete ${p.site_id}:`, del.code, del.message ?? ""); process.exit(1); }
  console.log("удалена колонна прошлого прогона:", p.site_id);
}

let room = rooms[0];
let spot: { x: number; y: number } | null = null;
for (const r of rooms) {
  for (const margin of [70, 50, 40]) {
    spot = freeSpotIn(r, margin, margin);
    if (spot) { room = r; break; }
  }
  if (spot) break;
}
if (!room || !spot) { console.error("нет свободной точки ни в одной комнате"); process.exit(1); }
console.log("комната:", room.id);
let spot2: { x: number; y: number } | null = spot ? freeSpotIn(room, 100, 100) : null;
if (!spot2) {
  // вторая точка в другой комнате
  for (const r of rooms) {
    if (r.id === room.id) continue;
    spot2 = freeSpotIn(r, 60, 60);
    if (spot2) { console.log("вторая точка в комнате:", r.id); break; }
  }
}
if (!spot2) { console.error("нет второй точки"); process.exit(1); }

// 1. Колонны с нестандартными параметрами
const added: { id: string; label: string; expect: Record<string, unknown> }[] = [];
const add = (label: string, args: Record<string, unknown>, expect: Record<string, unknown>) => {
  const r = json((null as unknown) as any); void r; void label; void args; void expect;
};

void add;

// свободно стоящая 300×400
const c1 = json(await client.callTool({ name: "pillar_add", arguments: { center: { x: Math.round(spot.x * 10), y: Math.round(spot.y * 10) }, width_mm: 300, height_mm: 400 } }));
if (c1.code) { console.error("pillar_add 1:", c1.code, c1.message); process.exit(1); }
added.push({ id: c1.entity.site_id, label: "free 300×400", expect: { width_mm: 300, depth_mm: 400, angle_deg: 0, x_mm: c1.entity.x_mm, y_mm: c1.entity.y_mm } });
console.log("+ free 300×400:", c1.entity.site_id, c1.entity.x_mm, c1.entity.y_mm);

// повёрнутая 250×250 на 30°
if (!spot2) { console.error("нет второй точки"); process.exit(1); }
const c2 = json(await client.callTool({ name: "pillar_add", arguments: { center: { x: Math.round(spot2.x * 10), y: Math.round(spot2.y * 10) }, width_mm: 250, height_mm: 250, angle_deg: 30 } }));
if (c2.code) { console.error("pillar_add 2:", c2.code, c2.message); process.exit(1); }
added.push({ id: c2.entity.site_id, label: "rotated 250×250/30°", expect: { width_mm: 250, depth_mm: 250, angle_deg: 30 } });
console.log("+ rotated 250×250 30°:", c2.entity.site_id, c2.entity.x_mm, c2.entity.y_mm);

// прижатая к стене: центр в 25 мм выше грани y=88 стены 7kmwa9hpxx (как в эталоне UI),
// габариты 250×150 → прижатие до грани (eds.b)
const W = wallsAll.find((w) => w.id === "7kmwa9hpxx") ?? wallsAll[0];
const faceY = Math.max(W.p1.y, W.p2.y) - W.depth / 2; // верхняя грань (Y вниз: меньшая координата)
// грани стены по оси: для горизонтальной стены — min/± depth/2
const faceTop = W.p1.y - W.depth / 2;
const px = { x: 4520, y: Math.round((faceY - 7.5 - 2.5) * 10) }; // центр в 25 мм от итоговой позиции (грань на грани стены)
const c3 = json(await client.callTool({ name: "pillar_add", arguments: { center: px, width_mm: 250, height_mm: 150 } }));
if (c3.code) { console.error("pillar_add 3:", c3.code, c3.message); process.exit(1); }
added.push({ id: c3.entity.site_id, label: "wall-adjacent 250×150", expect: { width_mm: 250, depth_mm: 150, angle_deg: 0 } });
console.log("+ wall-adjacent:", c3.entity.site_id, c3.entity.x_mm, c3.entity.y_mm, "(ожидался прижим к грани y =", faceY, "см)");

// 2. Цепочка update: перенос, габариты, поворот
const up1 = json(await client.callTool({ name: "pillar_update", arguments: { pillar_id: c1.entity.site_id, center: { x: c1.entity.x_mm + 300, y: c1.entity.y_mm } } }));
if (up1.code) { console.error("pillar_update 1:", up1.code, up1.message); process.exit(1); }
added.find((x) => x.id === c1.entity.site_id)!.expect.x_mm = up1.entity.x_mm;
added.find((x) => x.id === c1.entity.site_id)!.expect.y_mm = up1.entity.y_mm;
const up2 = json(await client.callTool({ name: "pillar_update", arguments: { pillar_id: c2.entity.site_id, width_mm: 350, angle_deg: 15 } }));
if (up2.code) { console.error("pillar_update 2:", up2.code, up2.message); process.exit(1); }
added.find((x) => x.id === c2.entity.site_id)!.expect.width_mm = 350;
added.find((x) => x.id === c2.entity.site_id)!.expect.angle_deg = 15;
console.log("update-цепочка: ok");

// 3. Ошибочные вызовы не меняют модель
const snapshot = json(await client.callTool({ name: "model_get", arguments: {} }));
const bad1 = json(await client.callTool({ name: "pillar_add", arguments: { center: { x: 999999, y: 999999 } } }));
const bad2 = json(await client.callTool({ name: "pillar_add", arguments: { center: { x: 4520, y: 1005 }, width_mm: 99999999 } }));
console.log("ошибки как ожидалось:", bad1.code ?? "НЕТ ОШИБКИ?!", "/", bad2.code ?? "НЕТ ОШИБКИ?!");
const snapshot2 = json(await client.callTool({ name: "model_get", arguments: {} }));
console.log("модель после ошибок не изменилась:", JSON.stringify(snapshot) === JSON.stringify(snapshot2));

// 4. Валидация и сохранение
const issues = json(await client.callTool({ name: "model_validate", arguments: {} }));
if (Array.isArray(issues) && issues.length > 0) {
  console.error("model_validate:", JSON.stringify(issues).slice(0, 600));
  process.exit(1);
}
const saved = json(await client.callTool({ name: "project_save", arguments: { comment: "probe 41-pillars live check" } }));
console.log("save:", JSON.stringify({ save_id: saved.save_id, will_delete: saved.will_delete, warnings: saved.warnings }).slice(0, 400));

// 5. Переоткрытие в чистом контексте и сверка
const ctx2 = new ServerContext();
const server2 = buildServer(ctx2);
const client2 = new Client({ name: "41-pillars-reopen", version: "0.0.0" });
const [a2, b2] = InMemoryTransport.createLinkedPair();
await Promise.all([server2.connect(b2), client2.connect(a2)]);
await client2.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } });
const after = json(await client2.callTool({ name: "model_get", arguments: {} }));
const byId = new Map<string, any>((after.pillars ?? []).map((p: any) => [p.site_id, p]));

let failed = 0;
for (const a of added) {
  const p = byId.get(a.id);
  if (!p) { console.error(`✖ ${a.label}: колонна ${a.id} исчезла после save → reopen`); failed++; continue; }
  for (const [k, v] of Object.entries(a.expect)) {
    if (p[k] !== v) {
      console.error(`✖ ${a.label} (${a.id}): ${k} = ${JSON.stringify(p[k])}, ожидалось ${JSON.stringify(v)}`);
      failed++;
    }
  }
}
console.log(failed === 0 ? `сверка после reopen: все ${added.length} колонн совпали` : `сверка после reopen: расхождений ${failed}`);

// 6. render_plan
const render = await client2.callTool({ name: "render_plan", arguments: { sheet: "init" } });
const rtext = ((render as Res).content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
const rjson = (() => { try { return JSON.parse(rtext); } catch { return null; } })();
console.log("render:", render.isError ? rtext.slice(0, 300) : JSON.stringify({ path: rjson?.path, revision: rjson?.revision ?? null }).slice(0, 400));
if (rjson?.path) {
  copyFileSync(rjson.path, ".orca-reports/41-live-render.png");
  console.log("copied to .orca-reports/41-live-render.png");
}
process.exit(failed === 0 ? 0 : 1);
