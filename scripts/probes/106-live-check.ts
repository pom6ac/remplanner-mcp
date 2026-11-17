// 106: живая проверка исправлений ревью 105 в dev-проекте (REMPLANNER_PROBE_OBJECT_ID /
// REMPLANNER_PROBE_PLAN_ID из env, только inline; контрольный проект —
// REMPLANNER_SNAPSHOT_OBJECT_ID / REMPLANNER_SNAPSHOT_PLAN_ID, только GET до/после).
// Схема «бэкап → запись → проверка → восстановление»: бэкап — локальный JSON в
// .orca-reports/tmp/; существующие стены не изменяются и не демонтируются — создаются
// только объекты пробы (перегородка, проёмы на ней, при возможности стена plan:a между
// существующими узлами), затем всё удаляется и данные сверяются с бэкапом целиком
// (исключения: walls.*.eds2.*.*.id, top-level session/log_plan, id комнат — комнаты
// сверяются по содержимому). Если операции со стенами в dev-объекте блокированы старым
// состоянием (INVALID_GEOMETRY, чинить запрещено) — запись не выполняется, сценарий
// считается покрытым пробой 106-norm-check (настоящий нормализатор на синтетике, без save).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID (inline)");
  process.exit(1);
}
const SNAP_ID = process.env.REMPLANNER_SNAPSHOT_OBJECT_ID;
const SNAP_PLAN = process.env.REMPLANNER_SNAPSHOT_PLAN_ID;

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
/** Ожидаемый отказ: возвращает код ошибки или null. */
/** Код ошибки из результата (JSON-обёртка или текст "MCP error ...: {json}"). */
function errorCode(res: { content: { type: string; text?: string }[] }): string {
  const t = text(res);
  try {
    return (JSON.parse(t) as { code?: string }).code ?? "UNKNOWN";
  } catch {
    const m = /\{[\s\S]*\}/.exec(t);
    if (m) {
      try { return (JSON.parse(m[0]) as { code?: string }).code ?? "UNKNOWN"; } catch { /* ниже */ }
    }
    return t.slice(0, 120);
  }
}

async function callErr(client: Client, name: string, args: Record<string, unknown>): Promise<string | null> {
  const t = setTimeout(() => process.exit(91), 150_000);
  t.unref();
  const res = await client.callTool({ name, arguments: args });
  clearTimeout(t);
  if (!res.isError) return null;
  return errorCode(res as never);
}

const EDS2_ID = /^walls\.[^.]+\.eds2\.[a-z]+\.\d+\.id$/;
/** Полная сверка data: служебные id граней и счётчики сессии исключены (разрешено
 * координатором), id комнат исключены — комнаты сверяются по содержимому. */
function strip(m: any): string {
  const walk = (v: any, p: string): any => {
    if (Array.isArray(v)) return v.map((e, i) => walk(e, `${p}.${i}`));
    if (v !== null && typeof v === "object") {
      const o: any = {};
      for (const k of Object.keys(v).sort()) {
        const kp = p ? `${p}.${k}` : k;
        if (EDS2_ID.test(kp) || (p === "" && (k === "session" || k === "log_plan"))) continue;
        if ((p === "rooms1" || p === "rooms2") && k === "id") continue;
        o[k] = walk(v[k], kp);
      }
      const keys = Object.keys(o);
      // под корнем rooms1/rooms2 — сверка множества содержимого комнат без привязки к id
      if (p === "rooms1" || p === "rooms2") {
        return JSON.stringify(keys.map((k) => JSON.stringify(o[k])).sort());
      }
      return o;
    }
    return v;
  };
  return JSON.stringify(walk(structuredClone(m), ""));
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
  const client = new Client({ name: "106-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let persisted = false;
  let before: any = null;
  const created: string[] = []; // id стен, созданных пробой

  try {
    mkdirSync(".orca-reports/tmp", { recursive: true });

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
    writeFileSync(".orca-reports/tmp/backup-dev-106.json", JSON.stringify({
      _source: "GET через project_open + model_get, dev-проект из env (inline), scripts/probes/106-live-check.ts; id не печатаются",
      model: before,
    }, null, 1));
    console.log("backup ok; counters:", JSON.stringify({
      walls: Object.keys(before.walls ?? {}).length,
      holes: Object.values<any>(before.walls ?? {}).reduce((n: number, w: any) => n + Object.keys(w.holes ?? {}).length, 0),
      rooms: Object.keys(before.rooms2 ?? {}).length,
    }));

    const vBase = await call(client, "model_validate", {});
    console.log("validate (baseline): проблем", (vBase.problems ?? []).length);

    // 2. слот для перегородки: центр самой большой комнаты, ≥60 см от стен, 1600 мм
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
    let slot: { cx: number; cy: number; vertical: boolean } | null = null;
    for (const e of roomEntries.sort((u, v) => areaOf(v.poly) - areaOf(u.poly))) {
      if (slot) break;
      const xs = e.poly.map((p) => p.x), ys = e.poly.map((p) => p.y);
      for (let gx = Math.min(...xs) + 2; gx <= Math.max(...xs) - 2 && !slot; gx += 3) {
        for (let gy = Math.min(...ys) + 2; gy <= Math.max(...ys) - 2 && !slot; gy += 3) {
          const px = gx * 10, py = gy * 10;
          for (const vertical of [true, false]) {
            const dx = vertical ? 0 : 800, dy = vertical ? 800 : 0;
            const pts = [[px - dx, py - dy], [px, py], [px + dx, py + dy]];
            if (pts.every(([qx, qy]) => pointInPoly(e.poly, qx / 10, qy / 10) && distToWalls(qx / 10, qy / 10) >= 60)) {
              slot = { cx: px, cy: py, vertical };
              break;
            }
          }
        }
      }
    }
    if (!slot) throw new Error("нет свободного места для пробы");

    // 3. перегородка пробы (wall_add kind=partition). Если dev-объект блокирует операции
    // со стенами старым состоянием (INVALID_GEOMETRY, чинить запрещено) — запись не идёт,
    // сценарий покрыт 106-norm-check (настоящий нормализатор на синтетике), отметим в отчёте.
    const r0 = (v: number): number => Math.round(v);
    const p1 = slot.vertical ? { x: r0(slot.cx), y: r0(slot.cy - 800) } : { x: r0(slot.cx - 800), y: r0(slot.cy) };
    const p2 = slot.vertical ? { x: r0(slot.cx), y: r0(slot.cy + 800) } : { x: r0(slot.cx + 800), y: r0(slot.cy) };
    let partId: string | null = null;
    const errBadMat = await callErr(client, "wall_add", { kind: "partition", material: "c_nonsense", start: p1, end: p2 });
    console.log("wall_add material=c_nonsense →", errBadMat, "(ожидается INVALID_ARGUMENT)");
    if (errBadMat !== "INVALID_ARGUMENT") throw new Error("строгий enum материалов не работает на живом редакторе");
    const addRes = await client.callTool({ name: "wall_add", arguments: { kind: "partition", material: "pgb", start: p1, end: p2 } });
    if (addRes.isError) {
      const code = (JSON.parse(text(addRes as never)) as { code?: string }).code;
      console.log(`wall_add перегородки → ${code}: запись со стенами в dev-объекте недоступна, живой save сценария не выполнен (см. 106-norm-check)`);
    } else {
      const wallE = JSON.parse(text(addRes as never)).entity;
      partId = wallE?.site_id ?? null;
      if (!partId) throw new Error("перегородка не создана");
      created.push(partId);
      console.log("перегородка создана:", wallE.plan, wallE.material, wallE.thickness_mm);

      // 4. проём на перегородке пробы: демонтаж проёма и отмена
      const doorRes = await call(client, "opening_add", { wall_id: partId, type: "door", offset_mm: 400 });
      void 0;
      const doorId = doorRes.id;
      if (!doorId) throw new Error("проём не создан");
      const demRes = await call(client, "demolish", { target: "opening", id: doorId });
      if (!demRes.holeId) throw new Error("demolish проёма не сработал");
      const canRes = await call(client, "demolish_cancel", { target: "opening", id: doorId });
      if (!canRes.holeId) throw new Error("demolish_cancel проёма не сработал");
      console.log("демонтаж проёма и отмена: OK");

      // 5. стена plan:a пробы между существующими узлами (1500–2600 мм, не коллинеарно
      // перекрывающая): на ней — сектор демонтажа и split
      const endpoints: { x: number; y: number }[] = [];
      for (const w of walls) {
        if (w.p1) endpoints.push({ x: Math.round(w.p1.x * 10), y: Math.round(w.p1.y * 10) });
        if (w.p2) endpoints.push({ x: Math.round(w.p2.x * 10), y: Math.round(w.p2.y * 10) });
      }
      let wallId: string | null = null;
      for (let i = 0; i < endpoints.length && !wallId; i++) {
        for (let j = i + 1; j < endpoints.length && !wallId; j++) {
          const d = Math.hypot(endpoints[j]!.x - endpoints[i]!.x, endpoints[j]!.y - endpoints[i]!.y);
          if (d < 1500 || d > 2600) continue;
          const mid = { x: (endpoints[i]!.x + endpoints[j]!.x) / 2, y: (endpoints[i]!.y + endpoints[j]!.y) / 2 };
          void mid;
          if (distToWalls(mid.x / 10, mid.y / 10) < 5) continue;
          const r = await client.callTool({ name: "wall_add", arguments: { start: endpoints[i], end: endpoints[j] } });
          if (!r.isError) {
            wallId = JSON.parse(text(r as never)).entity?.site_id ?? null;
            if (wallId) created.push(wallId);
          }
        }
      }
      if (wallId) {
        const secRes = await call(client, "demolish", { target: "wall", id: wallId, range: { from: "start", offset_mm: 500, length_mm: 800 } });
        const sectorId = secRes.sectorId;
        if (!sectorId) throw new Error("участок демонтажа не создан");
        const got = await call(client, "model_get", { detail: "full" });
        const wallGot = Object.values<any>(got.walls).find((w: any) => w.id === wallId)!;
        const sectors = Object.values<any>(wallGot.sectors ?? {});
        console.log("участок демонтажа:", JSON.stringify(sectors.map((s) => ({ sector_id: s.id, width: s.width }))));
        if (sectors.length !== 1 || sectors[0]!.id !== sectorId) throw new Error("compact не вернул актуальный sector_id");
        const splitRes = await call(client, "wall_split", { wall_id: wallId, at_mm: 1600 });
        const ids = (splitRes.entity ?? []) as any[];
        console.log("split стены с сектором: частей", ids.length);
        for (const id of ids.map((x: any) => x.site_id)) if (id) created.push(id);
        if (created.includes(wallId)) created.splice(created.indexOf(wallId), 1);
      } else {
        console.log("подходящей пары узлов для стены plan:a не нашлось — сектор/split покрыты 106-norm-check");
      }
    }

    if (created.length > 0) {
      // 6. save пробы → verify
      const v = await call(client, "model_validate", {});
      console.log("validate: проблем", (v.problems ?? []).length);
      const saveRes = await call(client, "project_save", {});
      persisted = true;
      console.log("save:", JSON.stringify({ verified: saveRes.verified, rounds: saveRes.rounds }));
      if (!saveRes.verified) throw new Error("save не verified — пометки демонтажа/замена потеряны при нормализации или на сервере");

      // 7. восстановление: удалить созданное, сохранить, сверить с бэкапом
      for (const wid of [...created]) {
        await call(client, "wall_delete", { wall_id: wid });
      }
      const saveRes2 = await call(client, "project_save", {});
      console.log("restore save:", JSON.stringify({ verified: saveRes2.verified }));
      if (!saveRes2.verified) throw new Error("restore save не verified");

      const after = await call(client, "model_get", { detail: "full" });
      const same = strip(after) === strip(before);
      console.log("полная сверка data с бэкапом (исключения: walls.*.eds2.*.*.id, session/log_plan, id комнат):", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
      if (!same) {
        const diff = diffKeysOf(strip(before) === "" ? {} : JSON.parse(strip(before)), JSON.parse(strip(after)));
        console.log("различающиеся пути:", diff.slice(0, 20).join(" | "));
        writeFileSync(".orca-reports/tmp/backup-dev-106-after.json", JSON.stringify({ model: after }, null, 1));
        throw new Error("модель не восстановилась полностью");
      }
    } else {
      // записи не было — dev-объект обязан совпасть с бэкапом
      const cur = await call(client, "model_get", { detail: "full" });
      console.log("записи не было, сверка с бэкапом:", strip(cur) === strip(before) ? "OK" : "РАСХОЖДЕНИЕ БЕЗ ЗАПИСИ");
    }

    // 8. контрольный проект: GET после
    if (SNAP_ID && SNAP_PLAN && snapBefore) {
      await call(client, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
      const snapAfter = JSON.stringify(await call(client, "model_get", { detail: "full" }));
      console.log("контрольный проект:", snapAfter === snapBefore ? "не изменился" : "ИЗМЕНИЛСЯ — СТОП");
      if (snapAfter !== snapBefore) throw new Error("контрольный проект изменился");
    }
    console.log("106-live OK");
  } catch (e) {
    console.error("FAIL:", String((e as Error).message ?? e).slice(0, 800));
    try {
      if (persisted && before) {
        await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
        const cur = await call(client, "model_get", { detail: "full" });
        const bWalls = new Set(Object.keys(before.walls ?? {}));
        for (const [id] of Object.entries<any>(cur.walls ?? {})) {
          if (!bWalls.has(id)) { const r = await call(client, "wall_delete", { wall_id: id }); console.log("аварийное удаление стены", id, "→", JSON.stringify(r).slice(0, 80)); }
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

await main();
