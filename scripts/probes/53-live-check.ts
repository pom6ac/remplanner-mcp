// 53-stairs: живая проверка раздела «Лестницы» через MCP в dev-проекте <REMPLANNER_PROBE_OBJECT_ID>.
// 6 видов лестниц (в т.ч. нестандартные размеры) → validate → save без NORMALIZATION_DROPPED →
// reopen в чистом контексте → сверка → render PNG. Затем контрольный GET рабочего проекта.
// ВНИМАНИЕ: проба ОТКРЫВАЕТ и ПИШЕТ (project_save) в указанный проект — только dev.
// node scripts/probes/53-live-check.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { copyFileSync, readFileSync } from "node:fs";
import { ServerContext } from "../../src/server/context.ts";
import { buildServer } from "../../src/server.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
const WORK_OBJECT_ID = process.env.REMPLANNER_PROBE_WORK_OBJECT_ID;
const WORK_PLAN_ID = process.env.REMPLANNER_PROBE_WORK_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID || !WORK_OBJECT_ID || !WORK_PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID/PLAN_ID и REMPLANNER_PROBE_WORK_OBJECT_ID/PLAN_ID.");
  process.exit(1);
}

type Res = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as Res).content as { text: string }[])[0]!.text;
const json = (r: unknown): any => JSON.parse(text(r));
const fail = (msg: string): never => { console.error("✖", msg); process.exit(1); };

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "53-stairs-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

await client.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } });
const before = json(await client.callTool({ name: "model_get", arguments: {} }));
console.log("до: стен", before.walls?.length, "предметов", before.items?.length, "ригелей", before.rigels?.length);

// 0a. Чистим лестницы прошлых прогонов пробы (это наши тестовые объекты)
const STAIR_NAMES = new Set([
  "ladder_march", "ladder_console", "ladder_2march", "ladder_2march-fan", "ladder_2march_console-fan",
  "ladder_2march_console", "ladder_trapeze", "rounded_staircase", "ladder_march_double", "ladder_fan_2march",
  "ladder_3march", "ladder_3march_fan", "spiral_staircase", "upper_march", "ladder_circle", "porch",
  "attic_staircase", "step_ladder", "escalator", "elevator", "floor_hatch", "stair_machine", "stair_spot",
]);
// 0a. Чистим лестницы прошлых прогонов пробы (это наши тестовые объекты)
{
  const fullBefore = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
  for (const [id, it] of Object.entries<any>(fullBefore.items ?? {})) {
    if (!STAIR_NAMES.has(it.name)) continue;
    const del = json(await client.callTool({ name: "item_delete", arguments: { item_id: id } }));
    if (del.code) fail(`item_delete ${id} (${it.name}): ${del.code} ${del.message}`);
    console.log("удалена лестница прошлого прогона:", id, it.name);
  }
}

// 0. catalog_search: лестницы ищутся по-русски
const search = json(await client.callTool({ name: "catalog_search", arguments: { query: "лестниц", group: "stairs", limit: 30 } }));
console.log("catalog_search лестниц (group stairs):", search.length, "позиций:", search.map((s: any) => s.name).join(","));
const searchPlain = json(await client.callTool({ name: "catalog_search", arguments: { query: "лестница" } }));
if (!searchPlain.some((s: any) => s.group === "stairs")) fail("catalog_search «лестница» не находит группу stairs");

// геометрия: центры комнат (rooms_list), стены без проёмов
const rooms = json(await client.callTool({ name: "rooms_list", arguments: {} }));
console.log("комнаты:", rooms.map((r: any) => `${r.id}:${r.area_m2}м²`).join(", "));
const big = [...rooms].sort((x: any, y: any) => y.area_m2 - x.area_m2)[0];
if (!big) fail("нет комнат");

const full = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
const wallsAll = Object.values<any>(full.walls ?? {});
const itemsAll = Object.values<any>(full.items ?? {});

function inRoomCandidates(areaM2: number): { x: number; y: number }[] {
  // сетка точек внутри полигона комнаты rooms2; габариты проверяет model_validate
  const rooms2 = Object.values<any>((full as any).rooms2 ?? {});
  const r = rooms2.find((rr: any) => Math.abs((rr.area ?? 0) - areaM2) < 0.01);
  if (!r) fail(`комната ${areaM2} м² не найдена`);
  const poly: { x: number; y: number }[] = r.polygon;
  const inPoly = (p: { x: number; y: number }): boolean => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
      if (((yi > p.y) !== (yj > p.y)) && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  const xs = poly.map((q) => q.x), ys = poly.map((q) => q.y);
  const out: { x: number; y: number }[] = [];
  for (let x = Math.ceil(Math.min(...xs)); x <= Math.max(...xs); x += 20) {
    for (let y = Math.ceil(Math.min(...ys)); y <= Math.max(...ys); y += 20) {
      const p = { x, y };
      if (!inPoly(p)) continue;
      if (![...itemsAll].every((it: any) => Math.hypot(it.pc.x - p.x, it.pc.y - p.y) > 100)) continue;
      out.push(p);
    }
  }
  return out;
}

const placedPc: { x: number; y: number }[] = [];

/** item_add на переборе точек: оставляем ту, где model_validate не даёт ITEM-проблем. */
async function placeValidated(label: string, args: (p: { x: number; y: number }) => Record<string, unknown>): Promise<any> {
  let tried = 0;
  for (const p of inRoomCandidates(big.area_m2)) {
    if (placedPc.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 150)) continue;
    if (tried++ > 300) break;
    const res = json(await client.callTool({ name: "item_add", arguments: args(p) }));
    if (res.code) continue; // OUTSIDE_ROOM и т.п. — следующая точка
    const issues = json(await client.callTool({ name: "model_validate", arguments: {} }));
    const problems: any[] = Array.isArray(issues) ? issues : issues?.problems ?? [];
    const itemProblems = problems.filter((pr) => String(pr.code).startsWith("ITEM"));
    if (itemProblems.length === 0) { placedPc.push(p); return { res, p }; }
    if (tried <= 3) console.log(`  [${label}] точка ${p.x},${p.y}:`, JSON.stringify(itemProblems).slice(0, 300));
    // предмет уже стоит в модели: ищем его site_id как последний добавленный
    const nowFull = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
    const ids = new Set(Object.keys(nowFull.items ?? {}));
    for (const pr of problems) {
      const pid = pr.details?.item_id;
      if (String(pr.code).startsWith("ITEM") && typeof pid === "string" && ids.has(pid)) {
        await client.callTool({ name: "item_delete", arguments: { item_id: pid } });
      }
    }
  }
  fail(`${label}: нет точки без ITEM-проблем (перебрано ${tried})`);
}

function wallFace(minLen = 200): { wallId: string; face: { x: number; y: number }; away: { x: number; y: number } } {
  for (const w of wallsAll) {
    const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
    if (len < minLen) continue;
    const u = { x: (w.p2.x - w.p1.x) / len, y: (w.p2.y - w.p1.y) / len };
    const n = { x: u.y, y: -u.x };
    const holes = Object.values<any>(w.holes ?? {});
    for (const t of [0.3, 0.7, 0.5, 0.2, 0.8]) {
      const axisPt = { x: w.p1.x + u.x * len * t, y: w.p1.y + u.y * len * t };
      if (!holes.every((h) => Math.hypot(h.pc.x - axisPt.x, h.pc.y - axisPt.y) > h.width / 2 + 40)) continue;
      if (!itemsAll.every((it: any) => Math.hypot(it.pc.x - axisPt.x, it.pc.y - axisPt.y) > 100)) continue;
      const face = { x: axisPt.x + n.x * (w.depth / 2), y: axisPt.y + n.y * (w.depth / 2) };
      const away = { x: axisPt.x + n.x * (w.depth / 2 + 60), y: axisPt.y + n.y * (w.depth / 2 + 60) };
      return { wallId: w.id, face, away };
    }
  }
  fail("нет подходящей стены для against_wall");
}

// 1. ladder_march с нестандартными размерами (3000×800 мм) и поворотом 15°
const s1 = await placeValidated("ladder_march", (p) => ({
  name: "ladder_march", position: { center: { x: p.x * 10, y: p.y * 10 } }, width_mm: 3000, depth_mm: 800, angle_deg: 15,
}));
console.log("+ ladder_march 3000×800@15°:", s1.res.entity.id, JSON.stringify(s1.res.entity));

// 2. ladder_2march по умолчанию
const s2 = await placeValidated("ladder_2march", (p) => ({ name: "ladder_2march", position: { center: { x: p.x * 10, y: p.y * 10 } } }));
console.log("+ ladder_2march дефолт:", s2.res.entity.id);

// 3. ladder_console у стены (against_wall): id_wall как у магнитных лестниц UI
const wf1 = wallFace();
const s3 = json(await client.callTool({ name: "item_add", arguments: {
  name: "ladder_console", position: { against_wall: { wall_id: wf1.wallId, offset_mm: 1500, gap_mm: 0 } },
} }));
if (s3.code) fail(`item_add ladder_console: ${s3.code} ${s3.message}`);
console.log("+ ladder_console у стены", wf1.wallId, ":", s3.entity.id);

// 4. upper_march (план {a:1} — ключ каталога init)
const s4 = await placeValidated("upper_march", (p) => ({ name: "upper_march", position: { center: { x: p.x * 10, y: p.y * 10 } } }));
console.log("+ upper_march:", s4.res.entity.id);

// 5. porch у стены
const wf2 = wallFace();
const s5 = json(await client.callTool({ name: "item_add", arguments: {
  name: "porch", position: { against_wall: { wall_id: wf2.wallId, offset_mm: 2500, gap_mm: 0 } },
} }));
if (s5.code) fail(`item_add porch: ${s5.code} ${s5.message}`);
console.log("+ porch у стены", wf2.wallId, ":", s5.entity.id);

// 6. stair_spot у стены, над полом 200 мм
const wf3 = wallFace(150);
const s6 = json(await client.callTool({ name: "item_add", arguments: {
  name: "stair_spot", position: { against_wall: { wall_id: wf3.wallId, offset_mm: 800, gap_mm: 0 } }, elevation_mm: 200,
} }));
if (s6.code) fail(`item_add stair_spot: ${s6.code} ${s6.message}`);
console.log("+ stair_spot у стены", wf3.wallId, ", over_floor 200:", s6.entity.id);

const added: { id: string; label: string; expect: Record<string, unknown> }[] = [];
{
  // site_id предметов: разность полной модели до/после (порядок вставки = порядок add)
  const beforeItems = new Set(Object.keys(full.items ?? {}));
  const afterAll = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
  const newIds = Object.keys(afterAll.items ?? {}).filter((id) => !beforeItems.has(id));
  const labels = [
    ["ladder_march 3000×800@15°", { width_mm: 3000, depth_mm: 800, angle_deg: 15 }],
    ["ladder_2march дефолт", { width_mm: 2600, depth_mm: 1600, angle_deg: 0 }],
    ["ladder_console у стены", { width_mm: 2600, depth_mm: 800 }],
    ["upper_march", { width_mm: 1800, depth_mm: 800 }],
    ["porch у стены", { width_mm: 1200, depth_mm: 800 }],
    ["stair_spot over_floor 200", { width_mm: 120, depth_mm: 140 }],
  ] as const;
  if (newIds.length !== labels.length) fail(`новых предметов ${newIds.length}, ожидалось ${labels.length}`);
  newIds.forEach((id, i) => added.push({ id, label: labels[i]![0], expect: { ...labels[i]![1] } }));
}

// 7. план: a:1 у лестниц меню; у upper_march — ровно {a:1}
const fullAfter = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
const itemsById = new Map<string, any>(Object.values<any>(fullAfter.items ?? {}).map((i: any) => [i.id, i]));const planOf = (id: string): Record<string, number> => itemsById.get(id)?.plan ?? {};
const ladderMarchId = added[0]!.id, upperMarchId = added[3]!.id, stairSpotId = added[5]!.id;
if (!Object.values(planOf(ladderMarchId)).includes(1) || planOf(ladderMarchId)["a"] !== 1) fail(`ladder_march: план без a:1: ${JSON.stringify(planOf(ladderMarchId))}`);
if (JSON.stringify(planOf(upperMarchId)) !== JSON.stringify({ a: 1 })) fail(`upper_march: план ≠ {a:1}: ${JSON.stringify(planOf(upperMarchId))}`);
console.log("планы: ladder_march", JSON.stringify(planOf(ladderMarchId)), "upper_march", JSON.stringify(planOf(upperMarchId)));

// 8. ошибочные вызовы не меняют модель
const snapshot = json(await client.callTool({ name: "model_get", arguments: {} }));
const bad1 = json(await client.callTool({ name: "item_add", arguments: { name: "ladder_march", position: { center: { x: 0, y: 0 } } } }));
const bad2 = json(await client.callTool({ name: "item_add", arguments: { name: "unknown_stair_xyz", position: { center: { x: placedPc[0]!.x * 10, y: placedPc[0]!.y * 10 } } } }));
console.log("ошибки как ожидалось:", bad1.code ?? "НЕТ ОШИБКИ?!", "/", bad2.code ?? "НЕТ ОШИБКИ?!");
const snapshot2 = json(await client.callTool({ name: "model_get", arguments: {} }));
console.log("модель после ошибок не изменилась:", JSON.stringify(snapshot) === JSON.stringify(snapshot2));

// 9. валидация и сохранение
const issues = json(await client.callTool({ name: "model_validate", arguments: {} }));
const problems: any[] = Array.isArray(issues) ? issues : issues?.problems ?? [];
const itemProblems = problems.filter((p) => String(p.code).startsWith("ITEM"));
if (itemProblems.length > 0) fail(`model_validate (предметы): ${JSON.stringify(itemProblems).slice(0, 600)}`);
if (problems.length > 0) console.log(`model_validate: ${problems.length} проблем не про предметы (напр. ${problems[0].code}) — не блокируют`);
const saved = json(await client.callTool({ name: "project_save", arguments: { comment: "probe 53-stairs live check" } }));
console.log("save:", JSON.stringify({ save_id: saved.save_id, will_delete: saved.will_delete, warnings: saved.warnings }).slice(0, 400));
if (JSON.stringify(saved).includes("NORMALIZATION_DROPPED")) fail("save: NORMALIZATION_DROPPED");

// 10. переоткрытие в чистом контексте и сверка
const ctx2 = new ServerContext();
const server2 = buildServer(ctx2);
const client2 = new Client({ name: "53-stairs-reopen", version: "0.0.0" });
const [a2, b2] = InMemoryTransport.createLinkedPair();
await Promise.all([server2.connect(b2), client2.connect(a2)]);
await client2.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } });
const after = json(await client2.callTool({ name: "model_get", arguments: { detail: "full" } }));
const afterItems = new Map<string, any>(Object.values<any>(after.items ?? {}).map((i: any) => [i.id, i]));
let mismatches = 0;
for (const a of added) {
  const it = afterItems.get(a.id);
  if (!it) { console.error(`✖ ${a.label}: предмет ${a.id} исчез после save → reopen`); mismatches++; continue; }
  const got = { width_mm: Math.round(it.width * 10), depth_mm: Math.round(it.height * 10), angle_deg: it.angle };
  for (const [k, v] of Object.entries(a.expect)) {
    if (got[k as keyof typeof got] !== v) {
      console.error(`✖ ${a.label} (${a.id}): ${k} = ${JSON.stringify((it as any)[k])}, ожидалось ${JSON.stringify(v)}`);
      mismatches++;
    }
  }
}
// план после reopen: a:1 сохранён
const planAfter1 = afterItems.get(ladderMarchId)?.plan ?? {};
const planAfter4 = afterItems.get(upperMarchId)?.plan ?? {};
if (planAfter1["a"] !== 1) { console.error(`✖ ladder_march: после reopen план без a:1: ${JSON.stringify(planAfter1)}`); mismatches++; }
if (JSON.stringify(planAfter4) !== JSON.stringify({ a: 1 })) { console.error(`✖ upper_march: после reopen план ≠ {a:1}: ${JSON.stringify(planAfter4)}`); mismatches++; }
// stair_spot: над полом 200 мм
const spotAfter = afterItems.get(stairSpotId);
const overFloor = typeof spotAfter?.over_floor === "object" ? spotAfter?.over_floor?.value : spotAfter?.over_floor;
if (Number(overFloor) !== 20) { console.error(`✖ stair_spot: over_floor после reopen = ${JSON.stringify(spotAfter?.over_floor)}`); mismatches++; }
console.log(mismatches === 0 ? `сверка после reopen: все ${added.length} лестниц совпали (размеры, углы, планы, высота светильника)` : `сверка после reopen: расхождений ${mismatches}`);

// 11. render_plan
const render = await client2.callTool({ name: "render_plan", arguments: { sheet: "init" } });
const rtext = ((render as Res).content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
const rjson = (() => { try { return JSON.parse(rtext); } catch { return null; } })();
console.log("render:", render.isError ? rtext.slice(0, 300) : JSON.stringify({ path: rjson?.path, revision: rjson?.revision ?? null }).slice(0, 500));
if (rjson?.path) {
  copyFileSync(rjson.path, "../../.orca-reports/53-live-render.png");
  console.log("копия: .orca-reports/53-live-render.png");
}

// 12. контрольный GET рабочего проекта — не изменился
const snapPath = `../../.orca-reports/snapshot-${WORK_OBJECT_ID}-53.json`;
const snapBefore = JSON.parse(readFileSync(snapPath, "utf8"));
const { loadModel } = await import("../../src/api.ts");
const { loadSession } = await import("../../src/session.ts");
const { STATE_PATH } = await import("../../src/config.ts");
const work = await loadModel(loadSession(STATE_PATH), WORK_OBJECT_ID, WORK_PLAN_ID);
const dataBefore = snapBefore.data as string;
const dataAfter = JSON.stringify(work.model);
console.log(`рабочий проект: save_id ${work.save_id} (был ${snapBefore.save_id}), data не изменилась: ${dataBefore === dataAfter}`);
if (work.save_id !== snapBefore.save_id || dataBefore !== dataAfter) fail("рабочий проект изменился!");

process.exit(mismatches === 0 ? 0 : 1);
