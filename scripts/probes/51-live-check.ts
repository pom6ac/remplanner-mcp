// 51-rigels-fix2: живая проверка второго круга PR #5 «Потолочный ригель» (ревью 50).
// Повтор scripts/probes/47-live-check.ts + цепочка ригель→ригель и ригель, прилипший
// к колонне: validate → save без NORMALIZATION_DROPPED → reopen → сверка → render.
// Плюс живая проверка major 50-1: удаление опорного ригеля цепочки гасит связь
// зависимого транзитивно (одной операцией, без повторного refresh).
//
// ВНИМАНИЕ: проба ОТКРЫВАЕТ и ПИШЕТ (project_save) в указанный аккаунтный проект и
// предназначена ТОЛЬКО для dev-проекта. node scripts/probes/51-live-check.ts
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
const client = new Client({ name: "51-rigels-fix2-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

await client.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } });
const full = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
const wallsAll = Object.values<any>(full.walls ?? {});
const pillarsAll = Object.values<any>(full.pillars ?? {});
console.log("стен:", wallsAll.length, "колонн:", pillarsAll.length, "ригелей:", Object.keys(full.rigels ?? {}).length);

// 0. Чистим ригели прошлых прогонов
const beforeCompact = json(await client.callTool({ name: "model_get", arguments: {} }));
const oldRigelIds: string[] = (beforeCompact.rigels ?? []).map((r: any) => r.site_id);
for (const r of beforeCompact.rigels ?? []) {
  const del = json(await client.callTool({ name: "rigel_delete", arguments: { rigel_id: r.site_id } }));
  if (del.code) { console.error(`rigel_delete ${r.site_id}:`, del.code, del.message ?? ""); process.exit(1); }
  console.log("удалён ригель прошлого прогона:", r.site_id);
}

const added: { id: string; label: string; expect: Record<string, unknown> }[] = [];
const fail = (msg: string): never => { console.error("✖", msg); process.exit(1); };

// --- общие помощники ---

function distSeg(p: { x: number; y: number }, a1: { x: number; y: number }, a2: { x: number; y: number }): number {
  const dx = a2.x - a1.x, dy = a2.y - a1.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a1.x) * dx + (p.y - a1.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a1.x + dx * t), p.y - (a1.y + dy * t));
}

const pillarEdgeDist = (p: { x: number; y: number }): number => Math.min(...pillarsAll.map((pi: any) => {
  const dx = Math.abs(p.x - pi.pc.x) - pi.width / 2;
  const dy = Math.abs(p.y - pi.pc.y) - pi.height / 2;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}));

/** Свободная точка: дальше 110 см от стен, колонн и уже занятых осей. */
function freeSpot(occupied: { a1: { x: number; y: number }; a2: { x: number; y: number } }[]): { x: number; y: number } {
  const xs = wallsAll.flatMap((w) => [w.p1.x, w.p2.x]);
  const ys = wallsAll.flatMap((w) => [w.p1.y, w.p2.y]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  for (let r = 0; r <= 900; r += 20) {
    for (let ang = 0; ang < 360; ang += 12) {
      const p = { x: cx + r * Math.cos(ang * Math.PI / 180), y: cy + r * Math.sin(ang * Math.PI / 180) };
      if (!wallsAll.every((w) => distSeg(p, w.p1, w.p2) > 110)) continue;
      if (pillarEdgeDist(p) <= 110) continue;
      if (!occupied.every((o) => distSeg(p, o.a1, o.a2) > 110)) continue;
      return p;
    }
  }
  return fail("нет свободной точки для ригеля");
}

function wallFace(): { face: { x: number; y: number }; away: { x: number; y: number } } | null {
  for (const w of wallsAll) {
    const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
    if (len < 200) continue;
    const u = { x: (w.p2.x - w.p1.x) / len, y: (w.p2.y - w.p1.y) / len };
    const n = { x: u.y, y: -u.x };
    const holes = Object.values<any>(w.holes ?? {});
    for (const t of [0.5, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85]) {
      const axisPt = { x: w.p1.x + u.x * len * t, y: w.p1.y + u.y * len * t };
      if (!holes.every((h) => Math.hypot(h.pc.x - axisPt.x, h.pc.y - axisPt.y) > h.width / 2 + 50)) continue;
      if (!pillarsAll.every((p) => Math.hypot(p.pc.x - axisPt.x, p.pc.y - axisPt.y) > 60)) continue;
      const face = { x: axisPt.x + n.x * (w.depth / 2), y: axisPt.y + n.y * (w.depth / 2) };
      const away = { x: axisPt.x + n.x * 80, y: axisPt.y + n.y * 80 };
      return { face, away };
    }
  }
  return null;
}

const mm = (p: { x: number; y: number }) => ({ x: Math.round(p.x * 10), y: Math.round(p.y * 10) });

// 1. Свободный диагональный ригель 150×250 (сценарий 47)
const occupied: { a1: { x: number; y: number }; a2: { x: number; y: number } }[] = [];
const freeSpot1 = freeSpot(occupied);
const spot2 = { x: freeSpot1.x + 60, y: freeSpot1.y + 20 };
occupied.push({ a1: freeSpot1, a2: spot2 });

const r1 = json(await client.callTool({ name: "rigel_add", arguments: {
  start: mm(freeSpot1), end: mm(spot2), depth_mm: 150, height_mm: 250,
} }));
if (r1.code) fail(`rigel_add 1: ${r1.code} ${r1.message}`);
added.push({ id: r1.entity.site_id, label: "free 150×250 diag", expect: { depth_mm: 150, height_mm: 250, ceiling_type: "" } });
console.log("+ free:", r1.entity.site_id, JSON.stringify(r1.entity.from), "→", JSON.stringify(r1.entity.to));

// 2. Ригель, прилипший к стене (сценарий 47)
const spot = wallFace();
if (!spot) fail("нет стены для прилипания");
const r2 = json(await client.callTool({ name: "rigel_add", arguments: {
  start: mm(spot.face), end: mm(spot.away), depth_mm: 300, height_mm: 300,
} }));
if (r2.code) fail(`rigel_add 2: ${r2.code} ${r2.message}`);
const wallLink = r2.entity.links.find((l: any) => l.end === "p1");
console.log("+ wall-attached:", r2.entity.site_id, "links:", JSON.stringify(r2.entity.links));
if (!wallLink || wallLink.ot !== "wall") fail(`конец p1 не прилип к стене: ${JSON.stringify(r2.entity.links)}`);
added.push({ id: r2.entity.site_id, label: "wall-attached", expect: { depth_mm: 300, height_mm: 300 } });

// 3. ЦЕПОЧКА ригель→ригель (ревью 50 major): B.p1 на боковой грани A
const chainASpot = freeSpot(occupied);
const chainAEnd = { x: chainASpot.x + 140, y: chainASpot.y + 30 };
const chainA = json(await client.callTool({ name: "rigel_add", arguments: {
  start: mm(chainASpot), end: mm(chainAEnd), depth_mm: 400, height_mm: 300,
} }));
if (chainA.code) fail(`rigel_add chainA: ${chainA.code} ${chainA.message}`);
occupied.push({ a1: chainASpot, a2: chainAEnd });
console.log("+ chain A:", chainA.entity.site_id, JSON.stringify(chainA.entity.from), "→", JSON.stringify(chainA.entity.to));

// боковая грань A из полной модели: середина rigel.l, ось B перпендикулярна оси A
const fullA = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
const rigelA = Object.values<any>(fullA.rigels ?? {}).find((r) => r.id === chainA.entity.site_id);
if (!rigelA?.l) fail("ригель A не найден в полной модели");
const mid = { x: (rigelA.l.p1.x + rigelA.l.p2.x) / 2, y: (rigelA.l.p1.y + rigelA.l.p2.y) / 2 };
const u = { x: rigelA.l.p2.x - rigelA.l.p1.x, y: rigelA.l.p2.y - rigelA.l.p1.y };
const ul = Math.hypot(u.x, u.y);
const n1 = { x: u.y / ul, y: -u.x / ul };
const away = Math.hypot(mid.x + n1.x - (rigelA.p1.x + rigelA.p2.x) / 2, mid.y + n1.y - (rigelA.p1.y + rigelA.p2.y) / 2)
  > Math.hypot(mid.x - n1.x - (rigelA.p1.x + rigelA.p2.x) / 2, mid.y - n1.y - (rigelA.p1.y + rigelA.p2.y) / 2);
const dir = away ? n1 : { x: -n1.x, y: -n1.y };
const chainBEnd = { x: mid.x + dir.x * 60, y: mid.y + dir.y * 60 };
const chainB = json(await client.callTool({ name: "rigel_add", arguments: {
  start: mm(mid), end: mm(chainBEnd), depth_mm: 200, height_mm: 350,
} }));
if (chainB.code) fail(`rigel_add chainB: ${chainB.code} ${chainB.message}`);
console.log("+ chain B:", chainB.entity.site_id, JSON.stringify(chainB.entity.from), "→", JSON.stringify(chainB.entity.to), "links:", JSON.stringify(chainB.entity.links));
const bLink = chainB.entity.links.find((l: any) => l.end === "p1");
if (!bLink || bLink.ot !== "rigel" || bLink.id !== chainA.entity.site_id) {
  fail(`chain B: конец p1 не прилип к ригелю A: ${JSON.stringify(chainB.entity.links)}`);
}
added.push({ id: chainB.entity.site_id, label: "chain B (rigel→rigel)", expect: { depth_mm: 200, height_mm: 350 } });

// 4. Ригель, прилипший к колонне
const pillarSpot = ((): { face: { x: number; y: number }; away: { x: number; y: number }; pillarId: string; z1: string } | null => {
  for (const pi of pillarsAll) {
    const faces: [string, any, any][] = [["t", pi.p1, pi.p2], ["r", pi.p2, pi.p3], ["b", pi.p3, pi.p4], ["l", pi.p4, pi.p1]];
    for (const [z1, q1, q2] of faces) {
      const fmid = { x: (q1.x + q2.x) / 2, y: (q1.y + q2.y) / 2 };
      const fl = Math.hypot(q2.x - q1.x, q2.y - q1.y);
      const fn = { x: (q2.y - q1.y) / fl, y: -(q2.x - q1.x) / fl };
      for (const s of [1, -1] as const) {
        const dir = { x: fn.x * s, y: fn.y * s };
        const end = { x: fmid.x + dir.x * 60, y: fmid.y + dir.y * 60 };
        const mid30 = { x: fmid.x + dir.x * 30, y: fmid.y + dir.y * 30 };
        if (!wallsAll.every((w) => distSeg(fmid, w.p1, w.p2) > 25 && distSeg(end, w.p1, w.p2) > 25 && distSeg(mid30, w.p1, w.p2) > 25)) continue;
        if (pillarsAll.every((p: any) => distSeg(end, p.p1, p.p2) > 25 && distSeg(end, p.p2, p.p3) > 25 && distSeg(end, p.p3, p.p4) > 25 && distSeg(end, p.p4, p.p1) > 25)) {
          return { face: fmid, away: end, pillarId: pi.id, z1 };
        }
      }
    }
  }
  return null;
})();
if (!pillarSpot) fail("нет свободной грани колонны для ригеля");
const rP = json(await client.callTool({ name: "rigel_add", arguments: {
  start: mm(pillarSpot.face), end: mm(pillarSpot.away), depth_mm: 250, height_mm: 400,
} }));
if (rP.code) fail(`rigel_add pillar: ${rP.code} ${rP.message}`);
console.log("+ pillar-attached:", rP.entity.site_id, "links:", JSON.stringify(rP.entity.links));
const pLink = rP.entity.links.find((l: any) => l.end === "p1");
if (!pLink || pLink.ot !== "pillar" || pLink.id !== pillarSpot.pillarId) {
  fail(`конец p1 не прилип к колонне: ${JSON.stringify(rP.entity.links)}`);
}
added.push({ id: rP.entity.site_id, label: "pillar-attached", expect: { depth_mm: 250, height_mm: 400 } });

// 5. Цепочка update (сценарий 47): перенос оси, толщина/высота, тип отделки
const up1 = json(await client.callTool({ name: "rigel_update", arguments: { rigel_id: r1.entity.site_id, end: mm({ x: spot2.x + 40, y: spot2.y + 10 }) } }));
if (up1.code) fail(`rigel_update 1: ${up1.code} ${up1.message}`);
added.find((x) => x.id === r1.entity.site_id)!.expect.depth_mm = 150;
const up2 = json(await client.callTool({ name: "rigel_update", arguments: { rigel_id: r2.entity.site_id, depth_mm: 120, height_mm: 450, ceiling_type: "gypsum_ceiling" } }));
if (up2.code) fail(`rigel_update 2: ${up2.code} ${up2.message}`);
Object.assign(added.find((x) => x.id === r2.entity.site_id)!.expect, { depth_mm: 120, height_mm: 450, ceiling_type: "gypsum_ceiling" });
console.log("update-цепочка: ok");

// 6. Ошибочные вызовы не меняют модель
const snapshot = json(await client.callTool({ name: "model_get", arguments: {} }));
const bad1 = json(await client.callTool({ name: "rigel_add", arguments: { start: { x: 1000, y: 1000 }, end: { x: 1000, y: 1000 } } }));
const bad2 = json(await client.callTool({ name: "rigel_add", arguments: { start: { x: 1000, y: 1000 }, end: { x: 2000, y: 1000 }, depth_mm: 9999 } }));
console.log("ошибки как ожидалось:", bad1.code ?? "НЕТ ОШИБКИ?!", "/", bad2.code ?? "НЕТ ОШИБКИ?!");
const snapshot2 = json(await client.callTool({ name: "model_get", arguments: {} }));
console.log("модель после ошибок не изменилась:", JSON.stringify(snapshot) === JSON.stringify(snapshot2));

// 7. Валидация и сохранение
const issues = json(await client.callTool({ name: "model_validate", arguments: {} }));
const problems: any[] = Array.isArray(issues) ? issues : issues?.problems ?? [];
const rigelProblems = problems.filter((p) => String(p.code).startsWith("RIGEL"));
if (rigelProblems.length > 0) fail(`model_validate (ригели): ${JSON.stringify(rigelProblems).slice(0, 600)}`);
if (problems.length > 0) console.log(`model_validate: ${problems.length} проблем НЕ про ригели (до этапа, напр. ${problems[0].code}) — не блокируют`);
const saved = json(await client.callTool({ name: "project_save", arguments: { comment: "probe 51-rigels-fix2 live check" } }));
console.log("save:", JSON.stringify({ save_id: saved.save_id, will_delete: saved.will_delete, warnings: saved.warnings }).slice(0, 400));
if (JSON.stringify(saved).includes("NORMALIZATION_DROPPED")) fail("save: NORMALIZATION_DROPPED");
// will_delete.rigels (счётчик) допустим только для намеренно удалённых ригелей прошлых прогонов
const wdRigels = saved.will_delete?.rigels ?? 0;
if (wdRigels > oldRigelIds.length) fail(`save: незапланированная потеря ригелей: will_delete.rigels = ${wdRigels} > ${oldRigelIds.length} удалённых прошлого прогона`);

// 8. Переоткрытие в чистом контексте и сверка
const ctx2 = new ServerContext();
const server2 = buildServer(ctx2);
const client2 = new Client({ name: "51-rigels-fix2-reopen", version: "0.0.0" });
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
// ось первого ригеля после update
const rAfter = byId.get(r1.entity.site_id);
if (rAfter) {
  const wantEnd = mm({ x: spot2.x + 40, y: spot2.y + 10 });
  if (rAfter.to[0] !== wantEnd.x || rAfter.to[1] !== wantEnd.y) {
    console.error(`✖ free: ось после update = ${JSON.stringify(rAfter.to)}, ожидалось ${JSON.stringify(wantEnd)}`);
    failed++;
  }
}
// связи после reopen
const hasLink = (r: any, end: string, ot: string, id?: string): boolean =>
  !!r?.links?.some((l: any) => l.end === end && l.ot === ot && (id === undefined || l.id === id));
const r2After = byId.get(r2.entity.site_id);
if (r2After && !r2After.links.some((l: any) => l.ot === "wall")) {
  console.error(`✖ wall-attached: связь со стеной потеряна: ${JSON.stringify(r2After.links)}`);
  failed++;
}
const chainBAfter = byId.get(chainB.entity.site_id);
if (chainBAfter && !hasLink(chainBAfter, "p1", "rigel", chainA.entity.site_id)) {
  console.error(`✖ chain B: связь с ригелем A потеряна после reopen: ${JSON.stringify(chainBAfter.links)}`);
  failed++;
}
const rPAfter = byId.get(rP.entity.site_id);
if (rPAfter && !hasLink(rPAfter, "p1", "pillar", pillarSpot.pillarId)) {
  console.error(`✖ pillar-attached: связь с колонной потеряна: ${JSON.stringify(rPAfter.links)}`);
  failed++;
}
console.log(failed === 0 ? `сверка после reopen: все ${added.length} ригелей совпали (включая цепочку и колонну)` : `сверка после reopen: расхождений ${failed}`);

// 9. render_plan
const render = await client2.callTool({ name: "render_plan", arguments: { sheet: "init" } });
const rtext = ((render as Res).content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
const rjson = (() => { try { return JSON.parse(rtext); } catch { return null; } })();
console.log("render:", render.isError ? rtext.slice(0, 300) : JSON.stringify({ path: rjson?.path, revision: rjson?.revision ?? null }).slice(0, 500));
if (rjson?.path) {
  copyFileSync(rjson.path, ".orca-reports/51-live-render.png");
  console.log("copied to .orca-reports/51-live-render.png");
}

// 10. Живая проверка major 50-1: удаление опорного ригеля цепочки гасит связь зависимого
const delA = json(await client2.callTool({ name: "rigel_delete", arguments: { rigel_id: chainA.entity.site_id } }));
if (delA.code) fail(`rigel_delete chainA: ${delA.code} ${delA.message}`);
const afterDel = json(await client2.callTool({ name: "model_get", arguments: {} }));
const bAfterDel = (afterDel.rigels ?? []).find((r: any) => r.site_id === chainB.entity.site_id);
if (!bAfterDel) fail("chain B исчез после удаления A");
if (bAfterDel.links?.some((l: any) => l.end === "p1" && l.ot === "rigel")) {
  console.error(`✖ major 50-1: связь chain B→A осталась после удаления A: ${JSON.stringify(bAfterDel.links)}`);
  process.exit(1);
}
console.log("major 50-1 live: удаление опорного ригеля погасило связь зависимого одной операцией");
process.exit(failed === 0 ? 0 : 1);
