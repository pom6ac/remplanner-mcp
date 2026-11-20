// 88: живая проверка раздела «Электрика» через MCP-инструменты в PRO-проекте
// (REMPLANNER_PROBE_OBJECT_ID/PLAN из env, схема «бэкап → запись → проверка →
// восстановление»; пробы удаляют ТОЛЬКО созданные ими объекты по ID).
// Контрольный проект (только GET) — REMPLANNER_SNAPSHOT_OBJECT_ID/PLAN.
// Схема: контрольный GET → бэкап → baseline validate → выключатели/розетки
// (item_add) + люстры/светильники → cable_add ×2 → item_update (перенос) →
// cable_delete → validate → save (без NORMALIZATION_DROPPED) → reopen → сверка →
// render PNG → cleanup (только свои ID) → save → сверка с бэкапом → контрольный GET.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFileSync } from "node:fs";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { refuseLegacyProbe } from "./probe-guard.ts";
refuseLegacyProbe(); // 322 N3г: старая пишущая проба без гардов — запуск запрещён

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID");
  process.exit(1);
}
const SNAP_ID = process.env.REMPLANNER_SNAPSHOT_OBJECT_ID;
const SNAP_PLAN = process.env.REMPLANNER_SNAPSHOT_PLAN_ID;

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 600)}`);
  return JSON.parse(text(res as never));
}

/** Служебные поля, меняющиеся при каждом сохранении/открытии, и регенерируемые id eds2. */
function strip(m: any): string {
  const c = structuredClone(m);
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "settings", "final", "signals", "smeta_water_pipes", "rooms2", "rooms1", "save_id", "is_forced"]) delete c[k];
  for (const k of ["borders", "drawings"]) {
    if (Array.isArray(c[k])) c[k] = [...c[k]].map((e: any) => JSON.stringify(e)).sort().map((s: string) => JSON.parse(s));
  }
  const norm = (v: any): any => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      const out: any = {};
      for (const k of Object.keys(v).sort()) out[k] = k === "eds2" ? normEds(v[k]) : norm(v[k]);
      return out;
    }
    return v;
  };
  const normEds = (v: any): any => {
    if (Array.isArray(v)) return v.map(normEds);
    if (v !== null && typeof v === "object") {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) out[k] = k === "id" && typeof val === "string" ? "<regen>" : normEds(val);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(c));
}

async function main() {
  const ctx = new ServerContext();
  const server = buildServer(ctx);
  const client = new Client({ name: "88-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const created: { items: string[]; cables: string[] } = { items: [], cables: [] };
  let persisted = false;
  let before: any = null;

  try {
    // 0. контрольный проект: GET до (запись запрещена)
    let snapBefore: string | null = null;
    if (SNAP_ID && SNAP_PLAN) {
      await call(client, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
      snapBefore = JSON.stringify(await call(client, "model_get", { detail: "full" }));
      console.log("контрольный проект: снимок до снят");
    }

    // 1. бэкап модели до
    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    before = await call(client, "model_get", { detail: "full" });
    writeFileSync(`../../.orca-reports/backup-${OBJECT_ID}-88.json`, JSON.stringify({
      _source: "GET через project_open + model_get, проект из env, scripts/probes/88-live-check.ts, только чтение; id планов/проектов не печатаются",
      model: before,
    }, null, 1));
    console.log("backup ok; counters:", JSON.stringify({
      walls: Object.keys(before.walls ?? {}).length, items: Object.keys(before.items ?? {}).length,
      cables: Object.keys(before.cables ?? {}).length,
    }));

    const vBase = await call(client, "model_validate", {});
    const baseCodes = new Set((vBase.problems ?? []).map((p: any) => `${p.code}:${p.details?.wall_id ?? p.details?.hole_id ?? p.details?.item_id ?? ""}`));
    console.log("validate (baseline): проблем", (vBase.problems ?? []).length);

    const ws = ctx.workspace();
    // стены из модели (оси, см): первая внутренняя стена для пристенных пунктов
    const wallList = Object.values<any>(before.walls ?? {}).filter((w: any) => w.plan === "a" && w.role === "wall");
    // точки внутри самой большой комнаты (как 84-live-check): полигон — из rooms2
    const roomsAll = Object.values<any>(before.rooms2 ?? {});
    let poly: { x: number; y: number }[] = [];
    for (const r of [...roomsAll].sort((r1, r2) => (r2.area ?? 0) - (r1.area ?? 0))) {
      const p: { x: number; y: number }[] = r.polygon ?? r.points ?? [];
      if (p.length >= 3) { poly = p; break; }
    }
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const minX = Math.round(Math.min(...xs) * 10), maxX = Math.round(Math.max(...xs) * 10);
    const minY = Math.round(Math.min(...ys) * 10), maxY = Math.round(Math.max(...ys) * 10);
    const inside: { x: number; y: number }[] = [];
    const inPoly = (px: number, py: number): boolean => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i]!.x * 10, yi = poly[i]!.y * 10, xj = poly[j]!.x * 10, yj = poly[j]!.y * 10;
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const distToSeg = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number => {
      const abx = b.x - a.x, aby = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby || 1)));
      return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
    };
    const farFromEdges = (px: number, py: number): boolean => {
      if (!poly.every((q) => Math.hypot(q.x * 10 - px, q.y * 10 - py) > 700)) return false;
      for (let i = 0; i < poly.length; i++) {
        const a = { x: poly[i]!.x * 10, y: poly[i]!.y * 10 };
        const b = { x: poly[(i + 1) % poly.length]!.x * 10, y: poly[(i + 1) % poly.length]!.y * 10 };
        if (distToSeg({ x: px, y: py }, a, b) < 900) return false;
      }
      return true;
    };
    for (let gx = minX; gx <= maxX; gx += 100) {
      for (let gy = minY; gy <= maxY; gy += 100) {
        if (inPoly(gx, gy) && farFromEdges(gx, gy)) inside.push({ x: gx, y: gy });
      }
    }
    inside.sort((p1, p2) => Math.hypot(p1.x - (minX + maxX) / 2, p1.y - (minY + maxY) / 2) - Math.hypot(p2.x - (minX + maxX) / 2, p2.y - (minY + maxY) / 2));
    if (inside.length < 6) throw new Error(`мало точек внутри комнаты: ${inside.length}`);
    const P = (i: number) => inside[Math.min(i, inside.length - 1)]!;
    console.log("комната (мм):", minX, minY, maxX, maxY, "; точек внутри:", inside.length);

    // 2. выключатели и розетки у стен (перебор стен-кандидатов), светильники в комнате
    const addWallItem = async (name: string, offsetMm: number): Promise<string> => {
      let lastErr: Error | null = null;
      for (const w of wallList) {
        const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
        if (len * 10 < offsetMm + 300) continue;
        try {
          await call(client, "item_add", { name, position: { against_wall: { wall_id: w.id, offset_mm: offsetMm } } });
          const id = Object.keys(ws.model.items).slice(-1)[0]!;
          created.items.push(id);
          const it = ws.model.items[id] as any;
          console.log(`item_add ${name}: ${id}`, JSON.stringify({ name: it.name, of: JSON.stringify(it.over_floor), subs: (it.socket_group ?? []).map((s: any) => s.name) }));
          await new Promise((r) => setTimeout(r, 300));
          return id;
        } catch (e) {
          lastErr = e as Error;
          console.log("  стена отклонена:", String((e as Error).message).replace(/\s+/g, " ").slice(0, 110));
        }
      }
      throw lastErr ?? new Error(`${name} не поставился`);
    };
    const addFree = async (name: string, i: number): Promise<string> => {
      await call(client, "item_add", { name, position: { center: P(i) } });
      const id = Object.keys(ws.model.items).slice(-1)[0]!;
      created.items.push(id);
      const it = ws.model.items[id] as any;
      console.log(`item_add ${name}: ${id}`, JSON.stringify({ of: JSON.stringify(it.over_floor), pc: it.pc }));
      await new Promise((r) => setTimeout(r, 300));
      return id;
    };
    const sw1 = await addWallItem("light_switch", 1000);
    const sw2 = await addWallItem("light_switch_double", 1500);
    const sock = await addWallItem("socket", 2000);
    const power = await addWallItem("socket_power", 2500);
    const lamp1 = await addFree("chandelier", 0);
    const lamp2 = await addFree("lightspot", 1);
    const lamp3 = await addFree("hanging_light", 2);
    const lamp4 = await addFree("ceiling_socket", 3);

    // 3. связи: выключатель → светильник (2 шт.)
    const c1 = await call(client, "cable_add", { switch_item_id: sw1, lamp_item_id: lamp1 });
    const c1Id = c1.entity?.site_id ?? Object.keys(ws.model.cables ?? {}).slice(-1)[0]!;
    created.cables.push(c1Id);
    console.log("cable_add 1:", JSON.stringify(c1.entity));
    await new Promise((r) => setTimeout(r, 300));
    const c2 = await call(client, "cable_add", { switch_item_id: sw2, lamp_item_id: lamp2, path: [P(4)] });
    const c2Id = c2.entity?.site_id ?? Object.keys(ws.model.cables ?? {}).slice(-1)[0]!;
    created.cables.push(c2Id);
    console.log("cable_add 2 (с узлом):", JSON.stringify(c2.entity));

    // 4. неверные вызовы отклоняются схемой/валидацией, модель не менялась
    let rejected = 0;
    try { await call(client, "cable_add", { switch_item_id: sock, lamp_item_id: lamp3 }); } catch { rejected++; }
    try { await call(client, "cable_add", { switch_item_id: sw1, lamp_item_id: lamp3 }); } catch { rejected++; }
    try { await call(client, "cable_add", { switch_item_id: sw1, lamp_item_id: power }); } catch { rejected++; }
    console.log("неверные вызовы отклонены:", rejected, "из 3");
    if (rejected < 3) throw new Error("не все неверные вызовы отклонены");

    // 5. перенос светильника и выключателя (транзитивный пересчёт вершин связи)
    const upd = await call(client, "item_update", { item_id: lamp1, position: { center: P(5) } });
    console.log("item_update chandelier:", JSON.stringify(upd.entity?.pc ?? upd));
    await new Promise((r) => setTimeout(r, 300));

    // 6. validate → save
    const v = await call(client, "model_validate", {});
    const fresh = (v.problems ?? []).filter((p: any) => !baseCodes.has(`${p.code}:${p.details?.wall_id ?? p.details?.hole_id ?? p.details?.item_id ?? ""}`));
    console.log("validate: базовых", (vBase.problems ?? []).length, ", новых", fresh.length);
    if (fresh.length > 0) throw new Error("validate: новые проблемы: " + JSON.stringify(fresh).slice(0, 400));
    persisted = true;
    const t0 = Date.now();
    const saved = await ws.save();
    console.log(`save ok in ${Date.now() - t0} ms; verified=${saved.verified}, rounds=${saved.rounds}, will_delete=${JSON.stringify(saved.will_delete)}`);
    if (!saved.verified) throw new Error("save не verified");

    // 7. reopen + сверка
    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const after = await call(client, "model_get", { detail: "full" });
    const itemsAfter = Object.values<any>(after.items ?? {}).filter((i: any) => created.items.includes(i.id));
    const cablesAfter = Object.values<any>(after.cables ?? {}).filter((l: any) => created.cables.includes(l.id));
    console.log("после reopen: предметы", itemsAfter.length, "из", created.items.length,
      "; связи", cablesAfter.length, "из", created.cables.length);
    if (itemsAfter.length !== created.items.length || cablesAfter.length !== created.cables.length) {
      throw new Error("объекты не пережили reopen");
    }
    for (const i of itemsAfter) {
      console.log(`предмет ${i.name}: pc=${i.pc.x},${i.pc.y} w=${i.width} over_floor=${JSON.stringify(i.over_floor)} subs=${JSON.stringify((i.socket_group ?? []).map((s: any) => s.name))}`);
    }
    for (const c of cablesAfter) {
      console.log(`связь ${c.id}: switch=${c.switch_item} lamp=${c.lamp_item} vertexes=${c.vertexes} length_mm=${c.length_mm}`);
    }

    // 8. render PNG листа «Выключатели»
    const rendered = await call(client, "render_plan", { sheet: "light_connections", width_px: 1600 });
    console.log("render_plan ok:", rendered.path, rendered.bytes, "bytes");

    // 9. восстановление: удалить созданное (только свои ID)
    ws.apply("88-live-cleanup", (m) => {
      for (const id of created.cables) if (m.cables?.[id]) delete m.cables[id];
      for (const id of created.items) if (m.items[id]) delete m.items[id];
      return { cables: created.cables.length, items: created.items.length };
    });
    await new Promise((r) => setTimeout(r, 5000)); // сохранение не чаще раза в 5 с
    const saved2 = await ws.save();
    console.log("cleanup save:", `verified=${saved2.verified}, will_delete=${JSON.stringify(saved2.will_delete)}`);
    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const restored = await call(client, "model_get", { detail: "full" });
    const equal = strip(restored) === strip(before);
    console.log("восстановление (сверка модели без служебных полей):", equal ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
    if (!equal) {
      const b0 = strip(before), b1 = strip(restored);
      for (let i = 0; i < Math.max(b0.length, b1.length); i++) {
        if (b0[i] !== b1[i]) {
          console.log("первое расхождение на", i, ":", b0.slice(Math.max(0, i - 150), i + 150), "|||", b1.slice(Math.max(0, i - 150), i + 150));
          break;
        }
      }
    }

    // 10. контрольный проект: GET после, сверка с «до»
    let snapOk: boolean | null = null;
    if (SNAP_ID && SNAP_PLAN && snapBefore) {
      await call(client, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
      const snapAfter = JSON.stringify(await call(client, "model_get", { detail: "full" }));
      snapOk = snapBefore === snapAfter;
      console.log("контрольный проект не изменился:", snapOk ? "OK" : "ИЗМЕНИЛСЯ");
    }

    await client.close();
    process.exit(equal && (snapOk !== false) ? 0 : 2);
  } catch (e) {
    console.error("FAIL:", String(e).slice(0, 1200));
    if (persisted && (created.items.length || created.cables.length) && before) {
      try {
        const ws = ctx.workspace();
        ws.apply("88-live-cleanup", (m) => {
          for (const id of created.cables) if (m.cables?.[id]) delete m.cables[id];
          for (const id of created.items) if (m.items[id]) delete m.items[id];
          return { cleaned: true };
        });
        await new Promise((res) => setTimeout(res, 5000));
        const s = await ws.save();
        await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
        const restored = await call(client, "model_get", { detail: "full" });
        const equal = strip(restored) === strip(before);
        console.log("аварийное восстановление:", `save verified=${s.verified}, сверка с бэкапом ${equal ? "OK" : "РАСХОЖДЕНИЕ"}`);
      } catch (e2) {
        console.error("аварийное восстановление НЕ УДАЛОСЬ:", String(e2).slice(0, 400));
      }
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error("FAIL:", String(e).slice(0, 1200)); process.exit(1); });
