// 57-communications: живая проверка раздела «Коммуникации» через MCP в dev-проекте <REMPLANNER_PROBE_OBJECT_ID>.
// Стояки/оборудование (в т.ч. нестандартные размеры) + потолочный wall-anchor + газовые линии → validate →
// save без NORMALIZATION_DROPPED → reopen в чистом контексте → сверка → render PNG. Затем контрольный GET рабочего проекта.
// ВНИМАНИЕ: проба ОТКРЫВАЕТ и ПИШЕТ (project_save) в указанный проект — только dev.
// node scripts/probes/57-live-check.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { copyFileSync, readFileSync } from "node:fs";
import { ServerContext } from "../../src/server/context.ts";
import { buildServer } from "../../src/server.ts";
import { refuseLegacyProbe } from "./probe-guard.ts";
refuseLegacyProbe(); // 322 N3г: старая пишущая проба без гардов — запуск запрещён

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
const client = new Client({ name: "57-comm-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

await client.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } });
const before = json(await client.callTool({ name: "model_get", arguments: {} }));
console.log("до: стен", before.walls?.length, "предметов", before.items?.length, "газовых линий", before.gas_lines?.length ?? 0);

// 0. catalog_search: коммуникации ищутся по-русски
const search = json(await client.callTool({ name: "catalog_search", arguments: { query: "стояк", limit: 30 } }));
console.log("catalog_search «стояк»:", search.length, "позиций:", search.map((s: any) => s.name).join(","));
if (!search.some((s: any) => s.name === "water")) fail("catalog_search «стояк» не находит water");
const searchGas = json(await client.callTool({ name: "catalog_search", arguments: { query: "газовый" } }));
if (!searchGas.some((s: any) => s.name === "gas_line")) fail("catalog_search «газовый» не находит gas_line");

// геометрия: центры комнат
const rooms = json(await client.callTool({ name: "rooms_list", arguments: {} }));
console.log("комнаты:", rooms.map((r: any) => `${r.id}:${r.area_m2}м²`).join(", "));
const big = [...rooms].sort((x: any, y: any) => y.area_m2 - x.area_m2)[0];
if (!big) fail("нет комнат");

const full = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
const wallsAll = Object.values<any>(full.walls ?? {});

// 0a. Чистим comm-объекты прошлых прогонов пробы (наши тестовые объекты)
const COMM_NAMES = new Set([
  "water", "water_column_hot", "water_column_cold", "drainage_column", "ceiling_water",
  "heat_pipe", "radiator_old", "air", "ventilation_hole", "gas_pipe", "gas_boiler",
  "gas_meter", "electric_shield_old", "fire_detector", "conditioner_cage",
]);
for (const [id, it] of Object.entries<any>(full.items ?? {})) {
  if (!COMM_NAMES.has(it.name)) continue;
  const del = json(await client.callTool({ name: "item_delete", arguments: { item_id: id } }));
  if (del.code) fail(`item_delete ${id} (${it.name}): ${del.code} ${del.message}`);
  console.log("удалён comm-предмет прошлого прогона:", id, it.name);
}
for (const id of Object.keys(full.pipes_gas ?? {})) {
  const del = json(await client.callTool({ name: "gas_line_delete", arguments: { gas_line_id: id } }));
  if (del.code) fail(`gas_line_delete ${id}: ${del.code} ${del.message}`);
  console.log("удалена газовая линия прошлого прогона:", id);
}

const placedPc: { x: number; y: number }[] = [];

/** item_add на переборе точек: оставляем ту, где model_validate не даёт ITEM-проблем. */
async function placeValidated(label: string, args: (p: { x: number; y: number }) => Record<string, unknown>): Promise<any> {
  let tried = 0;
  for (const p of inRoomCandidates(big.area_m2)) {
    if (placedPc.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 120)) continue;
    if (tried++ > 300) break;
    const res = json(await client.callTool({ name: "item_add", arguments: args(p) }));
    if (res.code) continue; // OUTSIDE_ROOM и т.п. — следующая точка
    const issues = json(await client.callTool({ name: "model_validate", arguments: {} }));
    const problems: any[] = Array.isArray(issues) ? issues : issues?.problems ?? [];
    const itemProblems = problems.filter((pr) => String(pr.code).startsWith("ITEM"));
    if (itemProblems.length === 0) { placedPc.push(p); return { res, p }; }
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

function inRoomCandidates(areaM2: number): { x: number; y: number }[] {
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
  for (let x = Math.ceil(Math.min(...xs)); x <= Math.max(...xs); x += 30) {
    for (let y = Math.ceil(Math.min(...ys)); y <= Math.max(...ys); y += 30) {
      const p = { x, y };
      if (!inPoly(p)) continue;
      out.push(p);
    }
  }
  return out;
}

/** Стена и offset для against_wall: точка на внутренней грани ВНУТРИ самой большой комнаты
 *  (item_add выбирает сторону стены по центру наибольшей комнаты) и вдали от проёмов.
 *  wallsAll/itemsAll — текущая модель (с уже поставленными предметами). */
function wallFaceList(modelSrc: any, bigAreaM2: number, widthCm: number, depthCm: number, minLen = 120): { wallId: string; offsetMm: number }[] {
  const out: { wallId: string; offsetMm: number }[] = [];
  const wallsAll = Object.values<any>(modelSrc?.walls ?? {});
  const itemsAll = Object.values<any>(modelSrc?.items ?? {});
  const rooms2 = Object.values<any>(modelSrc?.rooms2 ?? {});
  const bigRoom = rooms2.reduce((a: any, b: any) => ((b.area ?? 0) > (a?.area ?? -1) ? b : a), null);
  if (!bigRoom || !Array.isArray(bigRoom.polygon)) fail("большая комната не найдена");
  const inPoly = (p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
      if (((yi > p.y) !== (yj > p.y)) && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  for (const w of wallsAll) {
    const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
    if (len < minLen) continue;
    const holes = Object.values<any>(w.holes ?? {});
    for (const t of [0.5, 0.35, 0.65, 0.2, 0.8, 0.3, 0.7, 0.25, 0.75, 0.15, 0.85, 0.45, 0.55, 0.1, 0.9, 0.4, 0.6, 0.32, 0.68, 0.18, 0.82, 0.28, 0.72, 0.22, 0.78, 0.38, 0.62, 0.42, 0.58]) {
      const u = { x: (w.p2.x - w.p1.x) / len, y: (w.p2.y - w.p1.y) / len };
      const n = { x: u.y, y: -u.x };
      const axisPt = { x: w.p1.x + (w.p2.x - w.p1.x) * t, y: w.p1.y + (w.p2.y - w.p1.y) * t };
      if (!holes.every((h) => Math.hypot(h.pc.x - axisPt.x, h.pc.y - axisPt.y) > h.width / 2 + 20)) continue;
      if (!itemsAll.every((it) => Math.hypot(it.pc.x - axisPt.x, it.pc.y - axisPt.y) > 70)) continue;
      // обе стороны грани: внутрь большой комнаты (как item_add выбирает сторону)
      for (const side of [1, -1] as const) {
        const inward = { x: axisPt.x + n.x * side * (w.depth / 2 + depthCm / 2), y: axisPt.y + n.y * side * (w.depth / 2 + depthCm / 2) };
        if (!inPoly(inward, bigRoom.polygon)) continue;
        // предмет не должен вылезать за ДРУГИЕ стены (оси, с учётом их толщины)
        const clear = wallsAll.every((ow) => {
          if (ow.id === w.id) return true;
          const olen = Math.hypot(ow.p2.x - ow.p1.x, ow.p2.y - ow.p1.y) || 1;
          const ou = { x: (ow.p2.x - ow.p1.x) / olen, y: (ow.p2.y - ow.p1.y) / olen };
          const t2 = Math.max(0, Math.min(olen, (inward.x - ow.p1.x) * ou.x + (inward.y - ow.p1.y) * ou.y));
          const proj = { x: ow.p1.x + ou.x * t2, y: ow.p1.y + ou.y * t2 };
          const d = Math.hypot(inward.x - proj.x, inward.y - proj.y);
          return d - ow.depth / 2 > depthCm / 2;
        });
        if (!clear) continue;
        // offset так, чтобы центр предмета встал на axisPt
        const offsetCm = t * len - widthCm / 2;
        if (offsetCm < 0) continue;
        out.push({ wallId: w.id, offsetMm: Math.round(offsetCm * 10) });
      }
    }
  }
  if (out.length === 0) fail("нет подходящей стены для against_wall");
  return out;
}

/** Постановка anchor:wall предмета с перебором стен: model_validate решает, где предмет не вылезает. */
async function placeWallValidated(label: string, name: string, widthCm: number, depthCm: number, extra: Record<string, unknown> = {}): Promise<any> {
  const fresh = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
  const candidates = wallFaceList(fresh, 0, widthCm, depthCm);
  const snapshotBefore = JSON.stringify(json(await client.callTool({ name: "model_get", arguments: {} })));
  for (const cand of candidates) {
    const res = json(await client.callTool({ name: "item_add", arguments: {
      name, position: { against_wall: { wall_id: cand.wallId, offset_mm: cand.offsetMm, gap_mm: 0 } }, ...extra,
    } }));
    if (res.code) continue;
    const issues = json(await client.callTool({ name: "model_validate", arguments: {} }));
    const problems: any[] = Array.isArray(issues) ? issues : issues?.problems ?? [];
    const itemProblems = problems.filter((pr) => String(pr.code).startsWith("ITEM"));
    if (itemProblems.length === 0) return { res, cand };
    const id = res.entity?.id;
    if (id) await client.callTool({ name: "item_delete", arguments: { item_id: id } });
  }
  const snapshotAfter = JSON.stringify(json(await client.callTool({ name: "model_get", arguments: {} })));
  if (snapshotBefore !== snapshotAfter) fail(label + ": модель изменилась после неудачных попыток");
  fail(label + ": нет места без ITEM-проблем (перебрано " + candidates.length + ")");
}

// 1. стояк с нестандартными размерами (250×250 мм) и поворотом 30°
const s1 = await placeValidated("water", (p) => ({
  name: "water", position: { center: { x: p.x * 10, y: p.y * 10 } }, width_mm: 250, depth_mm: 250, angle_deg: 30,
}));
console.log("+ water 250×250@30°:", s1.res.entity.id);

// 2. стояк ХВС по умолчанию
const s2 = await placeValidated("water_column_cold", (p) => ({ name: "water_column_cold", position: { center: { x: p.x * 10, y: p.y * 10 } } }));
console.log("+ water_column_cold дефолт:", s2.res.entity.id);

// 3. радиатор с нестандартными размерами и подъёмом (1200×150, @15°, над полом 350)
const s3 = await placeValidated("radiator_old", (p) => ({
  name: "radiator_old", position: { center: { x: p.x * 10, y: p.y * 10 } },
  width_mm: 1200, depth_mm: 150, angle_deg: 15, elevation_mm: 350,
}));
console.log("+ radiator_old 1200×150@15° over_floor 350:", s3.res.entity.id);

// 4. газовая колонка с высотой (500×250, h 670, над полом 1000)
const s4 = await placeValidated("gas_boiler", (p) => ({
  name: "gas_boiler", position: { center: { x: p.x * 10, y: p.y * 10 } },
  width_mm: 500, depth_mm: 250, height_mm: 670, elevation_mm: 1000,
}));
console.log("+ gas_boiler 500×250 h670 over_floor 1000:", s4.res.entity.id);

// 5. вентиляционный короб с нестандартным размером (400×400)
const s5 = await placeValidated("air", (p) => ({
  name: "air", position: { center: { x: p.x * 10, y: p.y * 10 } }, width_mm: 400, depth_mm: 400,
}));
console.log("+ air 400×400:", s5.res.entity.id);

// 6. ввод водоснабжения у стены (against_wall, anchor:wall)
const s6 = await placeWallValidated("ceiling_water", "ceiling_water", 20, 18);
console.log("+ ceiling_water у стены", s6.cand.wallId, ":", s6.res.entity.id);

// 7. корзина кондиционера у стены (anchor:wall, h 600, over_floor 150)
const s7 = await placeWallValidated("conditioner_cage", "conditioner_cage", 95, 65, { height_mm: 600, elevation_mm: 150 });
console.log("+ conditioner_cage у стены", s7.cand.wallId, ":", s7.res.entity.id);

// 8. газовая линия: add → update (перемещение конца) → вторая линия
const gasFullBefore = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
const roomR2 = Object.values<any>((full as any).rooms2 ?? {}).find((rr: any) => Math.abs((rr.area ?? 0) - big.area_m2) < 0.01)!;
const poly = roomR2.polygon as { x: number; y: number }[];
const px = Math.round((Math.min(...poly.map((q) => q.x)) + Math.max(...poly.map((q) => q.x))) / 2);
const py = Math.round((Math.min(...poly.map((q) => q.y)) + Math.max(...poly.map((q) => q.y))) / 2);
const g1 = json(await client.callTool({ name: "gas_line_add", arguments: { start: { x: (px - 60) * 10, y: (py - 60) * 10 }, end: { x: (px + 90) * 10, y: (py - 30) * 10 } } }));
if (g1.code) fail(`gas_line_add: ${g1.code} ${g1.message}`);
console.log("+ gas_line:", g1.entity.site_id, "length_m:", g1.entity.length_m, "(ожидается 1.53)");
if (g1.entity.length_m !== 1.53) fail(`газовая линия: length_m ${g1.entity.length_m}, ожидалось 1.53`);
const g1upd = json(await client.callTool({ name: "gas_line_update", arguments: { gas_line_id: g1.entity.site_id, end: { x: (px + 90) * 10, y: (py + 60) * 10 } } }));
if (g1upd.code) fail(`gas_line_update: ${g1upd.code} ${g1upd.message}`);
console.log("  после update end:", g1upd.entity.length_m, "м (ожидается 1.92)");
if (g1upd.entity.length_m !== 1.92) fail(`газовая линия после update: length_m ${g1upd.entity.length_m}, ожидалось 1.92`);
const g2 = json(await client.callTool({ name: "gas_line_add", arguments: { start: { x: (px - 100) * 10, y: (py + 80) * 10 }, end: { x: (px - 100) * 10, y: (py + 200) * 10 } } }));
if (g2.code) fail(`gas_line_add второй: ${g2.code} ${g2.message}`);
console.log("+ gas_line вторая:", g2.entity.site_id, "length_m:", g2.entity.length_m, "(ожидается 1.2)");

// 9. ошибочные вызовы не меняют модель и дают корректные коды
const snapshot = json(await client.callTool({ name: "model_get", arguments: {} }));
const bad1 = json(await client.callTool({ name: "item_add", arguments: { name: "gas_line", position: { center: { x: (px + 200) * 10, y: py * 10 } } } }));
console.log("item_add gas_line →", bad1.code ?? "НЕТ ОШИБКИ?!");
if (bad1.code !== "INVALID_ARGUMENT") fail(`item_add gas_line: ожидался INVALID_ARGUMENT, получен ${bad1.code}`);
const bad2 = json(await client.callTool({ name: "item_add", arguments: { name: "ceiling_water", position: { center: { x: (px + 200) * 10, y: py * 10 } } } }));
console.log("item_add ceiling_water (anchor:wall, свободно) →", bad2.code ?? "НЕТ ОШИБКИ?!");
if (bad2.code !== "INVALID_ARGUMENT") fail(`item_add ceiling_water: ожидался INVALID_ARGUMENT, получен ${bad2.code}`);
const bad3 = json(await client.callTool({ name: "gas_line_delete", arguments: { gas_line_id: "_nope" } }));
if (bad3.code !== "NOT_FOUND") fail(`gas_line_delete чужой id: ожидался NOT_FOUND, получен ${bad3.code}`);
const snapshot2 = json(await client.callTool({ name: "model_get", arguments: {} }));
console.log("модель после ошибок не изменилась:", JSON.stringify(snapshot) === JSON.stringify(snapshot2));
if (JSON.stringify(snapshot) !== JSON.stringify(snapshot2)) fail("модель изменилась после ошибочных вызовов");

// 10. валидация и сохранение
const issues = json(await client.callTool({ name: "model_validate", arguments: {} }));
const problems: any[] = Array.isArray(issues) ? issues : issues?.problems ?? [];
const itemProblems = problems.filter((p) => String(p.code).startsWith("ITEM"));
if (itemProblems.length > 0) fail(`model_validate (предметы): ${JSON.stringify(itemProblems).slice(0, 600)}`);
if (problems.length > 0) console.log(`model_validate: ${problems.length} проблем не про предметы (напр. ${problems[0].code}) — не блокируют`);
const saved = json(await client.callTool({ name: "project_save", arguments: { comment: "probe 57-communications live check" } }));
console.log("save:", JSON.stringify({ save_id: saved.save_id, will_delete: saved.will_delete, warnings: saved.warnings }).slice(0, 500));
if (JSON.stringify(saved).includes("NORMALIZATION_DROPPED")) fail("save: NORMALIZATION_DROPPED");

// 11. переоткрытие в чистом контексте и сверка
const ctx2 = new ServerContext();
const server2 = buildServer(ctx2);
const client2 = new Client({ name: "57-comm-reopen", version: "0.0.0" });
const [a2, b2] = InMemoryTransport.createLinkedPair();
await Promise.all([server2.connect(b2), client2.connect(a2)]);
await client2.callTool({ name: "project_open", arguments: { object_id: OBJECT_ID, plan_id: PLAN_ID } });
const after = json(await client2.callTool({ name: "model_get", arguments: { detail: "full" } }));
const afterItems = new Map<string, any>(Object.values<any>(after.items ?? {}).map((i: any) => [i.id, i]));
const gasSiteIds = new Map<string, any>(Object.values<any>(after.pipes_gas ?? {}).map((g: any) => [g.id, g]));
let mismatches = 0;

// ожидания предметов: site_id → {label, expect} (site_id по порядку добавления)
const fullAfterAdd = json(await client.callTool({ name: "model_get", arguments: { detail: "full" } }));
const beforeItems = new Set(Object.keys(full.items ?? {}));
const newIds = Object.keys(fullAfterAdd.items ?? {}).filter((id) => !beforeItems.has(id));
const itemExpects: [string, Record<string, unknown>][] = [
  ["water 250×250@30°", { width_mm: 250, depth_mm: 250, angle_deg: 30 }],
  ["water_column_cold дефолт", { width_mm: 100, depth_mm: 100, angle_deg: 0 }],
  ["radiator_old 1200×150@15° over 350", { width_mm: 1200, depth_mm: 150, angle_deg: 15 }],
  ["gas_boiler 500×250 h670 over 1000", { width_mm: 500, depth_mm: 250, angle_deg: 0 }],
  ["air 400×400", { width_mm: 400, depth_mm: 400, angle_deg: 0 }],
  ["ceiling_water у стены", { width_mm: 200, depth_mm: 180 }],
  ["conditioner_cage у стены", { width_mm: 950, depth_mm: 650 }],
];
if (newIds.length !== itemExpects.length) fail(`новых предметов ${newIds.length}, ожидалось ${itemExpects.length}`);
for (let i = 0; i < newIds.length; i++) {
  const [label, expect] = itemExpects[i]!;
  const id = newIds[i]!;
  const it = afterItems.get(id);
  if (!it) { console.error(`✖ ${label}: предмет ${id} исчез после save → reopen`); mismatches++; continue; }
  const got = {
    width_mm: Math.round(it.width * 10),
    depth_mm: Math.round(it.height * 10),
    angle_deg: ((Math.round(it.angle) % 360) + 360) % 360,
  };
  for (const [k, v] of Object.entries(expect)) {
    if (got[k as keyof typeof got] !== v) {
      console.error(`✖ ${label} (${id}): ${k} = ${JSON.stringify((it as any)[k])}, ожидалось ${JSON.stringify(v)}`);
      mismatches++;
    }
  }
  // план a:1 у всех пунктов меню «Коммуникации»
  if ((it.plan ?? {})["a"] !== 1) { console.error(`✖ ${label}: план без a:1: ${JSON.stringify(it.plan)}`); mismatches++; }
}
// radiator_old: over_floor {value:35, display:false}; gas_boiler: over_floor 100 display:true, self_height 67
const radAfter = afterItems.get(newIds[2]!);
const radOf = typeof radAfter?.over_floor === "object" ? radAfter?.over_floor : { value: radAfter?.over_floor, display: null };
if (Number(radOf?.value) !== 35 || radOf?.display !== false) { console.error(`✖ radiator_old: over_floor после reopen = ${JSON.stringify(radAfter?.over_floor)}`); mismatches++; }
const boilerAfter = afterItems.get(newIds[3]!);
const boilerOf = typeof boilerAfter?.over_floor === "object" ? boilerAfter?.over_floor : { value: boilerAfter?.over_floor, display: null };
if (Number(boilerOf?.value) !== 100 || boilerOf?.display !== true || Math.round((boilerAfter?.self_height ?? 0) * 10) !== 670) {
  console.error(`✖ gas_boiler: over_floor/self_height после reopen = ${JSON.stringify(boilerAfter?.over_floor)}, ${boilerAfter?.self_height}`); mismatches++;
}
// газовые линии: тип, длина, узлы
const gasExpect: [string, number][] = [[g1.entity.site_id, 1.92], [g2.entity.site_id, 1.2]];
for (const [siteId, len] of gasExpect) {
  const g = gasSiteIds.get(siteId);
  if (!g) { console.error(`✖ газовая линия ${siteId} исчезла после save → reopen`); mismatches++; continue; }
  if (g.type !== "gas_line") { console.error(`✖ ${siteId}: type = ${g.type}`); mismatches++; }
  if (Math.abs(Number(g.length) - len) > 0.02) { console.error(`✖ ${siteId}: length = ${g.length}, ожидалось ${len}`); mismatches++; }
  if ((g.vertexes ?? []).length !== 2) { console.error(`✖ ${siteId}: узлов ${g.vertexes?.length}`); mismatches++; }
}
// план компактного слоя
const afterCompact = json(await client2.callTool({ name: "model_get", arguments: {} }));
console.log("после reopen: газовых линий в compact:", afterCompact.gas_lines?.length ?? 0, "(ожидается 2)");
if ((afterCompact.gas_lines?.length ?? 0) !== 2) { console.error("✖ compact: газовых линий не 2"); mismatches++; }
console.log(mismatches === 0
  ? `сверка после reopen: все ${itemExpects.length} предметов и 2 газовые линии совпали (размеры, углы, планы, высоты)`
  : `сверка после reopen: расхождений ${mismatches}`);

// 12. render_plan
const render = await client2.callTool({ name: "render_plan", arguments: { sheet: "init" } });
const rtext = ((render as Res).content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
const rjson = (() => { try { return JSON.parse(rtext); } catch { return null; } })();
console.log("render:", render.isError ? rtext.slice(0, 300) : JSON.stringify({ path: rjson?.path, revision: rjson?.revision ?? null }).slice(0, 500));
if (rjson?.path) {
  copyFileSync(rjson.path, "../../.orca-reports/57-live-render.png");
  console.log("копия: .orca-reports/57-live-render.png");
}

// 13. контрольный GET рабочего проекта — не изменился
const snapPath = `../../.orca-reports/snapshot-${WORK_OBJECT_ID}-57.json`;
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
