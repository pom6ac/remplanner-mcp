// 96 (ревью 95 R1–R4): живая проверка закрытия находок в dev-проекте (REMPLANNER_PROBE_OBJECT_ID/PLAN
// из env, схема «бэкап → запись → проверка → восстановление»). Отделка пола/потолка/стены
// в комнате, у которой есть стена с проёмом: save обязан пройти verified без
// NORMALIZATION_DROPPED (сверка 96 объясняет разрывы отделки вокруг проёмов и штатную
// форму UI); после reopen — явно заданные параметры пола на месте (R4); затем
// восстановление прежней отделки → save → полная семантическая сверка data с бэкапом
// (rooms2/settings не исключаются). Контрольный проект (только GET) — REMPLANNER_SNAPSHOT_*.
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

/** Служебные поля, меняющиеся при каждом сохранении/открытии, и регенерируемые id eds2.
 *  rooms2/rooms1/settings НЕ исключаются (урок R7 ревью 93) — отделка сверяется. */
function strip(m: any): string {
  const c = structuredClone(m);
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "final", "signals", "smeta_water_pipes", "save_id", "is_forced"]) delete c[k];
  for (const k of ["borders", "drawings"]) {
    if (Array.isArray(c[k])) c[k] = [...c[k]].map((e: any) => JSON.stringify(e)).sort().map((s: string) => JSON.parse(s));
  }
  // декор-линии отделки: UI пишет линию с отступом от грани, MCP — по ребру;
  // семантика — на каком ребре лежит линия (покрытие), не её точные координаты
  const canonDecorLine = (room: any) => {
    const edges: any[] = room.edges ?? [];
    const distToSeg = (p: any, a: any, b: any): number => {
      const abx = b.x - a.x, aby = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby || 1)));
      return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
    };
    return (line: any): any => {
      if (!line?.p1 || !line?.p2) return line;
      const best = edges.map((e, i) => ({ i, d: distToSeg(line.p1, e.p1, e.p2) + distToSeg(line.p2, e.p1, e.p2) }))
        .sort((u, v) => u.d - v.d)[0];
      return best && best.d < 12 ? { edge: best.i } : line;
    };
  };
  const stripIds = (v: any): any => {
    if (Array.isArray(v)) return v.map(stripIds);
    if (v !== null && typeof v === "object") {
      const o: any = {};
      for (const [k, val] of Object.entries(v)) o[k] = k === "id" && typeof val === "string" ? "<regen>" : stripIds(val);
      return o;
    }
    return v;
  };
  const normRooms = (rooms: any): any => {
    if (!rooms || typeof rooms !== "object") return rooms;
    const out: any = {};
    for (const [rid, r] of Object.entries<any>(rooms)) {
      const canon = canonDecorLine(r);
      const rr: any = structuredClone(r);
      if (Array.isArray(rr.decors)) {
        for (const d of rr.decors) {
          if (d?.exist && d.parts) {
            for (const p of Object.values<any>(d.parts)) {
              p.line = canon(p.line);
              p.line_wall = canon(p.line_wall);
              p.line_decor = canon(p.line_decor);
            }
          }
        }
      }
      out[rid] = stripIds(rr);
    }
    return out;
  };
  const norm = (v: any): any => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      if (Array.isArray(v.decors)) return normRooms(v);
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
  // id комнат в rooms1/rooms2 регенерируются при restore — переименовываем по содержимому
  for (const key of ["rooms1", "rooms2"]) {
    if (c[key] && typeof c[key] === "object") {
      const entries = Object.entries<any>(c[key]).map(([rid, r]) => [rid, stripIds(r)] as const)
        .sort((u, v) => JSON.stringify(u[1]).localeCompare(JSON.stringify(v[1])));
      c[key] = Object.fromEntries(entries.map(([, v], i) => [`ROOM${i + 1}`, v]));
    }
  }
  return JSON.stringify(norm(c));
}

/** Производные/пересчитываемые редактором поля при сверке комнат (не пользовательские). */
function finishSemantics(rooms: Record<string, any>): string {
  const out: Record<string, unknown> = {};
  for (const [rid, r] of Object.entries(rooms)) {
    const f = (r.floors ?? [])[0];
    const c = (r.ceilings ?? [])[0];
    const decors = (r.decors ?? []).map((d: any) => d.exist
      ? Object.values<any>(d.parts ?? {}).map((p) => ({ type: p.type, layer: p.layer, height: p.height, hff: p.height_from_floor }))
      : false);
    out[rid] = {
      floor: f?.exist ? { cover: f.cover, angle: f.angle, width: f.width, height: f.height, stitch: f.stitch_width, lay: f.type_laying } : false,
      ceiling: c?.exist ? { material: c.material, level: c.level, profile: c.profile } : false,
      decors,
    };
  }
  return JSON.stringify(out, Object.keys(out).sort());
}

async function main() {
  const ctx = new ServerContext();
  const server = buildServer(ctx);
  const client = new Client({ name: "96-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let persisted = false;
  let before: any = null;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    writeFileSync(".orca-reports/backup-dev-96.json", JSON.stringify({
      _source: "GET через project_open + model_get, dev-проект из env, scripts/probes/96-live-check.ts, только чтение; id планов/проектов не печатаются",
      model: before,
    }, null, 1));
    console.log("backup ok; counters:", JSON.stringify({
      walls: Object.keys(before.walls ?? {}).length, items: Object.keys(before.items ?? {}).length,
      rooms: Object.keys(before.rooms2 ?? {}).length,
    }));

    const vBase = await call(client, "model_validate", {});
    console.log("validate (baseline): проблем", (vBase.problems ?? []).length);

    // 2. исходная отделка комнат (для восстановления)
    const finishBefore = await call(client, "finish_get", {});
    console.log("отделка до:", JSON.stringify(finishBefore).slice(0, 600));

    // 3. комната со стеной, в которой есть проём (ключевой сценарий ревью 95 R2/R3)
    const wallIds = Object.keys(before.walls ?? {});
    let roomKey: string | null = null;
    let wallKey: string | null = null;
    for (const [rid, r] of Object.entries<any>(before.rooms2 ?? {})) {
      for (const e of (r.edges ?? []) as any[]) {
        const w = (before.walls ?? {})[e.pid];
        if (w && Object.keys(w.holes ?? {}).length > 0) { roomKey = rid; wallKey = e.pid; break; }
      }
      if (roomKey) break;
    }
    if (!roomKey || !wallKey) {
      console.log("нет комнаты со стеной с проёмом — берём первую комнату и её ребро (сценарий проёма не покрыт)");
      roomKey = Object.keys(before.rooms2 ?? {})[0]!;
      wallKey = ((before.rooms2 ?? {})[roomKey]!.edges ?? [])[0]?.pid ?? null;
    }
    if (!wallKey) throw new Error("нет граничной стены");
    const wallIdx = wallIds.indexOf(wallKey);
    const roomLabel = `R${Object.keys(before.rooms2 ?? {}).indexOf(roomKey) + 1}`;
    const wallLabel = wallIdx >= 0 ? `W${wallIdx + 1}` : wallKey;
    console.log(`комната ${roomLabel} (с проёмом на стене ${wallLabel})`);
    await sleep(1500);

    // 4. инструменты: пол (с явно заданными параметрами — R4), потолок, стена с проёмом
    console.log("floor_set:", JSON.stringify(await call(client, "finish_floor_set", {
      room_id: roomLabel, cover: "laminate", angle_deg: 0,
      plank_length_mm: 1200, plank_width_mm: 180, stitch_width_mm: 2, type_laying: "1/2",
    })));
    await sleep(1500);
    console.log("ceiling_set:", JSON.stringify(await call(client, "finish_ceiling_set", {
      room_id: roomLabel, material: "paint_ceiling", level: 0, profile: "standard",
    })));
    await sleep(1500);
    console.log("wall_set (стена с проёмом):", JSON.stringify(await call(client, "finish_wall_set", {
      room_id: roomLabel, wall_id: wallLabel, type: "wallpaper",
    })));
    await sleep(1500);
    // некорректные вызовы отклоняются атомарно (в т.ч. R5 — применимость/диапазоны)
    for (const [name, args] of [
      ["finish_floor_set", { room_id: roomLabel, cover: "no_such_cover" }],
      ["finish_wall_set", { room_id: roomLabel, wall_id: wallLabel, type: "wallpaper_xyz" }],
      ["finish_ceiling_set", { room_id: roomLabel, material: "laminate" }],
      ["finish_floor_set", { room_id: roomLabel, cover: "linoleum", type_laying: "tile" }],
      ["finish_floor_set", { room_id: roomLabel, cover: "laminate", stitch_width_mm: -10 }],
      ["finish_ceiling_set", { room_id: roomLabel, material: "paint_ceiling", profile: "arbitrary-catalog-key" }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      const code = JSON.parse(text(res as never)).code ?? "";
      console.log("invalid", name, JSON.stringify(args.cover ?? args.type ?? args.material), "→", code || "NO-ERROR");
      if (!res.isError) throw new Error(`ожидаемый отказ не случился: ${name}`);
      await sleep(1200);
    }

    // 5. validate → save (обязан пройти verified без NORMALIZATION_DROPPED)
    const v = await call(client, "model_validate", {});
    console.log("validate: проблем", (v.problems ?? []).length);
    const saveRes = await call(client, "project_save", {});
    persisted = true;
    console.log("save:", JSON.stringify({ verified: saveRes.verified, rounds: saveRes.rounds, save_id: saveRes.save_id }));
    if (!saveRes.verified) throw new Error("save не verified");
    await sleep(3000);

    // 6. reopen → сверка: явно заданные параметры пола на месте (R4 после GET)
    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const finAfter = await call(client, "finish_get", {});
    console.log("finish_get после reopen:", JSON.stringify(finAfter).slice(0, 900));
    const reopened = (finAfter as any[]).find((r) => r.site_id === roomKey) ?? {};
    const fl = reopened.floor ?? {};
    for (const [k, expected] of [["plank_length_mm", 1200], ["plank_width_mm", 180], ["stitch_width_mm", 2], ["angle_deg", 0], ["type_laying", "1/2"]] as const) {
      if (fl[k] !== expected) throw new Error(`R4: параметр ${k} не сохранился после GET: ${JSON.stringify(fl)}`);
    }
    console.log("R4 после GET: пользовательские параметры пола на месте");
    await sleep(1500);

    await sleep(2000);

    // 5. восстановление прежней отделки
    await restoreFinish(client, finishBefore);
    const saveRes2 = await call(client, "project_save", {});
    console.log("restore save:", JSON.stringify({ verified: saveRes2.verified, rounds: saveRes2.rounds }));
    if (!saveRes2.verified) throw new Error("restore save не verified");

    // 6. полная семантическая сверка с бэкапом
    const after = await call(client, "model_get", { detail: "full" });
    const same = strip(after) === strip(before);
    console.log("полная сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
    if (!same) {
      const diffKeys = diffKeysOf(before, after);
      console.log("различающиеся пути:", diffKeys.slice(0, 20).join(" | "));
      writeFileSync(".orca-reports/backup-dev-96-after.json", JSON.stringify({ model: after }, null, 1));
    }
    // отделка сверяется отдельно
    const semBefore = finishSemantics(before.rooms2 ?? {});
    const semAfter = finishSemantics(after.rooms2 ?? {});
    console.log("сверка отделки:", semBefore === semAfter ? "OK" : `РАСХОЖДЕНИЕ: ${semBefore.slice(0, 300)} → ${semAfter.slice(0, 300)}`);

    // 7. контрольный проект: GET после
    if (SNAP_ID && SNAP_PLAN && snapBefore) {
      await call(client, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
      const snapAfter = JSON.stringify(await call(client, "model_get", { detail: "full" }));
      console.log("контрольный проект:", snapAfter === snapBefore ? "не изменился" : "ИЗМЕНИЛСЯ — СТОП");
      if (snapAfter !== snapBefore) throw new Error("контрольный проект изменился");
    }
    console.log("96-live OK");
  } catch (e) {
    console.error("FAIL:", String((e as Error).message ?? e).slice(0, 800));
    if (process.env.RP_DEBUG) console.error((e as Error).stack);
    // аварийное восстановление
    try {
      if (persisted && before) {
        await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
        await restoreFinish(client, await call(client, "finish_get", {}) && finishOfBackup(before));
        const r = await call(client, "project_save", {});
        console.log("аварийное восстановление:", r.verified ? "OK" : "не verified");
      }
    } catch (e2) {
      console.error("RESTORE-FAIL:", String((e2 as Error).message ?? e2).slice(0, 400));
    }
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

/** Прежняя отделка из бэкапа: {roomId: {floor, ceiling, walls}} — слепок finish_get-формы. */
function finishOfBackup(backup: any): any[] {
  const rooms = backup.rooms2 ?? {};
  const wallList = Object.keys(backup.walls ?? {});
  return Object.entries(rooms).map(([rid, r]: [string, any]) => {
    const f = (r.floors ?? [])[0];
    const c = (r.ceilings ?? [])[0];
    const walls: unknown[] = [];
    (r.decors ?? []).forEach((d: any, i: number) => {
      if (!d?.exist) return;
      const pid = ((r.edges ?? [])[i] ?? {}).pid;
      const wi = wallList.indexOf(pid);
      for (const part of Object.values<any>(d.parts ?? {})) {
        walls.push({ wall: wi >= 0 ? `W${wi + 1}` : pid, type: part.type, layer: part.layer, height_mm: (part.height ?? 0) * 10, height_from_floor_mm: (part.height_from_floor ?? 0) * 10 });
      }
    });
    return {
      id: `R${Object.keys(rooms).indexOf(rid) + 1}`,
      site_id: rid,
      ...(f?.exist ? { floor: { cover: f.cover, ...(f.angle !== undefined ? { angle_deg: f.angle } : {}), ...(f.width !== undefined ? { plank_length_mm: f.width * 10 } : {}), ...(f.height !== undefined ? { plank_width_mm: f.height * 10 } : {}), ...(f.stitch_width !== undefined ? { stitch_width_mm: f.stitch_width * 10 } : {}), ...(f.type_laying ? { type_laying: f.type_laying } : {}) } } : {}),
      ...(c?.exist ? { ceiling: { material: c.material, level: c.level ?? 0, ...(c.profile ? { profile: c.profile } : {}) } } : {}),
      walls,
    };
  });
}

async function restoreFinish(client: Client, finishBefore: any[]): Promise<void> {
  for (const r of finishBefore as any[]) {
    const rid = r.site_id ?? r.id;
    if (r.floor?.cover) {
      await call(client, "finish_floor_set", {
        room_id: rid, cover: r.floor.cover,
        ...(r.floor.angle_deg !== undefined ? { angle_deg: r.floor.angle_deg } : {}),
        ...(r.floor.plank_length_mm !== undefined ? { plank_length_mm: Math.round(r.floor.plank_length_mm) } : {}),
        ...(r.floor.plank_width_mm !== undefined ? { plank_width_mm: Math.round(r.floor.plank_width_mm) } : {}),
        ...(r.floor.stitch_width_mm !== undefined ? { stitch_width_mm: r.floor.stitch_width_mm } : {}),
        ...(r.floor.type_laying ? { type_laying: r.floor.type_laying } : {}),
      });
    } else {
      await call(client, "finish_floor_remove", { room_id: rid });
    }
    if (r.ceiling?.material) {
      await call(client, "finish_ceiling_set", { room_id: rid, material: r.ceiling.material, level: r.ceiling.level ?? 0 });
    } else {
      await call(client, "finish_ceiling_remove", { room_id: rid });
    }
  }
  // отделка стен: снять всё, вернуть прежнее
  const current = await call(client, "finish_get", {});
  for (const r of current as any[]) {
    if ((r.walls ?? []).length > 0) await call(client, "finish_wall_remove", { room_id: r.site_id ?? r.id });
  }
  for (const r of finishBefore as any[]) {
    for (const w of r.walls ?? []) {
      await call(client, "finish_wall_set", {
        room_id: r.site_id ?? r.id, wall_id: w.wall, type: w.type,
        height_mm: Math.round(w.height_mm ?? 0), height_from_floor_mm: Math.round(w.height_from_floor_mm ?? 0),
      });
    }
  }
}

function diffKeysOf(a: any, b: any, path = "", out: string[] = []): string[] {
  if (out.length > 50) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { out.push(path || "<root>"); return out; }
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) diffKeysOf(a?.[k], b?.[k], path ? `${path}.${k}` : k, out);
  return out;
}

await main();
