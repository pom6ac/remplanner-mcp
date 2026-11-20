// 255/256: живая проверка конструктора щитка в dev-проекте из env (REMPLANNER_PROBE_*).
// Цепочка MCP: item_add (электрощиток у стены) → shield_rail_add → shield_module_add ×2
// → shield_module_update → model_validate → project_save (verified, без
// NORMALIZATION_DROPPED) → reopen → model_get сверка → render_plan PNG →
// item_delete щитка (каскад конструктора, нет висячих shield_id) → save →
// счетчики как до прогона. GET рабочего проекта (env) — только чтение до/после.
//
// Ревью 256 №3: предмет удаляется только по захваченному site_id (метка
// резолвится из свежей модели непосредственно перед удалением — инцидент 240);
// очистка и сверка восстановления — в finally при любом исходе (удаление по
// site_id, при расхождении — возврат бэкапа project_import_plan + save);
// после project_open модель сверяется с GET до первой записи («план в
// редакторе == сервер»).
// Запуск: node --experimental-strip-types scripts/probes/255-live-check.ts run
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { toModel } from "../../src/model/canonical.ts";
import { HOME_DIR, PLANS_DIR } from "../../src/config.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run (REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID из env)");
  process.exit(0);
}

const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID и REMPLANNER_PROBE_READONLY_ID");
  process.exit(1);
}
if (OBJECT_ID === READONLY_ID) {
  console.error("OBJECT_ID === READONLY_ID — отказ до любой записи");
  process.exit(1);
}
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
// бэкап этапа (по заданию 257): .orca-reports/backup-<OBJECT_ID>-257.json
const BACKUP_PATH = join(".orca-reports", `backup-${OBJECT_ID}-257.json`);

function countsOk(c: Compact, walls: number, items: number, shields: number): boolean {
  return c.walls.length === walls && c.items.length === items && (c.shields?.length ?? 0) === shields;
}

/** Строгая сверка модели (data) с бэкапом: обе стороны через toModel. */
const canon = (m: Record<string, unknown>): string => JSON.stringify(toModel(structuredClone(m) as never));
const sameData = (before: Record<string, unknown>, after: Record<string, unknown>): boolean => canon(before) === canon(after);

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
  const m = await loadModel(ctx.session(), objectId, "1");
  writeFileSync(`${OUT}/get-${objectId}-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

type Compact = {
  walls: { id: string }[];
  items: { id: string; name: string }[];
  shields?: { id: string; site_id: string; item: string; rails: number; modules: { module_id: string; rail: number; type: string; subtype: string }[] }[];
};
const mg = async (): Promise<Compact> => (await call("model_get", {})) as unknown as Compact;

/** Метка I<n> предмета с захваченным site_id из СВЕЖЕЙ модели (инцидент 240). */
const itemLabelBySiteId = async (siteId: string): Promise<string | null> => {
  const raw = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const idx = Object.keys((raw.model["items"] ?? {}) as Record<string, unknown>).indexOf(siteId);
  return idx >= 0 ? `I${idx + 1}` : null;
};

let readonlyBefore: LoadedModel | null = null;
let ownBefore: LoadedModel | null = null;
let shieldItemSiteId: string | null = null;
let verified = false;
let restoreOk = false;
try {
  // 0. бэкап GET dev-проекта + контрольный GET рабочего
  ownBefore = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  writeFileSync(BACKUP_PATH, JSON.stringify({
    _source: "GET через loadModel, dev-проект из env, scripts/probes/255-live-check.ts, до прогона; id не печатаются",
    model: ownBefore.model,
  }, null, 1));
  writeFileSync(`${OUT}/backup-${OBJECT_ID}-255.json`, JSON.stringify({ model: ownBefore.model }, null, 1));
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
  entityId(addRes);
  // захват site_id созданного предмета: разница ключей items GET до/после (без
  // лексической фильтрации меток — ревью 256 №3а)
  const itemsAfterAdd = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const keysBefore = new Set(Object.keys((ownBefore.model["items"] ?? {}) as Record<string, unknown>));
  const added = Object.keys((itemsAfterAdd.model["items"] ?? {}) as Record<string, unknown>).filter((k) => !keysBefore.has(k));
  if (added.length !== 1) throw new Error(`ожидался 1 новый предмет, по GET найдено ${added.length}`);
  shieldItemSiteId = added[0]!;
  const shieldItemLabel = entityId(addRes);
  console.log("shield item:", shieldItemLabel, "site_id captured");

  // 1. конструктор: рейка + два модуля + update
  const railRes = await call("shield_rail_add", { item_id: shieldItemLabel });
  console.log("rail add ok, shields:", JSON.stringify(railRes["entity"]));
  await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module", subtype: "25A", group_number: 1, comment: "проба 255" });
  const mod2 = await call("shield_module_add", { item_id: shieldItemLabel, type: "shield_module_x2", rail: 0 });
  const mods = (mod2["entity"] as { modules?: { module_id: string }[] }).modules ?? [];
  if (mods.length !== 2) throw new Error(`модулей ${mods.length}, ожидалось 2`);
  await call("shield_module_update", { item_id: shieldItemLabel, module_id: mods[1]!.module_id, subtype: "16A/30mA", group_number: 2 });
  console.log("modules:", mods.map((x) => x.module_id).join(" "));

  // 2. validate → save
  const validation = (await call("model_validate", {})) as { ok?: boolean; problems?: unknown[] };
  console.log("validate ok:", validation.ok, validation.problems?.length ?? 0);
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
    ["модули: 2 (автомат 25A + дифавтомат 16A/30mA)", !!sh && sh.modules.length === 2
      && sh.modules[0]!.type === "shield_module" && sh.modules[0]!.subtype === "25A"
      && sh.modules[1]!.type === "shield_module_x2" && sh.modules[1]!.subtype === "16A/30mA"],
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
  const cleanupLabel = await itemLabelBySiteId(shieldItemSiteId);
  if (cleanupLabel) {
    await call("item_delete", { item_id: cleanupLabel });
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

  // 6. GET рабочего проекта (env) после прогона — не изменился
  const readonlyAfter = await snap(READONLY_ID, "after");
  const sameReadonly = JSON.stringify(readonlyBefore.model) === JSON.stringify(readonlyAfter.model);
  console.log(sameReadonly ? "READONLY OK" : "READONLY CHANGED — СТОП");
  // свой план dev-проекта после очистки — как до прогона (сверка data с бэкапом)
  const ownAfter = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const sameOwn = sameData(ownBefore.model, ownAfter.model);
  if (!sameOwn) console.log("OWN PLAN CHANGED (данные после очистки не равны бэкапу)");
  console.log(sameOwn ? "OWN PLAN OK (после очистки как до прогона)" : "OWN PLAN CHANGED");

  console.log("RESULT:", allOk && verified && sameReadonly && sameOwn && restoreOk ? "LIVE_OK" : "LIVE_FAIL");
} catch (e) {
  console.error("PROBE_ERROR:", (e as Error).message);
  console.log("RESULT: LIVE_FAIL");
} finally {
  // ревью 256 №3б: восстановление при ЛЮБОМ исходе — удалить свои объекты по
  // захваченному site_id (метка из свежей модели), при расхождении с бэкапом —
  // вернуть бэкап (project_import_plan + save), затем сверить data.
  try {
    if (ownBefore) {
      if (shieldItemSiteId) {
        const label = await itemLabelBySiteId(shieldItemSiteId);
        if (label) {
          await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
          await call("item_delete", { item_id: label });
          const sv = (await call("project_save", {})) as { verified?: boolean };
          console.log("finally: пробный щиток удалён, save verified:", sv.verified === true);
        }
      }
      const afterModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
      if (!sameData(ownBefore.model, afterModel.model)) {
        console.log("finally: данные отличаются от бэкапа — возврат бэкапа");
        const planFile = `backup-${OBJECT_ID}-257.plan`;
        writeFileSync(join(HOME_DIR, "plans", planFile), JSON.stringify({ model: ownBefore.model, saved_at: new Date().toISOString() }, null, 1));
        await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
        await call("project_import_plan", { path: planFile, replace: true });
        const sv = (await call("project_save", {})) as { verified?: boolean };
        console.log("finally: бэкап возвращён, save verified:", sv.verified === true);
        const restored = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
        restoreOk = sameData(ownBefore.model, restored.model);
        console.log("finally: сверка data после восстановления:", restoreOk ? "OK" : "MISMATCH");
      } else {
        restoreOk = true;
        console.log("finally: данные проекта равны бэкапу");
      }
    }
  } catch (e) {
    console.error("finally RESTORE_ERROR:", (e as Error).message.slice(0, 400));
    restoreOk = false;
  }
  await closeBrowser().catch(() => {});
}
process.exit(0);
