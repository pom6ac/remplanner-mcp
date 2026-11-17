// 122: живая проверка раздела «Тёплый пол, кондиционеры, вентиляция» через MCP-инструменты
// в dev-проекте (REMPLANNER_PROBE_OBJECT_ID/PLAN из env, схема «бэкап → запись → проверка →
// восстановление»; пробы удаляют только созданное ими по ID).
// Контрольный проект (только GET) — REMPLANNER_SNAPSHOT_OBJECT_ID/PLAN.
// Схема: контрольный GET → бэкап → baseline validate → item_add (кондиционер у стены,
// внешний блок, терморегулятор) → warm_floor_add (водяной) → pipe_add (воздуховод +
// магистраль тёплого пола) → validate → save (без NORMALIZATION_DROPPED) → reopen →
// сверка → render PNG (лист warm_floor) → удаление созданного → save → полная
// семантическая сверка data с бэкапом → контрольный GET.
// Watchdog 8 минут, таймауты на вызовах, явный process.exit.
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

const WATCHDOG_MS = 8 * 60_000;
const watchdog = setTimeout(() => {
  console.error(`WATCHDOG: ${WATCHDOG_MS / 1000} с — принудительный выход`);
  process.exit(9);
}, WATCHDOG_MS);

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${label} (${ms} мс)`)), ms)),
  ]);
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await withTimeout(client.callTool({ name, arguments: args }), 120_000, name);
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 600)}`);
  return JSON.parse(text(res as never));
}
async function callInvalid(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await client.callTool({ name, arguments: args });
  const raw = text(res as never);
  let code = "";
  try { code = (JSON.parse(raw) as { code?: string }).code ?? ""; } catch { code = raw.startsWith("MCP error") ? "SCHEMA_REJECT" : raw.slice(0, 40); }
  if (!res.isError) throw new Error(`ожидаемый отказ не случился: ${name}`);
  return code;
}

/** Служебные поля и регенерируемые id (как 113): id комнат rooms1/rooms2 переименовываются
 *  по содержимому; eds2.*.id редактор перегенерирует при каждом пересчёте комнат.
 *  rooms2/settings НЕ исключаются (урок R7 ревью 93). */
function strip(m: any): string {
  const c = structuredClone(m);
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "final", "signals", "smeta_water_pipes", "save_id", "is_forced"]) delete c[k];
  for (const k of ["borders", "drawings"]) {
    if (Array.isArray(c[k])) c[k] = [...c[k]].map((e: any) => JSON.stringify(e)).sort().map((s: string) => JSON.parse(s));
  }
  const stripIds = (v: any): any => {
    if (Array.isArray(v)) return v.map(stripIds);
    if (v !== null && typeof v === "object") {
      const o: any = {};
      for (const [k, val] of Object.entries(v)) o[k] = k === "id" && typeof val === "string" ? "<regen>" : stripIds(val);
      return o;
    }
    return v;
  };
  const norm = (v: any): any => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      const out: any = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  if (c.walls && typeof c.walls === "object") {
    for (const [wid, wall] of Object.entries<any>(c.walls)) {
      if (wall?.eds2) c.walls[wid].eds2 = stripIds(wall.eds2);
    }
  }
  for (const key of ["rooms1", "rooms2"]) {
    if (c[key] && typeof c[key] === "object") {
      const entries = Object.entries<any>(c[key]).map(([rid, r]) => [rid, stripIds(r)] as const)
        .sort((u, v) => JSON.stringify(u[1]).localeCompare(JSON.stringify(v[1])));
      c[key] = Object.fromEntries(entries.map(([, v], i) => [`ROOM${i + 1}`, v]));
    }
  }
  // производные пути, которые редактор дописывает при каждом пересчёте комнат
  // (исключение перечислено в spec этапа 122): warms_walls — ТОЛЬКО доказанно пустые
  // заглушки листа «Тёплые полы» (массив из {exist:false}, R7 ревью 123: иначе сверять
  // строго — потеря реального содержимого тёплой стены не маскируется),
  // zones[].number_by_area — автоматическая нумерация комнат
  const emptyWarmsWalls = (v: unknown): boolean =>
    Array.isArray(v) && v.every((e) => e !== null && typeof e === "object" && Object.keys(e).length === 1 && (e as { exist?: unknown }).exist === false);
  for (const r of Object.values<any>(c.rooms2 ?? {})) {
    if (emptyWarmsWalls(r.warms_walls)) delete r.warms_walls;
    for (const z of r.zones ?? []) delete z.number_by_area;
  }
  return JSON.stringify(norm(c));
}

function diffKeysOf(a: any, b: any, path = "", out: string[] = []): string[] {
  if (out.length > 50) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { out.push(path || "<root>"); return out; }
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) diffKeysOf(a?.[k], b?.[k], path ? `${path}.${k}` : k, out);
  return out;
}

async function main() {
  const ctx = new ServerContext();
  const server = buildServer(ctx);
  const client = new Client({ name: "122-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let persisted = false;
  let before: any = null;
  const created: { warmFloors: string[]; pipes: string[]; items: string[] } = { warmFloors: [], pipes: [], items: [] };

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
    writeFileSync(".orca-reports/backup-dev-122.json", JSON.stringify({
      _source: "GET через project_open + model_get, dev-проект из env, scripts/probes/122-live-check.ts, только чтение; id проектов/планов не печатаются",
      model: before,
    }, null, 1));
    console.log("backup ok; counters:", JSON.stringify({
      walls: Object.keys(before.walls ?? {}).length, items: Object.keys(before.items ?? {}).length,
      rooms: Object.keys(before.rooms2 ?? {}).length,
      warm_floors: Object.keys(before.warm_floors ?? {}).length,
      pipes_ventilation: Object.keys(before.pipes_ventilation ?? {}).length,
    }));

    const vBase = await call(client, "model_validate", {});
    console.log("validate (baseline): проблем", (vBase.problems ?? []).length);

    // 2. инструменты: кондиционер у стены, внешний блок, терморегулятор,
    //    водяной тёплый пол, воздуховод, магистраль тёплого пола
    const rooms = before.rooms2 ?? {};
    // комната и прямоугольник: ищем комнату с площадью ≥ 4 м² и прямоугольник
    // (от большого к малому), целиком лежащий в её полигоне (контур тёплого пола
    // должен лежать внутри одной комнаты — warm_floor_add отвергает иначе)
    const pip = (poly: { x: number; y: number }[], p: { x: number; y: number }): boolean => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
        if (((yi > p.y) !== (yj > p.y)) && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    };
    let cx = 0, cy = 0;
    outer:
    for (const room of Object.values<any>(rooms).sort((a: any, b: any) => (b.area ?? 0) - (a.area ?? 0))) {
      const poly = room.polygon as { x: number; y: number }[];
      if (!poly || (room.area ?? 0) < 4) continue;
      const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
      for (const half of [80, 60, 40, 25]) {
        const mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
        const corners = [[mx - half, my - half], [mx + half, my - half], [mx + half, my + half], [mx - half, my + half], [mx, my]];
        if (corners.every(([x, y]) => pip(poly, { x, y }))) { cx = Math.round(mx * 10); cy = Math.round(my * 10); break outer; }
      }
    }
    if (!cx) throw new Error("не найдена комната для контура тёплого пола");
    const wallId = Object.keys(before.walls ?? {}).find((id: string) => {
      const w = before.walls[id];
      return !w.demount && Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y) > 150;
    });
    if (!wallId) throw new Error("нет стены для пристенных предметов");

    console.log("item_add conditioner:", JSON.stringify(await call(client, "item_add", {
      name: "conditioner",
      position: { against_wall: { wall_id: wallId, offset_mm: 800 } },
    })));
    console.log("item_add conditioner_engine:", JSON.stringify(await call(client, "item_add", {
      name: "conditioner_engine",
      position: { against_wall: { wall_id: wallId, offset_mm: 1400 } },
    })));
    console.log("item_add socket_thermo:", JSON.stringify(await call(client, "item_add", {
      name: "socket_thermo",
      position: { against_wall: { wall_id: wallId, offset_mm: 1200 } },
    })));
    console.log("warm_floor_add water:", JSON.stringify(await call(client, "warm_floor_add", {
      kind: "water", corner1: { x: cx - 400, y: cy - 400 }, corner2: { x: cx + 400, y: cy + 400 },
    })));
    console.log("pipe_add vent_out:", JSON.stringify(await call(client, "pipe_add", {
      kind: "vent_out", path: [{ x: cx - 1000, y: cy + 900 }, { x: cx, y: cy + 900 }],
    })));
    console.log("pipe_add warm_floor:", JSON.stringify(await call(client, "pipe_add", {
      kind: "warm_floor", path: [{ x: cx + 500, y: cy }, { x: cx + 1200, y: cy }],
    })));

    // некорректные вызовы отклоняются атомарно
    for (const [name, args] of [
      ["warm_floor_add", { kind: "cable", corner1: { x: cx - 500, y: cy - 500 }, corner2: { x: cx + 300, y: cy + 300 } }],
      ["warm_floor_add", { kind: "cable", corner1: { x: cx - 5000, y: cy - 500 }, corner2: { x: cx + 3000, y: cy + 300 } }],
      ["warm_floor_add", { kind: "cable", corner1: { x: cx, y: cy }, corner2: { x: cx + 100, y: cy } }],
      ["pipe_add", { kind: "vent_out", path: [{ x: cx, y: cy }, { item_id: "нет_такого" }] }],
    ] as const) {
      const code = await callInvalid(client, name, args as Record<string, unknown>);
      console.log("invalid", name, "→", code);
    }

    // id созданного — из полного model_get (новые против бэкапа)
    const nowFull = await call(client, "model_get", { detail: "full" });
    const newIds = (coll: string): string[] =>
      Object.keys(nowFull[coll] ?? {}).filter((id: string) => !(id in (before[coll] ?? {})));
    created.warmFloors = newIds("warm_floors");
    created.pipes = [
      ...newIds("pipes_warm_floor").map((id) => `pipes_warm_floor/${id}`),
      ...newIds("pipes_conditioner").map((id) => `pipes_conditioner/${id}`),
      ...newIds("pipes_heat").map((id) => `pipes_heat/${id}`),
      ...newIds("pipes_ventilation").map((id) => `pipes_ventilation/${id}`),
    ];
    created.items = newIds("items");
    console.log("created:", JSON.stringify(created));

    // 3. validate → save → reopen → сверка
    const v = await call(client, "model_validate", {});
    console.log("validate: проблем", (v.problems ?? []).length, JSON.stringify((v.problems ?? []).slice(0, 5)));
    // R5 (ревью 123): persisted ставится ДО вызова project_save — вызов способен
    // записать модель и выбросить ошибку при GET-верификации; catch обязан
    // восстанавливать при любом исходе после первой попытки записи
    persisted = true;
    const saveRes = await call(client, "project_save", {});
    console.log("save:", JSON.stringify({ verified: saveRes.verified, rounds: saveRes.rounds, warnings: saveRes.warnings }));
    if (!saveRes.verified) throw new Error("save не verified");

    // reopen: созданное пережило сохранение
    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const afterFull = await call(client, "model_get", { detail: "full" });
    const lostAll = [
      ...created.warmFloors.filter((id) => !(id in (afterFull.warm_floors ?? {}))).map((id) => `warm_floors/${id}`),
      ...created.pipes.filter((ref) => { const [coll, id] = ref.split("/"); return !(id in ((afterFull as any)[coll!] ?? {})); }),
      ...created.items.filter((id) => !(id in (afterFull.items ?? {}))).map((id) => `items/${id}`),
    ];
    // водяной контур: length_pipes и умолчания пережили save
    const wfGot = created.warmFloors.map((id) => afterFull.warm_floors?.[id]).filter(Boolean)[0];
    console.log("reopen:", JSON.stringify({
      lost: lostAll.length ? lostAll : null,
      warm_floor: wfGot ? { type: wfGot.type, length_pipes: wfGot.length_pipes, step: wfGot.step, id_room: !!wfGot.id_room, area: wfGot.area } : null,
      vent: afterFull.pipes_ventilation ? Object.keys(afterFull.pipes_ventilation).length : 0,
    }));
    if (lostAll.length) throw new Error("после reopen созданное потеряно");

    // render листа тёплого пола
    const png = await call(client, "render_plan", { sheet: "warm_floor" });
    console.log("render warm_floor:", png.bytes, "байт,", png.path);

    // 4. восстановление: удалить созданное пробой (по ID)
    for (const ref of created.pipes) await call(client, "pipe_delete", { pipe_id: ref.split("/")[1] });
    for (const id of created.warmFloors) await call(client, "warm_floor_delete", { warm_floor_id: id });
    for (const id of created.items) await call(client, "item_delete", { item_id: id });
    const saveRes2 = await call(client, "project_save", {});
    console.log("cleanup save:", JSON.stringify({ verified: saveRes2.verified, rounds: saveRes2.rounds }));
    if (!saveRes2.verified) throw new Error("cleanup save не verified");

    // 5. полная семантическая сверка с бэкапом
    const after = await call(client, "model_get", { detail: "full" });
    const same = strip(after) === strip(before);
    console.log("полная сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
    if (!same) {
      const diffKeys = diffKeysOf(before, after);
      console.log("различающиеся пути:", diffKeys.slice(0, 20).join(" | "));
      writeFileSync(".orca-reports/backup-dev-122-after.json", JSON.stringify({ model: after }, null, 1));
      throw new Error("модель не совпала с бэкапом");
    }

    // 6. контрольный проект: GET после
    if (SNAP_ID && SNAP_PLAN && snapBefore) {
      await call(client, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
      const snapAfter = JSON.stringify(await call(client, "model_get", { detail: "full" }));
      console.log("контрольный проект:", snapAfter === snapBefore ? "не изменился" : "ИЗМЕНИЛСЯ — СТОП");
      if (snapAfter !== snapBefore) throw new Error("контрольный проект изменился");
    }
    console.log("122-live OK");
    clearTimeout(watchdog);
    await client.close();
    process.exit(0);
  } catch (e) {
    console.error("FAIL:", String((e as Error).message ?? e).slice(0, 800));
    if (process.env.RP_DEBUG) console.error((e as Error).stack);
    // аварийное восстановление (R5, ревью 123): при любой ошибке после первой попытки
    // записи — перечитать модель, удалить созданное пробой, сохранить и сверить data
    // с бэкапом (не считать удаление созданных ID полной заменой сверки)
    try {
      if (persisted && before) {
        await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
        for (const ref of created.pipes) await call(client, "pipe_delete", { pipe_id: ref.split("/")[1] }).catch(() => {});
        for (const id of created.warmFloors) await call(client, "warm_floor_delete", { warm_floor_id: id }).catch(() => {});
        for (const id of created.items) await call(client, "item_delete", { item_id: id }).catch(() => {});
        const r = await call(client, "project_save", {});
        const afterFail = await call(client, "model_get", { detail: "full" });
        const restored = strip(afterFail) === strip(before);
        console.log("аварийное восстановление:", r.verified ? "save OK" : "save не verified", "; сверка с бэкапом:", restored ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
        if (!restored) {
          writeFileSync(".orca-reports/backup-dev-122-after.json", JSON.stringify({ model: afterFail }, null, 1));
          console.error("различающиеся пути:", diffKeysOf(before, afterFail).slice(0, 20).join(" | "));
        }
      }
    } catch (e2) {
      console.error("RESTORE-FAIL:", String((e2 as Error).message ?? e2).slice(0, 400));
    }
    clearTimeout(watchdog);
    await client.close().catch(() => {});
    process.exit(1);
  }
}

await main();
