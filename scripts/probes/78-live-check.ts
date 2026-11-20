// 78: живая проверка раздела «Сантехника и водоснабжение» через MCP-инструменты
// (проект из env REMPLANNER_PROBE_OBJECT_ID / REMPLANNER_PROBE_PLAN_ID — PRO, схема
// «бэкап → запись → проверка → восстановление»; пробы удаляют ТОЛЬКО созданные
// ими объекты по ID). Контрольный проект (только GET, писать запрещено) —
// REMPLANNER_SNAPSHOT_OBJECT_ID / REMPLANNER_SNAPSHOT_PLAN_ID.
// Схема: контрольный GET → бэкап → baseline validate → точки воды (waterspots) +
// трубы (pipe_add water/drainage с подключением к коллектору) → validate →
// project_save (без NORMALIZATION_DROPPED) → reopen → сверка → печать нормализованной
// трубы (для эталона ui-ref-plumb-pipe, обезличивается отдельно) → render PNG →
// cleanup: pipe_delete → item_delete (только созданные пробой) → save → сверка с бэкапом.
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
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 800)}`);
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
  const client = new Client({ name: "78-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const created: { items: string[]; pipes: string[] } = { items: [], pipes: [] };
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
    writeFileSync(`../../.orca-reports/backup-${OBJECT_ID}-78.json`, JSON.stringify({
      _source: "GET через project_open + model_get, проект из env, scripts/probes/78-live-check.ts, только чтение; id планов/проектов не печатаются",
      model: before,
    }, null, 1));
    console.log("backup ok; counters:", JSON.stringify({
      walls: Object.keys(before.walls ?? {}).length, items: Object.keys(before.items ?? {}).length,
      pipes: Object.keys(before.pipes ?? {}).length,
    }));

    const vBase = await call(client, "model_validate", {});
    const baseCodes = new Set((vBase.problems ?? []).map((p: any) => `${p.code}:${p.details?.wall_id ?? p.details?.hole_id ?? p.details?.item_id ?? ""}`));
    console.log("validate (baseline): проблем", (vBase.problems ?? []).length);

    // 2. точки воды: коллектор у стены + комбинированные выводы; стены проекта из модели
    const walls = Object.values<any>(before.walls ?? {}).filter((w: any) => w.plan === "a" && w.role === "wall");
    if (!walls.length) throw new Error("нет стен");
    // стены проекта пользователя не трогаем: точки ставим центром в комнатах (free-магнит)
    const room = Object.values<any>(before.rooms2 ?? {})[0]!;
    const poly: { x: number; y: number }[] = room.polygon ?? room.points ?? [];
    const cx = Math.round(poly.reduce((s, p) => s + p.x, 0) / poly.length * 10);
    const cy = Math.round(poly.reduce((s, p) => s + p.y, 0) / poly.length * 10);
    console.log("базовая точка (центр первой комнаты), мм:", cx, cy);
    const ws = ctx.workspace();

    // ставим через MCP item_add (полный путь инструментов); коллектор — anchor:wall:
    // перебираем стены-кандидаты (проба 57/71 — item_add атомарен, отказ не меняет модель)
    let s1id: string | null = null;
    for (const w of walls) {
      const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
      if (len < 100) continue;
      try {
        await call(client, "item_add", {
          name: "waterspot_collector",
          position: { against_wall: { wall_id: w.id, offset_mm: Math.round(len * 10 / 2) } },
        });
        s1id = Object.keys(ws.model.items).slice(-1)[0]!;
        console.log("коллектор у стены", w.id);
        break;
      } catch (e) {
        console.log("стена отклонена:", w.id, String((e as Error).message).replace(/\s+/g, " ").slice(0, 90));
      }
    }
    if (!s1id) throw new Error("коллектор не поставился ни у одной стены");
    const lastItem = () => Object.keys(ws.model.items).slice(-1)[0]!;
    created.items.push(s1id);
    await new Promise((r) => setTimeout(r, 300));
    await call(client, "item_add", { name: "waterspot_cold_hot", position: { center: { x: cx + 200, y: cy - 200 } } });
    const s2id = lastItem();
    created.items.push(s2id);
    await call(client, "item_add", { name: "waterspot_drainage_cold_hot", position: { center: { x: cx - 200, y: cy - 200 } } });
    const s3id = lastItem();
    created.items.push(s3id);
    console.log("точки воды:", s1id, s2id, s3id, "over_floor:", JSON.stringify((ws.model.items[s1id] as any).over_floor), JSON.stringify((ws.model.items[s2id] as any).over_floor), JSON.stringify((ws.model.items[s3id] as any).over_floor));

    // 3. трубы: ХВС от коллектора к выводу, канализация от вывода к коллектору
    const pipe1 = await call(client, "pipe_add", { kind: "water", path: [{ item_id: s1id }, { x: cx + 200, y: cy - 200 }, { item_id: s2id }] });
    const p1id = pipe1.entity?.site_id ?? Object.keys(ws.model.pipes ?? {}).slice(-1)[0]!;
    created.pipes.push(p1id);
    console.log("pipe_add water:", JSON.stringify(pipe1.entity));
    await new Promise((r) => setTimeout(r, 300));
    const pipe2 = await call(client, "pipe_add", { kind: "drainage", path: [{ item_id: s3id }, { x: cx + 600, y: cy + 200 }] });
    const p2id = pipe2.entity?.site_id ?? Object.keys(ws.model.pipes ?? {}).slice(-1)[0]!;
    created.pipes.push(p2id);
    console.log("pipe_add drainage:", JSON.stringify(pipe2.entity));
    // обратные ссылки
    console.log("props.pipes:", JSON.stringify({
      collector: (ws.model.items[s1id] as any).pipes,
      spot2: (ws.model.items[s2id] as any).pipes,
      spot3: (ws.model.items[s3id] as any).pipes,
    }));

    // 4. validate → save
    const v = await call(client, "model_validate", {});
    const fresh = (v.problems ?? []).filter((p: any) => !baseCodes.has(`${p.code}:${p.details?.wall_id ?? p.details?.hole_id ?? p.details?.item_id ?? ""}`));
    console.log("validate: базовых", (vBase.problems ?? []).length, ", новых", fresh.length);
    if (fresh.length > 0) throw new Error("validate: новые проблемы: " + JSON.stringify(fresh).slice(0, 400));
    persisted = true;
    const t0 = Date.now();
    const saved = await ws.save();
    console.log(`save ok in ${Date.now() - t0} ms; verified=${saved.verified}, rounds=${saved.rounds}, will_delete=${JSON.stringify(saved.will_delete)}`);
    if (!saved.verified) throw new Error("save не verified");

    // 5. reopen + сверка
    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const after = await call(client, "model_get", { detail: "full" });
    const pipesAfter = Object.values<any>(after.pipes ?? {}).filter((p: any) => created.pipes.includes(p.id));
    const spotsAfter = Object.values<any>(after.items ?? {}).filter((i: any) => created.items.includes(i.id ?? i.item_id));
    console.log("после reopen: трубы", pipesAfter.length, "из", created.pipes.length, "; точки воды", spotsAfter.length, "из", created.items.length);
    if (pipesAfter.length !== 2 || spotsAfter.length !== 3) throw new Error("объекты не пережили reopen");
    for (const p of pipesAfter) {
      console.log(`труба ${p.id}: type=${p.type} vertexes=${p.vertexes.length} length=${p.length} plan=${p.plan ?? "<нет поля plan>"} items=${JSON.stringify(p.items)}`);
    }
    for (const i of spotsAfter) {
      console.log(`точка ${i.id}: name=${i.name} pc=${i.pc.x},${i.pc.y} over_floor=${JSON.stringify(i.over_floor)} id_wall=${i.id_wall ?? null}`);
    }

    // 6. печать нормализованной трубы (для эталона ui-ref-plumb-pipe; обезличивание отдельно)
    console.log("NORMALIZED_PIPE " + JSON.stringify(pipesAfter.find((p: any) => p.type === "water_pipe")));

    // 7. render PNG листа водоснабжения
    const rendered = await call(client, "render_plan", { sheet: "waterplan", width_px: 1600 });
    console.log("render_plan ok:", rendered.path, rendered.bytes, "bytes");

    // 8. восстановление: удалить созданные трубы и предметы (только свои ID)
    ws.apply("78-live-cleanup", (m) => {
      for (const id of created.pipes) {
        if (m.pipes?.[id]) delete m.pipes[id];
      }
      for (const id of created.items) {
        if (m.items[id]) delete m.items[id];
      }
      return { pipes: created.pipes.length, items: created.items.length };
    });
    await new Promise((res) => setTimeout(res, 5000)); // сохранение не чаще раза в 5 с
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

    // 9. контрольный проект: GET после, сверка с «до»
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
    if (persisted && (created.pipes.length || created.items.length) && before) {
      try {
        const ws = ctx.workspace();
        ws.apply("78-live-cleanup", (m) => {
          for (const id of created.pipes) if (m.pipes?.[id]) delete m.pipes[id];
          for (const id of created.items) if (m.items[id]) delete m.items[id];
          return { pipes: created.pipes.length, items: created.items.length };
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
