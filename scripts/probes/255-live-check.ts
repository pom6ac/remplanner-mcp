// 255: живая проверка конструктора щитка в dev-проекте из env (REMPLANNER_PROBE_*).
// Цепочка MCP: item_add (электрощиток у стены) → shield_rail_add → shield_module_add ×2
// → shield_module_update → model_validate → project_save (verified, без
// NORMALIZATION_DROPPED) → reopen → model_get сверка → render_plan PNG →
// item_delete щитка (каскад конструктора, нет висячих shield_id) → save →
// счетчики как до прогона. GET рабочего проекта (env) — только чтение до/после.
// Запуск: node --experimental-strip-types scripts/probes/255-live-check.ts run
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

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

function countsOk(c: Compact, walls: number, items: number, shields: number): boolean {
  return c.walls.length === walls && c.items.length === items && (c.shields?.length ?? 0) === shields;
}

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

let readonlyBefore: LoadedModel | null = null;
let shieldItemLabel: string | null = null;
let verified = false;
try {
  // 0. бэкап GET dev-проекта + контрольный GET рабочего
  const ownBefore = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  writeFileSync(`${OUT}/backup-${OBJECT_ID}-255.json`, JSON.stringify({
    _source: "GET через loadModel, dev-проект из env, scripts/probes/255-live-check.ts, до прогона; id не печатаются",
    model: ownBefore.model,
  }, null, 1));
  readonlyBefore = await snap(READONLY_ID, "before");
  console.log("backup ok");

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const before = await mg();
  const wallsBefore = before.walls.length;
  const itemsBefore = before.items.length;
  const shieldsBefore = (before.shields ?? []).length;
  if (shieldsBefore !== 0) throw new Error(`в dev-проекте уже есть щитки (${shieldsBefore}) — проба не должна их трогать`);
  // пробный щиток у существующей стены (по захваченному id стены из model_get)
  const wall = before.walls[0]!;
  const addRes = (await call("item_add", { name: "electric_shield", position: { against_wall: { wall_id: wall.id, offset_mm: 500 } } })) as Record<string, unknown>;
  const e = addRes["entity"] as { id?: string } | undefined;
  if (!e?.id) throw new Error(`item_add: в ответе нет entity.id: ${JSON.stringify(addRes).slice(0, 200)}`);
  shieldItemLabel = e.id;
  console.log("shield item:", shieldItemLabel);

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

  // 5. очистка: щиток-предмет (каскад конструктора) + save
  if (verified) {
    await call("item_delete", { item_id: shieldItemLabel });
    const sv = (await call("project_save", {})) as { verified?: boolean };
    const cleanupVerified = sv.verified === true;
    await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const clean = await mg();
    const back = countsOk(clean, wallsBefore, itemsBefore, shieldsBefore);
    console.log("cleanup verified:", cleanupVerified, "counters back:", back);
    allOk = allOk && cleanupVerified && back;
  }

  // 6. GET рабочего проекта (env) после прогона — не изменился
  const readonlyAfter = await snap(READONLY_ID, "after");
  const sameReadonly = JSON.stringify(readonlyBefore.model) === JSON.stringify(readonlyAfter.model);
  console.log(sameReadonly ? "READONLY OK" : "READONLY CHANGED — СТОП");
  // свой план dev-проекта после очистки — семантически как до прогона
  const ownAfter = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const ownSig = (m: Record<string, unknown>): string => {
    const walls = Object.values((m["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number }; holes?: Record<string, unknown> }>);
    const wallSig = walls.map((w) => [w.p1.x, w.p1.y, w.p2.x, w.p2.y, Object.keys(w.holes ?? {}).length].join(":")).sort().join("|");
    const colls = ["items", "shields", "cables_socket", "led_strips", "rulers", "comments"]
      .map((k) => `${k}=${Object.keys((m[k] ?? {}) as Record<string, unknown>).length}`).join(",");
    return `${wallSig}#${colls}#rooms2=${Object.keys((m["rooms2"] ?? {}) as Record<string, unknown>).length}`;
  };
  const sameOwn = ownSig(ownBefore.model) === ownSig(ownAfter.model);
  if (!sameOwn) {
    console.log("own before sig:", ownSig(ownBefore.model).slice(0, 300));
    console.log("own after  sig:", ownSig(ownAfter.model).slice(0, 300));
  }
  console.log(sameOwn ? "OWN PLAN OK (после очистки как до прогона)" : "OWN PLAN CHANGED");

  console.log("RESULT:", allOk && verified && sameReadonly && sameOwn ? "LIVE_OK" : "LIVE_FAIL");
} catch (e) {
  console.error("PROBE_ERROR:", (e as Error).message);
  console.log("RESULT: LIVE_FAIL");
} finally {
  await closeBrowser().catch(() => {});
}
process.exit(0);
