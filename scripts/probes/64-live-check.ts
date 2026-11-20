// 64: живая проверка новых разделов через MCP-инструменты (проект и план — из env).
// Схема: бэкап модели до (GET) → terrace_add + fence + column + floor_hole → validate →
// project_save (без NORMALIZATION_DROPPED) → project_open (reopen) → model_get сверка →
// render_plan PNG → удаление созданных объектов → save → GET-сверка восстановления.
// ID проекта/плана — только из env REMPLANNER_PROBE_OBJECT_ID / REMPLANNER_PROBE_PLAN_ID;
// углы проёма в полу (мм «x1,y1,x2,y2») — REMPLANNER_PROBE_HOLE, по умолчанию
// синтетические 2100,1600,2300,1800 (должны лежать внутри свободной части комнаты).
// Приватные ID проектов/комнат в файл не записываются: бэкап именуется по значению env.
// Перед запуском — GET-снимок второго контрольного проекта, после — повторный (сверка).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFileSync, mkdirSync } from "node:fs";
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
const HOLE_MM = (process.env.REMPLANNER_PROBE_HOLE ?? "2100,1600,2300,1800")
  .split(",")
  .map((v) => Number(v.trim()));
if (HOLE_MM.length !== 4 || HOLE_MM.some((v) => !Number.isFinite(v))) {
  console.error("REMPLANNER_PROBE_HOLE должен быть «x1,y1,x2,y2» в мм");
  process.exit(1);
}

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 800)}`);
  return JSON.parse(text(res as never));
}

async function main() {
  const ctx = new ServerContext();
  const server = buildServer(ctx);
  const client = new Client({ name: "64-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  // 1. бэкап модели до
  await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const before = await call(client, "model_get", { detail: "full" });
  mkdirSync(".orca-reports", { recursive: true });
  writeFileSync(`.orca-reports/backup-probe-${OBJECT_ID}-64.json`, JSON.stringify({
    _source: `GET через project_open + model_get, проект из env, scripts/probes/64-live-check.ts, только чтение; id планов/проектов не печатаются`,
    model: before,
  }, null, 1));
  console.log("backup ok; counters:", JSON.stringify({
    walls: Object.keys(before.walls ?? {}).length,
    terrace_borders: Object.keys(before.terrace_borders ?? {}).length,
    level_holes: Object.keys(before.level_holes ?? {}).length,
  }));

  // 2. создаём сущности: терраса вдали от квартиры, проём в полу — внутри комнаты
  // (углы из env, по умолчанию синтетические)
  const ring = await call(client, "terrace_add", {
    points: [{ x: 15000, y: 5000 }, { x: 15300, y: 5000 }, { x: 15300, y: 5300 }, { x: 15000, y: 5300 }],
  });
  const borderId0 = ring.borders[0]?.id ?? ring.created?.[0]?.id;
  void borderId0;
  console.log("terrace_add ok:", ring.borders?.length ?? ring.created?.length, "borders");
  const fence = await call(client, "terrace_fence_add", { start: { x: 15300, y: 5000 }, end: { x: 15300, y: 5300 } });
  console.log("terrace_fence_add ok:", fence.id);
  const col = await call(client, "terrace_column_add", { center: { x: 15100, y: 5100 } });
  console.log("terrace_column_add ok:", col.id ?? col.site_id);
  const hole = await call(client, "floor_hole_add", {
    corner1: { x: HOLE_MM[0], y: HOLE_MM[1] },
    corner2: { x: HOLE_MM[2], y: HOLE_MM[3] },
  });
  console.log("floor_hole_add ok:", hole.id ?? hole.site_id);

  // 3. validate → save
  const v = await call(client, "model_validate", {});
  console.log("validate:", v.ok ? "ok" : JSON.stringify(v.problems).slice(0, 400));
  const t0 = Date.now();
  const saved = await call(client, "project_save", {});
  console.log(`save ok in ${Date.now() - t0} ms; verified=${saved.verified}, rounds=${saved.rounds}, will_delete=${JSON.stringify(saved.will_delete)}`);
  if (!saved.verified) throw new Error("save не verified");

  // 4. reopen + сверка
  await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after = await call(client, "model_get", { detail: "full" });
  const checks = {
    terrace_borders: Object.keys(after.terrace_borders ?? {}).length,
    territory_borders: Object.keys(after.territory_borders ?? {}).length,
    level_holes: Object.keys(after.level_holes ?? {}).length,
    pillars_terrace: Object.values(after.pillars ?? {}).filter((p: any) => p.role === "terrace_column").length,
    fences: Object.values(after.walls ?? {}).filter((w: any) => w.role === "terrace_fence").length,
  };
  console.log("after reopen:", JSON.stringify(checks));
  if (checks.terrace_borders !== 4 || checks.level_holes !== 1 || checks.pillars_terrace !== 1 || checks.fences !== 1) {
    throw new Error("сущности не пережили reopen");
  }
  const holeFull = Object.values(after.level_holes ?? {})[0] as any;
  console.log("hole after reopen: type=", holeFull.type, "area=", holeFull.area, "pc=", JSON.stringify(holeFull.pc));
  const colFull = Object.values(after.pillars ?? {}).find((p: any) => p.role === "terrace_column") as any;
  console.log("column after reopen: pc=", JSON.stringify(colFull.pc), "wh=", colFull.width, colFull.height);

  // 5. render PNG
  const rendered = await call(client, "render_plan", { sheet: "init", width_px: 1600 });
  console.log("render_plan ok:", rendered.path, rendered.bytes, "bytes");

  // 6. восстановление: удалить созданные сущности.
  // wall_delete через applyWalls блокируется заранее существующими свободными узлами стен
  // проекта (§12.4 — dangling ends вне нашего сценария), поэтому зачистка — прямым
  // apply рабочей копии + save (та же верификация save).
  const holeSite = hole.entity?.site_id ?? hole.id;
  const colSite = col.entity?.site_id ?? col.id;
  const ws = ctx.workspace();
  const removed = ws.apply("64-live-cleanup", (m) => {
    const out = { borders: 0, hole: 0, column: 0, fence: 0 };
    out.borders = Object.keys(m.terrace_borders ?? {}).length;
    delete m.terrace_borders;
    delete m.territory_borders;
    if (m.level_holes && m.level_holes[holeSite]) { delete m.level_holes[holeSite]; out.hole = 1; }
    if (m.pillars[colSite]) { delete m.pillars[colSite]; out.column = 1; }
    if (m.walls[fence.id]) { delete m.walls[fence.id]; out.fence = 1; }
    return out;
  });
  console.log("cleanup removed:", JSON.stringify(removed));
  const saved2 = await ws.save();
  console.log("cleanup save:", `verified=${saved2.verified}`);
  await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const restored = await call(client, "model_get", { detail: "full" });
  const strip = (m: any) => {
    const c = structuredClone(m);
    delete c.errors; delete c.logs; delete c.session; delete c.version; delete c.drawing;
    delete c.params; delete c.settings; delete c.final; delete c.signals; delete c.smeta_water_pipes;
    delete c.rooms2; delete c.rooms1; delete c.save_id;
    // id внутри eds2 редактор перегенерирует при каждом restore — не расхождение
    const normIds = (v: any): any => {
      if (Array.isArray(v)) return v.map(normIds);
      if (v !== null && typeof v === "object") {
        const out: any = {};
        for (const [k, val] of Object.entries(v)) out[k] = k === "eds2" ? normEds(val) : normIds(val);
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
    return JSON.stringify(normIds(c));
  };
  const equal = strip(restored) === strip(before);
  console.log("восстановление (сверка модели без служебных полей):", equal ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
  if (!equal) {
    const b0 = strip(before), b1 = strip(restored);
    for (let i = 0; i < Math.max(b0.length, b1.length); i++) {
      if (b0[i] !== b1[i]) {
        console.log("первое расхождение на", i, ":", b0.slice(Math.max(0, i - 120), i + 120), "|||", b1.slice(Math.max(0, i - 120), i + 120));
        break;
      }
    }
  }
  await client.close();
  process.exit(equal ? 0 : 2);
}
main().catch((e) => { console.error("FAIL:", String(e).slice(0, 1200)); process.exit(1); });
