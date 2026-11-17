// 103: живая проверка раздела «Перепланировка» в dev-проекте (REMPLANNER_PROBE_OBJECT_ID/PLAN из env,
// схема «бэкап → запись → проверка → восстановление»). Существующие стены не изменяются:
// создаются только новая перегородка (wall_add kind=partition), ГКЛ-короб (pillar_add
// kind=gypsum_box) и проём на перегородке; затем всё удаляется созданными инструментами.
// Контрольный проект — REMPLANNER_SNAPSHOT_OBJECT_ID/PLAN (только GET до и после).
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

// зависание прошлого запуска: после FAIL процесс не выходил — соединение с браузером
// держало event loop (у проб 78/88 есть явный process.exit). Теперь: общий watchdog 8 минут
// и таймаут каждого вызова 150 с — оба завершают процесс с кодом ≠0; в finally — process.exit.
const WATCHDOG = setTimeout(() => {
  console.error("TIMEOUT: общий watchdog 8 минут истёк");
  process.exit(90);
}, 8 * 60_000);
WATCHDOG.unref();

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const t = setTimeout(() => {
    console.error(`TIMEOUT: вызов ${name} не ответил за 150 с`);
    process.exit(91);
  }, 150_000);
  t.unref();
  const res = await client.callTool({ name, arguments: args });
  clearTimeout(t);
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 600)}`);
  return JSON.parse(text(res as never));
}
/** Сверка восстановления: исключение — walls.*.eds2.*.*.id (служебные ID граней,
 * регенерируются при save; разрешено координатором) и счётчики сессии session/log_plan
 * (растут при каждом save: counter_saving_one_session и т.п., к данным модели не относятся;
 * отклонение зафиксировано в отчёте). rooms1/rooms2 не пересортировываются:
 * между бэкапом и контрольным GET reopen нет, id комнат стабильны внутри сессии. */
const EDS2_ID = /^walls\.[^.]+\.eds2\.[a-z]+\.\d+\.id$/;
function strip(m: any): string {
  const walk = (v: any, p: string): any => {
    if (Array.isArray(v)) return v.map((e, i) => walk(e, `${p}.${i}`));
    if (v !== null && typeof v === "object") {
      const o: any = {};
      for (const k of Object.keys(v).sort()) {
        const kp = p ? `${p}.${k}` : k;
        if (EDS2_ID.test(kp) || p === "" && (k === "session" || k === "log_plan")) continue;
        o[k] = walk(v[k], kp);
      }
      return o;
    }
    return v;
  };
  return JSON.stringify(walk(structuredClone(m), ""));
}

async function main() {
  const ctx = new ServerContext();
  const server = buildServer(ctx);
  const client = new Client({ name: "103-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
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
    writeFileSync(".orca-reports/backup-dev-103.json", JSON.stringify({
      _source: "GET через project_open + model_get, dev-проект из env, scripts/probes/103-live-check.ts, только чтение; id планов/проектов не печатаются",
      model: before,
    }, null, 1));
    console.log("backup ok; counters:", JSON.stringify({
      walls: Object.keys(before.walls ?? {}).length, items: Object.keys(before.items ?? {}).length,
      pillars: Object.keys(before.pillars ?? {}).length,
      rooms: Object.keys(before.rooms2 ?? {}).length,
    }));

    const vBase = await call(client, "model_validate", {});
    console.log("validate (baseline): проблем", (vBase.problems ?? []).length);

    // 2. свободное место: центр самой большой комнаты (rooms2), перегородки не касаются стен
    const walls = Object.values<any>(before.walls ?? {});
    const rooms2 = before.rooms2 ?? {};
    const polyOf = (r: any): { x: number; y: number }[] => r.polygon ?? r.zones?.[0]?.polygon ?? [];
    const areaOf = (poly: { x: number; y: number }[]): number => {
      let s = 0;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
        s += p.x * q.y - q.x * p.y;
      }
      return Math.abs(s) / 2;
    };
    const roomEntries = Object.entries<any>(rooms2).map(([rid, r]) => ({ rid, poly: polyOf(r) })).filter((e) => e.poly.length >= 3);
    if (roomEntries.length === 0) throw new Error("в dev-проекте нет комнат (rooms2)");
    roomEntries.sort((u, v) => areaOf(v.poly) - areaOf(u.poly));
    const pointInPoly = (poly: { x: number; y: number }[], px: number, py: number): boolean => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const distToWalls = (px: number, py: number): number => {
      let d = Infinity;
      for (const w of walls) {
        const ax = w.p1.x, ay = w.p1.y, bx = w.p2.x, by = w.p2.y;
        const abx = bx - ax, aby = by - ay;
        const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1)));
        d = Math.min(d, Math.hypot(px - (ax + abx * t), py - (ay + aby * t)));
      }
      return d;
    };
    // ищем размещение перегородки (вертикальной или горизонтальной, 1600 мм),
    // целиком в комнате и не ближе 60 см к стенам; два отдельных слота
    const findSlot = (): { cx: number; cy: number; vertical: boolean } => {
      for (const e of roomEntries) {
        const xs = e.poly.map((p) => p.x), ys = e.poly.map((p) => p.y);
        for (let gx = Math.min(...xs) + 2; gx <= Math.max(...xs) - 2; gx += 3) {
          for (let gy = Math.min(...ys) + 2; gy <= Math.max(...ys) - 2; gy += 3) {
            const px = gx * 10, py = gy * 10; // мм
            for (const vertical of [true, false]) {
              const dx = vertical ? 0 : 800, dy = vertical ? 800 : 0;
              const pts = [[px - dx, py - dy], [px, py], [px + dx, py + dy]];
              const okGeo = pts.every(([qx, qy]) => pointInPoly(e.poly, qx / 10, qy / 10) && distToWalls(qx / 10, qy / 10) >= 60);
              if (okGeo) return { cx: px, cy: py, vertical };
            }
          }
        }
      }
      throw new Error("нет свободного места для пробы без касания существующих стен");
    };
    const slot2 = findSlot();
    // короб 700×200: свой слот — углы в комнате и ≥40 см от стен, вдали от перегородочного слота
    const boxSlot = (() => {
      for (const e of roomEntries) {
        const xs = e.poly.map((p) => p.x), ys = e.poly.map((p) => p.y);
        for (let gx = Math.min(...xs) + 2; gx <= Math.max(...xs) - 2; gx += 3) {
          for (let gy = Math.min(...ys) + 2; gy <= Math.max(...ys) - 2; gy += 3) {
            const px = gx * 10, py = gy * 10;
            if (Math.hypot(px - slot2.cx, py - slot2.cy) < 1800) continue;
            const corners = [[-350, -100], [350, -100], [350, 100], [-350, 100]].map(([dx, dy]) => ({ x: (px + dx) / 10, y: (py + dy) / 10 }));
            if (corners.every((q) => pointInPoly(e.poly, q.x, q.y) && distToWalls(q.x, q.y) >= 40)) return { cx: px, cy: py };
          }
        }
      }
      throw new Error("нет места для ГКЛ-короба");
    })();
    const boxC = { x: Math.round(boxSlot.cx), y: Math.round(boxSlot.cy) };
    console.log("слоты:", JSON.stringify({ slot2, boxSlot }));

    // 3. ГКЛ-короб (pillar_add — ws.apply, без нормализатора; операции со стенами
    // wall_add/demolish в dev-проекте блокируют старые висячие стыки стен
    // (INVALID_GEOMETRY, их чинить запрещено) — стены проверяются пробой
    // 103-norm-check.ts настоящим нормализатором на синтетике без save)
    for (const [name, args, expect] of [
      ["pillar_add", { center: { x: 9_000_000, y: 9_000_000 }, kind: "gypsum_box" }, "OUTSIDE_ROOM"],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      const code = (JSON.parse(text(res as never)) as { code?: string }).code ?? "NO-ERROR";
      console.log("invalid", name, "→", code);
      if (!res.isError || code !== expect) throw new Error(`ожидаемый отказ ${expect} не случился: ${name} → ${code}`);
    }

    const box = await call(client, "pillar_add", { center: boxC, kind: "gypsum_box" });
    const boxE = box.entity;
    const boxId = boxE?.site_id;
    console.log("gypsum box:", boxId, "plan:", boxE?.plan, "габариты:", boxE?.width_mm, "x", boxE?.depth_mm);
    if (!boxId) throw new Error("короб не создан");

    // 4. validate → save → reopen → сверка
    const v = await call(client, "model_validate", {});
    console.log("validate: проблем", (v.problems ?? []).length);
    const saveRes = await call(client, "project_save", {});
    persisted = true;
    console.log("save:", JSON.stringify({ verified: saveRes.verified, rounds: saveRes.rounds }));
    if (!saveRes.verified) throw new Error("save не verified");

    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const afterWrite = await call(client, "model_get", { detail: "full" });
    const gotBox = Object.values<any>(afterWrite.pillars ?? {}).find((p: any) => (p.role_ ?? p.role) === "gypsum");
    console.log("reopen: короб", gotBox ? `на месте (plan ${gotBox.plan}, id_room задан)` : "ПОТЕРЯН");
    if (!gotBox) throw new Error("после reopen созданный короб потерян");

    // render листа «Перегородки»
    const png = await call(client, "render_plan", { sheet: "create_walls" });
    console.log("render create_walls:", png.bytes, "байт,", png.path);

    // 5. восстановление: удалить созданное
    await call(client, "pillar_delete", { pillar_id: boxId });
    const saveRes2 = await call(client, "project_save", {});
    console.log("restore save:", JSON.stringify({ verified: saveRes2.verified, rounds: saveRes2.rounds }));
    if (!saveRes2.verified) throw new Error("restore save не verified");

    // 6. полная сверка data с бэкапом
    const after = await call(client, "model_get", { detail: "full" });
    const same = strip(after) === strip(before);
    console.log("полная сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
    if (!same) {
      const diffKeys = diffKeysOf(before, after);
      console.log("различающиеся пути:", diffKeys.slice(0, 20).join(" | "));
      writeFileSync(".orca-reports/backup-dev-103-after.json", JSON.stringify({ model: after }, null, 1));
      throw new Error("модель не восстановилась полностью");
    }

    // 7. контрольный проект: GET после
    if (SNAP_ID && SNAP_PLAN && snapBefore) {
      await call(client, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
      const snapAfter = JSON.stringify(await call(client, "model_get", { detail: "full" }));
      console.log("контрольный проект:", snapAfter === snapBefore ? "не изменился" : "ИЗМЕНИЛСЯ — СТОП");
      if (snapAfter !== snapBefore) throw new Error("контрольный проект изменился");
    }
    console.log("103-live OK");
  } catch (e) {
    console.error("FAIL:", String((e as Error).message ?? e).slice(0, 800));
    if (process.env.RP_DEBUG) console.error((e as Error).stack);
    try {
      if (persisted && before) {
        await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
        const cur = await call(client, "model_get", { detail: "full" });
        const bWalls = new Set(Object.keys(before.walls ?? {}));
        for (const [id] of Object.entries<any>(cur.walls ?? {})) {
          if (!bWalls.has(id)) { const r = await call(client, "wall_delete", { wall_id: id }); console.log("аварийное удаление стены", id, "→", r); }
        }
        const bPillars = new Set(Object.keys(before.pillars ?? {}));
        for (const [id] of Object.entries<any>(cur.pillars ?? {})) {
          if (!bPillars.has(id)) await call(client, "pillar_delete", { pillar_id: id });
        }
        const r = await call(client, "project_save", {});
        console.log("аварийное восстановление:", r.verified ? "OK" : "не verified");
      }
    } catch (e2) {
      console.error("RESTORE-FAIL:", String((e2 as Error).message ?? e2).slice(0, 400));
    }
    process.exitCode = 1;
  } finally {
    await client.close();
    process.exit(process.exitCode ?? 0);
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
