// 284: живая проверка проводов/переноса модулей конструктора щитка в dev-проекте
// из env (REMPLANNER_PROBE_*). Цепочка MCP: item_add (электрощиток у стены) →
// shield_rail_add ×2 → shield_module_add ×4 → shield_wire_add ×3 (фаза/ноль/земля,
// включая модуль→ввод) → model_validate → project_save (verified, без
// NORMALIZATION_DROPPED) → reopen → model_get сверка проводов → render_plan PNG →
// shield_module_update (rail/index) → save → shield_wire_delete → save →
// shield_module_delete модуля с проводом (deleted_wires) → save →
// item_delete щитка (каскад конструктора) → save → счётчики как до прогона.
// GET рабочего проекта (env) — только чтение до/после; ревью 285 №3: план_id
// РЕАЛЬНЫЙ из env (REMPLANNER_PROBE_READONLY_PLAN_ID, не «1»), пустой ответ
// (data_empty) — отказ пробы; сверка каноническая, как в гарде записи.
// Гарды (уроки 240/256/258): бэкап до прогона, «план в редакторе == сервер»,
// удаление только по захваченному site_id, восстановление в finally.
// Запуск: node --experimental-strip-types scripts/probes/284-live-check.ts run
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
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run (REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID, REMPLANNER_PROBE_READONLY_PLAN_ID из env)");
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
const BACKUP_PATH = join(".orca-reports", `backup-${OBJECT_ID}-284.json`);

function countsOk(c: Compact, walls: number, items: number, shields: number): boolean {
  return c.walls.length === walls && c.items.length === items && (c.shields?.length ?? 0) === shields;
}

/** Строгая сверка модели (data) — гард «план в редакторе == сервер» ДО первой записи. */
const canon = (m: Record<string, unknown>): string => JSON.stringify(toModel(structuredClone(m) as never));
const sameData = (before: Record<string, unknown>, after: Record<string, unknown>): boolean => canon(before) === canon(after);

/** Семантическая сигнатура плана — сверка ПОСЛЕ записи (id рёбер/комнат/предметов
 *  перегенерируются редактором; сравниваются оси стен, комнаты, счётчики коллекций). */
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
    .filter((k) => !["v", "id", "plan_id", "session"].includes(k))
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
const client = new Client({ name: "284-live-check", version: "0.0.0" });
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
  writeFileSync(`${OUT}/get-${objectId}-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

type Compact = {
  walls: { id: string }[];
  items: { id: string; name: string }[];
  shields?: { id: string; site_id: string; item: string; rails: number; modules: { module_id: string; rail: number; type: string; subtype: string; index: number }[]; wires?: { wire_id: string; type: string; from: Record<string, unknown>; to: Record<string, unknown> }[]; buses?: number; collectors?: number }[];
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
let verified = false;
let restoreOk = false;
let mainOk = false;
try {
  // 0. бэкап GET dev-проекта + контрольный GET рабочего
  ownBefore = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  writeFileSync(BACKUP_PATH, JSON.stringify({
    _source: "GET через loadModel, dev-проект из env, scripts/probes/284-live-check.ts, до прогона; id не печатаются",
    model: ownBefore.model,
  }, null, 1));
  // ревью 319 №3/№4: пара объект/план из env; эталон контрольного проекта фиксированный
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  const roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, `${OUT}/284-live-check-readonly-ref.json`);
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

  // 1. щиток + 2 рейки + 4 модуля
  const wall = before.walls[0]!;
  const addRes = (await call("item_add", { name: "electric_shield", position: { against_wall: { wall_id: wall.id, offset_mm: 500 } } })) as Record<string, unknown>;
  const shieldItemLabel = entityId(addRes);
  const railRes = await call("shield_rail_add", { item_id: shieldItemLabel });
  shieldItemSiteId = String((railRes["entity"] as { item?: string } | undefined)?.item ?? "");
  if (!shieldItemSiteId) throw new Error("shield_rail_add: в compact-щитке нет item (site_id предмета)");
  await call("shield_rail_add", { item_id: shieldItemLabel });
  const lastModuleId = (res: Record<string, unknown>): string => {
    const mods = (res["entity"] as { modules?: { module_id: string }[] }).modules ?? [];
    return mods[mods.length - 1]!.module_id;
  };
  const idA = lastModuleId(await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module", subtype: "16A", comment: "проба 284" }));
  const idB = lastModuleId(await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module_x2", subtype: "16A/30mA" }));
  const idC = lastModuleId(await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module", subtype: "25A" }));
  await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module", subtype: "32A", rail: 1 });
  const shNow = ((await call("model_get", {})) as unknown as Compact).shields?.[0];
  console.log("modules:", shNow?.modules.length, "rail0:", shNow?.modules.filter((m) => m.rail === 0).length, "rail1:", shNow?.modules.filter((m) => m.rail === 1).length);
  if (shNow?.modules.length !== 4) throw new Error(`модулей ${shNow?.modules.length}, ожидалось 4`);

  // 2. провода: фаза A.p0→B.p0, ноль B.p2→C.p0, земля C.p1→ввод earth
  await call("shield_wire_add", { item_id: shieldItemLabel, type: "shield_wire_phase", source: { module_id: idA, port: 0 }, target: { module_id: idB, port: 0 } });
  await call("shield_wire_add", { item_id: shieldItemLabel, type: "shield_wire_null", source: { module_id: idB, port: 2 }, target: { module_id: idC, port: 0 } });
  const wEarth = await call("shield_wire_add", { item_id: shieldItemLabel, type: "shield_wire_earth", source: { module_id: idC, port: 1 }, target: { input: "earth" } });
  const wiresAfterAdd = ((wEarth["entity"] as { wires?: { wire_id: string; type: string }[] }).wires ?? []);
  console.log("wires:", wiresAfterAdd.map((w) => w.type).join(", "));
  if (wiresAfterAdd.length !== 3) throw new Error(`проводов ${wiresAfterAdd.length}, ожидалось 3`);

  // 3. validate → save
  const validation = (await call("model_validate", {})) as { ok?: boolean; problems?: unknown[] };
  console.log("validate ok:", validation.ok, validation.problems?.length ?? 0);
  const save = await call("project_save", {});
  writeFileSync(`${OUT}/284-save-result.json`, JSON.stringify(save, null, 1));
  const verified = (save as { verified?: boolean }).verified === true;
  console.log("save verified:", verified);

  // 4. reopen + сверка проводов
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after = await mg();
  const sh = after.shields?.[0];
  const wireByType = (t: string) => sh?.wires?.find((w) => w.type === t);
  const checks: [string, boolean][] = [
    // запись по умолчанию уже содержит 1 рейку + 2 shield_rail_add
    ["щиток: 3 рейки (умолчание + 2), 4 модуля", !!sh && sh.rails === 3 && sh.modules.length === 4],
    ["провода: 3 (phase/null/earth)", !!sh && sh.wires?.length === 3],
    // ревью 287 N3: проверяются и from, и to (в compact from не бывает null)
    ["фаза A.p0→B.p0", (() => { const w = wireByType("shield_wire_phase"); return !!w && w.from.module_id === idA && w.from.port === 0 && w.to.module_id === idB && w.to.port === 0; })()],
    ["ноль B.p2→C.p0", (() => { const w = wireByType("shield_wire_null"); return (w?.from as { module_id?: string })?.module_id === idB && (w?.from as { port?: number })?.port === 2 && (w?.to as { module_id?: string })?.module_id === idC; })()],
    ["земля C.p1→ввод", (() => { const w = wireByType("shield_wire_earth"); return (w?.from as { module_id?: string })?.module_id === idC && (w?.to as { input?: string })?.input === "earth"; })()],
  ];
  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(ok ? "OK   " : "FAIL ", label);
    if (!ok) allOk = false;
  }

  // 5. перенос модуля на рейку 1 + порядок (drag-семантика)
  await call("shield_module_update", { item_id: shieldItemLabel, module_id: idA, rail: 1 });
  await call("shield_module_update", { item_id: shieldItemLabel, module_id: idA, index: 0 });
  const sv2 = (await call("project_save", {})) as { verified?: boolean };
  console.log("save after move verified:", sv2.verified === true);
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterMove = await mg();
  const movedMod = afterMove.shields?.[0]?.modules.find((m) => m.module_id === idA);
  const moveOk = movedMod?.rail === 1 && movedMod.index === 0;
  console.log(moveOk ? "OK   " : "FAIL ", "перенос модуля на рейку 1, позиция 0 (провода живы — wires:", afterMove.shields?.[0]?.wires?.length, ")");
  allOk = allOk && moveOk && sv2.verified === true;

  // 6. удаление провода
  const wireId = wireByType("shield_wire_null")!.wire_id;
  await call("shield_wire_delete", { item_id: shieldItemLabel, wire_id: wireId });
  const sv3 = (await call("project_save", {})) as { verified?: boolean };
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterDel = await mg();
  const delOk = afterDel.shields?.[0]?.wires?.length === 2 && sv3.verified === true;
  console.log(delOk ? "OK   " : "FAIL ", "удаление провода (осталось 2), save verified");
  allOk = allOk && delOk;

  // 7. удаление модуля с проводом → каскад deleted_wires
  const delRes = await call("shield_module_delete", { item_id: shieldItemLabel, module_id: idC });
  const deletedWires = (delRes as { deleted_wires?: string[] }).deleted_wires ?? [];
  console.log("deleted_wires:", deletedWires.length);
  const sv4 = (await call("project_save", {})) as { verified?: boolean };
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterModDel = await mg();
  const cascadeOk = deletedWires.length >= 1 && afterModDel.shields?.[0]?.wires?.length === 1 && sv4.verified === true;
  console.log(cascadeOk ? "OK   " : "FAIL ", "каскад удаления модуля с проводом");
  allOk = allOk && cascadeOk;

  // 8. render PNG
  const png = await call("render_plan", {});
  const pngPath = png["path"] as string | undefined;
  console.log("render:", pngPath ?? "нет path в ответе");
  if (!pngPath) allOk = false;
  else copyFileSync(pngPath, `${OUT}/284-render.png`);

  // 9. ревью 319 №4: контрольный проект сверяется с фиксированным эталоном
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
    console.error("finally RESTORE_ERROR:", (e as Error).message.slice(0, 400));
    restoreOk = false;
  }
  await closeBrowser().catch(() => {});
}
console.log("RESULT:", mainOk && restoreOk ? "LIVE_OK" : "LIVE_FAIL");
process.exit(mainOk && restoreOk ? 0 : 1);
