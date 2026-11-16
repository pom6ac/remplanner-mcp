// 47-rigels: живая проверка раздела «Потолочный ригель» через MCP-инструменты.
// Ригели с нестандартными параметрами → model_validate → project_save → переоткрытие → сверка → render_plan.
//
// ВНИМАНИЕ: проба ОТКРЫВАЕТ и ПИШЕТ (project_save) в указанный аккаунтный проект и
// предназначена ТОЛЬКО для dev-проекта. node scripts/probes/47-live-check.ts
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
const client = new Client({ name: "47-rigels-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

await client.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } });
const full = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
const wallsAll = Object.values<any>(full.walls ?? {});
const pillarsAll = Object.values<any>(full.pillars ?? {});
console.log("стен:", wallsAll.length, "колонн:", pillarsAll.length, "ригелей:", Object.keys(full.rigels ?? {}).length);

// 0. Чистим ригели прошлых прогонов
const beforeCompact = json(await client.callTool({ name: "model_get", arguments: {} }));
for (const r of beforeCompact.rigels ?? []) {
  const del = json(await client.callTool({ name: "rigel_delete", arguments: { rigel_id: r.site_id } }));
  if (del.code) { console.error(`rigel_delete ${r.site_id}:`, del.code, del.message ?? ""); process.exit(1); }
  console.log("удалён ригель прошлого прогона:", r.site_id);
}

// Точка на грани стены (для прилипания) и свободные точки для диагональной оси.
// Стена без проёмов и без колонн рядом — берём самую длинную.
function wallFacePoint(): { wall: any; face: { x: number; y: number }; away: { x: number; y: number } } | null {
  for (const w of wallsAll) {
    const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
    if (len < 300 || Object.keys(w.holes ?? {}).length > 0) continue;
    // нет колонн в средней трети стены
    const mid = { x: (w.p1.x + w.p2.x) / 2, y: (w.p1.y + w.p2.y) / 2 };
    if (!pillarsAll.every((p) => Math.hypot(p.pc.x - mid.x, p.pc.y - mid.y) > 120)) continue;
    const n = { x: (w.p2.y - w.p1.y) / len, y: -(w.p2.x - w.p1.x) / len }; // нормаль влево
    const face = { x: mid.x, y: mid.y }; // ось == грань? нет: грань = ось + n*depth/2
    face.x += n.x * (w.depth / 2);
    face.y += n.y * (w.depth / 2);
    // точка оси посередине (ригель диагонально от грани)
    const axis = { x: mid.x + (w.p2.x - w.p1.x) / len * 40, y: mid.y + (w.p2.y - w.p1.y) / len * 40 };
    const away = { x: axis.x + n.x * 100, y: axis.y + n.y * 100 };
    return { wall: w, face, away };
  }
  return null;
}

// 1. Ригели с нестандартными параметрами
const added: { id: string; label: string; expect: Record<string, unknown> }[] = [];

// свободный диагональный ригель 150×250 вдали от стен/колонн
const freeSpot = (() => {
  const xs = wallsAll.flatMap((w) => [w.p1.x, w.p2.x]);
  const ys = wallsAll.flatMap((w) => [w.p1.y, w.p2.y]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const distSeg = (p: any, a1: any, a2: any) => {
    const dx = a2.x - a1.x, dy = a2.y - a1.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((p.x - a1.x) * dx + (p.y - a1.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a1.x + dx * t), p.y - (a1.y + dy * t));
  };
  const pillarEdgeDist = (p: any) => Math.min(...pillarsAll.map((pi: any) => {
    const dx = Math.abs(p.x - pi.pc.x) - pi.width / 2;
    const dy = Math.abs(p.y - pi.pc.y) - pi.height / 2;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  }));
  for (let r = 0; r <= 600; r += 20) {
    for (let ang = 0; ang < 360; ang += 12) {
      const p = { x: cx + r * Math.cos(ang * Math.PI / 180), y: cy + r * Math.sin(ang * Math.PI / 180) };
      if (!wallsAll.every((w) => distSeg(p, w.p1, w.p2) > 100)) continue;
      if (pillarEdgeDist(p) <= 100) continue;
      return p;
    }
  }
  return null;
})();
if (!freeSpot) { console.error("нет свободной точки для ригеля"); process.exit(1); }
const spot2 = { x: freeSpot.x + 60, y: freeSpot.y + 20 };

const r1 = json(await client.callTool({ name: "rigel_add", arguments: {
  start: { x: Math.round(freeSpot.x * 10), y: Math.round(freeSpot.y * 10) },
  end: { x: Math.round(spot2.x * 10), y: Math.round(spot2.y * 10) },
  depth_mm: 150, height_mm: 250,
} }));
if (r1.code) { console.error("rigel_add 1:", r1.code, r1.message); process.exit(1); }
added.push({ id: r1.entity.site_id, label: "free 150×250 diag", expect: { depth_mm: 150, height_mm: 250, ceiling_type: "" } });
console.log("+ free:", r1.entity.site_id, JSON.stringify(r1.entity.from), "→", JSON.stringify(r1.entity.to));

// ригель с прилипанием к стене: конец на грани, ось под углом
const spot = wallFace();
function wallFace(): { wall: any; face: { x: number; y: number }; away: { x: number; y: number } } | null {
  for (const w of wallsAll) {
    const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
    if (len < 200) continue;
    const u = { x: (w.p2.x - w.p1.x) / len, y: (w.p2.y - w.p1.y) / len };
    const n = { x: u.y, y: -u.x };
    const holes = Object.values<any>(w.holes ?? {});
    // точка на оси: смещаемся вдоль, пока не уйдём от проёмов и колонн
    for (const t of [0.5, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85]) {
      const axisPt = { x: w.p1.x + u.x * len * t, y: w.p1.y + u.y * len * t };
      if (!holes.every((h) => Math.hypot(h.pc.x - axisPt.x, h.pc.y - axisPt.y) > h.width / 2 + 50)) continue;
      if (!pillarsAll.every((p) => Math.hypot(p.pc.x - axisPt.x, p.pc.y - axisPt.y) > 60)) continue;
      const face = { x: axisPt.x + n.x * (w.depth / 2), y: axisPt.y + n.y * (w.depth / 2) };
      const away = { x: axisPt.x + n.x * 80, y: axisPt.y + n.y * 80 };
      return { wall: w, face, away };
    }
  }
  return null;
}
if (!spot) { console.error("нет стены для прилипания"); process.exit(1); }
const r2 = json(await client.callTool({ name: "rigel_add", arguments: {
  start: { x: Math.round(spot.face.x * 10), y: Math.round(spot.face.y * 10) },
  end: { x: Math.round(spot.away.x * 10), y: Math.round(spot.away.y * 10) },
  depth_mm: 300, height_mm: 300,
} }));
if (r2.code) { console.error("rigel_add 2:", r2.code, r2.message); process.exit(1); }
const wallLink = r2.entity.links.find((l: any) => l.end === "p1");
console.log("+ wall-attached:", r2.entity.site_id, "links:", JSON.stringify(r2.entity.links));
if (!wallLink || wallLink.ot !== "wall") { console.error("✖ конец p1 не прилип к стене:", JSON.stringify(r2.entity.links)); process.exit(1); }
added.push({ id: r2.entity.site_id, label: "wall-attached", expect: { depth_mm: 300, height_mm: 300 } });

// 2. Цепочка update: перенос оси, толщина, высота; тип отделки
const up1 = json(await client.callTool({ name: "rigel_update", arguments: { rigel_id: r1.entity.site_id, end: { x: Math.round((spot2.x + 40) * 10), y: Math.round((spot2.y + 10) * 10) } } }));
if (up1.code) { console.error("rigel_update 1:", up1.code, up1.message); process.exit(1); }
const e1 = added.find((x) => x.id === r1.entity.site_id)!;
e1.expect.depth_mm = 150; e1.expect.height_mm = 250;
const up2 = json(await client.callTool({ name: "rigel_update", arguments: { rigel_id: r2.entity.site_id, depth_mm: 120, height_mm: 450, ceiling_type: "gypsum_ceiling" } }));
if (up2.code) { console.error("rigel_update 2:", up2.code, up2.message); process.exit(1); }
const e2 = added.find((x) => x.id === r2.entity.site_id)!;
e2.expect.depth_mm = 120; e2.expect.height_mm = 450; e2.expect.ceiling_type = "gypsum_ceiling";
console.log("update-цепочка: ok");

// 3. Ошибочные вызовы не меняют модель
const snapshot = json(await client.callTool({ name: "model_get", arguments: {} }));
const bad1 = json(await client.callTool({ name: "rigel_add", arguments: { start: { x: 1000, y: 1000 }, end: { x: 1000, y: 1000 } } }));
const bad2 = json(await client.callTool({ name: "rigel_add", arguments: { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 }, depth_mm: 9999 } }));
console.log("ошибки как ожидалось:", bad1.code ?? "НЕТ ОШИБКИ?!", "/", bad2.code ?? "НЕТ ОШИБКИ?!");
const snapshot2 = json(await client.callTool({ name: "model_get", arguments: {} }));
console.log("модель после ошибок не изменилась:", JSON.stringify(snapshot) === JSON.stringify(snapshot2));

// 4. Валидация и сохранение
const issues = json(await client.callTool({ name: "model_validate", arguments: {} }));
if (Array.isArray(issues) && issues.length > 0) {
  console.error("model_validate:", JSON.stringify(issues).slice(0, 600));
  process.exit(1);
}
const saved = json(await client.callTool({ name: "project_save", arguments: { comment: "probe 47-rigels live check" } }));
console.log("save:", JSON.stringify({ save_id: saved.save_id, will_delete: saved.will_delete, warnings: saved.warnings }).slice(0, 400));

// 5. Переоткрытие в чистом контексте и сверка
const ctx2 = new ServerContext();
const server2 = buildServer(ctx2);
const client2 = new Client({ name: "47-rigels-reopen", version: "0.0.0" });
const [a2, b2] = InMemoryTransport.createLinkedPair();
await Promise.all([server2.connect(b2), client2.connect(a2)]);
await client2.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } });
const after = json(await client2.callTool({ name: "model_get", arguments: {} }));
const byId = new Map<string, any>((after.rigels ?? []).map((r: any) => [r.site_id, r]));

let failed = 0;
for (const a of added) {
  const r = byId.get(a.id);
  if (!r) { console.error(`✖ ${a.label}: ригель ${a.id} исчез после save → reopen`); failed++; continue; }
  for (const [k, v] of Object.entries(a.expect)) {
    if (r[k] !== v) {
      console.error(`✖ ${a.label} (${a.id}): ${k} = ${JSON.stringify(r[k])}, ожидалось ${JSON.stringify(v)}`);
      failed++;
    }
  }
}
// ось первого ригеля после update: конец передвинут
const rAfter = byId.get(r1.entity.site_id);
if (rAfter) {
  const wantEnd = { x: Math.round((spot2.x + 40) * 10), y: Math.round((spot2.y + 10) * 10) };
  if (rAfter.to[0] !== wantEnd.x || rAfter.to[1] !== wantEnd.y) {
    console.error(`✖ free: ось после update = ${JSON.stringify(rAfter.to)}, ожидалось ${JSON.stringify(wantEnd)}`);
    failed++;
  }
}
// связь со стеной у второго
const r2After = byId.get(r2.entity.site_id);
if (r2After && !r2After.links.some((l: any) => l.ot === "wall")) {
  console.error(`✖ wall-attached: связь со стеной потеряна после reopen: ${JSON.stringify(r2After.links)}`);
  failed++;
}
console.log(failed === 0 ? `сверка после reopen: все ${added.length} ригелей совпали` : `сверка после reopen: расхождений ${failed}`);

// 6. render_plan
const render = await client2.callTool({ name: "render_plan", arguments: { sheet: "init" } });
const rtext = ((render as Res).content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
const rjson = (() => { try { return JSON.parse(rtext); } catch { return null; } })();
console.log("render:", render.isError ? rtext.slice(0, 300) : JSON.stringify({ path: rjson?.path, revision: rjson?.revision ?? null }).slice(0, 500));
if (rjson?.path) {
  copyFileSync(rjson.path, ".orca-reports/47-live-render.png");
  console.log("copied to .orca-reports/47-live-render.png");
}
process.exit(failed === 0 ? 0 : 1);
