// 84: живая проверка раздела «Освещение» через MCP-инструменты в PRO-проекте
// (REMPLANNER_PROBE_OBJECT_ID/REMPLANNER_PROBE_PLAN_ID из env, схема
// «бэкап → запись → проверка → восстановление»; пробы удаляют ТОЛЬКО созданные
// ими объекты по ID). Контрольный проект (только GET) — REMPLANNER_SNAPSHOT_*.
// Схема: контрольный GET → бэкап → baseline validate → светильники (потолочные,
// настенный бра, подвесной, Армстронг) + лента/шины/линейный свет (add/update) →
// validate → save (без NORMALIZATION_DROPPED) → reopen → сверка → печать
// нормализованных линий (для эталонов, обезличиваются отдельно) → render PNG →
// cleanup (только свои ID) → save → сверка с бэкапом → контрольный GET.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFileSync } from "node:fs";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

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
  const client = new Client({ name: "84-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const created: { items: string[]; led: string[]; stripes: string[]; lines: string[] } = { items: [], led: [], stripes: [], lines: [] };
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
    writeFileSync(`../../.orca-reports/backup-${OBJECT_ID}-84.json`, JSON.stringify({
      _source: "GET через project_open + model_get, проект из env, scripts/probes/84-live-check.ts, только чтение; id планов/проектов не печатаются",
      model: before,
    }, null, 1));
    console.log("backup ok; counters:", JSON.stringify({
      walls: Object.keys(before.walls ?? {}).length, items: Object.keys(before.items ?? {}).length,
      led: Object.keys(before.led_strips ?? {}).length, stripes: Object.keys(before.stripes_light ?? {}).length,
      lines: Object.keys(before.line_strips ?? {}).length,
    }));

    const vBase = await call(client, "model_validate", {});
    const baseCodes = new Set((vBase.problems ?? []).map((p: any) => `${p.code}:${p.details?.wall_id ?? p.details?.hole_id ?? p.details?.item_id ?? ""}`));
    console.log("validate (baseline): проблем", (vBase.problems ?? []).length);

    const ws = ctx.workspace();
    // базовая точка — центр первой комнаты (мм)
    const room = Object.values<any>(before.rooms2 ?? {})[0]!;
    const poly: { x: number; y: number }[] = room.polygon ?? room.points ?? [];
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const minX = Math.round(Math.min(...xs) * 10), maxX = Math.round(Math.max(...xs) * 10);
    const minY = Math.round(Math.min(...ys) * 10), maxY = Math.round(Math.max(...ys) * 10);
    // точки строго внутри полигона с отступом от стен (сеть по bbox, точка в полигоне,
    // расстояние до всех вершин полигона > 500 мм — под габарит светильника)
    const inside: { x: number; y: number }[] = [];
    const inPoly = (px: number, py: number): boolean => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i]!.x * 10, yi = poly[i]!.y * 10, xj = poly[j]!.x * 10, yj = poly[j]!.y * 10;
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const farFromEdges = (px: number, py: number): boolean =>
      poly.every((q) => Math.hypot(q.x * 10 - px, q.y * 10 - py) > 500);
    for (let gx = minX; gx <= maxX; gx += 100) {
      for (let gy = minY; gy <= maxY; gy += 100) {
        if (inPoly(gx, gy) && farFromEdges(gx, gy)) inside.push({ x: gx, y: gy });
      }
    }
    inside.sort((a, b) => Math.hypot(a.x - (minX + maxX) / 2, a.y - (minY + maxY) / 2) - Math.hypot(b.x - (minX + maxX) / 2, b.y - (minY + maxY) / 2));
    if (inside.length < 8) throw new Error(`мало точек внутри комнаты: ${inside.length}`);
    const P = (i: number) => inside[Math.min(i, inside.length - 1)]!;
    console.log("комната (мм):", minX, minY, maxX, maxY, "; точек внутри:", inside.length);

    // 2. светильники: потолочные (свободно), подвесной, настенный бра (перебор стен), Армстронг
    const add = async (name: string, position: Record<string, unknown>): Promise<string> => {
      await call(client, "item_add", { name, position });
      const id = Object.keys(ws.model.items).slice(-1)[0]!;
      created.items.push(id);
      const it = ws.model.items[id] as any;
      console.log(`item_add ${name}: ${id}`, JSON.stringify({ w: it.width, of: JSON.stringify(it.over_floor), sh: it.self_height }));
      await new Promise((r) => setTimeout(r, 300));
      return id;
    };
    await add("chandelier", { center: P(0) });
    await add("lightspot", { center: P(1) });
    await add("hanging_lightspot", { center: P(2) });
    await add("armstrong_light", { center: P(3) });
    const walls = Object.values<any>(before.walls ?? {}).filter((w: any) => w.plan === "a" && w.role === "wall");
    let braId: string | null = null;
    for (const w of walls) {
      const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
      if (len < 100) continue;
      try {
        braId = await add("bra", { against_wall: { wall_id: w.id, offset_mm: Math.round(len * 10 / 2) } });
        break;
      } catch (e) {
        console.log("стена отклонена:", w.id, String((e as Error).message).replace(/\s+/g, " ").slice(0, 80));
      }
    }
    if (!braId) throw new Error("бра не поставилось ни у одной стены");

    // 3. световые линии: лента (ломаная 3 узла), шины pendent/recessed, линейный свет
    const led = await call(client, "led_strip_add", { path: [P(4), P(5), P(6)] });
    const ledId = led.entity?.site_id ?? Object.keys(ws.model.led_strips ?? {}).slice(-1)[0]!;
    created.led.push(ledId);
    console.log("led_strip_add:", JSON.stringify(led.entity));
    await new Promise((r) => setTimeout(r, 300));
    const stripe = await call(client, "stripe_add", { kind: "pendent", path: [P(8), P(9)] });
    const stripeId = stripe.entity?.site_id ?? Object.keys(ws.model.stripes_light ?? {}).slice(-1)[0]!;
    created.stripes.push(stripeId);
    console.log("stripe_add pendent:", JSON.stringify(stripe.entity));
    await new Promise((r) => setTimeout(r, 300));
    const stripe2 = await call(client, "stripe_add", { kind: "recessed", path: [P(11), P(12)] });
    const stripe2Id = stripe2.entity?.site_id ?? Object.keys(ws.model.stripes_light ?? {}).slice(-1)[0]!;
    created.stripes.push(stripe2Id);
    console.log("stripe_add recessed:", JSON.stringify(stripe2.entity));
    await new Promise((r) => setTimeout(r, 300));
    const line = await call(client, "line_light_add", { path: [P(13), P(14)] });
    const lineId = line.entity?.site_id ?? Object.keys(ws.model.line_strips ?? {}).slice(-1)[0]!;
    created.lines.push(lineId);
    console.log("line_light_add:", JSON.stringify(line.entity));

    // 4. update: перенос узла ленты и шины — длина пересчитывается
    const ledUpd = await call(client, "led_strip_update", { led_strip_id: ledId, positions: [{ vertex: 2, x_mm: P(7).x, y_mm: P(7).y }] });
    console.log("led_strip_update:", JSON.stringify(ledUpd.entity));
    await new Promise((r) => setTimeout(r, 300));
    const stripeUpd = await call(client, "stripe_update", { stripe_id: stripeId, positions: [{ vertex: 1, x_mm: P(10).x, y_mm: P(10).y }] });
    console.log("stripe_update:", JSON.stringify(stripeUpd.entity));

    // 5. validate → save
    const v = await call(client, "model_validate", {});
    const fresh = (v.problems ?? []).filter((p: any) => !baseCodes.has(`${p.code}:${p.details?.wall_id ?? p.details?.hole_id ?? p.details?.item_id ?? ""}`));
    console.log("validate: базовых", (vBase.problems ?? []).length, ", новых", fresh.length);
    if (fresh.length > 0) throw new Error("validate: новые проблемы: " + JSON.stringify(fresh).slice(0, 400));
    persisted = true;
    const t0 = Date.now();
    const saved = await ws.save();
    console.log(`save ok in ${Date.now() - t0} ms; verified=${saved.verified}, rounds=${saved.rounds}, will_delete=${JSON.stringify(saved.will_delete)}`);
    if (!saved.verified) throw new Error("save не verified");

    // 6. reopen + сверка
    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const after = await call(client, "model_get", { detail: "full" });
    const itemsAfter = Object.values<any>(after.items ?? {}).filter((i: any) => created.items.includes(i.id));
    const ledAfter = Object.values<any>(after.led_strips ?? {}).filter((l: any) => created.led.includes(l.id));
    const stripesAfter = Object.values<any>(after.stripes_light ?? {}).filter((l: any) => created.stripes.includes(l.id));
    const linesAfter = Object.values<any>(after.line_strips ?? {}).filter((l: any) => created.lines.includes(l.id));
    console.log("после reopen: предметы", itemsAfter.length, "из", created.items.length,
      "; ленты", ledAfter.length, "из", created.led.length,
      "; шины", stripesAfter.length, "из", created.stripes.length,
      "; линейный", linesAfter.length, "из", created.lines.length);
    if (itemsAfter.length !== created.items.length || ledAfter.length !== 1 || stripesAfter.length !== 2 || linesAfter.length !== 1) {
      throw new Error("объекты не пережили reopen");
    }
    for (const i of itemsAfter) {
      console.log(`предмет ${i.name}: pc=${i.pc.x},${i.pc.y} w=${i.width} over_floor=${JSON.stringify(i.over_floor)} id_wall=${i.id_wall ?? null}`);
    }
    for (const l of [...ledAfter, ...stripesAfter, ...linesAfter]) {
      console.log(`линия ${l.type}: vertexes=${l.vertexes.length} length=${l.length} plan=${JSON.stringify(l.plan ?? null)} prs=${JSON.stringify(l.prs ?? null)} props=${JSON.stringify(l.props)} on_size=${JSON.stringify(l.on_size)} hl=${JSON.stringify((l as any).height_lowering ?? null)} spots=${JSON.stringify((l as any).spots ?? null)} items_keys=${Object.keys(l.items ?? {}).length} vertex0=${JSON.stringify(l.vertexes[0])}`);
    }

    // 7. печать нормализованных линий (для эталонов; обезличивание отдельно)
    console.log("NORMALIZED_LED " + JSON.stringify(ledAfter[0]));
    console.log("NORMALIZED_STRIPE " + JSON.stringify(stripesAfter.find((s: any) => s.type === "pendent_strip")));
    console.log("NORMALIZED_LINE " + JSON.stringify(linesAfter[0]));

    // 8. render PNG листа света
    const rendered = await call(client, "render_plan", { sheet: "light", width_px: 1600 });
    console.log("render_plan ok:", rendered.path, rendered.bytes, "bytes");

    // 9. восстановление: удалить созданное (только свои ID)
    ws.apply("84-live-cleanup", (m) => {
      for (const id of created.led) if (m.led_strips?.[id]) delete m.led_strips[id];
      for (const id of created.stripes) if (m.stripes_light?.[id]) delete m.stripes_light[id];
      for (const id of created.lines) if (m.line_strips?.[id]) delete m.line_strips[id];
      for (const id of created.items) if (m.items[id]) delete m.items[id];
      return { led: created.led.length, stripes: created.stripes.length, lines: created.lines.length, items: created.items.length };
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
    if (persisted && (created.items.length || created.led.length || created.stripes.length || created.lines.length) && before) {
      try {
        const ws = ctx.workspace();
        ws.apply("84-live-cleanup", (m) => {
          for (const id of created.led) if (m.led_strips?.[id]) delete m.led_strips[id];
          for (const id of created.stripes) if (m.stripes_light?.[id]) delete m.stripes_light[id];
          for (const id of created.lines) if (m.line_strips?.[id]) delete m.line_strips[id];
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
