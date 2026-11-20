// 255/256: живая проверка конструктора щитка в dev-проекте из env (REMPLANNER_PROBE_*).
// Цепочка MCP: item_add (электрощиток у стены) → shield_rail_add → shield_module_add ×2
// → shield_module_update → model_validate → project_save (verified, без
// NORMALIZATION_DROPPED) → reopen → model_get сверка → render_plan PNG →
// item_delete щитка (каскад конструктора, нет висячих shield_id) → save →
// счетчики как до прогона. GET рабочего проекта (env) — только чтение до/после.
//
// Ревью 256 №3: предмет удаляется только по захваченному site_id (резолв — из
// РАБОЧЕЙ модели редактора после project_open, непосредственно перед удалением
// — инцидент 240, ревью 258 №1); очистка и сверка восстановления — в finally
// при любом исходе (удаление по site_id, при расхождении — возврат бэкапа
// project_import_plan + save); после project_open модель сверяется с GET до
// первой записи («план в редакторе == сервер»).
// Запуск: node --experimental-strip-types scripts/probes/255-live-check.ts run
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, saveModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { assertNoReadonlyCollision, assertTargetPair, assertUnchangedRef, newGuardRef, readonlyGuard, readonlyRefPath } from "./probe-guard.ts";
import { BASE_URL, HTTP_TIMEOUT_MS, USER_AGENT } from "../../src/config.ts";
import { cookieHeader, type SessionState } from "../../src/session.ts";
import { toModel } from "../../src/model/canonical.ts";
import { resolveItem } from "../../src/dto/items.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run (REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID из env)");
  process.exit(0);
}

const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID и REMPLANNER_PROBE_READONLY_PLAN_ID (322 N3б)");
  process.exit(1);
}
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
// бэкап этапа (по заданию 257): .orca-reports/backup-<OBJECT_ID>-257.json
const BACKUP_PATH = join(".orca-reports", `backup-${OBJECT_ID}-257.json`);

function countsOk(c: Compact, walls: number, items: number, shields: number): boolean {
  return c.walls.length === walls && c.items.length === items && (c.shields?.length ?? 0) === shields;
}

/** Строгая сверка модели (data) — гард «план в редакторе == сервер» ДО первой записи
 *  (там данные обязаны совпасть байт в байт после toModel). */
const canon = (m: Record<string, unknown>): string => JSON.stringify(toModel(structuredClone(m) as never));
const sameData = (before: Record<string, unknown>, after: Record<string, unknown>): boolean => canon(before) === canon(after);

/**
 * Семантическая сигнатура плана — сверка ПОСЛЕ записи (урок 256-прогона): любой
 * save через редактор перегенерирует id рёбер стен/комнат и id_room предметов
 * (eds[].l[].id, rooms1/rooms2 ключи, items.id_room) при неизменной геометрии —
 * строгий JSON сравнивать нельзя. Сигнатура: осевые отрезки стен (координаты,
 * толщина, материал, роль) + число сущностей каждой коллекции + комнаты по
 * полигону/площади.
 */
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
const client = new Client({ name: "255-live-check", version: "0.0.0" });
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
  const m = await loadModel(ctx.session(), objectId, READONLY_PLAN_ID);
  writeFileSync(`${OUT}/get-${objectId}-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

type Compact = {
  walls: { id: string }[];
  items: { id: string; name: string }[];
  shields?: { id: string; site_id: string; item: string; rails: number; modules: { module_id: string; rail: number; type: string; subtype: string }[] }[];
};
const mg = async (): Promise<Compact> => (await call("model_get", {})) as unknown as Compact;

/** Предмет по site_id из РАБОЧЕЙ модели редактора после project_open — тот же
 *  резолвер, что в item_delete (dto/items.ts: resolveItem принимает id сайта
 *  напрямую; ревью 258 №1: позиционная метка из порядка ключей GET не
 *  используется — инцидент 240). Возвращает id сайта или null. */
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
const roRef = newGuardRef();
try {
  // 0. бэкап GET dev-проекта + контрольный GET рабочего
  ownBefore = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  writeFileSync(BACKUP_PATH, JSON.stringify({
    _source: "GET через loadModel, dev-проект из env, scripts/probes/255-live-check.ts, до прогона; id не печатаются",
    model: ownBefore.model,
  }, null, 1));
  writeFileSync(`${OUT}/backup-${OBJECT_ID}-255.json`, JSON.stringify({ model: ownBefore.model }, null, 1));
  // ревью 319 №3/№4: пара объект/план из env; эталон контрольного проекта фиксированный
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  const roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  roRef.current = roGuard;
  await roGuard.assertUnchanged("перед записями");
  readonlyBefore = await snap(READONLY_ID, "before");
  console.log("backup ok");

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  // гарды «план в редакторе == сервер» (ревью 256 №3в): модель после открытия
  // сверяется с GET до первой записи; расхождение — стоп до любой мутации
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
  // пробный щиток у существующей стены (по захваченному id стены из model_get)
  const wall = before.walls[0]!;
  const addRes = (await call("item_add", { name: "electric_shield", position: { against_wall: { wall_id: wall.id, offset_mm: 500 } } })) as Record<string, unknown>;
  const shieldItemLabel = entityId(addRes);
  // захват site_id созданного предмета: compact-щиток несёт item = id сайта
  // (до save модель на сервере ещё не изменилась — GET-диф тут не работает)
  const railRes = await call("shield_rail_add", { item_id: shieldItemLabel });
  shieldItemSiteId = String((railRes["entity"] as { item?: string } | undefined)?.item ?? "");
  if (!shieldItemSiteId) throw new Error("shield_rail_add: в compact-щитке нет item (site_id предмета)");
  console.log("shield item:", shieldItemLabel, "site_id captured");

  // 1. конструктор: рейка + 5 модулей (в т.ч. типы без default_subtype — ревью 256 №1)
  console.log("rail add ok, shields:", JSON.stringify(railRes["entity"]));
  await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module", subtype: "25A", group_number: 1, comment: "проба 255" });
  const mod2 = await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module_x2", rail: 0 });
  const mods = (mod2["entity"] as { modules?: { module_id: string }[] }).modules ?? [];
  if (mods.length !== 2) throw new Error(`модулей ${mods.length}, ожидалось 2`);
  await call("shield_module_update", { item_id: shieldItemLabel, module_id: mods[1]!.module_id, subtype: "16A/30mA", group_number: 2 });
  // uzip/terminal/uvr — без subtype: MCP обязан поставить subtype как в редакторе
  await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module_uzip" });
  await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module_terminal" });
  await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module_uvr" });
  console.log("modules:", mods.map((x) => x.module_id).join(" "));

  // 2. validate → save
  const validation = (await call("model_validate", {})) as { ok?: boolean; problems?: unknown[] };
  console.log("validate ok:", validation.ok, validation.problems?.length ?? 0);
  await assertUnchangedRef(roRef, "{tag}");
  const save = await call("project_save", {});
  writeFileSync(`${OUT}/255-save-result.json`, JSON.stringify(save, null, 1));
  verified = (save as { verified?: boolean }).verified === true;
  console.log("save verified:", verified);

  // 3. reopen + сверка
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after = await mg();
  const sh = after.shields?.[0];
  const checks: [string, boolean][] = [
    ["щиток в model_get (1 запись, привязка к предмету)", !!sh && sh.item.length > 0],
    ["рейки: 2 (умолчание + добавленная)", !!sh && sh.rails === 2],
    ["модули: 5 (автомат 25A, диф 16A/30mA, uzip 5A, terminal 5A, uvr 63A)", !!sh && sh.modules.length === 5
      && sh.modules[0]!.type === "shield_module" && sh.modules[0]!.subtype === "25A"
      && sh.modules[1]!.type === "shield_module_x2" && sh.modules[1]!.subtype === "16A/30mA"
      && sh.modules[2]!.type === "shield_module_uzip" && sh.modules[2]!.subtype === "5A"
      && sh.modules[3]!.type === "shield_module_terminal" && sh.modules[3]!.subtype === "5A"
      && sh.modules[4]!.type === "shield_module_uvr" && sh.modules[4]!.subtype === "63A"],
    ["щиток-предмет на месте", after.items.some((i) => i.id === shieldItemLabel)],
  ];
  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(ok ? "OK   " : "FAIL ", label);
    if (!ok) allOk = false;
  }

  // 4. render PNG (копия в tmp)
  const png = await call("render_plan", {});
  const pngPath = png["path"] as string | undefined;
  console.log("render:", pngPath ?? "нет path в ответе");
  if (!pngPath) allOk = false;
  else copyFileSync(pngPath, `${OUT}/255-render.png`);

  // 5. очистка (в дополнение к finally): щиток-предмет по site_id + save
  const cleanupLabel = itemLabelBySiteId(shieldItemSiteId);
  if (cleanupLabel) {
    await call("item_delete", { item_id: cleanupLabel });
    await assertUnchangedRef(roRef, "{tag}");
    const sv = (await call("project_save", {})) as { verified?: boolean };
    const cleanupVerified = sv.verified === true;
    await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const clean = await mg();
    const back = countsOk(clean, wallsBefore, itemsBefore, shieldsBefore);
    console.log("cleanup verified:", cleanupVerified, "counters back:", back);
    allOk = allOk && cleanupVerified && back;
  } else {
    console.log("cleanup: предмет по site_id не найден в свежей модели (уже удалён?)");
  }

  // 6. ревью 319 №4: контрольный проект сверяется с фиксированным эталоном
  const sameReadonly = !(await roGuard.checkFinal("в конце"));
  console.log(sameReadonly ? "READONLY OK" : "READONLY CHANGED — СТОП");
  // свой план dev-проекта после очистки — как до прогона (семантическая сигнатура)
  const ownAfter = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const sameOwn = samePlan(ownBefore.model, ownAfter.model);
  if (!sameOwn) console.log("OWN PLAN CHANGED (сигнатура плана отличается от бэкапа)");
  console.log(sameOwn ? "OWN PLAN OK (после очистки как до прогона)" : "OWN PLAN CHANGED");

  mainOk = allOk && verified && sameReadonly && sameOwn;
} catch (e) {
  console.error("PROBE_ERROR:", (e as Error).message);
  mainOk = false;
} finally {
  // ревью 256 №3б: восстановление при ЛЮБОМ исходе — удалить свои объекты по
  // захваченному site_id (метка из свежей модели), при расхождении сигнатуры
  // плана с бэкапом — вернуть бэкап точной записью data (A-транспорт), затем
  // сверить сигнатуру.
  try {
    if (ownBefore) {
      if (shieldItemSiteId) {
        // ревью 258 №1: сначала project_open (рабочая модель = сервер), потом резолв
        await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
        const label = itemLabelBySiteId(shieldItemSiteId);
        if (label) {
          await call("item_delete", { item_id: label });
          await assertUnchangedRef(roRef, "{tag}");
          const sv = (await call("project_save", {})) as { verified?: boolean };
          console.log("finally: пробный щиток удалён, save verified:", sv.verified === true);
        }
      }
      const afterModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
      if (!samePlan(ownBefore.model, afterModel.model)) {
        console.log("finally: сигнатура плана отличается от бэкапа — возврат бэкапа");
        const fresh = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
        await assertUnchangedRef(roRef, "{tag}");
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
// итог — после восстановительного finally: ядро пробы + состояние проекта
console.log("RESULT:", mainOk && restoreOk ? "LIVE_OK" : "LIVE_FAIL");
process.exit(mainOk && restoreOk ? 0 : 1);
