// 92 (вариант 3, согласован координатором): живая проверка правки R1a/R1b БЕЗ
// wall_move — в dev-проекте (REMPLANNER_PROBE_OBJECT_ID/PLAN_ID) предсуществующие
// висячие стыки стен (normalize нетронутой модели отдаёт 7 несоединённых концов),
// гарда §12.4 в applyWalls блокирует любые мутации стен; стыки не чинить.
// Схема: контрольный GET → бэкап → выключатель у стены + светильник + cable_add →
// save verified → reopen → cleanup (только свои ID) → save → сверка с бэкапом →
// контрольный GET.
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

const pace = () => new Promise((r) => setTimeout(r, 400));

async function main() {
  const ctx = new ServerContext();
  const server = buildServer(ctx);
  const client = new Client({ name: "92-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const created: { items: string[]; cables: string[] } = { items: [], cables: [] };
  let persisted = false;
  let before: any = null;
  let ws: ReturnType<ServerContext["workspace"]> | null = null;

  const cleanupCreated = async (): Promise<void> => {
    for (const id of created.cables) {
      try { await call(client, "cable_delete", { cable_id: id }); } catch { /* уже нет */ }
      await pace();
    }
    created.cables = [];
    for (const id of [...created.items].reverse()) {
      try { await call(client, "item_delete", { item_id: id }); } catch { /* уже нет */ }
      await pace();
    }
    created.items = [];
  };

  try {
    // 0. контрольный проект: GET до (запись запрещена)
    let snapBefore: string | null = null;
    if (SNAP_ID && SNAP_PLAN) {
      await call(client, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
      snapBefore = JSON.stringify(await call(client, "model_get", { detail: "full" }));
      console.log("контрольный проект: снимок до снят");
      await pace();
    }

    // 1. бэкап модели до
    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    before = await call(client, "model_get", { detail: "full" });
    writeFileSync(`../../.orca-reports/backup-${OBJECT_ID}-92.json`, JSON.stringify({
      _source: "GET через project_open + model_get, проект из env, scripts/probes/92-fix2-live-check.ts, только чтение; id проектов/планов не печатаются",
      model: before,
    }, null, 1));
    console.log("backup ok; counters:", JSON.stringify({
      walls: Object.keys(before.walls ?? {}).length, items: Object.keys(before.items ?? {}).length,
      cables: Object.keys(before.cables ?? {}).length,
    }));
    ws = ctx.workspace();

    // 2. выключатель у стены (перебор стен-кандидатов) + светильник + связь
    const wallList = Object.values<any>(before.walls ?? {}).filter((w: any) => w.plan === "a" && w.role === "wall");
    let swId: string | null = null;
    let lastErr: Error | null = null;
    for (const w of wallList) {
      const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
      if (len * 10 < 1500) continue;
      try {
        await call(client, "item_add", { name: "light_switch", position: { against_wall: { wall_id: w.id, offset_mm: 1000 } } });
        swId = Object.keys(ws!.model.items).slice(-1)[0]!;
        created.items.push(swId);
        break;
      } catch (e) {
        lastErr = e as Error;
        console.log("  стена отклонена:", String((e as Error).message).replace(/\s+/g, " ").slice(0, 110));
      }
    }
    if (!swId) throw lastErr ?? new Error("выключатель не поставился");
    await pace();
    const sw = ws!.model.items[swId] as any;
    console.log(`item_add light_switch: ${swId}`, JSON.stringify({
      pc: sw.pc, id_wall: sw.id_wall, of: sw.over_floor,
      subs: (sw.socket_group ?? []).map((s: any) => ({ name: s.name, center: s.center, real_center: s.real_center })),
    }));

    const roomsAll = Object.values<any>(before.rooms2 ?? {});
    let poly: { x: number; y: number }[] = [];
    for (const r of [...roomsAll].sort((r1: any, r2: any) => (r2.area ?? 0) - (r1.area ?? 0))) {
      const p: { x: number; y: number }[] = r.polygon ?? r.points ?? [];
      if (p.length >= 3) { poly = p; break; }
    }
    const cx = Math.round(poly.reduce((s, p) => s + p.x, 0) / poly.length * 10);
    const cy = Math.round(poly.reduce((s, p) => s + p.y, 0) / poly.length * 10);
    await call(client, "item_add", { name: "chandelier", position: { center: { x: cx, y: cy } } });
    const lampId = Object.keys(ws!.model.items).slice(-1)[0]!;
    created.items.push(lampId);
    await pace();
    console.log(`item_add chandelier: ${lampId}`);

    const c1 = await call(client, "cable_add", { switch_item_id: swId, lamp_item_id: lampId });
    const c1Id = c1.entity?.site_id ?? Object.keys(ws!.model.cables ?? {}).slice(-1)[0]!;
    created.cables.push(c1Id);
    await pace();
    console.log("cable_add:", JSON.stringify(c1.entity));

    // 3. save — verified (R1a/R1b: производные под-розеток до save не сверяются,
    //    over_floor.value обязателен и сверяется)
    persisted = true;
    const t0 = Date.now();
    const saved1 = await ws!.save();
    console.log(`save ok in ${Date.now() - t0} ms; verified=${saved1.verified}, rounds=${saved1.rounds}, will_delete=${JSON.stringify(saved1.will_delete)}`);
    if (!saved1.verified) throw new Error("save не verified");

    // 4. reopen: созданные объекты на месте
    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    await pace();
    const after = await call(client, "model_get", { detail: "full" });
    const itemsAfter = Object.values<any>(after.items ?? {}).filter((i: any) => created.items.includes(i.id));
    const cablesAfter = Object.values<any>(after.cables ?? {}).filter((l: any) => created.cables.includes(l.id));
    console.log("после reopen: предметы", itemsAfter.length, "из", created.items.length, "; связи", cablesAfter.length, "из", created.cables.length);
    if (itemsAfter.length !== created.items.length || cablesAfter.length !== created.cables.length) {
      throw new Error("объекты не пережили reopen");
    }
    for (const i of itemsAfter) {
      console.log(`предмет ${i.name}: pc=${i.pc.x},${i.pc.y} id_wall=${i.id_wall} over_floor=${JSON.stringify(i.over_floor)} subs=${JSON.stringify((i.socket_group ?? []).map((s: any) => ({ center: s.center, real_center: s.real_center })))}`);
    }

    // 5. восстановление: только свои ID
    await cleanupCreated();
    await new Promise((r) => setTimeout(r, 5000)); // сохранение не чаще раза в 5 с
    const saved2 = await ws!.save();
    console.log("cleanup save:", `verified=${saved2.verified}, will_delete=${JSON.stringify(saved2.will_delete)}`);
    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    await pace();
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

    // 6. контрольный проект: GET после, сверка с «до»
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
    console.error("FAIL:", String(e).slice(0, 1500));
    if (before) {
      try {
        await cleanupCreated();
        if (persisted) {
          await new Promise((res) => setTimeout(res, 5000));
          const s = await ws!.save();
          await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
          const restored = await call(client, "model_get", { detail: "full" });
          const equal = strip(restored) === strip(before);
          console.log("аварийное восстановление:", `save verified=${s.verified}, сверка с бэкапом ${equal ? "OK" : "РАСХОЖДЕНИЕ"}`);
        }
      } catch (e2) {
        console.error("аварийное восстановление НЕ УДАЛОСЬ:", String(e2).slice(0, 400));
      }
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error("FAIL:", (e && e.stack) || String(e)); process.exit(1); });
