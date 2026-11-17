// 126: живая проверка надёжности save по комнатам через MCP-инструменты в dev-проекте
// (REMPLANNER_PROBE_OBJECT_ID/PLAN из env, схема «бэкап → запись → проверка → восстановление»).
// Контрольный проект (только GET) — REMPLANNER_SNAPSHOT_OBJECT_ID/PLAN.
// Схема: контрольный GET → бэкап → project_save без изменений (verified, без ложной
// блокировки строгой сверки комнат) → смена имени комнаты как в UI (page.evaluate по
// zones[0].name/zone_name + localSave, проба 43) → editor.save → имя на сервере →
// СВЕЖИЙ ServerContext: project_save (verified: имя переживает строгую сверку) →
// reopen → имя сохранилось → откат имени → editor.save → свежий ServerContext:
// project_save → полная семантическая сверка data с бэкапом → контрольный GET.
// Свежий ServerContext после каждого внешнего editor.save: страница редактора MCP
// держит свой save_id, внешний editor.save его продвигает — старая страница отвечает
// конфликтом (инцидент прогона 126 #1).
// Watchdog 8 минут, таймауты на вызовах, явный process.exit.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { closeBrowser } from "../../src/browser.ts";
import { openEditor } from "../../src/editor/adapter.ts";
import { loadSession } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadModel } from "../../src/api.ts";

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

/** Свежий MCP-клиент: страница редактора с устаревшим save_id не переиспользуется. */
async function freshClient(): Promise<Client> {
  const server = buildServer(new ServerContext());
  const client = new Client({ name: "126-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

/** Служебные поля и регенерируемые id (как 122): id комнат rooms1/rooms2 переименовываются
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
      // пустой контейнер проёмов: нативный save редактора поле не пишет; непустой
      // holes остаётся в сверке (потеря проёмов не маскируется)
      if (wall?.holes && typeof wall.holes === "object" && !Array.isArray(wall.holes) && Object.keys(wall.holes).length === 0) delete c.walls[wid].holes;
    }
  }
  for (const key of ["rooms1", "rooms2"]) {
    if (c[key] && typeof c[key] === "object") {
      const entries = Object.entries<any>(c[key]).map(([rid, r]) => [rid, stripIds(r)] as const)
        .sort((u, v) => JSON.stringify(u[1]).localeCompare(JSON.stringify(v[1])));
      c[key] = Object.fromEntries(entries.map(([, v], i) => [`ROOM${i + 1}`, v]));
    }
  }
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

function diffStripped(before: any, after: any): string[] {
  return diffKeysOf(JSON.parse(strip(before)), JSON.parse(strip(after)));
}

/** Имя помещения первой комнаты с zones[0].name (как его видит сверка). */
function firstRoomName(model: any): { roomId: string; name: string } | null {
  const rooms = (model.rooms2 ?? {}) as Record<string, any>;
  for (const [rid, room] of Object.entries(rooms)) {
    const name = (room?.zones ?? [])[0]?.name;
    if (typeof name === "string") return { roomId: rid, name };
  }
  return null;
}

/** Комната по каноническому контуру (id регенерируется при каждом save). */
function roomByContour(model: any, roomId: string): string | null {
  const rooms = (model.rooms2 ?? {}) as Record<string, any>;
  const ref = rooms[roomId];
  if (!ref) return null;
  const canon = (r: any): string =>
    JSON.stringify(((r?.polygon ?? r?.points ?? []) as Array<{ x: number; y: number }>)
      .map((p) => [Math.round(p.x * 2) / 2, Math.round(p.y * 2) / 2])
      .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
  const target = canon(ref);
  for (const [rid, room] of Object.entries(rooms)) {
    if (canon(room) === target) return rid;
  }
  return null;
}

/** Смена имени комнаты как в UI (проба 43): zones[0].name/zone_name + localSave + editor.save. */
async function renameViaEditor(roomId: string, newName: string): Promise<void> {
  const session = loadSession(STATE_PATH);
  const editor = await withTimeout(openEditor(session, OBJECT_ID, PLAN_ID), 120_000, "openEditor");
  try {
    const page = (editor as unknown as { page: import("playwright-core").Page }).page;
    const res = await withTimeout(page.evaluate(({ roomId, newName }: { roomId: string; newName: string }) => {
      const w = window as unknown as Record<string, any>;
      const r = w.ROOMS2?.[roomId];
      const z = (r?.zones ?? [])[0];
      if (!z) return { err: "нет зоны" };
      z.name = newName;
      z.zone_name = newName;
      try { z.draw?.(); } catch { /* ignore */ }
      w.selected.room = r;
      w.selected.zone = z;
      w.project.localSave();
      return { roomId, name: z.name };
    }, { roomId, newName }), 60_000, "rename");
    if (res?.err || res?.name !== newName) throw new Error(`rename: ${JSON.stringify(res)}`);
    const saveRes = await withTimeout(editor.save(), 120_000, "editor.save");
    if (!saveRes.ok) throw new Error("editor.save не прошёл");
  } finally {
    await editor.close().catch(() => {});
  }
}

/** Имя комнаты на сервере с повторным чтением: применённый save виден не сразу
 *  (проба 126 #3), опрос до ~60 с. Чтение — прямой HTTP GET (model_get MCP-клиента
 *  отдаёт кеш workspace на момент project_open). */
async function roomNameOnServer(roomId: string, expect: string, attempts = 12): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    const model = await loadModel(loadSession(STATE_PATH), OBJECT_ID, PLAN_ID);
    const currentId = roomByContour(model.model, roomId) ?? roomId;
    const name = ((model.model.rooms2 ?? {})[currentId]?.zones ?? [])[0]?.name ?? null;
    if (name === expect) return name;
    console.log(`  чтение ${i + 1}: имя "${name}" (ждём "${expect}")`);
  }
  return null;
}

async function main() {
  const client = await freshClient();
  let persisted = false;
  let before: any = null;
  let probeRoom: { roomId: string; name: string } | null = null;

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
    mkdirSync(".orca-reports/tmp", { recursive: true });
    writeFileSync(".orca-reports/tmp/backup-dev-126.json", JSON.stringify({
      _source: "GET через project_open + model_get, dev-проект из env, scripts/probes/126-live-check.ts, только чтение; id проектов/планов не печатаются",
      model: before,
    }, null, 1));
    probeRoom = firstRoomName(before);
    console.log("backup ok; rooms:", Object.keys(before.rooms2 ?? {}).length,
      "первая комната с именем:", probeRoom ? `"${probeRoom.name}"` : "нет");
    if (!probeRoom) throw new Error("нет комнаты с zones[0].name");

    // 2. штатный save без изменений: строгая сверка комнат не блокирует.
    // После save закрываем общий браузер: страница редактора с устаревшим save_id,
    // оставленная открытой, перезаписывает следующие записи своим состоянием
    // (инцидент пробы 126 #1/#4)
    const saveRes = await call(client, "project_save", {});
    console.log("save без изменений:", JSON.stringify({ verified: saveRes.verified, rounds: saveRes.rounds, warnings: saveRes.warnings }));
    if (!saveRes.verified) throw new Error("save без изменений не verified");
    if (saveRes.warnings?.some((w: string) => w.includes("room_topology_changed"))) throw new Error("ложная блокировка комнат при штатном save");
    await closeBrowser();

    // 3. смена имени комнаты как в UI + штатный save редактора.
    // id комнат регенерируется при каждом save — комнату берём из СВЕЖЕГО GET по контуру
    const PROBE_NAME = `Проба 126 (${probeRoom.name})`;
    const freshModel = await call(client, "model_get", { detail: "full" });
    const liveRoomId = roomByContour(freshModel, probeRoom.roomId);
    if (!liveRoomId) throw new Error("комната бэкапа не найдена по контуру в свежей модели");
    console.log("комната пробы:", liveRoomId, `"${((freshModel.rooms2 ?? {})[liveRoomId]?.zones ?? [])[0]?.name}"`);
    await renameViaEditor(liveRoomId, PROBE_NAME);
    const gotName = await roomNameOnServer(liveRoomId, PROBE_NAME);
    console.log("имя на сервере после editor.save:", gotName ? `"${gotName}"` : "не доехало");
    if (gotName !== PROBE_NAME) throw new Error("имя не доехало до сервера");
    await closeBrowser();

    // 4. штатный save с изменённым именем (свежий контекст): verified без ложной блокировки
    const client2 = await freshClient();
    persisted = true;
    await call(client2, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const saveRes2 = await call(client2, "project_save", {});
    console.log("save с новым именем:", JSON.stringify({ verified: saveRes2.verified, rounds: saveRes2.rounds, warnings: saveRes2.warnings }));
    if (!saveRes2.verified) throw new Error("save с новым именем не verified");
    await call(client2, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const nameKept = await roomNameOnServer(probeRoom.roomId, PROBE_NAME);
    console.log("после reopen:", nameKept ? `"${nameKept}"` : "нет");
    if (nameKept !== PROBE_NAME) throw new Error("имя потеряно после save+reopen");
    await closeBrowser();

    // 5. откат имени (свежий GET → контур) + штатный save
    const liveRoom2 = roomByContour(await call(client2, "model_get", { detail: "full" }), probeRoom.roomId) ?? liveRoomId;
    await renameViaEditor(liveRoom2, probeRoom.name);
    const reverted = await roomNameOnServer(probeRoom.roomId, probeRoom.name);
    console.log("имя на сервере после отката:", reverted ? `"${reverted}"` : "не доехало");
    if (reverted !== probeRoom.name) throw new Error("откат имени не доехал");
    await closeBrowser();
    const client3 = await freshClient();
    await call(client3, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const saveRes3 = await call(client3, "project_save", {});
    console.log("save отката:", JSON.stringify({ verified: saveRes3.verified, rounds: saveRes3.rounds, warnings: saveRes3.warnings }));
    if (!saveRes3.verified) throw new Error("save отката не verified");
    await closeBrowser();

    // 6. полная семантическая сверка data с бэкапом
    const after = await call(client3, "model_get", { detail: "full" });
    const same = strip(after) === strip(before);
    console.log("полная сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
    if (!same) {
      const diffKeys = diffKeysOf(JSON.parse(strip(before)), JSON.parse(strip(after)));
      console.log("различающиеся пути:", diffKeys.slice(0, 20).join(" | "));
      writeFileSync(".orca-reports/tmp/backup-dev-126-after.json", JSON.stringify({ model: after }, null, 1));
      throw new Error("модель не совпала с бэкапом");
    }

    // 7. контрольный проект: GET после
    if (SNAP_ID && SNAP_PLAN && snapBefore) {
      const client4 = await freshClient();
      await call(client4, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
      const snapAfter = JSON.stringify(await call(client4, "model_get", { detail: "full" }));
      console.log("контрольный проект:", snapAfter === snapBefore ? "не изменился" : "ИЗМЕНИЛСЯ — СТОП");
      if (snapAfter !== snapBefore) throw new Error("контрольный проект изменился");
    }
    console.log("126-live OK");
    clearTimeout(watchdog);
    await client.close().catch(() => {});
    process.exit(0);
  } catch (e) {
    console.error("FAIL:", String((e as Error).message ?? e).slice(0, 800));
    if (process.env.RP_DEBUG) console.error((e as Error).stack);
    try {
      if (persisted && before && probeRoom) {
        // аварийное восстановление: откат имени пробой (если осталось), save, сверка
        const now = await call(await freshClient(), "model_get", { detail: "full" });
        const liveRoomR = roomByContour(now, probeRoom.roomId);
        const curName = liveRoomR ? (((now.rooms2 ?? {})[liveRoomR]?.zones ?? [])[0]?.name ?? null) : null;
        if (curName !== probeRoom.name && liveRoomR) {
          await renameViaEditor(liveRoomR, probeRoom.name).catch((e) => console.error("revert:", String(e).slice(0, 200)));
          await closeBrowser().catch(() => {});
          await new Promise((r) => setTimeout(r, 3000));
        }
        const clientR = await freshClient();
        await call(clientR, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
        const r = await call(clientR, "project_save", {});
        const afterFail = await call(clientR, "model_get", { detail: "full" });
        const restored = strip(afterFail) === strip(before);
        console.log("аварийное восстановление:", r.verified ? "save OK" : "save не verified", "; сверка с бэкапом:", restored ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
        if (!restored) {
          console.error("различающиеся пути:", diffKeysOf(JSON.parse(strip(before)), JSON.parse(strip(afterFail))).slice(0, 20).join(" | "));
          writeFileSync(".orca-reports/tmp/backup-dev-126-after.json", JSON.stringify({ model: afterFail }, null, 1));
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
