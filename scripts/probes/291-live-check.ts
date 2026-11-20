// 291: живая проверка шин/коллекторов конструктора щитка в dev-проекте из env
// (REMPLANNER_PROBE_*). Цепочка MCP: item_add (электрощиток) → shield_module_add ×4 →
// shield_bus_add (TC, 6 гнёзд) → shield_wire_add фаза модуль→{bus, port 3} →
// shield_collector_add (2 модуля) → model_validate → project_save (verified) →
// reopen → сверка bus_list/collector_list → shield_bus_update (align R) → save →
// shield_collector_update (набор модулей) → save → shield_bus_delete (deleted_wires) →
// shield_module_delete (каскад коллектора) → render PNG → item_delete щитка →
// save → счётчики как до прогона.
// Гарды (уроки 240/256/258, ревью 285 №3): бэкап GET до прогона, «план в редакторе
// == сервер» (строгая сверка canon) ДО первой записи, контрольный GET рабочего
// проекта по РЕАЛЬНОМУ plan_id из env (не «1»), пустой ответ (data_empty) — отказ,
// сверка до/после по save_id и канонической модели, удаление только по
// захваченному site_id, восстановление в finally, browser.close в finally.
// Запуск: node --experimental-strip-types scripts/probes/291-live-check.ts run
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, saveModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { assertNoReadonlyCollision, assertTargetPair, readonlyGuard } from "./probe-guard.ts";
import { BASE_URL, HTTP_TIMEOUT_MS, USER_AGENT } from "../../src/config.ts";
import { cookieHeader, type SessionState } from "../../src/session.ts";
import { toModel } from "../../src/model/canonical.ts";
import { resolveItem } from "../../src/dto/items.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run (REMPLANNER_PROBE_* из env)");
  process.exit(0);
}

const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID и REMPLANNER_PROBE_READONLY_PLAN_ID (реальный plan_id, не «1»)");
  process.exit(1);
}
if (READONLY_PLAN_ID === "1") {
  console.error("REMPLANNER_PROBE_READONLY_PLAN_ID = «1» — контрольный GET должен идти по реальному plan_id рабочего проекта");
  process.exit(1);
}
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
const BACKUP_PATH = join(".orca-reports", `backup-${OBJECT_ID}-291.json`);

function countsOk(c: Compact, walls: number, items: number, shields: number): boolean {
  return c.walls.length === walls && c.items.length === items && (c.shields?.length ?? 0) === shields;
}

/** Строгая сверка модели (data) — гард «план в редакторе == сервер» ДО первой записи. */
const canon = (m: Record<string, unknown>): string => JSON.stringify(toModel(structuredClone(m) as never));
const sameData = (before: Record<string, unknown>, after: Record<string, unknown>): boolean => canon(before) === canon(after);

/** Семантическая сигнатура плана — сверка ПОСЛЕ записи (284: байтовая сверка
 *  недостижима, transient-id перегенерируются редактором). */
const ownSig = (m: Record<string, unknown>): string => {
  const walls = Object.values((m["walls"] ?? {}) as Record<string, Record<string, unknown>>)
    .map((w) => {
      const p1 = w["p1"] as { x: number; y: number }, p2 = w["p2"] as { x: number; y: number };
      return [p1.x, p1.y, p2.x, p2.y, w["depth"], w["material"], w["role"] ?? ""].join(":");
    })
    .sort()
    .join("|");
  const rooms = (m["rooms2"] ?? m["rooms1"] ?? {}) as Record<string, Record<string, unknown>>;
  const roomSig = Object.values(rooms)
    .map((r) => JSON.stringify([((r["polygon"] ?? []) as Array<{ x: number; y: number }>).map((p) => [p.x, p.y]), r["area"] ?? null]))
    .sort()
    .join("|");
  const colls = Object.keys(m)
    .filter((k) => !["v", "id", "plan_id", "session", "borders", "rooms1", "logs", "is_forced", "params"].includes(k))
    .map((k) => `${k}=${Object.keys(m[k] ?? {}).length}`)
    .sort()
    .join(",");
  return `${walls}#${roomSig}#${colls}`;
};
const samePlan = (before: Record<string, unknown>, after: Record<string, unknown>): boolean => ownSig(before) === ownSig(after);

/** authkey проекта из ЛК (для restore через A-транспорт; не печатается). */
const authKeyFor = async (session: SessionState, objectId: string): Promise<string> => {
  const res = await fetch(`${BASE_URL}/client/`, {
    headers: { cookie: cookieHeader(session, "remplanner.ru"), "user-agent": USER_AGENT, referer: `${BASE_URL}/client/` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const html = await res.text();
  const i = html.indexOf(`data-object="${objectId}"`);
  if (i < 0) throw new Error("в ЛК нет объекта dev-проекта (restore невозможен)");
  const m = /data-auth\S+="([0-9a-f]+)"/.exec(html.slice(i, i + 400));
  if (!m) throw new Error("в ЛК нет authkey для объекта (restore невозможен)");
  return m[1]!;
};

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "291-live-check", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  const first = contents.find((c) => c.type === "text");
  return first?.text ?? JSON.stringify(contents);
};
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 800)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};
const entityId = (res: Record<string, unknown>): string => {
  const e = res["entity"] as { id?: string } | undefined;
  if (!e?.id) throw new Error(`в ответе нет entity.id: ${JSON.stringify(res).slice(0, 200)}`);
  return e.id;
};

const snap = async (objectId: string, tag: string): Promise<LoadedModel> => {
  // ревью 285 №3: контрольный GET рабочего проекта — по реальному plan_id из env;
  // пустой ответ (data_empty) — отказ: сверка пустого с пустым ничего не доказывает
  const planId = objectId === READONLY_ID ? READONLY_PLAN_ID : PLAN_ID;
  const m = await loadModel(ctx.session(), objectId, planId);
  if (objectId === READONLY_ID && m.data_empty === true) {
    throw new Error("контрольный GET рабочего проекта пуст (data_empty) — сверка неизменности недостоверна, стоп");
  }
  writeFileSync(`${OUT}/get-${objectId}-${tag}-291.json`, JSON.stringify(m, null, 1));
  return m;
};

type Compact = {
  walls: { id: string }[];
  items: { id: string; name: string }[];
  shields?: {
    id: string; site_id: string; item: string; rails: number;
    modules: { module_id: string; rail: number; index: number; type: string; subtype: string }[];
    wires?: { wire_id: string; type: string; from: Record<string, unknown>; to: Record<string, unknown> }[];
    buses?: number;
    bus_list?: { bus_id: string; type: string; sockets: number; distance: number; connection: string; sockets_list: { port: number; connected: number }[] }[];
    collectors?: number;
    collector_list?: { collector_id: string; rail: number; module_width: number; module_ids: string[]; position: string }[];
  }[];
};
const mg = async (): Promise<Compact> => (await call("model_get", {})) as unknown as Compact;

/** Предмет по site_id из РАБОЧЕЙ модели редактора после project_open. */
const itemLabelBySiteId = (siteId: string): string | null => {
  const ws = ctx.workspaceOrNull;
  if (!ws) return null;
  try {
    return resolveItem(ws.model, siteId).id;
  } catch {
    return null;
  }
};

let readonlyBefore: LoadedModel | null = null;
let ownBefore: LoadedModel | null = null;
let shieldItemSiteId: string | null = null;
let restoreOk = false;
let mainOk = false;
try {
  // 0. бэкап GET dev-проекта + контрольный GET рабочего
  ownBefore = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  writeFileSync(BACKUP_PATH, JSON.stringify({
    _source: "GET через loadModel, dev-проект из env, scripts/probes/291-live-check.ts, до прогона; id не печатаются",
    model: ownBefore.model,
  }, null, 1));
  // ревью 319 №3/№4: пара объект/план из env; эталон контрольного проекта фиксированный
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  const roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, `${OUT}/291-live-check-readonly-ref.json`);
  await roGuard.assertUnchanged("перед записями");
  readonlyBefore = await snap(READONLY_ID, "before");
  console.log("backup ok");

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const openedFull = await call("model_get", { detail: "full" });
  if (!sameData(ownBefore.model, openedFull as Record<string, unknown>)) {
    throw new Error("модель после project_open не равна GET до прогона — стоп до любой записи");
  }
  console.log("guard: план в редакторе == сервер");
  const before = await mg();
  const wallsBefore = before.walls.length;
  const itemsBefore = before.items.length;
  const shieldsBefore = (before.shields ?? []).length;
  if (shieldsBefore !== 0) throw new Error(`в dev-проекте уже есть щитки (${shieldsBefore}) — проба не должна их трогать`);

  // 1. щиток + 4 модуля
  const wall = before.walls[0]!;
  const addRes = (await call("item_add", { name: "electric_shield", position: { against_wall: { wall_id: wall.id, offset_mm: 500 } } })) as Record<string, unknown>;
  const shieldItemLabel = entityId(addRes);
  const railRes = await call("shield_rail_add", { item_id: shieldItemLabel });
  shieldItemSiteId = String((railRes["entity"] as { item?: string } | undefined)?.item ?? "");
  if (!shieldItemSiteId) throw new Error("shield_rail_add: в compact-щитке нет item (site_id предмета)");
  const lastModuleId = (res: Record<string, unknown>): string => {
    const mods = (res["entity"] as { modules?: { module_id: string }[] }).modules ?? [];
    return mods[mods.length - 1]!.module_id;
  };
  const idA = lastModuleId(await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module", subtype: "16A", comment: "проба 291" }));
  const idB = lastModuleId(await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module", subtype: "25A" }));
  const idC = lastModuleId(await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module", subtype: "32A" }));
  const idD = lastModuleId(await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module", subtype: "10A" }));
  console.log("modules:", 4);

  // 2. шина TC + провод модуль→{bus, port 3} + коллектор на A,B
  const busRes = await call("shield_bus_add", { item_id: shieldItemLabel, position: "T" });
  const busList = (busRes["entity"] as { bus_list: { bus_id: string; type: string; sockets: number; distance: number; connection: string }[] }).bus_list!;
  const bus = busList[0]!;
  console.log("bus:", bus.type, "sockets:", bus.sockets, "distance:", bus.distance);
  if (bus.type !== "TC" || bus.sockets !== 6 || bus.distance !== 157.5) throw new Error(`шина не по эталону: ${JSON.stringify(bus)}`);
  await call("shield_wire_add", { item_id: shieldItemLabel, type: "shield_wire_phase", source: { module_id: idA, port: 0 }, target: { bus: bus.bus_id, port: 3 } });
  const colRes = await call("shield_collector_add", { item_id: shieldItemLabel, modules: [idB, idC] });
  const colList = (colRes["entity"] as { collector_list: { collector_id: string; rail: number; module_ids: string[]; position: string }[] }).collector_list!;
  console.log("collector:", JSON.stringify(colList[0]));
  if (colRes["entity"] && (colRes["entity"] as { collectors: number }).collectors !== 1) throw new Error("коллектор не один");

  // 3. validate → save
  const validation = (await call("model_validate", {})) as { ok?: boolean; problems?: unknown[] };
  console.log("validate ok:", validation.ok, validation.problems?.length ?? 0);
  const save = await call("project_save", {});
  writeFileSync(`${OUT}/291-save-result.json`, JSON.stringify(save, null, 1));
  const verified = (save as { verified?: boolean }).verified === true;
  console.log("save verified:", verified);

  // 4. reopen + сверка
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after = await mg();
  const sh = after.shields?.[0];
  const checks: [string, boolean][] = [
    ["щиток: 4 модуля, 1 шина, 1 коллектор", !!sh && sh.modules.length === 4 && sh.buses === 1 && sh.collectors === 1],
    ["шина: TC, 6 гнёзд, distance 157.5", !!sh && sh.bus_list?.[0]?.type === "TC" && sh.bus_list?.[0]?.sockets === 6 && sh.bus_list?.[0]?.distance === 157.5],
    ["шина: connection = shield_wire_phase (гнездо 3 connected)", !!sh && sh.bus_list?.[0]?.connection === "shield_wire_phase" && sh.bus_list?.[0]?.sockets_list?.[3]?.connected === 1],
    ["коллектор: 2 модуля B,C на рейке 0, position T", !!sh && sh.collector_list?.[0]?.module_ids?.length === 2 && sh.collector_list?.[0]?.rail === 0 && sh.collector_list?.[0]?.position === "T"],
    ["провод: from A.p0 → to {bus, port 3}", (() => {
      const w = sh?.wires?.find((x) => x.type === "shield_wire_phase");
      return !!w && (w.from as { module_id?: string }).module_id === idA && (w.to as { bus?: string; port?: number }).bus === bus.bus_id && (w.to as { port?: number }).port === 3;
    })()],
  ];
  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(ok ? "OK   " : "FAIL ", label);
    if (!ok) allOk = false;
  }

  // 5. шина: привязка R (drag-семантика) → save → reopen
  await call("shield_bus_update", { item_id: shieldItemLabel, bus_id: bus.bus_id, align: "R" });
  const sv2 = (await call("project_save", {})) as { verified?: boolean };
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterMove = await mg();
  const busAfter = afterMove.shields?.[0]?.bus_list?.[0];
  const busMoveOk = busAfter?.type === "TR" && busAfter?.distance === 315 && busAfter?.connection === "shield_wire_phase";
  console.log(busMoveOk ? "OK   " : "FAIL ", "шина TR distance 315, провод жив");
  allOk = allOk && busMoveOk && sv2.verified === true;

  // 6. коллектор: замена набора модулей (C,D — соседние) → save → reopen
  await call("shield_collector_update", { item_id: shieldItemLabel, collector_id: afterMove.shields?.[0]?.collector_list?.[0]?.collector_id ?? "", modules: [idC, idD] });
  const sv3 = (await call("project_save", {})) as { verified?: boolean };
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterColUpdate = await mg();
  const colAfter = afterColUpdate.shields?.[0]?.collector_list?.[0];
  const colOk = JSON.stringify(colAfter?.module_ids) === JSON.stringify([idC, idD]);
  console.log(colOk ? "OK   " : "FAIL ", "коллектор: набор заменён на [C, D]");
  allOk = allOk && colOk && sv3.verified === true;

  // 7. удаление шины → deleted_wires
  const delRes = await call("shield_bus_delete", { item_id: shieldItemLabel, bus_id: bus.bus_id });
  const deletedWires = (delRes as { deleted_wires?: string[] }).deleted_wires ?? [];
  console.log("deleted_wires:", deletedWires.length);
  const sv4 = (await call("project_save", {})) as { verified?: boolean };
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterBusDel = await mg();
  console.log("afterBusDel: buses:", afterBusDel.shields?.[0]?.buses, "wires:", afterBusDel.shields?.[0]?.wires?.length, "sv4:", sv4.verified);
  const busDelOk = deletedWires.length === 1 && (afterBusDel.shields?.[0]?.buses ?? 0) === 0 && (afterBusDel.shields?.[0]?.wires?.length ?? 0) === 0 && sv4.verified === true;
  console.log(busDelOk ? "OK   " : "FAIL ", "удаление шины с проводом (каскад), без висячих ссылок");
  allOk = allOk && busDelOk;

  // 8. удаление модуля коллектора (C) → коллектор с одним модулем удаляется каскадом
  const modDel = await call("shield_module_delete", { item_id: shieldItemLabel, module_id: idC });
  const deletedCollectors = (modDel as { deleted_collectors?: string[] }).deleted_collectors ?? [];
  console.log("deleted_collectors:", deletedCollectors.length);
  const sv5 = (await call("project_save", {})) as { verified?: boolean };
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterModDel = await mg();
  console.log("afterModDel: collectors:", afterModDel.shields?.[0]?.collectors, "sv5:", sv5.verified, "col_list:", JSON.stringify(afterModDel.shields?.[0]?.collector_list));
  const cascadeOk = deletedCollectors.length === 1 && (afterModDel.shields?.[0]?.collectors ?? 0) === 0 && (afterModDel.shields?.[0]?.collector_list ?? []).length === 0 && sv5.verified === true;
  console.log(cascadeOk ? "OK   " : "FAIL ", "каскад удаления модуля коллектора");
  allOk = allOk && cascadeOk;

  // 9. render PNG
  const png = await call("render_plan", {});
  const pngPath = png["path"] as string | undefined;
  console.log("render:", pngPath ?? "нет path в ответе");
  if (!pngPath) allOk = false;
  else copyFileSync(pngPath, `${OUT}/291-render.png`);

  // 9а. ревью 319 №4: контрольный проект сверяется с фиксированным эталоном
  const sameReadonly = !(await roGuard.checkFinal("в конце"));
  console.log(sameReadonly ? "READONLY OK" : "READONLY CHANGED — СТОП");

  // 10. очистка: щиток-предмет по site_id + save + сверка сигнатуры
  const cleanupLabel = itemLabelBySiteId(shieldItemSiteId!);
  if (cleanupLabel) {
    await call("item_delete", { item_id: cleanupLabel });
    const sv = (await call("project_save", {})) as { verified?: boolean };
    await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const clean = await mg();
    const back = countsOk(clean, wallsBefore, itemsBefore, shieldsBefore);
    console.log("cleanup verified:", sv.verified === true, "counters back:", back);
    allOk = allOk && sv.verified === true && back;
  } else {
    console.log("cleanup: предмет по site_id не найден (уже удалён?)");
  }

  const ownAfter = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const sameOwn = samePlan(ownBefore.model, ownAfter.model);
  console.log(sameOwn ? "OWN PLAN OK" : "OWN PLAN CHANGED");
  mainOk = allOk && verified && sameReadonly && sameOwn;
} catch (e) {
  console.error("PROBE_ERROR:", (e as Error).message);
  mainOk = false;
} finally {
  try {
    if (ownBefore) {
      if (shieldItemSiteId) {
        await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
        const label = itemLabelBySiteId(shieldItemSiteId);
        if (label) {
          await call("item_delete", { item_id: label });
          const sv = (await call("project_save", {})) as { verified?: boolean };
          console.log("finally: пробный щиток удалён, save verified:", sv.verified === true);
        }
      }
      const afterModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
      if (!samePlan(ownBefore.model, afterModel.model)) {
        console.log("finally: сигнатура плана отличается от бэкапа — возврат бэкапа");
        const fresh = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
        const sv = await saveModel(ctx.session(), {
          objectId: OBJECT_ID,
          planId: PLAN_ID,
          authkey: await authKeyFor(ctx.session(), OBJECT_ID),
          saveId: fresh.save_id,
          model: ownBefore.model,
        });
        console.log("finally: бэкап возвращён (A-транспорт), ok:", sv.ok, "conflict:", sv.conflict);
        const restored = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
        restoreOk = samePlan(ownBefore.model, restored.model);
        console.log("finally: сверка сигнатуры после восстановления:", restoreOk ? "OK" : "MISMATCH");
      } else {
        restoreOk = true;
        console.log("finally: сигнатура плана равна бэкапу");
      }
    }
  } catch (e) {
    console.error("finally ERROR:", (e as Error).message.slice(0, 400));
    restoreOk = false;
  }
  await closeBrowser().catch(() => {});
}
process.exit(mainOk && restoreOk ? 0 : 1);

